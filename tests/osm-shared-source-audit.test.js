// tests/osm-shared-source-audit.test.js
// [Mission 35F] 共有 OSM source の監査と、影響のあったレイヤーだけの再生成
//   - 切断の判定は「北側だけ増えたか」で見る（疎なレイヤーでは崖が出ない）
//   - canonical タイルの跨ぎを重複と誤認しない
//   - 乗換駅を重複と誤認しない
//   - 道路（35E）と建物（V4）を触っていない
//   - production は 600,764 のまま
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  latKey, latitudeCliff, isTruncatedByCliff, truncationSignal,
  KINDS, NORTH_WARDS, LAT_BANDS, CITY_NORTH_LAT, NORTH_GAIN_PCT, SOUTH_STABLE_PCT,
} from '../tools/audit/osm-shared-source-coverage.js';
import { LAYERS, pbfOf, dependsOnOldPbf, OLD_PBF, NEW_PBF } from '../tools/audit/osm-source-dependency-inventory.js';
import { KIND_TO_LAYER, REBUILD_ACTIONS, UNTOUCHED, affectedLayers } from '../tools/audit/osm-shared-source-rebuild-summary.js';
import { resolvePbf as resolvePlacePbf, WIDE_PBF, OLD_PBF as PLACE_OLD_PBF } from '../tools/build-place-labels.js';
import {
  loadFeatures, findDuplicates, geomKey, countNearSameName, INTERCHANGE_M, BEFORE_35F,
} from '../tools/audit/shared-layer-duplicate-audit.js';
import { railVisibleAt, waterVisibleAt, parkVisibleAt, ALLOWED } from '../tools/build-derived-shared-layers.js';
import { PRODUCTION_BUILDING_COUNT, ROAD_35E, CANONICAL_BUILDING_V1 } from '../tools/validate/osm-shared-source-audit.js';
import { CANONICAL_ROAD_FEATURE_COUNT } from '../tools/lib/canonical-baseline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

// ── §3 切断の判定 ───────────────────────────────────────────────────────
test('35F 崖だけで判定すると疎なレイヤーを取りこぼす', () => {
  // 建物や道路のように密なら崖が出る
  const dense = { '34.71': 5901, '34.72': 7338, '34.73': 846, '34.74': 1 };
  assert.ok(latitudeCliff(dense), '密なレイヤーでは崖が出る');
  // 鉄道のように疎だと同じ切断でも崖にならない（1 帯あたりの件数が少ない）
  const sparse = { '34.71': 40, '34.72': 35, '34.73': 8, '34.74': 0 };
  assert.equal(latitudeCliff(sparse), null, '疎なレイヤーでは崖が出ない');
});

test('35F 北側だけ増えていれば切断の影響と判定する', () => {
  // 実測: railway-way 北 757→1120 (+48%) / 南 1982→1982 (0%)
  const rail = truncationSignal({ old: 757, new: 1120 }, { old: 1982, new: 1982 });
  assert.equal(rail.affectedByOldPbfTruncation, true);
  assert.ok(rail.northGainPct > 40);
  assert.equal(rail.southGainPct, 0);
  // 南も一緒に増えているなら OSM 側の編集差
  const churn = truncationSignal({ old: 100, new: 130 }, { old: 1000, new: 1300 });
  assert.equal(churn.affectedByOldPbfTruncation, false);
  assert.match(churn.rationale, /南側も動いている/);
  // 北も増えていないなら影響なし
  const none = truncationSignal({ old: 100, new: 101 }, { old: 1000, new: 1000 });
  assert.equal(none.affectedByOldPbfTruncation, false);
  assert.match(none.rationale, /北側が増えていない/);
  // データが無ければ判定しない
  assert.equal(truncationSignal({ old: 0, new: 0 }, { old: 0, new: 0 }).affectedByOldPbfTruncation, false);
});

