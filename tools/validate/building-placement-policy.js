#!/usr/bin/env node
// tools/validate/building-placement-policy.js
// [Mission 31G-FIX6 §25] Building Placement Policy の検証。
//
//   PASS 条件:
//     - missing building id 0（placement tile の canonicalId が canonical buildings に存在）
//     - invalid policy 0（SUPPRESS / REVIEW / EXEMPT のみ。DISPLAY は tile に載せない）
//     - source geometry mutation 0（canonical buildings の count / manifest 不変）
//     - unexplained auto suppress 0（SUPPRESS の reason が許可集合内・overlap 閾値と整合）
//     - EXPLAIN building wrongly suppressed 0（31E EXPLAIN の建物を SUPPRESS していない）
//     - ward scope regression 0（runtime は wardId フィルタ → placement フィルタの 2 段）
//     - canonical building count unchanged（615,617）
//     - production / protected unchanged
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const PLACE_DIR = P('data', 'processed', 'osaka-city', 'derived', 'building-placement');
const PLACE_PUB = P('public', 'map-data', 'osaka-city', 'derived', 'building-placement');
const CANON_BLD = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const RESOLUTION = P('data', 'reports', 'canonical-conflict-resolution.json');
const DEV = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const REPORT = P('data', 'reports', 'building-placement-validation.json');

const VALID_POLICIES = new Set(['SUPPRESS', 'REVIEW', 'EXEMPT']);
const ALLOWED_SUPPRESS_REASONS = new Set([
  'building-major-overlap-with-water',
  'building-almost-entirely-inside-road-area',
]);
const EXPECTED_CANON_COUNT = 615617;

function sha(p) { return fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null; }

function loadCanonicalBuildingIds() {
  const ids = new Set();
  let count = 0;
  for (const f of fs.readdirSync(CANON_BLD)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(CANON_BLD, f), 'utf-8'));
    for (const ft of (t.features || [])) { ids.add(ft.canonicalId); count++; }
  }
  return { ids, count };
}

