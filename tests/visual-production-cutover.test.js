// tests/visual-production-cutover.test.js
// [Mission 35J] 35I の見た目を production へ反映
//   - 反映したのは見た目だけ（データ・geometry は 1 つも動かない）
//   - production は dev からビルドプロファイル 1 行だけの変換
//   - 開発用の切替（TUNE / VISUAL / LIGHT）は production で表示されない
//   - protected は 1 バイトも変わらない
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILDING_COUNT, PLATEAU_BUILDING_COUNT, V4_FALLBACK_COUNT, FPS_DIFF_BUDGET_PCT,
} from '../tools/validate/visual-production-cutover.js';
import { EXPECTED, SITES, DEV_ONLY_IDS, PRODUCTION_UI_IDS, worldOf } from '../tools/audit/visual-production-qa.js';
import { MIN_SCENE_LUMA, MAX_CLIPPED_FRACTION } from '../tools/audit/directional-balance-qa.js';
import {
  productionIsDevWithProfileOnly, productionMatchesBuildRecord, devUiIsGated, sha256,
} from '../tools/lib/production-invariants.js';
import {
  CANONICAL_ROAD_FEATURE_COUNT, CANONICAL_RAIL_FEATURE_COUNT,
  CANONICAL_WATER_FEATURE_COUNT, CANONICAL_PARKS_FEATURE_COUNT, CANONICAL_STATION_COUNT,
} from '../tools/lib/canonical-baseline.js';
import { classifyPointToWard } from '../tools/lib/point-in-polygon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const prod = fs.readFileSync(PROD, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');
const M = (...s) => path.join(ROOT, 'public', 'map-data', 'osaka-city', ...s);

// ── §2 35I の値がそのまま入っている ────────────────────────────────────
test('35J production の visual 既定が 35I', () => {
  assert.match(prod, /let visualProfile = 'DEPTH';/);
  assert.match(prod, /let depthTuning = '35I';/);
  assert.match(prod, /let lightLevel = 'STANDARD';/);
  assert.equal(EXPECTED.tuning, '35I');
});

