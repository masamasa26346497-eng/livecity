// tests/mission28-waterway-density.test.js
// [Mission28 小河川・運河・水路の高密度化]
//   micro tier / LOD 4 段 / 建物干渉（shrink 優先）/ underground 除外 / completeness /
//   major 7 河川 regression / __RIVER_NETWORK_DEBUG__ 拡張 / validator / runtime / protected・production。

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
const riverIife = html.slice(html.indexOf('const RiverLayerV2 = (function'), html.indexOf('RiverLayerV2.init();'));

const RIVERS = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json');
const DENSITY = path.join(PROJECT_ROOT, 'data', 'reports', 'waterway-density.json');
const COVERAGE = path.join(PROJECT_ROOT, 'data', 'reports', 'river-network-coverage.json');
const VAL = path.join(PROJECT_ROOT, 'data', 'reports', 'waterway-density-validation.json');
const doc = fs.existsSync(RIVERS) ? JSON.parse(fs.readFileSync(RIVERS, 'utf-8')) : null;
const den = fs.existsSync(DENSITY) ? JSON.parse(fs.readFileSync(DENSITY, 'utf-8')) : null;
const cov = fs.existsSync(COVERAGE) ? JSON.parse(fs.readFileSync(COVERAGE, 'utf-8')) : null;

function run() {
  return require('./_ward-ux-v1-smoke-harness.cjs').runInlineScript(undefined, { fetchRoot: path.resolve(PROJECT_ROOT, 'public') });
}
async function flush(n = 24) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

const MAJOR7 = ['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川'];

