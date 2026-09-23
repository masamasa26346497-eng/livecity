// tests/mission21-land-coverage.test.js
// [見た目改善 Mission21] 大阪市24区 陸域 coverage 完成の HTML 配線・配信データ・回帰保護。
//   絶対条件: legacy gnd.visible = false 維持 / 巨大 1 枚 ground mesh を敷かない /
//   RiverLayerV2 無改変 / WaterSurfaceLayer は陸を水扱いしない / protected・production 無変更。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { SEA_MASK } from '../tools/lib/water-surface.js';
import { auditLandCoverage, findLandGapClusters, auditKeyPlaces, validateLandSurface, DREAM_ISLAND } from '../tools/lib/land-coverage.js';

const require = createRequire(import.meta.url);
const HTML_PATH = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];
const lsIife = js.slice(js.indexOf('const LandSurfaceLayer = (function'), js.indexOf('LandSurfaceLayer.init();'));

const DATA = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'land-surface', 'land-surface.json');
const WATER = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'water-surface', 'water-surface.json');
const WARDS = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');

const wards = JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards || [];
const waterPositions = fs.existsSync(WATER) ? (JSON.parse(fs.readFileSync(WATER, 'utf-8')).positions || null) : null;

function run() {
  return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
}
async function flush(n = 12) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

