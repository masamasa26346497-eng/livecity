// tools/lib/ward-layer-plan.js
// Mission 116: 24区「建物＋河川（水域）」統合表示のパス解決・読み込み計画・失敗診断・整合性検査。
//
// 【方針】
//  - 座標系・投影は一切定義しない（tools/lib/livecity-coordinate-system.js / znorth-neg-v1 が唯一の基準）。
//    「建物だけ一律平行移動する」補正は禁止。ここでは *検出* だけを行い、補正は行わない。
//  - URL 規約は public/osaka_3d_buildings*.html の実装（BuildingTileLayer / CityTileLayer /
//    RiverLayerV2 / WaterSurfaceLayer）と同一。HTML 側の定数が変わったら tests/mission116-ward-layers.test.js が落ちる。
//  - 選択した区だけを読む: planWard() は区 bbox を覆うタイルのみを列挙する（24区一括ロードを作らない）。
//  - 「データが無い」「検証していない」を成功として扱わない。status は常に根拠付きで返す。
import fs from 'node:fs';
import path from 'node:path';
import { pointInWard } from './point-in-polygon.js';
import { tilesCoveringBboxXZ } from './ward-tile-coverage.js';

export const EXPECTED_CONVENTION = 'znorth-neg-v1';
export const BUILDING_TILE_SIZE = 500;
export const CITY_LAYER_TILE_SIZE = 2000;
export const CITY_LAYERS = ['waterways', 'roads', 'parks', 'railways'];
export const URL_BASE = 'map-data/osaka-city';
/** HTML 側の描画高さ（地表=0 からの Y）。回帰検証でHTML文字列と突き合わせる。 */
export const EXPECTED_WATER_Y = { waterFill: 0.04, waterShore: 0.055, waterways: 0.05, parks: 0.07, roads: 0.13, railways: 0.17 };

// ── URL 規約（HTML と同一） ─────────────────────────────────────────────
export const urls = {
  buildingsRoot: () => `${URL_BASE}/buildings/manifest.json`,
  buildingsManifest: (datasetId) => `${URL_BASE}/buildings/${datasetId}/manifest.json`,
  buildingsTile: (datasetId, tx, tz) => `${URL_BASE}/buildings/${datasetId}/tile_${tx}_${tz}.json`,
  cityManifest: (layer) => `${URL_BASE}/${layer}/manifest.json`,
  cityTile: (layer, tx, tz) => `${URL_BASE}/${layer}/tile_${tx}_${tz}.json`,
  riversV2: () => `${URL_BASE}/rivers-v2/rivers.json`,
  waterSurface: () => `${URL_BASE}/water-surface/water-surface.json`,
  wardPolygons: () => `${URL_BASE}/boundaries/ward-classification-polygons.json`,
};

/** URL → mapRoot 配下のファイルパス。 */
export function urlToFile(publicDir, url) { return path.join(publicDir, ...url.split('/')); }

function readJson(file) {
  if (!fs.existsSync(file)) return { ok: false, code: 'missing-file' };
  try { return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { ok: false, code: 'invalid-json', detail: e.message }; }
}

// ── 計画: 区 → 読むべきURL一覧（選択区のみ） ─────────────────────────
/**
 * @param {object} rootManifest  buildings/manifest.json
 * @param {string} wardKey       wardId('fukushima') | datasetId('osaka-fukushima') | 区名('福島区') | wardCode
 * @param {{bufferM?:number}} [opts]
 */
export function findDataset(rootManifest, wardKey) {
  const ds = (rootManifest && rootManifest.datasets) || [];
  return ds.find((d) => d.wardId === wardKey || d.id === wardKey || d.ward === wardKey || d.wardCode === wardKey) || null;
}

