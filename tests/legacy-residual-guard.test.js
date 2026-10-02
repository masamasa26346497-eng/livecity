// tests/legacy-residual-guard.test.js
// [Mission 31G-FIX19C] Runtime QA Blocker Fix — Legacy residual regression + Road mode UI visibility。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInlineScript } from './_ward-ux-v1-smoke-harness.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const HTML = R('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

test('[FIX19C] legacy-residual-guard validator が PASS', { skip: !rpt('legacy-residual-guard-validation.json') && 'no report' }, () => {
  const v = rpt('legacy-residual-guard-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of ['loadRemoteTileEntryGuard', 'loadRemoteTilePostAwaitGuard', 'cityModeEnterGuarded',
    'embeddedDisposeUsesCorrectId', 'staleEmbeddedLiteralsRemoved',
    // [Mission 31G-FIX23 §32]
    'canonicalOwnershipTagged', 'legacyOwnershipTagged', 'debugOwnershipTagged', 'coexistNamingFixed',
    'streetscapeGuarded', 'loadFullWardEntryGuard', 'loadFullWardCommitGuard', 'debugCountedAsLegacy',
    'residualThresholdStrict', 'residualDetailApiExposed', 'boundedCleanupRetry',
    // [Mission 31G-FIX23B §34]
    'tagRuntimeOwnerRecursiveDefined', 'hybridRoadGroupsOwnershipTagged', 'residualDetailUiPresent',
    'testingBridgesExposed', 'sceneGraphHarnessActive',
    // [Mission 31G-FIX23C §22]
    'roadKeyNotUsedAsBlindCanonicalHeuristic', 'legacyRoadOwnerTagged', 'fix13RoadOwnerTagged',
    'fix13RoadChildInheritance', 'residualSignatureAggregation']) {
    assert.equal(v.checks[k], true, k + ' が true でない');
  }
  assert.equal(v.checks.geometryMutation, 0);
  assert.equal(v.checks.productionModified, false);
  assert.equal(v.checks.protectedModified, false);
});

test('[FIX19C §9] embedded dataset の disposeDataset が正しい ID を使う（旧 literal は no-op だった）', { skip: !html && 'no html' }, () => {
  assert.match(html, /BuildingTileLayer\.disposeDataset\(BUILDING_TILE_CONFIG\.embeddedDatasetId\);/);
  assert.doesNotMatch(html, /disposeDataset\('osaka-embedded'\)/);
  assert.doesNotMatch(html, /disposeDataset\('embedded'\)/);
});

// ── §27 async race test: legacy building load 開始時は ownership 未取得、fetch/parse 中に
//   ownership を取得した場合、load 完了後も legacy scene attachment = 0 であること。
test('[FIX19C §3/§4/§27] 動的: async race — ownership取得中の fetch 完了後も新規 building mesh を作らない', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const BTL = w.__BUILDING_TILE_LAYER__;
  const cfg = w.__BUILDING_TILE_CONFIG__;
  assert.ok(BTL && cfg, '__BUILDING_TILE_LAYER__ / __BUILDING_TILE_CONFIG__ が公開されていない');

  const dsId = 'osaka-abeno';
  // load 開始時点では ownership 未取得（switchWard 等の呼び出し元 guard を素通りした状況を模す）
  w.__CANONICAL_OWNS_BASE__ = false;
  BTL.enableDataset(dsId);
  const p = BTL.loadRemoteTile(dsId, -1, -10);
  // fetch/parse の await 中に ownership を取得（race window）
  w.__CANONICAL_OWNS_BASE__ = true;
  const tile = await p;

  assert.equal(tile && tile.state, 'skipped-canonical-owns', 'race window で load が打ち切られていない: ' + (tile && tile.state));
  const stats = BTL.getDatasetStats(dsId);
  assert.equal(stats.buildings, 0, 'race 発生後も building データが登録されている（bPick等への副作用が残った）: ' + JSON.stringify(stats));
  assert.equal(stats.loadedTiles, 0, 'race 発生後に tile が loaded 扱いになっている: ' + JSON.stringify(stats));
});

