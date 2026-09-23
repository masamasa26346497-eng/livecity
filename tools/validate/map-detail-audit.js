#!/usr/bin/env node
// tools/validate/map-detail-audit.js
// [Mission30 §17] 大阪市全域 細部欠落総合監査 validator。
//
// PASS 条件:
//   CRITICAL = 0 / HIGH = 0 / unexplained = 0
//   MEDIUM: 0 または全件 §5 cause で説明可能
//   layer QA（land / roads / buildings / waterways / parks / railways / sea）すべて pass
//   duplicate 0 / invalid geometry 0（buildings QA 経由）
//   runtimeMissing 0（map-completeness runtime）
//   全 anomaly に §5 cause taxonomy の値
//   representative QA に FAIL 無し
//   performance regression なし
//   HTML: __MAP_DETAIL_AUDIT_DEBUG__ 配線（summary のみ・runtime へ anomaly 配列を常時載せない）
//   map completeness 100 維持 / production・protected 無変更
//
// 実行: node tools/validate/map-detail-audit.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { CAUSE, isExplainableCause } from '../lib/map-detail-audit.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AUDIT = P('data', 'reports', 'map-detail-audit.json');
const MC = P('data', 'reports', 'map-completeness-audit.json');
const MCV = P('data', 'reports', 'map-completeness-validation.json');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const REPORT = P('data', 'reports', 'map-detail-audit-validation.json');
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; } };

