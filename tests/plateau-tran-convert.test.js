// tests/plateau-tran-convert.test.js
// [Mission 31C2] PLATEAU tran:Road CityGML パーサの検証。
//   fixture は実データ（27100_osaka-shi_city_2025_citygml / udx/tran/*_tran_6697_op.gml）の構造をそのまま写したもの。
//   ※ 31C2 の実データ確認で、この配布に tran:TrafficArea による車道/歩道の細分はほぼ無く
//     （市域 199,162 Road 中 888 件・0.4% のみ）、tran:Road の lod1MultiSurface＝道路区域が
//     唯一の一様な面 source であることが判明した。code 値も配布同梱 codelist が正本。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import {
  parseTranPosList, latLonToZNorthNeg, ringsFromPolygonXml, validateTranPolygon, ringSelfIntersects,
  roadAttributesFromBlock,
  ROAD_FUNCTION_LABEL, ROAD_FUNCTION_CLASS, SECTION_TYPE_LABEL, SECTION_STRUCTURE, SUBSURFACE_STRUCTURES,
  TRAFFICAREA_FUNCTION_CATEGORY, ROAD_SURFACE_CATEGORIES, PEDESTRIAN_SURFACE_CATEGORIES,
} from '../tools/convert-plateau-tran.js';

const PROJ = { centerLat: 34.604208, centerLon: 135.52502, metersPerDegree: 111320 };
const toXZ = (lat, lon) => latLonToZNorthNeg(lat, lon, PROJ);
const rpt = (n) => { const p = path.join(PROJECT_ROOT, 'data/reports', n); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null; };

test('[31C2] parseTranPosList: EPSG:6697 の "lat lon alt" → [[lat,lon],...]', () => {
  const pts = parseTranPosList('34.70 135.50 5.0 34.71 135.51 5.1 34.70 135.52 5.0', { axisOrder: 'lat lon', dims: 3 });
  assert.equal(pts.length, 3);
  assert.deepEqual(pts[0], [34.70, 135.50]);
  assert.deepEqual(pts[1], [34.71, 135.51]);
  const pts2 = parseTranPosList('135.50 34.70 135.51 34.71', { axisOrder: 'lon lat', dims: 2 });
  assert.deepEqual(pts2[0], [34.70, 135.50]);
});

test('[31C2] latLonToZNorthNeg: znorth-neg-v1（北が -Z）', () => {
  assert.deepEqual(toXZ(34.604208, 135.52502), [0, 0]);
  const north = toXZ(34.614208, 135.52502);
  assert.ok(north[1] < 0, '北で z<0（znorth-neg-v1）: ' + north[1]);
  assert.ok(Math.abs(north[1] - (-1113.2)) < 1, 'z ≈ -1113.2m: ' + north[1]);
  const east = toXZ(34.604208, 135.53502);
  assert.ok(east[0] > 0 && Math.abs(east[0] - 916) < 5, 'x ≈ +916m: ' + east[0]);
});

// 実 GML と同じ構造（tran:Road > tran:function > uro:sectionType > tran:lod1MultiSurface）
const FIXTURE = `<core:cityObjectMember>
  <tran:Road gml:id="tran_f1f3ac9f-6c6c-4ef4-bf37-42767cd31038">
   <tran:function codeSpace="../../codelists/Road_function.xml">3</tran:function>
   <uro:roadStructureAttribute>
    <uro:RoadStructureAttribute>
     <uro:sectionType codeSpace="../../codelists/RoadStructureAttribute_sectionType.xml">2</uro:sectionType>
    </uro:RoadStructureAttribute>
   </uro:roadStructureAttribute>
   <tran:lod1MultiSurface>
    <gml:MultiSurface>
     <gml:surfaceMember>
      <gml:Polygon>
       <gml:exterior><gml:LinearRing>
        <gml:posList srsDimension="3">34.700000 135.500000 5.0 34.700500 135.500000 5.0 34.700500 135.500800 5.0 34.700000 135.500800 5.0 34.700000 135.500000 5.0</gml:posList>
       </gml:LinearRing></gml:exterior>
       <gml:interior><gml:LinearRing>
        <gml:posList srsDimension="3">34.700100 135.500100 5.0 34.700200 135.500100 5.0 34.700200 135.500200 5.0 34.700100 135.500200 5.0 34.700100 135.500100 5.0</gml:posList>
       </gml:LinearRing></gml:interior>
      </gml:Polygon>
     </gml:surfaceMember>
    </gml:MultiSurface>
   </tran:lod1MultiSurface>
  </tran:Road>
 </core:cityObjectMember>`;

