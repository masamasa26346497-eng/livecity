// tests/river-ribbon-validator.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRiverRibbon } from '../tools/lib/river-ribbon.js';
import { validateRiverRibbon, validateRiverRibbons, validateCityBboxContainment, RIBBON_VALIDATION_LIMITS } from '../tools/lib/river-ribbon-validator.js';

function riverFrom(centerline, width, opts, extra = {}) {
  const r = buildRiverRibbon(centerline, width, opts);
  return { id: 'test', name: extra.name || 'テスト川', width, ...r, ...extra };
}

test('正常な河川（密なcenterline・妥当な幅）は ERROR/WARN 0', () => {
  const river = riverFrom([[0, 0], [500, 0], [1000, 50], [1500, 0]], 40, { maxSeg: 60 });
  const { errors, warns } = validateRiverRibbon(river);
  assert.deepEqual(errors, []);
  assert.deepEqual(warns, []);
});

test('width が不正（0/負/非有限）は ERROR', () => {
  for (const w of [0, -10, NaN]) {
    const river = riverFrom([[0, 0], [100, 0]], 40, {}, { width: w });
    const { errors } = validateRiverRibbon(river);
    assert.ok(errors.some((e) => e.includes('width')), `w=${w}: ${JSON.stringify(errors)}`);
  }
});

test('width が上限超過は ERROR', () => {
  const river = riverFrom([[0, 0], [100, 0]], 40, {}, { width: 9999 });
  const { errors } = validateRiverRibbon(river);
  assert.ok(errors.some((e) => e.includes('上限超過')));
});

test('巨大三角形（maxTriangleArea超過）は ERROR', () => {
  const river = riverFrom([[0, 0], [1000, 0]], 40, { maxSeg: 60 });
  river.maxTriangleArea = RIBBON_VALIDATION_LIMITS.maxTriangleAreaM2 * 5; // 意図的に壊す
  const { errors } = validateRiverRibbon(river);
  assert.ok(errors.some((e) => e.includes('巨大三角形')));
});

test('centerline最大辺長が長すぎる場合は WARN（ERRORにはしない＝目視確認対象）', () => {
  const river = riverFrom([[0, 0], [1000, 0]], 40, { maxSeg: 100000 }); // densifyさせない
  const { errors, warns } = validateRiverRibbon(river);
  assert.deepEqual(errors, []);
  assert.ok(warns.some((w) => w.includes('最大辺長')));
});

test('三角形の最長辺(maxTriangleEdge)が異常なら ERROR（数km級の横飛び）', () => {
  const river = riverFrom([[0, 0], [1000, 0]], 40, { maxSeg: 60 });
  river.maxTriangleEdge = RIBBON_VALIDATION_LIMITS.maxTriangleEdgeM + 1;
  const { errors } = validateRiverRibbon(river);
  assert.ok(errors.some((e) => e.includes('最長辺が異常')));
});

test('rawMaxSegment（densify前の生データジャンプ）が非現実的なら ERROR', () => {
  const river = riverFrom([[0, 0], [1000, 0]], 40, { maxSeg: 60 });
  river.rawMaxSegment = RIBBON_VALIDATION_LIMITS.rawJumpErrorM + 1;
  const { errors } = validateRiverRibbon(river);
  assert.ok(errors.some((e) => e.includes('巨大ジャンプ')));
});

test('rawMaxSegmentがWARN帯（source疎密）なら ERRORにはせずWARNのみ（実データ淀川の一部区間で発生する正常なケース）', () => {
  const river = riverFrom([[0, 0], [1000, 0]], 40, { maxSeg: 60 });
  river.rawMaxSegment = RIBBON_VALIDATION_LIMITS.rawJumpWarnM + 1;
  const { errors, warns } = validateRiverRibbon(river);
  assert.deepEqual(errors, []);
  assert.ok(warns.some((w) => w.includes('node間隔が疎')));
});

test('幅方向ベクトルが反転すると self crossing 疑いで ERROR', () => {
  const river = riverFrom([[0, 0], [1000, 0]], 40, { maxSeg: 60 });
  // 意図的にleft/rightの一部を入れ替えて幅方向を反転させる
  const mid = Math.floor(river.left.length / 2);
  [river.left[mid], river.right[mid]] = [river.right[mid], river.left[mid]];
  const { errors } = validateRiverRibbon(river);
  assert.ok(errors.some((e) => e.includes('self crossing')));
});

test('正常なcenterlineでは self crossing / 横飛びERRORが出ない', () => {
  const river = riverFrom([[0, 0], [500, 100], [1000, 0], [1500, -50]], 40, { maxSeg: 60, maxMiterRatio: 2.5 });
  const { errors } = validateRiverRibbon(river);
  assert.deepEqual(errors.filter((e) => e.includes('self crossing') || e.includes('横飛び')), []);
});

test('centerlineが2点未満は ERROR', () => {
  const { errors } = validateRiverRibbon({ id: 'x', centerline: [[0, 0]], left: [], right: [] });
  assert.ok(errors.some((e) => e.includes('2点未満')));
});

test('非有限座標を含む場合は ERROR', () => {
  const river = riverFrom([[0, 0], [100, 0]], 40, {});
  river.centerline = [[0, 0], [NaN, 0]];
  const { errors } = validateRiverRibbon(river);
  assert.ok(errors.some((e) => e.includes('非有限')));
});

test('validateCityBboxContainment: 市の外接矩形内なら violation 0、はみ出すと検出する', () => {
  const cityBbox = { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 };
  const inside = { id: 'a', name: '市内川', bbox: { minX: 100, maxX: 900, minZ: 100, maxZ: 900 } };
  const outside = { id: 'b', name: '市外へ飛び出す川', bbox: { minX: -5000, maxX: 900, minZ: 100, maxZ: 900 } };
  const okOnly = validateCityBboxContainment([inside], cityBbox, 500);
  assert.equal(okOnly.violationCount, 0);
  const withViolation = validateCityBboxContainment([inside, outside], cityBbox, 500);
  assert.equal(withViolation.violationCount, 1);
  assert.equal(withViolation.violations[0].name, '市外へ飛び出す川');
  assert.ok(withViolation.violations[0].overflowM > 4000);
});

test('validateRiverRibbons: 複数riverを集計する', () => {
  const good = riverFrom([[0, 0], [1000, 0]], 40, { maxSeg: 60 });
  const bad = riverFrom([[0, 0], [100, 0]], 40, {}, { width: -1 });
  const result = validateRiverRibbons([good, bad]);
  assert.equal(result.riverCount, 2);
  assert.ok(result.errorCount >= 1);
});
