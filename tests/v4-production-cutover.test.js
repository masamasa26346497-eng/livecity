// tests/v4-production-cutover.test.js
// [Mission 35G] Building V4 の production 昇格。
//   - production は dev から「ビルドプロファイル 1 行」だけ変えたもの
//   - 既存 canonicalId / PLATEAU geometry は不変、足したのは 35D の 17,985 棟だけ
//   - V4 namespace に building-facts があること（無いと card の高さ・階数が全棟で消える）
//   - 復旧済みレイヤー（35E/35F）は production と共有で、状態が保たれている
//   - protected は不変
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ITEMS, buildingsVersionOf, mapDataPaths } from '../tools/audit/production-shared-data-inventory.js';
import { htmlState, dataState } from '../tools/audit/production-cutover-snapshot.js';
import { NAMESPACES, dirsFor, factOf, HEIGHT_BASIS } from '../tools/build-building-source-facts.js';
import {
  PRODUCTION_BUILDING_COUNT_AFTER, PRODUCTION_BUILDING_COUNT_BEFORE,
  RECOVERED_BUILDINGS, PLATEAU_BUILDING_COUNT,
} from '../tools/validate/v4-production-cutover.js';
import { SITES, PERF_SITES, DEV_ONLY_IDS, PRODUCTION_UI_IDS, BRILLIA, worldOf } from '../tools/audit/v4-production-qa.js';
import {
  CANONICAL_ROAD_FEATURE_COUNT, CANONICAL_RAIL_FEATURE_COUNT, CANONICAL_WATER_FEATURE_COUNT,
  CANONICAL_PARKS_FEATURE_COUNT, CANONICAL_STATION_COUNT,
} from '../tools/lib/canonical-baseline.js';
import { classifyPointToWard } from '../tools/lib/point-in-polygon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const M = (...s) => path.join(ROOT, 'public', 'map-data', 'osaka-city', ...s);

// ── §12 production の状態 ───────────────────────────────────────────────
test('35G production は V4 / build profile は production', () => {
  const h = fs.readFileSync(PROD, 'utf-8');
  assert.equal(buildingsVersionOf(h), 'V4');
  assert.match(h, /const LIVECITY_BUILD_PROFILE = 'production';/);
  assert.ok(!h.includes("const LIVECITY_BUILD_PROFILE = 'development';"), 'development 行が残っている');
  const pl = rj(M('derived-v4-final', 'building-placement', 'manifest.json'));
  if (pl) assert.equal(pl.canonicalBuildingCount, PRODUCTION_BUILDING_COUNT_AFTER);
});

test('35G production は自分のビルド記録と一致する（cutover 後に手で触っていない）', () => {
  // 35G の cutover 直後は dev と production が 1 行違いで一致していた。
  //   [Mission 35H] 以降のミッションが dev を進めるとその一致は崩れる（それが正常）。
  //   常時守れるのは「production が自分のビルド成果物のままであること」。
  const build = rpt('production-cutover-build.json');
  assert.ok(build && build.productionSha256, 'ビルド記録が無い');
  assert.equal(sha(PROD), build.productionSha256, 'production HTML が手で書き換えられている');
  assert.equal(build.source, 'public/osaka_3d_buildings.ward-ux-v1.html');
  assert.deepEqual(build.transform, [{
    from: "const LIVECITY_BUILD_PROFILE = 'development';",
    to: "const LIVECITY_BUILD_PROFILE = 'production';", count: 1,
  }], '変換が 1 行だけでない');
  // dev 側の行は 1 個だけ（2 個あると置換が壊れる）
  const dev = fs.readFileSync(DEV, 'utf-8');
  assert.equal(dev.split("const LIVECITY_BUILD_PROFILE = 'development';").length - 1, 1);
});

test('35G 建物数の前後', () => {
  assert.equal(PRODUCTION_BUILDING_COUNT_BEFORE, 600764);
  assert.equal(PRODUCTION_BUILDING_COUNT_AFTER, 618749);
  assert.equal(PRODUCTION_BUILDING_COUNT_AFTER - PRODUCTION_BUILDING_COUNT_BEFORE, RECOVERED_BUILDINGS);
  assert.equal(RECOVERED_BUILDINGS, 17985);
});