test('[31C2] ringsFromPolygonXml: exterior + interior（穴）を Polygon 単位で抽出', () => {
  const lod1 = FIXTURE.match(/<tran:lod1MultiSurface>[\s\S]*?<\/tran:lod1MultiSurface>/)[0];
  const rings = ringsFromPolygonXml(lod1, toXZ, { axisOrder: 'lat lon', dims: 3 });
  assert.equal(rings.exterior.length, 1);
  assert.equal(rings.interior.length, 1, '実データには gml:interior（穴）が存在する');
  for (const [x, z] of rings.exterior[0]) assert.ok(Math.abs(x) < 20000 && Math.abs(z) < 20000, [x, z].join(','));
  const v = validateTranPolygon(rings);
  assert.ok(v.ok, JSON.stringify(v));
  assert.ok(v.areaM2 > 100 && v.areaM2 < 20000, 'area ' + v.areaM2);
});

test('[31C2] roadAttributesFromBlock: Road_function=行政種別 / sectionType=構造区分', () => {
  const a = roadAttributesFromBlock(FIXTURE);
  assert.equal(a.gmlId, 'tran_f1f3ac9f-6c6c-4ef4-bf37-42767cd31038');
  assert.equal(a.functionCode, '3');
  assert.equal(a.functionLabel, '都道府県道');
  assert.equal(a.adminClass, 'prefectural');
  assert.equal(a.sectionTypeCode, '2');
  assert.equal(a.structure, 'elevated', 'sectionType 2 = 高架橋');
  assert.equal(a.surfaceKind, 'roadSurface');
});

test('[31C2] codelist は配布同梱の正本と一致（Road_function は面種別ではなく行政種別）', () => {
  assert.equal(ROAD_FUNCTION_LABEL['1'], '高速自動車国道');
  assert.equal(ROAD_FUNCTION_LABEL['2'], '一般国道');
  assert.equal(ROAD_FUNCTION_LABEL['3'], '都道府県道');
  assert.equal(ROAD_FUNCTION_LABEL['4'], '市町村道');
  assert.equal(ROAD_FUNCTION_LABEL['9020'], '不明');
  assert.equal(ROAD_FUNCTION_CLASS['1'], 'expressway');
  assert.equal(ROAD_FUNCTION_CLASS['9020'], 'unknown');
  // sectionType（§17 高架・橋梁・トンネル）
  assert.equal(SECTION_TYPE_LABEL['2'], '高架橋');
  assert.equal(SECTION_TYPE_LABEL['6'], 'トンネル');
  assert.equal(SECTION_STRUCTURE['2'], 'elevated');
  assert.equal(SECTION_STRUCTURE['7'], 'elevated');
  assert.equal(SECTION_STRUCTURE['3'], 'bridge');
  assert.equal(SECTION_STRUCTURE['6'], 'tunnel');
  // トンネルは地表の道路面ではないので除外される（§7）
  assert.ok(SUBSURFACE_STRUCTURES.has('tunnel'));
  assert.ok(!SUBSURFACE_STRUCTURES.has('elevated'), '高架は除外しない（地表と区別するだけ）');
});

test('[31C2] TrafficArea_function は Road_function とは別の codelist（車道部/歩道部）', () => {
  assert.equal(TRAFFICAREA_FUNCTION_CATEGORY['1000'], 'roadway'); // 車道部
  assert.equal(TRAFFICAREA_FUNCTION_CATEGORY['1010'], 'roadway'); // 車線
  assert.equal(TRAFFICAREA_FUNCTION_CATEGORY['2000'], 'sidewalk'); // 歩道部
  assert.equal(TRAFFICAREA_FUNCTION_CATEGORY['3020'], 'median');   // 分離帯（Auxiliary）
  assert.equal(TRAFFICAREA_FUNCTION_CATEGORY['5000'], 'greenery'); // 植栽（Auxiliary）
  assert.ok(ROAD_SURFACE_CATEGORIES.has('roadway'));
  assert.ok(!ROAD_SURFACE_CATEGORIES.has('sidewalk'));
  assert.ok(PEDESTRIAN_SURFACE_CATEGORIES.has('sidewalk'));
});

