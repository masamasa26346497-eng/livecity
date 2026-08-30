// tools/lib/boundary-ingestion-validator.js
// P1-2: 行政区境界（国土数値情報 N03）の取り込み結果を自動検証する。
//
// 検証対象は tools/ingest/n03-administrative-boundaries.js の出力ペイロード
//   { records: [{ wardId, wardCode, wardName, geometry, ... }], metadata: {...} }
// である。geometry は次のどちらか:
//   - 変換済み: { coordinatesConverted:true, coordinateConvention:'znorth-neg-v1', rings:[[[x,z],...],...] }
//   - 生WGS84 : { coordinatesConverted:false, coordinateConvention:null, raw:{type,coordinates} }
//
// AUTODEV_BACKLOG.md P1-2 の確認項目に対応する:
//   - polygon parse成功            → C_GEOMETRY_PRESENT / C_RINGS_NONEMPTY
//   - ward code一致                → C_WARD_IDENTITY
//   - polygonが空でない            → C_RINGS_NONEMPTY
//   - NaNなし                      → C_COORDS_FINITE
//   - 異常自己交差の検出可能性     → C_SELF_INTERSECTION / C_OVERSIZED_SEGMENT
//   - znorth-neg-v1整合            → C_COORDINATE_CONVENTION
//   - 既存3区を壊していない        → C_KNOWN_WARDS_STABLE
//
// この関数は例外を投げず、常に構造化された結果を返す（fail-fastが必要な取り込み側とは責務が別）。

import { convertCoordsArray } from './projection.js';

// 既存 osaka-sumiyoshi エリア（住吉区・東住吉区・平野区の建物データに合わせたbbox）。
// 24区取り込みでこの3区が消える／座標系がズレていないことの回帰チェックに使う。
const LEGACY_SUMIYOSHI_AREA_BBOX = { south: 34.599824, west: 135.499929, north: 34.608592, east: 135.550111 };
const KNOWN_WARD_IDS = ['sumiyoshi', 'higashisumiyoshi', 'hirano'];

// 大阪市の妥当な緯度経度レンジ（此花区の夢洲・住之江区の咲洲を含む広めの窓）。
const OSAKA_CITY_LATLON_WINDOW = { south: 34.55, west: 135.30, north: 34.80, east: 135.65 };

// 「1セグメントが異常に長い」= 同一リング内の中央値セグメント長のこの倍数を超え、かつ絶対長も超える。
// multipolygon の outer メンバー way を連結し損ねた場合や、閉じていないリングを閉ポリゴンとして
// 扱った場合、行政界の細かいジグザグの中に「地物を横断する1本の巨大な辺」が混じる。行政界は
// 通常セグメント長が比較的均一なため、中央値の20倍を超える辺は連結漏れ・座標破損を強く示唆する。
const OVERSIZED_SEG_MEDIAN_MULT = 20;
const OVERSIZED_SEG_ABS_METERS = 800;
const OVERSIZED_SEG_MIN_POINTS = 5;

// 自己交差スキャンは O(n^2)。行政区リングは最大でも千点オーダーのため実用上問題ないが、
// 想定外に巨大なリングでCIが固まらないよう上限を設ける（超過時は warning として報告）。
const SELF_INTERSECTION_MAX_POINTS = 6000;

function isFinitePair(pt) {
  return Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]);
}

function ringBbox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, diag: Math.hypot(maxX - minX, maxY - minY) };
}

function segmentsIntersect(p1, p2, p3, p4) {
  const d = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = d(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1]);
  const d2 = d(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1]);
  const d3 = d(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  const d4 = d(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1]);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

/**
 * 1リング（[[x,y],...] の点列。座標系は呼び出し側で統一済み）を評価する。
 * @returns {{points:number, uniquePoints:number, closed:boolean, maxSegment:number,
 *   bboxDiag:number, oversizedSegments:number, selfIntersections:number, selfIntersectionScanned:boolean,
 *   nonFinite:number}}
 */
