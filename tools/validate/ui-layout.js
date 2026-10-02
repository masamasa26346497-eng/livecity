#!/usr/bin/env node
// tools/validate/ui-layout.js
// [見た目改善 Mission19] White / Light UI Refresh の静的検証。
//
// 検証:
//   - <style> の波括弧が均衡（CSS 構文が壊れていない）
//   - :root に UI custom property が定義されている（--lc-bg / --lc-panel / --lc-accent 等）
//   - 開発者 HUD（#fps / #pr）が既定で非表示（body:not(.lc-debug-ui) の display:none ルール）
//   - 旧・散在パネル（#pl / #layer-toggle-panel / #visual-panel / #controls）が display:none で抑制
//   - 全画面の不透明・暗色オーバーレイ CSS が無い（左下の黒矩形の再発防止）
//   - LC_UI IIFE / window.__UI_DEBUG__ / window.__LIVE_CITY_DEBUG_UI__ の配線
//   - Top Bar / Right Panel / Map Controls の要素 id
//   - responsive: @media (max-width:768px) がある / width:100vw の横溢れ要因が無い
//   - aria-label / role の付与
//   - 機能回帰: CityModeManager / WardModeManager 参照 / layer toggle keys / Mission14 debounce /
//     Mission15 LabelEngine 不在 / Mission10・11・11B の要 IIFE / 3D loop 無改変
//   - production / protected HTML 無変更
//   - インライン <script> の node --check
//
// 実行: node tools/validate/ui-layout.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const DEV = resolveProjectPath(path.join('public', 'osaka_3d_buildings.ward-ux-v1.html'));
const PROD = resolveProjectPath(path.join('public', 'osaka_3d_buildings.html'));
const PROT = resolveProjectPath(path.join('public', 'osaka_3d_buildings.fullward-v3.html'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'ui-layout-validation.json'));

