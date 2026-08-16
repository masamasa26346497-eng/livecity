// tools/lib/validate-demographics.js
// 人口統計特有の検証（負の人口、割合の範囲、内訳合計との差異等）。
// 既存のtools/lib/validate.js（ファイルサイズ・件数等の汎用検証）とは別に、
// 人口統計データにのみ適用する追加チェックとして分離する。

/**
 * 人口・世帯数データの検証。
 * @param {object[]} records [{chochoCode, chochoName, population, households, foreignPopulation, ...}]
 */
export function validatePopulationRecords(records) {
  const issues = [];

  for (const r of records) {
    if (r.population != null && r.population < 0) {
      issues.push({ chochoCode: r.chochoCode, chochoName: r.chochoName, issue: 'negative-population', value: r.population });
    }
    if (r.households != null && r.households < 0) {
      issues.push({ chochoCode: r.chochoCode, chochoName: r.chochoName, issue: 'negative-households', value: r.households });
    }
    if (r.foreignPopulation != null && r.population != null && r.foreignPopulation > r.population) {
      issues.push({ chochoCode: r.chochoCode, chochoName: r.chochoName, issue: 'foreign-population-exceeds-total', value: r.foreignPopulation });
    }
  }

  return { pass: issues.length === 0, issues };
}

/**
 * 年齢構成データの検証: 総人口と年齢階級合計の差をチェックする。
 * 差異が許容範囲(秘匿等による若干のズレを想定したtolerance)を超える場合に報告する。
 * @param {object[]} records [{chochoCode, totalPopulation, ageGroups: {0-4: n, 5-9: n, ...}}]
 */
export function validateAgeStructure(records, tolerance = 5) {
  const issues = [];
  for (const r of records) {
    if (r.totalPopulation == null || !r.ageGroups) continue;
    const ageSum = Object.values(r.ageGroups)
      .filter((v) => v !== null && v !== 'suppressed')
      .reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    const suppressedCount = Object.values(r.ageGroups).filter((v) => v === 'suppressed').length;
    const diff = Math.abs(r.totalPopulation - ageSum);
    if (diff > tolerance && suppressedCount === 0) {
      // 秘匿値がある場合は合計が一致しないのは当然のため、秘匿が無い場合のみ異常として報告する
      issues.push({ chochoCode: r.chochoCode, issue: 'age-sum-mismatch', totalPopulation: r.totalPopulation, ageSum, diff });
    }
  }
  return { pass: issues.length === 0, issues };
}

/**
 * 比率データ(0-100%であるべき値)の範囲検証。
 */
export function validatePercentageRange(records, fieldNames) {
  const issues = [];
  for (const r of records) {
    for (const field of fieldNames) {
      const v = r[field];
      if (v != null && (v < 0 || v > 100)) {
        issues.push({ chochoCode: r.chochoCode, issue: 'percentage-out-of-range', field, value: v });
      }
    }
  }
  return { pass: issues.length === 0, issues };
}
