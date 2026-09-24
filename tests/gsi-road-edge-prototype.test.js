// tests/gsi-road-edge-prototype.test.js
// [Mission 31G-FIX15] GSI Official Road Edge Import & Validation Prototype。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../tools/lib/canonical-baseline.js";
import { skipIfMissingRel } from './_generated-data.mjs';
// [Mission 35L] canonical の生成物が無い素のチェックアウトでは検証対象が無いので skip（assertion 失敗では skip しない）
const CANONICAL_SKIP = skipIfMissingRel('data/processed/osaka-city/canonical/buildings/manifest.json', 'data/processed/osaka-city/canonical/roads/manifest.json', 'data/processed/osaka-city/derived/refined-road-surface.json');
// [Mission 35L] 検証対象の生成物が無いときだけ skip（生成済みなら従来どおり全部検証する）
const RAW_SKIP = skipIfMissingRel('data/raw/gsi/road-edge');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

test('[FIX15 §1] data/raw/gsi/road-edge/ input directory + README が存在する', { skip: RAW_SKIP }, () => {
  const dir = R('data', 'raw', 'gsi', 'road-edge');
  assert.ok(fs.existsSync(dir), 'input directory が無い');
  assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'README.md が無い');
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf-8');
  assert.match(readme, /基盤地図情報/);
  assert.match(readme, /raw data は一切加工しません|加工しません/);
});

test('[FIX15 §2] raw data が無い場合 GSI_ROAD_EDGE_RAW_DATA_MISSING を記録する（現状の実データ無し状態）', { skip: !rpt('gsi-road-edge-prototype.json') && 'no report' }, () => {
  const files = fs.readdirSync(R('data', 'raw', 'gsi', 'road-edge')).filter((f) => !/^readme\.md$/i.test(f) && !f.startsWith('.'));
  if (files.length > 0) return; // 実データが投入されていれば本テストは対象外
  const j = rpt('gsi-road-edge-prototype.json');
  assert.equal(j.rawDataPresent, false);
  assert.equal(j.STATUS, 'GSI_ROAD_EDGE_RAW_DATA_MISSING');
  assert.ok(typeof j.userAction === 'string' && j.userAction.length > 0, 'userAction が空');
  assert.equal(j.canonicalRoadUnchanged, true);
  assert.equal(j.canonicalBuildingUnchanged, true);
  assert.equal(j.fix13RoadVisualSurfaceUnchanged, true);
});

test('[FIX15 §28] report に必須フィールドが全て存在する', { skip: !rpt('gsi-road-edge-prototype.json') && 'no report' }, () => {
  const j = rpt('gsi-road-edge-prototype.json');
  for (const f of ['rawDataPresent', 'sourceFiles', 'sourceCrs', 'featureType', 'featureCount', 'osakaFeatureCount',
    'invalidCount', 'duplicateCount', 'coverage', 'sampleAreas', 'pairing', 'majorRoadWidths',
    'fix13Comparison', 'buildingOverlapComparison', 'adoptionRecommendation']) {
    assert.ok(f in j, '必須フィールドが無い: ' + f);
  }
  assert.ok(Array.isArray(j.sampleAreas) && j.sampleAreas.length >= 6, 'sample area が最低 6 地区ない');
  const names = j.sampleAreas.map((a) => a.name);
  for (const n of ['梅田', '本町', '難波', '天王寺', '十三', '住吉']) assert.ok(names.includes(n), n + ' が sample area に無い');
});

test('[FIX15 §20/§29] fakeMeasurement 0: raw data 無しのとき比較結果が捏造されていない', { skip: !rpt('gsi-road-edge-prototype.json') && 'no report' }, () => {
  const j = rpt('gsi-road-edge-prototype.json');
  if (j.rawDataPresent !== false) return;
  assert.equal(j.osakaFeatureCount, 0);
  assert.equal(j.pairing.high, 0); assert.equal(j.pairing.medium, 0); assert.equal(j.pairing.low, 0);
  assert.equal(j.samplePolygonCount, 0);
  for (const v of Object.values(j.majorRoadWidths)) assert.equal(v.gsiWidthM, null, 'gsiWidthM が null でない: ' + JSON.stringify(v));
  assert.doesNotMatch(String(j.fix13Comparison), /^GSI_(NARROWER|WIDER|SIMILAR)/);
  assert.notEqual(j.adoptionRecommendation.decision, 'OFFICIAL_SOURCE_ADOPTED');
  assert.notEqual(j.adoptionRecommendation.decision, 'GSI_NOT_BETTER_THAN_FIX13');
});

