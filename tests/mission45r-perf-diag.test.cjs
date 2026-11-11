'use strict';
// Mission 45R: 静的検査のみ（実 Windows Chrome・GPU 計測は未実施）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../public/mission37g-osaka-24ward-mvp.html'), 'utf8');

test('45R: camera view save/restore is in-memory only (no URL/storage/network)', () => {
  const i = html.indexOf("mkBtn('視点を保存'");
  const j = html.indexOf("mkBtn('視点を復元'");
  assert.ok(i > 0 && j > i);
  const seg = html.slice(i, html.indexOf('const fb = ', j));
  assert.doesNotMatch(seg, /localStorage|sessionStorage|fetch\(|sendBeacon|XMLHttpRequest|history\.|location\./);
});
test('45R: 10s run records frame breakdown, selected tiles, draw commands, HUD cost and A/B switches', () => {
  for (const k of ['updMs', 'rndMs', 'dtMs', 'selectedTiles', 'drawCommands', 'hud:', 'vcdefer', 'hudmove', 'sseMove', 'jsShareHint']) assert.ok(html.includes(k), k);
  assert.match(html, /scene\.postUpdate\.addEventListener/);
  assert.match(html, /scene\.preRender\.addEventListener/);
});
test('45R: HUD skips updates during gestures by default; ?hudmove=1 restores old behaviour', () => {
  assert.match(html, /HUD_MOVE = q\.get\('hudmove'\) === '1'/);
  assert.match(html, /if \(!HUD_MOVE && IX\.isActive\(performance\.now\(\)\)\)/);
});
test('45R: sseMove is opt-in (default off) and restores the original SSE', () => {
  assert.match(html, /SSE_MOVE = Math\.max\(0, \+q\.get\('sseMove'\) \|\| 0\)/);
  assert.match(html, /if \(EXT45 && SSE_MOVE > 0\)/);
  assert.match(html, /orig\.get\(t\)/);
});
test('45R: no external send / Google references in the diagnostic block', () => {
  const k = html.indexOf('45R: HUD 自身');
  assert.ok(k > 0);
  assert.doesNotMatch(html.slice(k, k + 6000), /googleapis|sendBeacon|XMLHttpRequest/);
});
test('45R: page scripts still parse', () => {
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(m[1]));
});