// ── HTML: 構文・配線 ──
test('[Mission21] インライン <script> の JS 構文が壊れていない', () => {
  const f = path.join(os.tmpdir(), `m21-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission21] LandSurfaceLayer は独立 IIFE / land-surface.json を fetch / __LAND_COVERAGE_DEBUG__ を公開', () => {
  assert.ok(/const LandSurfaceLayer = \(function \(\) \{/.test(html), 'LandSurfaceLayer IIFE が無い');
  assert.ok(/land-surface\/land-surface\.json/.test(lsIife), 'land-surface.json を fetch していない');
  assert.ok(/window\.__LAND_COVERAGE_DEBUG__ = \(\) => LandSurfaceLayer\.getDebug\(\);/.test(html), '__LAND_COVERAGE_DEBUG__ の公開が無い');
  for (const fn of ['function build(', 'function load()', 'function init()', 'function show()', 'function hide()', 'function dispose()', 'function applyMode(', 'function landCoverageDebugSnapshot()']) {
    assert.ok(lsIife.includes(fn), `LandSurfaceLayer に ${fn} が無い`);
  }
  assert.ok(/getDebug: landCoverageDebugSnapshot/.test(lsIife), 'getDebug が公開されていない');
});

test('[Mission21] LandSurfaceLayer は RiverLayerV2 / WaterSurfaceLayer / GroundVisualLayer を改変しない', () => {
  // 他レイヤーの内部関数を呼んだり共有状態を書き換えたりしない（読み取り参照は getDebug 内のみ許容）
  assert.ok(!/RiverLayerV2\.\w+\(|WaterSurfaceLayer\.(show|hide|load|init|dispose)\(|GroundVisualLayer\.(show|hide|applyMode|dispose)\(/.test(lsIife),
    'LandSurfaceLayer が他レイヤーの状態を操作している');
  assert.ok(!/earcut|triangulateShape|assembleMultipolygon|coastline/i.test(lsIife), 'ブラウザ側で三角形分割している（生成側でやる約束）');
});

test('[Mission21] Y は GROUND(-0.02) の上・海面(0.03) の下 / renderOrder は面レイヤー最下位付近', () => {
  const y = parseFloat(lsIife.match(/const Y = (-?[0-9.]+);/)[1]);
  assert.ok(y > -0.02 && y < 0.03, `LandSurface Y=${y} が GROUND〜海面の間でない`);
  const ro = parseInt(lsIife.match(/mesh\.renderOrder = (\d+);/)[1], 10);
  assert.ok(ro <= 5, `renderOrder ${ro} が高すぎる（他の面レイヤーを覆う）`);
  assert.ok(/polygonOffset:\s*true/.test(lsIife), 'polygonOffset を使っていない（Z-fighting 対策なし）');
});

test('[Mission21] legacy ground を再表示していない（SHOW_LEGACY_GROUND:false / gnd.visible=true が無い）', () => {
  assert.ok(/SHOW_LEGACY_GROUND:\s*false/.test(html), 'SHOW_LEGACY_GROUND が false でない');
  assert.ok(!/\bgnd\.visible\s*=\s*true\b/.test(js), 'gnd.visible = true（legacy ground 再表示）');
  // LandSurfaceLayer 内で gnd を表示側へ触っていない
  assert.ok(!/gnd\.visible\s*=/.test(lsIife), 'LandSurfaceLayer が gnd.visible を書き換えている');
});

test('[Mission21] 巨大 1 枚 ground mesh を敷いていない（配信データはタイル分割・多数三角形）', () => {
  const doc = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  assert.ok(doc.tiles >= 50, `タイル数 ${doc.tiles} が少なすぎる（巨大 1 枚 mesh の疑い）`);
  assert.ok(doc.triangleCount >= 2000, `三角形 ${doc.triangleCount} が少なすぎる`);
  const v = validateLandSurface(doc.positions, { tileM: doc.tileM || 1000 });
  assert.equal(v.stats.giant, 0, 'giant triangle がある');
  assert.ok(v.stats.maxEdgeM <= (doc.tileM || 1000) * Math.SQRT2 + 1, `最大辺 ${Math.round(v.stats.maxEdgeM)}m がタイル対角を超える`);
});

test('[Mission21] applyMode は refreshEnvironmentMaterials から呼ばれる（模型↔データで陸色同期）', () => {
  assert.ok(/if \(typeof LandSurfaceLayer !== 'undefined' && LandSurfaceLayer\.applyMode\) LandSurfaceLayer\.applyMode\(isReal\);/.test(html),
    'refreshEnvironmentMaterials の applyMode hook が無い');
});

// ── 配信データ: coverage / geometry ──
test('[Mission21] 配信データ: znorth-neg-v1 / emitted / geometry 検証全通過', () => {
  const doc = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  assert.equal(doc.coordinateConvention, 'znorth-neg-v1');
  assert.equal(doc.emitted, true, (doc.validationErrors || []).join(' / '));
  assert.equal(doc.rejectedToEmpty, false);
  const v = validateLandSurface(doc.positions, { tileM: doc.tileM || 1000 });
  assert.equal(v.ok, true, v.errors.join(' / '));
  assert.equal(v.stats.nan, 0);
  assert.equal(v.stats.degenerate, 0);
  assert.equal(v.stats.downfacing, 0, '下向き三角形がある');
});

test('[Mission21] 24区 land coverage >= 99%（可能なら >= 99.5%）/ unexplained missing cluster = 0', () => {
  // テストでは 100m グリッド（50m の完全版は tools/audit/land-coverage.js のレポートで担保）
  const a = auditLandCoverage({ wards, cellM: 100, seaMask: SEA_MASK, waterPositions });
  assert.ok(a.coveragePercent >= 99, `coverage ${a.coveragePercent}% < 99%`);
  assert.equal(Object.keys(a.byWard).length >= 24, true, '24区分の byWard が無い');
  const clusters = findLandGapClusters({ wards, cellM: 100, seaMask: SEA_MASK });
  const unexplained = clusters.filter((c) => c.unexplained);
  assert.equal(unexplained.length, 0, 'unexplained: ' + unexplained.map((c) => c.id + JSON.stringify(c.center)).join(','));
});

test('[Mission21] LandSurface ∩ water-surface の不正な重なり = 0（陸を水扱いしていない）', () => {
  const a = auditLandCoverage({ wards, cellM: 100, seaMask: SEA_MASK, waterPositions });
  assert.equal(a.seaOverlapSamples, 0, `LandSurface と water-surface が ${a.seaOverlapSamples} サンプルで重なる`);
});

test('[Mission21] 人工島・港湾: 夢洲/舞洲/咲洲/南港/天保山 が covered', () => {
  const kp = auditKeyPlaces(wards, SEA_MASK, DREAM_ISLAND, waterPositions);
  for (const id of ['yumeshima', 'maishima', 'sakishima', 'nanko', 'tempozan']) {
    const k = kp.find((x) => x.id === id);
    assert.ok(k, `KEY_PLACES に ${id} が無い`);
    assert.equal(k.covered, true, `${k.name} が未 cover: ${k.cause}`);
  }
});

test('[Mission21] 夢洲コアは N03 欠落補完（konohana / N03 には無い）', () => {
  const doc = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  assert.ok(doc.dreamIsland && doc.dreamIsland.ward === 'konohana', '配信データに夢洲補完メタが無い');
  assert.ok(/N03 2026 未収録/.test(doc.dreamIsland.reason), '夢洲補完の理由が記録されていない');
  // N03 側に yumeshima-core は無い（補完は生成時のみ）
  assert.ok(!wards.some((w) => w.wardId === 'yumeshima-core'), 'N03 に夢洲コアが混入している');
});

// ── 回帰保護 ──
test('[Mission21] RiverLayerV2 / MAP_LAYER_Y / projection 不変', () => {
  assert.ok(/const RiverLayerV2 = /.test(html), 'RiverLayerV2 が消えた');
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html), 'projection 式が変わった');
  assert.ok(/GROUND:\s*-0\.02/.test(html) && /WATER:\s*0\.04/.test(html), 'MAP_LAYER_Y が変わった');
});

test('[Mission21] WaterSurfaceLayer 配信データ回帰（Mission06 の意味ゲート維持）', () => {
  const doc = JSON.parse(fs.readFileSync(WATER, 'utf-8'));
  assert.equal(doc.emitted, true);
  const km2 = doc.areaM2 / 1e6;
  assert.ok(km2 >= 20 && km2 <= 120, `海面面積 ${km2.toFixed(1)}km² が想定外`);
  assert.ok(doc.bbox.maxX <= 0, '海面が東へ延びた');
});

test('[Mission21] Mission19/20 UI 維持（LC_UI / LIVE_CITY_MODE / 白基調トークン）', () => {
  assert.ok(/--lc-bg:/.test(html) && /LC_UI/.test(html), 'Mission19 UI が消えた');
  assert.ok(/LiveCityModeManager/.test(html) && /lc-modeswitch/.test(html), 'Mission20 モード分離が消えた');
});

test('[Mission21] Mission15 LabelEngine を復活させていない', () => {
  assert.ok(!/new LabelEngine\(|LabelEngine\.mount\(/.test(js), 'LabelEngine が復活している');
});

test('[Mission21] protected HTML に Mission21 の変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/LandSurfaceLayer|__LAND_COVERAGE_DEBUG__|land-surface\.json/.test(h), `${rel} に Mission21 混入`);
  }
});

// ── runtime ──
test('[Mission21] runtime: 例外なく評価 / __LAND_COVERAGE_DEBUG__ が形を返す / gnd.visible=false', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  const w = r.window;
  assert.equal(typeof w.__LAND_COVERAGE_DEBUG__, 'function');
  await flush();
  const d = w.__LAND_COVERAGE_DEBUG__();
  for (const k of ['coveragePercent', 'landTriangles', 'landTiles', 'loadedTiles', 'seaOverlap', 'landAreaKm2', 'drawCalls', 'bbox', 'y', 'missingClusters', 'legacyGroundVisible']) {
    assert.ok(k in d, `__LAND_COVERAGE_DEBUG__ に ${k} が無い`);
  }
  assert.equal(d.legacyGroundVisible, false, 'legacy gnd が可視になっている');
  assert.equal(d.missingClusters, 0);
  assert.equal(d.seaOverlap, 0, 'runtime で seaOverlap != 0');
  assert.ok(d.landTriangles >= 2000, `landTriangles ${d.landTriangles} が少なすぎる（データ未ロード or 巨大 mesh）`);
  assert.equal(d.drawCalls, 1, 'LandSurface が 1 draw call でない');
});
