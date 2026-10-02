#!/usr/bin/env node
// tools/validate/legacy-residual-guard.js
// [Mission 31G-FIX19C] Runtime QA Blocker Fix — Legacy Building ownership regression の静的検証。
//
// 背景: Canonical Runtime が base layer を所有中でも、legacy building tile の async load が
// ownership 取得と race し、scene へ mesh が残存する（Legacy residual）問題が実機で再発した。
// 根本原因は2つ:
//   (1) loadRemoteTile() に「fetch/parse 完了後に ownership を再確認する」guard が無かった
//       （switchWard 等の呼び出し元 guard は「開始時」だけを見ており、async 完了時点は無防備だった）。
//   (2) toggleOldLayers(true) の embedded dataset dispose が 'osaka-embedded' / 'embedded' という
//       実際には存在しない dataset ID literal を使っており、常に no-op だった
//       （実際の ID = BUILDING_TILE_CONFIG.embeddedDatasetId = 'osaka-embedded-mixedward-legacy'）。
//
// このセッションにはブラウザが無いため、静的ソース解析 + smoke harness の実 fetch による
// 動的検証（tests/legacy-residual-guard.test.js）で検証する。
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
const REPORT = P('data', 'reports', 'legacy-residual-guard-validation.json');

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

  // ── §1/§3 loadRemoteTile 入口 guard（呼び出し元に関わらず、実 load 開始点で ownership を確認）──
  const fnStart = html.indexOf('async function loadRemoteTile(datasetId, tx, tz)');
  const fnEnd = html.indexOf('\n  // ── manifest読み込み', fnStart);
  const fnBody = (fnStart >= 0 && fnEnd > fnStart) ? html.slice(fnStart, fnEnd) : '';
  checks.loadRemoteTileEntryGuard = /if \(typeof window !== 'undefined' && window\.__CANONICAL_OWNS_BASE__\) return null;/.test(fnBody);
  if (!checks.loadRemoteTileEntryGuard) errors.push('loadRemoteTile() の入口 guard が見つからない（§3/§4）');

  // ── §3/§4 loadRemoteTile 内、fetch/parse の await 後（scene.add 直前）の再確認 guard ──
  checks.loadRemoteTilePostAwaitGuard = /if \(typeof window !== 'undefined' && window\.__CANONICAL_OWNS_BASE__\) \{\s*\r?\n\s*tile\.state = 'skipped-canonical-owns';/.test(fnBody);
  if (!checks.loadRemoteTilePostAwaitGuard) errors.push('loadRemoteTile() の fetch/parse 後 guard が見つからない（async race 対策・§3/§4）');

  // ── §7 CityModeManager.enter() の legacy building dataset 一括 enable が ownership guard 済み ──
  const enterStart = html.indexOf('function enter() {');
  const enterEnd = html.indexOf('\n  }', enterStart);
  const enterBody = (enterStart >= 0 && enterEnd > enterStart) ? html.slice(enterStart, enterEnd) : '';
  checks.cityModeEnterGuarded = /if \(!window\.__CANONICAL_OWNS_BASE__\) \{/.test(enterBody) && enterBody.includes('BuildingTileLayer.enableDataset(w.datasetId)');
  if (!checks.cityModeEnterGuarded) errors.push('CityModeManager.enter() の enableDataset 一括呼び出しが ownership guard されていない（§7）');

  // ── §9 embedded dataset の dispose が正しい ID を使っている（旧 'osaka-embedded'/'embedded' literal は削除済み）──
  checks.embeddedDisposeUsesCorrectId = /BuildingTileLayer\.disposeDataset\(BUILDING_TILE_CONFIG\.embeddedDatasetId\);/.test(html);
  checks.staleEmbeddedLiteralsRemoved = !/disposeDataset\('osaka-embedded'\)/.test(html) && !/disposeDataset\('embedded'\)/.test(html);
  if (!checks.embeddedDisposeUsesCorrectId) errors.push('embedded dataset の disposeDataset が正しい ID (BUILDING_TILE_CONFIG.embeddedDatasetId) を使っていない（§9）');
  if (!checks.staleEmbeddedLiteralsRemoved) errors.push('embedded dataset dispose に古い誤った literal ID が残っている（常に no-op になるバグ・§1/§2）');

  // ── §10 Legacy residual 正常値チェック: __MAP_COMPLETENESS_DEBUG__ の runtimeMissing が
  //     canonical ownership 中は BuildingTileLayer/CityTileLayer の 0 tile を誤検知しない ──
  checks.completenessDebugCanonicalAware = /const canonicalOwnsNow = \(typeof window !== 'undefined'\) && !!window\.__CANONICAL_OWNS_BASE__;/.test(html)
    && /if \(bt && !canonicalOwnsNow && \(bt\.loadedTiles \|\| 0\) === 0\)/.test(html);
  if (!checks.completenessDebugCanonicalAware) warns.push('__MAP_COMPLETENESS_DEBUG__ の runtimeMissing が canonical ownership を考慮していない（FIX19C で修正済みのはず）');

  // ═══════════════════════════════════════════════════════════════
  // [Mission 31G-FIX23] §32 Canonical Runtime Purity 用の追加チェック。
  //   実機ブラウザが無いため、object単位の完全な動的検証（scene.traverse実測）は
  //   tests/legacy-residual-guard.test.js（拡張したハーネスで実際にscene graphを構築して検証）に
  //   委ね、ここでは「その動的検証を支える静的コード構造」を確認する。
  // ═══════════════════════════════════════════════════════════════
  checks.canonicalOwnershipTagged = /const RUNTIME_OWNER = \{ CANONICAL: 'CANONICAL', LEGACY: 'LEGACY', DEBUG: 'DEBUG' \};/.test(html)
    && /function findRuntimeOwner\(o\)/.test(html);
  if (!checks.canonicalOwnershipTagged) errors.push('RUNTIME_OWNER / findRuntimeOwner が見つからない（§4/§9）');

  checks.legacyOwnershipTagged = /for \(const __m of \[wM, tM, eLine\]\) \{ __m\.userData\.usage = usage; Object\.assign\(__m\.userData, __ownerTag\); \}/.test(html)
    && /mesh\.userData\.runtimeOwner = RUNTIME_OWNER\.LEGACY;\s*\r?\n\s*mesh\.userData\.creationPath = 'CITY_BUILDING_LOD';/.test(html);
  if (!checks.legacyOwnershipTagged) errors.push('BuildingTileLayer(wM/tM/eLine) または CityBuildingLOD の runtimeOwner=LEGACY タグ付けが見つからない（§4/§9）');

  // [Mission 31G-FIX23B §17] tagRuntimeOwnerRecursive(g, RUNTIME_OWNER.DEBUG) へ統一（子孫も再帰タグ）。
  const debugTagCount = (html.match(/tagRuntimeOwnerRecursive\(g, RUNTIME_OWNER\.DEBUG\);/g) || []).length;
  checks.debugOwnershipTagged = debugTagCount === 6;
  if (!checks.debugOwnershipTagged) errors.push('debug overlay(6箇所: Alignment/RoadEdge/V2/V3/Bounds/Seams)のruntimeOwner=DEBUGタグが揃っていない: ' + debugTagCount + '/6（§10）');

  // ── §7/§8: 過去にCOEXIST_NAMEが想定していたのに実際は.name未設定だった false positive源を修正済み ──
  checks.coexistNamingFixed = /line\.name = 'HighlightLine';/.test(html) && /fill\.name = 'HighlightFill';/.test(html)
    && /group\.name = 'WardBoundary';/.test(html) && /group\.name = 'WardArea';/.test(html)
    && /group\.name = 'GroundVisual';/.test(html);
  if (!checks.coexistNamingFixed) errors.push('hover/select highlight・WardBoundary/WardArea・GroundVisualのname設定漏れ修正が見つからない（§7/§13/§14）');

  checks.streetscapeGuarded = /if \(typeof StreetscapeLayer !== 'undefined'\) hidden \? StreetscapeLayer\.hide\(\) : StreetscapeLayer\.show\(\);/.test(html);
  if (!checks.streetscapeGuarded) errors.push('StreetscapeLayer が toggleOldLayers から呼ばれていない（Canonical所有中も常時表示され続ける実バグ・§17）');

  // ── §17: loadFullWard の atomic commit race（実データ生成経路のバグ）修正 ──
  const lfwStart = html.indexOf('async function loadFullWard(datasetId, opts) {');
  const lfwBody = lfwStart >= 0 ? html.slice(lfwStart, lfwStart + 8000) : '';
  checks.loadFullWardEntryGuard = /Canonical Runtime 所有中のため loadFullWard をスキップ/.test(lfwBody);
  checks.loadFullWardCommitGuard = /Canonical Runtime 所有中のため atomic commit をスキップ/.test(lfwBody);
  if (!checks.loadFullWardEntryGuard || !checks.loadFullWardCommitGuard) errors.push('loadFullWard() のentry/atomic commit ownership guardが見つからない（§5/§17）');

  // ── §7/§10: classifyLegacyResidual が DEBUG を residual.total から除外する構造 ──
  const clrStart = html.indexOf('function classifyLegacyResidual(opts)');
  const clrEnd = html.indexOf('function makeDetailRecord', clrStart);
  const clrBody = (clrStart >= 0 && clrEnd > clrStart) ? html.slice(clrStart, clrEnd) : '';
  checks.debugCountedAsLegacy = !(/if \(owner === RUNTIME_OWNER\.DEBUG\) \{[\s\S]{0,80}buckets\.total\+\+/.test(clrBody)) && /buckets\.debugCount\+\+;/.test(clrBody);
  if (!checks.debugCountedAsLegacy) errors.push('classifyLegacyResidual が DEBUG owner を buckets.total に含めている疑い（§10）');

  // ── §26: 閾値の厳格化（>8 → >0）──
  checks.residualThresholdStrict = !/residual\.total > 8/.test(html) && /residual\.total > 0/.test(html);
  if (!checks.residualThresholdStrict) errors.push('Legacy residual ERROR 閾値が ">0" へ厳格化されていない（§26）');

  // ── §1/§28: object単位の完全な内訳 API・手動self-check APIが公開されている ──
  checks.residualDetailApiExposed = /window\.__LEGACY_RESIDUAL_DETAIL__ = function/.test(html) && /window\.__CANONICAL_SELF_CHECK__ = function/.test(html);
  if (!checks.residualDetailApiExposed) errors.push('__LEGACY_RESIDUAL_DETAIL__ / __CANONICAL_SELF_CHECK__ が公開されていない（§1/§28）');

  // ── §23: startup cleanupが有限回数（bounded retry）で、per-frameではないこと ──
  checks.boundedCleanupRetry = /const CLEANUP_RETRY_DELAYS_MS = \[3000, 8000, 15000\];/.test(html)
    && /attempts < CLEANUP_RETRY_DELAYS_MS\.length/.test(html);
  if (!checks.boundedCleanupRetry) errors.push('startup cleanupが有限回数のbounded retryになっていない（§23）');

  // ═══════════════════════════════════════════════════════════════
  // [Mission 31G-FIX23B] Unknown Legacy Residual 18 最終解消 用の追加チェック。
  // ═══════════════════════════════════════════════════════════════
  checks.tagRuntimeOwnerRecursiveDefined = /function tagRuntimeOwnerRecursive\(root, owner\)/.test(html)
    && /for \(const c of root\.children\) tagRuntimeOwnerRecursive\(c, owner\);/.test(html);
  if (!checks.tagRuntimeOwnerRecursiveDefined) errors.push('tagRuntimeOwnerRecursive() が見つからない（§17）');

  // ── §6/§9: HYBRID_V1(gN)/DIFF_DEBUG(gD) road groupのownership漏れ（実測で発見した実バグ）修正 ──
  checks.hybridRoadGroupsOwnershipTagged = /tagRuntimeOwnerRecursive\(gN, RUNTIME_OWNER\.CANONICAL\);/.test(html)
    && /tagRuntimeOwnerRecursive\(gD, RUNTIME_OWNER\.DEBUG\);/.test(html);
  if (!checks.hybridRoadGroupsOwnershipTagged) errors.push('HYBRID_V1(gN)/DIFF_DEBUG(gD) road groupにownership markerが付いていない（Road mode切替でunknown residualが発生する実バグ・§6/§9）');

  // ── §5: [Residual details] development detail panel ──
  checks.residualDetailUiPresent = /residualDetailBtn\.textContent = '\[Residual details\]';/.test(html)
    && /function renderResidualDetailPanel_\(\)/.test(html)
    && /residualDetailBtn\.style\.display = residualBad \? 'block' : 'none';/.test(html);
  if (!checks.residualDetailUiPresent) errors.push('[Residual details] development detail panelが見つからない（§5）');

  // ── §1/§27/§33: 診断・非vacuous testを実行するための最小限のwindow公開（read参照のみ・新規状態は作らない）──
  checks.testingBridgesExposed = /window\.__SCENE__ = scene;/.test(html) && /window\.__WARD_MODE_MANAGER__ = WardModeManager;/.test(html);
  if (!checks.testingBridgesExposed) errors.push('__SCENE__ / __WARD_MODE_MANAGER__ が公開されていない（非vacuous residual test・ward switch testに必要・§1/§27/§33）');

  // ── §32: test harnessのTHREE stubが本物のscene graph（no-opへ後退していない）であることを確認 ──
  //   [Mission 31G-ALIGNMENT-RESET] add() は multi-arg(add(a,b,c))対応（実 three.js と同じ挙動）へ
  //   拡張されたため、シグネチャは変わったが「実際に children へ push する実装」という本質は不変。
  //   ここでは `this.children.push(obj); obj.parent = this;` という副作用の実体で判定する
  //   （引数の取り方(単一/可変長)には依存しない）。
  const HARNESS = P('tests', '_ward-ux-v1-smoke-harness.cjs');
  const harnessSrc = fs.existsSync(HARNESS) ? fs.readFileSync(HARNESS, 'utf-8') : '';
  checks.sceneGraphHarnessActive = /function makeObject3DLike\(extra = \{\}\)/.test(harnessSrc)
    && /this\.children\.push\(obj\); obj\.parent = this;/.test(harnessSrc)
    && /traverse\(cb\) \{ cb\(this\); for \(const c of this\.children\.slice\(\)\)/.test(harnessSrc);
  if (!checks.sceneGraphHarnessActive) errors.push('test harnessのscene graphがno-opへ後退している疑い（FIX23で追加した本物のadd/remove/traverse実装が見つからない・§32）');

  // ═══════════════════════════════════════════════════════════════
  // [Mission 31G-FIX23C] FIX13 Road Ownership Final Fix 用の追加チェック。
  // ═══════════════════════════════════════════════════════════════
  // ── §1: roadKeyのuserData代入がRoadLayer(Legacy)の1箇所のみ（roadKey自体を判定材料に使っていない証跡）──
  const roadKeyAssignCount = (html.match(/\.userData\.roadKey\s*=/g) || []).length;
  checks.roadKeyNotUsedAsBlindCanonicalHeuristic = roadKeyAssignCount === 1
    && !/owner === RUNTIME_OWNER\.CANONICAL[\s\S]{0,40}roadKey/.test(html)
    && !/roadKey[\s\S]{0,40}RUNTIME_OWNER\.CANONICAL/.test(html);
  if (!checks.roadKeyNotUsedAsBlindCanonicalHeuristic) errors.push('roadKeyの有無だけでCANONICAL判定している疑い、またはroadKey代入箇所が想定外（§0/§5禁止事項）');

  // ── §3/§4: RoadLayer(Legacy Road)への明示的なownership付与 ──
  checks.legacyRoadOwnerTagged = /group\.name = 'RoadLayer';/.test(html)
    && /tagRuntimeOwnerRecursive\(group, RUNTIME_OWNER\.LEGACY\);/.test(html)
    && /m\.userData\.creationPath = 'LEGACY_ROAD_LAYER';/.test(html);
  if (!checks.legacyRoadOwnerTagged) errors.push('RoadLayer(Legacy Road)へのownership marker付与が見つからない（§3/§4）');

  // ── §3/§4/§9: CanonicalRuntime自身のFIX13 Road（および他layer）tile groupへの明示的な自己タグ ──
  checks.fix13RoadOwnerTagged = /gb\.group\.userData\.runtimeOwner = RUNTIME_OWNER\.CANONICAL;/.test(html)
    && /gb\.group\.userData\.runtimeSubsystem = 'FIX13_ROAD';/.test(html)
    && /gb\.group\.userData\.runtimeSource = 'REFINED_ROAD_SURFACE';/.test(html);
  if (!checks.fix13RoadOwnerTagged) errors.push('FIX13 Road(CanonicalRuntime自身のtile group)へのCANONICAL自己タグ付与が見つからない（§3/§4）');

  // ── §7: FIX13 root(rtRoot) → layerGroup['roads'] → tile group → mesh という親子関係で
  //     tile groupへ自己タグを付けている（子meshは祖先チェーンで継承する設計・§8のinheritance）──
  checks.fix13RoadChildInheritance = /layerGroup\[job\.layer\]\.add\(gb\.group\);/.test(html)
    && html.indexOf('layerGroup[job.layer].add(gb.group);') < html.indexOf("gb.group.userData.runtimeOwner = RUNTIME_OWNER.CANONICAL;");
  if (!checks.fix13RoadChildInheritance) errors.push('tile groupがlayerGroup配下へattachされる前後関係が想定と異なる（§7の親子継承が壊れている疑い）');

  // ── §11: __LEGACY_RESIDUAL_DETAIL__ がsignature別集計(keySignatureCounts)を返す ──
  checks.residualSignatureAggregation = /buckets\.keySignatureCounts = sig;/.test(html)
    && /sig\.roadKey\+\+/.test(html);
  if (!checks.residualSignatureAggregation) errors.push('__LEGACY_RESIDUAL_DETAIL__ にkeySignatureCounts集計が無い（§11）');

  // ── production / protected 不変 ──
  const curProd = sha(PROD), curProt = sha(PROT);
  const baseline = rj(BASELINE);
  checks.productionModified = !!(baseline && baseline.prod && curProd && baseline.prod !== curProd);
  checks.protectedModified = !!(baseline && baseline.prot && curProt && baseline.prot !== curProt);
  if (checks.productionModified) errors.push('production HTML が変更されている（§0/§30 禁止）');
  if (checks.protectedModified) errors.push('protected HTML が変更されている（§0/§30 禁止）');

  // ── geometry 不変 ──
  const rm = rj(CANON_ROADS_MANIFEST), bm = rj(CANON_BLDG_MANIFEST), refined = rj(REFINED);
  let geometryMutation = 0;
  if (!rm || rm.featureCount !== EXPECT_ROAD_FEATURES) { geometryMutation++; errors.push('canonical roads featureCount 変化: ' + (rm && rm.featureCount)); }
  if (!bm || bm.featureCount !== EXPECT_BLDG_FEATURES) { geometryMutation++; errors.push('canonical buildings featureCount 変化: ' + (bm && bm.featureCount)); }
  if (!refined || refined.indexedCount !== EXPECT_REFINED_INDEXED) { geometryMutation++; errors.push('refined-road-surface.json indexedCount 変化: ' + (refined && refined.indexedCount)); }
  checks.geometryMutation = geometryMutation;

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
  console.log('[legacy-residual-guard-validate] ' + JSON.stringify(checks));
  for (const e of errors) console.log('  [ERROR] ' + e);
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[legacy-residual-guard-validate] 失敗:', e && e.stack || e); process.exit(1); });