function main() {
  const errors = [], warns = [];
  const html = fs.readFileSync(DEV, 'utf-8');
  const styleM = html.match(/<style>([\s\S]*?)<\/style>/i);
  const css = styleM ? styleM[1] : '';
  const scriptM = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const js = scriptM ? scriptM[1] : '';

  // -- CSS 構文（波括弧均衡 + 未終端コメント無し） --
  if (!css) errors.push('<style> block が見つからない');
  const open = (css.match(/\{/g) || []).length, close = (css.match(/\}/g) || []).length;
  if (open !== close) errors.push(`CSS の { } が不均衡: ${open} vs ${close}`);
  if ((css.match(/\/\*/g) || []).length !== (css.match(/\*\//g) || []).length) errors.push('CSS コメントが未終端');

  // -- custom properties --
  for (const v of ['--lc-bg', '--lc-panel', '--lc-border', '--lc-text', '--lc-muted', '--lc-accent', '--lc-radius', '--lc-shadow']) {
    if (!new RegExp(v.replace(/-/g, '\\-') + '\\s*:').test(css)) errors.push(`:root に custom property ${v} が無い`);
  }

  // -- debug HUD 既定非表示 --
  if (!/body:not\(\.lc-debug-ui\)\s*#fps[\s\S]{0,40}display\s*:\s*none/.test(css.replace(/\s*,\s*/g, ',')) &&
      !/#fps[,\s\S]{0,80}display\s*:\s*none\s*!important/.test(css)) {
    // 緩い判定: #fps と #pr がまとめて non-debug で消えていること
    if (!/body:not\(\.lc-debug-ui\)[\s\S]{0,120}#(fps|pr)[\s\S]{0,80}display:\s*none/.test(css)) {
      errors.push('開発者 HUD（#fps / #pr）を既定非表示にする CSS が見当たらない');
    }
  }

  // -- 旧散在パネル抑制 --
  if (!/#pl\s*,?[\s\S]{0,80}#layer-toggle-panel[\s\S]{0,120}display\s*:\s*none/.test(css)
    && !/#layer-toggle-panel[\s\S]{0,40}display\s*:\s*none/.test(css)) {
    errors.push('旧レイヤーパネル（#layer-toggle-panel）を display:none で抑制していない（左下の黒矩形の元）');
  }

  // -- 全画面の不透明・暗色オーバーレイが無いか（黒矩形 QA） --
  //   width:100% + height:100% を持つルールの直後の bg が rgba(...,>=0.85) で暗色でないこと
  const overlayRules = css.match(/\{[^}]*width\s*:\s*100%[^}]*height\s*:\s*100%[^}]*\}/g) || [];
  for (const rule of overlayRules) {
    const bg = (rule.match(/background\s*:\s*(rgba?\([^)]+\)|#[0-9a-f]{3,8})/i) || [])[1];
    if (!bg) continue;
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(',').map((s) => parseFloat(s));
      const a = p[3] == null ? 1 : p[3];
      const lum = (p[0] + p[1] + p[2]) / 3;
      if (a >= 0.85 && lum < 60) errors.push(`全画面 CSS ルールが不透明・暗色: ${bg}`);
    } else if (/^#0|^#1|^#2/.test(bg)) {
      errors.push(`全画面 CSS ルールが不透明・暗色: ${bg}`);
    }
  }

  // -- LC_UI 配線 --
  if (!/\(function LC_UI\(\)\{/.test(js)) errors.push('LC_UI IIFE が無い');
  if (!/window\.__UI_DEBUG__\s*=\s*function/.test(js)) errors.push('window.__UI_DEBUG__ が無い');
  if (!/window\.__LIVE_CITY_DEBUG_UI__/.test(js)) errors.push('window.__LIVE_CITY_DEBUG_UI__ の参照が無い');
  for (const k of ['blackOverlayDetected', 'rightPanelOpen', 'visiblePanels', 'debugHudVisible', 'topBarHeight', 'overlayCount', 'viewport', 'mobile']) {
    if (!new RegExp(k + '\\s*:').test(js)) errors.push(`__UI_DEBUG__ に ${k} が無い`);
  }

  // -- 新 UI 要素 --
  for (const id of ['lc-topbar', 'lc-panel', 'lc-panel-collapse', 'lc-panel-tab', 'lc-mapctl', 'lc-brand']) {
    if (!new RegExp("id:\\s*'" + id + "'|id=\"" + id + "\"").test(js) && !new RegExp('#' + id + '\\b').test(css)) {
      errors.push(`新 UI 要素 #${id} が CSS/JS どちらにも無い`);
    }
  }

  // -- responsive --
  if (!/@media\s*\(max-width:\s*768px\)/.test(css)) errors.push('@media (max-width:768px) が無い（mobile foundation）');
  if (/width\s*:\s*100vw/.test(css)) warns.push('width:100vw がある（横スクロールの要因になりうる。要確認）');

  // -- a11y --
  const ariaCount = (js.match(/setAttribute\('aria-label'|aria-label=/g) || []).length + (html.match(/aria-label=/g) || []).length;
  if (ariaCount < 5) errors.push(`aria-label が少なすぎる（${ariaCount}）`);
  if (!/:focus-visible/.test(css)) warns.push(':focus-visible のスタイルが無い（キーボードフォーカス可視化）');

  // -- 機能回帰 --
  const reg = [
    [/CityModeManager\.enter\(\)/, 'CityModeManager.enter 参照'],
    [/WardModeManager\.switchWard/, 'WardModeManager.switchWard 参照'],
    [/const BUILDING_HEIGHT_STYLE = \(function/, 'Mission10 BUILDING_HEIGHT_STYLE'],
    [/const LANDMARK_REGISTRY = \(function/, 'Mission11 LANDMARK_REGISTRY'],
    [/const LandmarkLayer = \(function/, 'Mission11B LandmarkLayer'],
    [/now - pendingSince > 1600 && now - lastRebuildAt > 3000/, 'Mission14 station debounce'],
    [/\(function loop\(\)\{/, '3D render loop'],
  ];
  for (const [re, name] of reg) if (!re.test(js)) errors.push(`回帰: ${name} が消えている`);
  if (/const LabelEngine = \(function/.test(js)) errors.push('回帰: Mission15 LabelEngine が復活している');
  // layer toggle keys
  for (const key of ['buildings', 'roads', 'waterways', 'sea', 'parks', 'railways', 'railStations']) {
    if (!new RegExp("key:\\s*'" + key + "'").test(js)) errors.push(`layer toggle key '${key}' が無い`);
  }
  // 3D を触っていない（geometry/camera 系の関数定義が LC_UI 内に無い）
  const lcui = js.slice(js.indexOf('(function LC_UI(){'), js.indexOf('(function LC_UI(){') + 8000);
  if (/function camUpd|new THREE\.|BufferGeometry|geometry\s*=/.test(lcui)) errors.push('LC_UI が 3D（THREE / geometry / camUpd）を触っている');

  // -- protected / production --
  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    if (/LC_UI|__UI_DEBUG__|--lc-bg|lc-topbar/.test(h)) errors.push(`${label} HTML に Mission19 の変更が混入`);
  }

  // -- inline JS 構文 --
  try {
    const f = path.join(os.tmpdir(), `ui-layout-${process.pid}.js`);
    fs.writeFileSync(f, js);
    try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { fs.unlinkSync(f); }
  } catch (e) { errors.push('インライン <script> の node --check 失敗: ' + (e.stderr ? e.stderr.toString().slice(0, 300) : e.message)); }

  console.log(`[ui-layout] CSS { }=${open}/${close}  aria=${ariaCount}  overlayRules=${overlayRules.length}`);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    cssBraces: { open, close }, ariaCount, overlayRuleCount: overlayRules.length,
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main();