test('35J 35I の壁・接地・光の値が勝手に変わっていない', () => {
  const t = prod.match(/'35I': \{ wallLit: ([\d.]+), wallDark: ([\d.]+), baseDarken: ([\d.]+), massDarken: ([\d.]+)/);
  assert.ok(t, '35I の壁の設定が読めない');
  assert.equal(+t[1], 0.96, 'wallLit');
  assert.equal(+t[2], 0.81, 'wallDark');
  assert.equal(+t[3], 0.83, 'baseDarken');
  assert.equal(+t[4], 0.07, 'massDarken');
  const l = prod.match(/'35I': \{[\s\S]*?STANDARD: \{ exposure: ([\d.]+), hemi: ([\d.]+), sun: ([\d.]+), fill: ([\d.]+) \}/);
  assert.ok(l, '35I の光の設定が読めない');
  assert.equal(+l[1], EXPECTED.light.exposure);
  assert.equal(+l[2], EXPECTED.light.hemi);
  assert.equal(+l[3], EXPECTED.light.sun);
  assert.equal(+l[4], EXPECTED.light.fill);
  assert.match(prod, /const CR_FILL_COLOR_DEPTH = 0xc6ced6;/);
});

test('35J 実効の壁倍率が 0.96 / 0.885 / 0.81', () => {
  // 定数の見た目ではなく、production の式を実際に呼んで確かめる。
  const s = prod.indexOf('const SUN_AZ_DEG = 236, SUN_EL_DEG = 47;');
  const e = prod.indexOf('const shadeByte =', s);
  assert.ok(s > 0 && e > s, '明暗の式が読めない');
  // eslint-disable-next-line no-new-func
  const S = new Function(prod.slice(s, prod.indexOf('\n', e) + 1)
    + ' ; return { CR_SUN_H, CR_DEPTH, wallShade, heightShade };')();
  const h = S.CR_SUN_H;
  assert.equal(+S.wallShade(h.x, h.z).toFixed(3), EXPECTED.wall.lit);
  assert.equal(+S.wallShade(-h.z, h.x).toFixed(3), EXPECTED.wall.side);
  assert.equal(+S.wallShade(-h.x, -h.z).toFixed(3), EXPECTED.wall.dark);
  // §2 接地 30m ≈ 0.815 / 180m ≈ 0.772
  assert.equal(+S.heightShade(0, 30).toFixed(3), 0.815);
  assert.equal(+S.heightShade(0, 180).toFixed(3), 0.772);
  assert.equal(+S.heightShade(30, 30).toFixed(6), 1);
});

// ── §3 35G の状態を保つ ────────────────────────────────────────────────
test('35J 建物は 618,749（V4 のまま）', () => {
  assert.match(prod, /let buildingsVersion = 'V4';/);
  const pl = rj(M('derived-v4-final', 'building-placement', 'manifest.json'));
  if (pl) assert.equal(pl.canonicalBuildingCount, BUILDING_COUNT);
  assert.equal(BUILDING_COUNT, 618749);
  assert.equal(PLATEAU_BUILDING_COUNT + V4_FALLBACK_COUNT, BUILDING_COUNT);
});

test('35J roads / rail / stations / water / parks を変更していない', () => {
  const want = { roads: CANONICAL_ROAD_FEATURE_COUNT, rail: CANONICAL_RAIL_FEATURE_COUNT,
    water: CANONICAL_WATER_FEATURE_COUNT, parks: CANONICAL_PARKS_FEATURE_COUNT };
  for (const [k, v] of Object.entries(want)) {
    const m = rj(M('derived', 'near', k, 'manifest.json'));
    if (m) assert.equal(m.featureCount, v, k);
  }
  const st = rj(M('derived', 'rail-stations.json'));
  if (st) assert.equal(st.count, CANONICAL_STATION_COUNT);
});

test('35J cutover で配信データが 1 つも動いていない', { skip: skip('production-cutover-snapshot-post.json') }, () => {
  const a = rpt('production-cutover-snapshot-pre.json');
  const b = rpt('production-cutover-snapshot-post.json');
  if (!a) return;
  // 見た目だけを変えたので、読むデータは前後で完全に同じ
  assert.deepEqual(b.productionData, a.productionData, 'cutover で配信データが動いている');
  // 変わったのは HTML の中身（visual）だけ
  assert.equal(a.production.buildingsVersion, 'V4');
  assert.equal(b.production.buildingsVersion, 'V4');
  assert.equal(a.production.hasVisualDepth, false, 'cutover 前に既に visual depth が入っている');
  assert.equal(b.production.hasVisualDepth, true, 'cutover 後に visual depth が入っていない');
  assert.equal(b.production.depthTuning, '35I');
  assert.notEqual(a.production.sha256, b.production.sha256);
  // protected は前後で同じ
  assert.equal(a.protectedHtml.sha256, b.protectedHtml.sha256);
});

// ── §4 geometry を触っていない ─────────────────────────────────────────
test('35J LOD1 の押し出し式と shadow の方針が変わっていない', () => {
  assert.ok(prod.includes('positions.push(a[0], 0, a[1], b[0], 0, b[1], b[0], h, b[1]);'));
  assert.ok(prod.includes('positions.push(a[0], 0, a[1], b[0], h, b[1], a[0], h, a[1]);'));
  assert.ok(prod.includes('positions.push(v.x, h, v.y);'));
  // 618,749 棟に dynamic shadow は掛けない
  assert.ok(prod.includes('m.castShadow = false; m.receiveShadow = false;'));
});

// ── §5 開発用 UI は production に出さない ──────────────────────────────
test('35J 開発用の切替は production で隠れる', () => {
  for (const id of ['visual-tuning-toggle', 'visual-profile-toggle', 'visual-light-toggle']) {
    assert.ok(DEV_ONLY_IDS.includes(id), id + ' を見ていない');
  }
  assert.deepEqual(devUiIsGated(DEV_ONLY_IDS, prod), { ok: true });
  assert.ok(PRODUCTION_UI_IDS.includes('lc-topbar') && PRODUCTION_UI_IDS.includes('search-input'));
  // CURRENT / 35H へ戻す入口はコード上に残るが、既定ではない
  assert.match(prod, /let visualProfile = 'DEPTH';/);
  assert.match(prod, /let depthTuning = '35I';/);
});

// ── §11 ビルドの作り方 ─────────────────────────────────────────────────
test('35J production は dev からプロファイル 1 行だけの変換', () => {
  // cutover した直後なので、この条件が成り立つ。
  assert.deepEqual(productionIsDevWithProfileOnly(), { ok: true });
  const build = rpt('production-cutover-build.json');
  assert.ok(build && build.productionSha256);
  assert.equal(build.source, 'public/osaka_3d_buildings.ward-ux-v1.html');
  assert.deepEqual(build.transform, [{
    from: "const LIVECITY_BUILD_PROFILE = 'development';",
    to: "const LIVECITY_BUILD_PROFILE = 'production';", count: 1,
  }]);
  assert.deepEqual(productionMatchesBuildRecord(build.productionSha256),
    { ok: true, now: sha256(PROD), expected: build.productionSha256 });
  assert.match(prod, /const LIVECITY_BUILD_PROFILE = 'production';/);
});

test('35J protected は 1 バイトも変えていない', () => {
  const base = rpt('baselines/prod-protected-hashes.json');
  assert.ok(base && base.prot, 'protected の基準 hash が無い');
  assert.equal(sha256(PROT), base.prot, 'protected HTML が変更されている');
  // protected に 35H/35I の visual は入らない
  const p = fs.readFileSync(PROT, 'utf-8');
  assert.ok(!/DEPTH_TUNINGS|CR_FILL_COLOR_DEPTH|CR_DEPTH/.test(p), 'protected に visual depth が入っている');
});

// ── QA の作り ───────────────────────────────────────────────────────────
test('35J §6 の地点が揃い、主要 3 地点は 4 方向以上', () => {
  for (const need of ['umeda', 'honmachi', 'namba', 'shin-osaka', 'higashiyodogawa']) {
    assert.ok(SITES.some((s) => s.id === need), need + ' が無い');
  }
  for (const id of ['umeda', 'honmachi', 'namba']) {
    const s = SITES.find((x) => x.id === id);
    assert.ok(s.dirs.length >= 4, id + ' が ' + s.dirs.length + ' 方向しかない');
  }
  // §13 本町は 35H で暗かった方向（南向き = 180°）を含める
  assert.ok(SITES.find((s) => s.id === 'honmachi').dirs.includes(180), '本町に南向きが無い');
  // 地点は区の中（区外だと建物タイルが読まれない）
  const wards = (rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'boundaries',
    'ward-classification-polygons.json')) || {}).wards;
  if (!wards) return;
  for (const s of SITES) {
    const w = worldOf(s);
    const r = classifyPointToWard(w.x, w.z, wards);
    assert.ok(r && r.wardId, s.id + ' が区ポリゴンの外にある');
  }
});

