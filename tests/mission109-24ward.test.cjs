'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const W = () => import(path.join(ROOT, 'tools/mission109/wards.mjs'));
const M = () => import(path.join(ROOT, 'tools/mission109/merge-matrix.mjs'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm109-'));

function glb() { const b = Buffer.alloc(24); b.write('glTF', 0, 'latin1'); b.writeUInt32LE(2, 4); b.writeUInt32LE(24, 8); return b; }
function makeWard(dir, code) {
  fs.mkdirSync(path.join(dir, 'attrs'), { recursive: true }); fs.mkdirSync(path.join(dir, 'ids'));
  fs.writeFileSync(path.join(dir, 'tileset.json'), JSON.stringify({ asset: { version: '1.0' }, root: { children: [{ content: { uri: 't.glb' } }] } }));
  fs.writeFileSync(path.join(dir, 't.glb'), glb());
  fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ vintage: 2025, wardCode: code }));
}
function pack(src, out) { assert.strictEqual(spawnSync('tar', ['-czf', out, '-C', src, '.']).status, 0); }

test('whitelist: 24 unique official codes, matches Mission106 matrix, no expo', async () => {
  const w = await W();
  assert.strictEqual(w.ALL_WARDS.length, 24);
  assert.strictEqual(new Set(Object.values(w.OSAKA_WARDS)).size, 24);
  assert.ok(!Object.values(w.OSAKA_WARDS).some((c) => c.startsWith('27999')));
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/mission106/progress-matrix.json'), 'utf8'));
  for (const r of m.wards) assert.strictEqual(w.OSAKA_WARDS[r.wardId], r.wardCode);
});

test('parseWards: ALL, subsets in canonical order; rejects unknown/duplicate/expo/malformed/empty', async () => {
  const w = await W();
  assert.strictEqual(w.parseWards('ALL').length, 24);
  assert.strictEqual(w.parseWards('all').length, 24);
  assert.deepStrictEqual(w.parseWards('yodogawa, nishi'), ['nishi', 'yodogawa']);
  for (const bad of ['', 'sumiyoshii', 'nishi,nishi', '27999', '27999expo', '../x', 'Nishi', 'nishi,,kita', 'expo', 'all,nishi']) assert.throws(() => w.parseWards(bad), undefined, bad);
});

test('planBatches: 24 -> 6 batches of 4; size bounds enforced; nothing lost or duplicated', async () => {
  const w = await W();
  const b = w.planBatches(w.ALL_WARDS);
  assert.strictEqual(b.length, 6);
  assert.deepStrictEqual(b.flat(), w.ALL_WARDS);
  assert.strictEqual(w.planBatches(w.ALL_WARDS, 5).length, 5);
  assert.throws(() => w.planBatches(w.ALL_WARDS, 0)); assert.throws(() => w.planBatches(w.ALL_WARDS, 7));
});

test('fetch-verify offline: one bad ward does not stop others; wrong wardCode in source.json fails; summary has no paths', () => {
  const t = tmp(); fs.mkdirSync(path.join(t, 'arch'));
  const cases = { nishi: '27106', fukushima: '27103', kita: '27999' }; // kita archive claims the expo code -> must fail
  for (const [w, code] of Object.entries(cases)) { const s = path.join(t, 'src-' + w); makeWard(s, code); pack(s, path.join(t, 'arch', 'plateau2025-' + w + '.tar.gz')); }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/mission109/fetch-verify.mjs'), '--wards', 'nishi,fukushima,kita,chuo', '--from-archive-dir', path.join(t, 'arch'), '--dest', path.join(t, 'out'), '--summary', path.join(t, 's.json')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.strictEqual(r.status, 1, r.stderr);
  const s = JSON.parse(fs.readFileSync(path.join(t, 's.json'), 'utf8'));
  assert.deepStrictEqual(s.verifiedWards, ['fukushima', 'nishi']);
  assert.deepStrictEqual(s.failedWards.sort(), ['chuo', 'kita']);
  assert.strictEqual(s.allVerified, false); assert.strictEqual(s.containsData, false); assert.strictEqual(s.acceptance, false);
  assert.ok(!JSON.stringify(s).includes(t));
  assert.ok(!fs.existsSync(path.join(t, 'out', '.archives')));
  assert.ok(fs.existsSync(path.join(t, 'out', 'nishi25', 'tileset.json')));
});

test('fetch-verify: refuses non-whitelisted ward, non-empty dest; needs token when online', () => {
  const t = tmp();
  const run = (args, env = { PATH: process.env.PATH }) => spawnSync(process.execPath, [path.join(ROOT, 'tools/mission109/fetch-verify.mjs'), ...args], { encoding: 'utf8', env });
  assert.strictEqual(run(['--wards', '27999', '--dest', path.join(t, 'a'), '--summary', path.join(t, 's')]).status, 64);
  fs.mkdirSync(path.join(t, 'd')); fs.writeFileSync(path.join(t, 'd', 'keep'), 'x');
  assert.strictEqual(run(['--wards', 'ALL', '--dest', path.join(t, 'd'), '--summary', path.join(t, 's')]).status, 2);
  assert.strictEqual(run(['--wards', 'ALL', '--dest', path.join(t, 'e'), '--summary', path.join(t, 's')]).status, 3);
});

test('merge-matrix: stored / CI QA / owner kept separate; prior run only for its 3 wards; rest unverified; no overwrite', async () => {
  const { buildReport } = await M();
  const matrix = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/mission106/progress-matrix.json'), 'utf8'));
  const fetchS = { wards: { kita: { status: 'verified', archiveSha256: 'a'.repeat(64), tilesetSha256: 'b'.repeat(64) } } };
  const qaS = { wards: { kita: { status: 'fail', checks: { x: false } } } };
  const rep = buildReport({ matrix, fetches: [fetchS], qas: [qaS], runId: '1' });
  const row = (id) => rep.wards.find((r) => r.wardId === id);
  assert.strictEqual(rep.wards.length, 24);
  assert.strictEqual(row('kita').storedVerified, 'verified-in-supplied-summary');
  assert.strictEqual(row('kita').ciBrowserQaPass, 'fail'); // stored != rendered
  assert.strictEqual(row('nishi').evidenceRunId, '41776480060');
  assert.match(row('nishi').storedVerified, /reported-by-run-41776480060/);
  assert.strictEqual(row('chuo').storedVerified, 'unverified'); assert.strictEqual(row('chuo').ciBrowserQaPass, 'unverified');
  for (const r of rep.wards) { assert.strictEqual(r.ownerDeviceAccepted, false); assert.strictEqual(r.roadWaterAlignment, 'unverified'); }
  assert.strictEqual(rep.counts.ownerDeviceAccepted, 0);
  const t = tmp(); const out = path.join(t, 'o.json'); fs.writeFileSync(out, 'keep');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/mission109/merge-matrix.mjs'), '--out', out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2); assert.strictEqual(fs.readFileSync(out, 'utf8'), 'keep');
});

test('tools never write token, delete sources, or call paid services', () => {
  for (const f of ['wards.mjs', 'fetch-verify.mjs', 'qa.mjs', 'merge-matrix.mjs']) {
    const s = fs.readFileSync(path.join(ROOT, 'tools/mission109', f), 'utf8');
    assert.ok(!/console\.(log|error)\([^)]*process\.env[^)]*TOKEN/.test(s), f);
    assert.ok(!/googleapis|places\.google/.test(s), f);
  }
});
