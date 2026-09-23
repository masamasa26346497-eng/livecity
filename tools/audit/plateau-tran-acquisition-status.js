#!/usr/bin/env node
// tools/audit/plateau-tran-acquisition-status.js
// [Mission 31C2 §4/§21/§30] PLATEAU tran:Road の取得状況と canonical roads polygon 化の可否を判定する。
//   ネットワーク不可の環境では取得できないため、STOP 条件（§30）を明示的に報告する。
//   出力: data/reports/plateau-tran-acquisition-status.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const RAW_TRAN = P('data', 'raw', 'plateau', 'osaka-city', 'tran');
const TRAN_POLYGONS = P('data', 'processed', 'osaka-city', 'canonical', 'roads-tran', 'polygons.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const PLATEAU_SOURCES = P('data', 'plateau-sources.json');
const CONVERSION = P('data', 'reports', 'plateau-tran-conversion.json');
const REPORT = P('data', 'reports', 'plateau-tran-acquisition-status.json');

function countGml(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d)) { const fp = path.join(d, e); const s = fs.statSync(fp); if (s.isDirectory()) walk(fp); else if (/\.gml$/i.test(e)) n++; } };
  walk(dir);
  return n;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const rawGmlCount = countGml(RAW_TRAN);
  const polygonsExist = fs.existsSync(TRAN_POLYGONS);
  let polygonCount = 0, wardCoverage = null;
  if (polygonsExist) {
    try { const d = JSON.parse(fs.readFileSync(TRAN_POLYGONS, 'utf-8')); polygonCount = (d.polygons || []).length; } catch { /* noop */ }
  }
  let canonRoadPolygonCov = null;
  if (fs.existsSync(CANON_ROADS_MANIFEST)) {
    try { const m = JSON.parse(fs.readFileSync(CANON_ROADS_MANIFEST, 'utf-8')); canonRoadPolygonCov = { byFeature: m.polygonCoverageRatioByFeature ?? m.polygonCoverageRatio ?? 0, byLength: m.polygonCoverageRatioByLength ?? 0, byArea: m.polygonCoverageRatioByArea ?? 0, tranMatch: m.tranMatch || null }; } catch { /* noop */ }
  }
  let tranPatternConfigured = false;
  try { const ps = JSON.parse(fs.readFileSync(PLATEAU_SOURCES, 'utf-8')); tranPatternConfigured = !!(ps.patterns && (ps.patterns.tranPattern || ps.patterns.tranPatterns)); } catch { /* noop */ }

  const acquired = rawGmlCount > 0;
  const stopReasons = [];
  if (!acquired) stopReasons.push('PLATEAU tran GML が未取得（このサンドボックスはネットワーク不可。配布 ZIP からの展開 or ローカル PC での取得が必要）');
  if (acquired && !polygonsExist) stopReasons.push('tran GML はあるが convert-plateau-tran.js 未実行（--inspect → --convert）');

  // 取得メタデータ（配布 ZIP からの展開経路を含む）
  let sourceMeta = null;
  const metaPath = path.join(RAW_TRAN, 'source-metadata.json');
  if (fs.existsSync(metaPath)) { try { sourceMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { /* noop */ } }

  // §30 の実測判定（plateau-tran-coverage.js の結果）を STOP 判定に取り込む
  const COVERAGE = P('data', 'reports', 'plateau-tran-coverage.json');
  let coverage = null;
  if (fs.existsSync(COVERAGE)) {
    try {
      coverage = JSON.parse(fs.readFileSync(COVERAGE, 'utf-8'));
      for (const k of (coverage.failedChecks || [])) {
        stopReasons.push('§30 check 不合格: ' + k + '（実測値 ' + JSON.stringify(coverage.checks[k] && coverage.checks[k].value) + '）');
      }
    } catch { /* noop */ }
  } else if (acquired && polygonsExist) {
    stopReasons.push('§30 カバレッジ/位置整合が未測定（tools/audit/plateau-tran-coverage.js を実行）');
  }

  const RESULT = acquired && polygonsExist && polygonCount > 0 && stopReasons.length === 0 ? 'READY-FOR-POLYGON-FIRST' : 'STOP';

  const report = {
    generatedAt,
    pipeline: {
      fetchScript: 'tools/fetch-plateau.js --layer tran （既存 building fetch は影響なし。--layer 既定 bldg）',
      fetchPlateauTranPatternConfigured: tranPatternConfigured,
      convertScript: 'tools/convert-plateau-tran.js （--inspect で構造確認 → --convert）',
      buildScript: 'tools/build-canonical-roads.js （tran polygon があれば polygon-first。無ければ ribbon fallback）',
      runbook: 'MISSION31C2_RUNBOOK.md',
    },
    acquisition: {
      rawTranDir: toProjectRelativePath(RAW_TRAN),
      rawTranGmlCount: rawGmlCount,
      tranPolygonsConverted: polygonsExist,
      tranPolygonCount: polygonCount,
      conversionReport: fs.existsSync(CONVERSION) ? toProjectRelativePath(CONVERSION) : null,
      acquisitionMethod: sourceMeta ? sourceMeta.acquisitionMethod : null,
      sourceMetadata: sourceMeta,
    },
    spec30Measurement: coverage ? {
      report: toProjectRelativePath(COVERAGE),
      RESULT: coverage.RESULT,
      checks: coverage.checks,
      failedChecks: coverage.failedChecks,
      wardsWithTran: coverage.wardCoverage && coverage.wardCoverage.wardsWithTran,
      cityCellCoverage: coverage.cityCellCoverage,
      osmAlignment: coverage.osmAlignment,
    } : null,
    canonicalRoads: {
      currentPolygonCoverage: canonRoadPolygonCov,
      note: canonRoadPolygonCov && canonRoadPolygonCov.byFeature > 0
        ? 'PLATEAU tran polygon を polygon-first 採用済み'
        : '全 feature が ribbon fallback（Mission31C/31D baseline のまま）',
    },
    stopConditionsSpec30: [
      'tran データが大阪市全域を十分カバーしない → 即 polygon 化せず STOP',
      'geometry CRS を確定できない → STOP（convert-plateau-tran.js --inspect で srsName を確認）',
      'TrafficArea semantics を確定できない → STOP（--inspect で function/usage codelist を確認）',
      'polygon invalid 率が高い → STOP',
      'OSM との位置差が大きすぎる → STOP',
      'PLATEAU dataset 自体が別年度・別位置系で不整合 → STOP',
    ],
    currentStopReasons: stopReasons,
    alternativeSources: [
      'GSI 基盤地図情報「道路縁」(RdEdg) — line geometry のため左右縁 pairing が必要（別課題）',
      '大阪市 道路台帳附図 / 道路区域 — 一部開示請求',
      'OSM area:highway — 大阪市に車道 polygon がほぼ無い（歩行者空間の補助のみ）',
    ],
    RESULT,
    nextAction: RESULT === 'STOP'
      ? 'ローカル PC で MISSION31C2_RUNBOOK.md の手順を実行し tran GML を取得 → convert-plateau-tran.js --inspect で CRS/codelist を確認 → --convert → build-canonical-roads.js 再実行。その後この監査を再実行して READY-FOR-POLYGON-FIRST を確認。'
      : 'build-canonical-roads.js を再実行し polygon coverage を確認。Building∩Road before/after を canonical-conflicts で比較。',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[plateau-tran-acquisition-status] raw tran GML: ' + rawGmlCount + ' / polygons: ' + polygonCount);
  console.log('  canonical roads polygon coverage: ' + JSON.stringify(canonRoadPolygonCov));
  if (stopReasons.length) { console.log('  STOP 理由:'); for (const s of stopReasons) console.log('   - ' + s); }
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + RESULT);
}

main().catch((e) => { console.error('[plateau-tran-acquisition-status] 失敗:', e && e.stack || e); process.exit(1); });
