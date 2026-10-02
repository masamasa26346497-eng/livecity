#!/usr/bin/env node
// tools/validate/fallback-building.js
// [追加修正タスク｜fallback建物の色未適用 & 範囲外表示] 完了条件の validator ゲート。
//
// PASS 条件:
//   - fallback 建物レコード全件が usageCategory / usageLabel / normalizedUsage を持つ（null を描画へ流さない）
//   - usageLabel が "null" / "その他(null)" 等の生の未分類表示でない
//   - fallback 建物全件が有効な wardId を持ち、centroid 再判定と一致（区所属が健全）
//   - color audit / ward-scope audit が両方 PASS
//   - HTML（ward-ux-v1.html）配線: fallbackTint / __lodTint / FALLBACK_KEY_PREFIX /
//     applyBand の区スコープ / __FALLBACK_BUILDING_DEBUG__ / popup null-safe
//   - production / protected HTML に本タスクの変更が混入していない
//
// 実行: node tools/validate/fallback-building.js
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const COLOR_AUDIT = P('data', 'reports', 'fallback-building-color-audit.json');
const SCOPE_AUDIT = P('data', 'reports', 'fallback-building-ward-scope-audit.json');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROT_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const REPORT = P('data', 'reports', 'fallback-building-validation.json');

function runAudit(rel) {
  try { execFileSync('node', [P(...rel.split('/'))], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
}

async function main() {
  const errors = [];
  // 監査を最新化してから読む
  runAudit('tools/audit/fallback-building-color.js');
  runAudit('tools/audit/fallback-building-ward-scope.js');

  const color = fs.existsSync(COLOR_AUDIT) ? JSON.parse(fs.readFileSync(COLOR_AUDIT, 'utf-8')) : null;
  const scope = fs.existsSync(SCOPE_AUDIT) ? JSON.parse(fs.readFileSync(SCOPE_AUDIT, 'utf-8')) : null;

  if (!color) errors.push('color audit レポートなし');
  else {
    if (color.RESULT !== 'PASS') errors.push('color audit FAIL: ' + JSON.stringify(color.issueCounts));
    if (!(color.fallbackBuildings > 0)) errors.push('fallback 建物 0');
    const ic = color.issueCounts || {};
    for (const k of ['missingNormalizedUsage', 'missingCategory', 'invalidCategory', 'badLabel', 'categoryMismatch']) {
      if ((ic[k] || 0) > 0) errors.push('color issue ' + k + '=' + ic[k]);
    }
  }
  if (!scope) errors.push('ward-scope audit レポートなし');
  else {
    if (scope.RESULT !== 'PASS') errors.push('ward-scope audit FAIL');
    if ((scope.missingWardId || 0) > 0) errors.push('wardId 欠落 ' + scope.missingWardId);
    if ((scope.invalidWardId || 0) > 0) errors.push('無効 wardId ' + scope.invalidWardId);
    if ((scope.centroidMismatch || 0) > 0) errors.push('centroid 区不一致 ' + scope.centroidMismatch);
  }

  // HTML 配線（audit 内でも見るが validator でも独立チェック）
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';
  const wiring = {
    fallbackTint: /function fallbackTint\(category\)/.test(html),
    lodTint: /b\.__lodTint = fallbackTint\(b\.usageCategory\)/.test(html) && /const T = b\.__lodTint \|\| ONE3;/.test(html),
    keyPrefix: /const FALLBACK_KEY_PREFIX = 'osm-fallback:';/.test(html),
    applyBandScope: /const wardScoped = !cityActive && !!curWard;/.test(html) && /wardScoped && wid !== curWard/.test(html),
    debugApi: /window\.__FALLBACK_BUILDING_DEBUG__ =/.test(html) && /function getFallbackDebug\(\)/.test(html),
    popupNullSafe: /function usageDisplayName\(d\)/.test(html) && !/\(UN\[d\.usage\]\|\|'その他'\)\+' \('\+d\.usage/.test(html),
    mission27Intact: /minor: visible && far, major: visible && \(far \|\| mid\)/.test(html) && /function setCameraDistance\(r\) \{\s*lastCameraDistance = r;\s*applyBand\(\);\s*\}/.test(html),
  };
  for (const [k, ok] of Object.entries(wiring)) if (!ok) errors.push('HTML 配線 ' + k + ' が無い');

  for (const [label, p] of [['production', PROD_HTML], ['protected', PROT_HTML]]) {
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    if (/__FALLBACK_BUILDING_DEBUG__|fallbackTint|FALLBACK_KEY_PREFIX|__lodTint/.test(h)) errors.push(label + ' HTML に本タスクの変更が混入');
  }

  const report = {
    generatedAt: new Date().toISOString(),
    colorAudit: color ? { RESULT: color.RESULT, fallbackBuildings: color.fallbackBuildings, nullRawUsage: color.nullRawUsage, byCategory: color.byCategory } : null,
    wardScopeAudit: scope ? { RESULT: scope.RESULT, missingWardId: scope.missingWardId, invalidWardId: scope.invalidWardId, centroidMismatch: scope.centroidMismatch, straddleWardBuildings: scope.straddleWardBuildings } : null,
    htmlWiring: wiring,
    errorCount: errors.length, errors,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  if (errors.length) { console.log('-- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  console.log('保存: ' + toProjectRelativePath(REPORT));
  console.log('RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[fallback-building-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
