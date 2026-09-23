// tests/mission20-mode-separation.test.js
// [見た目改善 Mission20] NORMAL / ANALYSIS モード分離の HTML 配線・遷移 QA・回帰保護。
//   成功条件: 初見のユーザーが「街を見る」と「都市を分析する」を迷わず区別できること。
//   ただし 3D（geometry / tile loader / camera）と既存の色/レイヤーハンドラは無改変。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const require = createRequire(import.meta.url);
const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
const iife = js.slice(js.indexOf('(function LIVE_CITY_MODE(){'), js.indexOf("console.log('[LIVE_CITY_MODE]"));

function run() {
  return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
}

test('[Mission20] インライン <script> の構文 OK', () => {
  const f = path.join(os.tmpdir(), `m20-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch {} }
});

test('[Mission20] canonical state: LiveCityModeManager 1 つ・散在なし', () => {
  assert.ok(/\(function LIVE_CITY_MODE\(\)\{/.test(js), 'LIVE_CITY_MODE IIFE が無い');
  assert.ok(/window\.LiveCityModeManager = LiveCityModeManager/.test(js), 'window.LiveCityModeManager が無い');
  assert.ok(/window\.__LIVE_CITY_MODE_DEBUG__ = function/.test(js));
  // mode 状態変数は IIFE 内の 1 セットのみ
  assert.ok(/let mode = 'normal', theme = 'none'/.test(iife), 'mode/theme の単一宣言が無い');
});

test('[Mission20] 既定 NORMAL / URL foundation', () => {
  assert.ok(/let mode = 'normal'/.test(iife), '既定が normal でない');
  assert.ok(/new URLSearchParams\(location\.search\)/.test(iife), 'URL parse が無い');
  assert.ok(/p\.get\('mode'\) === 'analysis'/.test(iife), '?mode=analysis の読み取りが無い');
  assert.ok(/serialize:/.test(js), 'serialize（URL 化）が無い');
});

test('[Mission20] Top Bar モード切替: segmented control + aria-pressed + keyboard', () => {
  assert.ok(/id: 'lc-modeswitch'/.test(js), '#lc-modeswitch が無い');
  assert.ok(/textContent: '街を見る'/.test(js) && /textContent: '都市を分析'/.test(js), 'モードボタン文言が無い');
  assert.ok(/setAttribute\('aria-pressed', String\(mode === 'normal'\)\)/.test(js), 'aria-pressed が無い');
  assert.ok(/#lc-modeswitch button\[aria-pressed="true"\]\{background:var\(--lc-accent-soft\)/.test(html), 'active スタイルが淡い blue でない');
  assert.ok(/#lc-modeswitch button\{min-height:40px/.test(html) || /min-height:44px/.test(html), 'mobile の touch target 指定が無い');
});

test('[Mission20] Analysis Theme Manager: implemented 4 テーマ / 準備中は disabled', () => {
  assert.ok(/THEME_STATUS = \{ none: 'implemented', building_usage: 'implemented', facilities: 'implemented', admin_boundary: 'implemented'/.test(js));
  assert.ok(/population: 'card-only'[\s\S]{0,120}disaster: 'planned'/.test(js));
  // 準備中は disabled（クリックハンドラを付けない）
  assert.ok(/if \(selectable\) \{[\s\S]{0,120}row\.addEventListener\('click', go\)/.test(js), 'selectable のみ click ハンドラ');
  assert.ok(/lc-disabled/.test(js) && /'詳細のみ'/.test(js) && /'準備中'/.test(js), 'disabled バッジが無い');
});

test('[Mission20] テーマ効果は既存ハンドラのみ / 新しい色処理を作らない', () => {
  assert.ok(/onFacilityShowToggle/.test(iife) && /onWardBoundariesToggle/.test(iife) && /onWardLabelsToggle/.test(iife), '既存トグルハンドラを呼んでいない');
  assert.ok(/applyDisplayMode\(want\)/.test(iife), 'applyDisplayMode を再利用していない');
  // 新規 material / vertexColor / THREE を LIVE_CITY_MODE 内で触っていない
  assert.ok(!/new THREE\.|BufferGeometry|vertexColors|\.material\s*=/.test(iife), 'LIVE_CITY_MODE が 3D/色処理を実装している');
  // building usage color と facilities/boundary が同時に混ざらない（切替時に必ず clearAllAnalysisVisuals）
  assert.ok(/function clearAllAnalysisVisuals\(\)/.test(iife));
  assert.ok(/clearAllAnalysisVisuals\(\);\s*\n\s*const eff = THEME_EFFECT\[theme\]/.test(iife), 'theme 切替で前テーマを解除してから適用していない');
});

test('[Mission20] NORMAL 復帰で完全復元（§8）', () => {
  assert.ok(/if \(mode === 'normal'\) \{[\s\S]{0,120}clearAllAnalysisVisuals\(\)/.test(iife), 'NORMAL で clearAllAnalysisVisuals していない');
  assert.ok(/setUsageColor\(false\); setFacilities\(false\); setAdminBoundary\(false\)/.test(iife), '全 analysis overlay を解除していない');
  assert.ok(/const want = on \? 'data' : 'real'/.test(iife), '白模型（real）への復元が無い');
});

test('[Mission20] base レイヤー状態はモード非依存（§9）— LIVE_CITY_MODE が layer toggle を触らない', () => {
  // 建物/道路/河川/海/公園/鉄道/駅名 の checkbox（data-layer-key）を LIVE_CITY_MODE が変更していない
  assert.ok(!/\[data-layer-key\][\s\S]{0,80}\.checked = /.test(iife), 'LIVE_CITY_MODE が base layer checkbox を書き換えている');
  assert.ok(!/apply\('buildings'|apply\('roads'|apply\('parks'/.test(iife), 'LIVE_CITY_MODE が base layer を勝手に切り替えている');
});

test('[Mission20] Legend system: analysis のみ・現在テーマのみ（§11）', () => {
  assert.ok(/id: 'lc-legend'/.test(js) || /#lc-legend/.test(html));
  assert.ok(/body:not\(\.lc-mode-analysis\) #lc-legend\{display:none !important\}/.test(html), 'NORMAL で凡例が消える CSS が無い');
  assert.ok(/if \(mode !== 'analysis'\) \{[\s\S]{0,80}innerHTML = ''/.test(iife), 'NORMAL で凡例をクリアしていない');
  assert.ok(/THEME_LEGENDS\[theme\]/.test(iife), '現在テーマの凡例を出していない');
});

test('[Mission20] __LIVE_CITY_MODE_DEBUG__: 必須キー', () => {
  const d = js.slice(js.indexOf('window.__LIVE_CITY_MODE_DEBUG__ = function'), js.indexOf('window.__LIVE_CITY_MODE_DEBUG__ = function') + 1600);
  for (const k of ['mode', 'analysisTheme', 'normal', 'analysis', 'baseLayers', 'visibleAnalysisLayers',
    'modelStyle', 'legendVisible', 'rightPanelMode', 'drawCalls', 'triangles', 'materials', 'textures',
    'lastTransition', 'transitionCount']) {
    assert.ok(new RegExp('\\b' + k + '\\s*[:,}\\n]').test(d), `${k} が無い`);
  }
});

test('[Mission20] a11y: role=radiogroup / role=radio / aria-current / keyboard', () => {
  assert.ok(/setAttribute\('role', 'radiogroup'\)/.test(js));
  assert.ok(/setAttribute\('role', 'radio'\)/.test(js));
  assert.ok(/setAttribute\('aria-current', String\(t === theme\)\)/.test(js) || /aria-current/.test(js));
  assert.ok(/ev\.key === 'Enter' \|\| ev\.key === ' '/.test(iife), 'テーマのキーボード操作が無い');
});

test('[Mission20] Mission19 UI / Mission10・11・11B / Mission14 / Mission15 regression', () => {
  assert.ok(/\(function LC_UI\(\)\{/.test(js), 'Mission19 LC_UI が消えた');
  assert.ok(/window\.__UI_DEBUG__ = function/.test(js), 'Mission19 __UI_DEBUG__ が消えた');
  assert.ok(/const BUILDING_HEIGHT_STYLE = \(function/.test(js), 'Mission10 が消えた');
  assert.ok(/const LANDMARK_REGISTRY = \(function/.test(js) && /const LandmarkLayer = \(function/.test(js), 'Mission11/11B が消えた');
  assert.ok(/now - pendingSince > 1600 && now - lastRebuildAt > 3000/.test(js), 'Mission14 debounce が変わった');
  assert.ok(!/const LabelEngine = \(function/.test(js), 'Mission15 LabelEngine が復活');
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(js), 'projection が変わった');
  // [Mission 31G-ALIGNMENT-RESET] Reference Alignment Mode(orthoCamera)対応で
  //   renderer.render(scene,camera) → renderer.render(scene,activeCamera()) へ変更されたため許容する。
  assert.ok(/renderer\.render\(scene,(camera|activeCamera\(\))\);\}\)\(\);/.test(js.replace(/\s+/g, '')), 'render loop が変わった');
});

test('[Mission20] City / Ward manager の配線が無傷', () => {
  assert.ok(/CityModeManager\.enter\(\); closePanel\(\);/.test(js));
  assert.ok(/WardModeManager\.switchWard\(def\.id\)/.test(js));
});

test('[Mission20] protected 無変更（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    assert.ok(!/LIVE_CITY_MODE|LiveCityModeManager|__LIVE_CITY_MODE_DEBUG__|lc-modeswitch/.test(fs.readFileSync(p, 'utf-8')), `${rel} に Mission20 混入`);
  }
});

test('[Mission20] 遷移 QA（§16）: NORMAL→用途→人口(不可)→NORMAL→施設→NORMAL で stale なし', () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  const w = r.window;
  const M = w.LiveCityModeManager;
  const dbg = () => w.__LIVE_CITY_MODE_DEBUG__();

  // 起動直後 = NORMAL / theme none / modelStyle real
  let d = dbg();
  assert.equal(d.mode, 'normal');
  assert.equal(d.analysisTheme, 'none');
  assert.equal(d.visibleAnalysisLayers.length, 0);
  assert.equal(d.legendVisible, false);
  assert.equal(d.modelStyle, 'real');

  // NORMAL → ANALYSIS building_usage
  M.setMode('analysis'); M.setTheme('building_usage');
  d = dbg();
  assert.equal(d.mode, 'analysis');
  assert.equal(d.analysisTheme, 'building_usage');
  assert.deepEqual([...d.visibleAnalysisLayers], ['building_usage'], 'テーマは単一');
  assert.equal(d.rightPanelMode, 'analysis');

  // building_usage → population（card-only：ブロックされ building_usage のまま）
  M.setTheme('population');
  d = dbg();
  assert.equal(d.analysisTheme, 'building_usage', '準備中テーマは選べない');

  // → NORMAL（完全復元）
  M.setMode('normal');
  d = dbg();
  assert.equal(d.mode, 'normal');
  assert.equal(d.analysisTheme, 'none', 'stale theme なし');
  assert.equal(d.visibleAnalysisLayers.length, 0, 'stale analysis layer なし');
  assert.equal(d.legendVisible, false, 'stale legend なし');
  assert.equal(d.modelStyle, 'real', 'MODEL_STYLE 白模型へ復元');

  // → ANALYSIS（直前テーマ building_usage を復元）→ facilities へ
  M.setMode('analysis');
  assert.equal(dbg().analysisTheme, 'building_usage', '直前テーマ復元');
  M.setTheme('facilities');
  d = dbg();
  assert.deepEqual([...d.visibleAnalysisLayers], ['facilities']);
  assert.equal(d.modelStyle, 'real', 'facilities では用途色に戻っていない（混ざらない）');

  // → NORMAL 最終
  M.setMode('normal');
  d = dbg();
  assert.equal(d.analysisTheme, 'none');
  assert.equal(d.visibleAnalysisLayers.length, 0);
  assert.ok(d.transitionCount >= 6);

  // panel 重複なし（#lc-view-normal / #lc-view-analysis は各 1 つ）
  const dom = w.document;
  // stub の querySelectorAll は [] を返すため、ここは HTML 側の構造チェックで担保（下の別 test）
  assert.equal(typeof w.__UI_DEBUG__, 'function', 'Mission19 __UI_DEBUG__ 健在');
});

test('[Mission20] パネル再編: #lc-view-normal / #lc-view-analysis を各 1 つだけ生成', () => {
  assert.equal((iife.match(/id: 'lc-view-normal'/g) || []).length, 1);
  assert.equal((iife.match(/id: 'lc-view-analysis'/g) || []).length, 1);
  // 旧「都市情報」セクションは撤去
  assert.ok(/secInfo\.parentNode\.removeChild\(secInfo\)/.test(iife), '旧 都市情報セクションを撤去していない');
  // 施設/行政区 details は analysis のテーマ別サブパネルへ移設
  assert.ok(/\$\('pl-facility-section'\)[\s\S]{0,40}fp\.appendChild/.test(iife));
  assert.ok(/\$\('pl-ward-section'\)[\s\S]{0,40}ap\.appendChild/.test(iife));
});
