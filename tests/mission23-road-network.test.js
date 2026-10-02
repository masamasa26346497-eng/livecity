// tests/mission23-road-network.test.js
// [Mission23 全道路カバレッジ] source 拡張 / access フィルタ / 生活道路・細街路の配信 / LOD 維持 /
//   連続性 / 主要道路 regression / HTML 配線 / protected・production 無変更。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { classifyRoad, classifyRoadLod } from '../tools/lib/road-network.js';

const require = createRequire(import.meta.url);
const HTML_PATH = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i)[1];

const TILE_DIR = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'roads');
const COVERAGE = path.join(PROJECT_ROOT, 'data', 'reports', 'road-network-coverage.json');
const hasTiles = fs.existsSync(TILE_DIR);

function loadFeats() {
  const byId = new Map();
  for (const f of fs.readdirSync(TILE_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(TILE_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) if (ft.kind === 'line' && !byId.has(ft.id)) byId.set(ft.id, ft);
  }
  return [...byId.values()];
}
const feats = hasTiles ? loadFeats() : [];
const cov = fs.existsSync(COVERAGE) ? JSON.parse(fs.readFileSync(COVERAGE, 'utf-8')) : null;

function run() {
  return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
}
async function flush(n = 16) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

// ── HTML ──
test('[Mission23] インライン <script> の JS 構文が壊れていない', () => {
  const f = path.join(os.tmpdir(), `m23-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission23] Road LOD の閾値・band ロジックは Mission02 から不変', () => {
  assert.ok(/const ROAD_LOD_FAR_M = 9000, ROAD_LOD_MID_M = 3500;/.test(html), 'LOD 閾値が変わった');
  assert.ok(/function roadClassVisible\(cls, d\) \{\s*const band = roadLodBand\(d\);\s*if \(cls === 'major'\) return true;\s*if \(cls === 'mid'\) return band !== 'far';\s*return band === 'near';/.test(html), 'roadClassVisible が変わった（FAR=major / MID=+mid / NEAR=all）');
});

test('[Mission23] buildRoadMeshes は tier ごと 1 merged geometry（1道路=1mesh 化しない）', () => {
  assert.ok(/const buckets = \{ major: \[\], mid: \[\], local: \[\] \};/.test(html), '3-tier bucketing が無い');
  assert.ok(/for \(const tier of \['major', 'mid', 'local'\]\) \{/.test(html), 'tier ごとの merged mesh ループが無い');
  assert.ok(/if \(f\.underground === true\) continue;/.test(html), '地下道路の ribbon 除外が無い（§11）');
});

test('[Mission23] 生活道路の class default 幅が定義されている（pedestrian / road 追加）', () => {
  assert.ok(/pedestrian: 4, road: 4, track: 3 \}/.test(html), 'pedestrian/road/track の幅 default が無い');
  assert.ok(/residential: 5\.5, living_street: 4\.5, unclassified: 4\.5, service: 3\.5/.test(html), 'local 系 default が変わった');
});

test('[Mission23] __ROAD_NETWORK_DEBUG__ が公開されている / getRoadNetworkDebug', () => {
  assert.ok(/window\.__ROAD_NETWORK_DEBUG__ = \(name\) => \(typeof CityTileLayer !== 'undefined' \? CityTileLayer\.getRoadNetworkDebug\(name\) : null\);/.test(html));
  const fn = js.slice(js.indexOf('function getRoadNetworkDebug'));
  for (const k of ['total', 'major', 'mid', 'local', 'visible', 'segments', 'triangles', 'drawCalls', 'loadedTiles', 'named', 'unnamed', 'widthSources', 'eligibleLocal', 'displayedLocal', 'localCoveragePercent', 'tunnelsSkipped']) {
    assert.ok(fn.includes(k), `getRoadNetworkDebug に ${k} が無い`);
  }
});

test('[Mission23] 旧 OSM_ROADS リテラルを新規に増やしていない（既存の legacy はそのまま）', () => {
  // 建物/道路の巨大リテラルは既存。Mission23 で新しく OSM_ROADS 相当を足していないこと。
  const count = (js.match(/const OSM_ROADS = \[/g) || []).length;
  assert.ok(count <= 1, 'OSM_ROADS リテラルが増えた');
});

// ── source 拡張 / 配信データ ──
test('[Mission23] import フィルタ: 生活道路・細街路まで対象（footway/path は対象外）', () => {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'tools', 'import', 'osm-pbf-city.js'), 'utf-8');
  // way フィルタの正規表現リテラル（^(...)$ の中身）だけを取り出す
  const m = src.match(/way:\s*\(t\)\s*=>[^\n]*\n?[^\n]*\/\^\(([a-z_|]+)\)\$\/\.test\(t\.highway\)/);
  assert.ok(m, 'roads の way フィルタ正規表現が見つからない');
  const classes = m[1].split('|');
  for (const hw of ['residential', 'living_street', 'unclassified', 'service', 'pedestrian', 'motorway_link', 'road']) {
    assert.ok(classes.includes(hw), `import フィルタに ${hw} が無い`);
  }
  for (const hw of ['footway', 'path', 'steps', 'cycleway']) {
    assert.ok(!classes.includes(hw), `import フィルタに歩行者専用 ${hw} が混入`);
  }
  // [Mission26] track（農道・管理道路）は取り込む（access で通行可否を判定）
  assert.ok(classes.includes('track'), 'import フィルタに track が無い（Mission26）');
});

test('[Mission23] 配信 feature: 生活道路が取り込まれている / tier・detail が付く', { skip: !hasTiles && 'no tiles' }, () => {
  const hw = {};
  for (const f of feats) hw[f.highway] = (hw[f.highway] || 0) + 1;
  assert.ok((hw.residential || 0) > 5000, 'residential が少なすぎる');
  assert.ok((hw.unclassified || 0) > 3000, 'unclassified が取り込まれていない');
  assert.ok((hw.service || 0) > 1000, 'service が取り込まれていない');
  assert.ok((hw.motorway_link || 0) > 100, 'motorway_link が取り込まれていない');
  for (const f of feats) {
    assert.ok(['major', 'mid', 'local'].includes(f.tier || classifyRoadLod(f.highway || '')), `${f.id}: tier=${f.tier}`);
  }
});

test('[Mission23] 配信 feature: 私有 driveway / parking_aisle / access=private は除外済み', { skip: !hasTiles && 'no tiles' }, () => {
  for (const f of feats) {
    assert.notEqual(f.service, 'driveway', `${f.id}: driveway が混入`);
    assert.notEqual(f.service, 'parking_aisle', `${f.id}: parking_aisle が混入`);
    assert.notEqual(f.access, 'private', `${f.id}: access=private が混入`);
    const c = classifyRoad({ highway: f.highway, access: f.access, service: f.service });
    assert.ok(c.eligible, `${f.name || f.id}: ineligible road が配信されている (${c.skipReason})`);
  }
});

test('[Mission23] coverage report（§13）: eligible local coverage >= 99% / 主要項目', { skip: !cov && 'no coverage' }, () => {
  for (const k of ['rawHighwayWays', 'byHighwayTag', 'skipReasons', 'totalRoadWays', 'byClass', 'byDetail', 'named', 'unnamed', 'widthSource', 'nearCoverage', 'continuity', 'byWard']) {
    assert.ok(k in cov, `coverage report に ${k} が無い`);
  }
  assert.ok(cov.nearCoverage.localCoveragePercent >= 99, `local coverage ${cov.nearCoverage.localCoveragePercent}% < 99%`);
  assert.equal(cov.continuity.tileBoundaryBreaks, 0, 'tile boundary break がある');
  assert.equal(Object.keys(cov.byWard).length, 24, '24区分の byWard が無い');
});

test('[Mission23] district QA（§14）: 主要区に近距離道路がある', { skip: !cov && 'no coverage' }, () => {
  for (const w of ['kita', 'chuo', 'naniwa', 'tennoji', 'abeno', 'sumiyoshi', 'higashisumiyoshi', 'hirano', 'joto', 'tsurumi', 'konohana', 'minato', 'taisho', 'suminoe', 'ikuno', 'nishinari']) {
    assert.ok(cov.byWard[w] && cov.byWard[w].count > 100, `${w}: 道路が少なすぎる (${cov.byWard[w] && cov.byWard[w].count})`);
    assert.ok(cov.byWard[w].local > 50, `${w}: local 道路が少なすぎる`);
  }
});

// ── regression ──
test('[Mission23] 主要道路 regression: major/mid の分類・件数・named', { skip: !hasTiles && 'no tiles' }, () => {
  const byTier = { major: 0, mid: 0, local: 0 };
  for (const f of feats) byTier[f.tier || classifyRoadLod(f.highway || '')]++;
  assert.ok(byTier.major >= 1800 && byTier.major <= 2600, `major ${byTier.major} が想定外`);
  assert.ok(byTier.mid >= 4000 && byTier.mid <= 5500, `mid ${byTier.mid} が想定外`);
  assert.ok(byTier.local >= 25000, `local ${byTier.local} が少なすぎる`);
  const majorNames = new Set(feats.filter((f) => f.name && (f.tier || classifyRoadLod(f.highway || '')) === 'major').map((f) => f.name));
  // 代表的な幹線が名前で残っていること（名称ハードコードではなく OSM 由来の存在確認）
  assert.ok([...majorNames].some((n) => /筋$|通$|国道|阪神高速/.test(n)), '代表的な幹線名が見当たらない');
});

test('[Mission23] RiverLayerV2 / LandSurfaceLayer / WaterSurfaceLayer は不変', () => {
  assert.ok(/const RiverLayerV2 = \(function/.test(html) && /rivers-v2\/rivers\.json/.test(html), 'RiverLayerV2 が消えた');
  assert.ok(/const LandSurfaceLayer = \(function/.test(html), 'LandSurfaceLayer が消えた');
  assert.ok(/const WaterSurfaceLayer = \(function/.test(html), 'WaterSurfaceLayer が消えた');
  // road y > river y（§12）
  assert.ok(/ROAD_SURFACE: 0\.10/.test(html) && /WATER: 0\.04/.test(html), 'MAP_LAYER_Y の road/river 順序が変わった');
});

test('[Mission23] Mission19 UI / Mission20 モード分離 / projection は不変', () => {
  assert.ok(/--lc-bg:/.test(html) && /LC_UI/.test(html), 'Mission19 UI が消えた');
  assert.ok(/LiveCityModeManager/.test(html), 'Mission20 が消えた');
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html), 'projection 式が変わった');
});

test('[Mission23] protected HTML に Mission23 の変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/__ROAD_NETWORK_DEBUG__|getRoadNetworkDebug/.test(h), `${rel} に Mission23 混入`);
  }
});

// ── runtime ──
test('[Mission23] runtime: 例外なく評価 / __ROAD_NETWORK_DEBUG__ が集計を返す', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  await flush();
  const d = r.window.__ROAD_NETWORK_DEBUG__();
  assert.ok(d, '__ROAD_NETWORK_DEBUG__ が null');
  assert.ok(d.local > d.major, 'local が major より少ない（生活道路が読めていない）');
  assert.ok(d.total >= 1000, `total=${d.total}`);
  assert.ok(d.drawCalls >= 1, `drawCalls=${d.drawCalls}`);
  assert.ok('localCoveragePercent' in d && 'tunnelsSkipped' in d, 'debug キー不足');
  const oo = r.window.__ROAD_NETWORK_DEBUG__('御堂筋');
  assert.ok(oo && ('resolved' in oo), '個別道路検索が形を返さない');
});
