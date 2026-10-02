// tools/lib/canonical-geometry-schema.js
// [Mission 31A] Live City Canonical Urban Geometry の schema・source priority・confidence・conflict QA。
// ══════════════════════════════════════════════════════════════════════════════════
// 目的（Mission 31A §1-8）:
//   Source Data → Canonical Urban Geometry → Attributes → LOD/Tile → Style/3D
//   の 2 段目「Live City が正式採用する都市基盤形状」の内部表現を定義する。
//
// 原則:
//   - geometry（where）と attribute（what）と style（how it looks）を分離する。
//   - canonical feature は「表示色・材質・LOD」を一切持たない。純粋な地理形状 + provenance + confidence。
//   - source missing は生成しない（推測ポリゴンを作らない）。
//   - 座標は znorth-neg-v1（x=(lon-135.52502)*cos(34.604208°)*111320, z=-((lat-34.604208)*111320)）。
//   - THREE 非依存。Node 18+ 組み込みのみ。
//
// このファイルは「設計の正本」。31B 以降の build ツールがこの schema/priority を config として読む。
// ══════════════════════════════════════════════════════════════════════════════════

/** canonical geometry の座標規約（既存パイプライン全体と一致。変更禁止）。 */
export const COORDINATE_CONVENTION = 'znorth-neg-v1';

/** canonical layer 一覧（Mission 31A §1）。 */
export const CANONICAL_LAYERS = Object.freeze(['land', 'buildings', 'roads', 'water', 'parks', 'rail', 'administrative']);

/** 各 canonical layer の許容 geometryType。 */
export const LAYER_GEOMETRY_TYPES = Object.freeze({
  land: ['Polygon', 'MultiPolygon'],
  buildings: ['Polygon', 'MultiPolygon'],
  roads: ['Polygon', 'MultiPolygon'],       // canonical は「道路区域」。centerline は centerlineRef で参照
  water: ['Polygon', 'MultiPolygon'],       // canonical は「水域ポリゴン」。centerline は centerlineRef で参照
  parks: ['Polygon', 'MultiPolygon'],
  rail: ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'],
  administrative: ['Polygon', 'MultiPolygon'],
});

export const GEOMETRY_TYPES = Object.freeze(['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString', 'Point']);

// ── source の役割（Mission 31A §2）─────────────────────────────────────────────
//   同一 source を「位置を決める（geometry）」と「属性を付ける（attribute）」に分けて考える。
export const GEOMETRY_ROLE = Object.freeze({ PRIMARY: 'geometry-primary', FALLBACK: 'geometry-fallback', REFERENCE: 'geometry-reference', NONE: 'geometry-none' });
export const ATTRIBUTE_ROLE = Object.freeze({ PRIMARY: 'attribute-primary', SUPPLEMENT: 'attribute-supplement', NONE: 'attribute-none' });