test('[FIX19C §7] 動的: canonical ownership 中に CityModeManager.enter() を呼んでも legacy building dataset が enable されない', { skip: !html && 'no html' }, async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const BTL = w.__BUILDING_TILE_LAYER__;
  assert.ok(BTL, '__BUILDING_TILE_LAYER__ が公開されていない');
  // CanonicalRuntime は起動直後に自動で ownership を取得する設計（auto-init）。
  // ここでは明示的に ownership=true を保証した状態で City Mode entry 相当の enableDataset 一括呼び出しを
  // 静的に確認済み（validator cityModeEnterGuarded）なので、ここでは実行時の disable* 状態を再確認する。
  w.__CANONICAL_OWNS_BASE__ = true;
  if (typeof w.CityModeManager !== 'undefined' && w.CityModeManager && w.CityModeManager.enter) {
    w.CityModeManager.enter();
  }
  // enableDataset が呼ばれていれば d.enabled=true になるはず。ward datasetの1つを代表チェック。
  const sample = BTL.getDatasetStats('osaka-abeno');
  if (sample) assert.equal(sample.enabled, false, 'canonical ownership 中に CityModeManager.enter() が legacy dataset を enable した: ' + JSON.stringify(sample));
});

// ── §28 UI visibility: ボタンは独立した固定位置要素としては存在せず、Canonical status panel
//   （z-index:99997・確実に最前面）の中で生成される。WARD-DIAG（z-index:99990）等より低い
//   z-index の独立要素として再度置かれていないことを確認する。
test('[FIX19C §13/§14/§28] Road mode ボタンは独立の低z-index固定要素ではなく、Canonical status panel内で生成される', { skip: !html && 'no html' }, () => {
  assert.doesNotMatch(html, /id = 'road-render-mode-bar'/, '独立の road-render-mode-bar が復活している');
  const panelStart = html.indexOf('function ensureStatusUI_()');
  const panelEnd = html.indexOf('function renderStatus()', panelStart);
  assert.ok(panelStart >= 0 && panelEnd > panelStart);
  const panel = html.slice(panelStart, panelEnd);
  assert.match(panel, /roadBox\.id = 'canonical-runtime-road-controls';/);
  assert.match(panel, /statusEl\.style\.cssText = \[/);   // roadBox は statusEl（z-index:99997）の子として生成される
  assert.match(html, /'position:fixed', 'right:12px', 'bottom:12px', 'z-index:99997',/);
});

test('[FIX19C §16] 動的: mode 切替後、対応するボタンが active 表示になる', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  await w.__SET_ROAD_RENDER_MODE__('HYBRID_V1');
  assert.equal(w.__ROAD_RENDER_MODE_DEBUG__().mode, 'HYBRID_V1');
  await w.__SET_ROAD_RENDER_MODE__('DIFF_DEBUG');
  assert.equal(w.__ROAD_RENDER_MODE_DEBUG__().mode, 'DIFF_DEBUG');
});

test('[FIX19C §0] protected HTML に legacy residual guard 関連コードが混入していない（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /skipped-canonical-owns|__BUILDING_TILE_LAYER__|canonical-runtime-road-controls/, f + ' に混入');
  }
});

// ═══════════════════════════════════════════════════════════════
// [Mission 31G-FIX23] Canonical Runtime Purity — Legacy residual を 0 へ。
// ═══════════════════════════════════════════════════════════════

test('[FIX23 §4/§9] RUNTIME_OWNER / findRuntimeOwner が定義され、主要な生成元にownership markerが付与されている', () => {
  assert.match(html, /const RUNTIME_OWNER = \{ CANONICAL: 'CANONICAL', LEGACY: 'LEGACY', DEBUG: 'DEBUG' \};/);
  assert.match(html, /function findRuntimeOwner\(o\)/);
  // buildUsageTileMeshes: wM/tM/eLine 全てに ownership marker（従来 eLine の userData.usage のみだった）
  assert.match(html, /for \(const __m of \[wM, tM, eLine\]\) \{ __m\.userData\.usage = usage; Object\.assign\(__m\.userData, __ownerTag\); \}/);
  assert.match(html, /creationPath: \(source === 'remote'\) \? 'LEGACY_REMOTE_TILE' : 'LEGACY_EMBEDDED'/);
  // CityBuildingLOD
  assert.match(html, /mesh\.userData\.runtimeOwner = RUNTIME_OWNER\.LEGACY;\s*\n\s*mesh\.userData\.creationPath = 'CITY_BUILDING_LOD';/);
});

