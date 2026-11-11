'use strict';
// Mission 138: 既存 24 区ページへの実フットプリント統合（?fp=1・localhost 限定）。純粋ロジック・ローカルサーバー・ページ配線・実 Chrome QA の保存結果を確認する。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
// package.json が "type":"module" のため、この .js は ESM 扱いで module が無く、globalThis.LC138 に公開される（ブラウザの window.LC138 と同じ）
const loaded = require('../public/mission138-footprints.js');
const FP = globalThis.LC138 || loaded;
const S = require('../tools/mission138-serve-local.cjs');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'mission37g-osaka-24ward-mvp.html'), 'utf8');

// ── 最小の Cesium スタブ（描画はしない。primitive の追加・破棄の数だけを見る）──
function fakeCesium() {
  class Prim { constructor(o) { this.o = o; this.show = true; this.ready = true; this._d = false; this.attrs = {}; } isDestroyed() { return this._d; } getGeometryInstanceAttributes(id) { return (this.attrs[id] = this.attrs[id] || {}); } }
  const C = {
    GeometryInstance: class { constructor(o) { Object.assign(this, o); } },
    PolygonGeometry: class { constructor(o) { this.o = o; } },
    PolygonHierarchy: class { constructor(p) { this.p = p; } },
    PerInstanceColorAppearance: Object.assign(class { constructor(o) { this.o = o; } }, { VERTEX_FORMAT: {} }),
    ColorGeometryInstanceAttribute: { fromColor: (c) => c, toValue: (c) => c },
    Color: { fromCssColorString: (s) => ({ css: s }) },
    Primitive: Prim,
  };
  const prims = [];
  const scene = { primitives: { add: (p) => { prims.push(p); return p; }, remove: (p) => { const i = prims.indexOf(p); if (i >= 0) prims.splice(i, 1); p._d = true; } } };
  return { Cesium: C, scene, prims };
}
const bld = (id, x, z, h = 10) => ({ id, fp: [[x, z], [x + 10, z], [x + 10, z + 10], [x, z + 10]], z0: 0, h, repX: x + 5, repZ: z + 5, usage: '411' });
function fetchFor(files, delayMs = 0) {
  return async (url, o) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (o && o.signal && o.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const k = Object.keys(files).find((f) => url.endsWith(f));
    return k ? { ok: true, status: 200, json: async () => files[k] } : { ok: false, status: 404, json: async () => ({}) };
  };
}
const manifest = (tiles, extra = {}) => ({ coordinateConvention: 'znorth-neg-v1', totalBuildings: 3, ward: '住吉区', wardCode: '27120', tiles: tiles.map((t) => ({ file: t })), ...extra });

test('cleanRing / buildingSpec: 閉じ点・重複点を除き、無効な建物は捨てる', () => {
  assert.strictEqual(FP.cleanRing([[0, 0], [1, 0]]), null);
  assert.strictEqual(FP.cleanRing([[0, 0], [1, 0], [2, 0]]), null, '面積ほぼ 0');
  const r = FP.cleanRing([[0, 0], [10, 0], [10, 10], [10, 10], [0, 10], [0, 0]]);
  assert.strictEqual(r.length, 4);
  assert.ok(FP.buildingSpec(bld('bldg_a', 0, 0)));
  assert.strictEqual(FP.buildingSpec({ ...bld('bldg_a', 0, 0), h: 0 }), null, '高さ 0 は捨てる（捏造しない）');
  assert.strictEqual(FP.buildingSpec({ ...bld('x_a', 0, 0) }), null, 'canonicalId 形式でない');
  assert.strictEqual(FP.buildingSpec(bld('bldg_a', 0, 0)).id, 'bldg_a', 'ID はそのまま');
  assert.ok(FP.isSentinelHeight(29997) && !FP.isSentinelHeight(450));
});