// ── source registry（Mission 31A §2）───────────────────────────────────────────
//   Live City が扱う source と、その素性。license / 取得状況 / 精度メモ。
export const SOURCE_REGISTRY = Object.freeze({
  'plateau-building': { label: 'PLATEAU 建物 (bldg:Building LOD1/2)', license: 'PLATEAU (国交省, CC BY 4.0 相当)', geometryRole: GEOMETRY_ROLE.PRIMARY, attributeRole: ATTRIBUTE_ROLE.PRIMARY, precisionM: 1.0, note: '大阪市 574,112 棟。footprint / 高さ / 用途コード。' },
  'plateau-tran-road': { label: 'PLATEAU 交通 (tran:Road lod1MultiSurface = 道路区域面)', license: 'PLATEAU (国交省) CC BY 4.0', geometryRole: GEOMETRY_ROLE.PRIMARY, attributeRole: ATTRIBUTE_ROLE.SUPPLEMENT, precisionM: 1.0, note: '31C2 で取得（27100 大阪市 2025 CityGML / udx/tran 288 file / 198,536 道路面）。24 区全域を被覆し、OSM centerline サンプルの 94% が polygon 内側。属性は行政種別（Road_function）と構造区分（sectionType）のみで、名称・車線数は持たないため attributeRole は SUPPLEMENT。' },
  'osm-building': { label: 'OSM building=* ways', license: 'ODbL 1.0', geometryRole: GEOMETRY_ROLE.FALLBACK, attributeRole: ATTRIBUTE_ROLE.SUPPLEMENT, precisionM: 3.0, note: 'PLATEAU 欠落セルのみ補完（Mission 29）。' },
  'osm-road-centerline': { label: 'OSM highway=* centerline', license: 'ODbL 1.0', geometryRole: GEOMETRY_ROLE.FALLBACK, attributeRole: ATTRIBUTE_ROLE.PRIMARY, precisionM: 4.0, note: 'centerline + width 推定。canonical では centerlineRef + 推定幅で区域化。' },
  'osm-area-highway': { label: 'OSM area:highway=* / highway polygon', license: 'ODbL 1.0', geometryRole: GEOMETRY_ROLE.FALLBACK, attributeRole: ATTRIBUTE_ROLE.SUPPLEMENT, precisionM: 3.0, note: '歩行者空間・広場中心。車道網の面カバレッジは低い（31C で計測）。' },
  'osm-water-polygon': { label: 'OSM natural=water / water=* polygon', license: 'ODbL 1.0', geometryRole: GEOMETRY_ROLE.PRIMARY, attributeRole: ATTRIBUTE_ROLE.SUPPLEMENT, precisionM: 3.0, note: '池・広い川。waterways tile の kind=area。' },
  'osm-riverbank': { label: 'OSM waterway=riverbank / water=river polygon', license: 'ODbL 1.0', geometryRole: GEOMETRY_ROLE.PRIMARY, attributeRole: ATTRIBUTE_ROLE.SUPPLEMENT, precisionM: 3.0, note: '河道ポリゴン。大川の実測幅 87.9m はここから（10 枚一致）。' },
  'osm-waterway-centerline': { label: 'OSM waterway=river/canal/stream centerline', license: 'ODbL 1.0', geometryRole: GEOMETRY_ROLE.FALLBACK, attributeRole: ATTRIBUTE_ROLE.PRIMARY, precisionM: 4.0, note: 'centerline + measured/tag/default 幅。riverbank が無い水路向け。' },
  'osm-park-polygon': { label: 'OSM leisure=park / boundary=protected_area polygon', license: 'ODbL 1.0', geometryRole: GEOMETRY_ROLE.PRIMARY, attributeRole: ATTRIBUTE_ROLE.PRIMARY, precisionM: 3.0, note: '公園ポリゴン。' },
  'osm-rail': { label: 'OSM railway=rail/subway/light_rail', license: 'ODbL 1.0', geometryRole: GEOMETRY_ROLE.PRIMARY, attributeRole: ATTRIBUTE_ROLE.PRIMARY, precisionM: 4.0, note: '線路 centerline。' },
  'n03-administrative': { label: '国土数値情報 N03 行政区域 2026', license: '国土数値情報 利用約款（出典明記）', geometryRole: GEOMETRY_ROLE.PRIMARY, attributeRole: ATTRIBUTE_ROLE.PRIMARY, precisionM: 1.0, note: '大阪市 24 区界。canonical administrative の唯一 source。' },
  'official-water-boundary': { label: '公的 水涯線 / 水域ポリゴン（国土地理院等）', license: '（未取得・要調査）', geometryRole: GEOMETRY_ROLE.PRIMARY, attributeRole: ATTRIBUTE_ROLE.NONE, precisionM: 0.5, note: '将来の water 一次 source 候補。31B で取得可否を評価。' },
  'official-road-area': { label: '公的 道路区域データ（道路基盤地図情報等）', license: '（未取得・要調査）', geometryRole: GEOMETRY_ROLE.PRIMARY, attributeRole: ATTRIBUTE_ROLE.NONE, precisionM: 0.5, note: '将来の roads 一次 source 候補。31C で取得可否を評価。' },
  'land-surface-derived': { label: 'Live City land-surface（N03 陸域ラスタ由来）', license: '派生 (N03)', geometryRole: GEOMETRY_ROLE.PRIMARY, attributeRole: ATTRIBUTE_ROLE.NONE, precisionM: 50, note: '陸/海の面。canonical land の暫定 source。' },
});