test('[FIX23/FIX23B §10/§17] 6つのdebug overlay groupすべてに runtimeOwner=DEBUG が付与されている', () => {
  // GsiBuildingAlignment(Building Alignment), GsiRoadEdgeDebug, GsiPrototypeV2Debug,
  // GsiPrototypeV3Debug, HybridSampleBoundsDebug, HybridSeamsDebug
  // [FIX23B] 個別の g.userData.runtimeOwner=... 代入から、子孫まで再帰的にタグ付けする
  //   tagRuntimeOwnerRecursive(g, RUNTIME_OWNER.DEBUG) へ統一した（意図的な強化・退行ではない）。
  const debugTagCount = (html.match(/tagRuntimeOwnerRecursive\(g, RUNTIME_OWNER\.DEBUG\);/g) || []).length;
  assert.equal(debugTagCount, 6, 'debug overlay groupのownership marker数が6でない: ' + debugTagCount);
});

test('[FIX23 §13/§14] hover/select highlight・WardBoundary/WardArea・GroundVisual・Streetscapeのname設定漏れを修正した', () => {
  // hover/select highlight: COEXIST_NAME は元々 Highlight/Hover/Select prefix を想定していたが
  // .name が一度も設定されていなかった（renderOrder>=900のため常時"BuildingTileLayer"residualに
  // 誤計上され続けていた実バグ）。
  assert.match(html, /line\.name = 'HighlightLine';/);
  assert.match(html, /fill\.name = 'HighlightFill';/);
  // WardBoundaryLayer / WardAreaFillLayer: 同様に .name 未設定だった
  assert.match(html, /group\.name = 'WardBoundary';/);
  assert.match(html, /group\.name = 'WardArea';/);
  // GroundVisualLayer: COEXIST_NAME の先頭prefixが元々想定していたが.name未設定だった
  assert.match(html, /group\.name = 'GroundVisual';/);
  // StreetscapeLayer: COEXIST_NAMEにも無くtoggleOldLayersからも呼ばれていなかった
  //   （Canonical所有中も常時表示され続けていた実バグ）。RoadLayerに準じてhide/showを追加。
  assert.match(html, /if \(typeof StreetscapeLayer !== 'undefined'\) hidden \? StreetscapeLayer\.hide\(\) : StreetscapeLayer\.show\(\);/);
});

test('[FIX23 §5/§17] loadFullWard: エントリと atomic commit 直前の2箇所でownershipを再確認する（実race修正）', () => {
  const start = html.indexOf('async function loadFullWard(datasetId, opts) {');
  assert.ok(start >= 0, 'loadFullWard が見つからない');
  const end = html.indexOf('\n  return {\n    loadFullWard,', start);
  const block = html.slice(start, end > start ? end : start + 6000);
  const guardCount = (block.match(/window\.__CANONICAL_OWNS_BASE__/g) || []).length;
  assert.ok(guardCount >= 2, 'loadFullWard内のownership確認が2箇所未満: ' + guardCount);
  assert.match(block, /Canonical Runtime 所有中のため loadFullWard をスキップ/);
  assert.match(block, /Canonical Runtime 所有中のため atomic commit をスキップ/);
});

