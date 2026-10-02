#!/usr/bin/env node
// tools/validate/building-visual-gaps.js
// [Mission21C §12] 実機視覚 building gap の突合 validator CLI。
//
// PASS 条件（§10）:
//   - sparse mismatch residual = 0（fallback 後も OSM >> PLATEAU の cell が残らない）
//   - sparse mismatch missed = 0（OSM dense / PLATEAU sparse の見落としなし）
//   - runtime loaded but invisible = 0（tile 生成漏れ 0）
//   - unexplained visual gap cluster = 0・全クラスタ cause 付き
//   - duplicate fallback = 0（sparse-mismatch も含めた polygon 重複）
//   - footprint 面積 coverage が fallback で改善（PLATEAU-only < +fallback）
//   - HTML: __VISIBLE_BUILDING_GAP_DEBUG__ / __BUILDING_GAP_FOCUS__ 配線
//   - protected / production HTML に Mission21C の変更が混入していない
//
// 実行: node tools/validate/building-visual-gaps.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const RECON = P('data', 'reports', 'building-visual-gap-reconciliation.json');
const FB_VALIDATION = P('data', 'reports', 'building-coverage-validation.json');
const REPORT = P('data', 'reports', 'building-visual-gaps-validation.json');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(RECON)) { console.error('[stop] 入力なし: ' + toProjectRelativePath(RECON) + '\n  先に: node tools/audit/building-visual-gap.js'); process.exitCode = 1; return; }
  const r = JSON.parse(fs.readFileSync(RECON, 'utf-8'));

  const sm = r.sparseMismatch || {};
  if ((sm.residualCells || 0) !== 0) errors.push('sparse mismatch residual cell ' + sm.residualCells);
  if ((sm.missedCells || 0) !== 0) errors.push('sparse mismatch missed cell ' + sm.missedCells + ': ' + (sm.missedCellList || []).slice(0, 6).join(', '));
  if ((r.runtimeMissing || 0) !== 0) errors.push('runtime loaded but invisible（missing tile）' + r.runtimeMissing);

  const vg = r.visualGapClusters || [];
  const noCause = vg.filter((c) => !c.likelyCause);
  if (noCause.length) errors.push('cause 未設定の visual gap cluster ' + noCause.length);
  if (r.remainingExplained && r.remainingExplained.unexplained > 0) errors.push('unexplained visual gap cluster ' + r.remainingExplained.unexplained);

  const fac = r.footprintAreaCoverage || {};
  if (!(fac.plateauPlusFallback > fac.plateauOnly)) errors.push('footprint 面積 coverage が fallback で改善していない: ' + fac.plateauOnly + ' → ' + fac.plateauPlusFallback);

  // fallback dedup（building-coverage-validation.json の結果を確認）
  if (fs.existsSync(FB_VALIDATION)) {
    const fv = JSON.parse(fs.readFileSync(FB_VALIDATION, 'utf-8'));
    const ck = fv.checks || {};
    if ((ck.fbSparseDup || 0) > Math.max(5, ((ck.fbByReason && ck.fbByReason['sparse-mismatch']) || 0) * 0.001)) errors.push('duplicate fallback（sparse-mismatch polygon 重複）' + ck.fbSparseDup);
    if ((ck.fbDupId || 0) > 0) errors.push('duplicate fallback id ' + ck.fbDupId);
    if (fv.RESULT !== 'PASS') errors.push('building-coverage validator が PASS でない');
  } else {
    warns.push('building-coverage-validation.json が無い（node tools/validate/building-coverage.js）');
  }

  // ── HTML 配線 ──
  if (fs.existsSync(DEV_HTML)) {
    const html = fs.readFileSync(DEV_HTML, 'utf-8');
    if (!/__VISIBLE_BUILDING_GAP_DEBUG__/.test(html)) errors.push('dev HTML に __VISIBLE_BUILDING_GAP_DEBUG__ が無い');
    if (!/__BUILDING_GAP_FOCUS__/.test(html)) errors.push('dev HTML に __BUILDING_GAP_FOCUS__ が無い');
    if (!/getBuildingCellCounts/.test(html)) errors.push('dev HTML: BuildingTileLayer.getBuildingCellCounts が無い');
    if (!/getRoadCellCoverage/.test(html)) errors.push('dev HTML: CityTileLayer.getRoadCellCoverage が無い');
    if (!/!b\.heightUnknown/.test(html)) errors.push('dev HTML: 実高不明建物を高さ階級から除外する処理が無い（§6）');
  }
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(label + ' HTML なし'); continue; }
    const h = fs.readFileSync(p, 'utf-8');
    if (/__VISIBLE_BUILDING_GAP_DEBUG__|__BUILDING_GAP_FOCUS__|getBuildingCellCounts|getRoadCellCoverage/.test(h)) errors.push(label + ' HTML に Mission21C の変更が混入している');
  }

  console.log('[building-visual-gaps-validate] footprint coverage PLATEAU ' + (fac.plateauOnly * 100).toFixed(1) + '% → +fallback ' + (fac.plateauPlusFallback * 100).toFixed(1) + '%');
  console.log('  fallback: ' + JSON.stringify(r.fallbackAdded) + ' / duplicatesRejected ' + r.duplicatesRejected);
  console.log('  sparse-mismatch: before ' + sm.cellsBeforeFallback + ' → residual ' + sm.residualCells + ' / missed ' + sm.missedCells + ' / granularityOnly ' + sm.granularityOnlyCells);
  console.log('  visual gap cluster ' + vg.length + ' (unexplained ' + (r.remainingExplained && r.remainingExplained.unexplained) + ') / runtimeMissing ' + r.runtimeMissing);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    footprintAreaCoverage: fac,
    fallbackAdded: r.fallbackAdded, duplicatesRejected: r.duplicatesRejected,
    sparseMismatch: sm,
    visualGapClusters: vg.length, causeBreakdown: r.causeBreakdown, runtimeMissing: r.runtimeMissing,
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[building-visual-gaps-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
