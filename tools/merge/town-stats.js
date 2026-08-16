// tools/merge/town-stats.js
// population-households(summary.json)、age-structure.json、household-composition.json、
// population-change.json を町丁目単位で統合し、地図表示用の単一JSONを生成する。
// boundaryId / chochoCode から高速参照できるMapを想定したフラット配列形式で出力する
// （実際のMap化はLive City本体側で行う）。
import path from 'path';
import { processedDir, publicMapDataDir, writeJson, writeJsonCompact, readJsonIfExists } from '../lib/area.js';
import { toProjectRelativePath } from '../lib/paths.js';

export async function mergeTownStats(areaId) {
  const popPath = path.join(processedDir(areaId), 'demographics', 'summary.json');
  const agePath = path.join(processedDir(areaId), 'demographics', 'age-structure.json');
  const householdCompositionPath = path.join(processedDir(areaId), 'demographics', 'household-composition.json');
  const populationChangePath = path.join(processedDir(areaId), 'demographics', 'population-change.json');
  const popMetaPath = path.join(publicMapDataDir(areaId), 'demographics', 'metadata.json');
  const ageMetaPath = path.join(publicMapDataDir(areaId), 'demographics', 'age-structure-metadata.json');
  const householdCompositionMetaPath = path.join(publicMapDataDir(areaId), 'demographics', 'household-composition-metadata.json');

  const popData = await readJsonIfExists(popPath);
  const ageData = await readJsonIfExists(agePath);
  const householdCompositionData = await readJsonIfExists(householdCompositionPath);
  const populationChangeData = await readJsonIfExists(populationChangePath);
  const popMeta = await readJsonIfExists(popMetaPath);
  const ageMeta = await readJsonIfExists(ageMetaPath);
  const householdCompositionMeta = await readJsonIfExists(householdCompositionMetaPath);

  if (!popData) {
    console.warn('[WARN] town-stats統合: population-households(summary.json)が見つかりません。');
  }

  const ageByBoundaryId = new Map();
  if (ageData) {
    for (const r of ageData.records) {
      ageByBoundaryId.set(r.boundaryId || r.fullChochoName, r);
    }
  }

  const householdCompositionByCompositeCode = new Map();
  if (householdCompositionData) {
    for (const r of householdCompositionData.records) {
      const key = r.compositeCode || r.boundaryId || r.fullChochoName;
      if (key) householdCompositionByCompositeCode.set(key, r);
    }
  }

  const populationChangeByCompositeCode = new Map();
  if (populationChangeData) {
    for (const r of populationChangeData.records) {
      const key = r.compositeCode || r.fullChochoName;
      if (key) populationChangeByCompositeCode.set(key, r);
    }
  }

  const merged = [];
  const popRecords = popData ? popData.records : [];
  for (const pop of popRecords) {
    const age = ageByBoundaryId.get(pop.boundaryId || pop.fullChochoName) || null;
    const personsPerHousehold = pop.population != null && pop.households
      ? Math.round((pop.population / pop.households) * 100) / 100
      : null;

    const hc = householdCompositionByCompositeCode.get(pop.compositeCode || pop.boundaryId || pop.fullChochoName) || null;
    const pc = populationChangeByCompositeCode.get(pop.compositeCode || pop.fullChochoName) || null;

    merged.push({
      boundaryId: pop.boundaryId || null,
      chochoCode: pop.chochoCode || null,
      municipalityCode: pop.municipalityCode || null,
      chochoName: pop.chochoName,
      ward: pop.ward,

      // 結合結果の状態。正式コードで結合されたか、町名フォールバックで結合されたかを
      // 後から確認できるようにする。
      joinMethod: pop.joinMethod || pop.matchMethod || 'unmatched',
      boundaryDataStatus: pop.boundaryDataStatus || 'legacy-unverified',
      joinConfidence: pop.joinConfidence || 'unavailable',
      // 本ファイルに含まれるレコードは結合済み(=境界形状の有無に関わらず地図上で参照可能)。
      // 境界データを今回取得していない区(平野区)等の未結合レコードはこのファイルには
      // 含まれず、data/reports/demographics-unmatched.json側でreasonCode付きで管理する
      // （「未結合」と「表示範囲外」を混同しないため、本ファイルには常にin-current-render-areaの
      // レコードのみを置く設計とする）。
      displayStatus: 'in-current-render-area',

      population: pop.population,
      populationValueType: 'official',
      populationSuppressed: pop.populationSuppressed,

      households: pop.households,
      householdsValueType: 'official',
      householdsSuppressed: pop.householdsSuppressed,

      personsPerHousehold,
      personsPerHouseholdValueType: 'livecity-calculated',

      youngPopulation: age ? age.age0to14 : null,
      productiveAgePopulation: age ? age.productiveAgePopulation : null,
      elderlyPopulation: age ? age.elderlyPopulation : null,
      youngPopulationRatio: age ? age.youngPopulationRatio : null,
      productiveAgePopulationRatio: age ? age.productiveAgePopulationRatio : null,
      agingRatio: age ? age.agingRatio : null,
      ageValueType: 'official',
      ageRatioValueType: 'livecity-calculated',
      ageDataAvailable: !!age,

      // 世帯構成: データが無い場合はnull(0や架空の値を作らない)。
      householdComposition: hc ? {
        generalHouseholds: hc.generalHouseholds,
        onePersonHouseholds: hc.onePersonHouseholds,
        twoPersonHouseholds: hc.twoPersonHouseholds,
        threePersonHouseholds: hc.threePersonHouseholds,
        fourOrMorePersonHouseholds: hc.fourOrMorePersonHouseholds,
        singlePersonHouseholdRate: hc.singlePersonHouseholdRate,
        twoPersonHouseholdRate: hc.twoPersonHouseholdRate,
        threePersonHouseholdRate: hc.threePersonHouseholdRate,
        fourOrMorePersonHouseholdRate: hc.fourOrMorePersonHouseholdRate,
        source: householdCompositionMeta ? `${householdCompositionMeta.provider}「${householdCompositionMeta.sourceTitle}」` : null,
        referenceYear: 2020,
        valueClassification: 'official',
        rateValueClassification: 'livecity-calculated',
        suppressionStatus: hc.generalHouseholdsSuppressed ? 'suppressed' : 'available',
      } : null,
      householdCompositionAvailable: !!hc,

      // 人口増減: データが無い場合はnull。比較不能の場合もcomparisonStatusで明示する
      // （0や架空の増減率を作らない）。
      populationChange: pc ? {
        baseYear: pc.baseYear,
        comparisonYear: pc.comparisonYear,
        basePopulation: pc.basePopulation,
        comparisonPopulation: pc.comparisonPopulation,
        changeCount: pc.changeCount,
        changeRate: pc.changeRate,
        comparisonStatus: pc.comparisonStatus,
        joinMethod: pc.joinMethod,
        source: pc.source,
        valueClassification: 'official',
        changeValueClassification: 'livecity-calculated',
      } : null,
      populationChangeAvailable: !!pc,

      referenceDate: popMeta ? popMeta.referenceDate : null,
      ageReferenceDate: ageMeta ? ageMeta.referenceDate : null,
      source: popMeta ? `${popMeta.provider}「${popMeta.sourceTitle}」` : null,
      ageSource: ageMeta ? `${ageMeta.provider}「${ageMeta.sourceTitle}」` : null,
    });
  }

  const output = {
    areaId,
    generatedAt: new Date().toISOString(),
    recordCount: merged.length,
    records: merged,
  };

  const outProcessed = path.join(processedDir(areaId), 'demographics', 'town-stats.json');
  const outPublic = path.join(publicMapDataDir(areaId), 'demographics', 'town-stats.json');
  await writeJson(outProcessed, output);
  await writeJsonCompact(outPublic, output);

  // 未結合レコード(地図表示対象外)の件数を区別に集計する。これにより「未結合」と
  // 「対象地域外」を混同せず、なぜ表示対象件数が統計データ総数より少ないのかを
  // 確認できるようにする。
  const unmatchedPath = path.resolve(process.cwd(), 'data', 'reports', 'demographics-unmatched.json');
  const unmatchedData = (await readJsonIfExists(unmatchedPath)) || [];
  const unmatchedByWard = {};
  for (const r of unmatchedData) {
    if (r.sourceDataset && r.sourceDataset !== 'population-households' && r.ward) {
      // age-structureからの追記分は人口データと重複するため、population-households分のみ数える
      continue;
    }
    if (!r.ward) continue;
    unmatchedByWard[r.ward] = (unmatchedByWard[r.ward] || 0) + 1;
  }

  console.log(`\n=== 統合JSON生成 ===`);
  console.log(`  地図表示対象件数(町丁目数): ${merged.length}`);
  console.log(`  年齢データが結合された件数: ${merged.filter((m) => m.ageDataAvailable).length}`);
  console.log(`  未結合(表示対象外)件数(区別): ${JSON.stringify(unmatchedByWard)}`);
  console.log(`  保存先(配信用): ${toProjectRelativePath(outPublic)}`);

  return { ...output, unmatchedByWard };
}
