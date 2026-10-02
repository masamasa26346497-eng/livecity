#!/usr/bin/env node
// tools/validate/road-network.js
// [Mission23 §16] 道路ネットワーク（RoadLayer 全道路）の配信データ validator CLI。
//
// PASS 条件:
//   - NaN / Inf 頂点 0
//   - invalid width 0（class default / lanes / width の解決結果が範囲外）
//   - giant segment 0（1 セグメント > 800m の細街路。疎ノード or way 誤結合の signature）
//   - eligible local road coverage >= 99%（NEAR で render 対象になる割合）
//   - tile boundary unexplained break = 0（line feature は tile 境界でクリップされない＝構造的に 0）
//   - 主要道路 regression intact（major/mid の分類・件数・代表 named 道路）
//   - Road LOD intact（HTML の閾値・3 tier bucketing・NEAR で local 表示）
//   - per-road mesh explosion なし（buildRoadMeshes は tier ごとに 1 merged geometry）
//   - protected / production HTML に Mission23 の変更が混入していない
//
// 実行: node tools/validate/road-network.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { classifyRoad, classifyRoadLod, resolveRoadWidth, ROAD_W_MIN, ROAD_W_MAX } from '../lib/road-network.js';

const TILE_DIR = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'roads'));
const COVERAGE = resolveProjectPath(path.join('data', 'reports', 'road-network-coverage.json'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'road-network-validation.json'));
const DEV_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.ward-ux-v1.html'));
const PROD_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.html'));
const PROTECTED_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.fullward-v3.html'));

const GIANT_SEG_M = 800;

function loadFeats() {
  const byId = new Map();
  for (const f of fs.readdirSync(TILE_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(TILE_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) if (ft.kind === 'line' && !byId.has(ft.id)) byId.set(ft.id, ft);
  }
  return [...byId.values()];
}

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(TILE_DIR)) { console.error('[road-network-validate] road tile なし: ' + toProjectRelativePath(TILE_DIR)); process.exitCode = 1; return; }
  const feats = loadFeats();
  const cov = fs.existsSync(COVERAGE) ? JSON.parse(fs.readFileSync(COVERAGE, 'utf-8')) : null;

  let nan = 0, badWidth = 0, giant = 0;
  const byTier = { major: 0, mid: 0, local: 0 };
  let underground = 0;
  for (const f of feats) {
    const p = f.p || [];
    let bad = false;
    for (const pt of p) if (!Array.isArray(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) bad = true;
    if (bad) { nan++; continue; }
    const tier = f.tier || classifyRoadLod(f.highway || '');
    // giant segment: 細街路（local）で 1 セグメント > 800m は疎ノード or way 誤結合の signature。
    //   幹線・高架・海底トンネルは長い直線が正当なので major/mid は対象外（HTML は 40m へ再密化する）。
    if (tier === 'local') {
      for (let i = 1; i < p.length; i++) if (Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]) > GIANT_SEG_M) { giant++; break; }
    }
    const w = resolveRoadWidth(f);
    if (!(Number.isFinite(w.width) && w.width >= ROAD_W_MIN - 1e-6 && w.width <= ROAD_W_MAX + 1e-6)) badWidth++;
    byTier[tier]++;
    if (f.underground) underground++;
    // access=private / service=driveway が配信に混入していないこと
    const c = classifyRoad({ highway: f.highway, access: f.access, service: f.service });
    if (!c.eligible) errors.push('配信に ineligible road が混入: ' + (f.name || f.id) + ' (' + c.skipReason + ')');
  }
  if (nan) errors.push('NaN/Inf 頂点をもつ road feature ' + nan);
  if (badWidth) errors.push('invalid width の road feature ' + badWidth);
  if (giant) errors.push('giant segment（local で > ' + GIANT_SEG_M + 'm）をもつ road feature ' + giant);

  // ── coverage ──
  if (cov) {
    const lc = cov.nearCoverage && cov.nearCoverage.localCoveragePercent;
    if (!(lc >= 99)) errors.push('eligible local road coverage が 99% 未満: ' + lc + '%');
    if (cov.continuity && cov.continuity.tileBoundaryBreaks !== 0) errors.push('tile boundary unexplained break ' + cov.continuity.tileBoundaryBreaks);
  } else {
    warns.push('road-network-coverage.json が無い（node tools/audit/road-network.js）');
  }

  // ── tier 分布 sanity / regression ──
  if (byTier.major < 1500) errors.push('major road が少なすぎる（' + byTier.major + '）— regression の疑い');
  if (byTier.local < 20000) errors.push('local road が少なすぎる（' + byTier.local + '）— 生活道路が取り込まれていない');
  const named = feats.filter((f) => f.name);
  const majorNamed = named.filter((f) => (f.tier || classifyRoadLod(f.highway || '')) === 'major');
  if (majorNamed.length < 50) errors.push('named major road が少なすぎる（' + majorNamed.length + '）');

  // ── HTML 配線 ──
  if (fs.existsSync(DEV_HTML)) {
    const html = fs.readFileSync(DEV_HTML, 'utf-8');
    if (!/__ROAD_NETWORK_DEBUG__/.test(html)) errors.push('dev HTML に __ROAD_NETWORK_DEBUG__ が無い');
    if (!/const ROAD_LOD_FAR_M = 9000, ROAD_LOD_MID_M = 3500;/.test(html)) errors.push('Road LOD の閾値が変わった（Mission02 回帰）');
    if (!/const buckets = \{ major: \[\], mid: \[\], local: \[\] \};/.test(html)) errors.push('buildRoadMeshes の 3-tier bucketing が壊れた');
    if (!/if \(f\.underground === true\) continue;/.test(html)) errors.push('地下道路の ribbon 除外が無い（§11）');
    if (!/for \(const tier of \['major', 'mid', 'local'\]\)/.test(html)) errors.push('tier ごと 1 merged mesh の構造が壊れた（1道路=1mesh 化の疑い）');
    if (/new THREE\.Mesh\([\s\S]{0,60}\bf\.p\b/.test(html)) warns.push('道路 feature ごとに Mesh を作っている疑い');
  }
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(label + ' HTML なし'); continue; }
    const h = fs.readFileSync(p, 'utf-8');
    if (/__ROAD_NETWORK_DEBUG__|getRoadNetworkDebug|f\.underground === true/.test(h)) errors.push(label + ' HTML に Mission23 の変更が混入している');
  }

  console.log('[road-network-validate] road feature ' + feats.length + '  byTier ' + JSON.stringify(byTier));
  console.log('  nan=' + nan + ' badWidth=' + badWidth + ' giantSeg=' + giant + ' underground=' + underground);
  if (cov) console.log('  local coverage=' + (cov.nearCoverage && cov.nearCoverage.localCoveragePercent) + '%  tileBoundaryBreaks=' + (cov.continuity && cov.continuity.tileBoundaryBreaks) + '  sourceNearMissGaps=' + (cov.continuity && cov.continuity.sourceNearMissGaps));
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    tiles: toProjectRelativePath(TILE_DIR),
    roadFeatures: feats.length, byTier, underground,
    checks: { nan, badWidth, giantSeg: giant },
    coverage: cov ? cov.nearCoverage : null,
    continuity: cov ? { tileBoundaryBreaks: cov.continuity.tileBoundaryBreaks, sourceNearMissGaps: cov.continuity.sourceNearMissGaps, danglingFrac: cov.continuity.danglingFrac } : null,
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[road-network-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
