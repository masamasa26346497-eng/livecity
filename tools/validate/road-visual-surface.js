#!/usr/bin/env node
// tools/validate/road-visual-surface.js
// [Mission 31G-FIX12 §20] Road Visual Surface（描画する道路面）の正規化を静的検証する。
//
// PASS 条件:
//   - source geometry mutation 0     : canonical roads の featureCount / manifest が不変
//   - invalid visual polygon 0        : renderClass index の各エントリが正しい rs / conf を持つ
//   - unknown rendered-as-full-road 0 : UNKNOWN / ROAD_RESERVE が primary（濃い不透明道路面）に分類されていない
//   - road visual provenance 100%     : index の全エントリが既知 renderClass・既知 rs
//   - building geometry mutation 0     : canonical buildings の featureCount が不変
//   - projection unchanged            : znorth-neg-v1 / origin が runtime で再定義されていない
//   - production / protected unchanged : hash baseline 一致・canonical runtime 混入なし
//   - runtime applied                 : ward-ux-v1.html が road-render-class.json を fetch し renderClass 別 style で描く
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
const RENDER_CLASS = P('data', 'processed', 'osaka-city', 'derived', 'road-render-class.json');
const RENDER_CLASS_PUB = P('public', 'map-data', 'osaka-city', 'derived', 'road-render-class.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const CANON_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const AUDIT = P('data', 'reports', 'road-visual-surface-audit.json');
const OVERLAP = P('data', 'reports', 'building-road-visual-overlap.json');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const REPORT = P('data', 'reports', 'road-visual-surface-validation.json');

// canonical roads の想定 featureCount（FIX11 で確定した source truth）。source geometry 不変の指標。
const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;

const VALID_RS = new Set(['primary', 'bridge', 'secondary', 'pedestrian', 'faint']);
const VALID_CLASS = new Set(['ROADWAY', 'INTERSECTION', 'RAMP', 'BRIDGE', 'PEDESTRIAN', 'ALLEY', 'MEDIAN', 'SIDEWALK', 'ROAD_RESERVE', 'UNKNOWN']);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};

  // ── renderClass index ──
  const rc = rj(RENDER_CLASS);
  if (!rc) { errors.push('road-render-class.json が無い（先に tools/build-road-render-class.js）'); return finish(errors, warns, checks); }
  const cm = rc.classMap || {};
  const entries = Object.entries(cm);

  let invalidVisualPolygon = 0;
  let unknownAsFullRoad = 0;
  let provenanceMissing = 0;
  for (const [id, v] of entries) {
    if (!v || typeof v !== 'object') { invalidVisualPolygon++; continue; }
    if (!VALID_RS.has(v.rs)) invalidVisualPolygon++;
    if (!VALID_CLASS.has(v.c)) provenanceMissing++;
    if (typeof v.conf !== 'number' || v.conf < 0 || v.conf > 1) invalidVisualPolygon++;
    // §5: UNKNOWN / ROAD_RESERVE / MEDIAN / SIDEWALK は「濃い不透明道路面」に載せない
    if ((v.c === 'UNKNOWN' || v.c === 'ROAD_RESERVE' || v.c === 'MEDIAN' || v.c === 'SIDEWALK') && (v.rs === 'primary' || v.rs === 'bridge')) unknownAsFullRoad++;
    // index は primary を載せない（runtime 既定）
    if (v.rs === 'primary') unknownAsFullRoad++;
  }
  checks.invalidVisualPolygon = invalidVisualPolygon;
  checks.unknownRenderedAsFullRoad = unknownAsFullRoad;
  checks.roadVisualProvenancePct = entries.length ? +(100 * (1 - provenanceMissing / entries.length)).toFixed(2) : 100;
  if (invalidVisualPolygon) errors.push('invalid visual polygon: ' + invalidVisualPolygon);
  if (unknownAsFullRoad) errors.push('UNKNOWN/RESERVE が濃い道路面に分類: ' + unknownAsFullRoad);
  if (checks.roadVisualProvenancePct < 100) errors.push('road visual provenance ' + checks.roadVisualProvenancePct + '% (<100)');

  // ── source geometry mutation 0（canonical roads / buildings の manifest 不変）──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST);
  checks.canonicalRoadFeatureCount = rm ? rm.featureCount : null;
  checks.canonicalBuildingFeatureCount = bm ? bm.featureCount : null;
  checks.sourceGeometryMutation = (rm && rm.featureCount === EXPECT_ROAD_FEATURES) ? 0 : 1;
  checks.buildingGeometryMutation = (bm && bm.featureCount === EXPECT_BLDG_FEATURES) ? 0 : 1;
  if (checks.sourceGeometryMutation) errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount));
  if (checks.buildingGeometryMutation) errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount));

  const audit = rj(AUDIT);
  checks.auditSourceGeometryMutated = audit ? !!audit.sourceGeometryMutated : null;
  checks.auditBuildingGeometryMutated = audit ? !!audit.buildingGeometryMutated : null;
  if (audit && (audit.sourceGeometryMutated || audit.buildingGeometryMutated)) errors.push('audit が geometry mutation を報告');
  if (audit) {
    checks.canonicalRoadAreaKm2 = +(audit.canonicalRoadAreaM2 / 1e6).toFixed(2);
    checks.visualRoadAreaKm2 = +(audit.visualRoadAreaM2 / 1e6).toFixed(2);
    checks.areaReductionRatio = audit.reductionRatio;
  }
  const ov = rj(OVERLAP);
  if (ov) {
    checks.buildingOnCanonicalRoadKm2 = +(ov.buildingOnCanonicalRoadAreaM2 / 1e6).toFixed(2);
    checks.buildingOnVisualRoadKm2 = +(ov.buildingOnVisualRoadAreaM2 / 1e6).toFixed(2);
    checks.overlapReductionRatio = ov.overlapReductionRatio;
    if (ov.buildingOnVisualRoadAreaM2 > ov.buildingOnCanonicalRoadAreaM2) errors.push('visual road の重なりが canonical より増えている（逆行）');
  } else warns.push('building-road-visual-overlap.json が無い（§8 監査未実行）');

  // ── runtime applied（ward-ux-v1.html）──
  const html = fs.existsSync(DEV) ? fs.readFileSync(DEV, 'utf-8') : '';
  checks.runtimeFetchesRenderClass = /fetch\(BASE \+ '\/road-render-class\.json'\)/.test(html);
  checks.runtimeBucketsByRenderClass = /const buckets = \{ primary: \[\], bridge: \[\], secondary: \[\], pedestrian: \[\], sidewalk: \[\], median: \[\], faint: \[\] \};/.test(html)
    && /roadRenderClass\.get\(f\.canonicalId\)/.test(html);
  checks.runtimePrimaryOpaque = /primary:\s*\{ col: COL\.road, y: Y\.road,\s+opacity: 1\.0,\s+transparent: false/.test(html);
  checks.runtimeFaintTransparent = /faint:\s*\{ col: [\s\S]{0,160}opacity: 0\.30, transparent: true/.test(html);
  checks.runtimeFallbackPrimary = /let rs = roadRenderClass\.get\(f\.canonicalId\) \|\| 'primary';/.test(html);
  if (!checks.runtimeFetchesRenderClass) errors.push('runtime が road-render-class.json を fetch していない');
  if (!checks.runtimeBucketsByRenderClass) errors.push('runtime roads branch が renderClass で bucket していない');
  if (!checks.runtimePrimaryOpaque) errors.push('primary 道路面が不透明でない（§4/§11）');
  if (!checks.runtimeFaintTransparent) errors.push('faint 道路面が透明化されていない（§5/§11）');

  // ── projection unchanged ──
  const crBlock = (html.match(/const CanonicalRuntime = \(function[\s\S]*?\}\)\(\);\n\nwindow\.__SET_CANONICAL_RUNTIME__/) || [''])[0];
  checks.projectionUnchanged = !/135\.52502|34\.604208|centerLon|centerLat|metersPerDegree|111320|function geoToThree/.test(crBlock);
  if (!checks.projectionUnchanged) errors.push('CanonicalRuntime ブロックに projection 定数の再定義（§0 禁止）');
  // roads branch で source geometry を書き換えていない
  {
    const s = html.indexOf("} else if (layer === 'roads') {");
    const b = s >= 0 ? html.slice(s, s + 1800) : '';
    checks.roadsBranchNoGeometryWrite = s >= 0 && !/\.coordinates\s*=|\.geometryType\s*=|f\.coordinates\.(push|splice|pop|shift)/.test(b);
    if (!checks.roadsBranchNoGeometryWrite) errors.push('roads branch が source geometry を書き換えている（§0/§18）');
  }

  // ── production / protected unchanged ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionUnchanged = !(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedUnchanged = !(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (!checks.productionUnchanged) errors.push('production HTML が変更されている（§0 禁止）');
  if (!checks.protectedUnchanged) errors.push('protected HTML が変更されている（§0 禁止）');
  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (fs.existsSync(p) && /road-render-class|roadRenderClass|CR_ROAD_RS/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に road visual surface コードが混入');
  }

  // ── public 配信 ──
  checks.publishedToPublic = fs.existsSync(RENDER_CLASS_PUB);
  if (!checks.publishedToPublic) warns.push('public/map-data/.../road-render-class.json が無い（build-derived-public.js 未実行）');
  else {
    const pub = rj(RENDER_CLASS_PUB);
    if (pub && pub.indexedCount !== rc.indexedCount) warns.push('public の road-render-class.json が古い（indexedCount 不一致）');
  }

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
  console.log('[road-visual-surface-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[road-visual-surface-validate] 失敗:', e && e.stack || e); process.exit(1); });
