// tests/camera-north-up.test.js
// [北向き] カメラの既定方位(th)を北が画面上向きになる値(0)にする。
//   projection(geoToThree/znorth-neg-v1: 北=-Z)自体は変更していないことも併せて確認する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

test('[北向き] 初期カメラ方位 cs.th は 0（北が画面上向き）', () => {
  const idx = html.indexOf('const cs = {');
  assert.ok(idx >= 0, 'cs オブジェクトが見つからない');
  const block = html.slice(idx, idx + 700);
  assert.ok(/th: 0,/.test(block), 'cs.th の初期値が0になっていない');
  assert.ok(!/th: Math\.PI\*0\.25/.test(block), '旧45°方位が残っている');
});

test('[北向き] resetCamera() も th=0 へ戻す（home操作でも北向きを維持）', () => {
  assert.ok(/function resetCamera\(\)\{cs\.tgt\.set\(0,8,0\);cs\.th=0;/.test(html), 'resetCamera が th=0 にリセットしていない');
});

test('[北向き] znorth-neg-v1 projection（北=-Z）は変更していない', () => {
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\] 北を-Zへ/.test(html),
    'geoToThree の projection式が変更されている（変更禁止）');
});

test('protected baseline fullward-v3.html は本ラウンドの変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/\[北向き\]/.test(fw), 'fullward-v3.html に北向き調整が混入');
});