export function evaluateRing(rawPoints) {
  const points = Array.isArray(rawPoints) ? rawPoints : [];
  let nonFinite = 0;
  for (const pt of points) if (!isFinitePair(pt)) nonFinite++;
  const finitePoints = points.filter(isFinitePair);

  const n = finitePoints.length;
  const closed = n >= 2 &&
    finitePoints[0][0] === finitePoints[n - 1][0] &&
    finitePoints[0][1] === finitePoints[n - 1][1];

  const uniqueKeys = new Set(finitePoints.map((p) => `${p[0]}_${p[1]}`));

  const bb = n ? ringBbox(finitePoints) : { diag: 0 };
  const segLengths = [];
  for (let i = 0; i < n - 1; i++) {
    segLengths.push(Math.hypot(finitePoints[i + 1][0] - finitePoints[i][0], finitePoints[i + 1][1] - finitePoints[i][1]));
  }
  const maxSegment = segLengths.length ? Math.max(...segLengths) : 0;
  const sorted = [...segLengths].sort((a, b) => a - b);
  const medianSegment = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  let oversizedSegments = 0;
  if (n >= OVERSIZED_SEG_MIN_POINTS && medianSegment > 0) {
    for (const seg of segLengths) {
      if (seg > OVERSIZED_SEG_ABS_METERS && seg > medianSegment * OVERSIZED_SEG_MEDIAN_MULT) oversizedSegments++;
    }
  }

  let selfIntersections = 0;
  let selfIntersectionScanned = false;
  if (n >= 4 && n <= SELF_INTERSECTION_MAX_POINTS) {
    selfIntersectionScanned = true;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n - 1; j++) {
        // 隣接セグメントと、閉じたリングの最初と最後のセグメント同士は共有頂点があるためスキップ
        if (i === 0 && j === n - 2) continue;
        if (segmentsIntersect(finitePoints[i], finitePoints[i + 1], finitePoints[j], finitePoints[j + 1])) {
          selfIntersections++;
        }
      }
    }
  }

  return {
    points: points.length,
    uniquePoints: uniqueKeys.size,
    closed,
    maxSegment,
    medianSegment,
    bboxDiag: bb.diag,
    oversizedSegments,
    selfIntersections,
    selfIntersectionScanned,
    nonFinite,
  };
}

// geometry を「検証用の共通座標系リング配列」へ正規化する。
// - 変換済み(rings) はそのまま [x,z] メートル。
// - 生WGS84(raw) は projection があればメートルへ変換、無ければ [lon,lat] のまま
//   （相対テストと緯度経度sanityのみ実施可能）。
function ringsForValidation(geometry, projection) {
  if (!geometry || typeof geometry !== 'object') return { rings: [], unit: 'none' };

  if (Array.isArray(geometry.rings)) {
    return { rings: geometry.rings, unit: 'meters' };
  }
  const raw = geometry.raw;
  if (!raw || !Array.isArray(raw.coordinates)) return { rings: [], unit: 'none' };

  const rawRings = [];
  if (raw.type === 'Polygon') {
    for (const ring of raw.coordinates) rawRings.push(ring);
  } else if (raw.type === 'MultiPolygon') {
    for (const poly of raw.coordinates) for (const ring of poly) rawRings.push(ring);
  } else {
    return { rings: [], unit: 'none' };
  }

  if (projection) {
    return { rings: rawRings.map((r) => convertCoordsArray(r, projection)), unit: 'meters' };
  }
  return { rings: rawRings, unit: 'degrees' };
}

function rawLatLonBbox(geometry) {
  const raw = geometry && geometry.raw;
  if (!raw || !Array.isArray(raw.coordinates)) return null;
  let s = 90, w = 180, n = -90, e = -180;
  const walk = (coords, depth) => {
    if (depth === 1) {
      for (const [lon, lat] of coords) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
        if (lon < w) w = lon;
        if (lon > e) e = lon;
      }
      return;
    }
    for (const c of coords) walk(c, depth - 1);
  };
  if (raw.type === 'Polygon') walk(raw.coordinates, 2);
  else if (raw.type === 'MultiPolygon') walk(raw.coordinates, 3);
  else return null;
  if (s > n || w > e) return null;
  return { south: s, west: w, north: n, east: e };
}