export function planWard(rootManifest, wardKey, opts = {}) {
  const ds = findDataset(rootManifest, wardKey);
  if (!ds) return { ok: false, code: 'unknown-ward', wardKey };
  const buffer = opts.bufferM ?? 150;
  const bbox = ds.bounds;
  const cityTiles = tilesCoveringBboxXZ(bbox, CITY_LAYER_TILE_SIZE, { bufferMeters: buffer });
  return {
    ok: true, dataset: ds, bbox,
    buildingManifestUrl: urls.buildingsManifest(ds.id),
    cityTiles,
    cityTileUrls: Object.fromEntries(CITY_LAYERS.map((l) => [l, cityTiles.map((t) => urls.cityTile(l, t.tx, t.tz))])),
    singleFiles: { riversV2: urls.riversV2(), waterSurface: urls.waterSurface() },
  };
}

// ── 失敗診断 ────────────────────────────────────────────────────────
const DIAG_HINT = {
  'missing-file': '該当ファイルが存在しない。生成/配置が未実施（Windowsローカルの出力を public/map-data/osaka-city/ へ配置）。',
  'invalid-json': 'JSONとして壊れている（途中切れ・コピー失敗の疑い）。再生成または再コピー。',
  'wrong-dir': 'tiles/ サブディレクトリにはあるが、HTMLが fetch する flat 配置（{layer}/tile_*.json）に無い。build-city-layer-tiles.js を --public 付きで実行するか、コピーしてflat配置にする。',
  'convention-mismatch': `coordinateConvention が ${EXPECTED_CONVENTION} ではない。座標系が異なるデータは混在不可（補正で合わせない・再生成する）。`,
  'count-mismatch': 'manifest 記載の件数/タイル数と実体が一致しない。部分コピーまたは古い manifest。',
  'out-of-ward': 'タイルの建物が区ポリゴン外に多い。座標原点・回転・オフセットのずれ、または区割り違いの疑い。',
  'empty': 'ファイルは存在するが地物が0件。',
};
export function diagnoseHint(code) { return DIAG_HINT[code] || ''; }

// ── ファイル状態検査 ────────────────────────────────────────────────
function inspectCityTile(publicDir, layer, tx, tz) {
  const url = urls.cityTile(layer, tx, tz);
  const f = urlToFile(publicDir, url);
  const r = readJson(f);
  if (!r.ok) {
    const alt = path.join(publicDir, ...URL_BASE.split('/'), layer, 'tiles', `tile_${tx}_${tz}.json`);
    if (r.code === 'missing-file' && fs.existsSync(alt)) return { url, code: 'wrong-dir' };
    return { url, code: r.code };
  }
  return { url, code: 'ok', data: r.data };
}

/** 水域 feature を線/面に分類（waterways tile: kind 'area' | 'line'|'mixed'）。 */
export function classifyWaterFeatures(features) {
  let polygons = 0, lines = 0, other = 0;
  for (const f of features || []) {
    if (f.kind === 'area') polygons++;
    else if (f.kind === 'line') lines++;
    else other++;
  }
  return { polygons, lines, other };
}

/** 水域面 (kind:'area', p=[[x,z]...]) の内部に建物代表点が入る割合を数える（河岸ずれ指標）。 */
export function buildingsOverWater(buildings, waterAreaFeatures) {
  const rings = (waterAreaFeatures || []).filter((f) => Array.isArray(f.p) && f.p.length >= 3)
    .map((f) => ({ bbox: bboxOfPoints(f.p), polygons: [{ outer: f.p, holes: f.holes || [] }] }))
    .map((w) => ({ ...w, bbox: w.bbox }));
  let over = 0, total = 0;
  for (const b of buildings || []) {
    const x = b.repX, z = b.repZ;
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    total++;
    if (rings.some((w) => pointInWard(x, z, w))) over++;
  }
  return { over, total, ratio: total ? over / total : 0 };
}

export function bboxOfPoints(pts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
  return { minX, maxX, minZ, maxZ };
}