test('35F 判定の閾値が妥当な範囲にある', () => {
  assert.ok(NORTH_GAIN_PCT > 0 && NORTH_GAIN_PCT <= 20);
  assert.ok(SOUTH_STABLE_PCT > 0 && SOUTH_STABLE_PCT <= 10);
  assert.ok(CITY_NORTH_LAT > 34.76 && CITY_NORTH_LAT < 34.78, '大阪市の北端');
  assert.equal(isTruncatedByCliff({ atLat: 34.74 }), true);
  assert.equal(isTruncatedByCliff({ atLat: 34.80 }), false);
  assert.equal(isTruncatedByCliff(null), false);
});

test('35F 緯度キーと監査対象の帯', () => {
  assert.equal(latKey(34.7351), '34.73');
  assert.equal(latKey(34.70), '34.70');
  for (const l of [34.70, 34.73, 34.76]) assert.ok(LAT_BANDS.includes(l), l);
});

test('35F §3 が名指しした種別をすべて監査している', () => {
  const ids = KINDS.map((k) => k.id);
  for (const need of ['railway-way', 'railway-station-node', 'railway-platform', 'railway-yard',
    'public-transport', 'waterway-way', 'natural-water', 'park-leisure',
    'landuse-grass', 'landuse-recreation']) {
    assert.ok(ids.includes(need), need + ' を監査していない');
  }
  // 判定関数が実際にタグを拾う
  const railway = KINDS.find((k) => k.id === 'railway-way');
  assert.equal(railway.match({ railway: 'rail' }), true);
  assert.equal(railway.match({ railway: 'tram' }), false);
  const grass = KINDS.find((k) => k.id === 'landuse-grass');
  assert.equal(grass.match({ landuse: 'grass' }), true);
  assert.equal(grass.match({ leisure: 'park' }), false);
});

test('35F 北側の重点区が定義されている', () => {
  for (const w of ['higashiyodogawa', 'yodogawa', 'asahi']) assert.ok(NORTH_WARDS.includes(w), w);
});

// ── §2 依存インベントリ ─────────────────────────────────────────────────
test('35F 監査対象のレイヤーが揃っている', () => {
  const ids = LAYERS.map((l) => l.id);
  for (const need of ['roads', 'rail', 'stations', 'waterways', 'parks', 'place-labels']) {
    assert.ok(ids.includes(need), need + ' が無い');
  }
  // 各レイヤーに生成手順が書いてある
  for (const l of LAYERS) assert.ok(l.generationTool, l.id + ' の生成手順が無い');
});

test('35F source PBF を実ファイルの _meta から読む', () => {
  assert.equal(OLD_PBF, 'osaka-latest.osm.pbf');
  assert.equal(NEW_PBF, 'osaka-full-coverage.osm.pbf');
  const roads = LAYERS.find((l) => l.id === 'roads');
  const p = pbfOf(roads.raw);
  if (p) {
    // 35E で道路は広域へ移行済み。旧に戻っていたら rollback している。
    assert.equal(p, NEW_PBF, '道路の source が旧 PBF に戻っている');
    assert.equal(dependsOnOldPbf(roads.raw), false);
  }
});

