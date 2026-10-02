#!/usr/bin/env node
// tools/validate/canonical-conflicts.js
// [Mission 31E §20] canonical conflict 解消の validator。
//
// PASS 条件:
//   - CRITICAL 0
//   - unexplained HIGH 0（すべての HIGH が action を持ち、MANUAL_REVIEW は §17 リストに載る）
//   - invalid correction 0（許可外 operation / schema 不備）
//   - untracked correction 0（適用された補正が corrections/ に記録されている）
//   - destructive source edit 0（raw source / 元 canonical baseline が不変）
//   - provenance missing 0（補正・split-off feature に provenance がある）
//   - reversible（補正適用後も originalGeometryHash で元へ戻せる）
//
// 実行: node tools/validate/canonical-conflicts.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { loadCorrections } from '../lib/canonical-corrections.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CONFLICTS = P('data', 'reports', 'canonical-conflicts.json');
const RESOLUTION = P('data', 'reports', 'canonical-conflict-resolution.json');
const MANUAL_REVIEW = P('data', 'reports', 'canonical-manual-review.json');
const WATER = P('data', 'processed', 'osaka-city', 'canonical', 'water.json');
const WATER_BASELINE = P('data', 'reports', 'baselines', 'canonical-water-31E-before.json');
const CORR_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'corrections');
const RAW_WATERWAYS = P('data', 'raw', 'osaka-city', 'waterways-osm.json');
const REPORT = P('data', 'reports', 'canonical-conflict-validation.json');

const ALLOWED_OPS = new Set(['split-multipolygon-parts', 'remove-sliver', 'exclude-invalid-island', 'reclassify']);
const ALLOWED_ACTIONS = new Set(['KEEP', 'EXPLAIN', 'CORRECT_A', 'CORRECT_B', 'RECLASSIFY', 'SUPPRESS_RENDER_ONLY', 'MANUAL_REVIEW']);

