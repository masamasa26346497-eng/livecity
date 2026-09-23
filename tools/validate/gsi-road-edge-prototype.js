#!/usr/bin/env node
// tools/validate/gsi-road-edge-prototype.js
// [Mission 31G-FIX15/FIX16 §29] GSI Road Edge Import & Validation Prototype の静的検証。
//
// PASS 条件（§29・FIX16 で fix13Mutation/untrackedGsiFeature を追加）:
//   rawMutation = 0 / canonicalRoadMutation = 0 / buildingMutation = 0 / fix13Mutation = 0 /
//   crsMismatch = 0 / untrackedGsiFeature = 0 / fakeMeasurement = 0 /
//   productionModified = false / protectedModified = false
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
const GSI_LINES = P('data', 'processed', 'osaka-city', 'gsi-road-edge', 'road-edge-lines.json');
const GSI_MANIFEST = P('data', 'processed', 'osaka-city', 'gsi-road-edge', 'manifest.json');
const PROTOTYPE_REPORT = P('data', 'reports', 'gsi-road-edge-prototype.json');
const COMPARISON_REPORT = P('data', 'reports', 'gsi-vs-fix13-road-comparison.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const CANON_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const RAW_HASH_RECORD = P('data', 'reports', 'baselines', 'gsi-raw-hashes.json');
const REPORT = P('data', 'reports', 'gsi-road-edge-prototype-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

function hashRawDir() {
  const out = {};
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[toProjectRelativePath(p)] = sha(p);
    }
  };
  walk(RAW_DIR);
  return out;
}

