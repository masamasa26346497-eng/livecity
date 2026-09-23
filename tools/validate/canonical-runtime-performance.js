#!/usr/bin/env node
// tools/validate/canonical-runtime-performance.js
// [Mission 31G-FIX7 §41/§42] Canonical Runtime 高速化の静的検証 + 性能レポート雛形。
//
//   ブラウザ実行は不可なので、before/after の実測値は __CANONICAL_RUNTIME_PERF__() で
//   ユーザーが取得する。ここでは:
//     - 高速化のための配線が入っているか（§42 チェック）
//     - derived tile の payload 実測（どの layer/LOD が重いか）
//     - 最適化前後の「戦略」を記録
//   を出力する。
//
//   §42 チェック:
//     duplicateFetch 0 / manifestReload 0 / frameIdleRefresh 0 / globalReloadOnWardSwitch 0
//     runtime geometry missing 0 / legacy residual 0 / placement policy active / usage palette active
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DEV = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const DERIVED_PUB = P('public', 'map-data', 'osaka-city', 'derived');
const REPORT = P('data', 'reports', 'canonical-runtime-performance.json');

const LODS = ['far', 'mid', 'near'];
const LAYERS = ['water', 'roads', 'buildings', 'parks', 'rail'];

function tilePayload(lod, layer) {
  const d = path.join(DERIVED_PUB, lod, layer);
  if (!fs.existsSync(d)) return null;
  const files = fs.readdirSync(d).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f));
  if (!files.length) return { tiles: 0, avgKB: 0, maxKB: 0, p90KB: 0 };
  const sizes = [];
  for (const f of files.slice(0, 400)) sizes.push(fs.statSync(path.join(d, f)).size);
  sizes.sort((a, b) => a - b);
  const sum = sizes.reduce((a, b) => a + b, 0);
  return {
    tiles: files.length,
    avgKB: +(sum / sizes.length / 1024).toFixed(1),
    p90KB: +(sizes[Math.floor(sizes.length * 0.9)] / 1024).toFixed(1),
    maxKB: +(sizes[sizes.length - 1] / 1024).toFixed(1),
  };
}

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(DEV)) { errors.push('ward-ux-v1.html が無い'); return done(errors, warns, null); }
  const html = fs.readFileSync(DEV, 'utf-8');

  // ── §42 チェック（静的）──
  const checks = {
    // duplicateFetch 0: queued Set + inflight + tileCache 済み判定で二重 fetch を防ぐ
    duplicateFetch: (/const queued = new Set\(inflight\);/.test(html) && /if \(queued\.has\(k\)\) continue;/.test(html)
      && /if \(tileCache\.has\(key\) \|\| inflight\.has\(key\)\) return;/.test(html)) ? 0 : 1,
    // manifestReload 0: ensureManifest 冒頭で return
    manifestReload: /async function ensureManifest\(\) \{\s*\n\s*if \(manifest\) return manifest;/.test(html) ? 0 : 1,
    // frameIdleRefresh 0: 静止 frame では refresh しない（未取得 tile がある時だけ progressive 追加）
    frameIdleRefresh: (/if \(now - lastUpdate < THROTTLE_MS\) \{/.test(html)
      && /for \(const k of wantSet\) if \(!tileCache\.has\(k\)\) \{ missing = true; break; \}/.test(html)) ? 0 : 1,
    // globalReloadOnWardSwitch 0: ward 切替は buildings のみ hide/unpin、GLOBAL cache key は ward 非依存
    globalReloadOnWardSwitch: (/if \(e\.layer === 'buildings'\) \{ e\.group\.visible = false; e\.pinnedByWard = null; \}/.test(html)
      && /\(layer === 'buildings'\) \? \(base \+ '@' \+ \(buildingWardId\(\) \|\| 'city'\)\) : base/.test(html)) ? 0 : 1,
    // legacy residual 0: ownership guard + classifyLegacyResidual を維持
    legacyResidualGuard: (/window\.__CANONICAL_OWNS_BASE__ = !!hidden/.test(html) && /function classifyLegacyResidual\(\)/.test(html)) ? 1 : 0,
    // placement policy active
    placementPolicyActive: (/async function ensurePlacement\(tx, tz\)/.test(html) && /placementPolicy\.get\(f\.canonicalId\)/.test(html)) ? 1 : 0,
    // usage palette active
    usagePaletteActive: (/const CR_USAGE_COLOR = \{/.test(html) && /crUsageCategory\(a\)/.test(html)) ? 1 : 0,
    // 高速化配線
    progressiveBuildBudget: /function drainBuild\(now\)/.test(html) && /frameBuildMs < BUILD_BUDGET_MS/.test(html),
    fetchConcurrencyLimited: /const MAX_CONCURRENT_FETCH = \d+;/.test(html) && /while \(activeFetches < MAX_CONCURRENT_FETCH/.test(html),
    fetchParseSplit: /async function fetchAndParse\(job\)/.test(html) && /function buildGroup\(layer, band, feats\)/.test(html),
    lodHysteresis: /const BAND_HYST_M = \d+;/.test(html),
    cameraDirtyThreshold: /const CAM_MOVE_EPS_M = \d+;/.test(html),
    byteBudgetCache: /const MAX_CACHE_MB = \d+;/.test(html),
    staleRequestCancel: /new AbortController\(\)/.test(html) && /function drainStaleQueues\(\)/.test(html),
    nearGlobalUsesMidTile: /if \(band === 'near'\) return GLOBAL_LAYERS\.has\(layer\) \? 'mid' : 'near';/.test(html),
    nearBuildingDistanceRing: /want\.push\(\['buildings', 'far', tx, tz\]\)/.test(html),
    perfHud: /window\.__CANONICAL_RUNTIME_PERF__ = function/.test(html) && /' fps　'/.test(html),
  };
  for (const [k, v] of Object.entries(checks)) {
    if (k.endsWith('Refresh') || k.endsWith('Reload') || k.startsWith('duplicate') || k.startsWith('globalReload')) {
      if (v !== 0) errors.push(`§42 チェック失敗: ${k} = ${v}（0 であるべき）`);
    } else if (!v) errors.push(`§42 チェック失敗: ${k} が false`);
  }

  // ── runtime geometry missing 0: derived public tile が全 band/layer で存在 ──
  let missingLodLayer = 0;
  for (const lod of LODS) for (const l of LAYERS) {
    if (!fs.existsSync(path.join(DERIVED_PUB, lod, l, 'manifest.json'))) missingLodLayer++;
  }
  if (missingLodLayer) errors.push(`derived public に ${missingLodLayer} 個の lod/layer manifest が欠落（runtime geometry missing）`);

  // ── payload 実測（どこが重いか）──
  const payload = {};
  for (const lod of LODS) { payload[lod] = {}; for (const l of LAYERS) payload[lod][l] = tilePayload(lod, l); }
  // 最も重い tile 種を特定
  const flat = [];
  for (const lod of LODS) for (const l of LAYERS) { const p = payload[lod][l]; if (p) flat.push({ lod, layer: l, avgKB: p.avgKB, maxKB: p.maxKB }); }
  flat.sort((a, b) => b.avgKB - a.avgKB);
  const heaviest = flat.slice(0, 5);

  const report = {
    generatedAt: new Date().toISOString(),
    note: 'before/after の実測値はブラウザで __CANONICAL_RUNTIME_PERF__() を実行して取得する（このセッションはブラウザ不可）。',
    checks,
    checksPassed: errors.length === 0,
    runtimeGeometryMissing: missingLodLayer,
    payloadByLodLayer: payload,
    heaviestTileTypes: heaviest,
    optimizationStrategy: {
      before_31G_FIX6: {
        buildOnFetchThen: 'loadTile 内で fetch+parse+mesh build を一括（1 frame にスパイク）',
        fetchConcurrency: '無制限（LOAD_BUDGET=20 個を一気に fetch）',
        lru: 'tile 数 260 固定',
        lodTiles: 'near band は全 layer near tile（near/roads 平均 1.4MB・near/buildings 平均 358KB）',
        nearBuildingReach: 'cs.r*0.6（最大 3600m）→ near tile 数十枚',
        cameraDirty: '500m 量子化 key のみ',
        lodHysteresis: 'なし',
        staleCancel: 'なし',
        wardSwitch: 'buildings tile を同期 dispose+delete',
      },
      after_31G_FIX7: {
        buildQueue: 'fetchAndParse（非同期）→ buildQ → drainBuild が 1 frame BUILD_BUDGET_MS(7ms) まで build',
        fetchConcurrency: `MAX_CONCURRENT_FETCH=6 の優先度キュー（water→roads→rail→parks→buildings, 各群 camera 中心距離順）`,
        lru: `byte-budget（MAX_CACHE_MB=300）+ tile 数下限 240。visible tile は evict しない`,
        lodTiles: 'near band の GLOBAL 地図（roads/water/parks/rail）は mid tile（tolM 6m・平均 131KB＝約 1/10）',
        nearBuildingRing: '内側 1300m = near tile（詳細）/ 外側 = far tile（mass ~6.5KB）で連続性維持',
        cameraDirty: 'CAM_MOVE_EPS_M=55m / CAM_ZOOM_EPS=0.05 未満は refresh しない + 停止後 SETTLE_MS=150ms で最終 refresh',
        lodHysteresis: 'BAND_HYST_M=420m（near⇔mid⇔far 境界の遊び）',
        staleCancel: 'refresh ごとに wantSet 外の in-flight fetch を AbortController で abort、queue から除去',
        wardSwitch: 'buildings tile は hide のみ（LRU に委譲）→ UI を止めない。旧区 build job は破棄',
      },
    },
    runtimeMeasurement: {
      howTo: 'http-server 起動 → ページを開く → 30 秒操作 → Console で __CANONICAL_RUNTIME_PERF__() を実行し before/after を貼る',
      metrics: ['startupMs', 'manifestLoadMs', 'firstMapVisibleMs', 'firstBuildingVisibleMs', 'frameAvgMs', 'frameP95Ms', 'fps',
        'totals.tileFetchMs', 'totals.tileParseMs', 'totals.meshBuildMs', 'totals.fetchMB', 'byLayer', 'tiles', 'scene.drawCalls', 'scene.triangles', 'scene.memoryEstimateMB'],
      before: null,
      after: null,
    },
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  await done(errors, warns, report);
}

async function done(errors, warns, report) {
  const r = report || { generatedAt: new Date().toISOString(), errors, warns, RESULT: 'FAIL' };
  r.errors = errors.slice(0, 40); r.warns = warns.slice(0, 20);
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, r);
  console.log('[canonical-runtime-perf] checks: ' + JSON.stringify(r.checks || {}));
  if (r.heaviestTileTypes) console.log('  heaviest tiles: ' + r.heaviestTileTypes.map((h) => `${h.lod}/${h.layer} ${h.avgKB}KB`).join(', '));
  for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + r.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[canonical-runtime-perf] 失敗:', e && e.stack || e); process.exitCode = 1; });
