// tests/landmark-model-provider.test.js
// [見た目改善 Mission11B] tools/lib/landmark-model-provider.js の純粋ロジック。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROCEDURAL_SHAPES, MODEL_KINDS,
  generateTower, generateDome, generateTwinTowerRing,
  shapeParams, getModelSpec, buildGeometry, summarizeModels,
} from '../tools/lib/landmark-model-provider.js';
import { LANDMARK_SEED, modelPlanFor } from '../tools/lib/landmark-registry.js';

function bboxOf(positions) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ, w: maxX - minX, d: maxZ - minZ, h: maxY - minY };
}
function assertMeshValid(g, name) {
  assert.equal(g.positions.length % 3, 0, `${name}: positions`);
  assert.equal(g.indices.length % 3, 0, `${name}: indices`);
  assert.equal(g.indices.length / 3, g.triangleCount, `${name}: triangleCount`);
  assert.ok(g.positions.every(Number.isFinite), `${name}: 非有限座標`);
  const nv = g.positions.length / 3;
  for (const id of g.indices) assert.ok(Number.isInteger(id) && id >= 0 && id < nv, `${name}: index 範囲`);
}

test('generateTower: 底が y=0、頂部が height、footprint 内に収まる、tri 少', () => {
  const g = generateTower({ baseW: 31, baseD: 32, height: 108 });
  assertMeshValid(g, 'tower');
  const bb = bboxOf(g.positions);
  assert.ok(Math.abs(bb.minY) < 0.01);
  assert.ok(Math.abs(bb.maxY - 108) < 0.01, `頂部 ${bb.maxY}`);
  assert.ok(bb.w <= 31 + 0.01 && bb.d <= 32 + 0.01, `footprint 超過 ${bb.w}x${bb.d}`);
  assert.ok(g.triangleCount < 200);
});

test('generateDome: 半楕円ドーム、apex = height、直径 ≈ footprint', () => {
  const g = generateDome({ radius: 104, apex: 83, ringHeight: 31 });
  assertMeshValid(g, 'dome');
  const bb = bboxOf(g.positions);
  assert.ok(Math.abs(bb.minY) < 0.01);
  assert.ok(Math.abs(bb.maxY - 83) < 0.5, `apex ${bb.maxY}`);
  assert.ok(bb.w <= 209 + 1 && bb.w >= 200, `直径 ${bb.w}`);
  assert.ok(g.triangleCount < 600);
});

test('generateTwinTowerRing: 2 スラブ + リング、height 尊重、footprint 内', () => {
  const g = generateTwinTowerRing({ totalW: 112, depth: 62, height: 173, gap: 18 });
  assertMeshValid(g, 'twin');
  const bb = bboxOf(g.positions);
  assert.ok(Math.abs(bb.minY) < 0.01);
  assert.ok(Math.abs(bb.maxY - 173) < 0.01, `頂部 ${bb.maxY}`);
  assert.ok(bb.w <= 112 + 0.01, `幅超過 ${bb.w}`);
  assert.ok(bb.d <= 62 + 0.01, `奥行超過 ${bb.d}`);
  assert.ok(g.triangleCount < 300);
});

test('generateTower: 決定的（同じ入力で同じ出力）', () => {
  const a = generateTower({ baseW: 31, baseD: 32, height: 108 });
  const b = generateTower({ baseW: 31, baseD: 32, height: 108 });
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.indices, b.indices);
});

test('shapeParams: footprint / height 不足なら null', () => {
  assert.equal(shapeParams('tower', null, 100), null);
  assert.equal(shapeParams('tower', { w: 30, h: 30 }, 0), null);
  assert.equal(shapeParams('tower', { w: 30, h: 30 }, NaN), null);
  assert.equal(shapeParams('bogus', { w: 30, h: 30 }, 100), null);
  assert.ok(shapeParams('dome', { w: 200, h: 200 }, 83));
});

