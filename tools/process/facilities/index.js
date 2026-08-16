// tools/process/facilities/index.js
// 実行: node tools/process/facilities/index.js --area osaka-sumiyoshi
//
// data/raw/{areaId}/facilities-osm.json (Overpass生データ) を読み込み、
// 拡張施設レコードへ変換し、検証した上で facilities.json / metadata.json /
// validation-report.json を生成する。
//
// 【取得失敗時の安全性】本処理は変換が完全に成功した場合のみ最終ファイルへ書き込む。
// 途中で例外が発生した場合、既存のfacilities.json(前回成功時のもの)は上書きされない
// （ご指示「取得失敗時に既存の正常なfacilities.jsonを上書きしないでください」に対応）。
import path from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import {
  loadAreaConfig, rawDir, processedDir, publicMapDataDir,
  readJsonIfExists, writeJson, writeJsonCompact,
} from '../../lib/area.js';
import { convertFacilitiesExtended, detectDuplicateCandidates } from '../../convert/facilities-extended.js';
import { isMainModule, toProjectRelativePath } from '../../lib/paths.js';

function parseArgs(argv) {
  const args = { area: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
  }
  return args;
}

/**
 * 変換済みレコードを検証する。検証は記録のみで、自動補正・自動削除は行わない
 * （ご指示通り、異常を検出してレポートへ出すことが目的）。
 */
function validateFacilities(records, areaConfig) {
  const issues = [];
  const idCounts = new Map();

  for (const r of records) {
    idCounts.set(r.id, (idCounts.get(r.id) || 0) + 1);
    if (!r.name) issues.push({ id: r.id, reasonCode: 'empty-name', detail: '施設名が空です' });
    if (typeof r.latitude !== 'number' || typeof r.longitude !== 'number' ||
        !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) {
      issues.push({ id: r.id, reasonCode: 'invalid-coordinates', detail: `lat=${r.latitude}, lon=${r.longitude}` });
    }
    if (areaConfig.bbox) {
      const { south, west, north, east } = areaConfig.bbox;
      if (r.latitude < south || r.latitude > north || r.longitude < west || r.longitude > east) {
        issues.push({ id: r.id, reasonCode: 'outside-area-bbox', detail: `lat=${r.latitude}, lon=${r.longitude}` });
      }
    }
    if (r.category === 'unknown') issues.push({ id: r.id, reasonCode: 'unknown-category', detail: r.name });
    if (!r.source) issues.push({ id: r.id, reasonCode: 'missing-source', detail: r.name });
    if (!r.license) issues.push({ id: r.id, reasonCode: 'missing-license', detail: r.name });
    if (r.duplicateCandidates && r.duplicateCandidates.length > 0) {
      issues.push({ id: r.id, reasonCode: 'duplicate-candidate', detail: `候補: ${r.duplicateCandidates.map((d) => d.id).join(', ')}` });
    }
  }

  for (const [id, count] of idCounts) {
    if (count > 1) issues.push({ id, reasonCode: 'duplicate-id', detail: `${count}件のレコードが同一IDを持っています` });
  }

  return { pass: issues.filter((i) => i.reasonCode === 'duplicate-id' || i.reasonCode === 'invalid-coordinates').length === 0, issues };
}

export async function run(args) {
  if (!args.area) throw new Error('--area が指定されていません。');
  const areaConfig = await loadAreaConfig(args.area);

  const rawPath = path.join(rawDir(args.area), 'facilities-osm.json');
  const rawMetaPath = path.join(rawDir(args.area), 'facilities-osm.meta.json');

  if (!existsSync(rawPath)) {
    console.log(`[SKIP] facilities: 生データが見つかりません (${toProjectRelativePath(rawPath)})`);
    console.log(`       取得コマンド: npm run data:download:facilities -- --area ${args.area}`);
    return { status: 'missing-raw-data' };
  }

  const raw = JSON.parse(await readFile(rawPath, 'utf-8'));
  const rawMeta = (await readJsonIfExists(rawMetaPath)) || {};

  const facilityConfig = JSON.parse(
    await readFile(path.resolve(process.cwd(), 'config', 'facilities', 'categories.json'), 'utf-8')
  );

  const sourceMeta = {
    provider: rawMeta.source || 'OpenStreetMap',
    license: rawMeta.license || 'ODbL 1.0',
    attribution: rawMeta.attribution || '© OpenStreetMap contributors',
    downloadedAt: rawMeta.downloadedAt || null,
  };

  const { records, skipped } = convertFacilitiesExtended(
    raw.elements || [], areaConfig.projection, areaConfig.bbox, facilityConfig, sourceMeta
  );

  if (records.length === 0) {
    console.warn('[WARN] facilities: 変換結果が0件です。既存のfacilities.jsonは上書きしません。');
    return { status: 'zero-records', skippedCount: skipped.length };
  }

  detectDuplicateCandidates(records);

  const validation = validateFacilities(records, areaConfig);
  console.log(`[OK] facilities: ${records.length}件変換 (スキップ${skipped.length}件、検証issue${validation.issues.length}件)`);

  // カテゴリ別件数の集計(報告用)
  const categoryCounts = {};
  for (const r of records) categoryCounts[r.category] = (categoryCounts[r.category] || 0) + 1;
  console.log('カテゴリ別件数:', JSON.stringify(categoryCounts));

  const output = {
    areaId: args.area,
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    categoryCounts,
    records,
  };
  const metadata = {
    datasetId: 'osaka-sumiyoshi-facilities-osm',
    provider: sourceMeta.provider,
    license: sourceMeta.license,
    attribution: sourceMeta.attribution,
    downloadedAt: sourceMeta.downloadedAt,
    bbox: areaConfig.bbox,
    recordCount: records.length,
    skippedCount: skipped.length,
  };
  const validationReport = {
    areaId: args.area,
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    skippedDuringConversion: skipped,
    issueCount: validation.issues.length,
    issues: validation.issues,
  };

  // 全ての変換・検証が成功した後にのみ書き込む(途中で例外が出れば、ここまで到達せず
  // 既存ファイルは無傷のまま残る)。
  const outProcessed = path.join(processedDir(args.area), 'facilities', 'facilities.json');
  const outPublicFacilities = path.join(publicMapDataDir(args.area), 'facilities', 'facilities.json');
  const outPublicMetadata = path.join(publicMapDataDir(args.area), 'facilities', 'metadata.json');
  const outPublicValidation = path.join(publicMapDataDir(args.area), 'facilities', 'validation-report.json');

  await writeJson(outProcessed, output);
  await writeJsonCompact(outPublicFacilities, output);
  await writeJson(outPublicMetadata, metadata);
  await writeJson(outPublicValidation, validationReport);

  console.log(`保存先: ${toProjectRelativePath(outPublicFacilities)}`);

  return {
    status: 'processed',
    recordCount: records.length,
    skippedCount: skipped.length,
    categoryCounts,
    issueCount: validation.issues.length,
    outPublicFacilities: toProjectRelativePath(outPublicFacilities),
  };
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  run(args).catch((err) => {
    console.error('予期しないエラー:', err.message);
    process.exit(1);
  });
}