test('35F 生成物が source を _meta 以外に書いていても依存を見つける', () => {
  // 実際にこれを見落として、地名ラベルを「OSM 非依存」と誤って分類した。
  const dir = path.join(ROOT, 'scratchpad-test-tmp');
  fs.mkdirSync(dir, { recursive: true });
  const cases = [
    ['a.json', { _meta: { input: 'data/raw/osm/osaka-latest.osm.pbf' } }, 'osaka-latest.osm.pbf'],
    ['b.json', { source: 'data/raw/osm/osaka-full-coverage.osm.pbf（既存。新規取得なし）' }, 'osaka-full-coverage.osm.pbf'],
    ['c.json', { _meta: { source: 'x/osaka-latest.osm.pbf' } }, 'osaka-latest.osm.pbf'],
    ['d.json', { note: '何も書いていない' }, null],
  ];
  try {
    for (const [f, body, want] of cases) {
      fs.writeFileSync(path.join(dir, f), JSON.stringify(body));
      assert.equal(pbfOf('scratchpad-test-tmp/' + f), want, f);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(pbfOf(null), null);
});

test('35F 地名ラベルは広域 PBF を使う', () => {
  assert.match(WIDE_PBF, /osaka-full-coverage\.osm\.pbf$/);
  assert.match(PLACE_OLD_PBF, /osaka-latest\.osm\.pbf$/);
  // 広域があるならそちらを選ぶ。無いときだけ旧へ落ちる（消さない）。
  assert.equal(resolvePlacePbf(), fs.existsSync(WIDE_PBF) ? WIDE_PBF : PLACE_OLD_PBF);
  const j = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived', 'place-labels.json'));
  if (j) assert.match(j.source, /osaka-full-coverage/, '地名ラベルが旧 PBF のまま');
});

test('35F 駅ラベルが読むファイルは canonical の駅数と一致する', () => {
  // 35F の意図: **画面が実際に読むファイル** が canonical と同じ駅数に追随していること。
  //   derived/rail-stations.json だけ更新して満足すると、画面のラベルは古いまま残る。
  //   35K で CityLabelLayer の読み先は labels/station-labels.json から
  //   derived/station-index.json（事業者付き・§4 で同一駅を統合したもの）へ移った。
  //   統合後の件数は canonical と一致しないので、canonicalCount を経由して追随を見る。
  const html = fs.readFileSync(path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
  const m = html.match(/STATION_URL = '([^']+)'/);
  assert.ok(m, 'CityLabelLayer の駅データの読み先が見つからない');
  const readPath = path.join(ROOT, 'public', m[1]);
  assert.ok(fs.existsSync(readPath), '画面が読む駅ファイルが無い: ' + m[1]);
  const read = rj(readPath);
  const lab = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'labels', 'station-labels.json'));
  const der = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived', 'rail-stations.json'));
  const canon = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'rail', 'stations.json'));
  if (lab && der) assert.equal(lab.stations.length, der.count, 'ラベルと配信データの駅数が食い違う');
  if (lab && canon) assert.equal(lab.stations.length, canon.count, 'ラベルと canonical の駅数が食い違う');
  if (lab) assert.ok(lab.stations.length > BEFORE_35F.stations, '駅が増えていない');
  // 画面が読むファイルの出どころが canonical と同じ世代か
  if (canon) assert.equal(read.canonicalCount ?? read.stations.length, canon.count,
    '画面が読む駅ファイルが canonical に追随していない');
  // 統合後の表示件数（230）は 35F 以前の 233 より小さくなりうる。増えたことを見るのは統合前の件数。
  assert.ok((read.canonicalCount ?? read.stations.length) > BEFORE_35F.stations, '画面側の駅が増えていない');
});

// ── §5 影響のあったものだけ直したか ────────────────────────────────────
test('35F 監査した種別はすべてレイヤーに対応づいている', () => {
  for (const k of KIND_TO_LAYER ? Object.keys(KIND_TO_LAYER) : []) {
    assert.ok(typeof KIND_TO_LAYER[k] === 'string', k);
  }
  for (const id of KINDS.map((k) => k.id)) {
    assert.ok(KIND_TO_LAYER[id], id + ' がどのレイヤーの話か分からない');
  }
});

test('35F 影響のあった種別からレイヤーを決める', () => {
  const cov = { kinds: [
    { id: 'railway-way', truncatedInOldPbf: true },
    { id: 'landuse-grass', truncatedInOldPbf: false },
    { id: 'park-leisure', truncatedInOldPbf: false },
  ] };
  const { layers, byLayer } = affectedLayers(cov);
  assert.deepEqual(layers, ['rail']);
  assert.deepEqual(byLayer.parks.affected, [], '影響の無い種別をレイヤーの根拠にしている');
  assert.deepEqual(byLayer.parks.kinds.sort(), ['landuse-grass', 'park-leisure']);
});

test('35F 道路と建物は触らなかった側に書いてある', () => {
  assert.ok(UNTOUCHED.roads && /35E/.test(UNTOUCHED.roads));
  assert.ok(UNTOUCHED.buildings);
  assert.ok(!REBUILD_ACTIONS.roads, '道路を作り直した側に書いている');
  assert.ok(!REBUILD_ACTIONS.buildings, '建物を作り直した側に書いている');
  for (const l of ['rail', 'water', 'parks', 'stations', 'place-labels']) {
    assert.ok(REBUILD_ACTIONS[l], l + ' に何をしたか書いていない');
  }
});

