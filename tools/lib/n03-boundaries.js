// tools/lib/n03-boundaries.js
// 国土交通省「国土数値情報 N03 行政区域データ」の取り込み・スキーマ検証。
//
// 【背景・ユーザー判断】AUTODEV_REPORT.md 2026-08-26 USER_DECISION（P1-1）で、行政区境界の
// canonical sourceはN03行政区域データとすることが確定した。実N03ファイルの取得を待たず、
// まずschema検証・取り込みロジック自体をsynthetic fixtureで検証する段階（P1-1 continuation）。
//
// 【検証対象フィールド(ユーザー確定)】N03_001, N03_004, N03_005, N03_007 + Polygon/MultiPolygon geometry。
//
// 【REAL_N03_VALIDATION 2026-08-27で確定した実スキーマ】実N03 2026大阪府GeoJSONで確認済み:
// - N03_004 = 市区町村名("大阪市"等。区名は含まない)
// - N03_005 = 行政区名(例: "都島区"。config/wards/registry.jsonのward.nameと照合する)
// - N03_007 = 5桁の全国地方公共団体コード(config/wards/registry.jsonのward.codeと照合する)
// N03_005/N03_007のどちらか一方でも登録区と一致しない場合はコード/名称不一致としてfail-fastする。
//
// 【複数Feature】同一区(同一N03_005/N03_007)が複数Featureに分かれて出現するのは正常なデータ形
// (実データで大阪市24区が39 Featureに分かれて出現することを確認済み)。重複エラーにはせず、
// 同一区のPolygon/MultiPolygonを1つのward recordへ統合する(mergeGeometriesToMultiPolygon)。
//
// 実データ投入時にこのスキーマと一致しない場合は、推測で補正せず例外を投げて処理を中止する
// (fail-fast。1件だけスキップして処理を続行する既存のe-Stat取り込みツールとは意図的に方針を変えている)。
import { validateGeometryStructure, convertGeometryToRings, mergeGeometriesToMultiPolygon } from './geojson-geometry.js';

export const REQUIRED_N03_PROPS = ['N03_001', 'N03_004', 'N03_005', 'N03_007'];
export const TARGET_PREFECTURE = '大阪府';

function describeFeature(feature, index) {
  const name = feature?.properties?.N03_005;
  const code = feature?.properties?.N03_007;
  if (!name && !code) return `feature[${index}]`;
  return `feature[${index}] (N03_005=${name ?? ''}, N03_007=${code ?? ''})`;
}

/**
 * N03の必須属性(4フィールド)が全て存在し、非空文字列であることを検証する。
 * 1件でも不正ならこの関数は即座に例外を投げる(呼び出し側でスキップせず全体を止める=fail-fast)。
 * @returns {object} feature.properties(検証済み)
 */
export function validateN03Properties(feature, index) {
  const props = feature?.properties;
  if (!props || typeof props !== 'object') {
    throw new Error(`${describeFeature(feature, index)}: propertiesが存在しません。N03スキーマ不一致のため取り込みを中止します。`);
  }
  for (const key of REQUIRED_N03_PROPS) {
    const value = props[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `${describeFeature(feature, index)}: 必須フィールド "${key}" が存在しないか空です` +
        `(実際の値: ${JSON.stringify(value)})。N03スキーマ不一致のため取り込みを中止します。`
      );
    }
  }
  return props;
}

/**
 * 大阪府/大阪市24区の対象範囲を判定する。
 * - N03_001が「大阪府」以外 → スコープ外(正常。全国データの大部分はこれに該当する)
 * - N03_004がregistry.city(「大阪市」)と一致しない → スコープ外(正常。大阪府内の他市町村)
 * - N03_004が「大阪市」かつN03_007(区code)・N03_005(区名)が同一のregistry区を指す → 対象区
 * - N03_004が「大阪市」だがN03_007・N03_005のどちらか一方だけが登録区と一致(コード/名称の
 *   指す区が食い違う、または片方だけ一致) → コード/名称不一致としてfail-fast
 * - N03_004が「大阪市」だがN03_007・N03_005のどちらもどの登録区とも一致しない
 *   → 未知の区としてfail-fast(黙って除外しない)
 */
