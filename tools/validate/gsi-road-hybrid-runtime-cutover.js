#!/usr/bin/env node
// tools/validate/gsi-road-hybrid-runtime-cutover.js
// [Mission 31G-FIX19B §23] Hybrid Runtime Visual Cutover の静的検証。
//
// このセッションにはブラウザが無いため、実際に描画されたピクセルは検証できない。
// ここでは「runtime 接続経路のコードが実際に存在し、構造的に正しく繋がっているか」を
// 静的ソース解析で確認する（§21: スクリーンショット成功を捏造しない）。
//
// PASS 条件（§23）:
//   roadRenderModeExists / hybridReplacesFix13InsideSample / fix13OutsideSample /
//   diffDebugUsesDistinctColors / hybridZeroSurfaceErrorVisible / sampleOutsideStatusVisible /
//   unexpectedFix13ResidualInsideHybrid=0 / geometryMutation=0 が全て true/0。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../lib/canonical-baseline.js";

const P = (...s) => resolveProjectPath(path.join(...s));
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const CANON_ROADS_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json');
const CANON_BLDG_MANIFEST = P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json');
const REFINED = P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json');
const REPORT = P('data', 'reports', 'gsi-road-hybrid-runtime-cutover-validation.json');

const EXPECT_ROAD_FEATURES = CANONICAL_ROAD_FEATURE_COUNT;
const EXPECT_BLDG_FEATURES = 615617;
const EXPECT_REFINED_INDEXED = REFINED_ROAD_SURFACE_INDEXED_COUNT;

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