// ── 実測 ────────────────────────────────────────────────────────────────
test('35J 実測: production が 35I の見た目で動いている', { skip: skip('visual-production-qa.json') }, () => {
  const q = rpt('visual-production-qa.json');
  const s = q.summary;
  assert.equal(s.visualMatches35I, true, JSON.stringify(s.visual));
  assert.equal(s.buildProfile, 'production');
  assert.equal(s.buildingsVersion, 'V4');
  assert.equal(s.devUiHidden, true, JSON.stringify({ visible: s.devUiVisible, missing: s.productionUiMissing }));
  // 全 LOD1 mesh に明暗が入っている
  assert.equal(s.lod1AllShaded, true, `${s.regression.lod1Shaded}/${s.regression.lod1Meshes}`);
});

test('35J 実測: 方向 QA（§7）', { skip: skip('visual-production-qa.json') }, () => {
  const q = rpt('visual-production-qa.json');
  const s = q.summary;
  assert.equal(s.darkFacingViewStillReadable, true, '最暗 ' + s.darkestSceneLuma);
  assert.ok(s.darkestSceneLuma >= MIN_SCENE_LUMA);
  assert.equal(s.brightFacingViewNotWashedOut, true, '白飛び ' + s.maxClippedFraction);
  assert.ok(s.maxClippedFraction <= MAX_CLIPPED_FRACTION);
  assert.equal(s.buildingColorRetained, true, '彩度 ' + s.minBuildingSaturation);
  assert.equal(s.contactDepthRetained, true);
  assert.equal(s.highRiseMassRetained, true);
});

test('35J 実測: 回帰と性能（§8/§9）', { skip: skip('visual-production-qa.json') }, () => {
  const q = rpt('visual-production-qa.json');
  const s = q.summary;
  assert.equal(s.regressionOk, true, JSON.stringify(s.regression));
  assert.equal(s.jsErrors, 0);
  // 高 LOD / HD ランドマークが描かれている
  assert.ok(s.regression.highLodMeshes > 0, '高 LOD が出ていない');
  // §9 dev（35I）の実測と合理的な誤差範囲
  const dev = rpt('directional-balance-qa.json');
  if (dev && dev.summary.perf && s.perf.umeda) {
    const devFps = dev.summary.perf.new.fpsAverage;
    const diff = Math.abs(devFps - s.perf.umeda.fps) / devFps * 100;
    assert.ok(diff <= FPS_DIFF_BUDGET_PCT, `梅田の FPS が dev ${devFps} と production ${s.perf.umeda.fps} で ${diff.toFixed(1)}% 違う`);
  }
});

test('35J 実測: validator が PASS', { skip: skip('visual-production-cutover-validation.json') }, () => {
  const v = rpt('visual-production-cutover-validation.json');
  assert.equal(v.buildingCount, BUILDING_COUNT);
  assert.equal(v.canonicalGeometryMutation, 0);
  assert.equal(v.canonicalIdMutation, 0);
  assert.equal(v.projectionMutation, 0);
  assert.equal(v.placementMutation, 0);
  assert.equal(v.roadMutation, 0);
  assert.equal(v.railMutation, 0);
  assert.equal(v.waterMutation, 0);
  assert.equal(v.parkMutation, 0);
  assert.equal(v.protectedModified, false);
  assert.equal(v.dataUnchanged, true);
  assert.equal(v.lod1GeometryUnchanged, true);
  assert.equal(v.classification, 'LIVE_CITY_VISUAL_35I_PRODUCTION_SUCCESS', JSON.stringify(v.errors));
});