// ── source priority table（Mission 31A §3）─────────────────────────────────────
//   各 canonical layer で geometry を決める source の優先順。上から順に採用。
//   最後の要素は必ず「source missing は生成しない」。
export const SOURCE_PRIORITY = Object.freeze({
  buildings: [
    { rank: 1, sourceId: 'plateau-building', geometryRole: GEOMETRY_ROLE.PRIMARY, note: 'PLATEAU footprint を最優先。破壊・置換しない。' },
    { rank: 2, sourceId: 'osm-building', geometryRole: GEOMETRY_ROLE.FALLBACK, note: 'PLATEAU 欠落セルのみ。duplicate suppression / invalid filter / ward assignment は Mission 29 を再利用。' },
    { rank: 99, sourceId: null, geometryRole: GEOMETRY_ROLE.NONE, note: 'source missing は生成しない。' },
  ],
  roads: [
    { rank: 1, sourceId: 'official-road-area', geometryRole: GEOMETRY_ROLE.PRIMARY, note: '公的道路区域ポリゴンがあれば最優先（未取得。31C で評価）。' },
    { rank: 2, sourceId: 'plateau-tran-road', geometryRole: GEOMETRY_ROLE.PRIMARY, note: 'PLATEAU tran:Road lod1 道路区域面。31C2 で取得・採用済み（polygon-first の実体）。' },
    { rank: 3, sourceId: 'osm-road-centerline', geometryRole: GEOMETRY_ROLE.FALLBACK, note: 'OSM centerline + width 推定で区域化。tran polygon と対応しない区間の fallback、および属性（名称・車線数・bridge/tunnel）の PRIMARY source。' },
    { rank: 4, sourceId: 'osm-area-highway', geometryRole: GEOMETRY_ROLE.REFERENCE, note: '歩行者空間・広場の補助。車道網カバレッジは低い。' },
    { rank: 99, sourceId: null, geometryRole: GEOMETRY_ROLE.NONE, note: 'source missing は生成しない。' },
  ],
  water: [
    { rank: 1, sourceId: 'official-water-boundary', geometryRole: GEOMETRY_ROLE.PRIMARY, note: '公的水域ポリゴン / 水涯線があれば最優先（未取得。31B で評価）。' },
    { rank: 2, sourceId: 'osm-riverbank', geometryRole: GEOMETRY_ROLE.PRIMARY, note: 'OSM riverbank / water=river ポリゴン（大川の実河道 87.9m の source）。' },
    { rank: 3, sourceId: 'osm-water-polygon', geometryRole: GEOMETRY_ROLE.PRIMARY, note: 'OSM natural=water ポリゴン（池・広い川）。' },
    { rank: 4, sourceId: 'osm-waterway-centerline', geometryRole: GEOMETRY_ROLE.FALLBACK, note: 'centerline + measured/tag/default 幅で区域化（riverbank が無い水路）。' },
    { rank: 99, sourceId: null, geometryRole: GEOMETRY_ROLE.NONE, note: 'source missing は生成しない。' },
  ],
  parks: [
    { rank: 1, sourceId: 'osm-park-polygon', geometryRole: GEOMETRY_ROLE.PRIMARY, note: 'OSM / 公的公園ポリゴン。' },
    { rank: 99, sourceId: null, geometryRole: GEOMETRY_ROLE.NONE, note: 'source 不足時は推測生成しない。' },
  ],
  rail: [
    { rank: 1, sourceId: 'osm-rail', geometryRole: GEOMETRY_ROLE.PRIMARY, note: 'OSM 線路 geometry。' },
    { rank: 2, sourceId: 'plateau-tran-road', geometryRole: GEOMETRY_ROLE.FALLBACK, note: '必要なら PLATEAU 等の補助（未評価）。' },
    { rank: 99, sourceId: null, geometryRole: GEOMETRY_ROLE.NONE, note: 'source missing は生成しない。' },
  ],
  administrative: [
    { rank: 1, sourceId: 'n03-administrative', geometryRole: GEOMETRY_ROLE.PRIMARY, note: 'N03 が唯一 source。' },
    { rank: 99, sourceId: null, geometryRole: GEOMETRY_ROLE.NONE, note: '推測しない。' },
  ],
  land: [
    { rank: 1, sourceId: 'official-water-boundary', geometryRole: GEOMETRY_ROLE.PRIMARY, note: '公的水涯線で陸/海を確定できれば最優先（未取得）。' },
    { rank: 2, sourceId: 'land-surface-derived', geometryRole: GEOMETRY_ROLE.PRIMARY, note: 'N03 陸域由来の面（暫定）。' },
    { rank: 99, sourceId: null, geometryRole: GEOMETRY_ROLE.NONE, note: '推測しない。' },
  ],
});