test('[Mission28] インライン <script> の JS 構文が壊れていない', () => {
  const f = path.join(os.tmpdir(), `m28-${process.pid}.js`);
  fs.writeFileSync(f, js);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

// ── HTML: micro tier / LOD ──
test('[Mission28] RiverLayerV2: micro mesh + MICRO_HIDE_DISTANCE_M=1500 + LOD 4 段', () => {
  assert.ok(/const MICRO_HIDE_DISTANCE_M = 1500;/.test(riverIife));
  assert.ok(/const MICRO_FADE_START_M = 1000;/.test(riverIife));
  assert.ok(/let majorMesh = null, mediumMesh = null, minorMesh = null, microMesh = null, shoreMesh = null;/.test(riverIife));
  assert.ok(/tier === 'major' \? majorPos : tier === 'medium' \? mediumPos : tier === 'micro' \? microPos : minorPos/.test(riverIife));
  assert.ok(/if \(microMesh\) microMesh\.visible = visible && distance <= MICRO_HIDE_DISTANCE_M;/.test(riverIife));
  // 既存 LOD 距離は不変（§0）
  assert.ok(/const MINOR_HIDE_DISTANCE_M = 4500;/.test(riverIife));
  assert.ok(/const MEDIUM_HIDE_DISTANCE_M = 9000;/.test(riverIife));
  // micro opacity fade
  assert.ok(/microMesh\.material\.opacity = base \* \(1 - 0\.9 \* mt\);/.test(riverIife));
  // static mesh 最適化維持（Mission25）
  assert.ok(/markStaticMesh\(microMesh\);/.test(riverIife));
});

test('[Mission28] shore は micro に付けない（§9 岸線 drawcall 増やさない）', () => {
  assert.ok(/if \(tier === 'major' \|\| tier === 'medium'\) \{ appendShorelineSegments/.test(riverIife));
});

test('[Mission28] __RIVER_NETWORK_DEBUG__ 拡張キー（byClass / byWaterway / visibleByLod / shrunk / overlapCount）', () => {
  const fn = riverIife.slice(riverIife.indexOf('function getNetworkDebug'));
  for (const k of ['byClass', 'byWaterway', 'visibleByLod', 'micro', 'microTriangles', 'shrunk', 'overlapCount',
    'minorWaterSuppressedCount', 'undergroundSkipped']) {
    assert.ok(fn.includes(k), `getNetworkDebug に ${k} が無い`);
  }
});

// ── 配信データ ──
test('[Mission28] rivers.json: micro tier / underground 混入なし / major 7 河川不変', { skip: !doc && 'no data' }, () => {
  assert.ok(doc.microCount >= 10, `micro が少ない: ${doc.microCount}`);
  for (const r of doc.rivers) {
    assert.ok(['major', 'medium', 'minor', 'micro'].includes(r.riverClass), `${r.name || r.id}: ${r.riverClass}`);
    assert.notEqual(r.surface, false, `${r.name || r.id}: underground が混入`);
    if (r.riverClass === 'micro' && r.ok && !r.suppressed) {
      assert.ok((r.widthMax || r.width || 0) <= 8 + 1e-6, `${r.name || r.id}: micro width ${r.widthMax} > 8m`);
    }
  }
  // major 7 河川は major・非 suppress・エラーなし
  for (const nm of MAJOR7) {
    const segs = doc.rivers.filter((r) => r.name === nm);
    assert.ok(segs.length > 0, `${nm} が無い`);
    for (const s of segs) { assert.equal(s.riverClass, 'major'); assert.equal(!!s.suppressed, false); assert.deepEqual(s.validationErrors || [], []); }
  }
  assert.ok(doc.buildingOverlap, 'buildingOverlap（§11）が payload に無い');
});

test('[Mission28] coverage report: tiers.micro / buildingOverlap / displayedByTier', { skip: !cov && 'no coverage' }, () => {
  assert.ok(cov.tiers.micro != null, 'tiers.micro が無い');
  assert.ok(cov.buildingOverlap, 'buildingOverlap が無い');
  for (const k of ['waterBuildingOverlapCount', 'minorWaterSuppressedCount', 'minorWaterShrunkCount']) {
    assert.ok(k in cov.buildingOverlap, `buildingOverlap に ${k} が無い`);
  }
  assert.ok(cov.displayedByTier && cov.displayedByTier.micro != null);
  assert.deepEqual(cov.unexplainedGapRivers, [], 'unexplained gap river がある');
});

test('[Mission28] water completeness: OSM surface waterway が理由なく消えていない', { skip: !den && 'no density' }, () => {
  assert.equal(den.grid.missingSurfaceWater, 0, `missing surface water ${den.grid.missingSurfaceWater}`);
  assert.ok(den.grid.coverage >= 0.9, `completeness ${den.grid.coverage}`);
  assert.ok(den.grid.undergroundSkippedCells > 0, 'underground cell が記録されていない');
  assert.equal(den.RESULT, 'PASS');
});

test('[Mission28] validator: waterway-density RESULT PASS', { skip: !fs.existsSync(VAL) && 'no validation' }, () => {
  const v = JSON.parse(fs.readFileSync(VAL, 'utf-8'));
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.counts.dupId, 0);
  assert.equal(v.counts.invalidGeom, 0);
  assert.equal(v.counts.giantTri, 0);
  assert.equal(v.counts.bboxViolation, 0);
  assert.equal(v.counts.undergroundRendered, 0);
  assert.ok(v.microMaxWidth <= 8 + 1e-6);
});

// ── 回帰 ──
test('[Mission28] 既存レイヤー / projection / Mission25 最適化 不変', () => {
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html));
  assert.ok(/const WaterSurfaceLayer = \(function/.test(html) && /const LandSurfaceLayer = \(function/.test(html));
  assert.ok(/const MAJOR_RIVER_NAMES = new Set\(\['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川'\]\);/.test(html));
  assert.ok(/function markStaticMesh\(obj\) \{/.test(html), 'markStaticMesh（Mission25）が消えた');
});

test('[Mission28] protected HTML に Mission28 変更が混入していない（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/MICRO_HIDE_DISTANCE_M|microMesh|microOpacity/.test(h), `${rel} に Mission28 混入`);
  }
});

// ── runtime ──
test('[Mission28] runtime: __RIVER_NETWORK_DEBUG__ が micro / byClass / visibleByLod を返す', async () => {
  const r = run();
  assert.ok(r.ok, r.error && r.error.stack);
  await flush();
  const d = r.window.__RIVER_NETWORK_DEBUG__();
  assert.ok(d.byClass && typeof d.byClass.micro === 'number', 'byClass.micro が無い');
  assert.ok(d.byWaterway && typeof d.byWaterway === 'object');
  assert.ok(d.visibleByLod && typeof d.visibleByLod.micro === 'boolean');
  assert.ok(d.micro >= 10, `micro=${d.micro}`);
  assert.ok(d.drawCalls >= 1 && d.drawCalls <= 5);
  assert.ok(d.undergroundSkipped > 0);
  assert.equal(d.unexplainedGapRivers.length, 0);
});