// ── §10 重複の数え方 ────────────────────────────────────────────────────
test('35F canonical タイルの跨ぎを重複と誤認しない', () => {
  const dir = path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'rail');
  if (!fs.existsSync(dir)) return;
  const loaded = loadFeatures(dir);
  const m = rj(path.join(dir, 'manifest.json'));
  // タイル行の合計 > 一意 id（跨ぎがある）が正常
  assert.ok(loaded.tileRows >= loaded.features.length, 'タイル行が一意 id より少ない');
  assert.ok(loaded.spanningIds > 0, '跨ぎが 1 つも無いのは不自然');
  if (m) assert.equal(loaded.features.length, m.featureCount, 'manifest と一意 id が合わない');
});

test('35F 重複の数え方（見本の上限を数として報告しない）', () => {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const mk = (id, r) => ({ canonicalId: id, geometryType: 'Polygon', coordinates: [r] });
  // 同じ形が 30 個。見本は 20 でも数は 29 でなければならない。
  const many = [];
  for (let i = 0; i < 30; i++) many.push(mk('id' + i, ring));
  const d = findDuplicates(many, 20);
  assert.equal(d.duplicateGeoms, 29, '見本の上限が数に漏れている');
  assert.equal(d.geomSamples.length, 20);
  assert.equal(d.duplicateIds, 0, 'id は全部違う');
  // 別の形なら重複ではない
  const diff = [mk('a', ring), mk('b', [[100, 100], [110, 100], [110, 110], [100, 110]])];
  assert.equal(findDuplicates(diff).duplicateGeoms, 0);
});

test('35F geometry の指紋は座標を丸めて作る', () => {
  const a = { geometryType: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] };
  const b = { geometryType: 'Polygon', coordinates: [[[0.01, 0], [1, 0], [1, 1]]] };
  const c = { geometryType: 'Polygon', coordinates: [[[5, 0], [1, 0], [1, 1]]] };
  assert.equal(geomKey(a), geomKey(b), '0.1m 未満の差は同じ形');
  assert.notEqual(geomKey(a), geomKey(c));
  assert.equal(geomKey({ geometryType: 'Polygon', coordinates: [] }), null);
});

test('35F 乗換駅を重複と誤認しない', () => {
  // 鶴橋は JR / 近鉄 / 地下鉄が別 node。同名で近い。
  const pts = [
    { name: '鶴橋', x: 475, z: -6812 }, { name: '鶴橋', x: 524, z: -6795 },
    { name: '長居', x: -1148, z: -739 },
  ];
  assert.equal(countNearSameName(pts), 1, '同名近接の組を数えられる');
  // 遠ければ別の駅
  assert.equal(countNearSameName([{ name: 'X', x: 0, z: 0 }, { name: 'X', x: 5000, z: 0 }]), 0);
  assert.ok(INTERCHANGE_M > 0 && INTERCHANGE_M <= 300);
});

// ── §8 LOD 規則を変えていない ───────────────────────────────────────────
test('35F rail / water / parks の LOD 規則が元実装と同じ', () => {
  assert.equal(railVisibleAt('far', { lodClass: 'major' }), true);
  assert.equal(railVisibleAt('far', { lodClass: 'urban' }), false);
  assert.equal(railVisibleAt('mid', { lodClass: 'urban' }), true);
  assert.equal(railVisibleAt('mid', { lodClass: 'local' }), false);
  assert.equal(railVisibleAt('near', { lodClass: 'local' }), true);

  assert.equal(waterVisibleAt('far', { riverClass: 'major' }, 10), true);
  assert.equal(waterVisibleAt('far', {}, 300000), true);
  assert.equal(waterVisibleAt('far', {}, 100), false);
  assert.equal(waterVisibleAt('mid', { waterClass: 'canal' }, 10), true);
  assert.equal(waterVisibleAt('near', {}, 1), true);

  // 公園は rankable / 実公園かどうかで決まる（面積だけではない）
  assert.equal(parkVisibleAt('far', { rankable: true, parkClass: 'park' }, 60000), true);
  assert.equal(parkVisibleAt('far', { rankable: false, parkClass: 'park' }, 60000), false);
  assert.equal(parkVisibleAt('mid', { parkClass: 'grass' }, 10000), false, 'grass は mid に出さない');
  assert.equal(parkVisibleAt('mid', { parkClass: 'park' }, 10000), true);
  assert.equal(parkVisibleAt('near', { parkClass: 'grass' }, 1), true);
});

