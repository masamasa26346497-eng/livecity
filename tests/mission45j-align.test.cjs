'use strict';
// Mission 45J: 座標規約の検証・fast clip・relevel 再利用。Node の純粋ロジック + 合成 fixture + ページ配線の静的確認。
// ブラウザ実描画・Windows 実データでの確認ではない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const A = require('../tools/lib/mission45j-align.cjs');
const B37 = require('../tools/mission37b-build-3dtiles.cjs');
const B45 = require('../tools/mission45i-build-layers-24.cjs');
const V = (() => { const m = require('../public/mission45i-vec.js'); return m && m.planKeys ? m : globalThis.LC45I; })();
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// ── 1. 建物 GLB の ENU 変換と、ビューアの toCart が同一の [x,z] で一致する（住吉以外・遠方区を含む） ──
const D2R = Math.PI / 180, WA = 6378137, WE2 = 0.00669437999014;
const ecef = (lon, lat, h) => { const l = lon * D2R, p = lat * D2R, s = Math.sin(p), c = Math.cos(p), N = WA / Math.sqrt(1 - WE2 * s * s); return [(N + h) * c * Math.cos(l), (N + h) * c * Math.sin(l), (N * (1 - WE2) + h) * s]; };
test('viewer PROJ constants equal the building builder constants (no hidden offset / rotation)', () => {
  const m = html.match(/const PROJ = \{ clat: ([\d.]+), clon: ([\d.]+), mpd: (\d+) \}/);
  assert.ok(m, 'PROJ literal present');
  assert.deepStrictEqual([Number(m[1]), Number(m[2]), Number(m[3])], [34.604208, 135.525020, 111320]);
  assert.match(html, /toLon = \(x\) => PROJ\.clon \+ x \/ \(COS_CLAT \* PROJ\.mpd\)/);
  assert.match(html, /toLat = \(z\) => PROJ\.clat - z \/ PROJ\.mpd/);
});
test('GLB path (tile frame ENU -> world) == viewer toCart path for far wards too (< 1 mm)', () => {
  const lon = (x) => 135.525020 + x / (Math.cos(34.604208 * D2R) * 111320), lat = (z) => 34.604208 - z / 111320;   // ビューアの toLon/toLat と同一式
  let worst = 0, n = 0;
  for (const w of wards) {
    const cx = (w.bbox.minX + w.bbox.maxX) / 2, cz = (w.bbox.minZ + w.bbox.maxZ) / 2;
    // タイル中心を基準フレームにし、同じ区内の複数点を GLB 経由 (toEnu → frame.t + basis*enu) とビューア経由 (ecef) で比べる
    const f = B37.makeFrame(B37.localToLon(cx), B37.localToLat(cz));
    for (const [dx, dz] of [[0, 0], [250, 250], [-250, 250], [250, -250], [-400, -400]]) {
      const x = cx + dx, z = cz + dz;
      const enu = B37.toEnu(f, B37.localToLon(x), B37.localToLat(z), 12);
      const viaGlb = [0, 1, 2].map((i) => f.t[i] + enu[0] * f.b.e[i] + enu[1] * f.b.n[i] + enu[2] * f.b.u[i]);
      const viaViewer = ecef(lon(x), lat(z), 12);
      worst = Math.max(worst, Math.hypot(viaGlb[0] - viaViewer[0], viaGlb[1] - viaViewer[1], viaGlb[2] - viaViewer[2])); n++;
    }
  }
  assert.ok(n >= 24 * 5);
  assert.ok(worst < 1e-3, 'worst error ' + worst + ' m');
});
test('glTF vertex mapping is [E, U, -N] (Y-up) which Cesium maps back to E,N,U: no axis swap / sign flip', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/mission37b-build-3dtiles.cjs'), 'utf8');
  assert.match(src, /pos\.push\(enu\[0\], enu\[2\], -enu\[1\]\)/);
});
test('north is z-negative in both: a point north of origin has negative z and larger latitude', () => {
  assert.ok(B37.localToLat(-1000) > B37.localToLat(0));
  assert.ok(B37.localToLon(1000) > B37.localToLon(0));
});

// ── 2. manifest 検証 ──
const goodManifest = () => ({ coordinateConvention: 'znorth-neg-v1', coordinateSystem: 'meters-local', tileSize: 2000, buffer: 0, bboxLocal: { minX: -20000, maxX: 20000, minZ: -30000, maxZ: 20000 }, layerBounds: { minX: -9000, maxX: 9000, minZ: -9000, maxZ: 9000 } });
test('validateSourceManifest: accepts the declared convention, flags everything else', () => {
  const ok = A.validateSourceManifest(goodManifest());
  assert.ok(ok.ok && ok.notes.length >= 1, 'projection origin not recorded is noted, not hidden');
  assert.ok(!A.validateSourceManifest(Object.assign(goodManifest(), { coordinateConvention: 'znorth-pos-v1' })).ok);
  assert.ok(!A.validateSourceManifest(Object.assign(goodManifest(), { coordinateSystem: 'degrees' })).ok);
  assert.ok(!A.validateSourceManifest(Object.assign(goodManifest(), { bboxLocal: { minX: -2e5, maxX: 2e5, minZ: -2e5, maxZ: 2e5 } })).ok, 'unit/origin suspect');
  assert.ok(!A.validateSourceManifest({}).ok);
  assert.ok(!A.validateSourceManifest(null).ok);
});