test('getModelSpec: PROCEDURAL + shape あり → available、estimate に triangles', () => {
  const e = { modelType: 'PROCEDURAL', proceduralShape: 'tower', footprintBbox: { w: 31, h: 32 }, osmHeight: 108 };
  const s = getModelSpec(e);
  assert.equal(s.available, true);
  assert.equal(s.kind, 'procedural');
  assert.ok(s.estimate.triangles > 0 && s.estimate.triangles < 200);
  assert.equal(s.estimate.textures, 0);
});

test('getModelSpec: LOD1 / LOD2 / shape なし → unavailable（安全に skip）', () => {
  assert.equal(getModelSpec({ modelType: 'LOD1' }).available, false);
  assert.equal(getModelSpec({ modelType: 'LOD2' }).available, false);
  assert.equal(getModelSpec({ modelType: 'PROCEDURAL', proceduralShape: null }).available, false);
  assert.match(getModelSpec({ modelType: 'PROCEDURAL', proceduralShape: null }).reason, /生成器なし/);
});

test('getModelSpec: GLTF は modelUrl が必要', () => {
  assert.equal(getModelSpec({ modelType: 'GLTF', modelUrl: null }).available, false);
  const s = getModelSpec({ modelType: 'GLTF', modelUrl: 'models/x.glb' });
  assert.equal(s.available, true);
  assert.equal(s.kind, 'gltf');
});

test('buildGeometry: spec から geometry、非 procedural は null', () => {
  const s = getModelSpec({ modelType: 'PROCEDURAL', proceduralShape: 'dome', footprintBbox: { w: 200, h: 200 }, osmHeight: 83 });
  const g = buildGeometry(s);
  assertMeshValid(g, 'dome-from-spec');
  assert.equal(buildGeometry({ available: false }), null);
  assert.equal(buildGeometry(getModelSpec({ modelType: 'LOD1' })), null);
});

test('LANDMARK_MODEL_PLAN: PoC 3 件が procedural + shape、あべのハルカスは LOD1、大阪城は LOD2', () => {
  assert.equal(modelPlanFor('tsutenkaku').proceduralShape, 'tower');
  assert.equal(modelPlanFor('kyocera-dome-osaka').proceduralShape, 'dome');
  assert.equal(modelPlanFor('umeda-sky-building').proceduralShape, 'twin-tower-ring');
  assert.equal(modelPlanFor('abeno-harukas').modelType, 'LOD1');
  assert.equal(modelPlanFor('osaka-castle').modelType, 'LOD2');
  assert.equal(modelPlanFor('kaiyukan').proceduralShape, null); // 生成器なし → 表示しない
});

test('summarizeModels: seed 全件で available=3 / totalTriangles < 1000', () => {
  const entries = LANDMARK_SEED.map((s) => {
    const p = modelPlanFor(s.id);
    return { id: s.id, modelType: p.modelType, proceduralShape: p.proceduralShape, modelUrl: p.modelUrl,
      footprintBbox: s.footprintBbox, osmHeight: s.height };
  });
  const sm = summarizeModels(entries);
  assert.equal(sm.available, 3);
  assert.equal(sm.proceduralAvailable, 3);
  assert.ok(sm.totalTriangles > 0 && sm.totalTriangles < 1000, `tri ${sm.totalTriangles}`);
});

test('PROCEDURAL_SHAPES / MODEL_KINDS: 定数', () => {
  assert.deepEqual(PROCEDURAL_SHAPES, ['tower', 'dome', 'twin-tower-ring']);
  assert.deepEqual(MODEL_KINDS, ['procedural', 'gltf', 'lod']);
});

test('real-world scale: seed の PoC 3 件で model 高さが osmHeight とほぼ一致（拡大なし）', () => {
  for (const id of ['tsutenkaku', 'kyocera-dome-osaka', 'umeda-sky-building']) {
    const s = LANDMARK_SEED.find((x) => x.id === id);
    const spec = getModelSpec({ ...modelPlanFor(id), footprintBbox: s.footprintBbox, osmHeight: s.height });
    const g = buildGeometry(spec);
    const bb = bboxOf(g.positions);
    const ratio = bb.h / s.height;
    assert.ok(ratio > 0.9 && ratio < 1.1, `${id}: 高さ比 ${ratio.toFixed(3)}（拡大の疑い）`);
  }
});