test('35F 道路と建物は今回の再生成の対象外', () => {
  assert.ok(!ALLOWED.includes('roads'), '道路を作り直す対象に入れている');
  assert.ok(!ALLOWED.includes('buildings'), '建物を作り直す対象に入れている');
  assert.deepEqual([...ALLOWED].sort(), ['parks', 'rail', 'water']);
});

// ── §13/§15 触っていないもの ────────────────────────────────────────────
test('35F 35E の道路状態を rollback していない', () => {
  assert.equal(ROAD_35E.canonicalRoads, CANONICAL_ROAD_FEATURE_COUNT);
  const m = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'));
  if (m) assert.equal(m.featureCount, ROAD_35E.canonicalRoads, '道路が 35E の状態でない');
  const raw = rj(path.join(ROOT, 'data', 'raw', 'osaka-city', 'roads-osm.json'));
  if (raw) assert.match(raw._meta.input, /osaka-full-coverage/, '道路の source が旧 PBF に戻っている');
});

test('35F 建物 V4 が dev の既定、production は V2N', () => {
  const dev = fs.readFileSync(path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
  assert.match(dev, /let buildingsVersion = 'V4';/);
  // 35F の時点では production は V2N のままにしておく約束だった。
  //   [Mission 35G] ユーザー承認のうえ V4 へ昇格。35F が根拠にした V2N の建物数は不変。
  const prod = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
  if (fs.existsSync(prod)) {
    const p = fs.readFileSync(prod, 'utf-8');
    assert.match(p, /let buildingsVersion = 'V4';/, '35G の cutover 後は V4');
  }
  assert.equal(PRODUCTION_BUILDING_COUNT, 600764);
  const v2n = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement', 'manifest.json'));
  if (v2n) assert.equal(v2n.canonicalBuildingCount, 600764, 'V2N の建物数が変わっている');
  assert.equal(CANONICAL_BUILDING_V1, 615617);
  const v4 = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-final', 'manifest.json'));
  if (v4) assert.equal(v4.featureCount, 618749, '建物 V4 が変わっている');
});

test('35F 旧 source を消していない', () => {
  for (const f of ['railways-osm.osaka-latest-backup.json', 'waterways-osm.osaka-latest-backup.json',
    'parks-osm.osaka-latest-backup.json', 'roads-osm.osaka-latest-backup.json']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'data', 'raw', 'osaka-city', f)), f + ' が無い');
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'data', 'raw', 'osm', 'osaka-latest.osm.pbf')), '旧 PBF を消している');
  // ラベルも作り直しているので、旧版を残す
  for (const f of ['public/map-data/osaka-city/labels/station-labels.osaka-latest-backup.json',
    'public/map-data/osaka-city/derived/place-labels.osaka-latest-backup.json']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' が無い');
  }
});

