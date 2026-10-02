#!/usr/bin/env node
// tools/audit/fallback-building-color.js
// [追加修正タスク｜fallback建物の色未適用] §1-A 色未適用の切り分け監査。
//   OSM fallback 建物レコードの usage / normalizedUsage / usageCategory / usageLabel を全件検査し、
//   「null のまま描画へ流れる」「灰色の既定カテゴリへ落ちるだけで用途色に乗らない」ケースを列挙する。
//   HTML 側（ward-ux-v1.html）の tint 配線（fallbackTint / __lodTint / __FALLBACK_BUILDING_DEBUG__）も確認。
//   出力: data/reports/fallback-building-color-audit.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { BUILDING_CATEGORY_LABEL, DEFAULT_BUILDING_CATEGORY, resolveFallbackUsage } from '../lib/osm-building-fallback.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DS_DIR = P('public', 'map-data', 'osaka-city', 'buildings', 'osaka-osm-fallback');
const HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const REPORT = P('data', 'reports', 'fallback-building-color-audit.json');

const CATEGORY_KEYS = new Set(Object.keys(BUILDING_CATEGORY_LABEL));
const BAD_LABELS = new Set(['null', 'undefined', 'その他(null)', 'その他（null）', 'その他', '']);

function loadFallbackBuildings() {
  const out = [];
  if (!fs.existsSync(DS_DIR)) return out;
  for (const f of fs.readdirSync(DS_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(DS_DIR, f), 'utf-8'));
    for (const b of (t.buildings || [])) out.push({ ...b, __tile: f.replace(/\.json$/, '') });
  }
  return out;
}

async function main() {
  const blds = loadFallbackBuildings();
  const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

  const byCategory = {};
  const issues = { missingNormalizedUsage: [], missingCategory: [], invalidCategory: [], badLabel: [], categoryMismatch: [] };
  let nullRawUsage = 0, defaultCategory = 0, coloredCategory = 0;

  for (const b of blds) {
    const nu = b.normalizedUsage, cat = b.usageCategory, label = b.usageLabel;
    byCategory[cat || '(none)'] = (byCategory[cat || '(none)'] || 0) + 1;
    if (b.usage == null) nullRawUsage++;
    if (!nu || typeof nu !== 'string') issues.missingNormalizedUsage.push(b.id);
    if (!cat || typeof cat !== 'string') issues.missingCategory.push(b.id);
    else if (!CATEGORY_KEYS.has(cat)) issues.invalidCategory.push({ id: b.id, cat });
    if (!label || typeof label !== 'string' || BAD_LABELS.has(label.trim())) issues.badLabel.push({ id: b.id, label: label ?? null });
    if (cat === DEFAULT_BUILDING_CATEGORY) defaultCategory++; else if (cat) coloredCategory++;
    // 期待カテゴリと突合（純ロジックとの一致）
    const exp = resolveFallbackUsage(b.usage || (b.normalizedUsage === 'yes' ? 'yes' : b.normalizedUsage));
    if (cat && exp.category !== cat) issues.categoryMismatch.push({ id: b.id, got: cat, expected: exp.category });
  }

  const htmlChecks = {
    fallbackTintHelper: /function fallbackTint\(category\)/.test(html),
    lodTintApplied: /b\.__lodTint = fallbackTint\(b\.usageCategory\)/.test(html),
    appendBuildingUsesTint: /const T = b\.__lodTint \|\| ONE3;/.test(html),
    tintWhiteBlendConst: /const FALLBACK_TINT_WHITE_BLEND = /.test(html),
    fallbackDebugApi: /window\.__FALLBACK_BUILDING_DEBUG__ =/.test(html),
    popupNullSafe: /function usageDisplayName\(d\)/.test(html) && !/\(UN\[d\.usage\]\|\|'その他'\)\+'（コード:'\+d\.usage/.test(html),
  };

  const totalIssues = Object.values(issues).reduce((s, a) => s + a.length, 0);
  const htmlOk = Object.values(htmlChecks).every(Boolean);
  const RESULT = (totalIssues === 0 && htmlOk && blds.length > 0) ? 'PASS' : 'FAIL';

  const report = {
    generatedAt: new Date().toISOString(),
    dataset: toProjectRelativePath(DS_DIR),
    fallbackBuildings: blds.length,
    nullRawUsage,
    defaultCategoryCount: defaultCategory,     // usage 不明 → 'other'（薄い既定色。灰色ベタ塗りではない）
    coloredCategoryCount: coloredCategory,      // 具体的な用途カテゴリ
    byCategory,
    categoryLabels: BUILDING_CATEGORY_LABEL,
    issueCounts: Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, v.length])),
    issues: Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, v.slice(0, 20)])),
    htmlChecks,
    diagnosis: totalIssues === 0
      ? 'fallback 全件が usageCategory / usageLabel を持ち、null は描画・popup へ流れない。'
      : 'usage 正規化に欠落あり（issues 参照）。',
    RESULT,
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[fallback-building-color] buildings=' + blds.length + ' nullRawUsage=' + nullRawUsage
    + ' default=' + defaultCategory + ' colored=' + coloredCategory + ' issues=' + totalIssues + ' htmlOk=' + htmlOk);
  console.log('  byCategory: ' + JSON.stringify(byCategory));
  console.log('  htmlChecks: ' + JSON.stringify(htmlChecks));
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + RESULT);
  if (RESULT !== 'PASS') process.exitCode = 1;
}

main().catch((e) => { console.error('[fallback-building-color] 失敗:', e && e.stack || e); process.exitCode = 1; });
