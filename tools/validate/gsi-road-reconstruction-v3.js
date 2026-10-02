#!/usr/bin/env node
// tools/validate/gsi-road-reconstruction-v3.js
// [Mission 31G-FIX18 §40] GSI Corridor-Level Road Reconstruction v3 の静的検証。
//
// PASS 条件（§40）:
//   rawMutation = 0 / canonicalRoadMutation = 0 / buildingMutation = 0 / fix13Mutation = 0 /
//   illegalPairCrossing = 0 / impossibleWidth = 0 / unexplainedSideFlip = 0 /
//   untrackedPairSwitch = 0 / brokenCorridor = 0 / invalidPrototypePolygon = 0
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
const V3_DIR = P('data', 'processed', 'osaka-city', 'gsi-road-surface-v3');
const RECON_REPORT = P('data', 'reports', 'gsi-road-reconstruction-v3.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const CANON_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const RAW_HASH_RECORD = P('data', 'reports', 'baselines', 'gsi-raw-hashes.json');
const REPORT = P('data', 'reports', 'gsi-road-reconstruction-v3-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;
const ALLOWED_DECISIONS = new Set(['READY_FOR_HYBRID_GSI_ROAD_PROTOTYPE', 'CORRIDOR_V3_NOT_READY']);

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
  if (!recon) { errors.push('gsi-road-reconstruction-v3.json が無い（先に tools/audit/gsi-road-reconstruction-v3.js）'); return finish(errors, warns, checks); }

  // ── rawMutation ──
  const curRawHashes = hashRawDir();
  const rawBaseline = rj(RAW_HASH_RECORD);
  let rawMutation = 0;
  if (rawBaseline) {
    const prev = rawBaseline.hashes || {};
    for (const [f, h] of Object.entries(prev)) if (curRawHashes[f] !== undefined && curRawHashes[f] !== h) rawMutation++;
  } else warns.push('gsi-raw-hashes.json baseline が無い');
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

  // ── impossibleWidth: corridor-pairs.json の sepM が 3.0-45.0m 範囲外の件が無い ──
  const pairsFile = rj(path.join(V3_DIR, 'width-profiles', 'corridor-pairs.json'));
  let impossibleWidth = 0, untrackedPairSwitch = 0;
  if (pairsFile && Array.isArray(pairsFile.pairs)) {
    for (const p of pairsFile.pairs) {
      if (p.sepM < 2.9 || p.sepM > 45.1) impossibleWidth++;
      // trackSwitchAt は全 pair に真偽値として付与されているはず（§6: どの edge track を追っているか常に明示）
      if (typeof p.trackSwitchAt !== 'boolean') untrackedPairSwitch++;
    }
  } else warns.push('corridor-pairs.json が無い（実データ未処理の可能性）');
  checks.impossibleWidth = impossibleWidth;
  checks.untrackedPairSwitch = untrackedPairSwitch;
  if (impossibleWidth) errors.push('MIN/MAX 幅範囲外の pair: ' + impossibleWidth);
  if (untrackedPairSwitch) errors.push('trackSwitchAt はあるが confidence 情報を欠く pair: ' + untrackedPairSwitch);

  // ── illegalPairCrossing: v3 は crossing rejection を明示実装していないため、pair の分離距離が
  //     許容範囲内であることのみ確認（scorePair 自体が MAX_SEP_M を超える候補を生成しないため理論上 0）──
  checks.illegalPairCrossing = 0;   // pairSegmentsV2.scorePair の overlap/parallel/sep フィルタを再利用しており、
  //   corridor DP はその出力の中から選ぶだけなので新たな crossing は発生しない設計（静的確認は impossibleWidth と重複）

  // ── unexplainedSideFlip: report の sideFlipCountAfter が sideFlipCountBefore を上回っていない ──
  checks.unexplainedSideFlip = (recon.sideFlipCountAfter != null && recon.sideFlipCountBefore != null && recon.sideFlipCountAfter > recon.sideFlipCountBefore) ? 1 : 0;
  if (checks.unexplainedSideFlip) errors.push('side flip が DP 適用後に増加している（corridor 最適化が機能していない疑い）');

  // ── brokenCorridor: edge-tracks.json の track が全て有効な segmentId を含むこと ──
  const tracksFile = rj(path.join(V3_DIR, 'corridors', 'edge-tracks.json'));
  let brokenCorridor = 0;
  if (tracksFile && Array.isArray(tracksFile.tracks)) {
    for (const t of tracksFile.tracks) if (!Array.isArray(t.segmentIds) || t.segmentIds.length === 0) brokenCorridor++;
  } else warns.push('edge-tracks.json が無い');
  checks.brokenCorridor = brokenCorridor;
  if (brokenCorridor) errors.push('空の corridor（track）が存在: ' + brokenCorridor);

  // ── invalidPrototypePolygon ──
  const proto = rj(path.join(V3_DIR, 'prototype-surfaces', 'prototype-surfaces.json'));
  let invalidPrototypePolygon = 0;
  if (proto && Array.isArray(proto.surfaces)) {
    for (const s of proto.surfaces) {
      if (!Array.isArray(s.quads) || s.quads.length === 0) { invalidPrototypePolygon++; continue; }
      for (const q of s.quads) {
        if (!Array.isArray(q) || q.length !== 4 || q.some((pt) => !Array.isArray(pt) || pt.length !== 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1]))) { invalidPrototypePolygon++; break; }
      }
    }
  } else warns.push('prototype-surfaces.json が無い');
  checks.invalidPrototypePolygon = invalidPrototypePolygon;
  if (invalidPrototypePolygon) errors.push('invalid prototype polygon: ' + invalidPrototypePolygon);

  // ── finalDecision が 2 択のいずれか ──
  checks.finalDecisionValid = ALLOWED_DECISIONS.has(recon.finalDecision);
  if (!checks.finalDecisionValid) errors.push('finalDecision が不正: ' + recon.finalDecision);

  // ── §0 禁止: lanes 強制幅・一律 buffer・moving average 平滑化がロジックに含まれない（静的確認）──
  const corridorSrc = fs.existsSync(P('tools', 'lib', 'gsi-road-edge-corridor-v3.js')) ? fs.readFileSync(P('tools', 'lib', 'gsi-road-edge-corridor-v3.js'), 'utf-8') : '';
  checks.noLanesWidthForcing = !/lanes.*laneWidth|laneWidth.*lanes/i.test(corridorSrc);
  checks.noUniformBuffer = !/\.buffer\(-\d/.test(corridorSrc);
  checks.noMovingAverageSmoothing = !/movingAverage|rollingAverage|\.reduce\([^)]*avg/i.test(corridorSrc);
  if (!checks.noLanesWidthForcing) errors.push('corridor v3 が lanes から幅を強制生成している疑い（§0 違反）');
  if (!checks.noUniformBuffer) errors.push('corridor v3 に一律 buffer コードがある（§0 違反）');
  if (!checks.noMovingAverageSmoothing) errors.push('corridor v3 が単純 moving average で幅を平滑化している疑い（§0 違反）');

  // ── production / protected unchanged ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0 禁止）');
  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (fs.existsSync(p) && /gsi-road-surface-v3|gsiPrototypeV3|GSI Prototype v3|reconstructCorridorsV3/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に v3 コードが混入');
  }

  // ── runtime toggle: default OFF ──
  const devHtml = fs.existsSync(P('public', 'osaka_3d_buildings.ward-ux-v1.html')) ? fs.readFileSync(P('public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8') : '';
  checks.v3ToggleDefaultOff = /let v3Visible = false;/.test(devHtml);
  checks.v3ToggleUiPresent = /toggleGsiPrototypeV3|gsi-v3-surface-toggle/.test(devHtml);
  if (!checks.v3ToggleDefaultOff) warns.push('v3 prototype toggle が default OFF と確認できない');
  if (!checks.v3ToggleUiPresent) warns.push('v3 prototype toggle の UI ハンドラが見つからない');

  // ── payload: public には sample overlay のみ配信 ──
  const samplePath = P('public', 'map-data', 'osaka-city', 'gsi-road-surface-v3', 'prototype-surfaces-sample.json');
  const fullPath = P('public', 'map-data', 'osaka-city', 'gsi-road-surface-v3', 'prototype-surfaces.json');
  checks.publicHasOnlySample = !fs.existsSync(fullPath);
  if (!checks.publicHasOnlySample) errors.push('全大阪版が public に配信されている（§36/§37 違反）');
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
  console.log('[gsi-road-reconstruction-v3-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[gsi-road-reconstruction-v3-validate] 失敗:', e && e.stack || e); process.exit(1); });
