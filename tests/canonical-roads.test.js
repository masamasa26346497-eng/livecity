// tests/canonical-roads.test.js
// [Mission 31C → 31C2] Canonical Roads 正式化。
//   31C 時点は polygon source が無く全 feature が OSM centerline + 幅推定の ribbon fallback だった。
//   31C2 で PLATEAU tran:Road（道路区域面）を取得し polygon-first へ移行したため、
//   「polygon coverage 0 / 全 ribbon」を固定していた assertion は 31C2 の実態へ rebase してある。
//   schema / provenance / confidence / centerlineRef / bridge・tunnel 属性 / tile prototype /
//   major road QA / Building∩Road・Road∩Water 監査 / RoadLayer render 不変。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { validateCanonicalFeature, isValidConfidence, ringAreaM2, SOURCE_PRIORITY, SOURCE_REGISTRY } from '../tools/lib/canonical-geometry-schema.js';
import { resolveRoadWidth } from '../tools/lib/road-network.js';
import { classifyRoadLod } from '../tools/lib/road-lod.js';

const P = (...s) => path.join(PROJECT_ROOT, ...s);
const DIR = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const MANIFEST = path.join(DIR, 'manifest.json');
const VALIDATION = P('data', 'reports', 'canonical-road-validation.json');
const BUILD = P('data', 'reports', 'canonical-road-build.json');
const MAJOR = P('data', 'reports', 'canonical-road-major.json');
const SOURCES = P('data', 'reports', 'canonical-road-source-comparison.json');
const INTERSECTION = P('data', 'reports', 'canonical-road-intersection-qa.json');
const CONFLICTS = P('data', 'reports', 'canonical-conflicts.json');
const PREVIEW = P('data', 'reports', 'canonical-road-preview.geojson');

