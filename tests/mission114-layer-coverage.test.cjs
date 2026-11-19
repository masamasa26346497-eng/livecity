'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const cov = require('../tools/mission114/layer-coverage.cjs');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

test('point-in-ring and coverage classification', () => {
  const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.ok(cov.inRing(sq, 50, 50)); assert.ok(!cov.inRing(sq, 150, 50));
  const ward = { bbox: { minX: 0, maxX: 100, minZ: 0, maxZ: 100 }, polygons: [{ outer: sq }] };
  const r = cov.coverage(ward, [{ minX: 0, maxX: 50, minZ: 0, maxZ: 100 }], 10);
  assert.strictEqual(r.pct, 50);
  assert.strictEqual(cov.classify(100), 'full'); assert.strictEqual(cov.classify(3), 'partial-window'); assert.strictEqual(cov.classify(0), 'none'); assert.strictEqual(cov.classify(null), 'unknown');
});

test('real repo data: no ward is fully covered; fukushima/yodogawa only partly (explains partial orange line)', () => {
  const rep = cov.run(100);
  assert.strictEqual(rep.wards.length, 24);
  const by = Object.fromEntries(rep.wards.map((w) => [w.wardId, w]));
  assert.strictEqual(rep.summary.roadFull, 0);
  assert.strictEqual(by.fukushima.roadEdge.status, 'partial-window');
  assert.ok(by.yodogawa.roadEdge.pct < 5);
  assert.ok(by.nishi.roadEdge.pct > 0 && by.nishi.roadEdge.pct < 50);
});

test('viewer window constants equal the data bboxLocal (no drift)', () => {
  const html = read('public/mission37g-osaka-24ward-mvp.html');
  const m = html.match(/const GSI_WINDOWS_114 = \{([\s\S]*?)\n  \};/);
  assert.ok(m, 'GSI_WINDOWS_114 present');
  const win = new Function('return {' + m[1] + '}')();
  const same = (a, f) => { const b = JSON.parse(read(f)).bboxLocal; return a.minX === b.minX && a.maxX === b.maxX && a.minZ === b.minZ && a.maxZ === b.maxZ; };
  cov.ROAD_WINDOWS.forEach((f, i) => assert.ok(same(win.road[i], f), f));
  cov.WATER_WINDOWS.forEach((f, i) => assert.ok(same(win.water[i], f), f));
  assert.match(html, /窓の外のため未配信/);
});

test('observation record is not acceptance', () => {
  const o = JSON.parse(read('data/reports/mission114/owner-device-observed.json'));
  assert.strictEqual(o.mission106Matrix.ownerDeviceAccepted, 0);
  assert.strictEqual(o.wards.fukushima.buildingsShown, 13412);
  assert.strictEqual(o.wards.yodogawa.buildingsShown, 35296);
  for (const w of Object.values(o.wards)) assert.strictEqual(w.accepted, false);
});

test('local-run: ASCII-safe plan, incremental, no delete/overwrite, token not given to server', () => {
  const src = read('tools/mission114/local-run.mjs');
  assert.ok(!/rmSync|unlinkSync|rmdirSync|copyFileSync|writeFileSync/.test(src));
  assert.match(src, /delete cleanEnv\.LIVECITY_3D_DATA_TOKEN/);
  assert.match(src, /fileURLToPath\(import\.meta\.url\)/);
  assert.ok(!/legacy|pc23/i.test(src.replace(/\/\/.*$/gm, '')));
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'm114-'));
  fs.mkdirSync(path.join(tmp, 'nishi25')); fs.writeFileSync(path.join(tmp, 'nishi25', 'tileset.json'), '{}');
  const r = spawnSync(process.execPath, [path.join(repo, 'tools/mission114/local-run.mjs'), '--wards', 'ALL', '--root', tmp, '--dry-run'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.deepStrictEqual(p.present, ['nishi']); assert.strictEqual(p.missing.length, 23); assert.strictEqual(p.requested, 24);
  const bad = spawnSync(process.execPath, [path.join(repo, 'tools/mission114/local-run.mjs'), '--wards', '27999', '--dry-run'], { encoding: 'utf8' });
  assert.notStrictEqual(bad.status, 0);
});