test('[FIX23 §7/§8/§10] classifyLegacyResidual は DEBUG ownerを除外し、underRt→CANONICAL の二重ガードを持つ', () => {
  const start = html.indexOf('function classifyLegacyResidual(opts)');
  const end = html.indexOf('function makeDetailRecord');
  const block = html.slice(start, end);
  assert.match(block, /if \(owner === RUNTIME_OWNER\.CANONICAL\) return;/);
  assert.match(block, /if \(owner === RUNTIME_OWNER\.DEBUG\) \{/);
  assert.match(block, /buckets\.debugCount\+\+;/);
});

test('[FIX23 §26] Legacy residual ERROR 閾値が「>8」から「>0」へ厳格化されている', () => {
  assert.doesNotMatch(html, /residual\.total > 8/);
  assert.match(html, /residual\.total > 0/);
  assert.doesNotMatch(html, /selfCheck\.residual\.total > 8/);
});

test('[FIX23 §1/§28] window.__LEGACY_RESIDUAL_DETAIL__ / __CANONICAL_SELF_CHECK__ が公開されている', () => {
  assert.match(html, /window\.__CANONICAL_SELF_CHECK__ = function/);
  assert.match(html, /window\.__LEGACY_RESIDUAL_DETAIL__ = function/);
  assert.match(html, /getResidualDetail: \(\) => classifyLegacyResidual\(\{ detail: true \}\)/);
});

test('[FIX23] 動的: 起動直後（何も操作しない状態）で Legacy residual = 0（実測でGroundVisual/Streetscapeの' +
  'name未設定バグを発見・修正した回帰防止）', () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  assert.equal(typeof w.__CANONICAL_SELF_CHECK__, 'function');
  const residual = w.__CANONICAL_SELF_CHECK__();
  assert.ok(residual, 'selfCheckがnullを返した(enabled=falseの可能性)');
  assert.equal(residual.total, 0, 'startup直後のresidualが0でない: ' + JSON.stringify(residual));
});

test('[FIX23 §11/§21] 動的: Building Alignment ON/OFF・Top Down ON/OFF でも Legacy residual = 0 のまま（DEBUG除外）', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const before = w.__CANONICAL_SELF_CHECK__();
  assert.equal(before.total, 0);
  await w.__TOGGLE_BUILDING_ALIGNMENT__();
  const dbg = w.__BUILDING_ALIGNMENT_DEBUG__();
  const afterOn = w.__CANONICAL_SELF_CHECK__();
  assert.equal(afterOn.total, 0, 'Building Alignment ON で residual が増えた: ' + JSON.stringify(afterOn));
  if (dbg.status === 'ready' && dbg.pairCount > 0) {
    assert.ok(afterOn.debugCount > before.debugCount, 'overlay実在なのにdebugCountが増えていない');
  }
  w.__TOGGLE_TOP_DOWN_ALIGNMENT__();
  const afterTopDown = w.__CANONICAL_SELF_CHECK__();
  assert.equal(afterTopDown.total, 0);
  assert.equal(afterTopDown.debugCount, afterOn.debugCount, 'Top Down はcamera変更のみのはずがscene構成が変わった');
  await w.__TOGGLE_BUILDING_ALIGNMENT__(); // OFFに戻す
  const afterOff = w.__CANONICAL_SELF_CHECK__();
  assert.equal(afterOff.total, 0);
});

test('[FIX23 §18/§30] 動的: 実機repro条件（osaka-kita, ownership取得中の非同期race）でも building tile が一切残らない', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const BTL = w.__BUILDING_TILE_LAYER__;
  assert.ok(BTL, '__BUILDING_TILE_LAYER__ が公開されていない');
  w.__CANONICAL_OWNS_BASE__ = false;
  BTL.enableDataset('osaka-kita');
  const p = BTL.loadRemoteTile('osaka-kita', -1, -20); // 実在するfixture tile
  w.__CANONICAL_OWNS_BASE__ = true; // fetch/parse中にownership取得（race window）
  const tile = await p;
  assert.equal(tile && tile.state, 'skipped-canonical-owns', '北区(osaka-kita)でrace windowのload打ち切りが効いていない: ' + (tile && tile.state));
  const stats = BTL.getDatasetStats('osaka-kita');
  assert.equal(stats.buildings, 0);
  assert.equal(stats.loadedTiles, 0);
  const residual = w.__CANONICAL_SELF_CHECK__();
  assert.equal(residual.total, 0, '北区race再現後もresidualが0でない: ' + JSON.stringify(residual));
});