/** 建物代表点のうち区ポリゴン内にある割合。座標のずれ/回転/誤原点の検出器（補正はしない）。 */
export function insideWardRatio(buildings, wardPoly) {
  let inside = 0, total = 0;
  for (const b of buildings || []) {
    const x = Number.isFinite(b.repX) ? b.repX : (b.fp && b.fp[0] && b.fp[0][0]);
    const z = Number.isFinite(b.repZ) ? b.repZ : (b.fp && b.fp[0] && b.fp[0][1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    total++;
    if (pointInWard(x, z, wardPoly)) inside++;
  }
  return { inside, total, ratio: total ? inside / total : 0 };
}

/** 地表基準高さ: 建物 z0 の分布。全区で 0 付近であること（区ごとの高さオフセット禁止）。 */
export function groundBaseStats(buildings) {
  const z0s = (buildings || []).map((b) => b.z0).filter(Number.isFinite).sort((a, b) => a - b);
  if (!z0s.length) return { n: 0, min: null, median: null, max: null };
  return { n: z0s.length, min: z0s[0], median: z0s[Math.floor(z0s.length / 2)], max: z0s[z0s.length - 1] };
}

/**
 * 1区の完全検査（ローカルファイルのみ）。
 * 戻り値の layers.* は { status, code?, detail } で、'ok' 以外は理由コード付き。
 * browser / http は別工程（verify-ward-layers.js）。ここでは決して "描画成功" とは言わない。
 */
export function inspectWard({ publicDir, rootManifest, wardKey, wardPolygons, thresholds = {} }) {
  const th = { insideRatioMin: 0.9, overWaterRatioWarn: 0.05, groundMedianMax: 1, ...thresholds };
  const plan = planWard(rootManifest, wardKey);
  if (!plan.ok) return { wardKey, status: 'unknown-ward' };
  const ds = plan.dataset;
  const out = { wardKey, datasetId: ds.id, ward: ds.ward, declared: { buildings: ds.buildings, tiles: ds.tiles }, layers: {}, checks: {}, warnings: [] };

  // 建物
  const bm = readJson(urlToFile(publicDir, plan.buildingManifestUrl));
  if (!bm.ok) {
    out.layers.buildings = { status: 'missing', code: bm.code, hint: diagnoseHint(bm.code) };
  } else {
    const m = bm.data;
    const bl = { status: 'ok', tilesDeclared: (m.tiles || []).length, tilesPresent: 0, tilesMissing: [], buildingsLoaded: 0 };
    if (m.coordinateConvention !== EXPECTED_CONVENTION) { bl.status = 'error'; bl.code = 'convention-mismatch'; bl.hint = diagnoseHint(bl.code); }
    const allB = [];
    for (const t of m.tiles || []) {
      const r = readJson(urlToFile(publicDir, urls.buildingsTile(ds.id, t.tx, t.tz)));
      if (!r.ok) { bl.tilesMissing.push({ tx: t.tx, tz: t.tz, code: r.code }); continue; }
      bl.tilesPresent++;
      const arr = r.data.buildings || [];
      bl.buildingsLoaded += arr.length;
      if (arr.length !== t.count) { bl.countMismatchTiles = (bl.countMismatchTiles || 0) + 1; }
      // サンプリング（巨大区でも全件保持しない: 各タイル最大200件）
      for (let i = 0; i < arr.length && i < 200; i++) allB.push(arr[i]);
    }
    if (bl.tilesMissing.length) { bl.status = bl.tilesPresent === 0 ? 'missing' : 'partial'; bl.code = bl.tilesPresent === 0 ? 'missing-file' : 'count-mismatch'; bl.hint = diagnoseHint(bl.code); }
    else if (bl.status === 'ok' && (bl.countMismatchTiles || bl.buildingsLoaded !== (m.totalBuildings ?? bl.buildingsLoaded))) { bl.status = 'partial'; bl.code = 'count-mismatch'; bl.hint = diagnoseHint(bl.code); }
    out.layers.buildings = bl;

    // 座標・地表高さ回帰（実タイルがある時のみ）
    if (allB.length) {
      const wp = (wardPolygons || []).find((w) => w.wardCode === ds.wardCode || w.wardId === ds.wardId);
      if (wp) {
        const r = insideWardRatio(allB, wp);
        out.checks.insideWard = { ...r, min: th.insideRatioMin, pass: r.ratio >= th.insideRatioMin };
        if (!out.checks.insideWard.pass) out.warnings.push({ code: 'out-of-ward', hint: diagnoseHint('out-of-ward') });
      } else out.checks.insideWard = { pass: null, reason: 'ward polygon not found' };
      const g = groundBaseStats(allB);
      out.checks.groundBase = { ...g, pass: Math.abs(g.median) <= th.groundMedianMax };
    }
    out.buildingSample = allB;
  }

  // 都市レイヤー（waterways は線/面を区別）
  const cityFeatures = {};
  for (const layer of CITY_LAYERS) {
    const mf = readJson(urlToFile(publicDir, urls.cityManifest(layer)));
    if (!mf.ok) { out.layers[layer] = { status: 'missing', code: mf.code, hint: diagnoseHint(mf.code) }; continue; }
    if (mf.data.coordinateConvention !== EXPECTED_CONVENTION) { out.layers[layer] = { status: 'error', code: 'convention-mismatch', hint: diagnoseHint('convention-mismatch') }; continue; }
    const st = { status: 'ok', tilesNeeded: plan.cityTiles.length, tilesPresent: 0, tilesEmpty: 0, problems: [], features: 0 };
    const feats = [];
    for (const t of plan.cityTiles) {
      const r = inspectCityTile(publicDir, layer, t.tx, t.tz);
      if (r.code === 'ok') { st.tilesPresent++; const f = r.data.features || []; st.features += f.length; if (!f.length) st.tilesEmpty++; feats.push(...f); }
      else if (r.code === 'wrong-dir') st.problems.push({ url: r.url, code: r.code });
      // マニフェストに載っていないタイル=その範囲に地物なし（未生成と区別するため manifest.tiles を参照）
      else if (!((mf.data.tiles || []).some((x) => x.tx === t.tx && x.tz === t.tz))) st.tilesEmpty++;
      else st.problems.push({ url: r.url, code: r.code });
    }
    if (st.problems.length) { st.status = st.tilesPresent ? 'partial' : 'missing'; st.code = st.problems[0].code; st.hint = diagnoseHint(st.code); }
    if (layer === 'waterways') st.water = classifyWaterFeatures(feats);
    cityFeatures[layer] = feats;
    out.layers[layer] = st;
  }

  // rivers-v2 / water-surface（単一ファイル）
  for (const [key, url] of [['riversV2', urls.riversV2()], ['waterSurface', urls.waterSurface()]]) {
    const r = readJson(urlToFile(publicDir, url));
    if (!r.ok) { out.layers[key] = { status: 'missing', code: r.code, hint: diagnoseHint(r.code) }; continue; }
    const conv = r.data.coordinateConvention;
    out.layers[key] = conv && conv !== EXPECTED_CONVENTION
      ? { status: 'error', code: 'convention-mismatch', hint: diagnoseHint('convention-mismatch') }
      : { status: 'ok', riverCount: Array.isArray(r.data.rivers) ? r.data.rivers.length : undefined };
  }

  // 建物×水面の整合（河岸ずれ指標）
  const waterAreas = (cityFeatures.waterways || []).filter((f) => f.kind === 'area');
  if (out.buildingSample && waterAreas.length) {
    const o = buildingsOverWater(out.buildingSample, waterAreas);
    out.checks.buildingsOverWater = { ...o, warnAbove: th.overWaterRatioWarn, pass: o.ratio <= th.overWaterRatioWarn };
  }
  delete out.buildingSample;

  // 総合: ローカルデータ観点のみ。描画成功は browser 検証が別途必要。
  const critical = [out.layers.buildings, out.layers.waterways];
  const allOk = critical.every((l) => l && l.status === 'ok') && Object.values(out.checks).every((c) => c.pass !== false);
  out.localData = allOk ? 'complete' : (critical.some((l) => l && l.status !== 'missing') ? 'partial' : 'absent');
  out.waterKind = out.layers.waterways && out.layers.waterways.water
    ? (out.layers.waterways.water.polygons ? 'polygon+line' : (out.layers.waterways.water.lines ? 'line-only' : 'none'))
    : 'unknown';
  out.browserVerified = false; // このモジュールでは決して true にしない
  return out;
}
