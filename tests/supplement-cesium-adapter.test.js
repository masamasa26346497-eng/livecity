// 補完レイヤーの Cesium アダプタ/座標回帰テスト。Cesium は最小スタブ（実 Cesium・実データではない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PROJ, makeProjection } from '../public/supplement-layer/projection.js';
import { createCesiumMeshBuilder, createCesiumGroup, connectSupplement } from '../public/supplement-layer/supplement-cesium-adapter.js';

const Cesium = {
  Cartesian3: { fromDegrees: (lon, lat, h) => ({ lon, lat, h }) },
  Math: { toDegrees: (r) => r * 180 / Math.PI },
  PolygonHierarchy: class { constructor(positions, holes = []) { this.positions = positions; this.holes = holes; } },
  PolygonGeometry: class { constructor(o) { Object.assign(this, o); } },
  GeometryInstance: class { constructor(o) { Object.assign(this, o); } },
  PerInstanceColorAppearance: Object.assign(class { constructor(o) { Object.assign(this, o); } }, { VERTEX_FORMAT: 'vf' }),
  ColorGeometryInstanceAttribute: { fromColor: (c) => ({ c }) },
  Color: { fromCssColorString: (s) => ({ css: s, withAlpha(a) { return { css: s, a }; } }) },
  Primitive: class { constructor(o) { Object.assign(this, o); } },
};
const mkScene = () => { const s = { prims: [], renders: 0, primitives: { add(p) { s.prims.push(p); }, remove(p) { s.prims = s.prims.filter((x) => x !== p); } }, requestRender() { s.renders++; } }; return s; };
const mkViewer = (lon, lat, height) => { const L = []; return { scene: mkScene(), listeners: L, camera: { positionCartographic: { longitude: lon * Math.PI / 180, latitude: lat * Math.PI / 180, height }, moveEnd: { addEventListener: (f) => L.push(f), removeEventListener: (f) => { const i = L.indexOf(f); if (i >= 0) L.splice(i, 1); } } } }; };
const rec = (o = {}) => ({ id: 'a', polys: [[[[0, 0], [10, 0], [10, 10], [0, 10]], [[3, 3], [6, 3], [6, 6], [3, 6]]]], z0: 0, height: 9, heightClass: 'estimated', heightSource: 'levels*3m', ...o });
const json = (o, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => o });
const manifest = { schema: 'livecity-supplement-layer-v1', tileSize: 100, publishable: true, tiles: [{ tx: 0, tz: 0, file: 'tile_0_0.json' }] };
const tile = { layer: 'supplement', buildings: [{ id: 'a', polys: rec().polys, h: 9, heightEstimated: true, heightSource: 'levels*3m' }, { id: 'diag', geometry: null, diagnostic: true }] };

test('投影: PR68 の定数・式と一致し往復で戻る', () => {
  assert.deepEqual({ ...PROJ }, { clat: 34.604208, clon: 135.525020, mpd: 111320 });
  const P = makeProjection(); const cos = Math.cos(34.604208 * Math.PI / 180);
  assert.equal(P.toLon(0), 135.525020); assert.equal(P.toLat(0), 34.604208);
  assert.ok(Math.abs(P.toLon(111320 * cos) - 136.525020) < 1e-9);
  assert.ok(Math.abs(P.toLat(-111320) - 35.604208) < 1e-9, 'z北=負');
  const l = P.toLocal(P.toLon(1234.5), P.toLat(-567.8));
  assert.ok(Math.abs(l.x - 1234.5) < 1e-6 && Math.abs(l.z + 567.8) < 1e-6);
});

test('投影: PR68 HTML が checkout にあれば定数が一致（無ければ skip）', { skip: !fs.existsSync('public/mission37g-osaka-24ward-mvp.html') }, () => {
  const h = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');
  assert.match(h, /PROJ\s*=\s*\{\s*clat:\s*34\.604208,\s*clon:\s*135\.525020,\s*mpd:\s*111320\s*\}/);
});

test('メッシュ: 内周は holes、MultiPolygon は複数インスタンス、height/extrudedHeight', () => {
  const toCart = (x, z, h) => ({ x, z, h });
  const build = createCesiumMeshBuilder({ Cesium, toCart });
  const multi = rec({ id: 'm', polys: [[[[0, 0], [5, 0], [5, 5]]], [[[20, 20], [30, 20], [30, 30]]]], z0: 2, height: 4 });
  const out = build({ buildings: [rec(), multi] }, { tx: 0, tz: 0 });
  const ins = out.object.geometryInstances;
  assert.equal(ins.length, 3);
  assert.equal(ins[0].geometry.polygonHierarchy.holes.length, 1);
  assert.equal(ins[0].geometry.polygonHierarchy.holes[0].positions.length, 4);
  assert.equal(ins[0].geometry.height, 0); assert.equal(ins[0].geometry.extrudedHeight, 9);
  assert.equal(ins[1].geometry.height, 2); assert.equal(ins[1].geometry.extrudedHeight, 6);
  assert.equal(ins[0].id.layer, 'supplement'); assert.equal(out.pickMap.get(ins[0].id).id, 'a');
  assert.equal(ins[1].id, ins[2].id, 'MultiPolygon は同一 id');
});