// ── §4 building-facts ───────────────────────────────────────────────────
test('35G facts は建物 namespace ごとに要る', () => {
  // card は getBuildingDataBase() の下の building-facts を読むので、
  //   V4 へ切り替えたのに V4 の facts が無いと高さ・階数が全棟で消える。
  assert.deepEqual(Object.keys(NAMESPACES).sort(), ['V2N', 'V4']);
  assert.match(dirsFor('V4').outDirs[1], /derived-v4-final[\\/]building-facts$/);
  assert.match(dirsFor('V2N').outDirs[1], /derived-v2-osmv2[\\/]building-facts$/);
  assert.throws(() => dirsFor('V9'), /知らない namespace/);
  for (const ns of ['V2N', 'V4']) {
    const d = M(NAMESPACES[ns].derived, 'building-facts');
    if (!fs.existsSync(d)) continue;
    const n = fs.readdirSync(d).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f)).length;
    assert.ok(n > 900, ns + ' の facts tile が ' + n + ' 枚しかない');
  }
});

test('35G facts の判定規則は 32S のまま', () => {
  // 高さの根拠は「measuredHeight > LOD 形状 > 階数換算 > 根拠なし」の順で決まる。
  assert.equal(factOf({ source: 'plateau-building', heightM: 45 }, { m: 45.2, s: 14 }).basis, HEIGHT_BASIS.measured);
  assert.equal(factOf({ source: 'plateau-building', heightM: 45 }, { m: 45.2, s: 14 }).storeys, 14);
  assert.equal(factOf({ source: 'plateau-building', heightM: 15 }, { s: 5 }).basis, HEIGHT_BASIS.storeys);
  assert.equal(factOf({ source: 'plateau-building', heightM: 3 }, { s: 0 }).basis, HEIGHT_BASIS.none);
  assert.equal(factOf({ source: 'plateau-building', heightM: 12.4 }, { s: 0 }).basis, HEIGHT_BASIS.geometry);
  assert.equal(factOf({ source: 'osm-building' }, null).basis, HEIGHT_BASIS.osmTag);
  assert.equal(factOf({ source: 'osm-building', heightUnknown: true }, null).basis, HEIGHT_BASIS.none);
  // センチネルは階数として採らない
  assert.equal(factOf({ source: 'plateau-building', heightM: 45 }, { m: 45.2, s: 9999 }).storeys, 0);
});

test('35G 実測: V4 の facts は PLATEAU 部分が V2N と同じ', { skip: skip('building-source-facts-v4.json') }, () => {
  const a = rpt('building-source-facts.json'), b = rpt('building-source-facts-v4.json');
  if (!a) return;
  assert.equal(b.stat.plateau, a.stat.plateau, 'PLATEAU の棟数が変わっている');
  assert.equal(b.stat.plateau, PLATEAU_BUILDING_COUNT);
  assert.equal(b.stat.osm - a.stat.osm, RECOVERED_BUILDINGS, '増えた OSM が 35D の棟数と違う');
  assert.equal(b.stat.buildings, PRODUCTION_BUILDING_COUNT_AFTER);
  // 実測値そのものは PLATEAU 側で一致する（判定規則を変えていない証拠）
  assert.equal(b.stat.byBasis['1'], a.stat.byBasis['1'], 'measuredHeight の件数が変わっている');
  assert.equal(b.stat.withStoreys, a.stat.withStoreys, '階数を持つ棟数が変わっている');
});

// ── §2 共有データの一覧 ─────────────────────────────────────────────────
test('35G §2 が名指しした項目をすべて見ている', () => {
  const ids = ITEMS.map((i) => i.id);
  for (const need of ['buildings', 'roads', 'rail', 'stations', 'water', 'parks',
    'place-labels', 'building-facts', 'placement', 'highLOD']) {
    assert.ok(ids.includes(need), need + ' を見ていない');
  }
});

test('35G HTML から map-data のパスと建物版を読む', () => {
  const h = "x fetch('map-data/osaka-city/derived/near/roads/tile_1_2.json') "
    + "let buildingsVersion = 'V4'; 'map-data/osaka-city/labels/station-labels.json'";
  assert.equal(buildingsVersionOf(h), 'V4');
  const p = mapDataPaths(h);
  assert.ok(p.includes('map-data/osaka-city/derived/near/roads'), 'tile 名を落としていない');
  assert.ok(p.includes('map-data/osaka-city/labels/station-labels.json'));
  assert.equal(buildingsVersionOf('なにも無い'), null);
});

test('35G 実測: 復旧済みレイヤーは production と共有', { skip: skip('production-shared-data-inventory.json') }, () => {
  const inv = rpt('production-shared-data-inventory.json');
  // 35E/35F で作り直した derived は production も読む。
  //   「production は未変更」と書いてはいけない根拠がこれ。
  for (const id of ['roads', 'rail', 'stations', 'water', 'parks', 'place-labels']) {
    const r = inv.items.find((x) => x.id === id);
    assert.equal(r.sharing, 'shared', id + ' が共有になっていない');
    assert.equal(r.devCount, r.productionCount, id + ' の件数が dev と production で違う');
  }
  // 建物だけ namespace で分かれる
  assert.match(inv.items.find((x) => x.id === 'buildings').sharing, /^(shared|separate)/);
});