// ── confidence 設計（Mission 31A §5）───────────────────────────────────────────
//   数値は「設計案」。build ツールはこの表を参照して confidence を割り当てる。
export const CONFIDENCE = Object.freeze({
  OFFICIAL_HIGH_PRECISION_POLYGON: 1.00, // 公的高精度ポリゴン（道路区域 / 水涯線 / N03）
  PLATEAU_BUILDING_FOOTPRINT: 0.95,      // PLATEAU building footprint
  // [31C2 §24] PLATEAU tran:Road lod1 道路区域面。geometry の出所は 3 段階とも同一（公的実測面）で、
  //   差は「OSM centerline による独立検証がどれだけ効いたか」。geometry そのものの品質に反映する。
  PLATEAU_ROAD_POLYGON_VERIFIED: 0.95,   // OSM centerline match STRONG（独立検証あり）
  PLATEAU_ROAD_POLYGON_PARTIAL: 0.92,    // match MEDIUM（部分検証）
  PLATEAU_ROAD_POLYGON_UNVERIFIED: 0.90, // 対応する OSM centerline なし（検証手段なし・OSM 欠測域を含む）
  OSM_WATER_POLYGON: 0.90,               // OSM water / riverbank ポリゴン
  OSM_PARK_POLYGON: 0.88,
  OSM_BUILDING_FOOTPRINT: 0.82,          // OSM fallback building footprint
  OSM_CENTERLINE_WIDTH_TAG: 0.80,        // OSM centerline + width タグ
  OSM_CENTERLINE_MEASURED_WIDTH: 0.78,   // OSM centerline + riverbank 実測幅
  OSM_RAIL_CENTERLINE: 0.75,
  OSM_CENTERLINE_CLASS_DEFAULT_WIDTH: 0.65, // OSM centerline + クラス既定幅
  LAND_SURFACE_DERIVED: 0.55,            // N03 ラスタ由来の粗い陸域面
});
export const CONFIDENCE_MIN = 0.0;
export const CONFIDENCE_MAX = 1.0;
export function isValidConfidence(c) { return typeof c === 'number' && Number.isFinite(c) && c >= CONFIDENCE_MIN && c <= CONFIDENCE_MAX; }

// ── conflict QA（Mission 31A §6/§7）────────────────────────────────────────────
//   canonical layer 同士の矛盾。重なり = 即 ERROR ではない。EXPLAINED を許容する。
export const CONFLICT_PAIRS = Object.freeze([
  { a: 'buildings', b: 'water', code: 'BUILDING_WATER' },
  { a: 'buildings', b: 'roads', code: 'BUILDING_ROAD' },
  { a: 'buildings', b: 'rail', code: 'BUILDING_RAIL' },
  { a: 'roads', b: 'water', code: 'ROAD_WATER' },
  { a: 'parks', b: 'buildings', code: 'PARK_BUILDING' },
  { a: 'land', b: 'water', code: 'LAND_SEA' },
]);

/** conflict の「意味付け」候補（EXPLAINED 理由）。重なりを消すのではなく意味を付ける（§7）。 */
export const CONFLICT_EXPLANATIONS = Object.freeze({
  BUILDING_WATER: ['boat-house', 'pier', 'over-water-structure', 'osm-building-drawn-on-water', 'centerline-offset'],
  BUILDING_ROAD: ['elevated-road', 'building-passage', 'gallery', 'footprint-eave-overhang', 'osm-alignment-error'],
  BUILDING_RAIL: ['station-building', 'elevated-rail', 'rail-over-building', 'track-through-depot-building'],
  ROAD_WATER: ['bridge', 'culvert', 'road-over-water', 'ford'],
  PARK_BUILDING: ['park-facility', 'clubhouse', 'museum-in-park', 'restroom'],
  LAND_SEA: ['reclaimed-boundary-rounding', 'tidal-flat', 'pier'],
});

export const CONFLICT_SEVERITY = Object.freeze(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);

/**
 * 重なりの severity を暫定判定する（§6/§19）。
 *   - EXPLAINED（explanation 付き）→ INFO
 *   - 面積が小さい / 一方の面積比が僅少 → LOW（座標丸め・軒の出）
 *   - confidence 差が大きく低い側が明らかに疑わしい → MEDIUM
 *   - 大面積の相互貫入で説明不能 → HIGH
 */
