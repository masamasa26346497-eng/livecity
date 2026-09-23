// tests/mission19-ui.test.js
// [見た目改善 Mission19] White / Light UI Refresh の HTML/CSS/JS 配線・回帰保護。
//   成功条件: 「開発中の Three.js デモ」ではなく「都市情報サービス」に見えること。
//   ただし 3D（geometry / camera / tile loader / render loop）と既存操作イベントは無改変。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const css = html.match(/<style>([\s\S]*?)<\/style>/i)[1];
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
const lcui = js.slice(js.indexOf('(function LC_UI(){'), js.indexOf("console.log('[LC_UI]"));

function runHarness(opts) {
  const h = require('./_ward-ux-v1-smoke-harness.cjs');
  return h.runInlineScript(undefined, opts);
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('[Mission19] インライン <script> の JS 構文が壊れていない', () => {
  const f = path.join(os.tmpdir(), `m19-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch {} }
});

test('[Mission19] CSS: 波括弧均衡 + :root に UI トークン', () => {
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length, 'CSS { } 不均衡');
  for (const v of ['--lc-bg', '--lc-panel', '--lc-border', '--lc-text', '--lc-muted', '--lc-accent', '--lc-radius', '--lc-shadow']) {
    assert.ok(new RegExp(v.replace(/-/g, '\\-') + '\\s*:').test(css), `${v} が無い`);
  }
  assert.ok(/:root\{[\s\S]*--lc-/.test(css), ':root に --lc- トークンが無い');
});

test('[Mission19] 白基調: body 背景が light、暗色 rgba(5,10,24…) を新規追加していない', () => {
  assert.ok(/body\{background:var\(--lc-bg\)/.test(css), 'body 背景が --lc-bg でない');
  // 新 UI ブロック（[Mission19] マーカー以降）に暗色パネル背景を持ち込んでいない
  const m19 = css.slice(css.indexOf('[Mission19] White / Light'));
  assert.ok(!/background:\s*rgba\(5,\s*10,\s*24/.test(m19) && !/background:\s*rgba\(8,\s*14,\s*26/.test(m19),
    'Mission19 CSS ブロックに暗色パネル背景が混入');
});

test('[Mission19] 開発者 HUD（#fps / #pr）は既定非表示・debug flag で表示', () => {
  assert.ok(/body:not\(\.lc-debug-ui\)[\s\S]{0,120}#fps[\s\S]{0,80}display\s*:\s*none\s*!important/.test(css)
    || /body:not\(\.lc-debug-ui\)\s*#fps,[\s\S]{0,60}#pr\{display:none !important\}/.test(css),
    '#fps/#pr の debug ゲート CSS が無い');
  assert.ok(/window\.__LIVE_CITY_DEBUG_UI__ === true/.test(js), '__LIVE_CITY_DEBUG_UI__ === true の判定が無い');
  assert.ok(/classList\.toggle\('lc-debug-ui'/.test(js), 'body.lc-debug-ui の付け外しが無い');
});

test('[Mission19] 黒矩形 QA: 旧レイヤーパネルを抑制・全画面不透明暗色オーバーレイなし', () => {
  assert.ok(/#pl,#layer-toggle-panel,#visual-panel,#controls\{display:none !important\}/.test(css.replace(/\s+/g, ''))
    || /#layer-toggle-panel[\s\S]{0,40}display:\s*none/.test(css), '旧 #layer-toggle-panel（黒矩形）を display:none にしていない');
  // 全画面ルールが不透明暗色でない
  for (const rule of (css.match(/\{[^}]*width\s*:\s*100%[^}]*height\s*:\s*100%[^}]*\}/g) || [])) {
    const bg = (rule.match(/background\s*:\s*rgba?\(([^)]+)\)/i) || [])[1];
    if (!bg) continue;
    const p = bg.split(',').map((s) => parseFloat(s));
    const a = p[3] == null ? 1 : p[3];
    assert.ok(!(a >= 0.85 && (p[0] + p[1] + p[2]) / 3 < 60), `全画面ルールが不透明暗色: rgba(${bg})`);
  }
  assert.ok(/blackOverlayDetected/.test(js) && /detectBlackOverlay/.test(js), '__UI_DEBUG__ の黒矩形検出が無い');
});

test('[Mission19] Top Bar / Right Panel / Map Controls の要素と折りたたみ', () => {
  for (const id of ['lc-topbar', 'lc-brand', 'lc-panel', 'lc-panel-head', 'lc-panel-body', 'lc-panel-collapse', 'lc-panel-tab', 'lc-mapctl']) {
    assert.ok(new RegExp("id:\\s*'" + id + "'").test(js) || new RegExp('#' + id + '\\b').test(css), `#${id} が無い`);
  }
  assert.ok(/body\.classList\.toggle\('lc-panel-collapsed'/.test(js), '右パネルの折りたたみトグルが無い');
  assert.ok(/body\.lc-panel-collapsed #lc-panel\{transform:translateX/.test(css), '折りたたみの CSS transform が無い');
  // Map Controls は既存カメラ関数を呼ぶだけ
  assert.ok(/cs\.r = Math\.max\(cs\.minR, Math\.min\(cs\.maxR, cs\.r \* factor\)\)/.test(js), 'zoom ボタンが cs.r をクランプしていない');
  assert.ok(/resetCamera\(\)/.test(lcui), 'reset ボタンが resetCamera を呼んでいない');
});

test('[Mission19] 既存操作の再利用: layer toggle / visual panel / ward selector をノード移設', () => {
  assert.ok(/D\.querySelectorAll\('#layer-toggle-panel label'\)/.test(js), 'layer toggle の <label> を移設していない');
  assert.ok(/D\.querySelectorAll\('#vp-body \.vp-row'\)/.test(js), 'visual panel の行を移設していない');
  assert.ok(/\$\('ward-current-area-label'\)/.test(js), 'ward selector ラベルを Top Bar へ移設していない');
  assert.ok(/\$\('pl-facility-section'\)/.test(js) && /\$\('pl-ward-section'\)/.test(js), '施設/行政区 details を移設していない');
  // 新規に機能ロジックを書き直していない（apply/onFacility* 等を再定義していない）
  assert.ok(!/function apply\(key, on\)|function onFacilityShowToggle|function onWardLabelsToggle/.test(lcui),
    'LC_UI が既存の機能ハンドラを再定義している');
});

test('[Mission19] 海（sea）を河川から独立したトグルに', () => {
  assert.ok(/key: 'sea', label: '海'/.test(js), 'sea トグルが items に無い');
  assert.ok(/if \(key === 'sea'\)[\s\S]{0,120}WaterSurfaceLayer/.test(js), 'sea トグルが WaterSurfaceLayer を操作していない');
  // waterways 分岐から WaterSurfaceLayer の呼び出しが外れている（河川トグルは海を触らない）
  const wwBranch = js.slice(js.indexOf("if (key === 'waterways')"), js.indexOf("if (key === 'sea')"));
  assert.ok(!/WaterSurfaceLayer\.(show|hide)|typeof WaterSurfaceLayer !== 'undefined'/.test(wwBranch),
    '河川トグルがまだ WaterSurfaceLayer を呼んでいる');
});

test('[Mission19] responsive foundation（<=768px）と横スクロール対策', () => {
  assert.ok(/@media\s*\(max-width:\s*768px\)/.test(css), '@media (max-width:768px) が無い');
  assert.ok(/html,body\{[^}]*overflow:hidden/.test(css), 'body overflow:hidden が無い（横スクロール防止）');
  assert.ok(!/width:\s*100vw/.test(css), 'width:100vw がある（横溢れの要因）');
  // mobile で右パネルが常時表示にならない（bottom sheet 化 or 折りたたみ）
  assert.ok(/@media[\s\S]{0,600}#lc-panel\{[^}]*bottom:0/.test(css), 'mobile で右パネルが bottom sheet 化していない');
  // touch target
  assert.ok(/min-width:44px|min-height:44px/.test(css), 'mobile の touch target >= 44px 指定が無い');
});

test('[Mission19] a11y: aria-label / role / focus-visible', () => {
  assert.ok((js.match(/setAttribute\('aria-label'/g) || []).length >= 4, 'aria-label が少ない');
  assert.ok(/setAttribute\('role', 'button'\)/.test(js), 'エリアボタンに role=button が無い');
  assert.ok(/:focus-visible\s*\{[\s\S]{0,40}outline/.test(css), 'focus-visible のアウトラインが無い');
  assert.ok(/ev\.key === 'Enter' \|\| ev\.key === ' '/.test(js), 'エリアボタンのキーボード操作が無い');
});

test('[Mission19] 3D 無改変: render loop / camera / tile loader / geometry を触っていない', () => {
  assert.ok(!/new THREE\.|BufferGeometry|computeVertexNormals|scene\.add|camera\.position/.test(lcui), 'LC_UI が 3D を触っている');
  // loop 本体の主要行が残っている
  // [Mission 31G-ALIGNMENT-RESET] Reference Alignment Mode(orthoCamera)対応で
  //   renderer.render(scene,camera) → renderer.render(scene,activeCamera()) へ変更されたため許容する。
  assert.ok(/renderer\.render\(scene,(camera|activeCamera\(\))\);\}\)\(\);/.test(js.replace(/\s+/g, '')), 'render loop の renderer.render が消えた');
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(js), 'projection が変わった');
});

test('[Mission19] City / Ward 切替と layer toggle の配線が無傷', () => {
  assert.ok(/cityRow\.addEventListener\('click', \(\) => \{ CityModeManager\.enter\(\); closePanel\(\); \}\)/.test(js), 'City Mode 行の click 配線が変わった');
  assert.ok(/WardModeManager\.switchWard\(def\.id\)/.test(js), 'Ward 切替の配線が変わった');
  assert.ok(/CityTileLayer\.setLayerEnabled\('roads', on\)/.test(js), 'layer toggle → CityTileLayer 配線が変わった');
  // [Mission 33A] 駅名ラベルは CityLabelLayer が描く（旧 StationLabelLayer は CityTileLayer の駅タイル依存で実機では出ていなかった）
  assert.ok(/CityLabelLayer\.setTypeVisible\('station', on\)/.test(js), '駅名トグル → ラベル層の配線が変わった');
});

test('[Mission19] protected HTML に変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/LC_UI|__UI_DEBUG__|--lc-bg|lc-topbar/.test(h), `${rel} に Mission19 の変更が混入`);
  }
});

test('[Mission19] runtime: 例外なく評価 / __UI_DEBUG__ が形を返す / __LIVE_CITY_SET_DEBUG_UI__', () => {
  const r = runHarness({ fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
  assert.ok(r.ok, r.error && r.error.stack);
  const w = r.window;
  assert.equal(typeof w.__UI_DEBUG__, 'function');
  const d = w.__UI_DEBUG__();
  for (const k of ['mode', 'rightPanelOpen', 'viewport', 'mobile', 'visiblePanels', 'debugHudVisible', 'overlayCount', 'blackOverlayDetected']) {
    assert.ok(k in d, `__UI_DEBUG__ に ${k} が無い`);
  }
  assert.equal(typeof w.__LIVE_CITY_SET_DEBUG_UI__, 'function');
});
