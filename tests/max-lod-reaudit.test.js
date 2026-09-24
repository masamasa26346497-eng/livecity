// tests/max-lod-reaudit.test.js
// [Mission 34D] 大阪 24 区 PLATEAU の max LOD 再監査
//   - raw source をファイル名決め打ちではなく中身で拾えているか
//   - LOD タグの置き場所（Building 直下 / boundedBy / BuildingPart）を数えているか
//   - 完全性（屋根・壁・接地）で採否を決めているか
//   - 空間照合を無理に採用していないか
//   - 24 区すべてを報告しているか / 建物総数を変えていないか
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  looksLikeBuildingCityGml, HEAD_BYTES, BLDG_NAME_RE, buildingStarts, countOf, detach,
  analyzeBuilding, LOD_ELEMENTS, SEMANTIC_ELEMENTS, EXCLUDE_DIR, EXCLUDE_NAME,
} from '../tools/audit/plateau-source-inventory.js';
import {
  judgeBuilding, COMPLETE, REJECT, WARDS_24, WARD_JA, spatialMatch, pointInRing, SPATIAL_NEAR_M,
} from '../tools/audit/max-lod-reaudit.js';
import { SPATIAL_VALID, VALID, roofQuality, TIER } from '../tools/build-plateau-high-lod.js';
import { FIXED, PREVIOUS } from '../tools/validate/max-lod-reaudit.js';
import { AREAS, DENSITY_CELL_M, TOP_N } from '../tools/audit/max-lod-coverage-matrix.js';
import { devUiIsGated } from '../tools/lib/production-invariants.js';
import { skipIfMissingRel } from './_generated-data.mjs';
// [Mission 35L] canonical の生成物が無い素のチェックアウトでは検証対象が無いので skip（assertion 失敗では skip しない）
const CANONICAL_SKIP = skipIfMissingRel('data/processed/osaka-city/canonical/buildings/manifest.json');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

// CityGML 断片（LOD1 のみ）
const LOD1_ONLY = `<bldg:Building gml:id="bldg_a">
  <gen:stringAttribute name="区名"><gen:value>北区</gen:value></gen:stringAttribute>
  <bldg:lod0FootPrint><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>34.70 135.49 0 34.7001 135.49 0 34.7001 135.4901 0 34.70 135.4901 0 34.70 135.49 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod0FootPrint>
  <bldg:lod1Solid><gml:Solid/></bldg:lod1Solid>
</bldg:Building>`;
// 屋根・壁・接地が揃った LOD2
const surface = (kind, id, lod = 2) => `<bldg:boundedBy><bldg:${kind} gml:id="${id}"><bldg:lod${lod}MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon gml:id="p_${id}"><gml:exterior><gml:LinearRing><gml:posList>34.70 135.49 2 34.7001 135.49 2 34.7001 135.4901 2 34.70 135.49 2</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod${lod}MultiSurface></bldg:${kind}></bldg:boundedBy>`;
const LOD2_COMPLETE = `<bldg:Building gml:id="bldg_b">
  <gen:stringAttribute name="区名"><gen:value>中央区</gen:value></gen:stringAttribute>
  <bldg:lod1Solid><gml:Solid/></bldg:lod1Solid>
  <bldg:lod2Solid><gml:Solid><gml:exterior><gml:CompositeSurface><gml:surfaceMember xlink:href="#p_r1"/></gml:CompositeSurface></gml:exterior></gml:Solid></bldg:lod2Solid>
  ${surface('RoofSurface', 'r1')}${surface('WallSurface', 'w1')}${surface('GroundSurface', 'g1')}
</bldg:Building>`;
// 屋根だけの LOD2（不完全）
const LOD2_ROOF_ONLY = `<bldg:Building gml:id="bldg_c">
  <bldg:lod1Solid><gml:Solid/></bldg:lod1Solid>
  ${surface('RoofSurface', 'r2')}
</bldg:Building>`;
// 本体に高 LOD が無く BuildingPart の中にだけある
const PART_ONLY = `<bldg:Building gml:id="bldg_d">
  <bldg:lod1Solid><gml:Solid/></bldg:lod1Solid>
  <bldg:consistsOfBuildingPart><bldg:BuildingPart gml:id="part1">
    <bldg:lod1Solid><gml:Solid/></bldg:lod1Solid>
    ${surface('RoofSurface', 'r3')}${surface('WallSurface', 'w3')}${surface('GroundSurface', 'g3')}
  </bldg:BuildingPart></bldg:consistsOfBuildingPart>
</bldg:Building>`;