export function classifyConflictSeverity(opts) {
  const { overlapAreaM2 = 0, aAreaM2 = 0, bAreaM2 = 0, explanation = null } = opts || {};
  if (explanation) return 'INFO'; // EXPLAINED（bridge / station / over-water 構造 / OSM 誤描画 等）
  const minArea = Math.max(1, Math.min(aAreaM2 || Infinity, bAreaM2 || Infinity));
  const frac = overlapAreaM2 / minArea;
  if (overlapAreaM2 < 25 || frac < 0.05) return 'LOW';           // 座標丸め・軒の出レベル
  if (frac >= 0.5 && overlapAreaM2 > 1500) return 'HIGH';         // 説明不能な大面積相互貫入
  if (overlapAreaM2 > 6000) return 'HIGH';
  return 'MEDIUM';
}

// ── layer precedence（Mission 31A §7）─────────────────────────────────────────
//   同じ面を複数 layer が占有する場合、「単純な排他 clip はしない」。
//   confidence + 実形状 QA で判断し、負けた側に qaFlag を立てるだけ（geometry は保持）。
export const LAYER_PRECEDENCE_POLICY = Object.freeze({
  method: 'confidence-and-qa',    // 'water 優先' のような固定順位は使わない
  neverHardClip: ['roads-buildings', 'rail-buildings'], // 高架・建物内通路があるため排他 clip 禁止
  tieBreak: 'higher-confidence-keeps-unflagged',
  note: '重なりは検出して意味を付ける。geometry を書き換えるのは 31E 以降で個別に判断。',
});

// ── 面 source の採用単位（Mission 31C2 §14）─────────────────────────────────────
//   polygon source を採用するときは「source polygon 1 枚 = canonical feature 1 件」を守る。
//   centerline 起点に「その線が通る polygon 群」をまとめて採用すると、交差点や並行道路の面を
//   複数の feature が同時に持ち、面積・conflict 計数が水増しされる（31C2 で実際に起きた）。
export const POLYGON_ADOPTION_POLICY = Object.freeze({
  unit: 'one-source-polygon-one-feature',
  attributeJoin: 'polygon に対応する centerline から属性を join する（geometry は polygon 起点のまま）',
  noUnlimitedUnion: true,
  fallbackRule: 'polygon で表現された centerline には ribbon を重ねない（二重計上の防止）',
  missingAttributes: 'geometry はあるが属性 source が無い場合、属性を捏造せず attributes-source-missing を立てる',
});

// ── geometry helpers（THREE 非依存）────────────────────────────────────────────
/** リング [[x,z],...] の符号付き面積 ×2。 */
function ringSignedArea2(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a;
}
export function ringAreaM2(ring) { return Math.abs(ringSignedArea2(ring)) / 2; }

/** Polygon（[outer, ...holes]）/ MultiPolygon（[[outer,...holes], ...]）の面積。 */
export function polygonAreaM2(geometryType, coordinates) {
  if (geometryType === 'Polygon') {
    if (!Array.isArray(coordinates) || !coordinates.length) return 0;
    let a = ringAreaM2(coordinates[0]);
    for (let i = 1; i < coordinates.length; i++) a -= ringAreaM2(coordinates[i]);
    return Math.max(0, a);
  }
  if (geometryType === 'MultiPolygon') {
    return (coordinates || []).reduce((s, poly) => s + polygonAreaM2('Polygon', poly), 0);
  }
  return 0;
}

/** 全頂点を走査して bbox を取る（型不問）。 */
export function bboxOf(coordinates) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const walk = (v) => {
    if (typeof v[0] === 'number' && typeof v[1] === 'number') {
      if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
      if (v[1] < minZ) minZ = v[1]; if (v[1] > maxZ) maxZ = v[1];
    } else for (const c of v) walk(c);
  };
  if (Array.isArray(coordinates)) walk(coordinates);
  return Number.isFinite(minX) ? { minX, maxX, minZ, maxZ } : null;
}

