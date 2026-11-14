'use strict';
// Mission 213 Phase 1: 都市全体 LOD0 のビルダーを合成 fixture で検証(ネットワーク不要・実データ無し)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mkTile = (items) => ({ fields: ['h', 'usage', 'repX', 'repZ', 'z0'], byId: Object.fromEntries(items.map((v, i) => ['bldg_' + v[3] + '_' + i, [v[0], null, v[1], v[2], 0]])) });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lod0-'));
  const put = (ward, name, tile) => { const d = path.join(root, ward, 'attrs'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name), JSON.stringify(tile)); };
  // 区A と 区B が x=1000 付近(セル境界=200mの倍数)で隣接。同一セル(cx=5)に両区の棟が入る
  put('a', 't_0_0.json', mkTile([[10, 100, 100, 'a'], [20, 130, 120, 'a'], [30, 990, 100, 'a'], [30, 1010, 105, 'a']]));
  put('b', 't_2_0.json', mkTile([[40, 1020, 110, 'b'], [50, 1150, 130, 'b'], [15, 1400, 400, 'b'], [15, 1410, 410, 'b']]));
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ wards: [], lod0Wards: [] }));
  return root;
}
const WARDS = [{ id: 'a', code: '27101' }, { id: 'b', code: '27102' }];

test('全区共通グリッド: 区境セルは 1 つに統合され二重化しない / 少数セルは落とす', async () => {
  const { aggregateCity, loadWardAttrs } = await import('../tools/cloud/city-lod0.mjs');
  const root = fixture();
  const agg = aggregateCity({ wardAttrs: WARDS.map((w) => loadWardAttrs(root, w.code, w.id)), cell: 200, minCount: 2 });
  const keys = agg.cells.map((c) => c.cx + '_' + c.cz);
  assert.strictEqual(new Set(keys).size, keys.length, 'セル重複なし');
  const border = agg.cells.find((c) => c.cx === 5 && c.cz === 0);   // x 1000..1200
  assert.ok(border && border.n === 3, '区境セルは a/b の棟を合算: ' + JSON.stringify(border));
  assert.strictEqual(agg.stats.cellsDroppedBelowMin, 1)   // x=990 単独セル(n=1);
  assert.ok(agg.cells.some((c) => c.cx === 7 && c.cz === 2 && c.n === 2));
});

test('LOD2 化した棟を戻し、LOD2 のみのセルが欠落しない(既定高さは flag)', async () => {
  const { aggregateCity, loadWardAttrs, lonToLocal, latToLocal } = await import('../tools/cloud/city-lod0.mjs');
  const root = fixture();
  const lod2 = [{ x: 3000, z: 3000 }, { x: 3050, z: 3020 }];
  const agg = aggregateCity({ wardAttrs: WARDS.map((w) => loadWardAttrs(root, w.code, w.id)), lod2Points: lod2, cell: 200 });
  const c = agg.cells.find((x) => x.cx === 15 && x.cz === 15);
  assert.ok(c && c.lod2 === 2 && c.meanH === 12);
  assert.strictEqual(agg.stats.lod2OnlyCellsDefaultHeight, 1);
  // 逆変換は geoToThree と整合(往復)
  const lon = 135.525020 + 3000 / (Math.cos(34.604208 * Math.PI / 180) * 111320);
  assert.ok(Math.abs(lonToLocal(lon) - 3000) < 1e-6); assert.ok(Math.abs(latToLocal(34.604208) - 0) < 1e-6);
});

test('決定的出力・分割 tileset・index 追記・LOD0 は非実棟(id=lod0_*)', async () => {
  const { buildCityLod0 } = await import('../tools/cloud/city-lod0.mjs');
  const r1 = fixture(), r2 = fixture();
  const rep = buildCityLod0({ extRoot: r1, wards: WARDS, tileCells: 4 });
  buildCityLod0({ extRoot: r2, wards: WARDS, tileCells: 4 });
  assert.ok(rep.ok && rep.missingWards.length === 0);
  const ts = JSON.parse(fs.readFileSync(path.join(r1, '_city-lod0/tileset.json'), 'utf8'));
  assert.ok(ts.root.children.length >= 2, '空間分割(1 巨大GLBではない)');
  assert.strictEqual(ts.extras.notRealBuildings, true); assert.strictEqual(ts.extras.clickable, false);
  for (const c of ts.root.children) { assert.strictEqual(c.refine, 'REPLACE'); assert.ok(fs.existsSync(path.join(r1, '_city-lod0', c.content.uri))); assert.strictEqual(c.transform.length, 16); }
  const glb = fs.readFileSync(path.join(r1, '_city-lod0', ts.root.children[0].content.uri));
  assert.ok(glb.includes('lod0_') && !glb.includes('bldg_'), 'LOD0 ID は lod0_* のみ');
  for (const f of fs.readdirSync(path.join(r1, '_city-lod0/tiles'))) assert.ok(fs.readFileSync(path.join(r1, '_city-lod0/tiles', f)).equals(fs.readFileSync(path.join(r2, '_city-lod0/tiles', f))), '同入力=同バイト列');
  const idx = JSON.parse(fs.readFileSync(path.join(r1, 'index.json'), 'utf8'));
  assert.strictEqual(idx.cityLod0.uri, '_city-lod0/tileset.json'); assert.deepStrictEqual(idx.lod0Wards, [], '既存キー不変');
});

test('区のデータ欠落は fail closed(coverage に欠落区を記録して例外)', async () => {
  const { buildCityLod0 } = await import('../tools/cloud/city-lod0.mjs');
  const root = fixture();
  assert.throws(() => buildCityLod0({ extRoot: root, wards: [...WARDS, { id: 'c', code: '27103' }] }), /欠落区: c/);
  const rep = JSON.parse(fs.readFileSync(path.join(root, '_city-lod0/coverage-report.json'), 'utf8'));
  assert.deepStrictEqual(rep.missingWards, ['c']);
});
