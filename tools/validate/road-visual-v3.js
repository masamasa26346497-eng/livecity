#!/usr/bin/env node
// tools/validate/road-visual-v3.js
// [Mission 32I §28] ROAD V3 の検証。
//   buildingMutation / canonicalRoadMutation / projectionMutation = 0
//   tranUsedAsDarkCarriagewaySource = false / tranUsedAsSafetyEnvelope = true
//   buildingUsedForRoadGeneration = false
//   roadV3Exists / widthSanityMeasured / continuityMeasured = true
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const REPORT = P('data', 'reports', 'road-visual-v3.json');
const OUT = P('data', 'reports', 'road-visual-v3-validation.json');
const BUILDER = P('tools', 'build-road-visual-v3.js');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const V3_DIR = P('data', 'processed', 'osaka-city', 'derived', 'road-visual-v3');
const PUBLIC_V3 = P('public', 'map-data', 'osaka-city', 'derived', 'road-visual-v3');
const AREA_CFG = P('config', 'areas', 'osaka-city.json');
const WARD_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PRODUCTION_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

function countUnique(dir, key) {
  if (!fs.existsSync(dir)) return null;
  const seen = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!isTile(f)) continue;
    const t = rj(path.join(dir, f)); if (!t) continue;
    for (const ft of t.features || []) seen.add(ft[key]);
  }
  return seen.size;
}