// ── 3. N03 突合: 軸 / 符号の取り違えを検出 ──
function pointsInside(w, n) {
  const ins = V.makeInsideTester(w.polygons, 64), pts = [];
  while (pts.length < n) { const x = w.bbox.minX + rnd() * (w.bbox.maxX - w.bbox.minX), z = w.bbox.minZ + rnd() * (w.bbox.maxZ - w.bbox.minZ); if (ins(x, z)) pts.push([x, z]); }
  return pts;
}
test('probeConvention: identity confirmed on correct data; flipped / swapped data is detected', () => {
  const w = wards.find((x) => x.wardId === 'kita') || wards[0];
  const pts = pointsInside(w, 400);
  assert.strictEqual(A.probeConvention(pts, w.polygons).verdict, 'identity-confirmed');
  for (const name of ['flipZ', 'flipX', 'rot180', 'swap']) {
    const bad = pts.map(([x, z]) => A.TRANSFORMS[name](x, z));
    const r = A.probeConvention(bad, w.polygons);
    assert.notStrictEqual(r.verdict, 'identity-confirmed', name);
  }
  assert.strictEqual(A.probeConvention([], w.polygons).verdict, 'no-points');
});

// ── 4. 回転 (yaw) の推定: 4 クラスタ未満は断定しない ──
function gridRoads(x0, z0, n, step) {
  const lines = [];
  for (let i = 0; i <= n; i++) { lines.push([[x0, z0 + i * step], [x0 + n * step, z0 + i * step]]); lines.push([[x0 + i * step, z0], [x0 + i * step, z0 + n * step]]); }
  return lines;
}
function bldgNearRoads(x0, z0, n, step, count) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const i = Math.floor(rnd() * (n + 1)), t = rnd() * n * step, off = (rnd() < 0.5 ? -1 : 1) * 7;
    out.push(rnd() < 0.5 ? [x0 + t, z0 + i * step + off] : [x0 + i * step + off, z0 + t]);
  }
  return out;
}
const rot = (p, deg) => { const t = deg * D2R; return [p[0] * Math.cos(t) - p[1] * Math.sin(t), p[0] * Math.sin(t) + p[1] * Math.cos(t)]; };
test('yawScan: detects a consistent 1.5 deg rotation across >= 4 clusters; asserts nothing with fewer / without rotation', () => {
  const roads = [], bl = [];
  for (const [x0, z0] of [[3000, 3000], [5000, 3000], [3000, 5000], [5000, 5000], [-5000, 3000]]) { gridRoads(x0, z0, 10, 200).forEach((l) => roads.push(l)); bl.push(...bldgNearRoads(x0, z0, 10, 200, 120)); }
  const rotated = bl.map((p) => rot(p, 1.5));
  const r = A.yawScan(roads, rotated);
  assert.ok(r.clusters >= 4);
  assert.strictEqual(r.rotationDetected, true, JSON.stringify(r.perCluster));
  assert.ok(Math.abs(r.estimatedDeg + 1.5) <= 0.25 + 1e-9, 'estimated ' + r.estimatedDeg);
  const none = A.yawScan(roads, bl);
  assert.strictEqual(none.rotationDetected, false);
  const few = A.yawScan(roads, rotated.filter((p) => p[0] > 0 && p[0] < 2400 + 3000 * 2).slice(0, 80));
  assert.strictEqual(few.rotationDetected, false);
  assert.match(few.conclusion, /inconclusive|no consistent/);
});