export function resolveWardScope(props, registry, feature, index) {
  if (props.N03_001 !== TARGET_PREFECTURE) {
    return { inScope: false };
  }
  if (props.N03_004 !== registry.city) {
    return { inScope: false };
  }

  const wardByCode = registry.wards.find((w) => w.code === props.N03_007);
  const wardByName = registry.wards.find((w) => w.name === props.N03_005);

  if (wardByCode && wardByName && wardByCode.id === wardByName.id) {
    return { inScope: true, wardId: wardByCode.id, wardCode: wardByCode.code, wardName: wardByCode.name };
  }
  if (wardByCode || wardByName) {
    throw new Error(
      `${describeFeature(feature, index)}: N03_007="${props.N03_007}"(registry一致先: ${wardByCode ? wardByCode.name : 'なし'}) と` +
      `N03_005="${props.N03_005}"(registry一致先: ${wardByName ? wardByName.name : 'なし'}) が指す区が一致しません。` +
      `コードと名称が不一致のため取り込みを中止します。`
    );
  }
  throw new Error(
    `${describeFeature(feature, index)}: N03_004="${props.N03_004}"は${registry.city}ですが、` +
    `N03_007="${props.N03_007}"・N03_005="${props.N03_005}" はconfig/wards/registry.jsonの` +
    `どの区とも一致しません。未知の区、またはコード/名称不一致のため取り込みを中止します。`
  );
}

/**
 * N03形式のGeoJSON FeatureCollectionを取り込み、大阪市24区分のみを抽出する。
 * @param {object} geojson FeatureCollection
 * @param {object} registry config/wards/registry.json相当のオブジェクト({ city, wards: [...] })
 * @param {{projection?: object}} [options] projectionを渡した場合のみThree.js座標(znorth-neg-v1)へ
 *   変換する。渡さない場合はWGS84のまま構造検証のみ行い、生のgeometryを保持する
 *   (config/areas/osaka-city.jsonがまだ確定していないため、production座標変換は本関数の責務外とする)。
 */
export function ingestN03FeatureCollection(geojson, registry, options = {}) {
  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    throw new Error('入力データがGeoJSON FeatureCollection形式ではありません。');
  }
  if (!registry || !Array.isArray(registry.wards) || typeof registry.city !== 'string') {
    throw new Error('registryにcity/wards配列がありません(config/wards/registry.jsonの構造を確認してください)。');
  }

  const { projection } = options;
  const groups = new Map(); // wardId -> { wardId, wardCode, wardName, sourceProperties, geometries: [] }
  let outOfScopeCount = 0;

  geojson.features.forEach((feature, index) => {
    const props = validateN03Properties(feature, index);
    try {
      validateGeometryStructure(feature.geometry, { allowPoint: false });
    } catch (err) {
      throw new Error(`${describeFeature(feature, index)}: ${err.message}`);
    }

    const scope = resolveWardScope(props, registry, feature, index);
    if (!scope.inScope) {
      outOfScopeCount++;
      return;
    }

    let group = groups.get(scope.wardId);
    if (!group) {
      group = {
        wardId: scope.wardId,
        wardCode: scope.wardCode,
        wardName: scope.wardName,
        sourceProperties: {
          N03_001: props.N03_001,
          N03_004: props.N03_004,
          N03_005: props.N03_005,
          N03_007: props.N03_007,
        },
        geometries: [],
      };
      groups.set(scope.wardId, group);
    }
    group.geometries.push(feature.geometry);
  });

  const records = [];
  for (const group of groups.values()) {
    const isSplit = group.geometries.length > 1;
    const rawGeometry = isSplit ? mergeGeometriesToMultiPolygon(group.geometries) : group.geometries[0];
    const geometryType = rawGeometry.type;

    const geometry = projection
      ? {
          coordinatesConverted: true,
          coordinateConvention: 'znorth-neg-v1',
          rings: group.geometries.flatMap((g) => convertGeometryToRings(g, projection)),
        }
      : { coordinatesConverted: false, coordinateConvention: null, raw: rawGeometry };

    records.push({
      wardId: group.wardId,
      wardCode: group.wardCode,
      wardName: group.wardName,
      geometryType,
      geometry,
      sourceFeatureCount: group.geometries.length,
      sourceProperties: group.sourceProperties,
      boundarySourceType: 'official-n03-administrative-boundaries',
      officialAttributes: true,
      officialBoundary: true,
      boundaryDataStatus: 'official',
    });
  }

  const foundWardIds = new Set(records.map((r) => r.wardId));
  const missingWards = registry.wards
    .filter((w) => !foundWardIds.has(w.id))
    .map((w) => ({ id: w.id, name: w.name, code: w.code }));

  return {
    records,
    recordCount: records.length,
    outOfScopeCount,
    missingWards,
  };
}
