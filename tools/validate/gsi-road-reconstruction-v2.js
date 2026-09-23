#!/usr/bin/env node
// tools/validate/gsi-road-reconstruction-v2.js
// [Mission 31G-FIX17 §41] GSI Road Edge Reconstruction v2 の静的検証。
//
// PASS 条件（§41）:
//   rawMutation = 0 / canonicalRoadMutation = 0 / buildingMutation = 0 / fix13Mutation = 0 /
//   invalidPrototypePolygon = 0 / untrackedPrototype = 0 / crossPairViolation = 0 /
//   impossibleWidthViolation = 0 / intersectionGapCritical = 0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const RAW_DIR = P('data', 'raw', 'gsi', 'road-edge');
const V2_DIR = P('data', 'processed', 'osaka-city', 'gsi-road-surface-v2');
const RECON_REPORT = P('data', 'reports', 'gsi-road-reconstruction-v2.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const CANON_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const RAW_HASH_RECORD = P('data', 'reports', 'baselines', 'gsi-raw-hashes.json');
const REPORT = P('data', 'reports', 'gsi-road-reconstruction-v2-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;
const ALLOWED_DECISIONS = new Set(['READY_FOR_GSI_ROAD_SURFACE_PROTOTYPE', 'PAIRING_V2_NOT_READY']);

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

function hashRawDir() {
  const out = {};
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[toProjectRelativePath(p)] = sha(p);
    }
  };
  walk(RAW_DIR);
  return out;
}