// ── §3/§4 source の拾い方 ─────────────────────────────────────────────────
test('[34D §4] 建物 CityGML は中身と命名の両方で判定する', () => {
  // 道路（tran）の CityGML は bldg 名前空間を宣言するだけ。建物として拾ってはいけない。
  const tranHead = '<?xml version="1.0"?><core:CityModel xmlns:bldg="http://www.opengis.net/citygml/building/2.0" xmlns:tran="..."><core:cityObjectMember><tran:Road/>';
  assert.equal(looksLikeBuildingCityGml(tranHead, 'x_tran_6697_op.gml'), false);
  // 建物タグがあれば拾う
  assert.equal(looksLikeBuildingCityGml('<core:CityModel><bldg:Building gml:id="a">', 'anything.gml'), true);
  // ヘッダが長くて先頭に建物タグが無くても、PLATEAU の命名なら拾う（取りこぼし防止）
  assert.equal(looksLikeBuildingCityGml('<core:CityModel>' + 'x'.repeat(100), '51357420_bldg_6697_op.gml'), true);
  assert.equal(looksLikeBuildingCityGml('<core:CityModel>', 'codelist.xml'), false);
  // BuildingPart だけでは建物ファイルと判定しない
  assert.equal(looksLikeBuildingCityGml('<bldg:BuildingPart gml:id="p">', 'x.gml'), false);
  assert.ok(BLDG_NAME_RE.test('51357420_bldg_6697_op.gml'));
  assert.ok(HEAD_BYTES >= 8192);
});

test('[34D §3] derived / processed / conflict copy は raw source に数えない', () => {
  assert.ok(EXCLUDE_DIR.test('data/processed/osaka-city/canonical'));
  assert.ok(EXCLUDE_DIR.test('data/derived-v2-osmv2/near'));
  assert.ok(!EXCLUDE_DIR.test('data/raw/osaka-higashisumiyoshi'));
  assert.ok(EXCLUDE_NAME.test('51357420_bldg_6697_op-DESKTOP-ORA500N.gml'));
  assert.ok(!EXCLUDE_NAME.test('51357420_bldg_6697_op.gml'));
});

test('[34D §5] 建物の切り出しは Building だけ（BuildingPart を建物として数えない）', () => {
  const t = LOD1_ONLY + PART_ONLY;
  assert.equal(buildingStarts(t).length, 2, 'Building は 2 件');
  assert.equal(countOf(t, '<bldg:BuildingPart'), 1);
  // SlicedString 対策（34A で OOM を踏んだ）
  const long = 'x'.repeat(9000) + 'abc';
  assert.equal(detach(long.slice(9000)), 'abc');
});

// ── §5/§6/§7/§8 schema ──────────────────────────────────────────────────
test('[34D §5/§6] LOD タグの置き場所を 3 つに分けて数える', () => {
  const a = analyzeBuilding(LOD2_COMPLETE);
  assert.equal(a.lodDirect.lod1, 1, 'lod1Solid は Building 直下');
  assert.equal(a.lodDirect.lod2, 1, 'lod2Solid は Building 直下');
  assert.equal(a.lodInBounded.lod2, 3, 'lod2MultiSurface は boundedBy の中に 3 つ');
  assert.equal(a.lodInPart.lod2, 0);
  const p = analyzeBuilding(PART_ONLY);
  assert.equal(p.lodDirect.lod2, 0, '本体には高 LOD が無い');
  assert.equal(p.lodInPart.lod2, 3, 'BuildingPart の中にだけある');
  assert.equal(p.parts, 1);
});

test('[34D §7/§8] xlink と surface semantics を数える', () => {
  const a = analyzeBuilding(LOD2_COMPLETE);
  assert.equal(a.xlinkHrefs, 1, 'lod2Solid は xlink 参照');
  assert.ok(a.posLists >= 3, 'geometry 本体は boundedBy 側にある');
  assert.equal(a.semantics.RoofSurface, 1);
  assert.equal(a.semantics.WallSurface, 1);
  assert.equal(a.semantics.GroundSurface, 1);
  for (const k of ['lod1', 'lod2', 'lod3', 'lod0']) assert.ok(Array.isArray(LOD_ELEMENTS[k]));
  for (const k of ['RoofSurface', 'WallSurface', 'GroundSurface', 'ClosureSurface', 'Window', 'Door']) {
    assert.ok(SEMANTIC_ELEMENTS.includes(k), k + ' を見ていない');
  }
});

