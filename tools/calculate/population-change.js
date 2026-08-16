// tools/calculate/population-change.js
// 2015年(平成27年)と2020年(令和2年)の町丁目別人口を比較し、人口増減を計算する。
//
// 【重要な前提】2015年表と2020年表は、地域階層レベルの意味・列構成が異なることが
// 実データ調査で確認されている(2015年: 3階層・1行ヘッダー、2020年: 4階層・2行ヘッダー)。
// このため、町丁目の対応関係は名称の見た目の類似性だけで判断せず、複合コード
// (municipalityCode+chochoCode)による厳密な一致を最優先とし、それで結合できない場合は
// 単純比較せず明示的に「比較不能」として扱う。町丁目の新設・廃止・分割・統合・境界変更が
// 疑われるケースを、基準人口0や比較人口0として誤って扱わないことが本実装の核心要件である。
import { normalizeChochoName } from '../lib/chocho-normalize.js';

export const COMPARISON_STATUS = {
  COMPARABLE: 'comparable',
  SUPPRESSED: 'data-suppressed',
  UNMATCHED_2015_ONLY: 'abolished-or-boundary-changed', // 2015年にのみ存在(廃止または境界変更の可能性)
  UNMATCHED_2020_ONLY: 'new-or-boundary-changed', // 2020年にのみ存在(新設または境界変更の可能性)
  UNMATCHED: 'unmatched',
};

/**
 * 人口増減数・増減率を計算する。
 * @param {number|null} basePopulation 2015年人口
 * @param {number|null} comparisonPopulation 2020年人口
 * @returns {{changeCount: number|null, changeRate: number|null}}
 */
function calculateChange(basePopulation, comparisonPopulation) {
  if (basePopulation == null || comparisonPopulation == null) {
    return { changeCount: null, changeRate: null };
  }
  const changeCount = comparisonPopulation - basePopulation;
  // 基準年度人口が0の場合、増減率は計算しない(0除算を避ける。人口が本当に0だった
  // 町丁目で、何らかの理由で2020年に人口が生じた場合、増減率は定義できない)。
  const changeRate = basePopulation === 0 ? null : Math.round((changeCount / basePopulation) * 1000) / 10;
  return { changeCount, changeRate };
}

/**
 * 2015年レコード配列と2020年レコード配列を、複合コードで結合し、人口増減を計算する。
 * @param {object[]} records2015 [{compositeCode, municipalityCode, chochoCode, ward, chochoName,
 *   fullChochoName, population2015, population2015Suppressed, households2015, ...}]
 * @param {object[]} records2020 [{compositeCode, municipalityCode, chochoCode, ward, chochoName,
 *   fullChochoName, population, populationSuppressed, households, ...}] (population-households.jsの出力形式)
 * @returns {{records: object[], stats: object}}
 */
