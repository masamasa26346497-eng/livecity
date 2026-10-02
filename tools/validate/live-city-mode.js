#!/usr/bin/env node
// tools/validate/live-city-mode.js
// [見た目改善 Mission20] NORMAL / ANALYSIS モード分離の静的検証。
//
// - tools/lib/live-city-mode.js: default NORMAL / valid mode・theme only / theme 単一 /
//   NORMAL 復帰で analysisTheme=none / URL serialize-parse round-trip
// - dev HTML: LIVE_CITY_MODE IIFE / LiveCityModeManager / __LIVE_CITY_MODE_DEBUG__ /
//   既存ハンドラ再利用（applyDisplayMode / onFacilityShowToggle / onWard*Toggle）/
//   新しい色処理・THREE を IIFE 内で書いていない / clearAllAnalysisVisuals /
//   Mission19 UI・Mission10/11/11B・Mission14 debounce・Mission15 不在
// - production / protected 無変更
// - HTML の inline THEME_STATUS が lib と一致
//
// 実行: node tools/validate/live-city-mode.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import {
  DEFAULT_MODE, DEFAULT_THEME, ANALYSIS_THEMES, THEME_STATUS,
  createModeStore, parseState, serializeState, themeSelectable,
} from '../lib/live-city-mode.js';

const DEV = resolveProjectPath(path.join('public', 'osaka_3d_buildings.ward-ux-v1.html'));
const PROD = resolveProjectPath(path.join('public', 'osaka_3d_buildings.html'));
const PROT = resolveProjectPath(path.join('public', 'osaka_3d_buildings.fullward-v3.html'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'live-city-mode-validation.json'));

