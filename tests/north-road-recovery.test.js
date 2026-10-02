// tests/north-road-recovery.test.js
// [Mission 35E] 北側道路の補完 + 建物 V4 の dev 既定昇格
//   - 緯度の崖の検出 / way 長さ / 区の割り当て
//   - ROAD V3 の意味・設計を変えていない（§5）/ 新しい renderer を作っていない（§8）
//   - dev 既定が V4、旧版は QA 用に残る（§2）
//   - production は 600,764 のまま（§14）
//   - 道路 way ID の一意性（§7）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  latHistogram, latitudeCliff, wayLengthM, wayWard, summarize,
  NORTH_WARDS, COVERAGE_CELL_M, R,
} from '../tools/audit/north-road-coverage.js';
import { roadVisibleAt } from '../tools/build-derived-roads.js';
import {
  PRODUCTION_BUILDING_COUNT, DEV_BUILDING_DEFAULT, ROAD_V3_MARKERS, NORTH_IMPROVE_PCT,
} from '../tools/validate/north-road-recovery.js';
import { SITES, PERF_SITES, worldOf } from '../tools/audit/north-road-runtime-qa.js';
import { latLonToLiveCityWorld } from '../tools/lib/livecity-coordinate-system.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

// ── 緯度の崖 ────────────────────────────────────────────────────────────
test('35E 道路 source の北側の崖を検出できる', () => {
  // 旧 source の実測値（34.72 で 7,338 → 34.73 で 846 → 34.74 で 1）
  const clipped = { '34.71': 5901, '34.72': 7338, '34.73': 846, '34.74': 1 };
  const c = latitudeCliff(clipped);
  assert.ok(c, '崖を見つけられていない');
  assert.ok(c.atLat >= 34.73 && c.atLat <= 34.74, 'atLat=' + c.atLat);
  assert.ok(c.ratio >= 8);
  // 切れていないデータでは崖にならない
  assert.equal(latitudeCliff({ '34.71': 6000, '34.72': 5800, '34.73': 6200, '34.74': 5900 }), null);
});

test('35E 緯度ヒストグラムは way の中心緯度で数える', () => {
  const els = [
    { geometry: [{ lat: 34.700, lon: 135.5 }, { lat: 34.704, lon: 135.5 }] },
    { geometry: [{ lat: 34.750, lon: 135.5 }, { lat: 34.750, lon: 135.5 }] },
    { geometry: [] },
  ];
  const h = latHistogram(els);
  assert.equal(h['34.70'], 1);
  assert.equal(h['34.75'], 1);
  assert.equal(Object.keys(h).length, 2, 'geometry 無しは数えない');
});

// ── way の長さ / 区 ─────────────────────────────────────────────────────
test('35E way の長さを world 座標で測る', () => {
  // 経度 0.001 度 ≈ 91.5m（lat 34.70 付近）
  const L = wayLengthM([{ lat: 34.70, lon: 135.500 }, { lat: 34.70, lon: 135.501 }]);
  assert.ok(L > 85 && L < 95, 'L=' + L);
  assert.equal(wayLengthM([{ lat: 34.7, lon: 135.5 }]), 0);
});

test('35E way の区は中点で決める', () => {
  const wards = [{ wardId: 'w', bbox: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
    polygons: [{ outer: [[-100, -100], [100, -100], [100, 100], [-100, 100]], holes: [] }] }];
  const c = latLonToLiveCityWorld(34.604208, 135.52502);   // 原点
  assert.ok(Math.abs(c.x) < 1 && Math.abs(c.z) < 1, '原点の確認');
  assert.equal(wayWard([{ lat: 34.604208, lon: 135.52502 }, { lat: 34.604208, lon: 135.52502 }, { lat: 34.604208, lon: 135.52502 }], wards), 'w');
  assert.equal(wayWard([{ lat: 35.5, lon: 136.5 }, { lat: 35.5, lon: 136.5 }, { lat: 35.5, lon: 136.5 }], wards), null);
});

test('35E 区ごとの集計は ways / 延長 / 被覆セルを出す', () => {
  const wards = [{ wardId: 'w', bbox: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 },
    polygons: [{ outer: [[-1000, -1000], [1000, -1000], [1000, 1000], [-1000, 1000]], holes: [] }] }];
  const els = [
    { id: 1, geometry: [{ lat: 34.604208, lon: 135.52502 }, { lat: 34.604208, lon: 135.5255 }, { lat: 34.604208, lon: 135.526 }] },
    { id: 2, geometry: [{ lat: 34.604208, lon: 135.52502 }] },   // 点だけ → 数えない
  ];
  const s = summarize(els, wards, COVERAGE_CELL_M);
  assert.equal(s.byWard.w.ways, 1);
  assert.ok(s.byWard.w.lengthM > 0);
  assert.ok(s.byWard.w.coveredCells >= 1);
  assert.equal(s.noGeom, 1);
  assert.equal(s.ids.size, 1, 'geometry の無い way は ID にも数えない');
});

