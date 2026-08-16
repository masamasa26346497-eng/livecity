#!/usr/bin/env node
// tools/compare/legacy-vs-official.js
// 実行: node tools/compare/legacy-vs-official.js --area osaka-sumiyoshi
//
// 既存HTML内のLEGACY_TOWN_DATA_UNVERIFIED(出典未確認)と、公式データ
// (data/processed/{area}/demographics/population-households.json)を比較し、
// data/reports/legacy-town-data-comparison.json へ結果を出力する。
//
// 公式データがまだ生成されていない場合（ネットワーク制約で未取得の場合）は、
// 全件 missing-in-official として正直に報告する（推測で埋めない）。

import path from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { processedDir, writeJson } from '../lib/area.js';
import { normalizeChochoName } from '../lib/chocho-normalize.js';

function parseArgs(argv) {
  const args = { area: null, htmlPath: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
    if (argv[i] === '--html') args.htmlPath = argv[++i];
  }
  return args;
}

/**
 * HTML内の LEGACY_TOWN_DATA_UNVERIFIED から、人口データのある町丁目を抽出する。
 */
async function extractLegacySamples(htmlPath, minSamples = 10) {
  const html = await readFile(htmlPath, 'utf-8');
  const m = html.match(/const LEGACY_TOWN_DATA_UNVERIFIED = (\{.*?\});/s);
  if (!m) throw new Error('LEGACY_TOWN_DATA_UNVERIFIED が見つかりません。');
  const legacy = JSON.parse(m[1]);

  const samples = [];
  for (const [chochoName, val] of Object.entries(legacy)) {
    const pop = val.population;
    if (pop && pop.total > 0) {
      samples.push({
        chochoName,
        legacyTotal: pop.total,
        legacyMale: pop.male,
        legacyFemale: pop.female,
        legacyHouseholds: pop.households,
        legacyForeign: null, // legacyデータには外国人人口が含まれていない
        legacyReferenceDate: val.sourceYear && val.sourceYear.census ? `${val.sourceYear.census}-10-01` : null,
      });
    }
    if (samples.length >= minSamples) break;
  }
  return samples;
}

/**
 * 公式データ(population-households.json)を読み込み、正規化名称でインデックス化する。
 */
async function loadOfficialIndex(areaId) {
  const summaryPath = path.join(processedDir(areaId), 'demographics', 'summary.json');
  if (!existsSync(summaryPath)) return null;
  const data = JSON.parse(await readFile(summaryPath, 'utf-8'));
  const metadataPath = path.join(processedDir(areaId), 'demographics', 'metadata.json');
  const metadata = existsSync(metadataPath) ? JSON.parse(await readFile(metadataPath, 'utf-8')) : null;
  const index = new Map();
  for (const record of data.records || []) {
    const key = normalizeChochoName(record.fullChochoName || record.chochoName);
    index.set(key, record);
  }
  return { index, metadata };
}

/**
 * 1件のlegacyサンプルと公式データを比較し、分類を返す。
 */
function compareSample(sample, officialIndexResult) {
  if (!officialIndexResult) {
    return {
      ...sample,
      officialTotal: null, officialMale: null, officialFemale: null,
      officialHouseholds: null, officialForeign: null, officialReferenceDate: null,
      classification: 'missing-in-official',
      note: '公式データ未取得のため比較不可（ネットワーク制約。ローカルPCでdata:download:demographics実行後に再評価が必要）',
    };
  }
  const key = normalizeChochoName(sample.chochoName);
  const official = officialIndexResult.index.get(key);
  if (!official) {
    return {
      ...sample,
      officialTotal: null, officialMale: null, officialFemale: null,
      officialHouseholds: null, officialForeign: null, officialReferenceDate: null,
      classification: 'missing-in-official',
      note: '正規化名称で公式データ中に該当する町丁目が見つからない（境界変更・秘匿処理・表記差の可能性）',
    };
  }

  const result = {
    ...sample,
    officialTotal: official.population,
    officialMale: official.malePopulation,
    officialFemale: official.femalePopulation,
    officialHouseholds: official.households,
    officialForeign: official.foreignPopulation,
    officialReferenceDate: officialIndexResult.metadata ? officialIndexResult.metadata.referenceDate : null,
  };

  if (official.population == null) {
    result.classification = 'missing-in-official';
    result.note = official.populationSuppressed
      ? '公式データ側で秘匿処理されている（推測補完しない）'
      : '公式データ側の値が欠落している';
    return result;
  }

  const diff = Math.abs(sample.legacyTotal - official.population);
  if (diff === 0) {
    result.classification = 'match';
    result.note = '完全一致';
  } else if (diff <= 5) {
    result.classification = 'minor-rounding-or-classification-difference';
    result.note = `差分${diff}人。統計表の定義差・四捨五入・集計時期のわずかなズレの可能性（断定しない）`;
  } else {
    result.classification = 'mismatch';
    result.note = `差分${diff}人。町丁目境界変更、統計表の定義差、秘匿処理による合算、または旧データの誤りの可能性（断定しない）`;
  }
  return result;
}

async function main(args) {
  if (!args.area) throw new Error('--area が指定されていません。');
  const htmlPath = args.htmlPath || '/mnt/user-data/outputs/osaka_3d_buildings.html';

  console.log(`=== 旧データ比較検証: ${args.area} ===`);
  const samples = await extractLegacySamples(htmlPath, 12);
  console.log(`抽出したlegacyサンプル数: ${samples.length}`);

  const officialIndexResult = await loadOfficialIndex(args.area);
  if (!officialIndexResult) {
    console.warn('[WARN] 公式データ(population-households.json)が未生成です。');
    console.warn('       ローカルPCで以下を実行してから再度本スクリプトを実行してください:');
    console.warn(`       npm run data:download:demographics -- --area ${args.area}`);
    console.warn(`       npm run data:process:demographics -- --area ${args.area}`);
  }

  const comparisons = samples.map((s) => compareSample(s, officialIndexResult));

  const summary = {
    match: 0, 'minor-rounding-or-classification-difference': 0, mismatch: 0,
    'missing-in-official': 0, 'missing-in-legacy': 0,
  };
  for (const c of comparisons) summary[c.classification] = (summary[c.classification] || 0) + 1;

  const report = {
    areaId: args.area,
    generatedAt: new Date().toISOString(),
    officialDataAvailable: !!officialIndexResult,
    sampleCount: comparisons.length,
    summary,
    comparisons,
  };

  const reportPath = path.resolve(process.cwd(), 'data', 'reports', 'legacy-town-data-comparison.json');
  await writeJson(reportPath, report);
  console.log(`\n比較結果サマリ:`, summary);
  console.log(`レポート保存先: ${reportPath}`);
  return report;
}

const args = parseArgs(process.argv.slice(2));
main(args).catch((err) => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
