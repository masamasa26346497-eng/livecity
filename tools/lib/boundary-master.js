// tools/lib/boundary-master.js
// 町丁目境界マスタの読み込み・統合を一箇所に集約する。
//
// 【重要な区別】属性データ(コード・名称・人口・世帯数等)の公式性と、境界形状(ポリゴン座標)の
// 公式性は別の軸である。公式属性データが存在するだけで、暫定TOWN_POLYGONSの境界形状を
// 置き換えてはならない。境界形状の選択優先順位は次の通り:
// 1. 有効な公式Polygon/MultiPolygon（officialBoundary: true, boundaryDataStatus: "official"）
// 2. 暫定TOWN_POLYGONS（officialAttributes有無に関わらず、形状はTOWN_POLYGONSを使う。
//    公式属性と組み合わさる場合は boundaryDataStatus: "official-attributes-with-legacy-geometry"）
// 3. 境界形状なし（boundaryDataStatus: "official-attributes-only" または "legacy-unverified"）
//
// 公式属性データ(data/processed/{areaId}/boundaries/administrative-boundaries.json)と
// 暫定境界データ(data/raw/{areaId}/administrative-boundaries.json、TOWN_POLYGONS由来)の
// 両方を読み込み、レコード単位(boundaryId/originalFullNameで対応付け)で統合する。
// 統計結合(複合キー・正規化名称)には公式属性データのcompositeCode/chochoCode等を使うが、
// 地図描画用のgeometryは、公式側にhasFullPolygon:trueの形状がある場合のみそれを使い、
// それ以外は暫定側のgeometryで補完する。
import path from 'path';
import { rawDir, processedDir, readJsonIfExists } from './area.js';
import { normalizeChochoName } from './chocho-normalize.js';

export const BOUNDARY_STATUS = {
  OFFICIAL: 'official', // 公式属性＋公式ポリゴン形状の両方を保持
  OFFICIAL_ATTRIBUTES_WITH_LEGACY_GEOMETRY: 'official-attributes-with-legacy-geometry', // 公式属性＋暫定形状
  OFFICIAL_ATTRIBUTES_ONLY: 'official-attributes-only', // 公式属性のみ、形状なし
  LEGACY_UNVERIFIED: 'legacy-unverified', // 公式属性なし、暫定データのみ（従来の挙動）
};

export function officialBoundariesPath(areaId) {
  return path.join(processedDir(areaId), 'boundaries', 'administrative-boundaries.json');
}

export function legacyBoundariesPath(areaId) {
  return path.join(rawDir(areaId), 'administrative-boundaries.json');
}

/**
 * 1件の公式属性レコードと、対応する暫定TOWN_POLYGONSレコード(あれば)を統合する。
 * @param {object} officialRecord 公式属性レコード(officialAttributes:trueを必ず持つ)
 * @param {object|null} legacyMatch 同じboundaryIdを持つ暫定レコード(無ければnull)
 */
function mergeOfficialAttributesWithGeometry(officialRecord, legacyMatch) {
  if (officialRecord.hasFullPolygon && officialRecord.geometry) {
    // 優先順位1: 公式属性データ自体が有効なPolygon/MultiPolygonを保持している場合、
    // それを最優先で使う(暫定データは一切参照しない)。
    return {
      ...officialRecord,
      geometrySourceType: 'official-estat-boundaries',
      boundaryDataStatus: BOUNDARY_STATUS.OFFICIAL,
    };
  }

  if (legacyMatch && legacyMatch.geometry) {
    // 優先順位2: 公式属性データには形状が無いが、暫定TOWN_POLYGONS側に同じ町丁目の形状が
    // ある場合、属性は公式データ・形状は暫定データという統合レコードを作る。
    // officialBoundary はあくまで「形状自体が公式かどうか」を表すため false のままにする
    // (公式属性データがあるからといって、暫定形状を公式形状であるかのように扱わない)。
    return {
      ...officialRecord,
      geometry: legacyMatch.geometry,
      hasFullPolygon: true, // 描画可能な形状を持つという意味では true。ただしofficialBoundaryとは独立。
      officialBoundary: false,
      geometrySourceType: 'embedded-html-town-polygons',
      boundaryDataStatus: BOUNDARY_STATUS.OFFICIAL_ATTRIBUTES_WITH_LEGACY_GEOMETRY,
    };
  }

  // 優先順位3: 公式側にも暫定側にも形状が無い。属性のみのレコードとして扱う。
  return {
    ...officialRecord,
    geometrySourceType: null,
    boundaryDataStatus: BOUNDARY_STATUS.OFFICIAL_ATTRIBUTES_ONLY,
  };
}

