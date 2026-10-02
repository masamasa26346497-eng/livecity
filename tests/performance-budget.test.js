// tests/performance-budget.test.js
// [Mission25] tools/lib/performance-budget.js の純粋ロジック。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERF_METRICS, LOWER_IS_BETTER, validatePerfBaselineSchema, comparePerfBaselines,
  extractRenderLoopBody, auditRenderLoopHotPath, auditStaticMeshUsage, DEFAULT_BUDGET,
} from '../tools/lib/performance-budget.js';

test('[Mission25] PERF_METRICS / LOWER_IS_BETTER', () => {
  assert.deepEqual([...PERF_METRICS], ['drawCalls', 'triangles', 'geometries', 'textures', 'programs', 'fps', 'frameMs']);
  assert.ok(LOWER_IS_BETTER.has('drawCalls') && LOWER_IS_BETTER.has('frameMs'));
  assert.ok(!LOWER_IS_BETTER.has('fps'));
});

test('[Mission25] validatePerfBaselineSchema: 必須キー / 型', () => {
  assert.equal(validatePerfBaselineSchema({ mode: 'city', drawCalls: 100, triangles: 1e6, geometries: 50, textures: 4, fps: 55, frameMs: 18 }).ok, true);
  const r = validatePerfBaselineSchema({ mode: 'x', drawCalls: 'a', triangles: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('geometries'));
  assert.ok(r.badType.includes('mode'));
  assert.ok(r.badType.includes('drawCalls'));
  assert.equal(validatePerfBaselineSchema(null).ok, false);
  // null は許容（未計測）
  assert.equal(validatePerfBaselineSchema({ mode: 'ward', drawCalls: null, triangles: null, geometries: null, textures: null, fps: null, frameMs: null }).ok, true);
});

test('[Mission25] comparePerfBaselines: 悪化なし=PASS / コスト増=FAIL / 削減=improvement', () => {
  const before = { drawCalls: 1000, triangles: 5e6, geometries: 400, textures: 10, programs: 20, fps: 50, frameMs: 20 };
  // 同等（ノイズ内）
  let c = comparePerfBaselines(before, { ...before }, DEFAULT_BUDGET);
  assert.equal(c.overall, 'PASS');
  assert.equal(c.regressions.length, 0);
  // drawCalls 15% 増 → REGRESS
  c = comparePerfBaselines(before, { ...before, drawCalls: 1150 }, DEFAULT_BUDGET);
  assert.equal(c.overall, 'FAIL');
  assert.ok(c.regressions[0].startsWith('drawCalls'));
  // drawCalls 20% 減 + fps 15% 増 → PASS + improvements
  c = comparePerfBaselines(before, { ...before, drawCalls: 800, fps: 57.5 }, DEFAULT_BUDGET);
  assert.equal(c.overall, 'PASS');
  assert.ok(c.improvements.some((s) => s.startsWith('drawCalls')));
  assert.ok(c.improvements.some((s) => s.startsWith('fps')));
  // fps 10% 低下 → REGRESS
  c = comparePerfBaselines(before, { ...before, fps: 44 }, DEFAULT_BUDGET);
  assert.equal(c.overall, 'FAIL');
});

test('[Mission25] comparePerfBaselines: 数値でない項目は SKIP', () => {
  const c = comparePerfBaselines({ drawCalls: 100 }, { drawCalls: null }, DEFAULT_BUDGET);
  assert.equal(c.rows.find((r) => r.metric === 'drawCalls').verdict, 'SKIP');
  assert.equal(c.overall, 'PASS');
});

test('[Mission25] extractRenderLoopBody / auditRenderLoopHotPath: 正常なループ', () => {
  const html = `x
(function loop(){requestAnimationFrame(loop);fc++;const now=performance.now();
  __perfFrameTick__();
  updateWindowMaterials();
  try { StationLabelLayer.update(); } catch (e) { console.warn('x', e); }
  if(now-lt>=1000){ const fps = 1; document.getElementById('fps').innerHTML = fps; }
  renderer.render(scene,camera);})();
`;
  const body = extractRenderLoopBody(html);
  assert.ok(body && body.includes('updateWindowMaterials'));
  const a = auditRenderLoopHotPath(html);
  assert.equal(a.ok, true, 'catch 内 console と 1秒throttleブロックは hot path でない: ' + a.hits.join(','));
});

test('[Mission25] auditRenderLoopHotPath: hot path の console.log / geometry生成 を検出', () => {
  const html = `(function loop(){requestAnimationFrame(loop);
  console.log('every frame');
  const g = new THREE.BufferGeometry();
  renderer.render(scene,camera);})();`;
  const a = auditRenderLoopHotPath(html);
  assert.equal(a.ok, false);
  assert.ok(a.hits.includes('console 出力'));
  assert.ok(a.hits.includes('geometry/mesh 生成'));
});

test('[Mission25] auditStaticMeshUsage: 実 HTML でレイヤー適用を検出', () => {
  // 合成 HTML（実ファイルの marker と同形）
  const html = `
function markStaticMesh(obj) { obj.updateMatrix(); obj.matrixAutoUpdate = false; return obj; }
markStaticMesh(majorMesh);
markStaticMesh(mesh); // [Mission25] 原点アンカーの統合mesh
      markStaticMesh(mesh);
      if (mesh.userData && (mesh.userData.water || mesh.userData.roadTier)) {}
markStaticMesh(mesh); // [Mission25] 原点アンカーの統合地表mesh
markStaticMesh(mesh); // [Mission25] 原点アンカーの統合公園mesh
markStaticMesh(mesh); // [Mission25] 原点アンカーの統合海面mesh
markStaticMesh(wM);
`;
  const r = auditStaticMeshUsage(html);
  assert.equal(r.defined, true);
  assert.ok(r.callCount >= 7);
  for (const L of ['RiverLayerV2', 'CityBuildingLOD', 'CityTileLayer', 'LandSurfaceLayer', 'ParkLayer', 'WaterSurfaceLayer', 'BuildingTileLayer']) {
    assert.ok(r.layers.includes(L), L + ' 未検出');
  }
});