test('グループ: add/remove で requestRender、二重 remove は無害', () => {
  const s = mkScene(); const g = createCesiumGroup({ scene: s, requestRender: () => s.requestRender() });
  const p = {}; g.add(p); assert.equal(s.prims.length, 1); g.remove(p); g.remove(p);
  assert.equal(s.prims.length, 0); assert.equal(s.renders, 3);
});

test('接続: 既定OFFは通信ゼロ、enable で manifest、カメラ範囲のタイルだけ取得、座標は共通投影', async () => {
  const P = makeProjection(); const viewer = mkViewer(P.toLon(50), P.toLat(-50), 100); const urls = [];
  const fetchImpl = async (u) => { urls.push(u); return json(u.endsWith('manifest.json') ? manifest : tile); };
  const c = connectSupplement({ Cesium, viewer, baseUrl: 'x/', fetchImpl });
  assert.equal(urls.length, 0); assert.equal(c.layer.state, 'off');
  await c.enable(); await c.layer.idle();
  assert.deepEqual(urls, ['x/manifest.json', 'x/tile_0_0.json']);
  assert.equal(viewer.scene.prims.length, 1);
  const ins = viewer.scene.prims[0].geometryInstances[0];
  const p0 = ins.geometry.polygonHierarchy.positions[1]; // world (10,0)
  assert.ok(Math.abs(p0.lon - P.toLon(10)) < 1e-12 && Math.abs(p0.lat - P.toLat(0)) < 1e-12);
  assert.equal(c.layer.stats.skippedBuildings, 1, '診断レコードは描画しない');
  assert.equal(c.pickRecord({ id: ins.id }).id, 'a'); assert.equal(c.pickRecord({ id: { layer: 'plateau' } }), null); assert.equal(c.pickRecord(undefined), null);
  assert.ok(viewer.scene.renders > 0);
  c.disable(); assert.equal(viewer.scene.prims.length, 0); assert.equal(viewer.listeners.length, 0); assert.equal(c.layer.state, 'off');
});

test('接続: カメラが遠ければタイルを取得しない / moveEnd で範囲更新', async () => {
  const P = makeProjection(); const viewer = mkViewer(P.toLon(5000), P.toLat(0), 100); const urls = [];
  const fetchImpl = async (u) => { urls.push(u); return json(u.endsWith('manifest.json') ? manifest : tile); };
  const timers = []; const c = connectSupplement({ Cesium, viewer, baseUrl: 'x/', fetchImpl, setTimeoutImpl: (f) => (timers.push(f), timers.length), clearTimeoutImpl: () => {} });
  await c.enable(); await c.layer.idle(); assert.deepEqual(urls, ['x/manifest.json']);
  viewer.camera.positionCartographic = { longitude: P.toLon(50) * Math.PI / 180, latitude: P.toLat(-50) * Math.PI / 180, height: 100 };
  viewer.listeners[0](); timers.at(-1)(); await c.layer.idle();
  assert.ok(urls.includes('x/tile_0_0.json'));
  assert.equal(viewer.listeners.length, 1, 'リスナーは二重登録しない');
});

test('異常系: manifest 404 でも例外なし・何も描画せず、unpublishable は拒否（外部から緩められない）', async () => {
  const P = makeProjection();
  let viewer = mkViewer(P.toLon(0), P.toLat(0), 100);
  let c = connectSupplement({ Cesium, viewer, baseUrl: 'x/', fetchImpl: async () => json({}, false) });
  assert.equal(await c.enable(), 'error'); assert.equal(viewer.scene.prims.length, 0); assert.equal(viewer.listeners.length, 0);
  viewer = mkViewer(P.toLon(0), P.toLat(0), 100);
  c = connectSupplement({ Cesium, viewer, baseUrl: 'x/', allowUnpublishable: true, fetchImpl: async (u) => json(u.endsWith('manifest.json') ? { ...manifest, publishable: false } : tile) });
  assert.equal(await c.enable(), 'blocked-unpublishable'); assert.equal(viewer.scene.prims.length, 0);
});