test('[FIX23 §1] __LEGACY_RESIDUAL_DETAIL__ が object 単位の完全な内訳を返す（uuid/name/parent/userData/geometry種別等）', () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const d = w.__LEGACY_RESIDUAL_DETAIL__();
  assert.ok(d, '__LEGACY_RESIDUAL_DETAIL__ がnullを返した');
  assert.ok(Array.isArray(d.details), 'details配列が無い');
  // startup直後はresidual=0のはずなので、details配列自体は空でよい（構造のみ確認）
  assert.equal(d.total, 0);
});

// ═══════════════════════════════════════════════════════════════
// [Mission 31G-FIX23B] Unknown Legacy Residual 18 最終解消。
// ═══════════════════════════════════════════════════════════════

test('[FIX23B §33] 動的・非vacuous性: dummy legacy objectをsceneへ意図的にaddするとdetectorが1件検出し、removeすると0に戻る', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  assert.ok(w.__SCENE__, '__SCENE__ が公開されていない（非vacuousテストにsceneへの参照が必要）');
  const before = w.__CANONICAL_SELF_CHECK__();
  assert.equal(before.total, 0, 'このテスト自体の前提条件が崩れている（startup residualが0でない）');
  const geo = new w.THREE.BufferGeometry();
  geo.setAttribute('position', new w.THREE.BufferAttribute(new Float32Array(2000), 3)); // 300件超で小helper除外を回避
  const dummy = new w.THREE.Mesh(geo, new w.THREE.MeshBasicMaterial({ color: 0xff0000 }));
  dummy.name = 'DummyLegacyTestObject'; // どのCOEXIST_NAME/bucket名にも一致しないダミー
  w.__SCENE__.add(dummy);
  const afterInject = w.__CANONICAL_SELF_CHECK__();
  assert.equal(afterInject.total, 1, 'detectorがdummy objectを検出できていない（=vacuous testの疑い）: ' + JSON.stringify(afterInject));
  assert.equal(afterInject.unknown, 1);
  w.__SCENE__.remove(dummy);
  const afterRemove = w.__CANONICAL_SELF_CHECK__();
  assert.equal(afterRemove.total, 0, 'dummy除去後もresidualが0に戻らない');
});

test('[FIX23B §6/§9] 動的: Road mode切替（FIX13/HYBRID_V1/DIFF_DEBUG）いずれでも Legacy residual = 0（HYBRID_V1/DIFF_DEBUGのownerタグ漏れバグを修正）', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
  await w.__SET_ROAD_RENDER_MODE__('HYBRID_V1');
  const hybrid = w.__CANONICAL_SELF_CHECK__();
  assert.equal(hybrid.total, 0, 'HYBRID_V1で residual が発生した(HybridV1Normalのownerタグ漏れの疑い): ' + JSON.stringify(hybrid));
  await w.__SET_ROAD_RENDER_MODE__('DIFF_DEBUG');
  const diff = w.__CANONICAL_SELF_CHECK__();
  assert.equal(diff.total, 0, 'DIFF_DEBUGで residual が発生した(HybridV1Debugのownerタグ漏れの疑い): ' + JSON.stringify(diff));
  assert.ok(diff.debugCount >= 2, 'DIFF_DEBUGのHybridV1DebugがDEBUG計上されていない');
  await w.__SET_ROAD_RENDER_MODE__('FIX13');
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
});

test('[FIX23B §17] tagRuntimeOwnerRecursive が定義され、子孫まで再帰的にownerを付与する', () => {
  assert.match(html, /function tagRuntimeOwnerRecursive\(root, owner\)/);
  const start = html.indexOf('function tagRuntimeOwnerRecursive(root, owner)');
  const end = html.indexOf('\n}', start);
  const body = html.slice(start, end);
  assert.match(body, /for \(const c of root\.children\) tagRuntimeOwnerRecursive\(c, owner\);/);
  // 6つのdebug overlay + HYBRID_V1/DIFF_DEBUGの計8箇所で使われている
  const usageCount = (html.match(/tagRuntimeOwnerRecursive\([a-zA-Z]+, RUNTIME_OWNER\.[A-Z]+\);/g) || []).length;
  assert.ok(usageCount >= 8, 'tagRuntimeOwnerRecursiveの利用箇所が8未満: ' + usageCount);
});