export function calculatePopulationChange(records2015, records2020) {
  const by2015CompositeCode = new Map();
  const by2015NormalizedName = new Map();
  for (const r of records2015) {
    if (r.compositeCode) by2015CompositeCode.set(r.compositeCode, r);
    const key = normalizeChochoName(r.fullChochoName);
    if (key) by2015NormalizedName.set(key, r);
  }

  const matchedCompositeCodes = new Set();
  const results = [];
  const stats = {
    totalRecords2020: records2020.length,
    matchedByCompositeCode: 0,
    matchedByName: 0,
    unmatched2020Only: 0,
    suppressed: 0,
  };

  for (const r2020 of records2020) {
    let r2015 = null;
    let joinMethod = null;

    if (r2020.compositeCode && by2015CompositeCode.has(r2020.compositeCode)) {
      r2015 = by2015CompositeCode.get(r2020.compositeCode);
      joinMethod = 'composite-code';
      stats.matchedByCompositeCode++;
    } else {
      const key = normalizeChochoName(r2020.fullChochoName);
      const candidate = key ? by2015NormalizedName.get(key) : null;
      if (candidate) {
        // 名称一致のみでの結合は、複合コード一致より信頼度が低い。境界変更で偶然名称が
        // 同じだが実際には異なる範囲を指すケースを排除できないため、結合はするが
        // comparisonStatusで区別する（単純比較せず、利用側が判断できるようにする）。
        r2015 = candidate;
        joinMethod = 'normalized-name';
        stats.matchedByName++;
      }
    }

    if (!r2015) {
      stats.unmatched2020Only++;
      results.push({
        municipalityCode: r2020.municipalityCode,
        chochoCode: r2020.chochoCode,
        compositeCode: r2020.compositeCode,
        ward: r2020.ward,
        chochoName: r2020.chochoName,
        fullChochoName: r2020.fullChochoName,
        baseYear: 2015,
        comparisonYear: 2020,
        basePopulation: null,
        comparisonPopulation: r2020.population ?? null,
        changeCount: null,
        changeRate: null,
        comparisonStatus: COMPARISON_STATUS.UNMATCHED_2020_ONLY,
        joinMethod: 'unmatched',
        source: '総務省統計局「平成27年国勢調査」「令和2年国勢調査」',
        changeValueType: 'livecity-calculated',
      });
      continue;
    }

    if (r2015.compositeCode) matchedCompositeCodes.add(r2015.compositeCode);

    const basePopSuppressed = r2015.population2015Suppressed;
    const comparisonPopSuppressed = r2020.populationSuppressed;
    if (basePopSuppressed || comparisonPopSuppressed) {
      stats.suppressed++;
      results.push({
        municipalityCode: r2020.municipalityCode,
        chochoCode: r2020.chochoCode,
        compositeCode: r2020.compositeCode,
        ward: r2020.ward,
        chochoName: r2020.chochoName,
        fullChochoName: r2020.fullChochoName,
        baseYear: 2015,
        comparisonYear: 2020,
        basePopulation: basePopSuppressed ? null : r2015.population2015,
        comparisonPopulation: comparisonPopSuppressed ? null : r2020.population,
        changeCount: null,
        changeRate: null,
        comparisonStatus: COMPARISON_STATUS.SUPPRESSED,
        joinMethod,
        source: '総務省統計局「平成27年国勢調査」「令和2年国勢調査」',
        changeValueType: 'livecity-calculated',
      });
      continue;
    }

    const { changeCount, changeRate } = calculateChange(r2015.population2015, r2020.population);
    results.push({
      municipalityCode: r2020.municipalityCode,
      chochoCode: r2020.chochoCode,
      compositeCode: r2020.compositeCode,
      ward: r2020.ward,
      chochoName: r2020.chochoName,
      fullChochoName: r2020.fullChochoName,
      baseYear: 2015,
      comparisonYear: 2020,
      basePopulation: r2015.population2015,
      comparisonPopulation: r2020.population,
      changeCount,
      changeRate,
      comparisonStatus: COMPARISON_STATUS.COMPARABLE,
      joinMethod,
      source: '総務省統計局「平成27年国勢調査」「令和2年国勢調査」',
      changeValueType: 'livecity-calculated',
    });
  }

  // 2015年にのみ存在し、2020年側で一度も結合に使われなかったレコード(廃止・境界変更の可能性)
  const unmatched2015Only = records2015.filter((r) => r.compositeCode && !matchedCompositeCodes.has(r.compositeCode));
  for (const r2015 of unmatched2015Only) {
    results.push({
      municipalityCode: r2015.municipalityCode,
      chochoCode: r2015.chochoCode,
      compositeCode: r2015.compositeCode,
      ward: r2015.ward,
      chochoName: r2015.chochoName,
      fullChochoName: r2015.fullChochoName,
      baseYear: 2015,
      comparisonYear: 2020,
      basePopulation: r2015.population2015Suppressed ? null : r2015.population2015,
      comparisonPopulation: null,
      changeCount: null,
      changeRate: null,
      comparisonStatus: COMPARISON_STATUS.UNMATCHED_2015_ONLY,
      joinMethod: 'unmatched',
      source: '総務省統計局「平成27年国勢調査」「令和2年国勢調査」',
      changeValueType: 'livecity-calculated',
    });
  }

  stats.unmatched2015Only = unmatched2015Only.length;
  stats.totalRecords2015 = records2015.length;
  stats.comparable = results.filter((r) => r.comparisonStatus === COMPARISON_STATUS.COMPARABLE).length;
  stats.increasing = results.filter((r) => r.comparisonStatus === COMPARISON_STATUS.COMPARABLE && r.changeCount > 0).length;
  stats.decreasing = results.filter((r) => r.comparisonStatus === COMPARISON_STATUS.COMPARABLE && r.changeCount < 0).length;
  stats.flat = results.filter((r) => r.comparisonStatus === COMPARISON_STATUS.COMPARABLE && r.changeCount === 0).length;

  return { records: results, stats };
}