// ── §3/§12 前後の記録 ───────────────────────────────────────────────────
test('35G snapshot は前後で同じ項目を読む', () => {
  const s = htmlState(PROD);
  assert.ok(s && s.sha256 && s.bytes > 0);
  assert.equal(s.buildProfile, 'production');
  assert.equal(s.buildingsVersion, 'V4');
  const d = dataState('V4');
  assert.equal(d.buildingNamespace, 'derived-v4-final');
  for (const k of ['roads', 'rail', 'stations', 'water', 'parks', 'placeLabels']) {
    assert.ok(d[k] != null, k + ' を読めていない');
  }
  assert.equal(htmlState(path.join(ROOT, 'no-such-file.html')), null);
});

test('35G 実測: cutover の前後で変わったのは建物だけ', { skip: skip('production-cutover-snapshot-35g-post.json') }, () => {
  // [Mission 35J] `-pre/-post` の generic な 1 枠は次の cutover が上書きする。
  //   35G の記録はミッション名付きのファイルを見る。
  const pre = rpt('production-cutover-snapshot-35g-pre.json');
  const post = rpt('production-cutover-snapshot-35g-post.json');
  if (!pre) return;
  assert.equal(pre.productionData.buildingCount, PRODUCTION_BUILDING_COUNT_BEFORE);
  assert.equal(post.productionData.buildingCount, PRODUCTION_BUILDING_COUNT_AFTER);
  assert.equal(pre.production.buildingsVersion, 'V2N');
  assert.equal(post.production.buildingsVersion, 'V4');
  // 建物以外は前後で同じ（共有データなので cutover では動かない）
  for (const k of ['roads', 'rail', 'stations', 'water', 'parks', 'placeLabels', 'highLodBuildings', 'refinedRoadSurface']) {
    assert.equal(post.productionData[k], pre.productionData[k], k + ' が cutover で動いている');
  }
  assert.equal(post.production.buildProfile, 'production');
  assert.equal(pre.protectedHtml.sha256, post.protectedHtml.sha256, 'protected が変わっている');
});

// ── §6 復旧済みレイヤー ─────────────────────────────────────────────────
test('35G 復旧済みレイヤーが 35F の状態のまま', () => {
  const want = { roads: CANONICAL_ROAD_FEATURE_COUNT, rail: CANONICAL_RAIL_FEATURE_COUNT,
    water: CANONICAL_WATER_FEATURE_COUNT, parks: CANONICAL_PARKS_FEATURE_COUNT };
  for (const [k, v] of Object.entries(want)) {
    const m = rj(M('derived', 'near', k === 'roads' ? 'roads' : k, 'manifest.json'));
    if (m) assert.equal(m.featureCount, v, k + ' が 35F の状態でない');
  }
  const st = rj(M('derived', 'rail-stations.json'));
  if (st) assert.equal(st.count, CANONICAL_STATION_COUNT);
});

// ── §5/§7 QA の作り ─────────────────────────────────────────────────────
test('35G §7 の 12 地点が揃っていて、全部が区の中にある', () => {
  assert.equal(SITES.length, 12);
  for (const need of ['umeda', 'nakanoshima', 'honmachi', 'namba', 'tennoji', 'shin-osaka',
    'higashi-mikuni', 'awaji', 'kami-shinjo', 'juso', 'kunijima', 'asahi']) {
    assert.ok(SITES.some((s) => s.id === need), need + ' が無い');
  }
  // 区の外の点だと建物タイルが読まれず「建物 0%」に見える（35F で踏んだ罠）
  const wards = (rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'boundaries',
    'ward-classification-polygons.json')) || {}).wards;
  if (!wards) return;
  for (const s of [...SITES, BRILLIA]) {
    const w = worldOf(s);
    const r = classifyPointToWard(w.x, w.z, wards);
    assert.ok(r && r.wardId, s.id + ' が区ポリゴンの外にある');
    assert.equal(r.wardId, s.ward, s.id + ' の区が ' + r.wardId);
  }
});

test('35G 性能は 35F dev と同じ地点で測る', () => {
  assert.deepEqual(PERF_SITES.map((s) => s.id).sort(),
    ['higashiyodogawa', 'shin-osaka', 'umeda', 'yodogawa']);
});