test('create/load: 全タイルを描き、canonicalId を GeometryInstance.id に保持、重複 ID は二重表示しない', async () => {
  const { Cesium, scene, prims } = fakeCesium();
  const files = { 'manifest.json': manifest(['tile_0_0.json', 'tile_1_0.json']), 'tile_0_0.json': { buildings: [bld('bldg_1', 0, 0), bld('bldg_2', 20, 0)] }, 'tile_1_0.json': { buildings: [bld('bldg_2', 20, 0), bld('bldg_3', 40, 0)] } };
  const L = FP.create({ Cesium, scene, toCart: (x, z) => [x, z], base: 'b/', fetchImpl: fetchFor(files), isStale: () => false });
  const s = await L.load();
  assert.strictEqual(s.state, 'ready');
  assert.strictEqual(s.buildings, 3); assert.strictEqual(s.skipped, 1);
  assert.deepStrictEqual([...L.byId.keys()].sort(), ['bldg_1', 'bldg_2', 'bldg_3']);
  assert.strictEqual(prims.length, 2);
  assert.strictEqual(L.idOfPick({ id: 'bldg_2', primitive: prims[0] }), 'bldg_2');
  assert.strictEqual(L.idOfPick({ id: { poi: 1 } }), null);
  assert.strictEqual(L.idOfPick({ id: 'bldg_zzz' }), null, '層に無い ID は拾わない');
  L.destroy();
  assert.strictEqual(prims.length, 0, '破棄で scene から全て外れる');
});

test('create/load: 規約違い・タイル欠落は ready にならない。manifest 404 は missing', async () => {
  let c = fakeCesium();
  let L = FP.create({ ...c, toCart: (x, z) => [x, z], base: 'b/', fetchImpl: fetchFor({ 'manifest.json': manifest(['tile_0_0.json'], { coordinateConvention: 'other' }) }), isStale: () => false });
  await assert.rejects(L.load(), /coordinateConvention mismatch/);
  c = fakeCesium();
  L = FP.create({ ...c, toCart: (x, z) => [x, z], base: 'b/', fetchImpl: fetchFor({ 'manifest.json': manifest(['tile_0_0.json', 'tile_1_0.json']), 'tile_0_0.json': { buildings: [bld('bldg_1', 0, 0)] } }), isStale: () => false });
  const s = await L.load();
  assert.strictEqual(s.state, 'incomplete'); assert.strictEqual(s.failedTiles, 1);
  c = fakeCesium();
  L = FP.create({ ...c, toCart: (x, z) => [x, z], base: 'b/', fetchImpl: fetchFor({}), isStale: () => false });
  assert.strictEqual((await L.load()).state, 'missing');
  assert.strictEqual(c.prims.length, 0, '欠落データから偽の建物を描かない');
});

test('create/load: 古い要求(isStale)は途中で止まり、破棄で primitive を残さない', async () => {
  const { Cesium, scene, prims } = fakeCesium();
  let stale = false;
  const tiles = Array.from({ length: 8 }, (_, i) => `tile_${i}_0.json`);
  const files = { 'manifest.json': manifest(tiles) }; tiles.forEach((t, i) => { files[t] = { buildings: [bld('bldg_t' + i, i * 20, 0)] }; });
  const L = FP.create({ Cesium, scene, toCart: (x, z) => [x, z], base: 'b/', fetchImpl: fetchFor(files, 5), isStale: () => stale, concurrency: 1 });
  const p = L.load();
  setTimeout(() => { stale = true; L.destroy(); }, 18);
  const s = await p;
  assert.strictEqual(s.state === 'stale' || s.state === 'destroyed', true);
  assert.ok(s.loadedTiles < 8, '全タイルは読まない');
  assert.strictEqual(prims.length, 0);
});

test('select/unselect: 選択色を設定し、解除で元の色に戻す', async () => {
  const { Cesium, scene, prims } = fakeCesium();
  const files = { 'manifest.json': manifest(['tile_0_0.json']), 'tile_0_0.json': { buildings: [bld('bldg_1', 0, 0, 50)] } };
  const L = FP.create({ Cesium, scene, toCart: (x, z) => [x, z], base: 'b/', fetchImpl: fetchFor(files), isStale: () => false, accent: '#2f7bff' });
  await L.load();
  assert.ok(L.select('bldg_1'));
  assert.strictEqual(prims[0].attrs.bldg_1.color.css, '#2f7bff');
  L.unselect();
  assert.strictEqual(prims[0].attrs.bldg_1.color.css, FP.tone(50));
  assert.strictEqual(L.select('bldg_nope'), false);
});