async function main() {
  const errors = [], warns = [];
  const checks = {};
  const html = fs.existsSync(DEV_HTML) ? fs.readFileSync(DEV_HTML, 'utf-8') : '';
  if (!html) { errors.push('dev HTML が無い: ' + toProjectRelativePath(DEV_HTML)); return finish(errors, warns, checks); }

  // ── §2 roadRenderModeExists: 3値 state が曖昧な複数 boolean でなく定義されている ──
  checks.roadRenderModeExists = /let roadRenderMode = 'FIX13';/.test(html)
    && /async function setRoadRenderMode\(mode\)/.test(html)
    && /function getRoadRenderMode\(\) \{ return roadRenderMode; \}/.test(html);
  if (!checks.roadRenderModeExists) errors.push('ROAD_RENDER_MODE state が見つからない（§2）');

  // ── §3 hybridReplacesFix13InsideSample: sample 内かつ GSI 被覆座標で FIX13 feature を skip している ──
  const roadsStart = html.indexOf("} else if (layer === 'roads') {");
  const parksStart = html.indexOf("} else if (layer === 'parks') {", roadsStart);
  const roadsBranch = (roadsStart >= 0 && parksStart > roadsStart) ? html.slice(roadsStart, parksStart) : '';
  checks.hybridReplacesFix13InsideSample = roadsBranch.includes('const covered = hybridCoveredAt(f.centroid[0], f.centroid[1]);')
    && /if \(covered\) \{ hybridSuppressedCount\+\+; continue; \}/.test(roadsBranch);
  if (!checks.hybridReplacesFix13InsideSample) errors.push('sample 内 GSI 被覆座標での FIX13 suppress ロジックが見つからない（§3）');

  // ── §4 fix13OutsideSample: suppress 判定が hybridSampleAt() で「sample 内」に限定されている
  //     （sample 外の座標には一切触れない＝roadRenderMode に関わらず通常描画される）──
  checks.fix13OutsideSample = /const sample = hybridSampleAt\(f\.centroid\[0\], f\.centroid\[1\]\);/.test(roadsBranch)
    && /if \(sample\) \{/.test(roadsBranch);
  if (!checks.fix13OutsideSample) errors.push('suppress ロジックが sample bbox 判定でガードされていない（sample 外にも影響する疑い・§4）');

  // ── §6 diffDebugUsesDistinctColors: GSI HIGH=緑 / MEDIUM=黄 / FIX13_FALLBACK=マゼンタ の3色が
  //     明確に別の色として定義されている（UNRESOLVED=赤は §21 の理由で geometry 非対応・正直にスコープ外）──
  const hasHigh = /0x22ff44/.test(html);   // GSI HIGH = 鮮明な緑
  const hasMed = /0xffe000/.test(html);    // GSI MEDIUM = 黄色
  const hasFallbackMagenta = /0xff00ff/.test(html);   // FIX13_FALLBACK(sample内残存) = マゼンタ
  checks.diffDebugUsesDistinctColors = hasHigh && hasMed && hasFallbackMagenta;
  if (!checks.diffDebugUsesDistinctColors) errors.push('DIFF_DEBUG の3色（緑/黄/マゼンタ）が揃っていない（§6）');
  checks.unresolvedGeometryScopeNote = /UNRESOLVED は 5m grid rasterize の産物で本 runtime に対応 geometry が無い/.test(html);
  if (!checks.unresolvedGeometryScopeNote) warns.push('UNRESOLVED 未描画のスコープ注記が見つからない（正直な限定である旨の記録が無い）');

  // ── §15 hybridZeroSurfaceErrorVisible ──
  checks.hybridZeroSurfaceErrorVisible = /HYBRID ERROR: 0 surfaces loaded/.test(html);
  if (!checks.hybridZeroSurfaceErrorVisible) errors.push('0 surfaces 時のエラー表示が見つからない（§15）');

  // ── §16 fetch失敗の画面表示 ──
  checks.hybridLoadFailedVisible = /Hybrid load failed/.test(html);
  if (!checks.hybridLoadFailedVisible) errors.push('fetch 失敗時の画面表示が見つからない（§16）');

  // ── §14 sampleOutsideStatusVisible ──
  checks.sampleOutsideStatusVisible = /OUTSIDE PROTOTYPE AREA/.test(html) && /Rendering: FIX13 fallback/.test(html);
  if (!checks.sampleOutsideStatusVisible) errors.push('sample 外の状態表示が見つからない（§14）');

  // ── §13 右下 status: Road: <mode> / Sample: <name> / Hybrid surfaces / GSI HIGH / GSI MED / Fallback / Unresolved ──
  checks.statusPanelHasRoadMode = /Road: ' \+ modeLabel/.test(html);
  checks.statusPanelHasSampleFields = /Hybrid surfaces: /.test(html) && /GSI HIGH: /.test(html) && /GSI MED: /.test(html) && /Fallback: /.test(html) && /Unresolved: /.test(html);
  if (!checks.statusPanelHasRoadMode) errors.push('右下 status に Road mode 表示が無い（§13）');
  if (!checks.statusPanelHasSampleFields) errors.push('右下 status に sample 詳細（surfaces/HIGH/MED/Fallback/Unresolved）が無い（§13）');

  // ── §10/§11 mode 切替時の tile 無効化（cache 問題対応）──
  checks.tileInvalidationOnModeSwitch = /function invalidateHybridAffectedRoadTiles\(\)/.test(html)
    && /disposeEntry\(e\); tileCache\.delete\(k\);/.test(html.slice(html.indexOf('function invalidateHybridAffectedRoadTiles')));
  if (!checks.tileInvalidationOnModeSwitch) errors.push('mode 切替時の road tile 無効化ロジックが見つからない（§10/§11）');

  // ── §18 FIX13/HYBRID/DIFF ボタン・§19 sample selector・§5 Sample Bounds トグル ──
  // [Mission 31G-FIX19C §15] 独立ボタンから Canonical status panel 内へ統合（roadModeBtns）。
  checks.hasModeButtons = /roadModeBtns\[mode\] = b;/.test(html) && /setRoadRenderMode\(mode\)/.test(html);
  checks.hasSampleSelector = /hybrid-sample-select/.test(html) && /flyTo\(a\.x, a\.z/.test(html);
  checks.hasSampleBoundsToggle = /toggleHybridSampleBounds/.test(html);
  if (!checks.hasModeButtons) errors.push('FIX13/HYBRID/DIFF ボタンが見つからない（§18）');
  if (!checks.hasSampleSelector) errors.push('sample selector が見つからない（§19）');
  if (!checks.hasSampleBoundsToggle) errors.push('[Hybrid Sample Bounds] トグルが見つからない（§5）');

  // ── §17 unexpectedFix13ResidualInsideHybrid: covered 判定直後に無条件 continue（構造的に0であることの保証）──
  //     FIX18 の illegalPairCrossing と同じ「構造的に発生しない」パターン。
  const continueOk = /if \(covered\) \{ hybridSuppressedCount\+\+; continue; \}/.test(roadsBranch);
  checks.unexpectedFix13ResidualInsideHybrid = continueOk ? 0 : 1;
  if (checks.unexpectedFix13ResidualInsideHybrid) errors.push('covered 判定後に無条件 continue が無い＝FIX13 残存の可能性（§17）');

  // ── §22 geometryMutation: Canonical Road/Building/FIX13 が完全不変 ──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED);
  let geometryMutation = 0;
  if (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) { geometryMutation++; errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount)); }
  if (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) { geometryMutation++; errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount)); }
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) { geometryMutation++; errors.push('refined-road-surface.json indexedCount 変化: ' + (refined && refined.indexedCount)); }
  checks.geometryMutation = geometryMutation;

  // ── §0 GSI pairing/corridor DP 自体には触れていない（静的ソース差分は git 側で別途確認するが、
  //     ここでは corridor v3 lib に FIX19B 由来の変更キーワードが無いことだけ軽く確認）──
  const corridorSrc = fs.existsSync(P('tools', 'lib', 'gsi-road-edge-corridor-v3.js')) ? fs.readFileSync(P('tools', 'lib', 'gsi-road-edge-corridor-v3.js'), 'utf-8') : '';
  checks.corridorLibUntouched = !/FIX19B/i.test(corridorSrc);
  if (!checks.corridorLibUntouched) errors.push('corridor v3 lib に FIX19B 由来の変更痕跡がある（§0 違反の疑い）');

  // ── mode 既定 OFF（FIX13）・toggle UI 存在 ──
  checks.roadRenderModeDefaultFix13 = /let roadRenderMode = 'FIX13';/.test(html);

  // ── production / protected 不変 ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0/§25 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0/§25 禁止）');
  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (fs.existsSync(p) && /roadRenderMode|setRoadRenderMode|HYBRID_SAMPLE_AREAS|gsi-road-hybrid-v1/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に Hybrid Runtime Cutover コードが混入');
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
  console.log('[gsi-road-hybrid-runtime-cutover-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[gsi-road-hybrid-runtime-cutover-validate] 失敗:', e && e.stack || e); process.exit(1); });