function main() {
  const errors = [], warns = [];

  // ── lib のロジック ──
  if (DEFAULT_MODE !== 'normal') errors.push('DEFAULT_MODE が normal でない');
  if (DEFAULT_THEME !== 'none') errors.push('DEFAULT_THEME が none でない');
  const impl = ANALYSIS_THEMES.filter((t) => themeSelectable(t)).sort();
  if (impl.join(',') !== 'admin_boundary,building_usage,facilities,none') errors.push(`implemented テーマが想定外: ${impl.join(',')}`);
  {
    const s = createModeStore();
    if (s.getMode() !== 'normal' || s.getTheme() !== 'none') errors.push('createModeStore の既定が NORMAL/none でない');
    s.setMode('analysis'); s.setTheme('building_usage'); s.setTheme('facilities');
    if (s.getTheme() !== 'facilities') errors.push('theme 切替が置換になっていない');
    s.setTheme('population');
    if (s.getTheme() !== 'facilities') errors.push('準備中テーマがブロックされていない');
    s.setMode('normal');
    if (s.getState().analysisTheme !== 'none') errors.push('NORMAL 復帰で analysisTheme が none にならない');
    s.setMode('analysis');
    if (s.getTheme() !== 'facilities') errors.push('直前テーマの復元がない');
  }
  // URL round-trip
  const rt = parseState(serializeState({ mode: 'analysis', theme: 'facilities' }));
  if (rt.mode !== 'analysis' || rt.theme !== 'facilities') errors.push('URL serialize/parse round-trip が壊れている');
  if (serializeState({ mode: 'normal', theme: 'none' }) !== '') errors.push('NORMAL は空 URL のはず');

  // ── dev HTML ──
  const html = fs.readFileSync(DEV, 'utf-8');
  const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
  const iife = js.slice(js.indexOf('(function LIVE_CITY_MODE(){'), js.indexOf("console.log('[LIVE_CITY_MODE]"));

  if (!/\(function LIVE_CITY_MODE\(\)\{/.test(js)) errors.push('LIVE_CITY_MODE IIFE が無い');
  if (!/window\.LiveCityModeManager = LiveCityModeManager/.test(js)) errors.push('window.LiveCityModeManager が無い');
  if (!/window\.__LIVE_CITY_MODE_DEBUG__ = function/.test(js)) errors.push('__LIVE_CITY_MODE_DEBUG__ が無い');
  if (!iife) { errors.push('LIVE_CITY_MODE IIFE 本文を特定できない'); }
  else {
    for (const [re, msg] of [
      [/let mode = 'normal', theme = 'none'/, '状態変数の単一宣言（既定 normal）'],
      [/function clearAllAnalysisVisuals\(\)/, 'clearAllAnalysisVisuals'],
      [/clearAllAnalysisVisuals\(\);\s*\n\s*const eff = THEME_EFFECT\[theme\]/, 'theme 切替で前テーマ解除 → 適用の順序'],
      [/onFacilityShowToggle/, '既存 onFacilityShowToggle 再利用'],
      [/onWardBoundariesToggle/, '既存 onWardBoundariesToggle 再利用'],
      [/onWardLabelsToggle/, '既存 onWardLabelsToggle 再利用'],
      [/applyDisplayMode\(want\)/, '既存 applyDisplayMode 再利用'],
      [/const want = on \? 'data' : 'real'/, '白模型（real）復元'],
      [/new URLSearchParams\(location\.search\)/, 'URL foundation'],
    ]) if (!re.test(iife)) errors.push(`IIFE: ${msg} が無い`);

    if (/new THREE\.|BufferGeometry|vertexColors|\.material\s*=|computeVertexNormals/.test(iife)) errors.push('IIFE が 3D / 色処理を実装している');
    if (/\[data-layer-key\][\s\S]{0,80}\.checked = /.test(iife)) errors.push('IIFE が base layer checkbox を書き換えている（§9 違反）');

    // inline THEME_STATUS が lib と一致
    const m = iife.match(/THEME_STATUS = (\{[\s\S]*?\});/);
    if (m) {
      try {
        const inlineStatus = Function('return ' + m[1])();
        for (const t of Object.keys(THEME_STATUS)) {
          if (inlineStatus[t] !== THEME_STATUS[t]) errors.push(`inline THEME_STATUS[${t}]=${inlineStatus[t]} != lib ${THEME_STATUS[t]}`);
        }
      } catch (e) { warns.push('inline THEME_STATUS の解析に失敗'); }
    } else warns.push('inline THEME_STATUS が見つからない');
  }

  // regression
  for (const [re, name] of [
    [/\(function LC_UI\(\)\{/, 'Mission19 LC_UI'],
    [/const BUILDING_HEIGHT_STYLE = \(function/, 'Mission10'],
    [/const LANDMARK_REGISTRY = \(function/, 'Mission11'],
    [/const LandmarkLayer = \(function/, 'Mission11B'],
    [/now - pendingSince > 1600 && now - lastRebuildAt > 3000/, 'Mission14 debounce'],
    [/\(function loop\(\)\{/, '3D loop'],
    [/CityModeManager\.enter\(\)/, 'CityModeManager'],
    [/WardModeManager\.switchWard/, 'WardModeManager'],
  ]) if (!re.test(js)) errors.push(`回帰: ${name} が消えた`);
  if (/const LabelEngine = \(function/.test(js)) errors.push('回帰: Mission15 LabelEngine が復活');

  // NORMAL で凡例が消える CSS
  if (!/body:not\(\.lc-mode-analysis\) #lc-legend\{display:none !important\}/.test(html)) errors.push('NORMAL で凡例を隠す CSS が無い');
  if (!/body\.lc-mode-analysis #lc-view-normal\{display:none\}/.test(html)) errors.push('ANALYSIS で NORMAL ビューを隠す CSS が無い');

  // protected / production
  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (!fs.existsSync(p)) continue;
    if (/LIVE_CITY_MODE|LiveCityModeManager|__LIVE_CITY_MODE_DEBUG__|lc-modeswitch/.test(fs.readFileSync(p, 'utf-8'))) {
      errors.push(`${label} HTML に Mission20 の変更が混入`);
    }
  }

  console.log(`[live-city-mode] implemented themes: ${impl.join(', ')}`);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    defaultMode: DEFAULT_MODE, implementedThemes: impl,
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