// ── 5. ビルダーは宣言と合わない manifest を書き出さない ──
test('builder refuses a source whose manifest declares another convention (nothing written)', () => {
  const w = wards.find((x) => x.wardId === 'kita') || wards[0];
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lc45j-src-')), root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc45j-out-')), 'layers');
  const size = 2000, cx = (w.bbox.minX + w.bbox.maxX) / 2, cz = (w.bbox.minZ + w.bbox.maxZ) / 2;
  for (const l of ['roads', 'waterways', 'parks', 'railways']) {
    fs.mkdirSync(path.join(src, l));
    fs.writeFileSync(path.join(src, l, 'manifest.json'), JSON.stringify(Object.assign(goodManifest(), { tileSize: size, coordinateConvention: 'znorth-pos-v1' })));
    const feats = l === 'roads' ? [{ id: 'r1', kind: 'line', tier: 'major', p: [[cx, cz], [cx + 100, cz]] }] : [];
    for (let tx = Math.floor((w.bbox.minX - 5) / size); tx <= Math.floor((w.bbox.maxX + 5) / size); tx++) for (let tz = Math.floor((w.bbox.minZ - 5) / size); tz <= Math.floor((w.bbox.maxZ + 5) / size); tz++) fs.writeFileSync(path.join(src, l, `tile_${tx}_${tz}.json`), JSON.stringify({ features: feats }));
  }
  const cov = B45.run({ src, layersRoot: root, wards: [w.wardId] });
  assert.strictEqual(cov.wards[0].stage, 'convention-mismatch');
  assert.ok(!fs.existsSync(path.join(root, w.wardId, 'layers')), 'no ward layers written');
});
test('builder source: convention comes from the manifest, ward-polygon clip is done once at build time, no hard-coded znorth literal in the output', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/mission45i-build-layers-24.cjs'), 'utf8');
  assert.match(src, /coordinateConvention: convention/);
  assert.match(src, /clipped: clippedKind/);
  assert.doesNotMatch(src, /coordinateConvention: 'znorth-neg-v1', coordinateSystem/);
});

// ── 6. fast clip は厳密判定と同じ結果で、厳密計算は境界セルだけ ──
const pipRef = (r, x, z) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (((r[i][1] > z) !== (r[j][1] > z)) && (x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) c = !c; return c; };
test('makeInsideTester equals the exact test on real ward polygons; most calls avoid the exact path', () => {
  for (const id of ['kita', 'sumiyoshi', 'minato']) {
    const w = wards.find((x) => x.wardId === id); if (!w) continue;
    const ref = (x, z) => w.polygons.some((p) => pipRef(p.outer, x, z) && !(p.holes || []).some((h) => pipRef(h, x, z)));
    const f = V.makeInsideTester(w.polygons, 64);
    let diff = 0;
    for (let i = 0; i < 20000; i++) { const x = w.bbox.minX - 200 + rnd() * (w.bbox.maxX - w.bbox.minX + 400), z = w.bbox.minZ - 200 + rnd() * (w.bbox.maxZ - w.bbox.minZ + 400); if (f(x, z) !== ref(x, z)) diff++; }
    assert.strictEqual(diff, 0, id);
    assert.ok(f.stats.exactCalls < f.stats.fastCalls, id + ' exact ' + f.stats.exactCalls + ' fast ' + f.stats.fastCalls);
  }
});
test('clipRuns keeps the same runs as the 40M rule (inside vertices + 1 neighbour)', () => {
  const sq = [{ outer: [[0, 0], [100, 0], [100, 100], [0, 100]] }];
  const f = V.makeInsideTester(sq, 8);
  const runs = V.clipRuns([[-50, 50], [-10, 50], [10, 50], [90, 50], [110, 50], [150, 50]], f);
  assert.strictEqual(runs.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(runs[0])), [[-10, 50], [10, 50], [90, 50], [110, 50]]);
});

// ── 7. relevel は破棄ではなく追加 + show/hide ──
test('planKeys: coarser level adds nothing and only hides; finer level adds only the missing keys', () => {
  const near = V.KEYS_BY_LEVEL.near;
  const toFar = V.planKeys(near, 'far');
  assert.deepStrictEqual(toFar.add, []);
  assert.ok(toFar.hide.includes('parks') && toFar.hide.includes('roads:local') && !toFar.hide.includes('roads:major'));
  const up = V.planKeys(V.KEYS_BY_LEVEL.far, 'near');
  assert.deepStrictEqual(up.add.slice().sort(), ['parks', 'roads:local', 'roads:mid', 'waterways'].sort());
  assert.strictEqual(V.keyLayer('roads:major'), 'roads');
});
test('viewer wiring: relevel does not destroy; moving camera defers builds; one ward per tick; prebuilt clip honoured; perf stats exposed', () => {
  assert.match(html, /async function vecRelevel/);
  assert.match(html, /for \(const code of p\.drop\) vecDrop\(code\)/, 'only real drops destroy');
  assert.doesNotMatch(html, /p\.drop\.concat\(p\.relevel\)/, 'old destroy-on-relevel removed');
  assert.match(html, /isMoving\(\) && \(p\.mount\.length \|\| p\.relevel\.length\)/);
  assert.match(html, /if \(did >= 1\) \{ vecDirty = true; break; \}/);
  assert.match(html, /data\.clipped !== 'ward-polygon'/);
  for (const k of ['clipMs', 'convertMs', 'polylines', 'vertices', 'yields', 'layerFetches', 'relevelsTotal', 'reuseTotal', 'deferredMoving']) assert.ok(html.includes(k), k);
  assert.match(html, /await new Promise\(\(r\) => setTimeout\(r, 0\)\)/, 'yields to the browser while building');
  assert.doesNotMatch(html, /googleapis|maps\.google/);
});
