#!/usr/bin/env node
// tools/validate/refined-road-visual-surface.js
// [Mission 31G-FIX13 §22] 実車道面（Road Visual Surface 精密化）の静的検証。
//
// PASS 条件:
//   - building geometry mutation 0
//   - canonical road mutation 0
//   - invalid carriageway polygon 0（renderClass 不正 / rs 不明）
//   - source provenance 100%（widthSourceCounts の合計が feature 数と一致）
//   - negative buffer hack 0（一律 buffer / clip コードが無い）
//   - untracked width source 0（bySource の値が既知 source のみ）
//   - intersection topology break 0（INTERSECTION 件数が canonical road-render-class と一致 = 交差点を欠落させていない）
//   - projection unchanged
//   - production / protected unchanged
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const DEV = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const REFINED_PUB = P('public', 'map-data', 'osaka-city', 'derived', 'refined-road-surface.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const CANON_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const REPORT21 = P('data', 'reports', 'refined-road-visual-surface.json');
const OVERLAP = P('data', 'reports', 'refined-carriageway-overlap.json');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const REPORT = P('data', 'reports', 'refined-road-visual-surface-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const KNOWN_RS = new Set(['bridge', 'pedestrian', 'sidewalk', 'median', 'faint', 'primary']);
const KNOWN_WIDTH_SOURCE = new Set(['osm-width', 'osm-lanes', 'osm-lanes-arterial-advisory', 'plateau-polygon+centerline', 'class-default', 'plateau-polygon']);

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};

  const rc = rj(REFINED);
  if (!rc) { errors.push('refined-road-surface.json が無い（先に tools/build-refined-road-surface.js）'); return finish(errors, warns, checks); }
  const pfx = rc.keyPrefix || '';
  const codes = rc.rsCodes || {};
  const entries = Object.entries(rc.classMap || {});

  // ── invalid carriageway polygon（rs 不明 / code 不明）──
  let invalidCount = 0;
  for (const [, code] of entries) { const rs = codes[code]; if (!rs || !KNOWN_RS.has(rs)) invalidCount++; }
  checks.invalidCarriagewayPolygon = invalidCount;
  if (invalidCount) errors.push('invalid carriageway polygon（rs 不明）: ' + invalidCount);

  // ── source provenance 100%（widthSourceCounts が既知 source のみ・合計 = feature 数）──
  const ws = rc.widthSourceCounts || {};
  let unknownSource = 0, wsTotal = 0;
  for (const [src, n] of Object.entries(ws)) { wsTotal += n; if (!KNOWN_WIDTH_SOURCE.has(src)) unknownSource += n; }
  checks.untrackedWidthSource = unknownSource;
  checks.sourceProvenancePct = wsTotal ? +(100 * (1 - unknownSource / wsTotal)).toFixed(2) : 100;
  if (unknownSource) errors.push('untracked width source: ' + unknownSource);
  if (checks.sourceProvenancePct < 100) errors.push('source provenance ' + checks.sourceProvenancePct + '% (<100)');

  // ── canonical road / building mutation 0 ──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST);
  checks.canonicalRoadMutation = (rm && rm.featureCount === EXPECT_ROAD_FEATURES) ? 0 : 1;
  checks.buildingGeometryMutation = (bm && bm.featureCount === EXPECT_BLDG_FEATURES) ? 0 : 1;
  if (checks.canonicalRoadMutation) errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount));
  if (checks.buildingGeometryMutation) errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount));

  const report21 = rj(REPORT21);
  checks.report21SourceGeometryMutated = report21 ? !!report21.sourceGeometryMutated : null;
  checks.report21BuildingGeometryMutated = report21 ? !!report21.buildingGeometryMutated : null;
  checks.report21NegativeBufferHack = report21 ? !!report21.negativeBufferHack : null;
  if (report21 && (report21.sourceGeometryMutated || report21.buildingGeometryMutated)) errors.push('§21 report が geometry mutation を報告');
  if (report21 && report21.negativeBufferHack) errors.push('§21 report が negativeBufferHack を報告（§0 違反）');

  // ── negative buffer hack 0（一律 buffer / offset コードが build script に無い）──
  const buildSrc = fs.existsSync(P('tools', 'build-refined-road-surface.js')) ? fs.readFileSync(P('tools', 'build-refined-road-surface.js'), 'utf-8') : '';
  const hasUniformBuffer = /buffer\(\s*-\d|offsetPolygon|shrinkBy|\.buffer\(-/.test(buildSrc);
  checks.negativeBufferHackInBuild = hasUniformBuffer ? 1 : 0;
  if (hasUniformBuffer) errors.push('build script に一律 negative buffer/offset コードがある（§0 違反）');

  // ── lanes は幾何 clamp に使っていない（advisory のみ）──
  checks.lanesUsedForGeometry = /wEst < effW|clampWidth|shrinkToLanes/.test(buildSrc) ? 1 : 0;
  if (checks.lanesUsedForGeometry) errors.push('lanes が幾何 clamp に使われている疑い（§0/§4 違反）');

  // ── intersection topology break 0（INTERSECTION 件数が FIX12 road-render-class の byClass と一致）──
  const fix12 = rj(P('data', 'processed', 'osaka-city', 'derived', 'road-render-class.json'));
  const intersectionsRefined = (rc.byClass && rc.byClass.INTERSECTION) || 0;
  const intersectionsFix12 = (fix12 && fix12.byClass && fix12.byClass.INTERSECTION) || 0;
  checks.intersectionTopologyBreak = (intersectionsFix12 > 0 && intersectionsRefined !== intersectionsFix12) ? 1 : 0;
  if (checks.intersectionTopologyBreak) errors.push('INTERSECTION 件数が FIX12 と不一致（交差点欠落の疑い）: ' + intersectionsRefined + ' vs ' + intersectionsFix12);

  // ── overlap 監査（§14 の 3 種比較。降順であるべき: canonical >= fix12 >= fix13）──
  const ov = rj(OVERLAP);
  if (ov) {
    checks.buildingOnCanonicalRoadKm2 = +(ov.buildingOnCanonicalRoadAreaM2 / 1e6).toFixed(2);
    checks.buildingOnFix12VisualRoadKm2 = +(ov.buildingOnFix12VisualRoadAreaM2 / 1e6).toFixed(2);
    checks.buildingOnRefinedCarriagewayKm2 = +(ov.buildingOnRefinedCarriagewayAreaM2 / 1e6).toFixed(2);
    if (ov.buildingOnRefinedCarriagewayAreaM2 > ov.buildingOnFix12VisualRoadAreaM2) errors.push('FIX13 の重なりが FIX12 より増えている（逆行）');
    if (ov.buildingOnFix12VisualRoadAreaM2 > ov.buildingOnCanonicalRoadAreaM2) errors.push('FIX12 の重なりが canonical より増えている（矛盾）');
  } else warns.push('refined-carriageway-overlap.json が無い（§14 監査未実行）');

  // ── runtime applied ──
  const html = fs.existsSync(DEV) ? fs.readFileSync(DEV, 'utf-8') : '';
  checks.runtimeFetchesRefined = /fetch\(BASE \+ '\/refined-road-surface\.json'\)/.test(html);
  checks.runtimeFallsBackToFix12 = /fetch\(BASE \+ '\/road-render-class\.json'\)/.test(html);
  checks.runtimeHasSidewalkMedianStyle = /sidewalk:\s*\{ col: /.test(html) && /median:\s*\{ col: /.test(html);
  checks.runtimePrimaryOpaque = /primary:\s*\{ col: COL\.road, y: Y\.road,\s+opacity: 1\.0,\s+transparent: false/.test(html);
  if (!checks.runtimeFetchesRefined) errors.push('runtime が refined-road-surface.json を fetch していない');
  if (!checks.runtimeFallsBackToFix12) errors.push('runtime が road-render-class.json への fallback を持たない');
  if (!checks.runtimeHasSidewalkMedianStyle) errors.push('runtime に sidewalk/median style が無い（FIX13 §9/§10）');
  if (!checks.runtimePrimaryOpaque) errors.push('primary 車道面が不透明でない（§0: 見た目だけで縮めない）');

  // ── projection unchanged ──
  const crBlock = (html.match(/const CanonicalRuntime = \(function[\s\S]*?\}\)\(\);\n\nwindow\.__SET_CANONICAL_RUNTIME__/) || [''])[0];
  checks.projectionUnchanged = !/135\.52502|34\.604208|centerLon|centerLat|metersPerDegree|111320|function geoToThree/.test(crBlock);
  if (!checks.projectionUnchanged) errors.push('CanonicalRuntime ブロックに projection 定数の再定義（§0 禁止）');
  {
    const s = html.indexOf("} else if (layer === 'roads') {");
    const b = s >= 0 ? html.slice(s, s + 1800) : '';
    checks.roadsBranchNoGeometryWrite = s >= 0 && !/\.coordinates\s*=|\.geometryType\s*=|f\.coordinates\.(push|splice|pop|shift)/.test(b);
    if (!checks.roadsBranchNoGeometryWrite) errors.push('roads branch が source geometry を書き換えている（§0/§15）');
  }

  // ── production / protected unchanged ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionUnchanged = !(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedUnchanged = !(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (!checks.productionUnchanged) errors.push('production HTML が変更されている（§0 禁止）');
  if (!checks.protectedUnchanged) errors.push('protected HTML が変更されている（§0 禁止）');
  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (fs.existsSync(p) && /refined-road-surface|CARRIAGEWAY|carriagewayRibbons/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に refined road surface コードが混入');
  }

  checks.publishedToPublic = fs.existsSync(REFINED_PUB);
  if (!checks.publishedToPublic) warns.push('public/map-data/.../refined-road-surface.json が無い（build-derived-public.js 未実行）');

  checks.indexedCount = rc.indexedCount;
  return finish(errors, warns, checks);
}

async function finish(errors, warns, checks) {
  const report = {
    generatedAt: new Date().toISOString(),
    checks,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[refined-road-visual-surface-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[refined-road-visual-surface-validate] 失敗:', e && e.stack || e); process.exit(1); });
