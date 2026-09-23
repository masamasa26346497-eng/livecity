// tests/mission24-map-completeness.test.js
// [Mission24 大阪市24区 基礎地図総合完成度監査]
//   audit レポート構造 / byLayer・byWard score / verdict / 主要公園・鉄道チェック /
//   rail 路線名 + railClass 配線 / HTML __MAP_COMPLETENESS_DEBUG__ 配線 / 既存レイヤー回帰 /
//   protected・production 無変更 / runtime debug API。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const require = createRequire(import.meta.url);
const HTML_PATH = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];

const AUDIT = path.join(PROJECT_ROOT, 'data', 'reports', 'map-completeness-audit.json');
const VALID = path.join(PROJECT_ROOT, 'data', 'reports', 'map-completeness-validation.json');
const RAIL_DIR = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'railways');
const a = fs.existsSync(AUDIT) ? JSON.parse(fs.readFileSync(AUDIT, 'utf-8')) : null;
const v = fs.existsSync(VALID) ? JSON.parse(fs.readFileSync(VALID, 'utf-8')) : null;

function run() {
  return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
}
async function flush(n = 16) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

// ── HTML 構文 ──
test('[Mission24] インライン <script> の JS 構文が壊れていない', () => {
  const f = path.join(os.tmpdir(), `m24-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

// ── §14 debug API 配線 ──
test('[Mission24] window.__MAP_COMPLETENESS_DEBUG__ が公開されている', () => {
  assert.ok(/window\.__MAP_COMPLETENESS_DEBUG__ = function \(\)/.test(html), '__MAP_COMPLETENESS_DEBUG__ が無い');
  const fn = js.slice(js.indexOf('window.__MAP_COMPLETENESS_DEBUG__'));
  for (const k of ['reportPath', 'runtime', 'performanceBaseline', 'runtimeMissing', 'visibleAnomalies',
    'wardsReady', 'buildingTiles', 'osmFallbackBuildings', 'roadTiles', 'river', 'land', 'sea', 'parks', 'rail',
    'drawCalls', 'triangles']) {
    assert.ok(fn.includes(k), `__MAP_COMPLETENESS_DEBUG__ に ${k} が無い`);
  }
});

// ── §9 rail: 本線断片救済（railClass 優先）──
test('[Mission24] buildRailMeshes / getRailLodDebug は f.railClass を優先する', () => {
  assert.ok(/buckets\[f\.railClass \|\| classifyRail\(f\.railway, railLineLength\(f\.p\)\)\]\.push\(f\);/.test(html),
    'buildRailMeshes が railClass を優先していない（本線断片が FAR で消える）');
  assert.ok(/counts\[f\.railClass \|\| classifyRail\(f\.railway, railLineLength\(f\.p\)\)\]\+\+;/.test(html),
    'getRailLodDebug の集計が railClass を優先していない');
});

test('[Mission24] rail タイルに路線名 + railClass が付与されている', { skip: !fs.existsSync(RAIL_DIR) && 'no rail tiles' }, () => {
  const byId = new Map();
  for (const f of fs.readdirSync(RAIL_DIR)) {
    if (!/\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(RAIL_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) if ((ft.kind === 'line' || ft.railway) && !byId.has(ft.id)) byId.set(ft.id, ft);
  }
  const feats = [...byId.values()];
  const named = feats.filter((f) => f.name);
  const classed = feats.filter((f) => f.railClass);
  assert.ok(named.length > 1500, `rail 路線名が保持されていない (${named.length})`);
  assert.ok(classed.length > 1500, `railClass が付与されていない (${classed.length})`);
  assert.ok(feats.some((f) => !f.name), '全 rail に name が付いている（渡り線・側線は名無しのはず）');
  // 代表路線が名前で存在
  const names = new Set(named.map((f) => f.name));
  assert.ok([...names].some((n) => /環状線/.test(n)), 'JR大阪環状線 が名前で見当たらない');
  assert.ok([...names].some((n) => /御堂筋線/.test(n)), 'Osaka Metro御堂筋線 が名前で見当たらない');
});

// ── §13 audit レポート構造 ──
test('[Mission24] map-completeness-audit.json: 必須キー / counts / verdict', { skip: !a && 'no audit' }, () => {
  for (const k of ['generatedAt', 'method', 'baseline', 'overallScore', 'criticalCount', 'highCount',
    'mediumCount', 'lowCount', 'infoCount', 'byLayer', 'byWard', 'representativeAreas',
    'parkCheck', 'railClassification', 'anomalies', 'knownLimitations', 'RESULT', 'verdict']) {
    assert.ok(k in a, `audit report に ${k} が無い`);
  }
  assert.equal(a.criticalCount, 0, 'CRITICAL anomaly が残っている');
  assert.equal(a.highCount, 0, 'HIGH anomaly が残っている');
  assert.equal(a.RESULT, 'PASS');
  assert.equal(a.verdict, '大阪市基礎地図 β1 完成候補');
  assert.ok(a.overallScore >= 95, `overallScore ${a.overallScore}`);
});

test('[Mission24] byLayer: 7 レイヤーすべて score があり CRITICAL/HIGH 0', { skip: !a && 'no audit' }, () => {
  for (const L of ['land', 'buildings', 'roads', 'rivers', 'sea', 'parks', 'railways']) {
    assert.ok(a.byLayer[L], `byLayer.${L} が無い`);
    assert.ok(typeof a.byLayer[L].score === 'number', `byLayer.${L}.score が数値でない`);
  }
  assert.ok(a.byLayer.roads.eligibleLocalCoverage >= 99, 'road eligible local coverage < 99%');
  assert.equal(a.byLayer.roads.tileBoundaryBreaks, 0, 'road tile boundary break がある');
  assert.equal(a.byLayer.buildings.unexplainedVisualGap, 0);
  assert.equal(a.byLayer.buildings.sparseMismatchResidual, 0);
  assert.equal(a.byLayer.buildings.duplicateFallback, 0);
  assert.equal(a.byLayer.rivers.unexplainedGapRivers, 0);
  assert.equal(a.byLayer.sea.illegalLandOverlap, 0);
});

test('[Mission24] byWard: 24 区分 / FAIL ステータスが無い（EXPLAINED は可）', { skip: !a && 'no audit' }, () => {
  assert.equal(Object.keys(a.byWard).length, 24, 'byWard が 24 区でない');
  for (const [w, W] of Object.entries(a.byWard)) {
    for (const k of ['landStatus', 'buildingStatus', 'roadStatus', 'waterStatus', 'parkStatus', 'railStatus']) {
      assert.notEqual(W[k], 'FAIL', `${w}.${k} が FAIL`);
    }
    assert.equal(W.anomalies.critical, 0, `${w} に CRITICAL anomaly`);
    assert.equal(W.anomalies.high, 0, `${w} に HIGH anomaly`);
  }
});

test('[Mission24] 全 anomaly が MEDIUM 以上なら reason 付き / severity は既定値', { skip: !a && 'no audit' }, () => {
  for (const an of a.anomalies) {
    assert.ok(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(an.severity), `不正な severity ${an.severity}`);
    if (['MEDIUM', 'HIGH', 'CRITICAL'].includes(an.severity)) {
      assert.ok(an.note || an.detail, `${an.type} (${an.severity}) に reason が無い`);
    }
  }
});

// ── §8 主要公園 / §9 主要鉄道 ──
test('[Mission24] parkCheck: 主要公園がすべて rendered', { skip: !a && 'no audit' }, () => {
  assert.ok(a.parkCheck.length >= 9, '主要公園チェックが少なすぎる');
  for (const p of a.parkCheck) assert.ok(p.rendered, `主要公園 ${p.name} が rendered でない`);
  const names = a.parkCheck.map((p) => p.name);
  for (const n of ['大阪城公園', '長居公園', '靱公園', '天王寺公園']) {
    assert.ok(names.includes(n), `parkCheck に ${n} が無い`);
  }
});

test('[Mission24] railClassification.lineCheck: 主要路線がすべて found（愛称→正式名解決込み）', { skip: !a && 'no audit' }, () => {
  const lc = a.railClassification.lineCheck;
  assert.ok(lc.length >= 20, '主要路線チェックが少なすぎる');
  for (const l of lc) assert.ok(l.found, `主要路線 ${l.name} が found でない`);
  assert.ok(a.railClassification.named > 1500, `named rail ${a.railClassification.named}`);
  // 断片救済で local は大きく減っている
  assert.ok(a.railClassification.byClass.local < a.railClassification.byClass.major,
    'local rail が major より多い（本線断片救済が効いていない）');
});

// ── §16 validator ──
test('[Mission24] map-completeness-validation.json: RESULT PASS / errorCount 0', { skip: !v && 'no validation' }, () => {
  assert.equal(v.RESULT, 'PASS');
  assert.equal(v.errorCount, 0, 'validator errors: ' + JSON.stringify(v.errors));
  assert.equal(v.counts.critical, 0);
  assert.equal(v.counts.high, 0);
  for (const L of Object.values(v.byLayer)) assert.ok(L >= 95, 'byLayer score < 95');
});

// ── 既存レイヤー回帰（§17）──
test('[Mission24] 既存レイヤー / データストアが消えていない', () => {
  for (const kw of ['const LandSurfaceLayer = (function', 'const RiverLayerV2 = (function',
    'const CityBuildingLOD', 'const BuildingTileLayer', 'const CityTileLayer',
    '__LAND_COVERAGE_DEBUG__', '__RIVER_NETWORK_DEBUG__', '__ROAD_NETWORK_DEBUG__',
    '__BUILDING_COVERAGE_DEBUG__', '__VISIBLE_BUILDING_GAP_DEBUG__', '__RAIL_LOD_DEBUG__']) {
    assert.ok(html.includes(kw), `既存 ${kw} が消えた`);
  }
});

test('[Mission24] projection (znorth-neg-v1) / Mission19 UI / Mission20 は不変', () => {
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html), 'projection 式が変わった');
  assert.ok(/LC_UI/.test(html) && /--lc-bg:/.test(html), 'Mission19 UI が消えた');
  assert.ok(/LiveCityModeManager/.test(html), 'Mission20 が消えた');
});

test('[Mission24] protected HTML に Mission24 の変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/__MAP_COMPLETENESS_DEBUG__|f\.railClass|getRoadCellCoverage|getBuildingCellCounts/.test(h), `${rel} に Mission24 混入`);
  }
});

// ── runtime ──
test('[Mission24] runtime: __MAP_COMPLETENESS_DEBUG__ が例外なく形を返す', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  await flush();
  const d = r.window.__MAP_COMPLETENESS_DEBUG__();
  assert.ok(d, '__MAP_COMPLETENESS_DEBUG__ が null');
  assert.ok(d.runtime && typeof d.runtime === 'object', 'runtime オブジェクトが無い');
  assert.ok(Array.isArray(d.runtimeMissing), 'runtimeMissing が配列でない');
  assert.ok(Array.isArray(d.visibleAnomalies), 'visibleAnomalies が配列でない');
  assert.ok('reportPath' in d, 'reportPath が無い');
});