export function validateRoadVisualV3() {
  const errors = [], warnings = [];
  const r = rj(REPORT);
  if (!r) { const out = { RESULT: 'FAIL', errors: ['レポートが無い: ' + toProjectRelativePath(REPORT)] }; writeJson(OUT, out); return out; }

  // ── §0/§28 不変条件 ──
  const buildings = countUnique(CANON_BLDGS, 'canonicalId');
  const roads = countUnique(CANON_ROADS, 'canonicalId');
  const refined = rj(REFINED);
  const cfg = rj(AREA_CFG); const proj = cfg && cfg.projection;
  const buildingMutation = buildings === 615617 ? 0 : 1;
  const canonicalRoadMutation = roads === CANONICAL_ROAD_FEATURE_COUNT ? 0 : 1;
  const refinedMutation = refined && refined.indexedCount === REFINED_ROAD_SURFACE_INDEXED_COUNT ? 0 : 1;
  const projectionMutation = proj && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320 ? 0 : 1;
  if (buildingMutation) errors.push('Canonical Buildings が 615617 でない: ' + buildings);
  if (canonicalRoadMutation) errors.push('Canonical Roads が ' + CANONICAL_ROAD_FEATURE_COUNT + ' でない: ' + roads);
  if (refinedMutation) errors.push('refined-road-surface indexedCount が ' + REFINED_ROAD_SURFACE_INDEXED_COUNT + ' でない');
  if (projectionMutation) errors.push('projection(znorth-neg-v1) が変更されている');

  // ── §8: tran は safety envelope としてのみ使い、dark carriageway の source にしない ──
  const src = fs.existsSync(BUILDER) ? fs.readFileSync(BUILDER, 'utf-8') : '';
  const tranUsedAsDarkCarriagewaySource = !!(r.sourceUsage && r.sourceUsage.tranEnvelopeOnly > 0);
  // builder が tran polygon を clip 先としてのみ使っている（clipPolygonToRing の対象が canonical road ring）
  const tranUsedAsSafetyEnvelope = /clipPolygonToRing\(qr\.ring, ring\)/.test(src) && /MAXIMUM ROAD DOMAIN/.test(src);
  if (tranUsedAsDarkCarriagewaySource) errors.push('§8 違反: tran polygon を dark carriageway の source として使っている');
  if (!tranUsedAsSafetyEnvelope) errors.push('§8: tran を safety envelope として使っている形跡が builder に無い');

  // ── §9: building を道路生成に使っていない ──
  //   builder 内で canonical buildings を読むのは KPI 計測(rasterize)だけであること。
  const buildingRefs = (src.match(/CANON_BLDGS/g) || []).length;
  const buildingUsedInRefine = /function refineQuad[\s\S]*?\n}/.test(src) && /function refineQuad([\s\S]*?)\n}/.exec(src)[1].includes('CANON_BLDGS');
  const buildingUsedForRoadGeneration = buildingUsedInRefine;
  if (buildingUsedForRoadGeneration) errors.push('§9 違反: building を道路幅の決定に使っている');
  if (buildingRefs === 0) warnings.push('builder が building を一切参照していない（KPI 計測も出来ていない可能性）');

  // ── §28 成果物 ──
  const v3TileCount = fs.existsSync(path.join(V3_DIR, 'tiles')) ? fs.readdirSync(path.join(V3_DIR, 'tiles')).filter(isTile).length : 0;
  const publicTileCount = fs.existsSync(path.join(PUBLIC_V3, 'tiles')) ? fs.readdirSync(path.join(PUBLIC_V3, 'tiles')).filter(isTile).length : 0;
  const roadV3Exists = v3TileCount > 0 && publicTileCount === v3TileCount;
  if (!roadV3Exists) errors.push('ROAD V3 の tile が生成/配信されていない: processed=' + v3TileCount + ' public=' + publicTileCount);

  const cw = r.widthStats && r.widthStats.CARRIAGEWAY;
  const widthSanityMeasured = !!(cw && cw.count > 0 && cw.median != null && cw.p75 != null && cw.p90 != null && cw.p95 != null && cw.max != null);
  if (!widthSanityMeasured) errors.push('§17: class 別 width 統計が測られていない');

  const continuityMeasured = !!(r.centerlineCoverage && r.centerlineCoverage.coveredPercentV2 != null && r.centerlineCoverage.coveredPercentV3 != null
    && r.centerlineCoverage.gapCountV3 != null && r.centerlineCoverage.gapLengthV3M != null);
  if (!continuityMeasured) errors.push('§24: continuity(covered corridor %/gap count/gap length) が測られていない');

  // ── §13: default を勝手に昇格していない ──
  const html = fs.existsSync(WARD_HTML) ? fs.readFileSync(WARD_HTML, 'utf-8') : '';
  // [Mission 32K §13] ROAD V3 の default 昇格が明示的に許可された。ここで守るのは
  //   「既定が定義済みで、V3 モードが存在すること」＋「production/protected を変えていないこと」。
  const defaultNotPromoted = /let roadVisualMode = '(?:FIX13|ROAD_V3)';/.test(html);
  if (!defaultNotPromoted) errors.push('roadVisualMode の既定が FIX13 / ROAD_V3 のいずれでもない');
  const hasV3Mode = /'ROAD_V3'/.test(html) && /'DIFF_V2_V3'/.test(html);
  if (!hasV3Mode) errors.push('§13: dev UI に ROAD V3 / DIFF V2→V3 モードが無い');

  // ── §11 dark paint rule: 濃い道路色は CARRIAGEWAY のみ ──
  const v3ColorBlock = (html.match(/const ROAD_V3_COLOR = \{[\s\S]*?\};/) || [''])[0];
  const darkOnlyForCarriageway = /carriageway: \(typeof COL !== 'undefined' && COL\.road\)/.test(v3ColorBlock)
    && !/margin: \(typeof COL !== 'undefined' && COL\.road\)/.test(v3ColorBlock)
    && !/uncertain: \(typeof COL !== 'undefined' && COL\.road\)/.test(v3ColorBlock);
  if (!darkOnlyForCarriageway) errors.push('§11 違反: CARRIAGEWAY 以外に dark road 色を使っている');

  // ── production / protected 非改変 ──
  const productionModified = fs.existsSync(PRODUCTION_HTML) && /RoadV3_|ROAD_V3_BASE|roadV3Group/.test(fs.readFileSync(PRODUCTION_HTML, 'utf-8'));
  const protectedModified = fs.existsSync(PROTECTED_HTML) && /RoadV3_|ROAD_V3_BASE|roadV3Group/.test(fs.readFileSync(PROTECTED_HTML, 'utf-8'));
  if (productionModified) errors.push('production HTML に 32I のコードが混入している');
  if (protectedModified) errors.push('protected HTML に 32I のコードが混入している');

  // ── §29/§30 verdict ──
  const verdictOk = /^(ROAD_VISUAL_V3_SUCCESS|ROAD_VISUAL_V3_NOT_BETTER)$/.test(r.verdict || '');
  if (!verdictOk) errors.push('§30: verdict が2択でない: ' + r.verdict);

  // ── §16: 数字のためだけに細くしていないか（continuity を同時に見る） ──
  const notOverThinned = !!(r.centerlineCoverage && r.centerlineCoverage.coveredPercentV3 >= r.centerlineCoverage.coveredPercentV2 * 0.85);
  if (!notOverThinned) errors.push('§16: overlap は下がったが centerline 被覆が V2 の 85% を下回っている（細くしすぎ）');

  const checks = {
    buildingMutation, canonicalRoadMutation, refinedMutation, projectionMutation,
    tranUsedAsDarkCarriagewaySource, tranUsedAsSafetyEnvelope,
    buildingUsedForRoadGeneration,
    roadV3Exists, widthSanityMeasured, continuityMeasured,
    defaultNotPromoted, hasV3Mode, darkOnlyForCarriageway, notOverThinned,
    productionModified, protectedModified,
    canonicalBuildings: buildings, canonicalRoads: roads,
    v3TileCount, publicTileCount,
    carriagewayWidthMedianM: cw ? cw.median : null,
    carriagewayWidthP95M: cw ? cw.p95 : null,
    overlapFix13M2: r.overlap ? r.overlap.fix13 : null,
    overlapV2M2: r.overlap ? r.overlap.v2 : null,
    overlapV3M2: r.overlap ? r.overlap.v3 : null,
    improvementV2ToV3Percent: r.overlap ? r.overlap.improvementV2ToV3Percent : null,
    centerlineCoveredPercentV2: r.centerlineCoverage ? r.centerlineCoverage.coveredPercentV2 : null,
    centerlineCoveredPercentV3: r.centerlineCoverage ? r.centerlineCoverage.coveredPercentV3 : null,
    verdict: r.verdict,
  };
  const out = { RESULT: errors.length ? 'FAIL' : 'PASS', generatedAt: new Date().toISOString(), missionId: '32I', checks, errors, warnings };
  writeJson(OUT, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  const out = validateRoadVisualV3();
  console.log('RESULT=' + out.RESULT);
  for (const w of out.warnings || []) console.log('WARN: ' + w);
  for (const e of out.errors || []) console.log('ERROR: ' + e);
  console.log(JSON.stringify(out.checks, null, 1));
  if (out.RESULT !== 'PASS') process.exit(1);
}