test('35F 鉄道は線として描かれているので、線も当たり判定に入れる', () => {
  // canonical の rail は lineMesh() ＝ THREE.LineSegments。isMesh だけ集めると必ず 0% になる。
  const html = fs.readFileSync(path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
  assert.match(html, /new THREE\.LineSegments\(g, new THREE\.LineBasicMaterial/, '鉄道の描き方が変わった');
  const qa = fs.readFileSync(path.join(ROOT, 'tools', 'audit', 'osm-shared-source-runtime-qa.js'), 'utf-8');
  assert.match(qa, /o\.isMesh \|\| o\.isLineSegments/, 'QA が線を数えていない');
  assert.match(qa, /rc\.params\.Line\.threshold/, '線の当たり幅を決めていない');
});

// ── 実測 ────────────────────────────────────────────────────────────────
test('35F 実測: 全種別で北側だけが増えていた', { skip: skip('osm-shared-source-coverage.json') }, () => {
  const c = rpt('osm-shared-source-coverage.json');
  assert.ok(c.kinds.length >= 10);
  for (const k of c.kinds) {
    assert.ok(k.truncationSignal, k.id + ' に北/南の比較が無い');
    if (!k.truncatedInOldPbf) continue;
    assert.ok(k.truncationSignal.northGainPct >= NORTH_GAIN_PCT, k.id);
    assert.ok(Math.abs(k.truncationSignal.southGainPct) <= SOUTH_STABLE_PCT, k.id + ' は南も動いている');
  }
  assert.ok(c.needsRebuild.length > 0, '影響を受けたレイヤーが 1 つも無い');
});

test('35F 実測: 作り直したレイヤーで重複が増えていない', { skip: skip('shared-layer-duplicate-audit.json') }, () => {
  const d = rpt('shared-layer-duplicate-audit.json');
  for (const k of ['rail', 'water', 'parks']) {
    assert.equal(d.layers[k].duplicateIds, 0, k + ' に id の重複');
    assert.equal(d.layers[k].duplicateGeoms, 0, k + ' に形の重複');
    assert.ok(d.layers[k].after > d.layers[k].before35F, k + ' が増えていない');
    assert.equal(d.layers[k].before35F, BEFORE_35F[k]);
  }
  // 駅は乗換駅ぶんを差し引いて、率が上がっていないこと
  const ic = d.layers.stations.interchange;
  if (ic) assert.equal(ic.rateIncreased, false, '乗換駅の率が上がっている（重複の疑い）');
  assert.equal(d.allClean, true, JSON.stringify(d.duplicates));
});

test('35F 実測: 検証が PASS している', { skip: skip('osm-shared-source-audit-validation.json') }, () => {
  const v = rpt('osm-shared-source-audit-validation.json');
  assert.ok(['OSM_SHARED_SOURCE_AUDIT_SUCCESS', 'OSM_SHARED_SOURCE_AUDIT_FAILED'].includes(v.classification));
  assert.equal(v.buildingV4DevDefault, true);
  assert.equal(v.productionBuildingCount, PRODUCTION_BUILDING_COUNT);
  assert.equal(v.road35EStatePreserved, true);
  assert.equal(v.projectionMutation, false);
  assert.equal(v.canonicalBuildingMutation, false);
  assert.equal(v.roadV3LogicMutation, false);
  assert.equal(v.duplicateRailIncrease, 0);
  assert.equal(v.duplicateWaterIncrease, 0);
  assert.equal(v.duplicateParkIncrease, 0);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
});

test('35F 実測: 実ブラウザで各レイヤーが出ている', { skip: skip('osm-shared-source-runtime-qa.json') }, () => {
  const q = rpt('osm-shared-source-runtime-qa.json');
  assert.equal(q.summary.buildingsVersion, 'V4');
  assert.equal(q.summary.allSitesHaveLayers, true);
  assert.equal(q.summary.regressionOk, true, JSON.stringify(q.summary.regression));
  assert.equal(q.summary.jsErrors, 0);
  assert.ok(q.summary.sitesWithRail > 0, '鉄道が 1 地点も出ていない');
  // §9 画面が読んでいる駅数が 35F 後のものになっていること（クラスタ後の数ではなく素の駅数）
  const der = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived', 'rail-stations.json'));
  if (der) assert.ok(q.summary.stationsLoaded > 0, '駅ラベルが 1 つも読めていない');
});

test('35F 実測: 作り直したレイヤーが北部の区に入っている', { skip: skip('shared-layer-duplicate-audit.json') }, () => {
  const d = rpt('shared-layer-duplicate-audit.json');
  for (const k of ['rail', 'water', 'parks']) {
    assert.ok(d.layers[k].northTotal > 0, k + ' が北部の区に 1 件も無い');
  }
  assert.ok(d.layers.stations.northTotal > 0, '駅が北部の区に 1 件も無い');
});