// ── §9/§10/§11 完全性 ───────────────────────────────────────────────────
test('[34D §9/§11] 屋根・壁・接地が揃った LOD2 だけ採用する', () => {
  const ok = judgeBuilding(LOD2_COMPLETE);
  assert.equal(ok.chosen, 2);
  assert.equal(ok.chosenReason, null);
  assert.equal(ok.lod2.complete, true);
  assert.equal(ok.lod2.roof, 1);
  assert.equal(ok.lod2.wall, 1);
  assert.equal(ok.lod2.ground, 1);
  assert.equal(ok.ward, '中央区');

  const bad = judgeBuilding(LOD2_ROOF_ONLY);
  assert.equal(bad.chosen, 1, '屋根だけなら LOD2 を採らない');
  assert.equal(bad.lod2.complete, false);
  assert.equal(bad.chosenReason, REJECT.INCOMPLETE);

  const none = judgeBuilding(LOD1_ONLY);
  assert.equal(none.chosen, 1);
  assert.equal(none.chosenReason, REJECT.NO_HIGH_LOD_IN_SOURCE);
  assert.equal(none.ward, '北区');
});

test('[34D §6] BuildingPart の中にだけ高 LOD があっても拾う', () => {
  const j = judgeBuilding(PART_ONLY);
  assert.equal(j.parts, 1);
  assert.equal(j.lod2.present, true);
  assert.equal(j.lod2.complete, true);
  assert.equal(j.chosen, 2, 'BuildingPart 側の geometry でも採用する');
});

test('[34D §10] 完全性の基準は「タグが 1 個ある」ではない', () => {
  assert.ok(COMPLETE.minRoofSurfaces >= 1);
  assert.ok(COMPLETE.minWallSurfaces >= 1);
  assert.ok(COMPLETE.minGroundOrClosure >= 1);
  assert.ok(COMPLETE.minPolygons >= 3);
});

test('[34D §12] 重心が取れる（頂点 1 点ではなく footprint の重心）', () => {
  const j = judgeBuilding(LOD1_ONLY);
  assert.ok(j.lat > 34.7 && j.lat < 34.7002, '重心が footprint の内側 lat=' + j.lat);
  assert.ok(j.lon > 135.4899 && j.lon < 135.4902);
});

// ── §13 空間照合 ────────────────────────────────────────────────────────
test('[34D §13] 空間照合は曖昧なものを採らない', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.ok(pointInRing(5, 5, sq));
  const cells = new Map([['0,0', [{ id: 'A', ring: sq, centroid: [5, 5] }]]]);
  assert.equal(spatialMatch(5, 5, cells, 25).how, 'footprint-inside');
  assert.equal(spatialMatch(100, 100, cells, 25), null, '遠いものは採らない');
  assert.ok(SPATIAL_NEAR_M <= 10, '近傍のしきい値が緩すぎる');
  // ビルド側の追加条件（id の裏付けが無いぶん厳しくする）
  assert.ok(SPATIAL_VALID.maxBboxCenterShiftM <= VALID.maxBboxCenterShiftM, 'bbox の条件が通常より緩い');
  assert.ok(SPATIAL_VALID.maxBboxAreaRatio <= VALID.maxBboxAreaRatio);
  assert.equal(SPATIAL_VALID.maxBboxCenterShiftM, 2);
});