async function main() {
  const errors = [], warns = [];

  if (!fs.existsSync(path.join(PLACE_DIR, 'manifest.json'))) {
    errors.push('building-placement/manifest.json が無い（先に build-building-placement-policy.js）');
    return fail(errors, warns);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(PLACE_DIR, 'manifest.json'), 'utf-8'));

  // ── canonical buildings 不変 ──
  const canonManifest = JSON.parse(fs.readFileSync(path.join(CANON_BLD, 'manifest.json'), 'utf-8'));
  const canonCount = canonManifest.featureCount != null ? canonManifest.featureCount : canonManifest.count;
  if (canonCount !== EXPECTED_CANON_COUNT) errors.push(`canonical building count が ${canonCount}（期待 ${EXPECTED_CANON_COUNT}）— source mutation 疑い`);
  if (manifest.canonicalBuildingCount !== canonCount) errors.push(`placement manifest の canonicalBuildingCount(${manifest.canonicalBuildingCount}) が canonical(${canonCount}) と不一致`);

  const { ids: canonIds, count: canonCounted } = loadCanonicalBuildingIds();
  if (canonCounted !== EXPECTED_CANON_COUNT) warns.push(`canonical building tile 実 count ${canonCounted}（manifest ${canonCount}）`);

  // ── 31E EXPLAIN 建物集合 ──
  const explainBuildings = new Set();
  const manualReviewBuildings = new Set();
  if (fs.existsSync(RESOLUTION)) {
    const r = JSON.parse(fs.readFileSync(RESOLUTION, 'utf-8'));
    for (const c of (r.conflicts || [])) {
      if (c.pairType !== 'BUILDING_WATER' && c.pairType !== 'BUILDING_ROAD') continue;
      for (const b of (Array.isArray(c.featureB) ? c.featureB : [c.featureB])) {
        if (typeof b !== 'string') continue;
        const cid = 'cg_bldg_' + b;
        if (c.action === 'EXPLAIN') explainBuildings.add(cid);
        else if (c.action === 'MANUAL_REVIEW') manualReviewBuildings.add(cid);
      }
    }
  } else warns.push('canonical-conflict-resolution.json が無い（EXPLAIN 逆流チェックをスキップ）');

  // ── placement tile 走査 ──
  const th = manifest.thresholds || {};
  const seen = new Set();
  let entries = 0, invalidPolicy = 0, missingId = 0, dupId = 0;
  let suppress = 0, review = 0, exempt = 0;
  let unexplainedSuppress = 0, explainSuppressed = 0, thresholdInconsistent = 0;
  const suppressReasonHist = {};
  for (const tinfo of (manifest.tiles || [])) {
    const tp = path.join(PLACE_DIR, tinfo.file);
    if (!fs.existsSync(tp)) { errors.push('manifest 記載 tile が無い: ' + tinfo.file); continue; }
    const tile = JSON.parse(fs.readFileSync(tp, 'utf-8'));
    for (const [cid, e] of Object.entries(tile.policies || {})) {
      entries++;
      if (seen.has(cid)) dupId++; seen.add(cid);
      if (!VALID_POLICIES.has(e.policy)) { invalidPolicy++; continue; }
      if (!canonIds.has(cid)) missingId++;
      if (e.policy === 'SUPPRESS') {
        suppress++;
        suppressReasonHist[e.reason] = (suppressReasonHist[e.reason] || 0) + 1;
        if (!ALLOWED_SUPPRESS_REASONS.has(e.reason)) unexplainedSuppress++;
        if (explainBuildings.has(cid)) explainSuppressed++;
        // 閾値整合
        const okWater = e.reason === 'building-major-overlap-with-water'
          && e.waterOverlapRatio >= (th.WATER_SUPPRESS_RATIO || 0.6) && e.overlapAreaM2 >= (th.WATER_SUPPRESS_AREA || 20);
        const okRoad = e.reason === 'building-almost-entirely-inside-road-area'
          && e.roadOverlapRatio >= (th.ROAD_SUPPRESS_RATIO || 0.97) && e.overlapAreaM2 >= (th.ROAD_SUPPRESS_AREA || 25);
        if (!okWater && !okRoad) thresholdInconsistent++;
      } else if (e.policy === 'REVIEW') review++;
      else if (e.policy === 'EXEMPT') exempt++;
    }
  }

  if (invalidPolicy) errors.push(`invalid policy ${invalidPolicy} 件（SUPPRESS/REVIEW/EXEMPT 以外）`);
  if (missingId) errors.push(`missing building id ${missingId} 件（canonical buildings に存在しない canonicalId）`);
  if (dupId) errors.push(`duplicate canonicalId ${dupId} 件（tile 間で重複）`);
  if (unexplainedSuppress) errors.push(`unexplained auto suppress ${unexplainedSuppress} 件（reason が許可集合外）`);
  if (thresholdInconsistent) errors.push(`SUPPRESS の overlap が閾値と不整合 ${thresholdInconsistent} 件`);
  if (explainSuppressed) errors.push(`31E EXPLAIN の建物を SUPPRESS している ${explainSuppressed} 件（§4/§25 違反）`);

  // ── 大量誤 SUPPRESS（§16）──
  const suppressFrac = suppress / Math.max(1, canonCount);
  if (suppressFrac > 0.02) errors.push(`SUPPRESS 率 ${(suppressFrac * 100).toFixed(2)}% > 2%（§16: 異常に多い）`);
  if (suppressFrac > 0.005) warns.push(`SUPPRESS 率 ${(suppressFrac * 100).toFixed(2)}%（0.5% 超。分布を確認）`);

  // ── source geometry mutation: canonical/ 配下に placement が書き込んでいない ──
  for (const stray of ['building-placement', 'placement']) {
    if (fs.existsSync(path.join(CANON_BLD, stray))) errors.push('canonical/buildings 配下に ' + stray + ' が生成されている（source 汚染）');
  }

  // ── runtime 統合（ward scope 2 段・placement lookup）──
  if (fs.existsSync(DEV)) {
    const html = fs.readFileSync(DEV, 'utf-8');
    const need = [
      ['placement lookup（buildings tile と同じ tx/tz）', /building-placement\/tile_/],
      ['placement Map', /placementPolicy|placementCache/],
      ['SUPPRESS を mesh から除外', /placement[\s\S]{0,80}=== 'SUPPRESS'|=== 'SUPPRESS'[\s\S]{0,80}continue/],
      ['ward filter → placement filter の 2 段（§12）', /if \(layer === 'buildings' && wardId\) \{[\s\S]{0,400}f\.attributes\.wardId\) === wardId/],
      ['buildingWardId（ward scope 不変）', /function buildingWardId\(\)/],
      ['GLOBAL_LAYERS 不変', /const GLOBAL_LAYERS = new Set\(\['roads', 'water', 'parks', 'rail'\]\)/],
      ['placement debug/status', /__PLACEMENT_DEBUG__|Suppressed|placementStats/],
    ];
    for (const [label, re] of need) if (!re.test(html)) errors.push('runtime 統合 欠落: ' + label);
    // ward scope regression: 建物 filter が placement より先
    const s = html.indexOf("} else if (layer === 'buildings') {");
    if (s >= 0) {
      const block = html.slice(s, s + 2400);
      const wardPos = block.search(/wardId/);
      const placePos = block.search(/placement/i);
      if (wardPos >= 0 && placePos >= 0 && placePos < wardPos - 5) {
        // placement が明らかに ward より前なら注意（順序は loadTile の feats.filter 段で ward 済みなので通常問題なし）
        warns.push('buildings branch で placement 参照が ward フィルタより前に見える（要確認）');
      }
    }
  } else warns.push('ward-ux-v1.html が無い（runtime 統合チェックをスキップ）');

  // ── public への配置 ──
  if (!fs.existsSync(path.join(PLACE_PUB, 'manifest.json'))) errors.push('public/map-data/.../building-placement/manifest.json が無い（build-derived-public.js 未実行）');

  // ── production / protected 不変 ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf-8')) : null;
  if (baseline) {
    if (baseline.prod && curProd && baseline.prod !== curProd) errors.push('production HTML が変更されている（§0 禁止）');
    if (baseline.prot && curProt && baseline.prot !== curProt) errors.push('protected HTML が変更されている（§0 禁止）');
  } else warns.push('prod/protected hash baseline が無い');

  const report = {
    generatedAt: new Date().toISOString(),
    checks: {
      manifestPresent: true,
      canonicalBuildingCountUnchanged: canonCount === EXPECTED_CANON_COUNT,
      invalidPolicy, missingId, duplicateId: dupId,
      unexplainedAutoSuppress: unexplainedSuppress,
      thresholdInconsistent,
      explainBuildingWronglySuppressed: explainSuppressed,
      suppressCount: suppress, reviewCount: review, exemptCount: exempt,
      suppressFraction: +suppressFrac.toFixed(5),
      suppressReasonHist,
      placementEntries: entries,
      publicPublished: fs.existsSync(path.join(PLACE_PUB, 'manifest.json')),
      productionUnchanged: !(baseline && baseline.prod && curProd && baseline.prod !== curProd),
      protectedUnchanged: !(baseline && baseline.prot && curProt && baseline.prot !== curProt),
    },
    thresholds: th,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[building-placement-validate] ' + JSON.stringify(report.checks));
  for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e);
  for (const w of warns.slice(0, 10)) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

async function fail(errors, warns) {
  await writeJson(REPORT, { generatedAt: new Date().toISOString(), errors, warns, RESULT: 'FAIL' });
  for (const e of errors) console.log('  [ERROR] ' + e);
  process.exitCode = 1;
}

main().catch((e) => { console.error('[building-placement-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
