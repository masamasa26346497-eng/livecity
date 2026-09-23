// tools/lib/osm-building-fallback.js
// [Mission21B/21C] PLATEAU 建物コーパスの欠落領域を OSM building footprint で補完する純粋ロジック。
//   方針（§10/§11、Mission21C §4-5 で拡張）:
//     - 優先は PLATEAU。OSM は次のいずれかの 100m cell で採用:
//         (hole)           50m cell + 8近傍まで PLATEAU footprint が皆無
//         (sparse-mismatch) OSM footprint 面積 >> PLATEAU footprint 面積（>= SPARSE_AREA_RATIO）
//                           かつ OSM 建物数 >= SPARSE_MIN_OSM_COUNT（PLATEAU が少数だけ入っていても補完）
//     - duplicate 排除は polygon レベル: centroid-in-polygon / bbox IoU（近接距離だけでは判定しない）。
//     - 高さ: OSM height → building:levels × LEVEL_HEIGHT_M → 不明は heightUnknown（分析用実高さに使わない。
//       表示用は renderHeight として明示分離）。
//     - source metadata（source:'osm-fallback', osmId, heightSource, fallbackReason）を必ず残す。
// THREE 非依存。座標は znorth-neg-v1 [x,z]。
// ══════════════════════════════════════════════════════════════════════════════════

export const SPARSE_AREA_RATIO = 2.5;   // osmFpArea / max(plateauFpArea, floor) がこれ以上で sparse-mismatch
export const SPARSE_MIN_OSM_COUNT = 5;  // sparse-mismatch cell の最小 OSM 建物数
export const SPARSE_PLATEAU_AREA_FLOOR = 200; // plateauFpArea の下限（0 割り防止・小さな PLATEAU を無視しすぎない）
export const RENDER_UNKNOWN_HEIGHT_M = 6.0; // class-default も無い generic 'yes' の「表示用」控えめ高さ

export const LEVEL_HEIGHT_M = 3.2;      // building:levels 1 層あたり（住宅・雑居ビル想定。§10 floorHeight≈3m 相当）
export const UNKNOWN_HEIGHT_M = 6.0;    // 後方互換（generic default）
export const MAX_FALLBACK_HEIGHT_M = 60; // OSM の異常 height を clamp（超高層は PLATEAU 側にある想定）

// [Mission29 §2] fallback 対象外にする building タグ（屋根のみ・工事中・廃墟・計画中）。
export const BUILDING_EXCLUDE_TAGS = new Set(['no', 'roof', 'construction', 'ruins', 'proposed', 'demolished', 'razed', 'collapsed', 'abandoned']);

// [Mission29 §10] building=* クラス別の default 高さ（height / building:levels がどちらも無い時のみ使う）。
//   都市模型で不自然にならない控えめ寄りの値。levels/height があれば必ず優先。
export const BUILDING_CLASS_DEFAULT_HEIGHT = Object.freeze({
  house: 8, detached: 8, semidetached_house: 8, terrace: 9, bungalow: 6, cabin: 5, hut: 4,
  residential: 11, apartments: 12, dormitory: 13,
  commercial: 11, retail: 9, supermarket: 9, kiosk: 4, shop: 7,
  office: 14,
  industrial: 9, manufacture: 9, factory: 10,
  warehouse: 8, storage_tank: 8,
  school: 10, university: 14, college: 13, kindergarten: 7,
  hospital: 14, clinic: 10,
  hotel: 16,
  civic: 12, public: 12, government: 14, hall: 10, community_centre: 8,
  church: 12, temple: 10, shrine: 8, mosque: 12, cathedral: 20, chapel: 9,
  train_station: 10, transportation: 8, hangar: 12,
  garage: 3, garages: 3, carport: 3, parking: 9, shed: 3, greenhouse: 4, farm: 6, barn: 8,
  sports_hall: 12, stadium: 20, grandstand: 12, pavilion: 6,
  yes: null, // generic：class default を当てず RENDER_UNKNOWN_HEIGHT_M
});

/** building タグ値を正規化した usage（不明・generic は 'yes'）。 */
export function normalizeBuildingUsage(buildingTag) {
  const v = String(buildingTag || '').toLowerCase().trim();
  if (!v || v === 'yes' || v === 'true' || v === '1') return 'yes';
  return v;
}

