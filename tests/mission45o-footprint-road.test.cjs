'use strict';
// Mission 45O: 合成 fixture のみ。実データ・実機ブラウザでは未確認。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('../tools/lib/mission45o-overlap.cjs');
const T = require('../tools/mission45o-footprint-vs-road.cjs');
const ROOT = path.join(__dirname, '..');

// 100m ピッチの街区: 建物 60x60、道路は建物の間（幅 40m の中央）を通る
function city(shiftX) {
  const polys = [], lines = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) { const x = i * 100 + 20, z = j * 100 + 20; polys.push([[x, z], [x + 60, z], [x + 60, z + 60], [x, z + 60]]); }
  for (let k = 0; k <= 6; k++) {
    lines.push([[k * 100 + shiftX, 0], [k * 100 + shiftX, 600]]);
    lines.push([[0, k * 100], [600, k * 100]]);
  }
  return { polys, lines };
}
test('aligned roads: zero offset has no overlap and verdict is aligned-at-zero', () => {
  const c = city(0), w = O.scan(c.polys, c.lines, { radius: 15 });
  assert.strictEqual(w.zero, 0);
  const v0 = O.verdict(w, []);
  assert.strictEqual(v0.verdict, 'no-consistent-translation-detected');
  assert.strictEqual(v0.legacyVerdict, 'aligned-at-zero');   // 45O 互換フィールド
  assert.ok(/does NOT prove/.test(v0.note));
});
test('roads shifted 25m east through buildings: best offset recovers -25 only if within radius, else inconclusive/aligned (no false shift)', () => {
  const c = city(25), w = O.scan(c.polys, c.lines, { radius: 30 });
  assert.ok(w.zero > 0.2);
  assert.strictEqual(w.best.f, 0);
  // 道路が隙間（幅40m）に収まる最小の移動量が選ばれる（同点は小さい方）
  assert.ok(w.best.dx <= -7.5 && w.best.dx >= -30, String(w.best.dx));
  assert.strictEqual(w.best.dz, 0);
});
test('consistent sub-areas required for shift candidate', () => {
  const whole = { samples: 1000, buildings: 10, zero: 0.4, best: { dx: 5, dz: 0, f: 0.1 } };
  const ok = [{ samples: 500, best: { dx: 5, dz: 0 } }, { samples: 500, best: { dx: 5, dz: 2.5 } }];
  assert.strictEqual(O.verdict(whole, ok).verdict, 'consistent-shift-candidate');
  const bad = [{ samples: 500, best: { dx: 5, dz: 0 } }, { samples: 500, best: { dx: -10, dz: 0 } }];
  assert.strictEqual(O.verdict(whole, bad).verdict, 'inconclusive');
  assert.strictEqual(O.verdict({ samples: 0, buildings: 0 }, []).verdict, 'no-data');
});
test('CLI run: reads source read-only, aggregate-only output, --dump refuses overwrite', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'm45o-'));
  const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
  const w = wards.find((x) => x.wardId === 'fukushima'), b = w.bbox;
  const x0 = Math.round((b.minX + b.maxX) / 2), z0 = Math.round((b.minZ + b.maxZ) / 2), c = city(0);
  const sh = (p) => p.map((q) => [q[0] + x0, q[1] + z0]);
  const bd = path.join(src, 'buildings', 'osaka-fukushima'); fs.mkdirSync(bd, { recursive: true });
  const bp = path.join(bd, 'tile_0_0.json');
  fs.writeFileSync(bp, JSON.stringify({ buildings: c.polys.map((p, i) => ({ id: 'bldg_x' + i, fp: sh(p) })) }));
  const rd = path.join(src, 'roads'); fs.mkdirSync(rd);
  const size = 100000;
  fs.writeFileSync(path.join(rd, 'manifest.json'), JSON.stringify({ tileSize: size, coordinateConvention: 'znorth-neg-v1' }));
  const tx = Math.floor(x0 / size), tz = Math.floor(z0 / size);
  fs.writeFileSync(path.join(rd, 'tile_' + tx + '_' + tz + '.json'), JSON.stringify({ features: c.lines.map((l, i) => ({ id: 'r' + i, kind: 'line', p: sh(l) })) }));
  const before = fs.readFileSync(bp, 'utf8');
  const dump = path.join(src, 'out');
  const out = T.run({ src, ward: 'fukushima', radius: 10, dump });
  assert.strictEqual(out.verdict, 'no-consistent-translation-detected-within-10m');
  assert.strictEqual(out.legacyVerdict, 'aligned-at-zero');
  assert.ok(!JSON.stringify(out).includes('bldg_x'));
  assert.strictEqual(fs.readFileSync(bp, 'utf8'), before);
  assert.ok(fs.existsSync(path.join(dump, 'diag.json')));
  assert.throws(() => T.run({ src, ward: 'fukushima', radius: 10, dump }), /refusing to overwrite/);
});
test('diag page is localhost-gated, local-only, and no write/send APIs', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/mission45o-align-diag.html'), 'utf8');
  assert.ok(/localhost\|127\\\.0\\\.0\\\.1/.test(h));
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(h));
  assert.ok(h.includes('FileReader'));
});
