// tools/convert/facilities-extended.js
// OSM Overpassの生データ -> 拡張施設レコード(facilities.json)への変換。
//
// 【既存のtools/convert/facilities.jsとの関係】既存ファイルは、LabelLayer専用の
// 軽量形式({name,category,priority,p})を生成する古い実装であり、7カテゴリのみを対象とする。
// 本ファイルは新しい拡張施設レコード形式(緯度経度を保持し、住所・営業時間等の項目を持つ)を
// 生成する別の変換処理であり、既存ファイルは変更せず保持する(移行期間中は両方が並存する)。
import { geoToLocal } from '../lib/projection.js';
import { haversineDistanceMeters } from '../lib/distance.js';
import { normalizeChochoName } from '../lib/chocho-normalize.js'; // 全角半角統一等、町丁目名と同じ正規化規則を流用する

/**
 * OSM要素(node/way/relation)の代表座標(緯度経度)を取得する。
 */
function elementCenter(el) {
  if (el.type === 'node') return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon }; // out center; で取得した場合
  if (el.geometry && el.geometry.length) {
    const lat = el.geometry.reduce((s, p) => s + p.lat, 0) / el.geometry.length;
    const lon = el.geometry.reduce((s, p) => s + p.lon, 0) / el.geometry.length;
    return { lat, lon };
  }
  return null;
}

/**
 * 名称が正規表現パターン配列のいずれかに一致するか判定する。
 */
function matchesAnyPattern(name, patterns) {
  if (!name) return false;
  return patterns.some((p) => new RegExp(p).test(name));
}

/**
 * 宗教施設(神社・寺院)を、amenity=place_of_worshipタグ単独で決め打ちせず、
 * religion/denomination/nameの組み合わせで判定する(ご指示通り)。
 */
function classifyReligiousFacility(tags, name, religiousRules) {
  if (tags.amenity !== 'place_of_worship') return null;

  if (tags.religion === 'shinto') return { category: 'tourism', subcategory: 'shrine' };
  if (tags.religion === 'buddhist') return { category: 'tourism', subcategory: 'temple' };

  // religionタグが無い、または上記以外の場合、名称パターンで補助判定する。
  // ただし名称からの推測であることをreasonとして残し、確証度の違いを記録する。
  if (matchesAnyPattern(name, religiousRules.shrineNamePatterns)) {
    return { category: 'tourism', subcategory: 'shrine', classifiedBy: 'name-pattern' };
  }
  if (matchesAnyPattern(name, religiousRules.templeNamePatterns)) {
    return { category: 'tourism', subcategory: 'temple', classifiedBy: 'name-pattern' };
  }
  // place_of_worshipだが神社・寺院いずれにも該当しない(教会等の可能性)
  return { category: 'tourism', subcategory: 'place_of_worship' };
}

/**
 * OSMタグから大分類(category)・小分類(subcategory)を決定する。
 * 分類できない場合はcategory:"unknown"を返す(削除しない)。
 */
export function classifyTags(tags, name, facilityConfig) {
  if (!tags) return { category: 'unknown', subcategory: null };

  // 宗教施設は専用ロジックで先に判定する(単一タグだけで決めつけない)
  const religious = classifyReligiousFacility(tags, name, facilityConfig.religiousFacilityRules);
  if (religious) return religious;

  // historic=* は値の種類が非常に多いため、専用処理で値そのものをsubcategoryに使う
  if (tags.historic) {
    return {
      category: facilityConfig.historicRules.categoryFor,
      subcategory: `${facilityConfig.historicRules.subcategoryPrefix}${tags.historic}`,
    };
  }

  // healthcare=* はワイルドカード指定(値を問わない)のルールとして扱う
  for (const rule of facilityConfig.rules) {
    if (rule.value === '*') {
      if (tags[rule.tag] != null) return { category: rule.category, subcategory: rule.subcategory };
      continue;
    }
    if (tags[rule.tag] === rule.value) return { category: rule.category, subcategory: rule.subcategory };
  }

  return { category: 'unknown', subcategory: null };
}

/**
 * 緯度経度が有効な数値で、かつ指定bbox内にあるかを検証する。
 */
function isValidCoordinateInBbox(lat, lon, bbox) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  if (bbox) {
    if (lat < bbox.south || lat > bbox.north || lon < bbox.west || lon > bbox.east) return false;
  }
  return true;
}

/**
 * 簡易的な名称正規化(全角半角統一・空白除去)。施設名は町丁目名とは異なる対象だが、
 * 同じ正規化規則(normalizeChochoName)を流用することで、別の正規化実装を増やさない
 * （ご指示「全角半角の名称差」テストにも対応する）。
 */
export function normalizeFacilityName(name) {
  if (!name) return '';
  return normalizeChochoName(name);
}

