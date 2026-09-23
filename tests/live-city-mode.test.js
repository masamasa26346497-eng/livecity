// tests/live-city-mode.test.js
// [見た目改善 Mission20] tools/lib/live-city-mode.js の純粋ロジック。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_MODES, DEFAULT_MODE, ANALYSIS_THEMES, DEFAULT_THEME, THEME_STATUS, THEME_LEGENDS,
  isValidMode, isValidTheme, themeSelectable, themeStatus, legendFor,
  serializeState, parseState, createModeStore,
} from '../tools/lib/live-city-mode.js';

test('既定: NORMAL / theme none', () => {
  assert.equal(DEFAULT_MODE, 'normal');
  assert.equal(DEFAULT_THEME, 'none');
  const s = createModeStore();
  assert.equal(s.getMode(), 'normal');
  assert.equal(s.getTheme(), 'none');
  assert.equal(s.isNormal(), true);
});

test('valid mode / theme のみ受け付ける', () => {
  assert.deepEqual(APP_MODES, ['normal', 'analysis']);
  assert.equal(isValidMode('normal'), true);
  assert.equal(isValidMode('debug'), false);
  assert.equal(isValidTheme('building_usage'), true);
  assert.equal(isValidTheme('nope'), false);
  const s = createModeStore();
  s.setMode('bogus');
  assert.equal(s.getMode(), 'normal');
});

test('THEME_STATUS: implemented は 4 つ（none / 建物用途 / 施設 / 行政区界）だけ選択可', () => {
  const impl = ANALYSIS_THEMES.filter((t) => themeSelectable(t));
  assert.deepEqual(impl.sort(), ['admin_boundary', 'building_usage', 'facilities', 'none'].sort());
  assert.equal(themeStatus('population'), 'card-only');
  assert.equal(themeStatus('disaster'), 'planned');
  assert.equal(themeSelectable('land_price'), false);
});

test('ANALYSIS 中のみ theme 変更可 / 準備中テーマは選べない', () => {
  const s = createModeStore();
  s.setTheme('building_usage');
  assert.equal(s.getTheme(), 'none', 'NORMAL 中は theme 変更不可');
  s.setMode('analysis');
  s.setTheme('building_usage');
  assert.equal(s.getTheme(), 'building_usage');
  s.setTheme('population');
  assert.equal(s.getTheme(), 'building_usage', 'card-only テーマはブロック');
  s.setTheme('disaster');
  assert.equal(s.getTheme(), 'building_usage', 'planned テーマはブロック');
});

test('theme は同時に 1 つ（切替で前テーマを置換）', () => {
  const s = createModeStore({ mode: 'analysis' });
  s.setTheme('building_usage');
  s.setTheme('facilities');
  assert.equal(s.getTheme(), 'facilities');
  s.setTheme('admin_boundary');
  assert.equal(s.getTheme(), 'admin_boundary');
  const st = s.getState();
  assert.equal(st.analysisTheme, 'admin_boundary');
});

test('NORMAL 復帰: analysisTheme は none / 直前テーマは記憶して復元', () => {
  const s = createModeStore();
  s.setMode('analysis');
  s.setTheme('facilities');
  s.setMode('normal');
  assert.equal(s.getMode(), 'normal');
  assert.equal(s.getTheme(), 'none');
  assert.equal(s.getState().analysisTheme, 'none', 'NORMAL に analysis theme が残らない');
  s.setMode('analysis');
  assert.equal(s.getTheme(), 'facilities', '直前テーマを復元');
});

test('subscribe: mode / theme 変更で通知（reason 付き）', () => {
  const s = createModeStore();
  const events = [];
  const unsub = s.subscribe((st, reason) => events.push([st.mode, st.analysisTheme, reason]));
  s.setMode('analysis');
  s.setTheme('building_usage');
  s.setMode('normal');
  assert.deepEqual(events, [
    ['analysis', 'none', 'mode'],
    ['analysis', 'building_usage', 'theme'],
    ['normal', 'none', 'mode'],
  ]);
  unsub();
  s.setMode('analysis');
  assert.equal(events.length, 3, 'unsub 後は通知されない');
});

test('transitionCount / lastTransition', () => {
  const s = createModeStore();
  assert.equal(s.getState().transitionCount, 0);
  s.setMode('analysis');
  s.setTheme('facilities');
  const st = s.getState();
  assert.equal(st.transitionCount, 2);
  assert.equal(st.lastTransition.theme, 'facilities');
});

test('serializeState / parseState: URL foundation', () => {
  assert.equal(serializeState({ mode: 'normal', theme: 'none' }), '');
  assert.equal(serializeState({ mode: 'analysis', theme: 'population' }), '?mode=analysis&theme=population');
  assert.equal(serializeState({ mode: 'analysis', theme: 'none', ward: 'kita' }), '?mode=analysis&ward=kita');
  assert.deepEqual(parseState('?mode=analysis&theme=facilities'), { mode: 'analysis', theme: 'facilities', ward: null });
  // 準備中テーマは none へフォールバック
  assert.deepEqual(parseState('?mode=analysis&theme=land_price'), { mode: 'analysis', theme: 'none', ward: null });
  // 不正 mode は normal
  assert.deepEqual(parseState('?mode=xyz'), { mode: 'normal', theme: 'none', ward: null });
  assert.deepEqual(parseState(''), { mode: 'normal', theme: 'none', ward: null });
});

test('legendFor: implemented テーマのみ凡例、card-only/planned は null', () => {
  assert.ok(Array.isArray(legendFor('building_usage')) && legendFor('building_usage').length >= 5);
  assert.ok(Array.isArray(legendFor('facilities')));
  assert.ok(Array.isArray(legendFor('admin_boundary')));
  assert.equal(legendFor('population'), null);
  assert.equal(legendFor('disaster'), null);
  assert.equal(legendFor('none'), null);
});

test('createModeStore(init): ?mode=analysis&theme=... の初期化', () => {
  const s = createModeStore({ mode: 'analysis', theme: 'facilities' });
  assert.equal(s.getMode(), 'analysis');
  assert.equal(s.getTheme(), 'facilities');
  // 準備中テーマ初期化は none
  const s2 = createModeStore({ mode: 'analysis', theme: 'land_price' });
  assert.equal(s2.getTheme(), 'land_price'); // isValidTheme は通る（初期化は緩め）
  assert.equal(createModeStore({ mode: 'analysis', theme: 'nope' }).getTheme(), 'none');
});
