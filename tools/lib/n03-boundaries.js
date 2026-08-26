// tools/lib/n03-boundaries.js
// 国土交通省「国土数値情報 N03 行政区域データ」の取り込み・スキーマ検証。
//
// 【背景・ユーザー判断】AUTODEV_REPORT.md 2026-08-26 USER_DECISION（P1-1）で、行政区境界の
// canonical sourceはN03行政区域データとすることが確定した。実N03ファイルの取得を待たず、
// まずschema検証・取り込みロジック自体をsynthetic fixtureで検証する段階（P1-1 continuation）。
//
// 【検証対象フィールド(ユーザー確定)】N03_001, N03_004, N03_005, N03_007 + Polygon/MultiPolygon geometry。
// N03_007の意味論はこの時点では未確認のため、値の存在・非空文字列であることのみ検証し、
// 意味を持つフィールド名へは変換しない(sourcePropertiesとして原文のまま保持する)。
// N03_005(5桁行政区域コード)は config/wards/registry.json の各区の code フィールドと同じ
// JIS行政区域コードをそのまま指すため、この一致判定で大阪市24区を安全に判定できる。
//
// 実データ投入時にこのスキーマと一致しない場合は、推測で補正せず例外を投げて処理を中止する
// (fail-fast。1件だけスキップして処理を続行する既存のe-Stat取り込みツールとは意図的に方針を変えている)。
import { validateGeometryStructure, convertGeometryToRings } from './geojson-geometry.js';

export const REQUIRED_N03_PROPS = ['N03_001', 'N03_004', 'N03_005', 'N03_007'];
export const TARGET_PREFECTURE = '大阪府';

function describeFeature(feature, index) {
  const code = feature?.properties?.N03_005;
  return `feature[${index}]${code ? ` (N03_005=${code})` : ''}`;
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
 * - N03_001が「大阪府」かつN03_005がregistryのいずれかの区codeと一致 → 対象区
 *   (ただしN03_004にその区名が含まれていない場合は、コードと名称の不一致としてfail-fast)
 * - N03_001が「大阪府」かつN03_004に「大阪市」を含むがN03_005がどの区codeとも一致しない
 *   → 想定外のデータとしてfail-fast(黙って除外しない)
 * - N03_001が「大阪府」だが大阪市に無関係(他市町村) → スコープ外(正常)
 */
export function resolveWardScope(props, registry, feature, index) {
  if (props.N03_001 !== TARGET_PREFECTURE) {
    return { inScope: false };
  }
  const ward = registry.wards.find((w) => w.code === props.N03_005);
  if (ward) {
    if (!props.N03_004.includes(ward.name)) {
      throw new Error(
        `${describeFeature(feature, index)}: N03_005="${props.N03_005}" はregistry上「${ward.name}」だが、` +
        `N03_004="${props.N03_004}" に区名が含まれていません。コードと名称が不一致のため取り込みを中止します。`
      );
    }
    return { inScope: true, wardId: ward.id, wardCode: ward.code, wardName: ward.name };
  }
  if (props.N03_004.includes(registry.city)) {
    throw new Error(
      `${describeFeature(feature, index)}: N03_004="${props.N03_004}" は${registry.city}を含みますが、` +
      `N03_005="${props.N03_005}" はconfig/wards/registry.jsonのどの区codeとも一致しません。` +
      `未知の区、またはコード不一致のため取り込みを中止します。`
    );
  }
  return { inScope: false };
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
  const records = [];
  const seenWardCodes = new Map();
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

    if (seenWardCodes.has(scope.wardCode)) {
      throw new Error(
        `区code "${scope.wardCode}"(${scope.wardName}) が複数回出現しています` +
        `(feature[${seenWardCodes.get(scope.wardCode)}] と feature[${index}])。重複データのため取り込みを中止します。`
      );
    }
    seenWardCodes.set(scope.wardCode, index);

    const geometry = projection
      ? { coordinatesConverted: true, coordinateConvention: 'znorth-neg-v1', rings: convertGeometryToRings(feature.geometry, projection) }
      : { coordinatesConverted: false, coordinateConvention: null, raw: feature.geometry };

    records.push({
      wardId: scope.wardId,
      wardCode: scope.wardCode,
      wardName: scope.wardName,
      geometryType: feature.geometry.type,
      geometry,
      sourceProperties: {
        N03_001: props.N03_001,
        N03_004: props.N03_004,
        N03_005: props.N03_005,
        N03_007: props.N03_007,
      },
      boundarySourceType: 'official-n03-administrative-boundaries',
      officialAttributes: true,
      officialBoundary: true,
      boundaryDataStatus: 'official',
    });
  });

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