const hasBuild = fs.existsSync(MANIFEST);
function loadFeatures() {
  const seen = new Map();
  for (const f of fs.readdirSync(DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    for (const ft of JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8')).features || []) if (!seen.has(ft.canonicalId)) seen.set(ft.canonicalId, ft);
  }
  return [...seen.values()];
}
const feats = hasBuild ? loadFeatures() : [];
const manifest = hasBuild ? JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')) : null;

// ── 純ロジック（既存 lib の再利用確認）──
test('[31C] resolveRoadWidth / classifyRoadLod: 幅推定 + LOD 分類（Mission26 意味不変）', () => {
  assert.equal(resolveRoadWidth({ highway: 'primary', width: '12' }).source, 'width');
  assert.equal(resolveRoadWidth({ highway: 'primary', lanes: '4' }).source, 'lanes');
  assert.equal(resolveRoadWidth({ highway: 'residential' }).source, 'class-default');
  assert.equal(classifyRoadLod('motorway'), 'major');
  assert.equal(classifyRoadLod('tertiary'), 'mid');
  assert.equal(classifyRoadLod('residential'), 'local');
});

// ── source inventory / PLATEAU tran（§1/§2/§3）──
test('[31C2] road source inventory: PLATEAU tran 取得済み / rank1 公的道路区域は未取得のまま', { skip: !fs.existsSync(SOURCES) && 'no report' }, () => {
  const s = JSON.parse(fs.readFileSync(SOURCES, 'utf-8'));
  assert.equal(s.currentOsmCenterline.hasAreaGeometry, false, 'OSM 側に area geometry は無い（変わっていないこと）');
  assert.ok(s.plateauTranAudit, 'PLATEAU tran 監査が無い（§2）');
  assert.equal(s.plateauTranAudit.available, true, 'PLATEAU tran は 31C2 で取得済み');
  assert.ok(s.plateauTranAudit.featureCount > 100000, 'tran 道路面 ' + s.plateauTranAudit.featureCount);
  assert.match(s.plateauTranAudit.status, /^acquired/);
  assert.ok(Array.isArray(s.officialRoadAreaSources) && s.officialRoadAreaSources.length >= 3, '公的道路区域 source 候補（§3）が足りない');
  assert.ok(s.officialRoadAreaSources.some((x) => x.canonicalPriority === 1));
  // rank1（公的道路区域）は依然未取得。PLATEAU で満足して打ち切っていないことを明示する。
  assert.match(s.availabilitySummary['official-road-area'], /not-acquired/);
});

// ── build 出力 ──
test('[31C2] canonical roads: polygon-first（PLATEAU tran 道路区域面が主 / ribbon は補完）', { skip: !hasBuild && 'no build' }, () => {
  assert.equal(manifest.coordinateConvention, 'znorth-neg-v1');
  assert.equal(manifest.layer, 'roads');
  assert.deepEqual(manifest.sourcePriority.map((p) => p.sourceId), SOURCE_PRIORITY.roads.map((p) => p.sourceId));
  assert.ok(feats.length > 30000, 'feature 数 ' + feats.length);
  const bySrc = {};
  for (const f of feats) bySrc[f.source.geometrySource] = (bySrc[f.source.geometrySource] || 0) + 1;
  // geometrySource は 2 種類のみ（polygon-first source と ribbon fallback）
  assert.deepEqual(Object.keys(bySrc).sort(), ['osm-road-centerline', 'plateau-tran-road']);
  const polyShare = (bySrc['plateau-tran-road'] || 0) / feats.length;
  assert.ok(Math.abs(manifest.polygonCoverageRatio - polyShare) < 0.001, 'manifest の polygon 被覆率が実態とずれている');
  assert.ok(polyShare > 0.9, 'polygon 被覆率 ' + polyShare.toFixed(4));
  for (const f of feats) {
    if (f.source.geometrySource === 'osm-road-centerline') assert.match(f.widthProfile.method, /osm-centerline-(default-)?width/);
    else assert.equal(f.widthProfile.method, 'plateau-tran-polygon', 'polygon feature が幅推定を使っている');
  }
});

test('[31C2] 面の二重計上をしない: polygon feature の canonicalId は PLATEAU gml:id 由来で一意', { skip: !hasBuild && 'no build' }, () => {
  const polys = feats.filter((f) => f.source.geometrySource === 'plateau-tran-road');
  const tranIds = new Set();
  for (const f of polys) {
    const sid = f.source.sourceIds.find((s) => s.startsWith('plateau-tran/'));
    assert.ok(sid, 'polygon feature に PLATEAU source id が無い: ' + f.canonicalId);
    assert.ok(!tranIds.has(sid), '同じ tran polygon が 2 度 feature 化されている（二重計上）: ' + sid);
    tranIds.add(sid);
  }
  // polygon を採用した centerline に ribbon が重ねられていないこと
  const ribbonIds = new Set(feats.filter((f) => f.source.geometrySource === 'osm-road-centerline').map((f) => f.canonicalId));
  for (const f of polys) {
    for (const s of ((f.centerlineRef && f.centerlineRef.sourceIds) || [])) {
      assert.ok(!ribbonIds.has('cg_road_' + s.replace(/^way\//, '')), 'polygon と ribbon が同じ道路で二重に出ている: ' + s);
    }
  }
});

test('[31C] 全 feature: schema valid / provenance 100% / confidence 100% / invalid polygon 0', { skip: !hasBuild && 'no build' }, () => {
  const ids = new Set();
  let schemaErr = 0, provMissing = 0, confInvalid = 0, invalidPoly = 0, noSourceIds = 0, noCenterlineRef = 0;
  for (const f of feats) {
    assert.ok(!ids.has(f.canonicalId), 'dup id ' + f.canonicalId);
    ids.add(f.canonicalId);
    const v = validateCanonicalFeature(f);
    if (!v.ok) { schemaErr++; if (schemaErr <= 3) console.error(f.canonicalId, v.errors); }
    if (!f.source || !SOURCE_REGISTRY[f.source.geometrySource]) provMissing++;
    else {
      if (!isValidConfidence(f.source.confidence)) confInvalid++;
      if (!f.source.sourceIds || !f.source.sourceIds.length) noSourceIds++;
    }
    // centerlineRef は「OSM centerline と対応がついた feature」だけが持つ。
    // 対応する centerline が存在しない PLATEAU polygon（OSM 欠測域を含む）は
    // attributes-source-missing を明示していれば centerlineRef 無しで正しい（§20/§21）。
    const orphan = (f.qaFlags || []).includes('attributes-source-missing');
    if (!orphan && (!f.centerlineRef || !Array.isArray(f.centerlineRef.coordinates) || f.centerlineRef.coordinates.length < 2)) noCenterlineRef++;
    if (orphan) {
      assert.ok(!f.centerlineRef, 'attributes-source-missing なのに centerlineRef を持つ: ' + f.canonicalId);
      assert.equal(f.attributes.name, null, '属性欠測のはずが name を持つ（捏造）: ' + f.canonicalId);
      assert.equal(f.attributes.highway, null, '属性欠測のはずが highway を持つ（捏造）: ' + f.canonicalId);
    }
    const polys = f.geometryType === 'Polygon' ? [f.coordinates] : (f.geometryType === 'MultiPolygon' ? f.coordinates : []);
    for (const poly of polys) if (!(ringAreaM2(poly[0] || []) > 0)) invalidPoly++;
    assert.ok(!('color' in f) && !('style' in f), 'canonical に style 混入: ' + f.canonicalId);
  }
  assert.equal(schemaErr, 0, schemaErr + ' schema エラー');
  assert.equal(provMissing, 0);
  assert.equal(confInvalid, 0);
  assert.equal(noSourceIds, 0);
  assert.equal(noCenterlineRef, 0, 'centerlineRef 欠落 ' + noCenterlineRef);
  assert.equal(invalidPoly, 0, 'invalid polygon ' + invalidPoly);
});

test('[31C] bridge / tunnel / layer 属性を保持（§13 高架・地下判定用）', { skip: !hasBuild && 'no build' }, () => {
  const bridges = feats.filter((f) => f.attributes.bridge);
  const tunnels = feats.filter((f) => f.attributes.tunnel);
  assert.ok(bridges.length > 100, 'bridge feature ' + bridges.length);
  assert.ok(tunnels.length > 10, 'tunnel feature ' + tunnels.length);
  for (const f of bridges.slice(0, 20)) assert.ok(f.qaFlags.includes('bridge'), 'bridge feature に qaFlag が無い');
});

test('[31C2] LOD class を保持（Mission26 の major/mid/local 意味不変）', { skip: !hasBuild && 'no build' }, () => {
  const cls = { major: 0, mid: 0, local: 0 };
  for (const f of feats) {
    cls[f.attributes.lodClass] = (cls[f.attributes.lodClass] || 0) + 1;
    if ((f.qaFlags || []).includes('lod-from-plateau-admin-class')) {
      // OSM highway が無い feature のみ、PLATEAU 行政種別から同じ意味のバンドへ割り当てる。
      // 意味（major=幹線 / mid=補助幹線 / local=生活道路）は Mission26 のまま。
      assert.equal(f.attributes.highway, null, 'OSM highway があるのに PLATEAU 由来 LOD を使っている');
      const expect = (f.attributes.plateauAdminClass === 'expressway' || f.attributes.plateauAdminClass === 'national') ? 'major'
        : f.attributes.plateauAdminClass === 'prefectural' ? 'mid' : 'local';
      assert.equal(f.attributes.lodClass, expect, 'PLATEAU 行政種別 → LOD の対応が崩れている');
    } else {
      assert.equal(f.attributes.lodClass, classifyRoadLod(f.attributes.highway));
    }
  }
  assert.ok(cls.major > 500 && cls.mid > 1000 && cls.local > 10000, JSON.stringify(cls));
});

test('[31C] major road QA: 重点道路が canonical roads に存在', { skip: !fs.existsSync(MAJOR) && 'no report' }, () => {
  const rep = JSON.parse(fs.readFileSync(MAJOR, 'utf-8'));
  const core = ['御堂筋', '新御堂筋', '中央大通', '阪神高速', '国道43号', '国道25号', '長居公園通'];
  for (const nm of core) {
    const r = rep.roads.find((x) => x.name === nm);
    assert.ok(r && r.featureCount > 0, nm + ' が canonical roads に無い');
    // 31C2: polygon source を取得済み。重点道路はすべて実測の道路区域面で表現されている。
    assert.equal(r.polygonSourceAvailable, true);
    assert.ok(r.polygonFeatures > 0, nm + ' に polygon feature が無い');
    assert.ok(r.polygonAreaM2 > 0, nm + ' の polygon 面積が 0');
  }
});

test('[31C2] intersection QA: polygon 採用で交差点が一体面になったことを記録', { skip: !fs.existsSync(INTERSECTION) && 'no report' }, () => {
  const q = JSON.parse(fs.readFileSync(INTERSECTION, 'utf-8'));
  assert.match(q.conclusion, /polygon source/);
  assert.ok(Number.isFinite(q.ribbonSelfCross));
  assert.ok(q.tranPolygonsLoaded > 100000, 'tran polygon が読まれていない');
  // §15 定量比較: ribbon の多重重なりが polygon でどれだけ減ったか
  const CMP = P('data', 'reports', 'canonical-road-intersection-compare.json');
  if (!fs.existsSync(CMP)) return;
  const c = JSON.parse(fs.readFileSync(CMP, 'utf-8'));
  assert.ok(c.samples.length >= 5, '交差点サンプルが少なすぎる');
  assert.ok(c.totalOverlapAreaBeforeM2 > 0, 'before の重複面積が測れていない');
  assert.ok(c.totalOverlapAreaAfterM2 <= c.totalOverlapAreaBeforeM2, '重複が増えている');
  assert.equal(c.RESULT, 'IMPROVED');
});

test('[31C] tile prototype: manifest featureCount == ユニーク feature / simplify なし', { skip: !hasBuild && 'no build' }, () => {
  assert.equal(manifest.featureCount, feats.length);
  assert.match(manifest.simplification, /none/);
  assert.ok(manifest.tiles.length > 20);
  assert.ok(fs.existsSync(path.join(DIR, manifest.tiles[0].file)));
});

test('[31C] conflict 監査: Building∩Road + Road∩Water 実計算 / bridge=EXPLAINED / byRoadClass', { skip: !fs.existsSync(CONFLICTS) && 'no conflicts' }, () => {
  const c = JSON.parse(fs.readFileSync(CONFLICTS, 'utf-8'));
  assert.ok(c.pairStatus.BUILDING_ROAD.computed, 'Building∩Road 未計算（§11）');
  assert.ok(c.pairStatus.ROAD_WATER.computed, 'Road∩Water 未計算（§12）');
  assert.ok((c.byCode.BUILDING_ROAD || 0) > 0);
  assert.ok('byRoadClass' in c, 'byRoadClass が無い（§21）');
  // bridge 上の建物・地下道路の上の建物は EXPLAINED
  assert.ok((c.byCause['building-over-road'] || 0) > 0 || (c.byCause['covered-road'] || 0) > 0, 'bridge/tunnel の意味付けが無い（§13）');
  // 31D で BUILDING_RAIL / PARK_BUILDING も実計算。LAND_SEA のみ pending。
  assert.equal(c.pairStatus.LAND_SEA.computed, false);
});

test('[31C] preview GeoJSON: major LOD / CRS84 / properties', { skip: !fs.existsSync(PREVIEW) && 'no preview' }, () => {
  const gj = JSON.parse(fs.readFileSync(PREVIEW, 'utf-8'));
  assert.equal(gj.type, 'FeatureCollection');
  assert.ok(gj.features.length > 500);
  const f = gj.features[0];
  assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
  assert.ok('highway' in f.properties && 'widthM' in f.properties && 'confidence' in f.properties);
});

test('[31C] canonical-roads validator が PASS', { skip: !fs.existsSync(VALIDATION) && 'no validation' }, () => {
  const v = JSON.parse(fs.readFileSync(VALIDATION, 'utf-8'));
  assert.equal(v.RESULT, 'PASS');
  assert.equal(v.checks.schemaErr, 0);
  assert.equal(v.checks.invalidPoly, 0);
  assert.equal(v.checks.majorMissing, 0);
  assert.ok(v.polygonCoverageRatio > 0.9, 'polygon 被覆率 ' + v.polygonCoverageRatio);
  assert.equal(v.plateauTranAdopted, true);
  // §28: polygon feature の centerlineRef / osmMatchQuality 欠落は 0（orphan は別枠で許容）
  assert.equal(v.checks.plateauNoCenterlineRef, 0);
  assert.equal(v.checks.plateauNoMatchQuality, 0);
});

test('[31C2] build report: polygon coverage（feature/延長/面積）と width resolution 内訳', { skip: !fs.existsSync(BUILD) && 'no report' }, () => {
  const b = JSON.parse(fs.readFileSync(BUILD, 'utf-8'));
  assert.equal(b.plateauTranAvailable, true);
  assert.ok(b.polygonCanonicalCount > 100000, 'polygon feature ' + b.polygonCanonicalCount);
  assert.equal(b.polygonCanonicalCount, b.polygonWithOsmAttributes + b.orphanTranCount, 'polygon の内訳が合わない');
  // §23: 3 通りの被覆率がすべて記録され、いずれも高い
  for (const k of ['polygonCoverageRatioByFeature', 'polygonCoverageRatioByLength', 'polygonCoverageRatioByArea']) {
    assert.ok(b[k] > 0.9, k + ' = ' + b[k]);
  }
  // 幅推定は ribbon fallback にのみ適用される（polygon は実測面）
  assert.ok(b.widthResolution.classDefault > b.widthResolution.widthTag, 'class-default が支配的なはず（OSM に width タグは少ない）');
  assert.equal(b.widthResolution.widthTag + b.widthResolution.lanes + b.widthResolution.classDefault, b.ribbonFallbackCount,
    '幅推定の件数が ribbon feature 数と一致しない（polygon にも幅推定を掛けている疑い）');
  assert.equal(b.schemaErrors, 0);
});

test('[31C] RoadLayer / protected は不変（31C は render を触らない）（production は 32U cutover で promoted build）', () => {
  const dev = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
  if (fs.existsSync(dev)) {
    const h = fs.readFileSync(dev, 'utf-8');
    assert.ok(/RoadLayer/.test(h), 'RoadLayer が消えた');
    assert.ok(!/canonical\/roads|canonical-road/.test(h), 'dev HTML に canonical roads 参照が混入');
  }
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = P('public', rel);
    if (fs.existsSync(p)) assert.ok(!/canonical-geometry-schema|canonical\/roads/.test(fs.readFileSync(p, 'utf-8')), rel + ' に混入');
  }
});