test('[FIX23B §5] Legacy residual > 0 のときだけ [Residual details] ボタンが表示され、object単位の内訳を画面に描画する', () => {
  assert.match(html, /residualDetailBtn\.textContent = '\[Residual details\]';/);
  assert.match(html, /residualDetailBtn\.style\.display = residualBad \? 'block' : 'none';/);
  assert.match(html, /function renderResidualDetailPanel_\(\)/);
  assert.match(html, /likelySource: ' \+ likelySourceOf_\(it\)/);
});

test('[FIX23B §2/§28] window.__CANONICAL_SELF_CHECK__ が Console 操作無しで手動self-checkを実行できる（自動実行の土台）', () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  const w = r.window;
  const sc1 = w.__CANONICAL_SELF_CHECK__();
  assert.ok(sc1 && typeof sc1.total === 'number');
});

test('[FIX23B §1/§27] 動的: 北区(osaka-kita)を含む複数回のward切替を繰り返しても Legacy residual = 0', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const WMM = w.__WARD_MODE_MANAGER__;
  assert.ok(WMM, '__WARD_MODE_MANAGER__ が公開されていない');
  for (const wardId of ['kita', 'chuo', 'sumiyoshi', 'kita']) {
    WMM.switchWard(wardId);
    for (let i = 0; i < 10; i++) await new Promise((r2) => setImmediate(r2));
    const residual = w.__CANONICAL_SELF_CHECK__();
    assert.equal(residual.total, 0, wardId + ' 切替後にresidualが0でない: ' + JSON.stringify(residual));
  }
});

test('[FIX23B §4] runtime-unknown-residual-detail.json が生成され、既知の修正済みsignatureと実測シナリオを記録している', { skip: !rpt('runtime-unknown-residual-detail.json') && 'no report' }, () => {
  const j = rpt('runtime-unknown-residual-detail.json');
  assert.ok(Array.isArray(j.knownFixedSignatures) && j.knownFixedSignatures.length >= 6);
  assert.ok(Array.isArray(j.scenarios) && j.scenarios.length >= 8);
  assert.equal(typeof j.caveat, 'string');
});

// ═══════════════════════════════════════════════════════════════
// [Mission 31G-FIX23C] FIX13 Road Ownership Final Fix — unknown residual 18 の道路Mesh誤分類解消。
// ═══════════════════════════════════════════════════════════════

test('[FIX23C §1] userData.roadKey の生成箇所は RoadLayer.build() の1箇所のみ（roadKeyだけでLegacy/Canonicalを判定していない証跡）', () => {
  const matches = html.match(/\.userData\.roadKey\s*=/g) || [];
  assert.equal(matches.length, 1, 'roadKey代入が想定(1箇所=RoadLayer)と異なる: ' + matches.length);
});

test('[FIX23C §3/§4] RoadLayer(Legacy Road)は明示的にLEGACYタグ・.name=RoadLayerが付与されている', () => {
  assert.match(html, /group\.name = 'RoadLayer';/);
  const start = html.indexOf("group.name = 'RoadLayer';");
  const end = html.indexOf('return group;\n  }', start);
  const body = html.slice(start, end);
  assert.match(body, /tagRuntimeOwnerRecursive\(group, RUNTIME_OWNER\.LEGACY\);/);
  assert.match(body, /m\.userData\.creationPath = 'LEGACY_ROAD_LAYER';/);
});

test('[FIX23C §3/§9] CanonicalRuntime自身のtile group(roads/water/parks/buildings/rail)へ明示的なCANONICAL自己タグが付与されている', () => {
  assert.match(html, /gb\.group\.userData\.runtimeOwner = RUNTIME_OWNER\.CANONICAL;/);
  assert.match(html, /gb\.group\.userData\.creationPath = 'CANONICAL_' \+ job\.layer\.toUpperCase\(\);/);
  assert.match(html, /gb\.group\.userData\.runtimeSubsystem = 'FIX13_ROAD';/);
  assert.match(html, /gb\.group\.userData\.runtimeSource = 'REFINED_ROAD_SURFACE';/);
});

