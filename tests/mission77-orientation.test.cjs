'use strict';
// [Mission 77] 建物パイプライン（実 buildGlb → GLB 頂点 → tile transform 連鎖）と
// 道路パイプライン（ビューア実コードの toCart）に同じ元座標を与え、向きを独立に比較する。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const B = require('../tools/mission37b-build-3dtiles.cjs');
const O = require('../tools/mission77-orientation.cjs');
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');

const D2R = Math.PI / 180, A = 6378137, E2 = 0.00669437999014;
const ecef = (lon, lat, h) => { const l = lon * D2R, p = lat * D2R, s = Math.sin(p), c = Math.cos(p), N = A / Math.sqrt(1 - E2 * s * s); return [(N + h) * c * Math.cos(l), (N + h) * c * Math.sin(l), (N * (1 - E2) + h) * s]; };
function geodetic(x, y, z) { const lon = Math.atan2(y, x), p = Math.hypot(x, y); let lat = Math.atan2(z, p * (1 - E2)), h = 0; for (let i = 0; i < 15; i++) { const s = Math.sin(lat), N = A / Math.sqrt(1 - E2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - E2 * N / (N + h))); } return { lon: lon / D2R, lat: lat / D2R, h }; }
// 独立の「地理 → ローカル」（geoToThree 相当: x=東, z=-北）。
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320, COS = Math.cos(CLAT * D2R);
const geoToLocal = (lon, lat) => [(lon - CLON) * COS * MPD, -(lat - CLAT) * MPD];
const mulM = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];

// 遠方を含む非共線点。各点は別 tile（別フレーム）に置く。
const POINTS = [[-2250, -750], [-1700, 250], [-3200, -1700], [4200, -3900], [-9000, 9000], [1500, 14000], [-1700, -13800]];

// 建物経路: 実 buildGlb の GLB 頂点 → Y-up→Z-up → leaf 相対 → group → ECEF → ローカル
function buildingPath(pts) {
  const out = [];
  const gframe = B.makeFrame(135.50, 34.60);
  for (const [x, z] of pts) {
    const tx = Math.floor(x / 500), tz = Math.floor(z / 500);
    const frame = B.makeFrame(B.localToLon((tx + 0.5) * 500), B.localToLat((tz + 0.5) * 500));
    const fp = [[x, z], [x + 20, z], [x + 20, z + 12], [x, z + 12]];
    const r = B.buildGlb([{ id: 'bldg_t', fp, z0: 0, top: 10, h: 10 }], frame);
    const g = B.parseGlb(r.glb);
    const jl = r.glb.readUInt32LE(12), bo = 20 + jl + 8;
    const acc = g.json.accessors[g.json.meshes[0].primitives[0].attributes.POSITION];
    const bv = g.json.bufferViews[acc.bufferView];
    const rel = B.relativeMatrix(gframe, frame), grp = B.frameMatrix(gframe);
    const vs = [];
    for (let i = 0; i < acc.count; i++) {
      const o = bo + (bv.byteOffset || 0) + (acc.byteOffset || 0) + i * 12;
      let v = [r.glb.readFloatLE(o), r.glb.readFloatLE(o + 4), r.glb.readFloatLE(o + 8)];
      v = [v[0], -v[2], v[1]]; // glTF Y-up → Z-up
      v = mulM(grp, mulM(rel, v));
      const ge = geodetic(v[0], v[1], v[2]);
      vs.push({ l: geoToLocal(ge.lon, ge.lat), h: ge.h });
    }
    const roof = vs.filter((q) => Math.abs(q.h - 10) < 0.05);
    for (const p of fp) { let best = null, bd = Infinity; for (const q of roof) { const d = Math.hypot(q.l[0] - p[0], q.l[1] - p[1]); if (d < bd) { bd = d; best = q; } } out.push({ src: p, dst: best.l }); }
  }
  return out;
}
// 道路経路: ビューアの toLon/toLat/toCart の実ソースを取り出して評価（Cesium は fromDegrees のみ差し替え）
function viewerToCart(mutate) {
  const a = html.indexOf('const PROJ = {'), e = html.indexOf('const toCart', a), e2 = html.indexOf('\n', e);
  assert.ok(a > 0 && e > a, 'viewer toCart block found');
  let src = html.slice(a, e2); if (mutate) src = mutate(src);
  const Cesium = { Cartesian3: { fromDegrees: (lon, lat, h) => ecef(lon, lat, h) } };
  return new Function('Cesium', src + '; return toCart;')(Cesium);
}
function roadPath(pts, toCart) { return pts.map(([x, z]) => { const c = toCart(x, z, 0); const g = geodetic(c[0], c[1], c[2]); return { src: [x, z], dst: geoToLocal(g.lon, g.lat) }; }); }
const run = (pairs, tweak) => O.classify(pairs.map((p) => p.src), pairs.map((p) => (tweak ? tweak(p.dst) : p.dst)));

