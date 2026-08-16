#!/usr/bin/env node
// tools/convert/demographics/index.js
// 実行: node tools/convert/demographics/index.js --area osaka-sumiyoshi
//
// data/raw/{area}/census/ のXLSXを読み込み、町丁目コードで結合し、比率等を計算した上で
// data/processed と public/map-data へ出力する。ネットワーク不要なため、fixtureデータがあれば
// Claude Code環境でも動作確認できる。

import path from 'path';
import { existsSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import {
  loadAreaConfig, rawDir, processedDir, publicMapDataDir, manifestPath,
  readJsonIfExists, writeJson, writeJsonCompact,
} from '../../lib/area.js';
import { convertPopulationHouseholdsXlsx } from './population-households.js';
import { convertAgeStructureXlsx } from './age-structure.js';
import { convertHouseholdCompositionCsv } from './household-composition.js';
import { convertPopulation2015Csv } from './population-2015.js';
import { calculatePopulationChange } from '../../calculate/population-change.js';
import { joinByChochoCode } from '../../join/chocho-crosswalk.js';
import { loadBoundaryMaster } from '../../lib/boundary-master.js';
import { generateBoundaryJoinReport } from '../../validate/boundary-join-report.js';
import { mergeTownStats } from '../../merge/town-stats.js';
import { calculateForeignPopulationRatio, calculatePersonsPerHousehold } from '../../calculate/demographics-ratios.js';
import { validatePopulationRecords, validatePercentageRange, validateAgeStructure } from '../../lib/validate-demographics.js';
import { buildMetadata } from '../../lib/metadata.js';
import { loadDataset } from '../../lib/dataset.js';
import { isMainModule, toProjectRelativePath } from '../../lib/paths.js';

function parseArgs(argv) {
  const args = { area: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
  }
  return args;
}

async function processPopulationHouseholds(areaId, areaConfig) {
  const datasetId = 'osaka-census-2020-population-households';
  const xlsxPath = path.join(rawDir(areaId), 'census', `${datasetId}.xlsx`);
  if (!existsSync(xlsxPath)) {
    console.log(`[SKIP] population-households: 生データが見つかりません (${xlsxPath})`);
    return { status: 'missing-raw-data' };
  }

  const buffer = await readFile(xlsxPath);
  const targetWards = areaConfig.demographics.targetWards || null;
  const { records, skippedRows } = convertPopulationHouseholdsXlsx(buffer, targetWards);
  console.log(`[OK] population-households: ${records.length}件抽出 (区合計/小計/対象外区等${skippedRows.length}件をスキップ)`);

  const boundaryMaster = await loadBoundaryMaster(areaId);
  const { master, boundaryDataStatus, officialBoundary, boundarySourceType, officialAttributeRecords, officialBoundaryRecords, legacyGeometryRecords, recordsWithoutGeometry } = boundaryMaster;
  if (!officialBoundary) {
    console.warn(`[WARN] 正式な行政界データ(official-boundaries.json)が未配置のため、` +
      `暫定境界データ(TOWN_POLYGONS由来、boundaryDataStatus: legacy-unverified)を使用します。`);
    console.warn('       人口・世帯・年齢構成の値自体は公式統計です。境界との対応のみが暫定照合です。');
  }

  let joined;
  if (master.length > 0) {
    joined = joinByChochoCode(records, master);
  } else {
    // マスタが無い場合は全件unmatchedとして扱う（結合できないことを明示し、推測補完しない）
    joined = {
      matched: [],
      unmatched: records.map((r) => ({ ...r, joinMethod: 'unmatched', joinConfidence: 'unavailable', unmatchedReason: '町丁目境界マスタ自体が未配置のため結合を試行できない' })),
      matchStats: { byCode: 0, byNormalizedName: 0, unmatchedCount: records.length, multipleCandidatesCount: 0, total: records.length },
      multipleCandidates: [],
      masterOnlyEntries: [],
    };
  }
  await generateBoundaryJoinReport(areaId, 'population-households', joined, { boundaryDataStatus, officialBoundary, boundarySourceType, officialAttributeRecords, officialBoundaryRecords, legacyGeometryRecords, recordsWithoutGeometry });

  const withForeignRatio = calculateForeignPopulationRatio(joined.matched);
  const withPersonsPerHousehold = calculatePersonsPerHousehold(withForeignRatio);

  const popValidation = validatePopulationRecords(withPersonsPerHousehold);
  const ratioValidation = validatePercentageRange(withPersonsPerHousehold, ['foreignPopulationRatio']);

  const dataset = await loadDataset(datasetId);
  const metaPath = path.join(rawDir(areaId), 'census', `${datasetId}.meta.json`);
  const existingMeta = await readJsonIfExists(metaPath);
  const metadata = buildMetadata(dataset, {
    valueType: 'official',
    downloadedAt: existingMeta ? existingMeta.downloadedAt : null,
    referenceDate: dataset.referenceDate,
    geographicLevel: 'chocho',
  });

  const output = {
    matchStats: joined.matchStats,
    records: withPersonsPerHousehold,
  };

  // public/map-data: summary.json(レコード本体) と metadata.json(出典・基準日等) を分離する。
  // 今後 age-structure.json 等を追加する際、メタデータを複製せず共有できるようにするための設計。
  const outProcessed = path.join(processedDir(areaId), 'demographics', 'summary.json');
  const outPublicSummary = path.join(publicMapDataDir(areaId), 'demographics', 'summary.json');
  const outPublicMetadata = path.join(publicMapDataDir(areaId), 'demographics', 'metadata.json');
  await writeJson(outProcessed, output);
  await writeJsonCompact(outPublicSummary, output);
  await writeJson(outPublicMetadata, {
    ...metadata,
    // 人口・世帯・年齢構成の値自体は常にofficial。boundaryDataStatusは「境界との対応」の
    // 信頼度を別に示すものであり、値の信頼度(valueType)と混同しないこと。
    boundaryDataStatus,
    officialBoundary,
    boundarySourceType,
  });

  if (joined.unmatched.length > 0) {
    // データセット横断で参照する固定パスのレポート（demographics専用ではなく、
    // 将来の他データセットの未結合レコードもこのファイルに集約していく想定）
    const unmatchedPath = path.resolve(process.cwd(), 'data', 'reports', 'demographics-unmatched.json');
    await writeJson(unmatchedPath, joined.unmatched);
    console.warn(`[WARN] population-households: ${joined.unmatched.length}件が結合できず ${toProjectRelativePath(unmatchedPath)} に出力されました。`);
  }

  return {
    status: 'processed',
    recordCount: withPersonsPerHousehold.length,
    unmatchedCount: joined.unmatched.length,
    validation: {
      population: popValidation.pass ? 'pass' : 'fail',
      populationIssues: popValidation.issues,
      ratio: ratioValidation.pass ? 'pass' : 'fail',
      ratioIssues: ratioValidation.issues,
    },
    boundaryJoin: {
      boundarySourceType,
      boundaryDataStatus,
      officialBoundary,
      officialAttributeRecords,
      officialBoundaryRecords,
      legacyGeometryRecords,
      recordsWithoutGeometry,
      totalStatisticsRecords: joined.matchStats.total,
      matchedByOfficialCode: joined.matchStats.byCode,
      matchedByFallbackName: joined.matchStats.byNormalizedName,
      unmatched: joined.matchStats.unmatchedCount,
      multipleCandidates: joined.matchStats.multipleCandidatesCount,
    },
    outPublicSummary: toProjectRelativePath(outPublicSummary),
    outPublicMetadata: toProjectRelativePath(outPublicMetadata),
  };
}

async function processAgeStructure(areaId, areaConfig) {
  const datasetId = 'osaka-census-2020-age-structure';
  const xlsxPath = path.join(rawDir(areaId), 'census', `${datasetId}.xlsx`);
  if (!existsSync(xlsxPath)) {
    console.log(`[SKIP] age-structure: 生データが見つかりません (${xlsxPath})`);
    return { status: 'missing-raw-data' };
  }

  const buffer = await readFile(xlsxPath);
  const targetWards = areaConfig.demographics.targetWards || null;
  const { records, skippedRows } = convertAgeStructureXlsx(buffer, targetWards);
  console.log(`[OK] age-structure: ${records.length}件抽出 (区合計/小計/対象外区/男女別行等${skippedRows.length}件をスキップ)`);

  const boundaryMaster = await loadBoundaryMaster(areaId);
  const { master, boundaryDataStatus, officialBoundary, boundarySourceType, officialAttributeRecords, officialBoundaryRecords, legacyGeometryRecords, recordsWithoutGeometry } = boundaryMaster;
  let joined;
  if (master.length > 0) {
    joined = joinByChochoCode(records, master);
  } else {
    joined = {
      matched: [],
      unmatched: records.map((r) => ({ ...r, joinMethod: 'unmatched', joinConfidence: 'unavailable', unmatchedReason: '町丁目境界マスタ自体が未配置のため結合を試行できない' })),
      matchStats: { byCode: 0, byNormalizedName: 0, unmatchedCount: records.length, multipleCandidatesCount: 0, total: records.length },
      multipleCandidates: [],
      masterOnlyEntries: [],
    };
  }
  await generateBoundaryJoinReport(areaId, 'age-structure', joined, { boundaryDataStatus, officialBoundary, boundarySourceType, officialAttributeRecords, officialBoundaryRecords, legacyGeometryRecords, recordsWithoutGeometry });

  // 年齢構成専用の軽量検証: 負の人口値、比率の0-100範囲。
  // (既存のvalidateAgeStructureはageGroupsオブジェクト形式を前提にしており、本データの
  // フラットなフィールド構造とは形が異なるため、ここでは専用の簡易チェックを行う)
  const negativeValueIssues = [];
  for (const r of joined.matched) {
    for (const key of ['age0to14', 'age15to24', 'age25to39', 'age40to64', 'age65to74', 'age75plus']) {
      if (r[key] != null && r[key] < 0) {
        negativeValueIssues.push({ chochoCode: r.chochoCode, chochoName: r.chochoName, field: key, value: r[key] });
      }
    }
  }
  const ratioValidation = validatePercentageRange(joined.matched, ['youngPopulationRatio', 'productiveAgePopulationRatio', 'agingRatio']);

  const dataset = await loadDataset(datasetId);
  const metaPath = path.join(rawDir(areaId), 'census', `${datasetId}.meta.json`);
  const existingMeta = await readJsonIfExists(metaPath);
  const metadata = buildMetadata(dataset, {
    valueType: 'official',
    downloadedAt: existingMeta ? existingMeta.downloadedAt : null,
    referenceDate: dataset.referenceDate,
    geographicLevel: 'chocho',
  });

  const output = {
    matchStats: joined.matchStats,
    records: joined.matched,
  };

  // summary.jsonとは別ファイルへ出力する（ご指示通り）。メタデータも年齢構成専用のものを
  // 別途保存する（population-householdsとデータセットが異なるため、出典・基準日も別物になる）。
  const outProcessed = path.join(processedDir(areaId), 'demographics', 'age-structure.json');
  const outPublicData = path.join(publicMapDataDir(areaId), 'demographics', 'age-structure.json');
  const outPublicMetadata = path.join(publicMapDataDir(areaId), 'demographics', 'age-structure-metadata.json');
  await writeJson(outProcessed, output);
  await writeJsonCompact(outPublicData, output);
  await writeJson(outPublicMetadata, {
    ...metadata,
    boundaryDataStatus,
    officialBoundary,
    boundarySourceType,
  });

  if (joined.unmatched.length > 0) {
    // 既存のunmatchedレポートに追記する形にする（population-householdsと合わせて
    // 1ファイルにdemographics全体の未結合状況を集約する設計を維持する）
    const unmatchedPath = path.resolve(process.cwd(), 'data', 'reports', 'demographics-unmatched.json');
    const existingUnmatched = (await readJsonIfExists(unmatchedPath)) || [];
    const combined = [...existingUnmatched, ...joined.unmatched.map((r) => ({ ...r, sourceDataset: datasetId }))];
    await writeJson(unmatchedPath, combined);
    console.warn(`[WARN] age-structure: ${joined.unmatched.length}件が結合できず ${toProjectRelativePath(unmatchedPath)} に出力されました。`);
  }

  return {
    status: 'processed',
    recordCount: joined.matched.length,
    unmatchedCount: joined.unmatched.length,
    validation: {
      negativeValues: negativeValueIssues.length === 0 ? 'pass' : 'fail',
      negativeValueIssues,
      ratio: ratioValidation.pass ? 'pass' : 'fail',
      ratioIssues: ratioValidation.issues,
    },
    boundaryJoin: {
      boundarySourceType,
      boundaryDataStatus,
      officialBoundary,
      officialAttributeRecords,
      officialBoundaryRecords,
      legacyGeometryRecords,
      recordsWithoutGeometry,
      totalStatisticsRecords: joined.matchStats.total,
      matchedByOfficialCode: joined.matchStats.byCode,
      matchedByFallbackName: joined.matchStats.byNormalizedName,
      unmatched: joined.matchStats.unmatchedCount,
      multipleCandidates: joined.matchStats.multipleCandidatesCount,
    },
    outPublicData: toProjectRelativePath(outPublicData),
    outPublicMetadata: toProjectRelativePath(outPublicMetadata),
  };
}

async function processHouseholdComposition(areaId, areaConfig) {
  const datasetId = 'osaka-census-2020-household-composition';
  const dataset = await loadDataset(datasetId);
  const csvPath = path.join(rawDir(areaId), 'census', `${datasetId}.csv`);
  if (!existsSync(csvPath)) {
    console.log(`[SKIP] household-composition: 生データが見つかりません (${toProjectRelativePath(csvPath)})`);
    console.log(`       取得コマンド: npm run data:update:households -- --force`);
    return { status: 'missing-raw-data' };
  }

  const buffer = await readFile(csvPath);
  const targetMunicipalityCodes = dataset.targetMunicipalityCodes || null;
  const { records, skippedRows, encoding } = convertHouseholdCompositionCsv(buffer, {}, targetMunicipalityCodes);
  console.log(`[OK] household-composition: ${records.length}件抽出 (文字コード: ${encoding}, ${skippedRows.length}件をスキップ)`);

  const boundaryMaster = await loadBoundaryMaster(areaId);
  const { master, boundaryDataStatus, officialBoundary, boundarySourceType, officialAttributeRecords, officialBoundaryRecords, legacyGeometryRecords, recordsWithoutGeometry } = boundaryMaster;
  let joined;
  if (master.length > 0) {
    joined = joinByChochoCode(records, master);
  } else {
    joined = {
      matched: [],
      unmatched: records.map((r) => ({ ...r, joinMethod: 'unmatched', joinConfidence: 'unavailable', unmatchedReason: '町丁目境界マスタ自体が未配置のため結合を試行できない' })),
      matchStats: { byCode: 0, byNormalizedName: 0, unmatchedCount: records.length, multipleCandidatesCount: 0, total: records.length },
      multipleCandidates: [],
      masterOnlyEntries: [],
    };
  }
  await generateBoundaryJoinReport(areaId, 'household-composition', joined, { boundaryDataStatus, officialBoundary, boundarySourceType, officialAttributeRecords, officialBoundaryRecords, legacyGeometryRecords, recordsWithoutGeometry });

  // 検証: 人数別世帯数の合計が一般世帯数を超えていないか(超えている場合は黙って補正せず記録する)
  const validationIssues = [];
  for (const r of joined.matched) {
    if (r.generalHouseholds == null || r.generalHouseholdsSuppressed) continue;
    const parts = [r.onePersonHouseholds, r.twoPersonHouseholds, r.threePersonHouseholds, r.fourOrMorePersonHouseholds];
    if (parts.some((p) => p == null)) continue;
    const sum = parts.reduce((s, p) => s + p, 0);
    if (sum > r.generalHouseholds) {
      validationIssues.push({ chochoName: r.chochoName, fullChochoName: r.fullChochoName, generalHouseholds: r.generalHouseholds, sum, reasonCode: 'breakdown-exceeds-total' });
    }
  }

  const metadata = buildMetadata(dataset, {
    valueType: 'official',
    downloadedAt: null,
    referenceDate: dataset.referenceDate,
    geographicLevel: 'chocho',
    boundaryDataStatus,
    officialBoundary,
    boundarySourceType,
  });

  const output = { matchStats: joined.matchStats, records: joined.matched };
  const outProcessed = path.join(processedDir(areaId), 'demographics', 'household-composition.json');
  const outPublicData = path.join(publicMapDataDir(areaId), 'demographics', 'household-composition.json');
  const outPublicMetadata = path.join(publicMapDataDir(areaId), 'demographics', 'household-composition-metadata.json');
  await writeJson(outProcessed, output);
  await writeJsonCompact(outPublicData, output);
  await writeJson(outPublicMetadata, metadata);

  const validationReportPath = path.resolve(process.cwd(), 'data', 'reports', 'household-composition-validation-report.json');
  await writeJson(validationReportPath, { areaId, generatedAt: new Date().toISOString(), issueCount: validationIssues.length, issues: validationIssues });
  if (validationIssues.length > 0) {
    console.warn(`[WARN] household-composition: 人数別内訳が一般世帯数を超える${validationIssues.length}件を検出しました。詳細: ${toProjectRelativePath(validationReportPath)}`);
  }

  if (joined.unmatched.length > 0) {
    const unmatchedPath = path.resolve(process.cwd(), 'data', 'reports', 'demographics-unmatched.json');
    const existingUnmatched = (await readJsonIfExists(unmatchedPath)) || [];
    const combined = [...existingUnmatched, ...joined.unmatched.map((r) => ({ ...r, sourceDataset: datasetId }))];
    await writeJson(unmatchedPath, combined);
  }

  const rateCalculableCount = joined.matched.filter((r) => r.singlePersonHouseholdRate != null).length;

  return {
    status: 'processed',
    recordCount: joined.matched.length,
    unmatchedCount: joined.unmatched.length,
    rateCalculableCount,
    validationIssueCount: validationIssues.length,
    boundaryJoin: {
      boundarySourceType, boundaryDataStatus, officialBoundary,
      totalStatisticsRecords: joined.matchStats.total,
      matchedByOfficialCode: joined.matchStats.byCode,
      matchedByFallbackName: joined.matchStats.byNormalizedName,
      unmatched: joined.matchStats.unmatchedCount,
      multipleCandidates: joined.matchStats.multipleCandidatesCount,
    },
    outPublicData: toProjectRelativePath(outPublicData),
    outPublicMetadata: toProjectRelativePath(outPublicMetadata),
  };
}

async function processPopulationChange(areaId, areaConfig) {
  const datasetId2015 = 'osaka-census-2015-population-households';
  const dataset2015 = await loadDataset(datasetId2015);
  const csvPath2015 = path.join(rawDir(areaId), 'census', `${datasetId2015}.csv`);
  if (!existsSync(csvPath2015)) {
    console.log(`[SKIP] population-change: 2015年生データが見つかりません (${toProjectRelativePath(csvPath2015)})`);
    console.log(`       取得コマンド: npm run data:update:population-change -- --force`);
    return { status: 'missing-raw-data' };
  }

  // 2020年データは既存のsummary.json(processPopulationHouseholdsの出力)を再利用する
  // （XLSXを再度パースしない。既存の変換結果をそのまま使う設計）。
  const summary2020Path = path.join(processedDir(areaId), 'demographics', 'summary.json');
  const summary2020 = await readJsonIfExists(summary2020Path);
  if (!summary2020) {
    console.log(`[SKIP] population-change: 2020年データ(summary.json)が未生成です。先に人口・世帯データの変換を実行してください。`);
    return { status: 'missing-2020-data' };
  }

  const buffer2015 = await readFile(csvPath2015);
  const targetMunicipalityCodes = dataset2015.targetMunicipalityCodes || null;
  const { records: records2015, skippedRows: skippedRows2015, encoding } = convertPopulation2015Csv(buffer2015, {}, targetMunicipalityCodes);
  console.log(`[OK] population-2015: ${records2015.length}件抽出 (文字コード: ${encoding}, ${skippedRows2015.length}件をスキップ)`);

  const { records: changeRecords, stats } = calculatePopulationChange(records2015, summary2020.records);
  console.log(`[OK] population-change: 比較可能${stats.comparable}件 (増加${stats.increasing}/減少${stats.decreasing}/横ばい${stats.flat}), ` +
    `2020年のみ${stats.unmatched2020Only}件, 2015年のみ${stats.unmatched2015Only}件, 秘匿${stats.suppressed}件`);

  // 異常値検出(増減率±100%以上、人口負数等)を黙って削除せずレポートする
  const anomalies = changeRecords.filter((r) =>
    (r.changeRate != null && Math.abs(r.changeRate) >= 100) ||
    (r.basePopulation != null && r.basePopulation < 0) ||
    (r.comparisonPopulation != null && r.comparisonPopulation < 0)
  );

  const output = { baseYear: 2015, comparisonYear: 2020, stats, records: changeRecords };
  const outProcessed = path.join(processedDir(areaId), 'demographics', 'population-change.json');
  const outPublicData = path.join(publicMapDataDir(areaId), 'demographics', 'population-change.json');
  await writeJson(outProcessed, output);
  await writeJsonCompact(outPublicData, output);

  const joinReportPath = path.resolve(process.cwd(), 'data', 'reports', 'population-change-join-report.json');
  await writeJson(joinReportPath, {
    areaId, generatedAt: new Date().toISOString(), stats,
    unmatched2015Only: changeRecords.filter((r) => r.comparisonStatus === 'abolished-or-boundary-changed').map((r) => ({ fullChochoName: r.fullChochoName, compositeCode: r.compositeCode })),
    unmatched2020Only: changeRecords.filter((r) => r.comparisonStatus === 'new-or-boundary-changed').map((r) => ({ fullChochoName: r.fullChochoName, compositeCode: r.compositeCode })),
  });

  const validationReportPath = path.resolve(process.cwd(), 'data', 'reports', 'population-change-validation-report.json');
  await writeJson(validationReportPath, { areaId, generatedAt: new Date().toISOString(), anomalyCount: anomalies.length, anomalies });
  if (anomalies.length > 0) {
    console.warn(`[WARN] population-change: 異常な増減率・負の人口を${anomalies.length}件検出しました。詳細: ${toProjectRelativePath(validationReportPath)}`);
  }

  return {
    status: 'processed',
    recordCount2015: records2015.length,
    stats,
    anomalyCount: anomalies.length,
    outPublicData: toProjectRelativePath(outPublicData),
  };
}

async function main(args) {
  const areaConfig = await loadAreaConfig(args.area);
  if (!areaConfig.demographics || !areaConfig.demographics.enabled) {
    console.log(`[SKIP] ${args.area}: demographics設定が無効です。`);
    return null;
  }

  console.log(`=== 人口統計変換開始: ${areaConfig.name} (${args.area}) ===`);

  /**
   * 各データセットの変換処理を独立に実行する。1つのデータセットの変換が失敗しても、
   * 他のデータセット(特に依存関係のないもの)の処理を止めない。失敗時はエラー内容を
   * 記録した上で次へ進む（例: 世帯構成CSVの列検出失敗が、無関係な人口増減処理や
   * town-stats統合まで止めてしまう、という実際に報告された不具合の修正）。
   */
  async function runStep(label, fn) {
    try {
      return await fn();
    } catch (err) {
      console.error(`[FAIL] ${label}: ${err.message}`);
      return { status: 'failed', error: err.message };
    }
  }

  const results = {};
  results.populationHouseholds = await runStep('population-households', () => processPopulationHouseholds(args.area, areaConfig));
  results.ageStructure = await runStep('age-structure', () => processAgeStructure(args.area, areaConfig));
  results.householdComposition = await runStep('household-composition', () => processHouseholdComposition(args.area, areaConfig));
  results.populationChange = await runStep('population-change', () => processPopulationChange(args.area, areaConfig));
  // town-stats統合は、利用可能な統計だけを使う設計にする(mergeTownStats自体が各入力ファイルの
  // 有無をreadJsonIfExistsで確認し、無ければnullとして扱う実装になっている)。
  // householdComposition/populationChangeのいずれかが失敗していても、統合処理自体は
  // 必ず実行し、既存の町丁目別人口・年齢構成データを壊さないようにする。
  results.townStats = await runStep('town-stats-merge', () => mergeTownStats(args.area));

  // マニフェスト更新（既存のurban用マニフェストとは別ファイルにする。
  // 1エリアにつき複数ドメインのマニフェストが今後増えるため、ドメインごとに分離する設計）
  const demographicsManifestPath = manifestPath(`${args.area}-demographics`);
  const manifest = {
    areaId: args.area,
    areaName: areaConfig.name,
    domain: 'demographics',
    generatedAt: new Date().toISOString(),
    results: {
      populationHouseholds: results.populationHouseholds,
      ageStructure: results.ageStructure,
      householdComposition: results.householdComposition,
      populationChange: results.populationChange,
      townStats: results.townStats ? { recordCount: results.townStats.recordCount } : null,
    },
  };
  await writeJson(demographicsManifestPath, manifest);
  console.log(`\nマニフェストを生成しました: data/manifests/${args.area}-demographics.json`);

  return results;
}

export async function run(args) {
  if (!args.area) throw new Error('area引数が指定されていません。');
  return main(args);
}

if (isMainModule(import.meta.url)) {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (!cliArgs.area) {
    console.error('使用法: node tools/convert/demographics/index.js --area <areaId>');
    process.exit(1);
  }
  main(cliArgs).catch((err) => {
    console.error('予期しないエラー:', err);
    process.exit(1);
  });
}