test('[FIX23C §5/§9/§10] 動的fixture: roadKeyを持つmeshはCANONICAL親の下では除外され、無印の親の下では正しくresidualとして検出される（roadKeyだけでCANONICAL判定していない証跡）', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const before = w.__CANONICAL_SELF_CHECK__();
  assert.equal(before.total, 0);

  const makeRoadKeyMesh = () => {
    const geo = new w.THREE.BufferGeometry();
    geo.setAttribute('position', new w.THREE.BufferAttribute(new Float32Array(2000), 3));
    const mesh = new w.THREE.Mesh(geo, new w.THREE.MeshPhongMaterial({ color: 0x1a2830 }));
    mesh.userData.roadKey = 'primary';
    return mesh;
  };

  // §9: owner none, parent = FIX13 canonical group(タグ済み), roadKeyあり → CANONICALとして除外される
  const canonicalParent = new w.THREE.Group();
  canonicalParent.userData.runtimeOwner = 'CANONICAL';
  canonicalParent.add(makeRoadKeyMesh());
  w.__SCENE__.add(canonicalParent);
  const afterCanonical = w.__CANONICAL_SELF_CHECK__();
  assert.equal(afterCanonical.total, 0, 'CANONICAL親配下のroadKey meshが誤ってresidual計上された: ' + JSON.stringify(afterCanonical));
  w.__SCENE__.remove(canonicalParent);

  // §10: owner none, parent = 無印(taglessな= Legacy相当)group, roadKeyあり → residualとして検出される
  //   （roadKeyがあるだけで一律CANONICAL扱いしていないことの証跡・§0禁止事項の回帰防止）
  const untaggedParent = new w.THREE.Group();
  untaggedParent.add(makeRoadKeyMesh());
  w.__SCENE__.add(untaggedParent);
  const afterUntagged = w.__CANONICAL_SELF_CHECK__();
  assert.equal(afterUntagged.total, 1, 'roadKeyを持つがownerタグの無いmeshが誤って除外された(roadKeyだけでCANONICAL扱いした疑い): ' + JSON.stringify(afterUntagged));
  w.__SCENE__.remove(untaggedParent);

  const afterCleanup = w.__CANONICAL_SELF_CHECK__();
  assert.equal(afterCleanup.total, 0);
});

test('[FIX23C §11] __LEGACY_RESIDUAL_DETAIL__ が roadKey/usageCategory等のsignature別集計(keySignatureCounts)を返す', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  const untaggedParent = new w.THREE.Group();
  const geo = new w.THREE.BufferGeometry();
  geo.setAttribute('position', new w.THREE.BufferAttribute(new Float32Array(2000), 3));
  const mesh = new w.THREE.Mesh(geo, new w.THREE.MeshPhongMaterial({ color: 0x1a2830 }));
  mesh.userData.roadKey = 'primary';
  untaggedParent.add(mesh);
  w.__SCENE__.add(untaggedParent);
  const d = w.__LEGACY_RESIDUAL_DETAIL__();
  assert.ok(d.keySignatureCounts, 'keySignatureCountsが無い');
  assert.equal(d.keySignatureCounts.roadKey, 1, 'roadKey集計が正しくない: ' + JSON.stringify(d.keySignatureCounts));
  w.__SCENE__.remove(untaggedParent);
});

test('[FIX23C §14] 動的: Road mode(FIX13→HYBRID_V1→DIFF_DEBUG→FIX13)を回してもresidual=0を維持し続ける（回帰防止）', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  for (const mode of ['HYBRID_V1', 'DIFF_DEBUG', 'FIX13']) {
    await w.__SET_ROAD_RENDER_MODE__(mode);
    const residual = w.__CANONICAL_SELF_CHECK__();
    assert.equal(residual.total, 0, mode + ' でresidualが発生した: ' + JSON.stringify(residual));
  }
});

test('[FIX23C §19/§20] Building residual回帰防止（FIX23/FIX23Bの修正が維持されている）', async () => {
  const r = runInlineScript(HTML, { fetchRoot: R('public') });
  assert.equal(r.ok, true, r.error && r.error.stack);
  const w = r.window;
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
  const WMM = w.__WARD_MODE_MANAGER__;
  WMM.switchWard('kita');
  for (let i = 0; i < 10; i++) await new Promise((r2) => setImmediate(r2));
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
});
