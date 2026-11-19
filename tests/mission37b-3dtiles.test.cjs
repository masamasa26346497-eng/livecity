'use strict';
// Mission 37B: 3D Tiles 変換ツールの検証（ブラウザ・ネットワーク不要）。
//   node --test tests/mission37b-3dtiles.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../tools/mission37b-build-3dtiles.cjs');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'mission37b-3dtiles-poc.html'), 'utf8');

test('triangulate: 凹多角形(L字)の面積が元と一致する', () => {
  const L = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
  const { tris, fallback } = lib.triangulate(L);
  assert.strictEqual(fallback, false);
  assert.strictEqual(tris.length / 3, L.length - 2);
  let a = 0;
  for (let i = 0; i < tris.length; i += 3) a += Math.abs(lib.signedArea([L[tris[i]], L[tris[i + 1]], L[tris[i + 2]]]));
  assert.ok(Math.abs(a - 7) < 1e-9);
});

test('buildGlb: canonicalId を一切変更せず GLB に保持する', () => {
  const frame = lib.makeFrame(135.525020, 34.604208);
  const feats = [
    { id: 'bldg_aaaaaaaa-0000-0000-0000-000000000001', fp: [[0, 0], [10, 0], [10, -8], [0, -8], [0, 0]], z0: 0, top: 12, h: 12 },
    { id: 'bldg_aaaaaaaa-0000-0000-0000-000000000002', fp: [[20, 0], [30, 0], [30, 5]], z0: 0, top: 5, h: 5 },
    { id: 'bldg_degenerate', fp: [[0, 0], [1, 1]], z0: 0, top: 3, h: 3 },
  ];
  const r = lib.buildGlb(feats, frame);
  assert.deepStrictEqual(r.ids, [feats[0].id, feats[1].id]);
  assert.strictEqual(r.stats.skipped, 1);
  const g = lib.parseGlb(r.glb);
  assert.deepStrictEqual(g.canonicalIds, r.ids);
  assert.deepStrictEqual([...g.featureIds].sort(), [0, 1]);
  assert.ok(g.json.extensions.EXT_structural_metadata.propertyTables[0].properties.canonicalId);
  assert.strictEqual(g.json.meshes[0].primitives[0].extensions.EXT_mesh_features.featureIds[0].featureCount, 2);
});

test('relativeMatrix: 親 transform と合成すると子の transform に戻る', () => {
  const p = lib.makeFrame(135.50, 34.60), c = lib.makeFrame(135.52, 34.61);
  const rel = lib.relativeMatrix(p, c), pm = lib.frameMatrix(p), cm = lib.frameMatrix(c);
  const mul = (a, b) => { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o; };
  const comp = mul(pm, rel);
  comp.forEach((v, i) => assert.ok(Math.abs(v - cm[i]) < 1e-3, 'idx ' + i));
});

test('build: 1 tile を変換し、全 canonicalId が元 tile と一致する（ID 新規採番なし）', () => {
  const dataset = 'osaka-sumiyoshi';
  const dir = path.join(pub, 'map-data/osaka-city/buildings', dataset);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const t = m.tiles.find(x => x.tx === -5 && x.tz === -2);
  if (!t) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'm37b-'));
  const rep = lib.build({ dataset, all: false, tx0: -5, tx1: -5, tz0: -2, tz1: -2, out, group: 4, coarseError: 40, coarseMinArea: 100 });
  const src = JSON.parse(fs.readFileSync(path.join(dir, t.file), 'utf8')).buildings.map(b => b.id);
  const ids = JSON.parse(fs.readFileSync(path.join(out, 'ids/t_-5_-2.json'), 'utf8'));
  assert.strictEqual(rep.totals.buildings + rep.totals.skipped, src.length);
  const srcSet = new Set(src);
  ids.forEach(id => assert.ok(srcSet.has(id) && /^bldg_/.test(id)));
  const g = lib.parseGlb(fs.readFileSync(path.join(out, 'tiles/t_-5_-2.glb')));
  assert.deepStrictEqual(g.canonicalIds, ids);
  const ts = JSON.parse(fs.readFileSync(path.join(out, 'tileset.json'), 'utf8'));
  assert.strictEqual(ts.asset.version, '1.1');
  assert.ok(ts.root.children[0].children[0].content.uri.endsWith('.glb'));
  fs.rmSync(out, { recursive: true, force: true });
});

test('ビューアは Cesium3DTileset・SSE 8/16/32・canonicalId 取得・HUD 項目を備える', () => {
  assert.match(html, /Cesium3DTileset\.fromUrl/);
  assert.match(html, /<option>8<\/option><option selected>16<\/option><option>32<\/option>/);
  assert.match(html, /getProperty\('canonicalId'\)/);
  assert.match(html, /\/\^bldg_\//);
  for (const id of ['h-fps', 'h-p95', 'h-first', 'h-tiles', 'h-bldg', 'h-heap']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.ok(!/maps\.googleapis|tile\.googleapis|photorealistic/i.test(html.replace(/<!--[\s\S]*?-->/g, '')));
});

test('投影定数は geoToThree() と同一', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools/mission37b-build-3dtiles.cjs'), 'utf8');
  assert.match(src, /CLAT = 34\.604208, CLON = 135\.525020, MPD = 111320/);
});