test('[FIX15 §29] gsi-road-edge-prototype validator が PASS', { skip: !rpt('gsi-road-edge-prototype-validation.json') && 'no report' }, () => {
  const v = rpt('gsi-road-edge-prototype-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.rawMutation, 0);
  assert.equal(v.checks.canonicalRoadMutation, 0);
  assert.equal(v.checks.buildingMutation, 0);
  assert.equal(v.checks.fix13Mutation, 0);
  assert.equal(v.checks.crsMismatch, 0);
  assert.equal(v.checks.untrackedGsiFeature, 0);
  assert.equal(v.checks.fakeMeasurement, 0);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[FIX15 §4] gsi-road-edge-transform.js が第6/7系へ強制変換していない（FIX11 Coordinate Authority 維持）', () => {
  const src = fs.readFileSync(R('tools', 'lib', 'gsi-road-edge-transform.js'), 'utf-8');
  assert.match(src, /FIX11 Coordinate Authority/);
  assert.doesNotMatch(src, /jprectZone\s*:\s*[67]/);
  assert.match(src, /非対応|強制変換しない/);
});

test('[FIX16 §3] parseRoadEdgeGml: 実データ構造（FIX16 で確認済み）で RdEdg feature を抽出できる', async () => {
  const { parseRoadEdgeGml } = await import('../tools/lib/gsi-road-edge-gml.js');
  // [FIX16] 実 GSI ファイル（FG-GML-*-RdEdg-*.xml）で確認した実際の構造:
  //   既定 namespace（prefix 無し）・srsName="fguuid:jgd2024.bl"・devDate はネストされた gml:timePosition・
  //   type は codeSpace 参照ではなく人間可読テキスト（例: 真幅道路）がそのまま入る。
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<Dataset xmlns:gml="http://www.opengis.net/gml/3.2" xmlns="http://fgd.gsi.go.jp/spec/2008/FGD_GMLSchema" gml:id="Dataset1">
<RdEdg gml:id="K19_rdedg_1">
<fid>48735-12471-s-420</fid>
<devDate gml:id="K19_rdedg_1-2"><gml:timePosition>2026-03-10</gml:timePosition></devDate>
<orgGILvl>2500</orgGILvl>
<vis>表示</vis>
<loc>
<gml:Curve gml:id="K19_rdedg_1-g" srsName="fguuid:jgd2024.bl">
<gml:segments><gml:LineStringSegment><gml:posList>
34.7025 135.4959
34.7030 135.4965
</gml:posList></gml:LineStringSegment></gml:segments>
</gml:Curve>
</loc>
<type>真幅道路</type>
<admOffice>不明</admOffice>
</RdEdg>
<AdmBdry gml:id="adm_1"><loc/></AdmBdry>
</Dataset>`;
  const { features, otherFeatureTypes } = parseRoadEdgeGml(xml);
  assert.equal(features.length, 1);
  assert.equal(features[0].id, 'K19_rdedg_1');
  assert.equal(features[0].srsName, 'fguuid:jgd2024.bl');
  assert.equal(features[0].coordsCount, 2);
  assert.equal(features[0].attrs.type, '真幅道路');
  assert.equal(features[0].attrs.devDate, '2026-03-10');   // ネストされた timePosition から取得できること
  assert.equal(features[0].attrs.admOffice, '不明');
  assert.ok(otherFeatureTypes.includes('AdmBdry'));
});

test('[FIX16 §4] classifyCrs: 実データの srsName "fguuid:jgd2024.bl" を地理座標として認識する', async () => {
  const { classifyCrs } = await import('../tools/lib/gsi-road-edge-transform.js');
  const cls = classifyCrs('fguuid:jgd2024.bl');
  assert.equal(cls.supported, true);
  assert.equal(cls.axisOrder, 'lat-lon');
  // 平面直角座標系（系番号）は依然として非対応のまま（§4: 強制変換しない）
  const zone6 = classifyCrs('fguuid:jgd2011.jprect6');
  assert.equal(zone6.supported, false);
});

test('[FIX15] posListToPairs + latLonPairsToWorld + touchesOsakaCity: 梅田座標が大阪市域に判定される', async () => {
  const { posListToPairs } = await import('../tools/lib/gsi-road-edge-gml.js');
  const { latLonPairsToWorld, loadWards, touchesOsakaCity } = await import('../tools/lib/gsi-road-edge-transform.js');
  const pairs = posListToPairs('34.7025 135.4959 34.7030 135.4965', 'lat-lon');
  const world = latLonPairsToWorld(pairs);
  assert.equal(world.length, 2);
  const wards = loadWards();
  if (wards.length === 0) return; // ward polygon fixture が無い環境ではスキップ相当
  assert.equal(touchesOsakaCity(world, wards), true);
  // 大きく市外（東京付近）に置き換えると false になること
  const tokyo = latLonPairsToWorld(posListToPairs('35.6812 139.7671 35.6820 139.7680', 'lat-lon'));
  assert.equal(touchesOsakaCity(tokyo, wards), false);
});

test('[FIX15 §9] validateLines: invalid / zero-length / duplicate を検出する（geometry は変更しない）', async () => {
  const { validateLines } = await import('../tools/lib/gsi-road-edge-validate.js');
  const feats = [
    { id: 'a', geometry: { coordinates: [[0, 0], [10, 10]] } },
    { id: 'b', geometry: { coordinates: [[0, 0], [10, 10]] } },          // duplicate of a
    { id: 'c', geometry: { coordinates: [[5, 5], [5, 5]] } },            // zero length
    { id: 'd', geometry: { coordinates: [[NaN, 0], [1, 1]] } },          // invalid coordinate
    { id: 'e', geometry: { coordinates: [[0, 0], [200000, 200000]] } },  // extreme outlier
  ];
  const { stats, invalidIds, duplicateIds } = validateLines(feats);
  assert.equal(stats.duplicates, 1);
  assert.equal(stats.zeroLength, 1);
  assert.equal(stats.invalidCoordinates, 1);
  assert.equal(stats.extremeOutlier, 1);
  assert.ok(duplicateIds.includes('b'));
  assert.ok(invalidIds.includes('c') || invalidIds.includes('d') || invalidIds.includes('e'));
});

test('[FIX15 §3] detectFormat がファイル内容から形式を判定する（拡張子に依存しない）', async () => {
  const { detectFormat } = await import('../tools/lib/gsi-road-edge-format.js');
  assert.equal(detectFormat(Buffer.from('PK\x03\x04rest')), 'zip');
  assert.equal(detectFormat(Buffer.from('<?xml version="1.0"?><FGD></FGD>')), 'gml-xml');
  assert.equal(detectFormat(Buffer.from('{"type":"FeatureCollection","features":[]}')), 'geojson');
  assert.equal(detectFormat(Buffer.from([0x00, 0x00, 0x27, 0x0a, 0, 0, 0, 0])), 'shapefile');
  assert.equal(detectFormat(Buffer.from('random binary junk')), 'unknown');
});

test('[FIX15 §10/§26/§27] runtime: GSI Road Edge toggle は既定 OFF・per-frame cost なし・Console 不要', { skip: !html && 'no html' }, () => {
  assert.match(html, /let gsiRoadEdgeVisible = false;/);
  assert.match(html, /window\.toggleGsiRoadEdge = async function/);
  assert.match(html, /addEventListener\('click', \(\) => \{ window\.toggleGsiRoadEdge\(\); \}\);/);
  assert.match(html, /color: 0xff2d95/);   // FIX13 道路色と明確に違う色
  // per-frame cost なし: render loop（animate 系）に gsiRoadEdge への参照が無いこと
  const animIdx = html.indexOf('function animate(');
  if (animIdx >= 0) assert.doesNotMatch(html.slice(animIdx, animIdx + 4000), /gsiRoadEdge/);
});

test('[FIX15 §0] canonical / building / FIX13 refined-road-surface は不変', { skip: CANONICAL_SKIP }, () => {
  const bm = JSON.parse(fs.readFileSync(R('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'), 'utf-8'));
  assert.equal(bm.featureCount, 615617);
  const rm = JSON.parse(fs.readFileSync(R('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'), 'utf-8'));
  assert.equal(rm.featureCount, CANONICAL_ROAD_FEATURE_COUNT);
  const refined = JSON.parse(fs.readFileSync(R('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json'), 'utf-8'));
  assert.equal(refined.indexedCount, REFINED_ROAD_SURFACE_INDEXED_COUNT);
});

test('[FIX15 §0] protected HTML に GSI road edge コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /gsi-road-edge|GSI Road Edge|RdEdg|toggleGsiRoadEdge/, f + ' に混入');
  }
});

test('[FIX15 §30] npm scripts が package.json に追加されている', () => {
  const pkg = JSON.parse(fs.readFileSync(R('package.json'), 'utf-8'));
  assert.ok(pkg.scripts['data:gsi-road-edge:import']);
  assert.ok(pkg.scripts['data:gsi-road-edge:validate']);
  assert.ok(pkg.scripts['data:gsi-road-edge:audit']);
});