// ── [fallback建物の色/用途] OSM building タグ値 → 描画カテゴリ ─────────────────────
//   HTML 側の建物用途プリセット（BLDG_PRESET_OF_USAGE の値: residential_low / residential_mid /
//   commercial / office / industrial / school / public / medical / hotel / other）と同じキー空間。
//   fallback 建物を「用途不明のグレー」で落とさず、既定カテゴリ（DEFAULT_BUILDING_CATEGORY）へ
//   必ず寄せる。null / undefined を描画・popup へ流さないための正規化ロジック。
export const DEFAULT_BUILDING_CATEGORY = 'other';
export const FALLBACK_USAGE_CATEGORY = Object.freeze({
  house: 'residential_low', detached: 'residential_low', semidetached_house: 'residential_low',
  terrace: 'residential_low', bungalow: 'residential_low', cabin: 'residential_low', hut: 'residential_low',
  static_caravan: 'residential_low', houseboat: 'residential_low', farm: 'residential_low',
  residential: 'residential_mid', apartments: 'residential_mid', dormitory: 'residential_mid',
  commercial: 'commercial', retail: 'commercial', supermarket: 'commercial', kiosk: 'commercial',
  shop: 'commercial', marketplace: 'commercial',
  office: 'office',
  industrial: 'industrial', manufacture: 'industrial', factory: 'industrial', warehouse: 'industrial',
  storage_tank: 'industrial', hangar: 'industrial', digester: 'industrial', agricultural: 'industrial',
  greenhouse: 'industrial', barn: 'industrial', farm_auxiliary: 'industrial',
  school: 'school', university: 'school', college: 'school', kindergarten: 'school',
  hospital: 'medical', clinic: 'medical', nursing_home: 'medical', social_facility: 'medical',
  hotel: 'hotel', motel: 'hotel', hostel: 'hotel', guest_house: 'hotel',
  civic: 'public', public: 'public', government: 'public', hall: 'public', community_centre: 'public',
  church: 'public', temple: 'public', shrine: 'public', mosque: 'public', cathedral: 'public', chapel: 'public',
  train_station: 'public', transportation: 'public', fire_station: 'public', museum: 'public',
  library: 'public', sports_hall: 'public', stadium: 'public', grandstand: 'public', pavilion: 'public',
  toilets: 'public', gatehouse: 'public',
});
export const BUILDING_CATEGORY_LABEL = Object.freeze({
  residential_low: '住宅', residential_mid: '共同住宅', commercial: '商業施設', office: '事務所',
  industrial: '工場・倉庫', school: '学校', medical: '医療・福祉', hotel: '宿泊施設',
  public: '公共施設', other: '建物（用途不明）',
});

/**
 * fallback 建物の用途を正規化する。戻り値は全フィールド非 null。
 *   usage           : OSM building タグ値そのまま（generic / 未指定は null。既存互換）
 *   normalizedUsage : 'yes'（generic）含む正規化値。null にならない。
 *   category        : 描画カテゴリ（HTML プリセットキー）。不明でも DEFAULT_BUILDING_CATEGORY。
 *   usageLabel      : popup 表示用の整形済み日本語名。"null" / "その他(null)" にならない。
 */
export function resolveFallbackUsage(buildingTag) {
  const normalizedUsage = normalizeBuildingUsage(buildingTag);
  const rawUsage = normalizedUsage === 'yes' ? null : normalizedUsage;
  const category = (rawUsage && FALLBACK_USAGE_CATEGORY[rawUsage]) || DEFAULT_BUILDING_CATEGORY;
  const usageLabel = BUILDING_CATEGORY_LABEL[category] || BUILDING_CATEGORY_LABEL.other;
  return { usage: rawUsage, normalizedUsage, category, usageLabel };
}

/** fallback 対象にできる building タグか（roof/construction/ruins 等を除外）。 */
export function isFallbackEligibleBuilding(buildingTag) {
  const v = String(buildingTag || '').toLowerCase().trim();
  if (!v) return false;
  return !BUILDING_EXCLUDE_TAGS.has(v);
}

/**
 * OSM タグから高さを解決する（§10: usage 別 class default 対応・§11: confidence 付き）。
 * @returns {{dz:number, heightSource:'osm-height'|'osm-levels'|'class-default'|'generic-default',
 *            heightUnknown:boolean, confidence:number, usage:string}}
 */
export function resolveOsmHeight(tags) {
  const t = tags || {};
  const usage = normalizeBuildingUsage(t.building);
  const hRaw = parseFloat(t.height);
  if (Number.isFinite(hRaw) && hRaw > 0) {
    return { dz: Math.min(MAX_FALLBACK_HEIGHT_M, hRaw), heightSource: 'osm-height', heightUnknown: false, confidence: 0.92, usage };
  }
  const lv = parseFloat(t['building:levels']);
  if (Number.isFinite(lv) && lv >= 1) {
    return { dz: Math.min(MAX_FALLBACK_HEIGHT_M, lv * LEVEL_HEIGHT_M), heightSource: 'osm-levels', heightUnknown: false, confidence: 0.78, usage };
  }
  const classDef = BUILDING_CLASS_DEFAULT_HEIGHT[usage];
  if (Number.isFinite(classDef) && classDef > 0) {
    // 実測ではないので heightUnknown は true のまま（Mission10 高さ階級には入れない）。renderHeight のみ現実的に。
    return { dz: Math.min(MAX_FALLBACK_HEIGHT_M, classDef), heightSource: 'class-default', heightUnknown: true, confidence: 0.55, usage };
  }
  return { dz: RENDER_UNKNOWN_HEIGHT_M, heightSource: 'generic-default', heightUnknown: true, confidence: 0.4, usage };
}