/** area-weighted な centroid（Polygon の outer ring ベース。MultiPolygon は最大 outer）。 */
export function centroidOf(geometryType, coordinates) {
  let ring = null;
  if (geometryType === 'Polygon') ring = coordinates && coordinates[0];
  else if (geometryType === 'MultiPolygon') {
    let best = 0;
    for (const poly of (coordinates || [])) { const ar = poly[0] ? ringAreaM2(poly[0]) : 0; if (ar > best) { best = ar; ring = poly[0]; } }
  } else if (geometryType === 'LineString') ring = coordinates;
  else if (geometryType === 'Point') return Array.isArray(coordinates) ? [coordinates[0], coordinates[1]] : null;
  else if (geometryType === 'MultiLineString') ring = (coordinates || [])[0];
  if (!Array.isArray(ring) || !ring.length) return null;
  if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') {
    let cx = 0, cz = 0, a = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const cr = p[0] * q[1] - q[0] * p[1];
      a += cr; cx += (p[0] + q[0]) * cr; cz += (p[1] + q[1]) * cr;
    }
    if (Math.abs(a) < 1e-9) { let sx = 0, sz = 0; for (const [x, z] of ring) { sx += x; sz += z; } return [sx / ring.length, sz / ring.length]; }
    a *= 0.5; return [cx / (6 * a), cz / (6 * a)];
  }
  let sx = 0, sz = 0; for (const [x, z] of ring) { sx += x; sz += z; }
  return [sx / ring.length, sz / ring.length];
}

let __idSeq = 0;
/** 決定的でない簡易 id。build ツールは source id ベースの決定的 id を推奨。 */
export function newCanonicalId(layer, hint) {
  __idSeq += 1;
  const h = String(hint || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return `cg_${layer}_${h || 'x'}_${__idSeq.toString(36)}`;
}

/**
 * provenance を作る（Mission 31A §4。canonical feature は必ず持つ）。
 * @param {{geometrySource:string, attributeSources?:string[], confidence:number, sourceIds?:Array, generatedAt?:string, notes?:string}} o
 */
export function makeProvenance(o) {
  const p = o || {};
  return {
    geometrySource: p.geometrySource || null,
    attributeSources: Array.isArray(p.attributeSources) ? p.attributeSources.slice() : [],
    confidence: isValidConfidence(p.confidence) ? p.confidence : null,
    sourceIds: Array.isArray(p.sourceIds) ? p.sourceIds.slice() : [],
    generatedAt: p.generatedAt || new Date().toISOString(),
    notes: p.notes || null,
  };
}

/**
 * canonical feature を組み立てる（Mission 31A §8 schema）。
 *   geometry（where）のみ。style / LOD は持たせない。attributes は what（用途・名前等）に限定。
 */
export function makeCanonicalFeature({ canonicalId, layer, geometryType, coordinates, provenance, attributes, qaFlags, centerlineRef, widthProfile }) {
  const gt = geometryType;
  const bbox = bboxOf(coordinates);
  const areaM2 = (gt === 'Polygon' || gt === 'MultiPolygon') ? +polygonAreaM2(gt, coordinates).toFixed(2) : null;
  const centroid = centroidOf(gt, coordinates);
  return {
    canonicalId: canonicalId || newCanonicalId(layer, (provenance && provenance.sourceIds && provenance.sourceIds[0]) || ''),
    layer,
    geometryType: gt,
    coordinates,
    bbox,
    areaM2,
    centroid: centroid ? [+centroid[0].toFixed(2), +centroid[1].toFixed(2)] : null,
    coordinateConvention: COORDINATE_CONVENTION,
    source: provenance || makeProvenance({}),
    attributes: attributes || {},
    qaFlags: Array.isArray(qaFlags) ? qaFlags : [],
    // water / roads は形状=区域だが、centerline を参照情報として保持できる（§1）
    ...(centerlineRef ? { centerlineRef } : {}),
    ...(widthProfile ? { widthProfile } : {}),
  };
}

const ID_RE = /^[A-Za-z0-9_:.-]{3,80}$/;

/** canonical feature の schema 検証（Mission 31A §18）。 */
export function validateCanonicalFeature(f, { convention = COORDINATE_CONVENTION } = {}) {
  const errors = [];
  if (!f || typeof f !== 'object') return { ok: false, errors: ['feature が object でない'] };
  if (!ID_RE.test(String(f.canonicalId || ''))) errors.push('canonicalId が不正: ' + f.canonicalId);
  if (!CANONICAL_LAYERS.includes(f.layer)) errors.push('layer が不正: ' + f.layer);
  if (!GEOMETRY_TYPES.includes(f.geometryType)) errors.push('geometryType が不正: ' + f.geometryType);
  const allowed = LAYER_GEOMETRY_TYPES[f.layer] || GEOMETRY_TYPES;
  if (f.layer && !allowed.includes(f.geometryType)) errors.push(`${f.layer} に ${f.geometryType} は不可`);
  if (f.coordinateConvention !== convention) errors.push('coordinateConvention 不一致: ' + f.coordinateConvention);
  // coordinates は有限数のみ
  let finite = true, vertexCount = 0;
  const walk = (v) => {
    if (!Array.isArray(v)) { finite = false; return; }
    if (typeof v[0] === 'number' && typeof v[1] === 'number') { vertexCount++; if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) finite = false; }
    else for (const c of v) walk(c);
  };
  walk(f.coordinates || []);
  if (!finite) errors.push('coordinates に非有限値');
  if (vertexCount < ((f.geometryType === 'Point') ? 1 : (/Polygon/.test(f.geometryType) ? 3 : 2))) errors.push('頂点数が不足: ' + vertexCount);
  if (!f.bbox || ['minX', 'maxX', 'minZ', 'maxZ'].some((k) => !Number.isFinite(f.bbox[k]))) errors.push('bbox が不正');
  if (/Polygon/.test(f.geometryType) && !(Number.isFinite(f.areaM2) && f.areaM2 >= 0)) errors.push('areaM2 が不正');
  if (!Array.isArray(f.centroid) || f.centroid.length !== 2 || !f.centroid.every(Number.isFinite)) errors.push('centroid が不正');
  const s = f.source;
  if (!s || typeof s !== 'object') errors.push('provenance（source）が無い');
  else {
    if (!s.geometrySource || !SOURCE_REGISTRY[s.geometrySource]) errors.push('geometrySource が registry に無い: ' + (s && s.geometrySource));
    if (!Array.isArray(s.attributeSources)) errors.push('attributeSources が配列でない');
    if (!isValidConfidence(s.confidence)) errors.push('confidence が不正: ' + (s && s.confidence));
    if (!Array.isArray(s.sourceIds) || s.sourceIds.length === 0) errors.push('sourceIds が空');
    if (!s.generatedAt) errors.push('generatedAt が無い');
  }
  if (!Array.isArray(f.qaFlags)) errors.push('qaFlags が配列でない');
  if (f.attributes && typeof f.attributes !== 'object') errors.push('attributes が object でない');
  return { ok: errors.length === 0, errors };
}