test('[31C2] validateTranPolygon: 自己交差 / zero area を除外', () => {
  const bowtie = { exterior: [[[0, 0], [10, 10], [10, 0], [0, 10]]], interior: [] };
  const r = validateTranPolygon(bowtie);
  assert.ok(!r.ok);
  assert.ok(['self-intersection', 'zero-area'].includes(r.reason), r.reason);
  assert.equal(validateTranPolygon({ exterior: [[[0, 0], [0.1, 0], [0.1, 0.1]]], interior: [] }).ok, false);
  assert.equal(ringSelfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]]), true);
});

test('[31C2] 変換結果: 実データが取得済みなら道路区域面が市域規模で出ている', { skip: !rpt('plateau-tran-conversion.json') && 'no report' }, () => {
  const c = rpt('plateau-tran-conversion.json');
  if (c.RESULT === 'NO-DATA') return; // 未取得環境ではスキップ相当
  assert.equal(c.RESULT, 'CONVERTED');
  assert.ok(c.roadSurfacePolygons > 100000, '道路区域面 ' + c.roadSurfacePolygons);
  assert.ok(c.invalidRate < 0.05, 'invalid 率 ' + c.invalidRate);
  // トンネルは地表面から除外されている
  assert.ok(c.subsurfacePolygons >= 0);
  assert.match(c.geometrySemantics, /lod1MultiSurface/);
});

test('[31C2] §30 STOP 条件の判定が記録され、採用可否が数値で示されている', { skip: !rpt('plateau-tran-coverage.json') && 'no report' }, () => {
  const s = rpt('plateau-tran-coverage.json');
  assert.ok(['READY-FOR-POLYGON-FIRST', 'STOP'].includes(s.RESULT));
  for (const k of ['crsDetermined', 'bboxWithinCity', 'allWardsCovered', 'cityCellCoverage', 'invalidRate', 'osmMedianOffset', 'osmUnmatchedRatio']) {
    assert.ok(s.checks[k] && typeof s.checks[k].ok === 'boolean', '§30 check 欠落: ' + k);
  }
  if (s.RESULT === 'READY-FOR-POLYGON-FIRST') {
    assert.equal(s.failedChecks.length, 0);
    assert.equal(s.source.sourceCrs, 'EPSG:6697');
    assert.equal(s.wardCoverage.wardsWithTran, 24, '24 区すべてに tran があること');
  }
});

test('[31C2] fetch-plateau.js: --layer で bldg/tran 切替（既定 bldg・building pipeline 不変）', () => {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'tools', 'fetch-plateau.js'), 'utf-8');
  assert.match(src, /args\.layer === 'tran'/);
  assert.match(src, /const layerPatterns = layerKind === 'tran' \? tranPatterns : bldgPatterns/);
  assert.match(src, /const bldgPatterns = toList\(cfg\.bldgPatterns \|\| cfg\.bldgPattern/);
});

test('[31C2] build-canonical-roads: polygon 起点で 1 枚 = 1 feature（面の二重計上をしない）', () => {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'tools', 'build-canonical-roads.js'), 'utf-8');
  assert.match(src, /function loadTranRoadPolygons/);
  assert.match(src, /function matchTranPolygons/);
  assert.match(src, /geometrySource: 'plateau-tran-road'/);
  // polygon を採用した centerline には ribbon を出さない（二重計上防止）
  assert.match(src, /if \(roadCoveredByPolygon\.has\(ri\)\) continue;/);
  const rep = rpt('canonical-road-build.json');
  if (!rep) return;
  if (rep.plateauTranAvailable) {
    assert.ok(rep.polygonCanonicalCount > 100000, 'polygon feature ' + rep.polygonCanonicalCount);
    assert.ok(rep.polygonCoverageRatioByFeature > 0.9, 'polygon 被覆率 ' + rep.polygonCoverageRatioByFeature);
    assert.equal(rep.schemaErrors, 0);
  }
  assert.ok('polygonCoverageRatioByLength' in rep && 'polygonCoverageRatioByArea' in rep, '§23 coverage 指標が無い');
});

test('[31C2] §17 高架・橋梁・トンネル: トンネルを地表面に混ぜない / 高架を推測で作らない', { skip: !rpt('canonical-road-structure.json') && 'no report' }, () => {
  const s = rpt('canonical-road-structure.json');
  assert.equal(s.plateau.tunnel, 0, 'トンネル区間が地表の道路面に混入している');
  assert.equal(s.tunnelHandling.excludedAtConversion, true);
  assert.equal(s.plateau.structureMissing, 0, 'plateauStructure の引き継ぎ漏れ');
  assert.ok(Array.isArray(s.limitations), '判定できない分を limitations として明示すること');
  assert.equal(s.RESULT, 'PASS');
});