/** リング（[x,z]列）の面積（絶対値）。 */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
}

// [Mission29 §9] リングの自己交差（隣接しない辺どうしの交差）を検出する。footprint 品質フィルタ用。
function segIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
export function ringSelfIntersects(ring) {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = ring[i], a2 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // 隣接辺
      const b1 = ring[j], b2 = ring[(j + 1) % n];
      if (segIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}
/** リングが描画に耐えるか（頂点数・面積・非有限・自己交差）。 */
export function isValidFootprint(ring, { minArea = 8, maxArea = 60000 } = {}) {
  if (!Array.isArray(ring) || ring.length < 3) return { ok: false, reason: 'too-few-points' };
  for (const p of ring) if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return { ok: false, reason: 'non-finite' };
  const a = ringArea(ring);
  if (a < minArea) return { ok: false, reason: 'too-small' };
  if (a > maxArea) return { ok: false, reason: 'too-big' };
  if (ringSelfIntersects(ring)) return { ok: false, reason: 'self-intersect' };
  return { ok: true, area: a };
}

export function ringBbox(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
  return { minX, maxX, minZ, maxZ };
}

export function ringCentroid(ring) {
  let cx = 0, cz = 0, area = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const cross = p[0] * q[1] - q[0] * p[1];
    area += cross; cx += (p[0] + q[0]) * cross; cz += (p[1] + q[1]) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    let sx = 0, sz = 0; for (const [x, z] of ring) { sx += x; sz += z; }
    return [sx / ring.length, sz / ring.length];
  }
  area *= 0.5;
  return [cx / (6 * area), cz / (6 * area)];
}

/**
 * PLATEAU footprint 群から「占有 50m cell」集合を作る。
 * @param {Array<number[][]>} plateauFootprints
 * @param {number} cellM
 * @returns {Set<string>} key "cx,cz"
 */
export function buildPlateauPresenceGrid(plateauFootprints, cellM = 50) {
  const set = new Set();
  for (const fp of plateauFootprints) {
    if (!Array.isArray(fp) || fp.length < 3) continue;
    const b = ringBbox(fp);
    for (let cx = Math.floor(b.minX / cellM); cx <= Math.floor(b.maxX / cellM); cx++)
      for (let cz = Math.floor(b.minZ / cellM); cz <= Math.floor(b.maxZ / cellM); cz++)
        set.add(cx + ',' + cz);
  }
  return set;
}

/** 中心 cell + 8近傍が全て PLATEAU-free か（＝ granularity mismatch でなく本当の hole）。 */
export function isInPlateauHole(x, z, presenceGrid, cellM = 50) {
  const cx = Math.floor(x / cellM), cz = Math.floor(z / cellM);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (presenceGrid.has((cx + dx) + ',' + (cz + dz))) return false;
  }
  return true;
}

/**
 * PLATEAU footprint 群 → 100m cell ごとの {count, area}。sparse-mismatch 判定用。
 * @returns {Map<string,{count:number, area:number}>}
 */
export function buildFootprintDensityGrid(footprints, cellM = 100) {
  const grid = new Map();
  for (const fp of footprints) {
    if (!Array.isArray(fp) || fp.length < 3) continue;
    const c = ringCentroid(fp);
    const k = Math.floor(c[0] / cellM) + ',' + Math.floor(c[1] / cellM);
    const e = grid.get(k) || { count: 0, area: 0 };
    e.count++; e.area += ringArea(fp);
    grid.set(k, e);
  }
  return grid;
}

/**
 * cell が「OSM >> PLATEAU の sparse-mismatch」か。
 * @param {{count,area}|undefined} plat  PLATEAU の cell 統計
 * @param {{count,area}} osm             OSM の cell 統計
 */
export function isSparseMismatch(plat, osm) {
  if (!osm || osm.count < SPARSE_MIN_OSM_COUNT) return false;
  const pa = Math.max((plat && plat.area) || 0, SPARSE_PLATEAU_AREA_FLOOR);
  return osm.area / pa >= SPARSE_AREA_RATIO;
}