// ── canonical output directory 設計（Mission 31A §9）───────────────────────────
export const CANONICAL_OUTPUT = Object.freeze({
  baseDir: 'data/processed/osaka-city/canonical',
  layout: 'manifest+tile',   // 最初から全量巨大 JSON にしない
  perLayer: {
    // 小さい layer は単一 JSON、大きい layer は manifest + tile。31A は water を単一 prototype で出す。
    land: 'single',
    administrative: 'single',
    water: 'single-then-tile',   // prototype は single。31B で tile 化
    parks: 'single-then-tile',
    rail: 'single-then-tile',
    roads: 'manifest+tile',
    buildings: 'manifest+tile',
  },
  tileSize: 2000,             // roads / parks / rail の既存 tile と揃える
  manifestFields: ['version', 'layer', 'coordinateConvention', 'generatedAt', 'featureCount', 'bbox', 'sourcePriority', 'tiles'],
});

// ── derived（LOD / style）は canonical の外（Mission 31A §15/§16）───────────────
export const DERIVED_OUTPUT = Object.freeze({
  baseDir: 'data/processed/osaka-city/derived',
  bands: ['far', 'mid', 'near', 'ultra-near'],
  note: 'canonical geometry は LOD で削らない。derived/ に simplify + tile clip + merged geometry を生成し、Mission 1〜30 の LOD 成果はこの derived 側へ統合する。',
});

// ── style は canonical の外（Mission 31A §15）──────────────────────────────────
export const STYLE_SEPARATION = Object.freeze({
  rule: 'canonical geometry は表示色・材質を一切持たない',
  styleLayerExamples: { water: '#9ed6e6', road: '#c4c8cc', building: 'usage palette（BLDG_PRESET_OF_USAGE）' },
});