test('35G 隠すべき開発用 UI を列挙している', () => {
  for (const need of ['canonical-runtime-status', 'max-lod-qa-toggle', 'inferred-roof-toggle',
    'landmark-hd-toggle', 'missing-recovery-toggle', 'lod-view-toggle']) {
    assert.ok(DEV_ONLY_IDS.includes(need), need + ' を見ていない');
  }
  assert.ok(PRODUCTION_UI_IDS.includes('lc-topbar') && PRODUCTION_UI_IDS.includes('search-input'));
});

test('35G 32U 以降に増えた開発用 UI も production で隠れる', () => {
  // production CSS は [id^="canonical-runtime-"] でまとめて隠す。
  //   新しいトグルはこの箱の中に入れる約束。外に置くと production に出てしまう。
  const h = fs.readFileSync(PROD, 'utf-8');
  assert.match(h, /html\[data-livecity-build="production"\] \[id\^="canonical-runtime-"\]\{display:none !important\}/);
  const boxIdx = h.indexOf("roadV2Box.id = 'canonical-runtime-road-v2-controls'");
  assert.ok(boxIdx > 0, '開発用トグルの箱が無い');
  for (const id of ['max-lod-qa-toggle', 'inferred-roof-toggle', 'landmark-hd-toggle',
    'missing-recovery-toggle', 'lod-view-toggle', 'coverage-qa-toggle']) {
    const at = h.indexOf("id = '" + id + "'");
    assert.ok(at > boxIdx, id + ' が canonical-runtime- の箱の外にある');
  }
});

// ── §11 protected ───────────────────────────────────────────────────────
test('35G protected は不変', () => {
  const base = rj(path.join(ROOT, 'data', 'reports', 'baselines', 'prod-protected-hashes.json'));
  if (base && base.prot) assert.equal(sha(PROT), base.prot, 'protected HTML が変更されている');
});

// ── 実測 ────────────────────────────────────────────────────────────────
test('35G 実測: 既存 canonicalId も PLATEAU geometry も失われていない',
  { skip: skip('v4-production-cutover-validation.json') }, () => {
    const v = rpt('v4-production-cutover-validation.json');
    assert.equal(v.existingCanonicalIdLoss, 0);
    assert.equal(v.canonicalPlateauGeometryMutation, 0);
    assert.equal(v.projectionMutation, false);
    assert.equal(v.roadV3LogicMutation, false);
    assert.equal(v.duplicateBuildingIncrease, 0);
    assert.equal(v.duplicateRailIncrease, 0);
    assert.equal(v.duplicateWaterIncrease, 0);
    assert.equal(v.duplicateParkIncrease, 0);
    assert.equal(v.protectedModified, false);
    assert.equal(v.productionMatchesDev, true);
    assert.equal(v.recoveredLayersPreserved, true);
    assert.ok(v.setCompare.added === RECOVERED_BUILDINGS, '足した棟数が ' + v.setCompare.added);
    assert.equal(v.setCompare.oldIds, PRODUCTION_BUILDING_COUNT_BEFORE);
    assert.equal(v.setCompare.newIds, PRODUCTION_BUILDING_COUNT_AFTER);
    assert.equal(v.classification, 'CITYWIDE_V4_PRODUCTION_CUTOVER_SUCCESS', JSON.stringify(v.errors));
  });

test('35G 実測: production を実ブラウザで確認できている',
  { skip: skip('v4-production-qa.json') }, () => {
    const q = rpt('v4-production-qa.json');
    const s = q.summary;
    assert.equal(s.buildingsVersion, 'V4');
    assert.equal(s.buildProfile, 'production');
    assert.equal(s.sites, 12);
    assert.equal(s.allSitesHaveBuildings, true);
    assert.equal(s.allSitesHaveRoads, true);
    assert.equal(s.allSitesCardOk, true);
    assert.equal(s.devUiHidden, true, JSON.stringify({ visible: s.devUiVisible, missing: s.productionUiMissing }));
    assert.equal(s.regressionOk, true, JSON.stringify(s.regression));
    assert.equal(s.brilliaOk, true);
    assert.equal(s.jsErrors, 0);
    // §4 facts が読めていれば高さが出る
    assert.ok(s.sitesWithHeight > 0, 'card に高さが 1 地点も出ていない');
    assert.equal(s.factsFailedTiles, 0, 'facts tile の取得に失敗している');
    // §11 古い建物 namespace を読んでいないこと
    assert.equal(q.fetchAudit.v1Buildings, 0);
    assert.ok(q.fetchAudit.v4 > 0, 'V4 を 1 度も読んでいない');
    assert.equal(q.fetchAudit.v2n, 0, 'V2N の建物を読んでいる');
    assert.ok(q.fetchAudit.v2nHighLod > 0, '高 LOD は V2N 固定パスなので読むはず');
  });
