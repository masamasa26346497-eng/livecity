// tests/mission27-major-building-lod.test.js
// [Mission27 中景用・主要建物LODの新設]
//   CityBuildingLOD の minor/major 2 バケット化 / band 排他（3重表示防止）/ landmark 二重表示防止 /
//   Mission25 最適化維持 / 既存 debug API 回帰 / audit・validator / runtime。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { bucketVisibility, isMajorBuilding } from '../tools/lib/major-building-lod.js';

const require = createRequire(import.meta.url);
const HTML_PATH = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
const cbl = html.slice(html.indexOf('const CityBuildingLOD = (function'), html.indexOf('const CityModeManager = (function'));

const AUDIT = path.join(PROJECT_ROOT, 'data', 'reports', 'major-building-lod.json');
const VAL = path.join(PROJECT_ROOT, 'data', 'reports', 'major-building-lod-validation.json');

function run() {
  return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
}
async function flush(n = 24) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

test('[Mission27] インライン <script> の JS 構文が壊れていない', () => {
  const f = path.join(os.tmpdir(), `m27-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission27] CityBuildingLOD が minor/major の 2 バケットへ分割されている', () => {
  assert.ok(/const MID_MAX_M = 9000;/.test(cbl));
  assert.ok(/const MAJOR_MIN_HEIGHT_M = 30;/.test(cbl));
  assert.ok(/const MAJOR_MIN_FP_AREA_M2 = 3000;/.test(cbl));
  assert.ok(/function isMajorBuilding\(b\) \{/.test(cbl), 'isMajorBuilding が無い');
  assert.ok(/function buildWardMeshes\(wardId, buildingsArr\) \{/.test(cbl), 'buildWardMeshes が無い');
  assert.ok(/\(isMajorBuilding\(b\) \? major : minor\)\.push\(b\);/.test(cbl), 'minor/major 振り分けが無い');
  assert.ok(/minorMesh: buildOneMesh\(wardId, minor, 'minor'\)/.test(cbl));
  assert.ok(/majorMesh: buildOneMesh\(wardId, major, 'major'\)/.test(cbl));
});

test('[Mission27] band 排他: FAR=minor+major / MID=major only / NEAR=両方非表示（3重表示防止）', () => {
  assert.ok(/const far = r > MID_MAX_M;/.test(cbl));
  assert.ok(/const mid = r > HIDE_NEAR_M && r <= MID_MAX_M;/.test(cbl));
  assert.ok(/minor: visible && far, major: visible && \(far \|\| mid\)/.test(cbl), 'minor は FAR のみ / major は FAR+MID');
  assert.ok(/const HIDE_NEAR_M = 4000;/.test(cbl), 'HIDE_NEAR_M=4000 が変わった');
  // 純ロジックと一致
  assert.deepEqual(bucketVisibility(12000), { band: 'far', minor: true, major: true });
  assert.deepEqual(bucketVisibility(6000), { band: 'mid', minor: false, major: true });
  assert.deepEqual(bucketVisibility(2000), { band: 'near', minor: false, major: false });
});

test('[Mission27] §8 landmark 二重表示防止: appendBuilding の suppress ガード維持', () => {
  assert.ok(/if \(typeof LandmarkLayer !== 'undefined' && LandmarkLayer\.isSuppressedBuilding\(b\.id\)\) return;/.test(cbl),
    'appendBuilding の LandmarkLayer.isSuppressedBuilding ガードが消えた');
});

test('[Mission27] §3/§4/§10 Mission25 最適化維持: material 共有 / static matrix / raycast 無効', () => {
  assert.ok(/const mesh = new THREE\.Mesh\(geom, getMaterial\(\)\); \/\/ \[Mission27\] minor\/major で material 共有/.test(cbl));
  assert.ok(/mesh\.raycast = \(\) => \{\}; \/\/ \[Mission27 §3\]/.test(cbl), 'raycast 無効化が無い');
  assert.ok(/markStaticMesh\(mesh\); \/\/ \[Mission25\]/.test(cbl), 'markStaticMesh が無い');
  // applyBand は render loop から呼ばれない
  assert.ok(!/requestAnimationFrame[\s\S]{0,200}applyBand\(\)/.test(html), 'applyBand が per-frame で呼ばれている');
  // applyBand の呼び出し元は setCameraDistance / setVisible / loadWard
  const callers = (cbl.match(/applyBand\(\)/g) || []).length;
  assert.ok(callers >= 3 && callers <= 8, `applyBand 呼び出し ${callers} 回`);
});

test('[Mission27] __MAJOR_BUILDING_LOD_DEBUG__ が公開され必要キーを持つ', () => {
  assert.ok(/window\.__MAJOR_BUILDING_LOD_DEBUG__ =/.test(html));
  const fn = cbl.slice(cbl.indexOf('function getMajorLodDebug'));
  for (const k of ['band', 'thresholdHeight', 'thresholdArea', 'selectedBuildings', 'visibleBuildings',
    'majorBuildings', 'minorBuildings', 'meshes', 'triangles', 'majorTriangles', 'minorTriangles']) {
    assert.ok(fn.includes(k), `getMajorLodDebug に ${k} が無い`);
  }
});

test('[Mission27] 既存 CityBuildingLOD API / getStats 互換キー / 遠景・近景レイヤー維持', () => {
  // [fallback建物] return に getFallbackDebug が追加された。コア API は不変であることを個別に確認する。
  assert.ok(/return \{ build, setCameraDistance, setVisible, getStats, getMajorLodDebug,[^}]*HIDE_NEAR_M, MID_MAX_M \};/.test(cbl));
  for (const k of ['wardsStarted', 'wardsReady', 'osmFallbackStatus', 'osmFallbackTriangles']) {
    assert.ok(cbl.includes(k), `getStats 互換キー ${k} が消えた`);
  }
  assert.ok(html.includes('CityBuildingLOD.build()'), 'CityModeManager が CityBuildingLOD.build を呼ばない');
  assert.ok(html.includes('const BuildingTileLayer = (function'), 'BuildingTileLayer（近景）が消えた');
  for (const kw of ['__PERFORMANCE_DEBUG__', '__BUILDING_COVERAGE_DEBUG__', '__MAP_COMPLETENESS_DEBUG__', '__RAIL_LOD_DEBUG__']) {
    assert.ok(html.includes(kw), `${kw} が消えた`);
  }
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html), 'projection 式が変わった');
});

test('[Mission27] audit / validator レポート', { skip: !fs.existsSync(AUDIT) && 'no audit' }, () => {
  const a = JSON.parse(fs.readFileSync(AUDIT, 'utf-8'));
  assert.equal(a.RESULT, 'PASS');
  assert.ok(a.selectedFraction > 0.005 && a.selectedFraction < 0.10, `選定率 ${a.selectedPercent}%`);
  assert.ok(a.selectedMajor > 5000);
  assert.equal(a.thresholds.midMaxM, 9000);
  assert.equal(a.thresholds.hideNearM, 4000);
  if (fs.existsSync(VAL)) assert.equal(JSON.parse(fs.readFileSync(VAL, 'utf-8')).RESULT, 'PASS');
});

test('[Mission27] protected HTML に Mission27 変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/isMajorBuilding|buildWardMeshes|__MAJOR_BUILDING_LOD_DEBUG__|MID_MAX_M/.test(h), `${rel} に Mission27 混入`);
  }
});

test('[Mission27] runtime: 例外なく評価 / __MAJOR_BUILDING_LOD_DEBUG__ が形を返す', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  await flush();
  const d = r.window.__MAJOR_BUILDING_LOD_DEBUG__();
  assert.ok(d && typeof d === 'object');
  assert.ok(['far', 'mid', 'near'].includes(d.band));
  assert.equal(d.thresholdHeight, 30);
  assert.equal(d.thresholdArea, 3000);
  // 既存 debug API も生きている
  assert.ok(typeof r.window.__PERFORMANCE_DEBUG__ === 'function');
  const pd = r.window.__PERFORMANCE_DEBUG__();
  assert.ok(pd.layers && pd.layers.buildings, 'PERFORMANCE_DEBUG の buildings が壊れた');
});