/**
 * OSM要素配列を拡張施設レコードへ変換する。
 * @param {object[]} rawElements Overpass APIの`elements`配列
 * @param {object} projection areaConfig.projection
 * @param {object} bbox areaConfig.bbox（対象範囲外の座標を除外するため）
 * @param {object} facilityConfig config/facilities/categories.json の内容
 * @param {{provider:string, license:string, attribution:string, downloadedAt:string}} sourceMeta
 * @returns {{records: object[], skipped: object[]}}
 */
export function convertFacilitiesExtended(rawElements, projection, bbox, facilityConfig, sourceMeta) {
  const records = [];
  const skipped = [];

  for (const el of rawElements) {
    const tags = el.tags || {};
    const name = tags['name:ja'] || tags.name || null;
    const center = elementCenter(el);

    if (!center) {
      skipped.push({ sourceId: `${el.type}/${el.id}`, reason: 'no-coordinates' });
      continue;
    }
    if (!isValidCoordinateInBbox(center.lat, center.lon, bbox)) {
      skipped.push({ sourceId: `${el.type}/${el.id}`, reason: 'invalid-or-out-of-bbox-coordinates', lat: center.lat, lon: center.lon });
      continue;
    }
    if (!name) {
      // 名称なし施設は削除せず、category:unknown相当として記録だけ残す方針もあり得るが、
      // 施設カードに表示する名称が無いと利用者に意味のある情報を提供できないため、
      // 「名称なし」を理由に記録からは除外し、検証レポート側で件数を確認できるようにする。
      skipped.push({ sourceId: `${el.type}/${el.id}`, reason: 'no-name' });
      continue;
    }

    const { category, subcategory, classifiedBy } = classifyTags(tags, name, facilityConfig);
    const { x, z } = geoToLocal(center.lat, center.lon, projection);

    records.push({
      id: `osm-${el.type}-${el.id}`,
      name,
      normalizedName: normalizeFacilityName(name),
      category,
      subcategory,
      classifiedBy: classifiedBy || 'tag-rule',
      latitude: center.lat,
      longitude: center.lon,
      localX: x,
      localZ: z,
      address: tags['addr:full'] || (tags['addr:city'] && tags['addr:housenumber']
        ? `${tags['addr:city'] || ''}${tags['addr:block_number'] || ''}${tags['addr:housenumber'] || ''}` : null) || null,
      phone: tags.phone || tags['contact:phone'] || null,
      website: tags.website || tags['contact:website'] || null,
      openingHours: tags.opening_hours || null,
      wheelchair: tags.wheelchair || 'unknown',
      source: sourceMeta.provider,
      sourceId: `${el.type}/${el.id}`,
      license: sourceMeta.license,
      attribution: sourceMeta.attribution,
      referenceDate: null, // OSMには公式な「基準日」が無いため、データ自体の日付情報は無いことを明示する
      downloadedAt: sourceMeta.downloadedAt,
      calculationMode: null, // 個別施設データ自体には適用されない(周辺検索結果に付与するフィールド)
      sources: [sourceMeta.provider],
      sourceIds: [`${el.type}/${el.id}`],
      duplicateCandidates: [], // detectDuplicateCandidates()で後段から設定する
      preferredSource: sourceMeta.provider,
    });
  }

  return { records, skipped };
}

/**
 * 同名・近距離の施設を重複候補として検出する。自動削除・自動統合は行わず、
 * 各レコードのduplicateCandidatesフィールドへ「候補のID一覧」を追記するのみとする。
 * @param {object[]} records convertFacilitiesExtendedの出力
 * @param {number} distanceThresholdM 重複候補とみなす距離のしきい値(メートル)
 * @returns {object[]} duplicateCandidatesが設定されたレコード配列(同じ配列を変更して返す)
 */
export function detectDuplicateCandidates(records, distanceThresholdM = 50) {
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i], b = records[j];
      if (a.category !== b.category) continue; // カテゴリが異なる場合は重複候補としない

      const nameMatch = a.normalizedName && b.normalizedName && (
        a.normalizedName === b.normalizedName ||
        a.normalizedName.includes(b.normalizedName) ||
        b.normalizedName.includes(a.normalizedName)
      );
      const phoneMatch = a.phone && b.phone && a.phone === b.phone;
      const addressMatch = a.address && b.address && a.address === b.address;

      if (!nameMatch && !phoneMatch && !addressMatch) continue;

      const dist = haversineDistanceMeters(a.latitude, a.longitude, b.latitude, b.longitude);
      if (dist > distanceThresholdM) continue;

      a.duplicateCandidates.push({ id: b.id, distanceMeters: Math.round(dist * 10) / 10, matchedBy: { nameMatch, phoneMatch, addressMatch } });
      b.duplicateCandidates.push({ id: a.id, distanceMeters: Math.round(dist * 10) / 10, matchedBy: { nameMatch, phoneMatch, addressMatch } });
    }
  }
  return records;
}
