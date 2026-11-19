'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../tools/mission45m-verify-glb-geometry.cjs');
const B = require('../tools/mission37b-build-3dtiles.cjs');
const root = path.join(__dirname, '..');

test('45M: tracked 住吉 9 tile の実 GLB 頂点を独立復元 → 元 footprint と一致（回転・鏡像・オフセットなし）', () => {
  const r = V.verify({ tileset: path.join(root, 'public/mission37b-3dtiles/osaka-sumiyoshi-9tile'),
    src: path.join(root, 'public/map-data/osaka-city/buildings/osaka-sumiyoshi'), maxTiles: 0, tol: 1, sample: 10 });
  assert.ok(r.buildingsChecked > 500);
  assert.ok(r.horizontalErrM.max < 0.01, 'horizontal ' + r.horizontalErrM.max);
  assert.ok(r.heightErrM.max < 0.01);
  assert.strictEqual(r.mirrorSuspectBuildings, 0);
  assert.strictEqual(r.regionViolations, 0);
  assert.strictEqual(r.idsMismatch, 0);
  assert.ok(r.fitRotationDegAbs.max < 0.001);
  assert.strictEqual(r.glbNodeMatrixPresent, false);
  assert.strictEqual(r.pass, true);
});

test('45M: 同一式・同一定数の local→lonlat→local 往復は厳密（±20km でも <1e-6 m）', () => {
  assert.ok(V.roundtripLocal([[-20000, 20000], [15000, -15000], [0, 0]]) < 1e-6);
});

test('45M: 合成 GLB（遠方原点）でも Y-up→Z-up + tile transform の復元が一致', () => {
  const frame = B.makeFrame(B.localToLon(8000.5), B.localToLat(-12000.5));
  const fp = [[8000, -12000], [8040, -12000], [8040, -11970], [8000, -11970]];
  const { glb } = B.buildGlb([{ id: 'bldg_x', fp, z0: 0, top: 20, h: 20 }], frame);
  const g = V.readGlb(glb);
  const M = V.mul(B.frameMatrix(frame), V.YUP_TO_ZUP);
  const pts = g.pos.map(p => { const w = V.apply(M, p); const d = V.ecefToGeodetic(w[0], w[1], w[2]); return V.geoToLocal(d.lon, d.lat); });
  for (const p of fp) assert.ok(pts.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.01));
});

test('45M: 既定は固定解像度、計測フックあり、検証ツールはビルダーを import しない', () => {
  const html = fs.readFileSync(path.join(root, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.match(html, /__mission45m/);
  assert.match(html, /EXT45\) \? 'quality'/);
  const src = fs.readFileSync(path.join(root, 'tools/mission45m-verify-glb-geometry.cjs'), 'utf8');
  assert.ok(!/require\('\.\/mission37b/.test(src));
});
