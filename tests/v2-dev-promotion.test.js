// tests/v2-dev-promotion.test.js
// [Mission 32P] PROMOTE CORRECTED BUILDING V2 IN DEV
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { scanFill, waterDepth } from '../tools/lib/scanline-raster.js';
import { pointInRingXZ } from '../tools/lib/osm-building-fallback.js';
import { decideV2, TH } from '../tools/build-v2-placement-policy.js';
import { classifyWater } from '../tools/audit/v2-final-overlap.js';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

test('[32P §1/§2/§24] development の既定は新しい版。V1 / V2+OLD OSM は QA 用に残り、status に標準構成を出す', () => {
  const html = fs.readFileSync(HTML, 'utf-8');
  // [Mission 35E §2] 既定は V2N → V4 へ昇格。この test の主旨は
  //   「既定が旧版（V1 / V2+OLD OSM）でないこと」と「旧版が QA 用に残っていること」。
  assert.match(html, /let buildingsVersion = 'V4';/);
  assert.doesNotMatch(html, /let buildingsVersion = 'V1';/);
  assert.doesNotMatch(html, /let buildingsVersion = 'V2';/);
  // [Mission 34C / 35D] V3・V4（回収分を足した namespace）が増えた。
  //   ラベル定義を 1 行まるごとの一致で見ると、版を足すたびに落ちる。
  //   既定の V2N を含む各版のラベルが残っていることを個別に見る。
  assert.match(html, /BUILDINGS_VERSION_LABEL = \{/);
  assert.match(html, /V1: 'V1 \(旧 canonical\)'/);
  assert.match(html, /V2: 'V2 CORRECTED \+ OLD OSM'/);
  assert.match(html, /V2N: 'V2 CORRECTED \+ OSM V2'/);
  assert.match(html, /V3: 'V3 \(V2N \+ 欠落建物の回収\)'/);
  assert.match(html, /\['V1', 'BLDG V1'/);
  assert.match(html, /\['V2', 'V2 \+ OLD OSM'/);
  assert.match(html, /\['V2N', 'V2 \+ NEW OSM'/);
  assert.match(html, /\['V3', 'V3 \+ RECOVERED'/);
  assert.match(html, />Buildings: ' \+ \(BUILDINGS_VERSION_LABEL\[buildingsVersion\]/);
  assert.match(html, />Count: ' \+ \(bc != null \? bc\.toLocaleString\('en-US'\)/);
  assert.match(html, />Road: ' \+ String\(roadVisualMode\)\.replace\(\/_\/g, ' '\) \+ '　Raw GSI Edge: '/);
  assert.match(html, /placementStats\.variant === 'v2-final' \? 'V2'/);
  // §3: 建物系 fetch を namespace 別に数える
  assert.match(html, /if \(layer === 'buildings'\) noteBuildingFetch\(tileUrl\(layer, band, tx, tz\)\);/);
});

test('[32P §3/§17] 起動直後の runtime は既定の namespace だけを読む（V1 / 旧 OSM の fetch 0）', async () => {
  const { runInlineScript } = require_('./_ward-ux-v1-smoke-harness.cjs');
  const boot = runInlineScript(HTML, { fetchRoot: path.join(ROOT, 'public') });
  assert.ok(boot.ok, boot.error && boot.error.message);
  const w = boot.window;
  for (let i = 0; i < 150 && !w.__BUILDINGS_VERSION_DEBUG__().wardIndexLoaded; i++) await new Promise((r) => setTimeout(r, 100));
  const d = w.__BUILDINGS_VERSION_DEBUG__();
  // [Mission 35E §2] 既定は V4。この test の主旨は「起動直後に旧版を読まない」こと。
  assert.equal(d.version, 'V4');
  assert.equal(d.label, 'V4 (全域再監査で作り直した final)');
  assert.equal(d.base, 'map-data/osaka-city/derived-v4-final');
  assert.equal(d.fetchByNamespace.V1, 0);
  assert.equal(d.fetchByNamespace.V2, 0);
  assert.equal(d.fetchByNamespace.V2N, 0);
  assert.equal(d.fetchByNamespace.VISUAL, 0);
  assert.ok(d.fetchByNamespace.V4 >= 2);
  const placement = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-v4-final', 'building-placement', 'manifest.json'));
  assert.equal(d.buildingCount, placement.canonicalBuildingCount);
  assert.equal(d.placementVariant, placement.variant || null);
  const sem = w.__SEMANTIC_DISPLAY_DEBUG__();
  assert.equal(sem.normalViewRoadMode, 'ROAD_V3');
  assert.equal(sem.normalViewRawGsiEdge, false);
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
  // QA 用に V1 へ切り替えられ、戻せる
  assert.equal((await w.__SET_BUILDINGS_VERSION__('V1')).base, 'map-data/osaka-city/derived');
  assert.equal((await w.__SET_BUILDINGS_VERSION__('V2N')).base, 'map-data/osaka-city/derived-v2-osmv2');
});

test('[32P §5] scanline 塗りは point-in-polygon と一致し、穴を抜く', () => {
  const g = { minX: -20, minZ: -20, nx: 40, nz: 40 };
  const outer = [[-15.3, -12.2], [14.1, -14.7], [16.2, 13.9], [0.4, 3.3], [-13.8, 15.1]];
  const hole = [[-4.2, -4.4], [4.6, -3.9], [3.8, 2.2], [-3.1, 1.7]];
  const got = new Set();
  scanFill(g, [outer, hole], (i, j) => got.add(j * g.nx + i));
  for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) {
    const x = g.minX + i + 0.5, z = g.minZ + j + 0.5;
    assert.equal(got.has(j * g.nx + i), pointInRingXZ(x, z, outer) !== pointInRingXZ(x, z, hole), `${i},${j}`);
  }
  // 水域の深さ: 左 3 列が陸
  const w = new Uint8Array(10 * 4); for (let j = 0; j < 4; j++) for (let i = 3; i < 10; i++) w[j * 10 + i] = 1;
  const d = waterDepth({ nx: 10, nz: 4 }, w);
  assert.deepEqual(Array.from(d.slice(0, 6)), [0, 0, 0, 1, 2, 3]);
});

const baseRec = { id: 'x', area: 100, w: 0, v3: 0, label: '事務所', water: null };
test('[32P §12] placement: 道路との重なりだけでは SUPPRESS しない（最大 REVIEW）', () => {
  assert.equal(decideV2({ ...baseRec, v3: 100 }).policy, 'REVIEW');
  assert.equal(decideV2({ ...baseRec, v3: 100 }).reason, 'road-v3-carriageway-overlap');
  assert.equal(decideV2({ ...baseRec, v3: 29 }).policy, 'DISPLAY');
  assert.equal(decideV2({ ...baseRec, v3: 100, label: '駅舎' }).policy, 'EXEMPT');
  assert.equal(TH.ROAD_V3_REVIEW_RATIO, 0.3);
});

test('[32P §9/§12] placement: 水域は実在構造を EXEMPT、高 confidence の衝突だけ SUPPRESS', () => {
  const water = (cls, waterClass = 'river') => ({ cls, waterClass, structure: cls === 'REAL_WATER_STRUCTURE' ? 'man_made=pier' : null });
  assert.equal(decideV2({ ...baseRec, w: 90, water: water('REAL_WATER_STRUCTURE') }).policy, 'EXEMPT');
  assert.equal(decideV2({ ...baseRec, w: 90, water: water('BUILDING_SOURCE_CONFLICT') }).policy, 'SUPPRESS');
  assert.equal(decideV2({ ...baseRec, w: 90, water: water('BUILDING_SOURCE_CONFLICT', 'harbor') }).policy, 'REVIEW');
  for (const c of ['WATER_GEOMETRY_TOO_WIDE', 'AMBIGUOUS', 'SHORELINE_CONFLICT']) assert.equal(decideV2({ ...baseRec, w: 90, water: water(c) }).policy, 'REVIEW', c);
  assert.equal(decideV2({ ...baseRec, w: 40, water: water('BUILDING_SOURCE_CONFLICT') }).policy, 'REVIEW');
  assert.equal(decideV2({ ...baseRec, w: 20, water: water('AMBIGUOUS') }).policy, 'DISPLAY');
  assert.equal(decideV2({ ...baseRec, w: 50, water: water('AMBIGUOUS', 'canal') }).policy, 'EXEMPT');
  // 小さい建物は 85% 以上でも 15m² 未満なら SUPPRESS しない
  assert.equal(decideV2({ ...baseRec, area: 10, w: 10, water: water('BUILDING_SOURCE_CONFLICT') }).policy, 'REVIEW');
});

test('[32P §9] 水域重なりの分類', () => {
  const ev = { sGrid: new Map(), bGrid: new Map(), nearCount: new Map([['0,0', 5]]), K: 200 };
  const ring = [[10, 10], [20, 10], [20, 20], [10, 20]];
  const r = (o) => ({ area: 100, w: 90, wDepth: 8, src: 'plateau-building', label: '事務所', c: [15, 15], bb: { minX: 10, maxX: 20, minZ: 10, maxZ: 20 }, ring, ...o });
  assert.equal(classifyWater(r({ label: '水門' }), ev, null).cls, 'REAL_WATER_STRUCTURE');
  assert.equal(classifyWater(r({ wDepth: 2 }), ev, null).cls, 'SHORELINE_CONFLICT');
  assert.equal(classifyWater(r({}), ev, null).cls, 'BUILDING_SOURCE_CONFLICT');
  assert.equal(classifyWater(r({ src: 'osm-building' }), ev, null).cls, 'AMBIGUOUS');
  assert.equal(classifyWater(r({}), { ...ev, nearCount: new Map() }, null).cls, 'AMBIGUOUS', 'OSM 空白地帯では建物側の誤りと言えない');
  const bGrid = new Map([['0,0', [{ ring, bb: { minX: 10, maxX: 20, minZ: 10, maxZ: 20 } }]]]);
  assert.equal(classifyWater(r({}), { ...ev, bGrid }, null).cls, 'WATER_GEOMETRY_TOO_WIDE');
  // GSI（国土地理院）の建物面による独立確認: OSM に無くても建物は実在 → SUPPRESS 対象の衝突にしない
  const gGrid = new Map([['0,0', [{ ring, bb: { minX: 10, maxX: 20, minZ: 10, maxZ: 20 } }]]]);
  const shallow = classifyWater(r({ wDepth: 8 }), { ...ev, gGrid }, null);
  assert.equal(shallow.cls, 'WATER_GEOMETRY_TOO_WIDE');
  assert.equal(shallow.evidence, 'gsi-building');
  const deep = classifyWater(r({ wDepth: 12 }), { ...ev, gGrid }, null);
  assert.equal(deep.cls, 'REAL_WATER_STRUCTURE');
  assert.equal(deep.evidence, 'gsi-building-deep-in-water');
  // OSM fallback でも GSI は独立ソースとして使える
  assert.equal(classifyWater(r({ src: 'osm-building', wDepth: 8 }), { ...ev, gGrid }, null).cls, 'WATER_GEOMETRY_TOO_WIDE');
});

test('[32P §5/§6/§8] 正式 KPI は V2 建物で再計算され、過去値は historical 扱い', { skip: skip('v2-final-road-overlap.json') }, () => {
  const road = rpt('v2-final-road-overlap.json');
  assert.equal(road.buildingSet.total, 600764);
  for (const s of ['umeda', 'honmachi', 'namba', 'tennoji', 'sumiyoshi', 'higashiyodogawa']) {
    for (const k of ['FIX13', 'ROAD_V2', 'ROAD_V3']) {
      const v = road.sites[s][k];
      assert.equal(typeof v.overlapM2, 'number'); assert.equal(typeof v.buildingsTouching, 'number'); assert.equal(typeof v.overlapRatio, 'number');
    }
  }
  assert.equal(road.historical.status, 'historical-invalidated-by-v2');
  assert.ok(road.citywide.ROAD_V3.overlapM2 < road.historical.mission32I_v1Buildings.overlapM2.v3);
  const water = rpt('v2-final-water-overlap.json');
  const sum = Object.values(water.citywide.byClass).reduce((a, v) => a + v.buildings, 0);
  assert.equal(sum, water.citywide.buildingsTouching);
  for (const r of ['大川', '淀川', '道頓堀川', '木津川', '安治川']) assert.ok(water.focusRivers[r], r);
});

test('[32P §11/§13/§14] placement と ward index は V2 から再生成', { skip: skip('v2-placement-policy.json') }, () => {
  const p = rpt('v2-placement-policy.json');
  const c = p.policyCounts;
  assert.equal(c.DISPLAY + c.SUPPRESS + c.REVIEW + c.EXEMPT, 600764);
  assert.equal(p.variant, 'v2-final');
  assert.ok(!Object.keys(p.byReason).some((k) => k.startsWith('SUPPRESS') && k !== 'SUPPRESS high-confidence-water-conflict'));
  assert.equal(p.wardIndex.wards, 24);
  assert.equal(p.wardIndex.generatedFromV2, true);
  const pub = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement', 'manifest.json'));
  assert.equal(pub.variant, 'v2-final');
  assert.equal(pub.uses31e, false);
});

test('[32P §26] V1 前提の過去レポートは削除せず historical-invalidated-by-v2 を明記', () => {
  const idx = rpt('historical-invalidated-by-v2.json');
  assert.ok(idx && idx.invalidated.length >= 3);
  for (const e of idx.invalidated) {
    assert.ok(fs.existsSync(path.join(ROOT, e.md)), e.md);
    assert.match(fs.readFileSync(path.join(ROOT, e.md), 'utf-8'), /historical-invalidated-by-v2/);
    assert.equal(rj(path.join(ROOT, e.json)).historicalStatus.status, 'historical-invalidated-by-v2');
  }
});

test('[32P §29] validator が PASS', { skip: skip('v2-dev-promotion-validation.json') }, () => {
  const v = rpt('v2-dev-promotion-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.classification, 'V2_DEV_PROMOTION_SUCCESS');
  assert.equal(v.devDefaultBuildingMode, 'V2_NEW_OSM');
  assert.equal(v.v1Default, false);
  assert.equal(v.v1StillAvailableForQa, true);
  assert.equal(v.plateauV2Count, 574112);
  assert.equal(v.osmFallbackV2Count, 26652);
  assert.equal(v.totalBuildingCount, 600764);
  assert.equal(v.oldOsmFallbackUsed, false);
  assert.equal(v.roadMode, 'ROAD_V3');
  assert.equal(v.rawGsiEdgeDefault, false);
  assert.equal(v.placementGeneratedFromV2, true);
  assert.equal(v.wardIndexGeneratedFromV2, true);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
});