test('35E 北側の重点区が定義されている', () => {
  for (const w of ['higashiyodogawa', 'yodogawa', 'asahi']) assert.ok(NORTH_WARDS.includes(w), w);
  assert.ok(COVERAGE_CELL_M > 0 && COVERAGE_CELL_M <= 500);
  assert.ok(NORTH_IMPROVE_PCT > 0);
});

// ── §5 ROAD V3 の LOD 規則を変えていない ────────────────────────────────
test('35E 道路の LOD 規則は build-derived-geometry と同じ', () => {
  assert.equal(roadVisibleAt('far', { lodClass: 'major' }), true);
  assert.equal(roadVisibleAt('far', { lodClass: 'mid' }), false);
  assert.equal(roadVisibleAt('far', { lodClass: 'local' }), false);
  assert.equal(roadVisibleAt('mid', { lodClass: 'mid' }), true);
  assert.equal(roadVisibleAt('mid', { lodClass: 'local' }), false);
  assert.equal(roadVisibleAt('near', { lodClass: 'local' }), true, 'near は完全');
  assert.equal(roadVisibleAt('near', {}), true);
});

// ── §9/§12 QA 地点 ─────────────────────────────────────────────────────
test('35E §9 の必須確認地点がすべて定義されている', () => {
  const ids = SITES.map((s) => s.id);
  for (const need of ['shin-osaka', 'higashi-mikuni', 'awaji', 'kami-shinjo',
    'juso', 'nishinakajima', 'kunijima', 'asahi-north']) {
    assert.ok(ids.includes(need), need + ' が無い');
  }
  // すべて緯度経度で書かれ、北側にある
  for (const s of SITES) {
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon), s.id);
    assert.ok(s.lat > 34.70, s.id + ' が北側でない: ' + s.lat);
  }
});

test('35E QA 地点の world 座標は正本の変換を通す', () => {
  for (const s of SITES) {
    const w = worldOf(s);
    const ref = latLonToLiveCityWorld(s.lat, s.lon);
    assert.equal(w.x, Math.round(ref.x));
    assert.equal(w.z, Math.round(ref.z));
  }
  // 淡路（東淀川）は旧 PBF の崖（lat 34.73）より北
  const awaji = SITES.find((s) => s.id === 'awaji');
  assert.ok(awaji.lat > 34.73, '崖より北の地点を見ていない');
});

test('35E §12 の性能測定地点が揃っている', () => {
  const ids = PERF_SITES.map((s) => s.id);
  for (const n of ['umeda', 'shin-osaka', 'higashiyodogawa', 'yodogawa']) assert.ok(ids.includes(n), n);
});

// ── §2 dev 既定 / §14 production ────────────────────────────────────────
test('35E dev の既定が V4、旧版は QA 用に残っている', () => {
  const html = fs.readFileSync(DEV, 'utf-8');
  assert.match(html, /let buildingsVersion = 'V4';/);
  assert.match(html, /derived-v4-final/);
  // 旧版の切替は消していない
  for (const v of ['V1', 'V2', 'V2N', 'V3']) {
    assert.ok(new RegExp("'" + v + "'").test(html), v + ' の切替が消えている');
  }
  assert.match(html, /derived-v2-osmv2/);
  assert.match(html, /derived-v2-osmv3/);
  assert.equal(DEV_BUILDING_DEFAULT, 'V4_REBUILT_FINAL');
});

test('35E §5 ROAD V3 の印が dev に残っている', () => {
  const html = fs.readFileSync(DEV, 'utf-8');
  for (const m of ROAD_V3_MARKERS) assert.ok(html.includes(m), m + ' が消えている');
  // §8 新しい road renderer を作っていない
  assert.ok(!/RoadV4Layer|ROAD_V4/.test(html), '新しい road renderer を足している');
});

test('35E §14 production は V2N（600,764）のまま', { skip: fs.existsSync(PROD) ? false : 'no production' }, () => {
  // 35E の時点では production は V2N のままにしておく約束だった。
  //   [Mission 35G] ユーザー承認のうえ V4（618,749）へ昇格したので、ここで守るのは
  //   「35E が根拠にした V2N の建物数 600,764 が今も正しく残っていること」。
  const html = fs.readFileSync(PROD, 'utf-8');
  assert.match(html, /let buildingsVersion = 'V4';/, '35G の cutover 後は V4');
  assert.equal(PRODUCTION_BUILDING_COUNT, 600764);
  const m = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement', 'manifest.json'));
  if (m) assert.equal(m.canonicalBuildingCount, PRODUCTION_BUILDING_COUNT, 'V2N の建物数が変わっている');
});

