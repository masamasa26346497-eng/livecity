// tests/ward-classification-validator.test.js
// P1-3: Ward polygon データセット検証（tools/lib/ward-classification-validator.js）のテスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { validateWardClassification } from '../tools/lib/ward-classification-validator.js';

const REGISTRY = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'config', 'wards', 'registry.json'), 'utf-8').replace(/^﻿/, ''));
const ring = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];

// 24区を横一列に並べた合成 Ward polygon データ（各区 幅1000 x 高さ1000、x = index*1000）。
// 既存3区(sumiyoshi/higashisumiyoshi/hirano)は znorth-neg-v1 らしく z<0 側へ置く。
function synthetic24(overrides = {}) {
  const wards = REGISTRY.wards.map((w, i) => {
    const x0 = i * 1000;
    const z0 = -800, z1 = -200; // 参照(znorth-neg-v1)と符号を合わせる
    return {
      wardId: w.id, wardCode: w.code, wardName: w.name,
      polygonCount: 1, exclaveCount: 0, holeCount: 0,
      bbox: { minX: x0, maxX: x0 + 800, minZ: z0, maxZ: z1 },
      polygons: [{ outer: ring(x0, z0, x0 + 800, z1), holes: [] }],
      ...(overrides[w.id] || {}),
    };
  });
  return { coordinateConvention: 'znorth-neg-v1', wards };
}

test('validator: 合成24区は error なしで PASS する', () => {
  const r = validateWardClassification(synthetic24(), REGISTRY);
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.pass), null, 2));
});

test('validator: 1区欠けると all-24-wards-present が FAIL', () => {
  const p = synthetic24();
  p.wards = p.wards.filter((w) => w.wardId !== 'nishinari');
  const r = validateWardClassification(p, REGISTRY);
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === 'all-24-wards-present').pass, false);
});

test('validator: wardId 重複で no-duplicate-wardId が FAIL', () => {
  const p = synthetic24();
  p.wards.push({ ...p.wards[0] });
  const r = validateWardClassification(p, REGISTRY);
  assert.equal(r.checks.find((c) => c.name === 'no-duplicate-wardId').pass, false);
});

test('validator: registry 外 wardId で no-registry-external-ward が FAIL', () => {
  const p = synthetic24();
  p.wards[0] = { ...p.wards[0], wardId: 'atlantis' };
  const r = validateWardClassification(p, REGISTRY);
  assert.equal(r.checks.find((c) => c.name === 'no-registry-external-ward').pass, false);
});

test('validator: 非有限座標で coords-finite が FAIL', () => {
  const p = synthetic24();
  p.wards[3].polygons[0].outer[1][0] = NaN;
  const r = validateWardClassification(p, REGISTRY);
  assert.equal(r.checks.find((c) => c.name === 'coords-finite').pass, false);
});

test('validator: 未閉合リングで rings-valid が FAIL', () => {
  const p = synthetic24();
  p.wards[2].polygons[0].outer = [[0, 0], [10, 0], [10, 10]]; // 閉じていない・3点
  const r = validateWardClassification(p, REGISTRY);
  assert.equal(r.checks.find((c) => c.name === 'rings-valid').pass, false);
});

test('validator: 2区が重なると wards-self-consistent が FAIL（相互排他が壊れている）', () => {
  const p = synthetic24();
  // hirano を sumiyoshi と完全に重ねる
  const s = p.wards.find((w) => w.wardId === 'sumiyoshi');
  const h = p.wards.find((w) => w.wardId === 'hirano');
  h.polygons = JSON.parse(JSON.stringify(s.polygons));
  h.bbox = { ...s.bbox };
  const r = validateWardClassification(p, REGISTRY);
  assert.equal(r.checks.find((c) => c.name === 'wards-self-consistent').pass, false);
});

test('validator: 市外プローブが区に入ると outside-city-unclassified が FAIL', () => {
  const p = synthetic24();
  // 巨大な区を1つ作って市外プローブ(200000,0)を飲み込ませる
  p.wards[0].polygons = [{ outer: ring(-500000, -500000, 500000, 500000), holes: [] }];
  p.wards[0].bbox = { minX: -500000, maxX: 500000, minZ: -500000, maxZ: 500000 };
  const r = validateWardClassification(p, REGISTRY);
  assert.equal(r.checks.find((c) => c.name === 'outside-city-unclassified').pass, false);
});

test('validator: extraProbes で境界付近/飛び地/hole の判定を検証できる', () => {
  const p = synthetic24({
    // sumiyoshi に hole を空ける
    sumiyoshi: (() => {
      const i = REGISTRY.wards.findIndex((w) => w.id === 'sumiyoshi');
      const x0 = i * 1000;
      return {
        holeCount: 1,
        polygons: [{ outer: ring(x0, -800, x0 + 800, -200), holes: [ring(x0 + 300, -600, x0 + 500, -400)] }],
      };
    })(),
  });
  const i = REGISTRY.wards.findIndex((w) => w.id === 'sumiyoshi');
  const x0 = i * 1000;
  const r = validateWardClassification(p, REGISTRY, {
    extraProbes: [
      { x: x0 + 400, z: -500, expect: null, label: 'sumiyoshi-hole内' },
      { x: x0 + 100, z: -500, expect: 'sumiyoshi', label: 'sumiyoshi-hole外' },
    ],
  });
  assert.equal(r.checks.find((c) => c.name === 'probe:sumiyoshi-hole内').pass, true);
  assert.equal(r.checks.find((c) => c.name === 'probe:sumiyoshi-hole外').pass, true);
});