// ── §22/§23 屋根の等級 ──────────────────────────────────────────────────
test('[34D §22/§23] 屋根の段数で等級を付ける（geometry は変えない）', () => {
  const flat = { lod: 2, parts: [{ kind: 'roof', positions: [0, 10, 0, 1, 10, 0, 1, 10, 1] }], surfaceCounts: { roof: 1, wall: 4 } };
  assert.equal(roofQuality(flat).tier, 'LOD2-C', '1 段で面も少なければ C');
  const stepped = { lod: 2, parts: [{ kind: 'roof', positions: [0, 5, 0, 1, 5, 0, 1, 5, 1, 2, 12, 2, 3, 12, 2, 3, 12, 3, 4, 20, 4, 5, 20, 4, 5, 20, 5] }], surfaceCounts: { roof: 3, wall: 8 } };
  assert.equal(roofQuality(stepped).roofLevels, 3);
  assert.equal(roofQuality(stepped).tier, 'LOD2-A');
  const many = { lod: 2, parts: [{ kind: 'roof', positions: [0, 5, 0, 1, 5, 0, 1, 5, 1] }], surfaceCounts: { roof: 12, wall: 30 } };
  assert.equal(roofQuality(many).tier, 'LOD2-A', '面が多ければ A');
  assert.equal(roofQuality({ ...flat, lod: 3 }).tier, 'LOD3');
  assert.ok(TIER.multiLevel >= 2 && TIER.levelBinM > 0);
});

// ── §14 24 区 ───────────────────────────────────────────────────────────
test('[34D §14] 24 区すべてが定義されている', () => {
  assert.equal(WARDS_24.length, 24);
  assert.equal(new Set(WARDS_24).size, 24);
  for (const w of WARDS_24) assert.ok(WARD_JA[w], w + ' の日本語名が無い');
  for (const ja of ['北区', '都島区', '福島区', '此花区', '中央区', '西区', '港区', '大正区', '天王寺区', '浪速区',
    '西淀川区', '淀川区', '東淀川区', '東成区', '生野区', '旭区', '城東区', '鶴見区', '阿倍野区', '住之江区',
    '住吉区', '東住吉区', '平野区', '西成区']) {
    assert.ok(Object.values(WARD_JA).includes(ja), ja + ' が無い');
  }
});

test('[34D §32/§33] 主要エリアと密度抽出の設定', () => {
  for (const id of ['umeda', 'dojima', 'nakanoshima', 'honmachi', 'namba', 'osakacastle', 'kyobashi',
    'tennoji', 'shinosaka', 'awaji', 'abeno', 'sumiyoshi', 'osakaport']) {
    assert.ok(AREAS.some((a) => a.id === id), id + ' が無い');
  }
  assert.equal(DENSITY_CELL_M, 500);
  assert.equal(TOP_N, 20);
});

// ── §26 捏造禁止 ────────────────────────────────────────────────────────
test('[34D §26] geometry を作る経路が無い', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'build-plateau-high-lod.js'), 'utf-8');
  assert.doesNotMatch(src, /aiRoof|inferRoof|generateRoof|synthesizeRoof/i);
  // 高さや階数から LOD2 を作らない
  assert.doesNotMatch(src, /roofFromHeight|roofFromLevels|building:levels/);
  // 使うのは raw の posList だけ
  assert.match(src, /parsePosListLatLonAlt/);
});