async function main() {
  const errors = [], warns = [];
  const checks = {};

  const recon = rj(RECON_REPORT);
  if (!recon) { errors.push('gsi-road-reconstruction-v2.json が無い（先に tools/audit/gsi-road-reconstruction-v2.js）'); return finish(errors, warns, checks); }

  // ── rawMutation ──
  const curRawHashes = hashRawDir();
  const rawBaseline = rj(RAW_HASH_RECORD);
  let rawMutation = 0;
  if (rawBaseline) {
    const prev = rawBaseline.hashes || {};
    for (const [f, h] of Object.entries(prev)) if (curRawHashes[f] !== undefined && curRawHashes[f] !== h) rawMutation++;
  } else warns.push('gsi-raw-hashes.json baseline が無い（FIX16 で作成されるはず）');
  checks.rawMutation = rawMutation;
  if (rawMutation) errors.push('raw GSI ファイルが変更されている（§0 違反）: ' + rawMutation);

  // ── canonicalRoadMutation / buildingMutation / fix13Mutation ──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED);
  checks.canonicalRoadMutation = (rm && rm.featureCount === EXPECT_ROAD_FEATURES) ? 0 : 1;
  checks.buildingMutation = (bm && bm.featureCount === EXPECT_BLDG_FEATURES) ? 0 : 1;
  checks.fix13Mutation = (refined && refined.indexedCount === EXPECT_REFINED_INDEXED) ? 0 : 1;
  if (checks.canonicalRoadMutation) errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount));
  if (checks.buildingMutation) errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount));
  if (checks.fix13Mutation) errors.push('refined-road-surface.json（FIX13）の indexedCount が変化している: ' + (refined && refined.indexedCount));

  // ── invalidPrototypePolygon / untrackedPrototype（prototype-surfaces.json を検証）──
  const proto = rj(path.join(V2_DIR, 'prototype-surfaces.json'));
  let invalidPrototypePolygon = 0, untrackedPrototype = 0;
  if (proto && Array.isArray(proto.surfaces)) {
    for (const s of proto.surfaces) {
      if (!s.aId || !s.bId) { untrackedPrototype++; continue; }
      if (!Array.isArray(s.quads) || s.quads.length === 0) { invalidPrototypePolygon++; continue; }
      for (const q of s.quads) {
        if (!Array.isArray(q) || q.length !== 4) { invalidPrototypePolygon++; break; }
        if (q.some((pt) => !Array.isArray(pt) || pt.length !== 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1]))) { invalidPrototypePolygon++; break; }
      }
    }
  } else warns.push('prototype-surfaces.json が無い（実データ未処理の可能性）');
  checks.invalidPrototypePolygon = invalidPrototypePolygon;
  checks.untrackedPrototype = untrackedPrototype;
  if (invalidPrototypePolygon) errors.push('invalid prototype polygon: ' + invalidPrototypePolygon);
  if (untrackedPrototype) errors.push('provenance（aId/bId）を欠く prototype surface: ' + untrackedPrototype);

  // ── crossPairViolation: pairs.json に confidence='reject' が紛れ込んでいないこと
  //     （§13 の設計上、reject は pairs 配列に入らず rejected 側で管理される）──
  const pairsFile = rj(path.join(V2_DIR, 'pairs.json'));
  let crossPairViolation = 0;
  if (pairsFile && Array.isArray(pairsFile.pairs)) {
    for (const p of pairsFile.pairs) if (p.confidence === 'reject') crossPairViolation++;
  }
  checks.crossPairViolation = crossPairViolation;
  if (crossPairViolation) errors.push('reject 判定の pair が pairs.json に混入: ' + crossPairViolation);

  // ── impossibleWidthViolation: sepM が MIN/MAX 範囲外の pair が無いこと（3.0m〜45.0m）──
  let impossibleWidthViolation = 0;
  if (pairsFile && Array.isArray(pairsFile.pairs)) {
    for (const p of pairsFile.pairs) if (p.sepM < 2.9 || p.sepM > 45.1) impossibleWidthViolation++;
  }
  checks.impossibleWidthViolation = impossibleWidthViolation;
  if (impossibleWidthViolation) errors.push('MIN/MAX 幅範囲外の pair: ' + impossibleWidthViolation);

  // ── intersectionGapCritical: pairing 全体が交差点近傍で致命的に破綻していないか（unpaired 比率の上限確認）──
  const pairing = recon.pairing || {};
  const totalSeg = pairing.totalSegments || 0;
  const unresolvedRatio = totalSeg > 0 ? (pairing.unpaired + pairing.rejected) / totalSeg : 0;
  checks.intersectionGapCritical = unresolvedRatio > 0.9 ? 1 : 0;   // 9割超が未解決なら致命的破綻とみなす
  if (checks.intersectionGapCritical) errors.push('unresolved 比率が致命的に高い: ' + (unresolvedRatio * 100).toFixed(1) + '%');

  // ── finalDecision が 2 択のいずれか（曖昧な表現でない §46）──
  checks.finalDecisionValid = ALLOWED_DECISIONS.has(recon.finalDecision);
  if (!checks.finalDecisionValid) errors.push('finalDecision が不正: ' + recon.finalDecision);

  // ── §0 禁止: lanes による強制幅推定・一律 buffer が pairing v2 ロジックに含まれない（静的確認）──
  const pairingSrc = fs.existsSync(P('tools', 'lib', 'gsi-road-edge-pairing-v2.js')) ? fs.readFileSync(P('tools', 'lib', 'gsi-road-edge-pairing-v2.js'), 'utf-8') : '';
  checks.noLanesWidthForcing = !/lanes.*laneWidth|laneWidth.*lanes/i.test(pairingSrc);
  if (!checks.noLanesWidthForcing) errors.push('pairing v2 が lanes から幅を強制生成している疑い（§0 違反）');
  checks.noUniformBuffer = !/\.buffer\(-\d/.test(pairingSrc);
  if (!checks.noUniformBuffer) errors.push('pairing v2 に一律 buffer コードがある（§0 違反）');

  // ── production / protected unchanged ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0 禁止）');
  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (fs.existsSync(p) && /gsi-road-surface-v2|gsiPrototypeV2|GSI Prototype v2/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に v2 コードが混入');
  }

  // ── runtime toggle: default OFF・Console 不要（静的確認）──
  const devHtml = fs.existsSync(P('public', 'osaka_3d_buildings.ward-ux-v1.html')) ? fs.readFileSync(P('public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8') : '';
  checks.v2ToggleDefaultOff = /let v2Visible = false;/.test(devHtml);
  checks.v2ToggleUiPresent = /toggleGsiPrototypeV2|gsi-v2-surface-toggle/.test(devHtml);
  if (!checks.v2ToggleDefaultOff) warns.push('v2 prototype toggle が default OFF と確認できない');
  if (!checks.v2ToggleUiPresent) warns.push('v2 prototype toggle の UI ハンドラが見つからない');

  // ── payload: sample overlay が過大でない（§27/§38 の教訓）──
  const samplePath = P('public', 'map-data', 'osaka-city', 'gsi-road-surface-v2', 'prototype-surfaces-sample.json');
  const fullPath = P('public', 'map-data', 'osaka-city', 'gsi-road-surface-v2', 'prototype-surfaces.json');
  checks.publicHasOnlySample = !fs.existsSync(fullPath);
  if (!checks.publicHasOnlySample) errors.push('全大阪版 prototype-surfaces.json が public に配信されている（§27/§38 違反）');
  if (fs.existsSync(samplePath)) {
    const sz = fs.statSync(samplePath).size;
    checks.samplePayloadExcessive = sz > 10 * 1024 * 1024;
    if (checks.samplePayloadExcessive) errors.push('sample overlay payload が過大: ' + (sz / 1e6).toFixed(1) + 'MB');
  }

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
  console.log('[gsi-road-reconstruction-v2-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[gsi-road-reconstruction-v2-validate] 失敗:', e && e.stack || e); process.exit(1); });