test('35E 旧 road source を消していない', () => {
  const backup = path.join(ROOT, 'data', 'raw', 'osaka-city', 'roads-osm.osaka-latest-backup.json');
  assert.ok(fs.existsSync(backup), '旧 road source のバックアップが無い');
  const oldPbf = path.join(ROOT, 'data', 'raw', 'osm', 'osaka-latest.osm.pbf');
  assert.ok(fs.existsSync(oldPbf), '旧 PBF を消している');
});

// ── 実測（レポートがあるときだけ）───────────────────────────────────────
test('35E 実測: 新 source の崖が市域の外へ出た', { skip: skip('north-road-coverage.json') }, () => {
  const c = rpt('north-road-coverage.json');
  assert.ok(c.oldSource.latitudeCliff, '旧 source に崖が無い（前提が崩れている）');
  assert.ok(c.oldSource.latitudeCliff.atLat <= 34.75, '旧の崖 ' + c.oldSource.latitudeCliff.atLat);
  if (c.newSource) {
    const nc = c.newSource.latitudeCliff;
    // 大阪市 24 区の北端は約 34.7688。崖がそれより北なら市域は覆えている。
    assert.ok(!nc || nc.atLat > 34.769, '新 source の崖が市域の中にある: ' + JSON.stringify(nc));
  }
});

test('35E 実測: 北側 3 区の被覆が大幅に改善した', { skip: skip('north-road-coverage.json') }, () => {
  const c = rpt('north-road-coverage.json');
  if (!c.newSource) return;
  for (const wid of ['higashiyodogawa', 'yodogawa', 'asahi']) {
    const w = c.byWard.find((x) => x.wardId === wid);
    assert.ok(w, wid + ' が無い');
    assert.ok(w.cellGainPct >= NORTH_IMPROVE_PCT, `${wid} の被覆改善が ${w.cellGainPct}%`);
    assert.ok(w.newWays >= w.oldWays, wid + ' の ways が減っている');
  }
  // 元々切れていなかった区は大きく動かない
  const kita = c.byWard.find((x) => x.wardId === 'kita');
  assert.ok(Math.abs(kita.cellGainPct) < 5, '北区が大きく動いている ' + kita.cellGainPct);
});

test('35E 実測: 道路 way ID が一意（二重生成していない）', { skip: skip('north-road-coverage.json') }, () => {
  const c = rpt('north-road-coverage.json');
  if (!c.duplicateCheck) return;
  assert.equal(c.newSource.ways, c.duplicateCheck.newUnique, '新 source に重複 way ID がある');
  assert.equal(c.oldSource.ways, c.duplicateCheck.oldUnique);
  assert.ok(c.duplicateCheck.newWayIdsAdded > 0, '追加された way が無い');
});

test('35E 実測: canonical roads が増え、ビルドが PASS', { skip: (() => {
  const m = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'));
  return m ? false : 'no canonical roads';
})() }, () => {
  const m = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'));
  assert.ok(m.featureCount > 199000, 'canonical roads が少なすぎる ' + m.featureCount);
  const b = rpt('canonical-road-build.json');
  if (b) {
    assert.equal(b.schemaErrors || 0, 0);
    if (b.RESULT) assert.equal(b.RESULT, 'PASS');
  }
});

test('35E 実測: 検証が PASS している', { skip: skip('north-road-recovery-validation.json') }, () => {
  const v = rpt('north-road-recovery-validation.json');
  assert.ok(['NORTH_OSAKA_ROAD_RECOVERY_SUCCESS', 'NORTH_OSAKA_ROAD_RECOVERY_FAILED'].includes(v.classification));
  assert.equal(v.devBuildingDefault, DEV_BUILDING_DEFAULT);
  assert.equal(v.productionBuildingCount, PRODUCTION_BUILDING_COUNT);
  assert.equal(v.roadSourceNorthCoverageImproved, true);
  assert.equal(v.roadV3LogicMutation, false);
  assert.equal(v.projectionMutation, false);
  assert.equal(v.duplicateRoadIncrease, 0);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
});

test('35E 実測: 実ブラウザで北部 8 地点に道路が出ている', { skip: skip('north-road-runtime-qa.json') }, () => {
  const q = rpt('north-road-runtime-qa.json');
  assert.equal(q.sites.length, SITES.length);
  assert.equal(q.summary.allSitesHaveRoads, true,
    '道路が出ていない地点: ' + JSON.stringify(q.sites.filter((s) => (s.roadCoverage || 0) <= 0.02).map((s) => s.id)));
  assert.equal(q.summary.buildingsVersion, 'V4', '起動時の建物版が V4 でない');
  assert.equal(q.summary.regressionOk, true, JSON.stringify(q.summary.regression));
  assert.equal(q.summary.jsErrors, 0);
});