/**
 * 境界マスタを読み込む。公式属性データと暫定TOWN_POLYGONSデータを、レコード単位で
 * 上記の優先順位に従って統合する。
 *
 * 統合後のmaster配列の各エントリは、必ず次のいずれかの状態になる:
 * - boundaryDataStatus: "official" (officialAttributes:true, officialBoundary:true, hasFullPolygon:true)
 * - boundaryDataStatus: "official-attributes-with-legacy-geometry" (officialAttributes:true,
 *   officialBoundary:false, hasFullPolygon:true, geometrySourceType:"embedded-html-town-polygons")
 * - boundaryDataStatus: "official-attributes-only" (officialAttributes:true, officialBoundary:false,
 *   hasFullPolygon:false)
 * - boundaryDataStatus: "legacy-unverified" (officialAttributes:false, officialBoundary:false,
 *   暫定データのみで公式属性に対応するレコードが無い場合)
 *
 * @returns {{
 *   master: object[],
 *   boundaryDataStatus: string,
 *   officialBoundary: boolean,
 *   boundarySourceType: string,
 *   officialAttributeRecords: number,
 *   officialBoundaryRecords: number,
 *   legacyGeometryRecords: number,
 *   recordsWithoutGeometry: number,
 * }}
 */
export async function loadBoundaryMaster(areaId) {
  let officialData = null;
  try {
    officialData = await readJsonIfExists(officialBoundariesPath(areaId));
  } catch (err) {
    console.warn(`[WARN] 正式境界データの読み込みに失敗しました(${err.message})。暫定境界データのみを使用します。`);
    officialData = null;
  }

  let legacyData = null;
  try {
    legacyData = await readJsonIfExists(legacyBoundariesPath(areaId));
  } catch (err) {
    console.warn(`[WARN] 暫定境界データの読み込みに失敗しました(${err.message})。`);
    legacyData = null;
  }

  const hasOfficial = officialData && Array.isArray(officialData) && officialData.length > 0;
  const hasLegacy = legacyData && Array.isArray(legacyData) && legacyData.length > 0;

  if (!hasOfficial && !hasLegacy) {
    return {
      master: [], boundaryDataStatus: BOUNDARY_STATUS.LEGACY_UNVERIFIED, officialBoundary: false,
      boundarySourceType: 'none', officialAttributeRecords: 0, officialBoundaryRecords: 0,
      legacyGeometryRecords: 0, recordsWithoutGeometry: 0,
    };
  }

  if (!hasOfficial) {
    // 公式属性データが無い場合は、従来通り暫定データのみを使う(後方互換)。
    return {
      master: legacyData,
      boundaryDataStatus: BOUNDARY_STATUS.LEGACY_UNVERIFIED,
      officialBoundary: false,
      boundarySourceType: 'embedded-html-town-polygons',
      officialAttributeRecords: 0,
      officialBoundaryRecords: 0,
      legacyGeometryRecords: legacyData.filter((l) => l.geometry).length,
      recordsWithoutGeometry: legacyData.filter((l) => !l.geometry).length,
    };
  }

  // 暫定データを正規化名称でインデックス化し、公式属性レコードと1件ずつ照合する。
  // 【重要】boundaryIdの厳密な文字列一致では照合できない（公式データは漢数字表記
  // "南住吉一丁目"、TOWN_POLYGONSは算用数字表記"南住吉1丁目"のため）。既存の
  // normalizeChochoName(漢数字↔算用数字等を統一する既存ロジック)で正規化した上で
  // 照合する必要がある。
  const legacyByNormalizedName = new Map();
  if (hasLegacy) {
    for (const l of legacyData) {
      const key = normalizeChochoName(l.originalFullName || l.boundaryId);
      if (key) legacyByNormalizedName.set(key, l);
    }
  }

  const merged = officialData.map((officialRecord) => {
    const normalizedKey = normalizeChochoName(officialRecord.originalFullName || officialRecord.boundaryId);
    const legacyMatch = legacyByNormalizedName.get(normalizedKey) || null;
    return mergeOfficialAttributesWithGeometry(officialRecord, legacyMatch);
  });

  const officialBoundaryRecords = merged.filter((m) => m.boundaryDataStatus === BOUNDARY_STATUS.OFFICIAL).length;
  const legacyGeometryRecords = merged.filter((m) => m.boundaryDataStatus === BOUNDARY_STATUS.OFFICIAL_ATTRIBUTES_WITH_LEGACY_GEOMETRY).length;
  const recordsWithoutGeometry = merged.filter((m) => m.boundaryDataStatus === BOUNDARY_STATUS.OFFICIAL_ATTRIBUTES_ONLY).length;

  // データセット全体としての boundaryDataStatus / officialBoundary は、
  // 「有効な公式形状が1件でも存在するか」を基準に設定する(全体の状態を表す代表値であり、
  // 個々のレコードの状態は各レコードのboundaryDataStatusで確認する)。
  const datasetOfficialBoundary = officialBoundaryRecords > 0;
  const datasetBoundaryDataStatus = officialBoundaryRecords > 0
    ? BOUNDARY_STATUS.OFFICIAL
    : (legacyGeometryRecords > 0 ? BOUNDARY_STATUS.OFFICIAL_ATTRIBUTES_WITH_LEGACY_GEOMETRY : BOUNDARY_STATUS.OFFICIAL_ATTRIBUTES_ONLY);

  return {
    master: merged,
    boundaryDataStatus: datasetBoundaryDataStatus,
    officialBoundary: datasetOfficialBoundary,
    boundarySourceType: 'official-estat-boundaries',
    officialAttributeRecords: merged.length,
    officialBoundaryRecords,
    legacyGeometryRecords,
    recordsWithoutGeometry,
  };
}