function bboxOverlaps(a, b, marginDeg = 0.02) {
  return !(a.east < b.west - marginDeg || a.west > b.east + marginDeg ||
    a.north < b.south - marginDeg || a.south > b.north + marginDeg);
}

function check(name, pass, detail, severity = 'error') {
  return { name, pass, detail, severity };
}

/**
 * 取り込みペイロード全体を検証する。
 * @param {{records:object[], metadata?:object}} payload
 * @param {{city:string, wards:object[]}} registry  config/wards/registry.json 相当
 * @param {{projection?:object, areaId?:string}} [options] projection を渡すと生WGS84 geometry も
 *   メートル系へ変換して幾何検証する。
 * @returns {{ok:boolean, checks:object[], wardReports:object[], summary:object}}
 */
export function validateBoundaryIngestion(payload, registry, options = {}) {
  const { projection = null, areaId = null } = options;
  const checks = [];
  const wardReports = [];

  if (!payload || !Array.isArray(payload.records)) {
    return {
      ok: false,
      checks: [check('payload-shape', false, 'payload.records が配列ではありません。')],
      wardReports: [],
      summary: { recordCount: 0 },
    };
  }
  if (!registry || !Array.isArray(registry.wards)) {
    return {
      ok: false,
      checks: [check('registry-shape', false, 'registry.wards が配列ではありません。')],
      wardReports: [],
      summary: { recordCount: payload.records.length },
    };
  }

  const records = payload.records;
  const registryById = new Map(registry.wards.map((w) => [w.id, w]));

  // ── C: 24区の網羅と一意性 ──
  const seenWardIds = new Map();
  for (const r of records) seenWardIds.set(r.wardId, (seenWardIds.get(r.wardId) || 0) + 1);
  const duplicateWardIds = [...seenWardIds.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  const missingWards = registry.wards.filter((w) => !seenWardIds.has(w.id));
  const missingWardIds = missingWards.map((w) => w.id);
  const unknownWardIds = [...seenWardIds.keys()].filter((id) => !registryById.has(id));

  checks.push(check('all-wards-present',
    missingWardIds.length === 0,
    missingWardIds.length ? `未取得: ${missingWards.map((w) => `${w.name}(${w.id})`).join(', ')}` : `${registry.wards.length}区すべて取得`));
  checks.push(check('no-duplicate-wards',
    duplicateWardIds.length === 0,
    duplicateWardIds.length ? `重複wardId: ${duplicateWardIds.join(', ')}` : 'OK'));
  checks.push(check('no-unknown-wards',
    unknownWardIds.length === 0,
    unknownWardIds.length ? `registry外のwardId: ${unknownWardIds.join(', ')}` : 'OK'));

  // ── 各レコードの検証 ──
  let identityMismatch = 0;
  let geometryMissing = 0;
  let emptyRings = 0;
  let nonFiniteTotal = 0;
  let conventionBad = 0;
  let convertedCount = 0;
  let rawCount = 0;
  let wardsWithOversizedSeg = [];
  let wardsWithSelfIntersection = [];
  let wardsWithUnclosedRing = [];
  let wardsOutOfLatLonWindow = [];
  let selfIntersectionUnscanned = [];

  for (const r of records) {
    const reg = registryById.get(r.wardId);
    const idOk = reg && reg.code === r.wardCode && reg.name === r.wardName;
    if (!idOk && reg) identityMismatch++;

    const geometry = r.geometry;
    const converted = !!(geometry && geometry.coordinatesConverted);
    if (converted) convertedCount++;
    else rawCount++;
    if (converted && geometry.coordinateConvention !== 'znorth-neg-v1') conventionBad++;

    const { rings, unit } = ringsForValidation(geometry, projection);
    if (!geometry || (!Array.isArray(geometry.rings) && !geometry.raw)) geometryMissing++;

    const nonEmptyRings = rings.filter((ring) => Array.isArray(ring) && ring.length >= 3);
    if (nonEmptyRings.length === 0) emptyRings++;

    let wardNonFinite = 0;
    let wardOversized = 0;
    let wardSelfInt = 0;
    let wardUnclosed = 0;
    let wardMaxSeg = 0;
    let wardUnscanned = false;
    for (const ring of rings) {
      const ev = evaluateRing(ring);
      wardNonFinite += ev.nonFinite;
      wardOversized += ev.oversizedSegments;
      wardSelfInt += ev.selfIntersections;
      if (!ev.selfIntersectionScanned && ev.points >= 4) wardUnscanned = true;
      if (ev.points >= 4 && !ev.closed && unit === 'degrees') wardUnclosed++; // GeoJSONリングは閉じている必要がある
      if (ev.maxSegment > wardMaxSeg) wardMaxSeg = ev.maxSegment;
    }
    nonFiniteTotal += wardNonFinite;
    if (wardOversized > 0) wardsWithOversizedSeg.push(`${r.wardName}(${wardOversized})`);
    if (wardSelfInt > 0) wardsWithSelfIntersection.push(`${r.wardName}(${wardSelfInt})`);
    if (wardUnclosed > 0) wardsWithUnclosedRing.push(`${r.wardName}(${wardUnclosed})`);
    if (wardUnscanned) selfIntersectionUnscanned.push(r.wardName);

    const latLonBbox = rawLatLonBbox(geometry);
    if (latLonBbox && !bboxOverlaps(latLonBbox, OSAKA_CITY_LATLON_WINDOW, 0)) {
      wardsOutOfLatLonWindow.push(r.wardName);
    }

    wardReports.push({
      wardId: r.wardId,
      wardName: r.wardName,
      wardCode: r.wardCode,
      identityMatchesRegistry: !!idOk,
      converted,
      unit,
      ringCount: rings.length,
      nonEmptyRingCount: nonEmptyRings.length,
      sourceFeatureCount: r.sourceFeatureCount,
      nonFiniteCoords: wardNonFinite,
      oversizedSegments: wardOversized,
      selfIntersections: wardSelfInt,
      unclosedRawRings: wardUnclosed,
      maxSegment: Math.round(wardMaxSeg),
      latLonBbox,
    });
  }

  checks.push(check('ward-identity-matches-registry',
    identityMismatch === 0,
    identityMismatch ? `${identityMismatch}区でwardCode/wardNameがregistryと不一致` : 'OK'));
  checks.push(check('geometry-present',
    geometryMissing === 0,
    geometryMissing ? `${geometryMissing}区でgeometryが欠落` : 'OK'));
  checks.push(check('rings-non-empty',
    emptyRings === 0,
    emptyRings ? `${emptyRings}区で有効なリング(3点以上)が0` : 'OK'));
  checks.push(check('coords-finite',
    nonFiniteTotal === 0,
    nonFiniteTotal ? `NaN/Infinity 座標 ${nonFiniteTotal}点` : 'OK'));
  checks.push(check('coordinate-convention-consistent',
    !(convertedCount > 0 && rawCount > 0),
    convertedCount > 0 && rawCount > 0 ? `変換済み${convertedCount}区と生WGS84 ${rawCount}区が混在` : (convertedCount > 0 ? 'znorth-neg-v1(変換済み)' : 'WGS84(未変換)')));
  checks.push(check('znorth-neg-v1-tag',
    conventionBad === 0,
    conventionBad ? `${conventionBad}区でcoordinateConventionがznorth-neg-v1でない` : 'OK'));
  checks.push(check('rings-closed',
    wardsWithUnclosedRing.length === 0,
    wardsWithUnclosedRing.length ? `閉じていない生リング: ${wardsWithUnclosedRing.join(', ')}` : 'OK'));

  // ── 異常幾何（自己交差の疑い） ──
  checks.push(check('no-oversized-segments',
    wardsWithOversizedSeg.length === 0,
    wardsWithOversizedSeg.length
      ? `地物を横断しうる巨大な辺(リングbbox対角比>${OVERSIZED_SEG_RATIO}かつ>${OVERSIZED_SEG_ABS_METERS}m): ${wardsWithOversizedSeg.join(', ')}`
      : 'OK',
    projection || convertedCount > 0 ? 'error' : 'warning'));
  checks.push(check('no-self-intersections',
    wardsWithSelfIntersection.length === 0,
    wardsWithSelfIntersection.length ? `自己交差を検出: ${wardsWithSelfIntersection.join(', ')}` : 'OK'));
  if (selfIntersectionUnscanned.length) {
    checks.push(check('self-intersection-scan-coverage', true,
      `点数上限(${SELF_INTERSECTION_MAX_POINTS})超でスキャン未実施: ${selfIntersectionUnscanned.join(', ')}`,
      'warning'));
  }

  // ── 緯度経度sanity（生WGS84の場合のみ判定可能） ──
  if (wardsOutOfLatLonWindow.length || rawCount > 0) {
    checks.push(check('latlon-window',
      wardsOutOfLatLonWindow.length === 0,
      wardsOutOfLatLonWindow.length
        ? `大阪市の妥当な緯度経度窓から外れる区: ${wardsOutOfLatLonWindow.join(', ')}`
        : 'OK'));
  }

  // ── 既存3区の保護 ──
  const knownPresent = KNOWN_WARD_IDS.filter((id) => seenWardIds.has(id));
  let knownStable = knownPresent.length === KNOWN_WARD_IDS.length;
  const knownDetail = [];
  if (!knownStable) {
    knownDetail.push(`欠落: ${KNOWN_WARD_IDS.filter((id) => !seenWardIds.has(id)).join(', ') || 'なし'}`);
  }
  for (const id of knownPresent) {
    const rep = wardReports.find((w) => w.wardId === id);
    if (rep && rep.latLonBbox && !bboxOverlaps(rep.latLonBbox, LEGACY_SUMIYOSHI_AREA_BBOX)) {
      knownStable = false;
      knownDetail.push(`${rep.wardName}のbboxが既存osaka-sumiyoshiエリアと重ならない`);
    }
    if (rep && (rep.nonEmptyRingCount === 0 || rep.nonFiniteCoords > 0)) {
      knownStable = false;
      knownDetail.push(`${rep.wardName}のリングが不正`);
    }
  }
  checks.push(check('known-wards-stable', knownStable, knownDetail.length ? knownDetail.join(' / ') : '住吉区・東住吉区・平野区は健全'));

  // ── metadata の出典記録（USER_DECISION 1: ライセンス・出典・基準年月日の記録が必須） ──
  const md = payload.metadata || {};
  const provenanceKeys = ['license', 'referenceDate', 'retrievedUrl'];
  const missingProvenance = provenanceKeys.filter((k) => !md[k]);
  checks.push(check('provenance-recorded',
    missingProvenance.length === 0,
    missingProvenance.length ? `metadata未記録: ${missingProvenance.join(', ')}` : 'OK',
    'warning'));

  const errorFails = checks.filter((c) => !c.pass && c.severity === 'error');
  const ok = errorFails.length === 0;

  return {
    ok,
    checks,
    wardReports,
    summary: {
      areaId,
      recordCount: records.length,
      registryWardCount: registry.wards.length,
      convertedWards: convertedCount,
      rawWards: rawCount,
      errorFailCount: errorFails.length,
      warningCount: checks.filter((c) => !c.pass && c.severity === 'warning').length,
    },
  };
}