/** 点がリング内か（ray casting）。 */
export function pointInRingXZ(x, z, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) ins = !ins;
  }
  return ins;
}

/** PLATEAU footprint の bbox spatial grid（polygon レベル duplicate 判定用）。 */
export function buildPlateauDedupIndex(footprints, cellM = 40) {
  const grid = new Map();
  for (const fp of footprints) {
    if (!Array.isArray(fp) || fp.length < 3) continue;
    const b = ringBbox(fp);
    const rec = { fp, b };
    for (let cx = Math.floor(b.minX / cellM); cx <= Math.floor(b.maxX / cellM); cx++)
      for (let cz = Math.floor(b.minZ / cellM); cz <= Math.floor(b.maxZ / cellM); cz++) {
        const k = cx + ',' + cz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(rec);
      }
  }
  return { grid, cellM };
}

function bboxIoU(a, b) {
  const ox = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const oz = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
  const inter = ox * oz;
  const ua = (a.maxX - a.minX) * (a.maxZ - a.minZ) + (b.maxX - b.minX) * (b.maxZ - b.minZ) - inter;
  return ua > 0 ? inter / ua : 0;
}

/**
 * OSM footprint が既存 PLATEAU footprint の duplicate か（polygon レベル・近接距離では判定しない）。
 *   - OSM centroid が PLATEAU polygon 内、または
 *   - bbox IoU >= iouThresh
 * @param {number[][]} osmFp
 * @param {{grid,cellM}} index  buildPlateauDedupIndex の戻り値
 */
export function isDuplicateOfPlateau(osmFp, index, iouThresh = 0.30) {
  if (!index || !index.grid) return false;
  const c = ringCentroid(osmFp);
  const b = ringBbox(osmFp);
  const cm = index.cellM;
  for (let cx = Math.floor(b.minX / cm); cx <= Math.floor(b.maxX / cm); cx++)
    for (let cz = Math.floor(b.minZ / cm); cz <= Math.floor(b.maxZ / cm); cz++) {
      const bucket = index.grid.get(cx + ',' + cz);
      if (!bucket) continue;
      for (const rec of bucket) {
        if (pointInRingXZ(c[0], c[1], rec.fp)) return true;
        if (bboxIoU(b, rec.b) >= iouThresh) return true;
      }
    }
  return false;
}

/**
 * OSM building（footprint + tags）を fallback building レコードへ変換する。
 * @param {string|number} osmId
 * @param {number[][]} footprint
 * @param {object} tags
 * @param {string} [fallbackReason]
 * @param {string|null} [wardId]  centroid が属する区（build 側で wardAt() 判定。境界外・不安定は null）
 * @returns {{id, fp, z0, dz, h, usage, normalizedUsage, usageCategory, usageLabel, ulabel, wardId,
 *            repX, repZ, repMethod, source, osmId, heightSource, heightUnknown, confidence}}
 */
export function toFallbackRecord(osmId, footprint, tags, fallbackReason, wardId) {
  const h = resolveOsmHeight(tags);
  const u = resolveFallbackUsage((tags || {}).building);
  const c = ringCentroid(footprint);
  // [§6/§10] 実測（osm-height / osm-levels）は renderHeight = 実高。class-default / generic は「表示用」の
  //   現実的な推定値を renderHeight に入れるが heightUnknown は true のまま（Mission10 高さ階級に入れない）。
  const renderHeight = +h.dz.toFixed(2);
  return {
    id: 'osm_' + osmId,
    fp: footprint,
    z0: 0,
    dz: renderHeight,
    h: renderHeight,
    renderHeight,
    actualHeight: h.heightUnknown ? null : renderHeight,
    usage: u.usage, // [Mission29 §2] building タグ値（generic は null。既存互換）
    normalizedUsage: u.normalizedUsage, // [fallback色] 非 null（generic は 'yes'）
    usageCategory: u.category,           // [fallback色] 描画カテゴリ（HTML プリセットキー）。非 null
    usageLabel: u.usageLabel,            // [fallback色] popup 表示用の整形済み日本語名。非 null
    ulabel: 'OSM建物（PLATEAU欠落補完）',
    wardId: wardId != null ? wardId : null, // [fallback範囲] centroid が属する区（境界外・不安定は null）
    repX: +c[0].toFixed(2),
    repZ: +c[1].toFixed(2),
    repMethod: 'centroid',
    source: 'osm-fallback',
    osmId: 'way/' + osmId,
    heightSource: h.heightSource,
    heightUnknown: h.heightUnknown,
    confidence: +h.confidence.toFixed(2), // [Mission29 §11]
    fallbackReason: fallbackReason || 'hole',
  };
}
