// tests/building-height-style.test.js
// [見た目改善 Mission10] tools/lib/building-height-style.js の純粋ロジック。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEIGHT_THRESHOLDS, HEIGHT_CLASSES, SHADE_FLOOR, SHADE_CEIL,
  classifyBuildingHeight, getHeightStyle, clampShade, summarizeHeights,
} from '../tools/lib/building-height-style.js';

test('classifyBuildingHeight: しきい値と境界値（しきい値ちょうどは上の階級）', () => {
  assert.equal(classifyBuildingHeight(0), 'low');
  assert.equal(classifyBuildingHeight(14.99), 'low');
  assert.equal(classifyBuildingHeight(15), 'mid');
  assert.equal(classifyBuildingHeight(39.99), 'mid');
  assert.equal(classifyBuildingHeight(40), 'high');
  assert.equal(classifyBuildingHeight(99.99), 'high');
  assert.equal(classifyBuildingHeight(100), 'skyscraper');
  assert.equal(classifyBuildingHeight(149.99), 'skyscraper');
  assert.equal(classifyBuildingHeight(150), 'very_tall');
  assert.equal(classifyBuildingHeight(300), 'very_tall');
});

test('classifyBuildingHeight: NaN / 欠損 / 非正 / 非数値 → low フォールバック', () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, 0, undefined, null, 'x', {}, []]) {
    assert.equal(classifyBuildingHeight(bad), 'low', `${String(bad)} が low にならない`);
  }
});

test('classifyBuildingHeight: 外れ値（29997m）も very_tall に飽和する', () => {
  assert.equal(classifyBuildingHeight(29997), 'very_tall');
  assert.equal(classifyBuildingHeight(1e9), 'very_tall');
});

test('HEIGHT_THRESHOLDS / HEIGHT_CLASSES: 想定値', () => {
  assert.deepEqual(HEIGHT_THRESHOLDS, { MID: 15, HIGH: 40, SKYSCRAPER: 100, VERY_TALL: 150 });
  assert.deepEqual(HEIGHT_CLASSES, ['low', 'mid', 'high', 'skyscraper', 'very_tall']);
});

test('getHeightStyle: low / mid は係数すべて 1.0（現状表現を厳密維持）', () => {
  for (const mode of ['detail', 'cityLOD']) {
    for (const h of [1, 7, 14.9, 15, 25, 39.9]) {
      const s = getHeightStyle(h, mode);
      assert.equal(s.bottomMul, 1, `${h}m ${mode} bottomMul`);
      assert.equal(s.topMul, 1, `${h}m ${mode} topMul`);
      assert.equal(s.roofMul, 1, `${h}m ${mode} roofMul`);
    }
  }
});

test('getHeightStyle: high 以上は「下端を暗く・上端/屋根を明るく」（垂直コントラスト方向）', () => {
  for (const h of [45, 120, 250]) {
    const s = getHeightStyle(h, 'detail');
    assert.ok(s.bottomMul < 1, `${h}m: bottomMul < 1`);
    assert.ok(s.topMul > 1, `${h}m: topMul > 1`);
    assert.ok(s.roofMul >= 1, `${h}m: roofMul >= 1`);
  }
});

test('getHeightStyle: 効果は「僅か」（過剰でない）', () => {
  const s = getHeightStyle(300, 'detail'); // 最も強い very_tall
  assert.ok(s.bottomMul >= 0.90, `bottomMul ${s.bottomMul} が下がりすぎ`);
  assert.ok(s.topMul <= 1.06, `topMul ${s.topMul} が上がりすぎ`);
  assert.ok(s.roofMul <= 1.07, `roofMul ${s.roofMul} が上がりすぎ`);
});

test('getHeightStyle: cityLOD は detail より弱い（遠景で騒がしくしない）', () => {
  const d = getHeightStyle(200, 'detail');
  const c = getHeightStyle(200, 'cityLOD');
  assert.ok(Math.abs(c.bottomMul - 1) < Math.abs(d.bottomMul - 1));
  assert.ok(Math.abs(c.topMul - 1) < Math.abs(d.topMul - 1));
  assert.equal(c.edgeMul, 1, 'cityLOD は edge なし → edgeMul 1');
});

test('getHeightStyle: class を返し、edgeMul は skyscraper/very_tall で >1（Mission08 尊重・未配線でも値は持つ）', () => {
  assert.equal(getHeightStyle(120, 'detail').class, 'skyscraper');
  assert.ok(getHeightStyle(120, 'detail').edgeMul > 1);
  assert.ok(getHeightStyle(180, 'detail').edgeMul >= getHeightStyle(120, 'detail').edgeMul);
  assert.equal(getHeightStyle(10, 'detail').edgeMul, 1);
});

test('clampShade: SHADE_FLOOR / SHADE_CEIL でクランプ、非有限は 1.0', () => {
  assert.equal(clampShade(0.1), SHADE_FLOOR);
  assert.equal(clampShade(5), SHADE_CEIL);
  assert.equal(clampShade(NaN), 1.0);
  assert.equal(clampShade(0.85), 0.85);
  assert.ok(SHADE_FLOOR >= 0.6 && SHADE_FLOOR < 0.8);
  assert.ok(SHADE_CEIL > 1.0 && SHADE_CEIL <= 1.15);
});

test('getHeightStyle × clampShade: 実際に壁へ掛かる値が [FLOOR, CEIL] に収まる', () => {
  for (const h of [5, 50, 120, 200, 29997]) {
    for (const mode of ['detail', 'cityLOD']) {
      const s = getHeightStyle(h, mode);
      for (const base of [0.76, 0.80, 1.0, 1.03]) {
        const v = clampShade(base * s.bottomMul);
        assert.ok(v >= SHADE_FLOOR - 1e-9 && v <= SHADE_CEIL + 1e-9);
      }
    }
  }
});

test('summarizeHeights: パーセンタイル・階級ヒストグラム・>=Nm カウント', () => {
  const heights = [];
  for (let i = 0; i < 900; i++) heights.push(5 + (i % 10));       // 5–14m
  for (let i = 0; i < 80; i++) heights.push(20 + i);              // 20–99m
  for (let i = 0; i < 15; i++) heights.push(105 + i * 5);         // 105–175m
  heights.push(NaN, -3, 0, 29997);                                // 無効 + 外れ値
  const s = summarizeHeights(heights);
  assert.equal(s.total, heights.length);
  assert.equal(s.valid, 900 + 80 + 15 + 1); // 29997 は valid
  assert.ok(s.median >= 5 && s.median <= 15);
  assert.equal(s.byClass.low + s.byClass.mid + s.byClass.high + s.byClass.skyscraper + s.byClass.very_tall, s.valid);
  assert.ok(s.ge100 >= 15);
  assert.ok(s.max >= 29997);
});