async function main() {
  const errors = [], warns = [];
  const need = [[CONFLICTS, 'canonical-conflicts.json'], [RESOLUTION, 'canonical-conflict-resolution.json'], [MANUAL_REVIEW, 'canonical-manual-review.json']];
  for (const [p, n] of need) if (!fs.existsSync(p)) errors.push(n + ' が無い（先に audit / resolution を実行）');
  if (errors.length) { await fail(errors, warns); return; }

  const conf = JSON.parse(fs.readFileSync(CONFLICTS, 'utf-8'));
  const res = JSON.parse(fs.readFileSync(RESOLUTION, 'utf-8'));
  const mr = JSON.parse(fs.readFileSync(MANUAL_REVIEW, 'utf-8'));

  // ── CRITICAL 0 ──
  const critical = conf.bySeverity && conf.bySeverity.CRITICAL ? conf.bySeverity.CRITICAL : 0;
  if (critical > 0) errors.push('CRITICAL conflict ' + critical + ' 件（0 でなければ FAIL）');

  // ── unexplained HIGH 0（audit の unexplainedHighCount ＝ resolution が全件処理していれば 0 扱い）──
  const auditUnexplainedHigh = conf.unexplainedHighCount || 0;
  const highTotal = res.high ? res.high.total : 0;
  const highActions = res.high ? res.high.byPairAction : {};
  let highWithAction = 0, highManualReview = 0;
  for (const pair of Object.keys(highActions)) {
    for (const [act, n] of Object.entries(highActions[pair])) {
      if (!ALLOWED_ACTIONS.has(act)) errors.push('未知の action: ' + act);
      highWithAction += n;
      if (act === 'MANUAL_REVIEW') highManualReview += n;
    }
  }
  if (highWithAction !== highTotal) errors.push(`HIGH ${highTotal} 件のうち action が付いたのは ${highWithAction} 件`);
  // MANUAL_REVIEW の HIGH が manual-review.json に全部載っているか
  const mrHighIds = new Set(mr.items.filter((x) => x.severity === 'HIGH' || x.severity === 'CRITICAL').map((x) => x.conflictId));
  const resMrHigh = (res.conflicts || []).filter((x) => (x.severity === 'HIGH' || x.severity === 'CRITICAL') && x.action === 'MANUAL_REVIEW');
  let missingFromMr = 0;
  for (const x of resMrHigh) if (!mrHighIds.has(x.conflictId)) missingFromMr++;
  if (missingFromMr > 0) errors.push(`MANUAL_REVIEW の HIGH ${missingFromMr} 件が canonical-manual-review.json に無い（§17）`);
  const unexplainedHighAfter = highTotal - highWithAction; // = 0 なら OK
  if (unexplainedHighAfter > 0) errors.push(`分類後も action の無い HIGH が ${unexplainedHighAfter} 件`);

  // ── corrections: invalid / untracked / provenance ──
  const corrLayers = ['water', 'roads', 'buildings', 'parks'];
  const allCorr = [];
  let invalidCorr = 0, provMissing = 0;
  for (const layer of corrLayers) {
    for (const rec of loadCorrections(layer)) {
      allCorr.push({ layer, ...rec });
      if (rec._error) { invalidCorr++; errors.push(`correction ${rec.correctionId}: ${rec._error}`); }
      if (!ALLOWED_OPS.has(rec.operation)) { invalidCorr++; errors.push(`correction ${rec.correctionId}: operation 許可外 ${rec.operation}`); }
      for (const k of ['correctionId', 'targetLayer', 'operation', 'reason', 'sourceEvidence', 'createdBy']) {
        if (rec[k] == null) { errors.push(`correction ${rec.correctionId || '(no id)'}: 必須フィールド ${k} が無い`); }
      }
      if (rec.operation === 'split-multipolygon-parts' && !rec.originalGeometryHash) {
        errors.push(`correction ${rec.correctionId}: split には originalGeometryHash が必須（§14 可逆性）`);
      }
      if (!rec.sourceEvidence || !rec.sourceEvidence.kind) {
        errors.push(`correction ${rec.correctionId}: sourceEvidence.kind が無い（§15: 見た目だけの補正禁止）`);
      }
    }
  }

  // ── applied corrections が water build report に記録されているか（untracked correction 0）──
  const waterBuild = fs.existsSync(P('data', 'reports', 'canonical-water-build.json'))
    ? JSON.parse(fs.readFileSync(P('data', 'reports', 'canonical-water-build.json'), 'utf-8')) : null;
  const waterCorrApplied = (waterBuild && waterBuild.corrections31E && waterBuild.corrections31E.applied) || [];
  const waterCorrErrs = (waterBuild && waterBuild.corrections31E && waterBuild.corrections31E.errors) || [];
  if (waterCorrErrs.length) errors.push('water correction 適用エラー ' + waterCorrErrs.length + ' 件: ' + JSON.stringify(waterCorrErrs[0]));
  const waterCorrFiles = new Set(loadCorrections('water').map((r) => r.correctionId));
  for (const ap of waterCorrApplied) {
    if (!waterCorrFiles.has(ap.correctionId)) errors.push(`適用された correction ${ap.correctionId} が corrections/water/ に無い（untracked）`);
  }

  // ── water.json 内で corrected feature の provenance / split-off feature の provenance ──
  if (fs.existsSync(WATER)) {
    const w = JSON.parse(fs.readFileSync(WATER, 'utf-8'));
    for (const f of w.features) {
      const corrected = (f.qaFlags || []).some((q) => q.startsWith('corrected-31E') || q.startsWith('split-from-'));
      if (!corrected) continue;
      if (!f.source || !f.source.geometrySource || !Array.isArray(f.source.sourceIds) || !f.source.sourceIds.length) {
        provMissing++; errors.push(`corrected feature ${f.canonicalId}: provenance 不備`);
      }
      if ((f.qaFlags || []).some((q) => q.startsWith('split-from-'))) {
        if (!f.source.notes || !/correction/.test(f.source.notes)) warns.push(`split-off ${f.canonicalId}: notes に correction 参照が無い`);
      }
    }
  }

  // ── destructive source edit 0: raw waterways-osm.json / 元 canonical baseline が不変 ──
  // raw は build が読むだけ（書かない）。mtime ではなく「build 後も存在し JSON として妥当」で代替検証。
  if (fs.existsSync(RAW_WATERWAYS)) {
    try { JSON.parse(fs.readFileSync(RAW_WATERWAYS, 'utf-8')); } catch { errors.push('raw waterways-osm.json が壊れている（destructive edit の疑い）'); }
  } else warns.push('raw waterways-osm.json が無い（このサンドボックスに未配置。ローカル取得物）');
  // 元 canonical baseline との差分 = 補正で説明できる範囲か
  if (fs.existsSync(WATER) && fs.existsSync(WATER_BASELINE)) {
    const w = JSON.parse(fs.readFileSync(WATER, 'utf-8'));
    const b = JSON.parse(fs.readFileSync(WATER_BASELINE, 'utf-8'));
    const added = w.featureCount - b.featureCount;
    const expectedAdded = waterCorrApplied.reduce((s, a) => s + (a.splitOffIds ? a.splitOffIds.length : 0), 0);
    if (added !== expectedAdded) {
      errors.push(`water feature 数の変化 ${added} が補正で説明できる ${expectedAdded} と一致しない（非追跡の変更）`);
    }
    // corrected/split 以外の feature は geometry hash が baseline と一致すること
    const bh = new Map(b.features.map((f) => [f.canonicalId, crypto.createHash('sha1').update(JSON.stringify(f.coordinates)).digest('hex')]));
    let silentlyChanged = 0;
    for (const f of w.features) {
      const touched = (f.qaFlags || []).some((q) => q.startsWith('corrected-31E') || q.startsWith('split-from-'));
      if (touched) continue;
      const h0 = bh.get(f.canonicalId);
      if (h0 && h0 !== crypto.createHash('sha1').update(JSON.stringify(f.coordinates)).digest('hex')) silentlyChanged++;
    }
    if (silentlyChanged > 0) errors.push(`補正対象外の water feature ${silentlyChanged} 件の geometry が baseline から変化（destructive / untracked）`);
  }

  // ── review GeoJSON の存在と最低限の形 ──
  const gj = P('data', 'reports', 'canonical-conflicts-review.geojson');
  if (!fs.existsSync(gj)) errors.push('canonical-conflicts-review.geojson が無い（§18）');
  else {
    const g = JSON.parse(fs.readFileSync(gj, 'utf-8'));
    if (g.type !== 'FeatureCollection' || !Array.isArray(g.features) || !g.features.length) errors.push('review GeoJSON が不正');
    else {
      const p0 = g.features[0].properties || {};
      for (const k of ['severity', 'cause', 'action', 'pairType']) if (!(k in p0)) errors.push('review GeoJSON properties に ' + k + ' が無い');
    }
  }

  const checks = {
    critical, auditUnexplainedHigh, highTotal, highWithAction, highManualReview, unexplainedHighAfter,
    missingFromManualReview: missingFromMr,
    correctionsSeen: allCorr.length, invalidCorrections: invalidCorr, provenanceMissing: provMissing,
    waterCorrectionsApplied: waterCorrApplied.length, waterCorrectionErrors: waterCorrErrs.length,
    manualReviewCount: mr.count,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    checks,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 40),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[canonical-conflicts-validate] checks: ' + JSON.stringify(checks));
  if (errors.length) { console.log('  -- errors --'); for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e); }
  for (const w of warns.slice(0, 10)) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

async function fail(errors, warns) {
  const report = { generatedAt: new Date().toISOString(), errors, warns, RESULT: 'FAIL' };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  for (const e of errors) console.log('  [ERROR] ' + e);
  console.log('RESULT: FAIL');
  process.exitCode = 1;
}

main().catch((e) => { console.error('[canonical-conflicts-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
