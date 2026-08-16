// tools/calculate/demographics-ratios.js
// 公式統計値から、Live City側で比率等を計算する。
// 全ての出力に valueType: 'livecity-calculated' を明示し、公式値(official)と混同しない。

/**
 * 各町丁目レコードに外国人人口比率を付与する。
 * 元の人口・外国人人口のいずれかが秘匿/欠損の場合は比率も計算せず、理由を保持する。
 */
export function calculateForeignPopulationRatio(records) {
  return records.map((r) => {
    if (r.population == null || r.foreignPopulation == null || r.population === 0) {
      return {
        ...r,
        foreignPopulationRatio: null,
        foreignPopulationRatioValueType: 'livecity-calculated',
        foreignPopulationRatioUnavailableReason:
          r.populationSuppressed || r.foreignPopulationSuppressed
            ? 'underlying-value-suppressed'
            : r.population === 0
            ? 'population-is-zero'
            : 'missing-underlying-value',
      };
    }
    return {
      ...r,
      foreignPopulationRatio: Math.round((r.foreignPopulation / r.population) * 1000) / 10, // 小数点1桁%
      foreignPopulationRatioValueType: 'livecity-calculated',
      foreignPopulationRatioUnavailableReason: null,
    };
  });
}

/**
 * 1世帯あたり人員（世帯人員）を計算する。
 */
export function calculatePersonsPerHousehold(records) {
  return records.map((r) => {
    if (r.population == null || r.households == null || r.households === 0) {
      return {
        ...r,
        personsPerHousehold: null,
        personsPerHouseholdValueType: 'livecity-calculated',
      };
    }
    return {
      ...r,
      personsPerHousehold: Math.round((r.population / r.households) * 100) / 100,
      personsPerHouseholdValueType: 'livecity-calculated',
    };
  });
}

/**
 * 2時点の推計人口から増減率を計算する（区単位データ専用、町丁目には適用しない）。
 */
export function calculatePopulationChangeRate(current, previous) {
  if (current == null || previous == null || previous === 0) {
    return { changeRate: null, changeCount: null, valueType: 'livecity-calculated', unavailableReason: 'missing-or-zero-base' };
  }
  return {
    changeRate: Math.round(((current - previous) / previous) * 1000) / 10,
    changeCount: current - previous,
    valueType: 'livecity-calculated',
    unavailableReason: null,
  };
}