test('ローカルサーバー: allowlist・404・パス走査拒否・Host 検査・読み取り専用', async () => {
  const fpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm138-t-fp-')), lyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm138-t-ly-'));
  fs.mkdirSync(path.join(fpRoot, 'osaka-chuo')); fs.writeFileSync(path.join(fpRoot, 'osaka-chuo', 'manifest.json'), '{"a":1}'); fs.writeFileSync(path.join(fpRoot, 'osaka-chuo', 'secret.txt'), 'x');
  fs.mkdirSync(path.join(lyRoot, 'chuo', 'layers'), { recursive: true }); fs.writeFileSync(path.join(lyRoot, 'chuo', 'layers', 'roads.json'), '{"b":1}');
  const before = fs.readdirSync(fpRoot).join();
  const s = await S.listen({ publicDir: path.join(__dirname, '..', 'public'), footprintsRoot: fpRoot, layersRoot: lyRoot }, 0);
  const get = (p, opt = {}) => new Promise((res) => { const r = http.request({ host: '127.0.0.1', port: s.port, path: p, method: opt.method || 'GET', headers: opt.headers }, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => res({ status: x.statusCode, body: d })); }); r.end(); });
  try {
    assert.strictEqual((await get('/ext-3dtiles/chuo/footprints/manifest.json')).status, 200);
    assert.strictEqual((await get('/ext-3dtiles/chuo/layers/roads.json')).body, '{"b":1}');
    assert.strictEqual((await get('/ext-3dtiles/chuo/footprints/secret.txt')).status, 404, 'allowlist 外');
    assert.strictEqual((await get('/ext-3dtiles/osaka/footprints/manifest.json')).status, 404, '無い区は 404');
    assert.strictEqual((await get('/ext-3dtiles/chuo/layers/water-surface.json')).status, 404, '欠落は 404（偽の 200 を返さない）');
    assert.strictEqual((await get('/ext-3dtiles/../x/footprints/manifest.json')).status, 404);
    assert.strictEqual((await get('/ext-3dtiles/chuo/footprints/manifest.json', { method: 'POST' })).status, 405);
    assert.strictEqual((await get('/ext-3dtiles/chuo/footprints/manifest.json', { headers: { Host: 'evil.example:80' } })).status, 403);
    assert.strictEqual((await get('/mission37g-osaka-24ward-mvp.html')).status, 200, 'public/ は 40F と同じく配信');
  } finally { s.srv.close(); }
  assert.strictEqual(fs.readdirSync(fpRoot).join(), before, 'サーバーは何も書かない');
  assert.ok(S.safeFile(fpRoot, 'osaka-chuo/manifest.json') && !S.safeFile(fpRoot, '../etc/passwd'));
});

test('ページ配線: ?fp=1 は localhost 限定、既存分岐を壊さず、区切替で破棄し、Google 参照を増やさない', () => {
  assert.match(PAGE, /const FP_ON = \/\^\(localhost\|127\\\.0\\\.0\\\.1\)\$\/\.test\(location\.hostname\) && q\.get\('fp'\) === '1'/);
  assert.match(PAGE, /<script src="mission138-footprints\.js"><\/script>/);
  assert.match(PAGE, /if \(FP_ON\) \{ const fr = await mountFootprints/);
  assert.match(PAGE, /fpUnmount\(\);/);
  assert.match(PAGE, /ctrl\.abort\(\)/);
  assert.match(PAGE, /idOfPick\(picked\)/);
  assert.match(PAGE, /livecity:37d-building-selected/);
  assert.match(PAGE, /外部変換の 3D Tiles が無い区だけ/, '外部 3D Tiles を優先');
  assert.match(PAGE, /劣化させない/, '既存の部分配信サンプルより少なければ置換しない');
  for (const f of ['public/mission138-footprints.js', 'tools/mission138-serve-local.cjs']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /googleapis|google\.com|maps\.google/i, f);
  }
});

test('保存済み実 Chrome QA: 住吉区 35,031 棟・実クリック・区切替・競合・Google 通信 0・JS 例外 0', () => {
  const f = path.join(__dirname, '..', 'data', 'reports', 'mission138', 'integrated-qa.json');
  if (!fs.existsSync(f)) return;   // QA 未実行の環境ではスキップ（実行コマンドはレポート参照）
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.jsErrorCount, 0); assert.strictEqual(r.googleRequestCount, 0); assert.deepStrictEqual(r.failedRequests, []);
  const by = Object.fromEntries(r.steps.map((s) => [s.label, s]));
  assert.strictEqual(by['住吉区 footprints'].fp.buildings, 35031);
  assert.strictEqual(by['住吉区 footprints'].fp.tiles, 52);
  assert.ok(by['実クリック'].clicks.length >= 1 && by['実クリック'].clicks.every((c) => c.selected));
  assert.strictEqual(by['区別 道路・河川（合成 fixture）'].synthetic, true, '合成 fixture は実データと区別して記録');
});
