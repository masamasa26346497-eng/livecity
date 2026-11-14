'use strict';
// Mission 45Q: 合成 fixture のみ。実 Windows Chrome・実データでは未確認。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('node:vm');
const T = require('../tools/mission45o-footprint-vs-road.cjs');
const ROOT = path.join(__dirname, '..');
const sb = {}; vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/mission45p-areacull.js'), 'utf8'), sb);
const A = sb.LC45P;

const sq = (x, z, s) => ({ kind: 'area', p: [[x, z], [x + s, z], [x + s, z + s], [x, z + s]] });
const rect = (cx, cz, r) => ({ minX: cx - r, maxX: cx + r, minZ: cz - r, maxZ: cz + r, cx, cz, r });

function scenario(opt) {
  const feats = []; for (let i = 0; i < 10; i++) feats.push(sq(i * 500, 0, 50));
  const idx = A.buildIndex(feats, {});
  let built = 0, destroyed = 0;
  const res = A.makeResidency(idx, () => ({ n: built++ }), () => { destroyed++; }, opt);
  res.sync(rect(250, 25, 300), true);          // 近傍を構築
  const before = res.size();
  res.sync(rect(4250, 25, 300), false);        // 遠くへ移動（操作中: 構築不可）
  return { before, afterMoving: res.size(), destroyedMoving: destroyed, res, rectEnd: rect(4250, 25, 300) };
}
test('default: units outside hysteresis are dropped even while moving (unchanged behaviour)', () => {
  const s = scenario({});
  assert.ok(s.before >= 1); assert.ok(s.destroyedMoving >= 1);
});
test('A/B deferDropWhileMoving: nothing destroyed while moving, dropped once settled', () => {
  const s = scenario({ deferDropWhileMoving: true });
  assert.strictEqual(s.destroyedMoving, 0);
  s.res.sync(s.rectEnd, true);
  assert.ok(s.res.stats.droppedTotal >= 1);
});
test('page wires ?vcdefer=1 and keeps default off', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(/deferDropWhileMoving: q\.get\('vcdefer'\) === '1'/.test(h));
  assert.strictEqual(A.DEFAULTS.deferDropWhileMoving, false);
});
test('45O dump records source file mtimes (aggregate dates only)', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'm45q-src-')), outDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm45q-out-')), 'd');
  const bd = path.join(src, 'buildings', 'osaka-fukushima'), rd = path.join(src, 'roads');
  fs.mkdirSync(bd, { recursive: true }); fs.mkdirSync(rd, { recursive: true });
  const w = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards.find((x) => x.wardId === 'fukushima');
  const x0 = w.bbox.minX + 100, z0 = w.bbox.minZ + 100;
  fs.writeFileSync(path.join(bd, 'tile_0_0.json'), JSON.stringify({ buildings: [{ id: 'bldg_x', fp: [[x0, z0], [x0 + 20, z0], [x0 + 20, z0 + 20], [x0, z0 + 20]], h: 5 }] }));
  const tb = Math.floor(x0 / 2000), tz = Math.floor(z0 / 2000);
  fs.writeFileSync(path.join(rd, 'manifest.json'), JSON.stringify({ coordinateConvention: 'znorth-neg-v1', tileSize: 2000, tiles: [{ tx: tb, tz, file: 'tile_' + tb + '_' + tz + '.json' }] }));
  fs.writeFileSync(path.join(rd, 'tile_' + tb + '_' + tz + '.json'), JSON.stringify({ features: [{ id: 'r1', kind: 'line', p: [[x0 - 50, z0 + 10], [x0 + 80, z0 + 10]] }] }));
  const out = T.run({ src, ward: 'fukushima', radius: 15, dump: outDir });
  const d = JSON.parse(fs.readFileSync(path.join(outDir, 'diag.json'), 'utf8'));
  assert.ok(/^\d{4}-\d\d-\d\d \.\. \d{4}-\d\d-\d\d$/.test(d.meta.source.buildingsMtime));
  assert.ok(out.dump.written);
});
test('45O diag page: scripted E2E in headless Chrome (skipped when no browser)', { timeout: 120000 }, () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/experiments/mission45q_diag_ui_e2e.mjs')], { encoding: 'utf8', timeout: 110000 });
  const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  if (j.skipped) return;
  assert.strictEqual(r.status, 0, r.stdout.slice(-800));
  assert.strictEqual(j.pass, true);
});
test('diag page has no upload path: no fetch/XHR/sendBeacon of loaded data', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/mission45o-align-diag.html'), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(h));
});