async function main() {
  const errors = [], warns = [];
  const checks = {};

  // ── rawMutation: raw ファイルが import 前後で変化していない（README.md は raw の一部だが
  //     importer が書き込むことはないので同列に扱う。hash baseline が無ければ今回分を新規記録）──
  const curRawHashes = hashRawDir();
  let rawBaseline = rj(RAW_HASH_RECORD);
  let rawMutation = 0;
  if (!rawBaseline) {
    fs.mkdirSync(path.dirname(RAW_HASH_RECORD), { recursive: true });
    fs.writeFileSync(RAW_HASH_RECORD, JSON.stringify({ recordedAt: new Date().toISOString(), hashes: curRawHashes }, null, 2));
    warns.push('gsi-raw-hashes.json baseline を新規記録した（次回から差分検出）');
  } else {
    const prev = rawBaseline.hashes || {};
    for (const [f, h] of Object.entries(prev)) if (curRawHashes[f] !== undefined && curRawHashes[f] !== h) rawMutation++;
    // [FIX16] 既知ファイルの改変が無ければ、新規ファイル（ユーザーが追加した raw data 等）の hash を
    //   baseline へ追記する（次回以降の差分検出対象に含める。既存 hash は書き換えない）。
    if (rawMutation === 0) {
      const merged = { ...prev, ...curRawHashes };
      if (Object.keys(merged).length !== Object.keys(prev).length) {
        fs.writeFileSync(RAW_HASH_RECORD, JSON.stringify({ recordedAt: new Date().toISOString(), hashes: merged }, null, 2));
        warns.push('gsi-raw-hashes.json baseline に新規ファイルの hash を追記した（' + (Object.keys(merged).length - Object.keys(prev).length) + ' 件）');
      }
    }
  }
  checks.rawMutation = rawMutation;
  if (rawMutation) errors.push('raw GSI ファイルが変更されている（§1/§8 違反）: ' + rawMutation + ' 件');

  // ── canonicalRoadMutation / buildingMutation / fix13Mutation（§29: 3 つとも 0 が PASS 条件） ──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED);
  checks.canonicalRoadMutation = (rm && rm.featureCount === EXPECT_ROAD_FEATURES) ? 0 : 1;
  checks.buildingMutation = (bm && bm.featureCount === EXPECT_BLDG_FEATURES) ? 0 : 1;
  checks.fix13Mutation = (refined && refined.indexedCount === EXPECT_REFINED_INDEXED) ? 0 : 1;
  if (checks.canonicalRoadMutation) errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount));
  if (checks.buildingMutation) errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount));
  if (checks.fix13Mutation) errors.push('refined-road-surface.json（FIX13）の indexedCount が変化している: ' + (refined && refined.indexedCount));

  // ── crsMismatch: GSI import コードが非対応 CRS を強制変換していないこと（§4 静的確認）──
  const transformSrc = fs.existsSync(P('tools', 'lib', 'gsi-road-edge-transform.js')) ? fs.readFileSync(P('tools', 'lib', 'gsi-road-edge-transform.js'), 'utf-8') : '';
  const forcesZone67 = /jprectZone\s*:\s*[67]|第[67]系|force.*(zone|crs)/i.test(transformSrc) && !/非対応|強制変換しない/.test(transformSrc);
  checks.crsMismatch = forcesZone67 ? 1 : 0;
  if (forcesZone67) errors.push('gsi-road-edge-transform.js が第6/7系への強制変換を含む疑い（§4 違反）');
  const manifest = rj(GSI_MANIFEST);
  if (manifest && manifest.crsUnsupportedCount > 0 && manifest.featureCountNormalized > manifest.featureCountRaw - manifest.crsUnsupportedCount) {
    checks.crsMismatch = 1; errors.push('crsUnsupported な feature が normalize 結果に含まれている疑い');
  }

  // ── untrackedGsiFeature: normalized line が provenance 必須フィールドを持つ ──
  let untrackedGsiFeature = 0;
  const lines = rj(GSI_LINES);
  if (lines && Array.isArray(lines.features)) {
    for (const f of lines.features) {
      if (!f.id || !f.sourceDataset || !f.provenance || !f.provenance.sourceFile) untrackedGsiFeature++;
    }
  }
  checks.untrackedGsiFeature = untrackedGsiFeature;
  if (untrackedGsiFeature) errors.push('provenance 必須フィールドを欠く normalized feature: ' + untrackedGsiFeature);

  // ── fakeMeasurement ──
  //   [FIX15] raw data 無しのとき: 比較結果が全てゼロ/null であること（捏造の疑い検出）。
  //   [FIX16] raw data 有りのとき: 逆に「実測値が明らかに非現実的」でないこと（範囲外の値は捏造/バグの疑い）
  //   + adoption decision が §25 の 4 択のいずれかであること（曖昧な表現の禁止）。
  const proto = rj(PROTOTYPE_REPORT);
  const cmp = rj(COMPARISON_REPORT);
  let fakeMeasurement = 0;
  if (proto && proto.rawDataPresent === false) {
    if (proto.osakaFeatureCount) fakeMeasurement++;
    if (proto.pairing && (proto.pairing.high || proto.pairing.medium || proto.pairing.low)) fakeMeasurement++;
    if (proto.samplePolygonCount) fakeMeasurement++;
    if (proto.majorRoadWidths) {
      for (const v of Object.values(proto.majorRoadWidths)) if (v && v.gsiWidthM != null) fakeMeasurement++;
    }
    if (typeof proto.fix13Comparison === 'string' && /^GSI_(NARROWER|WIDER|SIMILAR)/.test(proto.fix13Comparison)) fakeMeasurement++;
    if (proto.adoptionRecommendation && /ADOPTED|GSI_NOT_BETTER/.test(proto.adoptionRecommendation.decision || '')) fakeMeasurement++;
  } else if (cmp && cmp.RESULT === 'GSI_VS_FIX13_COMPARED') {
    const ALLOWED_DECISIONS = new Set(['ADOPT_FOR_PROTOTYPE_INTEGRATION', 'KEEP_FIX13', 'INSUFFICIENT_DATA', 'GSI_INVALID_FOR_CARRIAGEWAY']);
    if (!ALLOWED_DECISIONS.has(cmp.decision)) fakeMeasurement++;
    const ALLOWED_FIX13_CMP = new Set(['GSI_NARROWER', 'GSI_WIDER', 'SIMILAR', 'GEOMETRY_DISAGREEMENT', 'INSUFFICIENT_DATA']);
    for (const v of Object.values(cmp.fix13Comparison || {})) if (!ALLOWED_FIX13_CMP.has(v)) fakeMeasurement++;
    for (const [label, m] of Object.entries(cmp.majorRoadWidths || {})) {
      if (m.sampleCount > 0 && (m.gsiWidthM == null || m.gsiWidthM <= 0 || m.gsiWidthM > 100)) { fakeMeasurement++; errors.push('非現実的な gsiWidthM: ' + label + '=' + m.gsiWidthM); }
    }
    if (cmp.pairing) {
      const { high, medium, low, unpaired } = cmp.pairing;
      if ([high, medium, low, unpaired].some((n) => typeof n !== 'number' || n < 0)) fakeMeasurement++;
    }
    if (cmp.coverageByWard && Object.keys(cmp.coverageByWard).length === 0 && cmp.decision !== 'INSUFFICIENT_DATA' && cmp.decision !== 'GSI_INVALID_FOR_CARRIAGEWAY') fakeMeasurement++;
  }
  checks.fakeMeasurement = fakeMeasurement;
  if (fakeMeasurement) errors.push('測定結果に捏造/非現実的な値の疑い: ' + fakeMeasurement + ' 件');
  checks.reportStatusHonest = !!(proto && (proto.STATUS || proto.RESULT));
  if (!checks.reportStatusHonest) warns.push('gsi-road-edge-prototype.json に STATUS/RESULT が無い');

  // ── production / protected unchanged ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0 禁止）');
  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (fs.existsSync(p) && /gsi-road-edge|GSI Road Edge|RdEdg/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に GSI road edge コードが混入');
  }

  // ── dev HTML: toggle が default OFF・per-frame cost なし（静的確認）──
  const devHtml = fs.existsSync(P('public', 'osaka_3d_buildings.ward-ux-v1.html')) ? fs.readFileSync(P('public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8') : '';
  if (devHtml) {
    checks.toggleDefaultOff = /let gsiRoadEdgeVisible = false;|gsiRoadEdgeVisible:\s*false/.test(devHtml);
    checks.toggleNoConsoleRequired = /toggleGsiRoadEdge|gsi-road-edge-toggle/.test(devHtml);
    if (!checks.toggleDefaultOff) warns.push('GSI Road Edge toggle が default OFF と確認できない');
    if (!checks.toggleNoConsoleRequired) warns.push('GSI Road Edge toggle の UI ハンドラが見つからない');
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
  console.log('[gsi-road-edge-prototype-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[gsi-road-edge-prototype-validate] 失敗:', e && e.stack || e); process.exit(1); });
