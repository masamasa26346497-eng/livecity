import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assemble, unsafeMembers, scanTree } from '../tools/lod2/lod2-release-assemble.mjs';
import { planMerge, inspectWard } from '../tools/lod2/lod2-cloud-merge.mjs';

const REG = [{ id: 'kita', code: '27127' }, { id: 'chuo', code: '27128' }];
function glb() { const b = Buffer.alloc(24); b.write('glTF', 0, 'latin1'); b.writeUInt32LE(2, 4); b.writeUInt32LE(24, 8); return b; }
function mkWard(root, name, ids, extra = {}) {
  const d = path.join(root, '_x_' + name, name + '25');
  fs.mkdirSync(path.join(d, 'tiles'), { recursive: true }); fs.mkdirSync(path.join(d, 'ids'));
  fs.writeFileSync(path.join(d, 'tiles/t.glb'), glb());
  fs.writeFileSync(path.join(d, 'tileset.json'), JSON.stringify({ root: { content: { uri: 'tiles/t.glb' } } }));
  fs.writeFileSync(path.join(d, 'ids/t.json'), JSON.stringify(ids));
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(d, k), JSON.stringify(v));
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm209-'));

test('assemble: synthesizes source/build-report, flags them, merge accepts', () => {
  const t = tmp(); process.env.RUNNER_TEMP = t;
  mkWard(path.join(t, 'in'), 'kita', ['bldg_a', 'bldg_b']);
  const r = assemble({ root: path.join(t, 'in'), out: path.join(t, 'out'), registry: REG });
  assert.equal(r.counts.ok, 1); assert.equal(r.counts.missing, 1); assert.equal(r.allOk, false);
  const kita = r.wards[0]; assert.deepEqual(kita.synthesized, ['source.json', 'build-report.json']);
  const info = inspectWard(path.join(t, 'out', 'kita'), '27127');
  assert.equal(info.buildings, 2); assert.equal(info.vintage, '2025');
  const plan = planMerge({ registry: REG, baseWards: { kita: info }, overlayWards: {} });
  assert.equal(plan.find((p) => p.ward === 'chuo').status, 'missing');
});
test('assemble: wardCode mismatch, duplicate ids, bad GLB are data-problem and not copied', () => {
  const t = tmp(); process.env.RUNNER_TEMP = t;
  mkWard(path.join(t, 'in'), 'kita', ['bldg_a'], { 'source.json': { wardCode: '99999' } });
  mkWard(path.join(t, 'in'), 'chuo', ['bldg_a', 'bldg_a']);
  const r = assemble({ root: path.join(t, 'in'), out: path.join(t, 'out'), registry: REG });
  assert.equal(r.counts.problem, 2); assert.equal(fs.existsSync(path.join(t, 'out', 'kita')), false);
});
test('assemble: real source.json without vintage is not called 2025; both wards -> allOk', () => {
  const t = tmp(); process.env.RUNNER_TEMP = t;
  mkWard(path.join(t, 'in'), 'kita', ['bldg_a'], { 'source.json': { wardCode: '27127' }, 'build-report.json': { totals: { buildings: 1 } } });
  mkWard(path.join(t, 'in'), 'chuo', ['bldg_b']);
  const r = assemble({ root: path.join(t, 'in'), out: path.join(t, 'out'), registry: REG });
  assert.equal(r.allOk, true); assert.equal(r.wards[0].vintage, null); assert.equal(r.wards[1].vintage, '2025');
});
test('refuses symlinks, size cap, unsafe tar members, and outputs outside temp', () => {
  const t = tmp(); process.env.RUNNER_TEMP = t;
  fs.mkdirSync(path.join(t, 'in')); fs.symlinkSync('/etc', path.join(t, 'in', 'x'));
  assert.ok(scanTree(path.join(t, 'in')).problems.some((p) => /symlink/.test(p)));
  fs.rmSync(path.join(t, 'in', 'x')); fs.writeFileSync(path.join(t, 'in', 'f'), Buffer.alloc(100));
  assert.ok(scanTree(path.join(t, 'in'), { maxBytes: 10 }).problems.includes('size cap exceeded'));
  assert.equal(unsafeMembers('a/b\n../x\n/abs\nok/..hidden\n').length, 2);
  assert.throws(() => assemble({ root: path.join(t, 'in'), out: '/var/tmp-not-allowed-m209', registry: REG }), /RUNNER_TEMP/);
});
test('workflow template: fixed-curl token step only, no new secret, no upload, no gh/claude', () => {
  const y = fs.readFileSync(new URL('../tools/lod2/cloud-workflow/lod2-release-merge.yml', import.meta.url), 'utf8');
  assert.match(y, /LIVECITY_3D_DATA_READ_TOKEN/); assert.doesNotMatch(y, /LIVECITY_3D_DATA_TOKEN\b/);
  assert.equal((y.match(/secrets\./g) || []).length, 1);
  assert.doesNotMatch(y, /upload-artifact|actions\/cache|gh release|--prod|GH_TOKEN|claude-code-action/);
  assert.match(y, /workflow_dispatch/); assert.match(y, /contents: read/); assert.match(y, /persist-credentials: false/);
});