async function main() {
  const errors = [], warns = [];
  const a = rd(AUDIT);
  if (!a) { console.error('[stop] map-detail-audit.json なし。先に node tools/audit/map-detail-audit.js'); process.exitCode = 1; return; }

  if (a.criticalCount !== 0) errors.push('CRITICAL ' + a.criticalCount);
  if (a.highCount !== 0) errors.push('HIGH ' + a.highCount);
  if (a.unexplained !== 0) errors.push('unexplained ' + a.unexplained);
  if (a.RESULT !== 'PASS') errors.push('audit RESULT = ' + a.RESULT);

  // MEDIUM は 0 または全件説明可能
  if ((a.mediumCount || 0) > 0) {
    const medUnexplained = a.anomalySummary && a.anomalySummary.unexplained;
    if (medUnexplained > 0) errors.push('MEDIUM anomaly に説明不能なものがある ' + medUnexplained);
    else warns.push('MEDIUM anomaly ' + a.mediumCount + ' 件（全件 cause 付き）');
  }

  // 全 anomaly に taxonomy 値
  for (const [c, n] of Object.entries(a.causeCounts || {})) {
    if (!CAUSE.includes(c)) errors.push('未知の cause: ' + c + ' (' + n + ')');
  }

  // layer QA すべて pass
  for (const [L, q] of Object.entries(a.layerQa || {})) {
    if (!q.pass) errors.push('layer QA 未 pass: ' + L + ' (' + JSON.stringify(q) + ')');
  }
  // buildings: duplicate / invalid
  if (a.layerQa && a.layerQa.buildings) {
    if ((a.layerQa.buildings.duplicate || 0) !== 0) errors.push('building duplicate ' + a.layerQa.buildings.duplicate);
    if ((a.layerQa.buildings.invalid || 0) !== 0) errors.push('building invalid geometry ' + a.layerQa.buildings.invalid);
    if (a.layerQa.buildings.unexplainedGapClusters !== 0) errors.push('building unexplained gap cluster ' + a.layerQa.buildings.unexplainedGapClusters);
  }
  // roads: §8 東淀川区・淀川区 が SOURCE_MISSING で正しく説明されている
  const smWards = (a.sourceMissing || []).filter((s) => s.layer === 'roads').map((s) => s.ward);
  for (const w of ['higashiyodogawa', 'yodogawa']) {
    if (!smWards.includes(w)) errors.push(w + ' が roads の sourceMissing に無い（§8）');
  }
  // waterways: §10 missingSurfaceWater 0
  if (a.layerQa && a.layerQa.waterways && a.layerQa.waterways.missingSurfaceWater !== 0) errors.push('missingSurfaceWater ' + a.layerQa.waterways.missingSurfaceWater);

  // representative QA に FAIL なし
  const repFail = (a.representativeQa || []).filter((r) => r.status === 'FAIL');
  if (repFail.length) errors.push('representative QA FAIL: ' + repFail.map((r) => r.name).join(', '));
  if ((a.representativeQa || []).length < 24) warns.push('representative QA が ' + (a.representativeQa || []).length + ' 点（24 未満）');

  // performance regression なし
  if (!(a.performanceRegression && a.performanceRegression.pass)) errors.push('performance regression: ' + JSON.stringify(a.performanceRegression));

  // runtimeMissing 0（map-completeness の runtime）
  const mc = rd(MC);
  if (mc) {
    if (mc.overallScore !== 100 || mc.criticalCount !== 0 || mc.highCount !== 0) errors.push('map completeness が 100 でない');
  } else warns.push('map-completeness-audit.json なし');
  const mcv = rd(MCV);
  if (mcv && mcv.RESULT !== 'PASS') errors.push('map-completeness validator が PASS でない');

  // HTML 配線
  if (fs.existsSync(DEV_HTML)) {
    const html = fs.readFileSync(DEV_HTML, 'utf-8');
    if (!/window\.__MAP_DETAIL_AUDIT_DEBUG__ = function/.test(html)) errors.push('dev HTML: __MAP_DETAIL_AUDIT_DEBUG__ が無い');
    // summary のみ: 大量 anomaly 配列を runtime へ常時載せない
    const fn = html.slice(html.indexOf('window.__MAP_DETAIL_AUDIT_DEBUG__'), html.indexOf('window.__MAP_DETAIL_AUDIT_DEBUG__') + 2000);
    if (/anomalies:\s*\[/.test(fn) && !/reportPath/.test(fn)) errors.push('dev HTML: __MAP_DETAIL_AUDIT_DEBUG__ が anomaly 配列を常時ロードしている（summary のみにすること）');
    for (const kw of ['__MAP_COMPLETENESS_DEBUG__', '__PERFORMANCE_DEBUG__']) {
      if (!html.includes(kw)) errors.push('dev HTML: 既存 ' + kw + ' が消えた');
    }
  }
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(label + ' HTML なし'); continue; }
    const h = fs.readFileSync(p, 'utf-8');
    if (/__MAP_DETAIL_AUDIT_DEBUG__/.test(h)) errors.push(label + ' HTML に Mission30 の変更が混入');
  }

  console.log('[map-detail-audit-validate] overallScore ' + a.overallScore + ' / CRITICAL ' + a.criticalCount + ' HIGH ' + a.highCount + ' MEDIUM ' + a.mediumCount + ' / unexplained ' + a.unexplained);
  console.log('  anomaly type: ' + JSON.stringify(a.anomalyTypeCounts) + '  cause: ' + JSON.stringify(a.causeCounts));
  console.log('  layer QA: ' + Object.entries(a.layerQa || {}).map(([k, v]) => k + ' ' + (v.pass ? 'PASS' : 'FAIL')).join(' / '));
  console.log('  representative: ' + (a.representativeQa || []).filter((r) => r.status !== 'FAIL').length + '/' + (a.representativeQa || []).length + '  sourceMissing: ' + (a.sourceMissing || []).map((s) => s.ward + '/' + s.layer).join(', '));
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    overallScore: a.overallScore, verdict: a.verdict,
    counts: { critical: a.criticalCount, high: a.highCount, medium: a.mediumCount, low: a.lowCount, info: a.infoCount, unexplained: a.unexplained },
    anomalyTypeCounts: a.anomalyTypeCounts, causeCounts: a.causeCounts,
    layerScores: a.layerScores,
    layerQaPass: Object.fromEntries(Object.entries(a.layerQa || {}).map(([k, v]) => [k, !!v.pass])),
    representativeFail: repFail.map((r) => r.name),
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[map-detail-audit-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