test('building path (real buildGlb + tile transform chain) preserves orientation at far, non-collinear points', () => {
  const r = run(buildingPath(POINTS));
  assert.ok(r.ok, JSON.stringify(r.issues) + ' det=' + r.fit.det);
  assert.ok(r.fit.det > 0.9999 && r.fit.det < 1.0001);
});
test('road path (viewer toCart source) preserves orientation at far, non-collinear points', () => {
  const r = run(roadPath(POINTS, viewerToCart()));
  assert.ok(r.ok, JSON.stringify(r.issues));
});
test('building vs road: same source coordinates land on the same ground point (<5 cm)', () => {
  const b = buildingPath(POINTS), toCart = viewerToCart();
  for (const p of b) { const c = toCart(p.src[0], p.src[1], 0), g = geodetic(c[0], c[1], c[2]), l = geoToLocal(g.lon, g.lat); assert.ok(Math.hypot(l[0] - p.dst[0], l[1] - p.dst[1]) < 0.05); }
});
test('detector flags each fault (mutation checks)', () => {
  const base = buildingPath(POINTS);
  const has = (tweak, key) => { const r = run(base, tweak); assert.ok(!r.ok && r.issues.some((i) => i.startsWith(key)), key + ' -> ' + JSON.stringify(r.issues)); };
  has(([x, z]) => [x, -z], 'mirror');   // Z 符号反転（Mission36H2 型の南北反転）
  has(([x, z]) => [-x, z], 'mirror');   // X 符号反転
  has(([x, z]) => [z, x], 'mirror');    // X/Z 入替は det<0
  has(([x, z]) => [-z, x], 'rotation'); // 90°
  has(([x, z]) => [-x, -z], 'rotation'); // 180°
  has(([x, z]) => [x + 3, z - 2], 'origin-offset');
  has(([x, z]) => [x * 1.01, z * 1.01], 'scale');
  const flip = O.classify(POINTS, roadPath(POINTS, viewerToCart((s) => s.replace('PROJ.clat - z', 'PROJ.clat + z'))).map((p) => p.dst));
  assert.ok(flip.issues.some((i) => i.startsWith('mirror')), 'viewer toLat sign flip detected: ' + JSON.stringify(flip.issues));
  const mpd = O.classify(POINTS, roadPath(POINTS, viewerToCart((s) => s.replace('mpd: 111320', 'mpd: 111000'))).map((p) => p.dst));
  assert.ok(!mpd.ok);
});
test('round trip alone cannot detect a mirror (documented limitation)', () => {
  const toLon = (x) => CLON + x / (COS * MPD), badLat = (z) => CLAT + z / MPD;
  const back = (lon, lat) => [(lon - CLON) * COS * MPD, (lat - CLAT) * MPD];
  const [x, z] = [-1700, 250]; const b = back(toLon(x), badLat(z));
  assert.ok(Math.hypot(b[0] - x, b[1] - z) < 1e-6); // 往復は 0 でも鏡映
  const r = O.classify(POINTS, POINTS.map(([x2, z2]) => geoToLocal(toLon(x2), badLat(z2))));
  assert.ok(r.issues.some((i) => i.startsWith('mirror')));
});

// 実データ: 外部基準（lat/lon）で footprint の絶対位置と鏡映の有無を確認
// 阪和病院 Wikidata Q97173758 (34.6044,135.5051)、旧・阪和記念病院 (34.598444,135.513923)。いずれも 36L 索引の外部座標。
const BDIR = 'public/map-data/osaka-city/buildings/osaka-sumiyoshi';
function findBuilding(id) {
  for (const f of fs.readdirSync(BDIR)) if (/^tile_.*\.json$/.test(f)) { const t = JSON.parse(fs.readFileSync(BDIR + '/' + f, 'utf8')); const b = t.buildings.find((q) => q.id === id); if (b) return b; }
  return null;
}
const inPoly = (p, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
test('real data: external lat/lon landmarks fall inside expected footprints, and not when mirrored', { skip: !fs.existsSync(BDIR) }, () => {
  const refs = [['bldg_ec74351a-f344-4b61-b2e6-04b660b05aa0', 135.5051, 34.6044], ['bldg_fae25b63-cddc-4545-8004-c41620676308', 135.513923, 34.598444]];
  for (const [id, lon, lat] of refs) {
    const b = findBuilding(id); assert.ok(b, id);
    const p = geoToLocal(lon, lat);
    assert.ok(inPoly(p, b.fp), id + ' contains external point');
    assert.ok(!inPoly([p[0], -p[1]], b.fp), id + ' not Z-mirrored');
    assert.ok(!inPoly([-p[0], p[1]], b.fp), id + ' not X-mirrored');
  }
});
const LAB = 'public/mission37c-layers/osaka-sumiyoshi-9tile/labels.json';
test('real data: station label agrees with external lat/lon (Abikocho approx 34.602N,135.507E; north = -Z)', { skip: !fs.existsSync(LAB) }, () => {
  const d = JSON.parse(fs.readFileSync(LAB, 'utf8'));
  const s = d.items.find((i) => i.kind === 'station' && i.name === '我孫子町'); assert.ok(s);
  const lon = CLON + s.x / (COS * MPD), lat = CLAT - s.z / MPD;
  assert.ok(Math.abs(lat - 34.602) < 0.002 && Math.abs(lon - 135.507) < 0.002, lat + ',' + lon); // 概略の外部値（約±200m）
  assert.strictEqual(d.coordinateConvention, 'znorth-neg-v1');
});
test('orientation tool is offline/read-only', () => {
  const src = fs.readFileSync('tools/mission77-orientation.cjs', 'utf8');
  for (const bad of ['http', 'fetch(', 'writeFile', 'unlink', 'child_process']) assert.ok(!src.includes(bad), bad);
});