// ── §34/§35/§36 dev QA ──────────────────────────────────────────────────
test('[34D §34] MAX LOD QA（LOD1 灰 / LOD2 青 / LOD3 金 / OSM 黄 / 除外 赤）', () => {
  assert.match(html, /const MaxLodQaLayer = \(function \(\) \{/);
  assert.match(html, /const COLOR = \{ osm: 0xffd21e, rejected: 0xff2d2d \};/);
  assert.match(html, /L\.setViewMode\('diff'\)/);
  assert.match(html, /maxLodQaBtn\.id = 'max-lod-qa-toggle';/);
  assert.match(html, /window\.__MAX_LOD_QA__/);
  // 通常表示には出さない
  assert.match(html, /if \(L\) L\.setViewMode\('high'\);/);
});

test('[34D §35/§36] クリックで LOD の診断が出る', () => {
  assert.match(html, /window\.__MAX_LOD_INSPECT__/);
  for (const k of ['canonicalId', 'sourceGmlId', 'currentDisplayedLod', 'highestAvailableLod',
    'fallbackReason', 'sourceFile', 'roofSurfaceCount', 'wallSurfaceCount']) {
    assert.ok(html.includes(k + ':'), '診断項目が足りない: ' + k);
  }
  // 理由の既定は「raw に LOD2 が無い」
  assert.match(html, /defaultReason \|\| 'NO_LOD2_IN_RAW_SOURCE'/);
  assert.match(html, /function reasonFor\(canonicalId\)/);
  assert.match(html, /OSM_FALLBACK/);
});

test('[34D §34] QA モードは production に出さない', () => {
  // [Mission 35G] MAX LOD QA の入口は production のバイトにも入る。
  //   通常表示は setViewMode('high') のままで、トグルは非表示の箱の中にある。
  const prod = fs.readFileSync(PROD, 'utf-8');
  assert.match(prod, /if \(L\) L\.setViewMode\('high'\);/, '通常表示が QA モードになっている');
  assert.deepEqual(devUiIsGated(['max-lod-qa-toggle']), { ok: true });
});

// ── 実データ（あるときだけ）────────────────────────────────────────────
test('[34D §3/§4] source 在庫', { skip: skip('plateau-source-inventory.json') }, () => {
  const inv = rpt('plateau-source-inventory.json');
  assert.ok(inv.scan.buildingSources > 400, 'source が少なすぎる: ' + inv.scan.buildingSources);
  assert.equal(inv.totals.uniqueIds, 616119, 'raw の一意 gml:id');
  // §6/§7 数えていること
  assert.equal(typeof inv.totals.withBuildingPart, 'number');
  assert.equal(typeof inv.totals.highLodOnlyInPart, 'number');
  assert.equal(typeof inv.totals.withXlink, 'number');
  assert.equal(inv.totals.noPosList, 0, 'geometry を持たない建物があってはならない');
});

test('[34D §41] 前回との比較', { skip: skip('max-lod-coverage-matrix.json') }, () => {
  const m = rpt('max-lod-coverage-matrix.json');
  assert.deepEqual(m.previous, PREVIOUS);
  assert.equal(m.current.total, m.current.lod2 + m.current.lod3);
  // 増えても減ってもよいが、会計は合うこと
  assert.equal(m.delta.total, m.current.total - PREVIOUS.total);
  assert.equal(m.wards.length, 24);
  assert.equal(m.totals.wardsWithHighLod + m.totals.wardsWithoutHighLod.length, 24);
});

test('[34D §2] 建物総数を変えていない', { skip: CANONICAL_SKIP }, () => {
  const man = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'));
  assert.ok(man, 'canonical manifest が無い');
  assert.equal(man.featureCount, FIXED.total);
});

test('[34D §15] 高 LOD が 0 の区は理由を明記している', { skip: skip('max-lod-coverage-matrix.json') }, () => {
  const m = rpt('max-lod-coverage-matrix.json');
  const zero = m.wards.filter((w) => w.lod2Available + w.lod3Available === 0);
  assert.ok(zero.length > 0);
  for (const w of zero) assert.equal(w.note, 'NO_HIGH_LOD_IN_SOURCE', w.wardJa + ' に理由が無い');
});

test('[34D §28/§29/§30] ランタイム', { skip: skip('max-lod-runtime-qa.json') }, () => {
  const r = rpt('max-lod-runtime-qa.json');
  assert.equal(r.summary.suppressMatchAll, true, '高 LOD 表示数 == LOD1 抑制数');
  assert.equal(r.summary.multiTileBuildings, 0, 'tile をまたいで描かれている建物がある');
  assert.equal(r.summary.cardMissing, 0, 'card を引けない建物がある');
  assert.equal(r.summary.pickSameAll, true, 'クリックで同じ canonicalId へ到達しない');
});

test('[34D §42] validator が通っている', { skip: skip('max-lod-reaudit-validation.json') }, () => {
  const v = rpt('max-lod-reaudit-validation.json');
  assert.equal(v.all24WardsAudited, true);
  assert.equal(v.buildingPartAudited, true);
  assert.equal(v.xlinkAudited, true);
  assert.equal(v.schemaVariantsAudited, true);
  assert.equal(v.zoneVIIUsed, false);
  assert.equal(v.canonicalBuildingCount, FIXED.canonicalPlateau);
  assert.equal(v.osmFallbackCount, FIXED.osmFallback);
  assert.equal(v.totalBuildingCount, FIXED.total);
  assert.equal(v.fabricatedHighLod, 0);
  assert.equal(v.highestValidExteriorLodSelected, true);
  assert.equal(v.buildingPositionMutation, 0);
  assert.equal(v.roadMutation, 0);
  assert.equal(v.projectionMutation, 0);
  assert.equal(v.placementMutation, 0);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
  assert.equal(v.classification, 'OSAKA_24WARD_MAX_LOD_AUDIT_SUCCESS');
});
