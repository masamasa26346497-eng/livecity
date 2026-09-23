// tests/canonical-runtime-cutover.test.js
// [Mission 31G] ward-ux-v1.html への Canonical Runtime 統合の静的検証。
//   ブラウザ描画は自動化できないため、配線・feature flag・§0 遵守・旧 render 温存を文字列で確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const P = (...s) => path.join(PROJECT_ROOT, ...s);
const DEV = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.existsSync(DEV) ? fs.readFileSync(DEV, 'utf-8') : '';
const rpt = (n) => { const p = P('data', 'reports', n); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null; };

test('[31G-FIX2] feature flag: __CANONICAL_RUNTIME__ 既定 ON / setter / debug', () => {
  assert.match(html, /window\.__CANONICAL_RUNTIME__ === 'undefined'\) window\.__CANONICAL_RUNTIME__ = true/);
  assert.doesNotMatch(html, /window\.__CANONICAL_RUNTIME__ === 'undefined'\) window\.__CANONICAL_RUNTIME__ = false/);
  assert.match(html, /window\.__SET_CANONICAL_RUNTIME__ = function/);
  assert.match(html, /window\.__CANONICAL_RUNTIME_DEBUG__ = function/);
  assert.match(html, /window\.__CANONICAL_RUNTIME_COMPARE__ = function/);
});

test('[31G-FIX2] auto-init: ページを開くだけで有効化（Console 操作不要）', () => {
  assert.match(html, /autoInitCanonicalRuntime/);
  assert.match(html, /CanonicalRuntime\.init\(\)/);
  assert.match(html, /DOMContentLoaded['"]?,\s*go|document\.readyState === 'loading'/);
  // init() は __SET_CANONICAL_RUNTIME__ ではなく内部 setEnabled で ON にする
  assert.match(html, /init\(\)\s*\{[^}]*window\.__CANONICAL_RUNTIME__ !== false[^}]*setEnabled\(true\)/);
});

test('[31G-FIX2] 自動 fallback: 初期化失敗で legacy へ自動復帰（白画面にしない）', () => {
  assert.match(html, /function fallbackToLegacy\(reason\)/);
  assert.match(html, /\.catch\(\(e\) => fallbackToLegacy\('manifest fetch/);
  assert.match(html, /fallbackToLegacy\('scene attach/);
  // fallback で旧 layer 復帰
  assert.match(html, /fallbackToLegacy[\s\S]{0,400}toggleOldLayers\(false\)/);
});

test('[31G-FIX2] 画面ステータス UI + トグルボタン（Console を開かず状態が分かる）', () => {
  assert.match(html, /id = 'canonical-runtime-status'/);
  assert.match(html, /\[CANONICAL\]/);
  assert.match(html, /LEGACY FALLBACK/);
  assert.match(html, /Loading canonical/);
  assert.match(html, /toggleBtn\.addEventListener\('click'/);
  // LOD / tile 数を表示
  assert.match(html, /LOD: ' \+ lod/);
  assert.match(html, /Tiles: ' \+ tileCache\.size/);
});

test('[31G-FIX2/FIX3] 起動 self-check（§13/§16）: canonical mesh > 0 / legacy residual 検出（再hideしない）', () => {
  assert.match(html, /function runSelfCheck\(\)/);
  assert.match(html, /stats\.canonicalMesh/);
  // [Mission 31G-FIX23] classifyLegacyResidual は §1 の object単位詳細列挙(opts.detail)対応で
  //   引数を取るようになった（ロジック自体は §2 layer別内訳のまま拡張）。
  assert.match(html, /function classifyLegacyResidual\(opts\)/);       // §2 layer 別内訳
  assert.match(html, /legacy residual/);                              // §12 表示
  // §16: self-check は「見つける → ERROR 記録」。自動再 hide しない
  assert.doesNotMatch(html, /旧 layer がまだ可視 → 隠蔽を再実行/);
  // self-check を setEnabled 後にスケジュール
  assert.match(html, /setTimeout\(\(\) => \{ if \(enabled/);
});

test('[31G-FIX3] Render Ownership: __CANONICAL_OWNS_BASE__ を単一箇所で管理', () => {
  assert.match(html, /window\.__CANONICAL_OWNS_BASE__ = !!hidden/);   // toggleOldLayers が管理
  assert.match(html, /ownsBaseLayers: \(\) => enabled && phase !== 'fallback'/);
});

test('[31G-FIX3] §3: render loop の legacy update を ownership で停止', () => {
  // BuildingTileLayer.updateByCamera / WardModeManager.update は __CANONICAL_OWNS_BASE__ ガードの中
  assert.match(html, /if \(!window\.__CANONICAL_OWNS_BASE__\) \{\s*\n\s*BuildingTileLayer\.updateByCamera\(camera\);/);
});

test('[31G-FIX3] §10: camUpd の「mesh を復活させうる」legacy camera 連動を ownership で停止', () => {
  assert.match(html, /const canonicalOwns = !!window\.__CANONICAL_OWNS_BASE__;/);
  assert.match(html, /if \(!canonicalOwns && typeof CityTileLayer !== 'undefined'\)/);
  assert.match(html, /if \(!canonicalOwns && typeof CityBuildingLOD !== 'undefined'\) CityBuildingLOD\.setCameraDistance/);
  // RiverLayerV2 / ParkLayer は hide() で group ごと scene から外れるためガード不要（residual を生まない）
  // WaterSurfaceLayer（海）/ LandmarkLayer は canonical と共存（ガードしない）
  assert.match(html, /if \(typeof WaterSurfaceLayer !== 'undefined'\) WaterSurfaceLayer\.updateByCamera/);
});

test('[31G-FIX3] §9: switchWard は canonical 所有中に legacy building をロードしない', () => {
  assert.match(html, /if \(window\.__CANONICAL_OWNS_BASE__\) \{\s*\n\s*currentWardId = wardId;/);
  assert.match(html, /Canonical Runtime 所有中: legacy building はロードしない/);
});

test('[31G-FIX3] §4: layer トグルパネルが canonical 所有中に legacy show を呼ばない', () => {
  assert.match(html, /if \(window\.__CANONICAL_OWNS_BASE__ && \['buildings', 'roads', 'waterways', 'sea', 'parks', 'railways'\]\.includes\(key\)\)/);
  assert.match(html, /CanonicalRuntime\.setLayerVisible/);
});

test('[31G-FIX3/FIX23] §16/§23: self-check は per-frame 再hide せず / 内訳を ERROR 記録 / startup 後始末は bounded retry', () => {
  const start = html.indexOf('function runSelfCheck()');
  const block = html.slice(start, start + 2400);
  assert.doesNotMatch(block, /toggleOldLayers\(true\)/);          // §1: 毎フレーム再hideの誤魔化しをしない
  assert.match(block, /classifyLegacyResidual\(\)/);
  assert.match(block, /root cause/);
  // [Mission 31G-FIX23 §17/§23] 1回だけの cleanupTried フラグから、tile fetch が遅い環境向けに
  //   有限回(CLEANUP_RETRY_DELAYS_MS.length回)まで間隔を空けて再試行する方式へ強化した。
  //   「per-frameではない・有限回で諦める」という §23 の要件自体は不変。
  assert.match(block, /selfCheck\.cleanupAttempts/);
  assert.match(block, /CLEANUP_RETRY_DELAYS_MS/);
  assert.match(block, /attempts < CLEANUP_RETRY_DELAYS_MS\.length/);   // 無限リトライではない（bounded）
  assert.match(block, /phase = 'error'/);                         // §12: 自動正常扱いにしない
});

test('[31G-FIX3] §12: status UI が Legacy residual を常時表示 / N>0 で CANONICAL ERROR', () => {
  assert.match(html, /Legacy residual: 0/);
  assert.match(html, /\[CANONICAL ERROR\]/);
  assert.match(html, /Legacy residual: ' \+ rt/);
});

test('[31G-FIX3] §8: camera移動 / ward切替後に residual を再検証', () => {
  assert.match(html, /wardChanged \|\| cameraOrZoomMoved/);
  assert.match(html, /if \(enabled\) runSelfCheck\(\); \}, 700\)/);
});

test('[31G-FIX2/FIX3/FIX4] validator の全チェックが期待値', { skip: !rpt('canonical-runtime-validation.json') && 'no report' }, () => {
  const v = rpt('canonical-runtime-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  for (const k of [
    'defaultOn', 'autoInit', 'legacyAutoHide', 'autoFallback', 'statusUI', 'screenToggle', 'selfCheck', 'manualConsoleNotRequired',
    'renderOwnership', 'loopLegacyStopped', 'camUpdLegacyStopped', 'switchWardGuarded', 'selfCheckNoRehide', 'residualClassified',
    // FIX4
    'globalMapLayers', 'buildingSelectionScopeOnly', 'wardFilterRemoved', 'wardSwitchDoesNotReloadGlobal', 'buildingScopeDebug', 'cityModeCityWide',
    // FIX5
    'buildingUsagePaletteEnabled', 'sharedMaterialBuckets', 'fallbackUsesCanonicalPalette', 'wardScopeUnchanged', 'globalMapUnchanged', 'legacyResidualGuard',
    // FIX6
    'placementPolicyLookup', 'placementSuppressExcludesMesh', 'placementDebugApi', 'placementSourceGeometryUnchanged',
    // FIX7
    'perfInstrumentation', 'progressiveBuildBudget', 'fetchConcurrencyLimited', 'duplicateFetchGuard', 'manifestCachedOnce',
    'lodHysteresis', 'cameraDirtyThreshold', 'byteBudgetCache', 'staleRequestCancel', 'nearGlobalUsesMidTile', 'nearBuildingDistanceRing',
    // FIX8 / FIX8B
    'contrastPaletteStronger', 'buildingBaseMidtone', 'buildingWhitenReduced', 'canonicalStyleOwnership',
    'legacyStyleDoesNotOverrideCanonical', 'styleReassertOnDrift', 'styleDiagnoseAvailable',
    'styleOnlyNoGeometryChange', 'nearWhitenBelowMid',
    // FIX9
    'wardBuildingsPinned', 'cameraDoesNotUnloadSelectedWard', 'wardFullCoverage',
    'wardSwitchUnpinsPrevious', 'cityModeUnchanged', 'wardIndexLoadedOnce',
    // FIX12 / FIX13
    'roadRenderClassLoaded', 'roadVisualSurfaceStyle', 'roadsBucketedByRenderClass',
    'unknownNotFullRoad', 'roadPrimaryStaysOpaque', 'roadSourceGeometryUnchanged', 'roadVisualSurfaceDebug',
    'sidewalkMedianStylesApplied', 'refinedSurfaceFallbackToFix12',
  ]) {
    assert.equal(v.checks[k], true, 'check ' + k + ' が true でない');
  }
  // FIX4: 地図 4 layer に ward filter が無い
  for (const k of ['roadWardFilter', 'waterWardFilter', 'parkWardFilter', 'railWardFilter']) {
    assert.equal(v.checks[k], false, k + ' が true（地図を ward で削っている）');
  }
  // FIX9: LOD representation gap が無い
  assert.equal(v.checks.lodRepresentationGap, 0, 'ward LOD handoff gap');
  // FIX5: 白一色ビル・null usage material が無い
  assert.equal(v.checks.whiteOnlyBuildings, false, '建物がまだ白一色（§2 違反）');
  assert.equal(v.checks.nullUsageMaterial, 0, 'null usage material が残っている（§6 違反）');
});

test('[31G] CanonicalRuntime モジュールが存在し loop / picking に接続', () => {
  assert.match(html, /const CanonicalRuntime = \(function \(\) \{/);
  assert.match(html, /if \(typeof CanonicalRuntime !== 'undefined'\) CanonicalRuntime\.update\(\)/);
  assert.match(html, /CanonicalRuntime\.pickBuilding\(ray\)/);
  // adapter interface
  for (const m of ['update', 'setEnabled', 'isEnabled', 'pickBuilding', 'getDebug']) {
    assert.ok(html.includes(m), 'adapter method ' + m + ' が無い');
  }
});

test('[31G] §34: 旧 render コードを削除していない', () => {
  for (const re of [/const RiverLayerV2 = \(function/, /const RoadLayer = \(function/, /const ParkLayer = \(function/, /const BuildingTileLayer = \(function/, /ray\.intersectObjects\(bMesh,false\)/]) {
    assert.match(html, re);
  }
  // 旧 layer は hide/show で切替（破壊しない）
  assert.match(html, /RoadLayer\.hide\(\) : RoadLayer\.show\(\)/);
  assert.match(html, /BuildingTileLayer\.hide\(\) : BuildingTileLayer\.show\(\)/);
});

test('[31G] §0: CanonicalRuntime ブロックが projection / znorth-neg-v1 を書き換えていない', () => {
  const start = html.indexOf('const CanonicalRuntime = (function');
  const end = html.indexOf("console.log('[CanonicalRuntime] READY');");
  assert.ok(start >= 0 && end > start, 'CanonicalRuntime ブロックが抽出できない');
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /135\.52502|34\.604208|metersPerDegree|111320/);
  assert.doesNotMatch(block, /geoToThree\s*=|projection\s*=\s*\{/);
});

test('[31G/FIX4] §11: 建物のみ wardId フィルタ / 地図 4 layer は GLOBAL', () => {
  assert.match(html, /function buildingWardId\(\)/);
  assert.match(html, /if \(layer === 'buildings' && wardId\) \{\s*\n\s*feats = feats\.filter\(\(f\) => \(f\.attributes && f\.attributes\.wardId\) === wardId\)/);
  // roads/water/parks/rail に ward bbox フィルタが残っていない
  assert.doesNotMatch(html, /scope\.bbox && layer !== 'water'/);
  assert.doesNotMatch(html, /function wardScope\(\)/);
  assert.match(html, /const GLOBAL_LAYERS = new Set\(\['roads', 'water', 'parks', 'rail'\]\)/);
  assert.match(html, /const SELECTION_LAYERS = new Set\(\['buildings'\]\)/);
});

test('[31G-FIX4/FIX7/FIX9] §5/§6/§35: ward 切替は buildings tile のみ差し替え（GLOBAL 再fetchなし・UI を止めない）', () => {
  // FIX7 §35: 一括 dispose ではなく hide → LRU に任せる。FIX9: unpin も同時に。GLOBAL は触らない。
  assert.match(html, /for \(const \[k, e\] of tileCache\) if \(e\.layer === 'buildings'\) \{ e\.group\.visible = false; e\.pinnedByWard = null; \}/);
  assert.doesNotMatch(html, /for \(const \[k, e\] of \[\.\.\.tileCache\.entries\(\)\]\) \{\s*\n\s*if \(e\.layer === 'buildings'\) \{ disposeEntry/);
  // cache key: buildings は wardId 付き、GLOBAL は ward 非依存
  assert.match(html, /function tileKeyOf\(layer, band, tx, tz\)/);
  // [32N] buildings は wardId に加えて V1/V2 版も key に含める
  assert.match(html, /\(layer === 'buildings'\) \? \(base \+ '@' \+ \(buildingWardId\(\) \|\| 'city'\) \+ '#' \+ buildingsVersion\) : base/);
});

test('[31G-FIX4] §13: status / debug に Map Scope=GLOBAL / Building Scope', () => {
  assert.match(html, /Map: ' \+ mapScopeLabel\(\)/);
  assert.match(html, /Bldg: ' \+ buildingScopeLabel\(\)/);
  assert.match(html, /mapScope: mapScopeLabel\(\)/);
  assert.match(html, /globalLayers: \['roads', 'water', 'parks', 'rail'\]/);
});

test('[31G-FIX4] §4: City Mode は city-wide 建物（buildingWardId が null）', () => {
  assert.match(html, /function buildingWardId\(\)[\s\S]{0,200}if \(cityActive\) return null;/);
});

test('[31G-FIX5] §1/§3: 用途別 palette に 10 カテゴリ全てが定義されている', () => {
  const m = html.match(/const CR_USAGE_COLOR = \{([\s\S]*?)\n  \};/);
  assert.ok(m, 'CR_USAGE_COLOR が抽出できない');
  for (const k of ['residential_low', 'residential_mid', 'commercial', 'office', 'industrial', 'public', 'school', 'medical', 'hotel', 'other']) {
    assert.match(m[1], new RegExp('\\b' + k + ':\\s*0x[0-9a-fA-F]{6}'), k + ' の色が無い');
  }
});

test('[31G-FIX5] §1/§6: crUsageCategory は usageCategory を主キーにし、null / 未知コードは other へ寄せる', () => {
  const body = html.match(/function crUsageCategory\(a\) \{([\s\S]*?)\n  \}/)[1];
  const CR_USAGE_COLOR = { residential_low: 1, commercial: 1, school: 1, other: 1 };
  const crUsageCategory = new Function('a', 'CR_USAGE_COLOR', body);
  assert.equal(crUsageCategory({ usageCategory: 'commercial' }, CR_USAGE_COLOR), 'commercial');   // commercial → commercial
  assert.equal(crUsageCategory({ usageCategory: 'residential_low' }, CR_USAGE_COLOR), 'residential_low');
  assert.equal(crUsageCategory({ usageCategory: 'school' }, CR_USAGE_COLOR), 'school');
  assert.equal(crUsageCategory({ usageCategory: null }, CR_USAGE_COLOR), 'other');                // null → other
  assert.equal(crUsageCategory({ usageCategory: 'zzz-unknown' }, CR_USAGE_COLOR), 'other');       // 未知 → other
  assert.equal(crUsageCategory({}, CR_USAGE_COLOR), 'other');
});

// [Mission 35A] buildings branch は固定バイト幅で切らない。
//   後から行が足されると窓の外へ出て、assert が黙って別の箇所を見てしまう。
//   次の `} else if (layer === ...` までを branch とみなす。
function buildingsBranch() {
  const s = html.indexOf("} else if (layer === 'buildings') {");
  if (s < 0) return '';
  const e = html.indexOf('} else if (layer ===', s + 10);
  return html.slice(s, e > s ? e : s + 4000);
}

test('[31G-FIX5] §2/§5: buildings branch は source で分岐せず usageCategory で色分けし、白一色へ落とさない', () => {
  const s = html.indexOf("} else if (layer === 'buildings') {");
  assert.ok(s >= 0, 'buildings branch が無い');
  const block = buildingsBranch();
  assert.match(block, /const cat = crUsageCategory\(a\);/);
  assert.doesNotMatch(block, /presetWallColor\(a\.usage\)/);         // §2 白一色の原因を撤去
  assert.doesNotMatch(block, /a\.source === 'osm-fallback'/);        // §5 fallback を別扱いしない
  assert.doesNotMatch(block, /msBlend\(COL\.white, 0xe6e9e5/);       // §5 灰色分岐を撤去
});

test('[31G-FIX5] §7/§8: usageCategory×band で material を共有（feature ごとに new しない）', () => {
  assert.match(html, /const crBuildingMats = new Map\(\);/);
  assert.match(html, /function crBuildingMaterial\(cat, band\)/);
  assert.match(html, /m\.userData\.crShared = true;/);
  assert.match(html, /if \(!\(x\.userData && x\.userData\.crShared\)\) x\.dispose\(\)/);   // 共有 material は dispose しない
  // buildings 分岐の末尾までを見る（固定幅だと後続ミッションの追記で範囲外になる。
  //   [Mission 34A] 高 LOD の抑制分岐が入って 2600 字では届かなくなったため、分岐の終端で切る）
  const s = html.indexOf("} else if (layer === 'buildings') {");
  const e = html.indexOf("} else if (layer === 'rail') {", s);
  assert.ok(e > s, 'buildings 分岐の終端が見つからない');
  // [Mission 35H] colors を渡す引数が増えて複数行になった。共有 material を使うことは不変。
  assert.match(html.slice(s, e), /material: crBuildingDiffGray \? crBuildingGrayMaterial\(\) : crBuildingMaterial\(cat, band\),/);
});

test('[31G-FIX5] §9: LOD で白寄せ量のみ変える（カテゴリは LOD で変えない）', () => {
  assert.match(html, /const CR_USAGE_WHITEN = \{ far: [\d.]+, mid: [\d.]+, near: [\d.]+ \}/);
  assert.doesNotMatch(html, /function crUsageCategory\(a, band\)/);
});

test('[31G-FIX5] §13: canonical pick の d は usageCategory / normalizedUsage を null にしない', () => {
  assert.match(html, /usageCategory: crUsageCategory\(a\), usageLabel: a\.usageLabel \|\| null/);
  assert.match(html, /normalizedUsage: \(typeof a\.normalizedUsage === 'string' && a\.normalizedUsage\) \? a\.normalizedUsage : 'unknown'/);
});

test('[31G-FIX5] §10/§11: ward scope / GLOBAL map / legacy residual guard は不変', () => {
  assert.match(html, /function buildingWardId\(\)/);
  assert.match(html, /const GLOBAL_LAYERS = new Set\(\['roads', 'water', 'parks', 'rail'\]\)/);
  assert.match(html, /window\.__CANONICAL_OWNS_BASE__ = !!hidden/);
});

test('[31G-FIX6] §23/§24: placement policy を precompute tile から lookup（毎フレーム計算しない）', () => {
  assert.match(html, /async function ensurePlacement\(tx, tz\)/);
  assert.match(html, /building-placement\/tile_\$\{tx\}_\$\{tz\}\.json/);
  // 1 度だけ fetch（placementTiles で guard）
  assert.match(html, /const placementTiles = new Map\(\)/);
  assert.doesNotMatch(html, /intersect[\s\S]{0,40}every frame|毎フレーム[\s\S]{0,20}intersection/);
});

test('[31G-FIX6] §12/§13: ward filter の後に placement filter（2 段）', () => {
  const branch = buildingsBranch();
  assert.match(branch, /const pp = placementPolicy\.get\(f\.canonicalId\);/);
  // ensurePlacement は wardId フィルタ後・mesh 構築前
  assert.match(html, /f\.attributes\.wardId\) === wardId[\s\S]{0,220}await ensurePlacement\(tx, tz\)/);
});

test('[31G-FIX6] §14: SUPPRESS は mesh にも footprint(pick) にも入れない', () => {
  const branch = buildingsBranch();
  assert.match(branch, /pp\.policy === 'SUPPRESS'\) \{[\s\S]{0,40}suppressedInTile\+\+;[\s\S]{0,400}continue;/);
  // REVIEW / EXEMPT / DISPLAY は footprints に入る（pick 可）
  assert.match(branch, /placement: pp \? pp\.policy : 'DISPLAY'/);
  assert.match(html, /function pickSuppressed\(px, pz\)/);
});

test('[31G-FIX6] §9/§11: runtime は canonical / source geometry を書き換えない', () => {
  const start = html.indexOf('const CanonicalRuntime = (function');
  const end = html.indexOf("console.log('[CanonicalRuntime] READY');");
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /\.coordinates\s*=\s*[^=]/);   // feature 座標の代入なし
  assert.doesNotMatch(block, /writeFile|fs\.|build-canonical/);
});

test('[31G-FIX6] §19: placement 集計を status / debug に出す（Console 不要）', () => {
  assert.match(html, /getPlacementDebug\(\)/);
  assert.match(html, /window\.__PLACEMENT_DEBUG__ = function/);
  assert.match(html, /抑制 水/);
  assert.match(html, /placement: \{[\s\S]{0,200}suppressedVisible/);
});

// ── Mission 31G-FIX7 全体高速化 ──
test('[31G-FIX7] §1/§41: 性能ボトルネックを自動計測（Console 不要）', () => {
  assert.match(html, /window\.__CANONICAL_RUNTIME_PERF__ = function/);
  assert.match(html, /getPerf\(\)/);
  assert.match(html, /firstMapVisibleMs|firstMapMs/);
  assert.match(html, /firstBuildingVisibleMs|firstBuildingMs/);
  assert.match(html, /frameP95/);
  // firstMap / firstBuilding のマーカーが drainBuild にある
  assert.match(html, /perf\.firstMapMs = Math\.round\(performance\.now\(\) - perf\.startT\)/);
  assert.match(html, /perf\.firstBuildingMs = Math\.round\(performance\.now\(\) - perf\.startT\)/);
});

test('[31G-FIX7] §2: layer 別コスト計測（fetch/parse/mesh/tris）', () => {
  assert.match(html, /byLayer: Object\.fromEntries\(LAYER_KEYS\.map/);
  assert.match(html, /lp\.fetchMs \+= fetchMs; lp\.parseMs \+= parseMs/);
  assert.match(html, /lp\.meshMs \+= meshMs/);
});

test('[31G-FIX7] §5/§6: frame budget 付き progressive build（1 frame に集中させない）', () => {
  assert.match(html, /const BUILD_BUDGET_MS = \d+;/);
  assert.match(html, /function drainBuild\(now\)/);
  assert.match(html, /while \(buildQ\.length && frameBuildMs < BUILD_BUDGET_MS\)/);
  // fetch/parse と mesh build が分離されている
  assert.match(html, /async function fetchAndParse\(job\)/);
  assert.match(html, /function buildGroup\(layer, band, feats\)/);
});

test('[31G-FIX7] §7/§33: fetch concurrency 制御 + 優先度キュー', () => {
  assert.match(html, /const MAX_CONCURRENT_FETCH = \d+;/);
  assert.match(html, /function pumpFetch\(\)/);
  assert.match(html, /while \(activeFetches < MAX_CONCURRENT_FETCH && fetchQ\.length\)/);
  assert.match(html, /const LAYER_PRIO = \{ water: 0, roads: 1, rail: 2, parks: 3, buildings: 4 \}/);
});

test('[31G-FIX7] §8: 重複 fetch 防止（loading/loaded/queued を一元管理）', () => {
  assert.match(html, /const queued = new Set\(inflight\);/);
  assert.match(html, /if \(queued\.has\(k\)\) continue;/);
});

test('[31G-FIX7] §9: manifest は 1 回のみ（ward/camera/zoom で再取得しない）', () => {
  assert.match(html, /async function ensureManifest\(\) \{\s*\n\s*if \(manifest\) return manifest;/);
});

test('[31G-FIX7] §27: LOD hysteresis（mid⇔near 振動防止）', () => {
  assert.match(html, /const BAND_HYST_M = \d+;/);
  assert.match(html, /if \(currentBand === 'near'\) return \(d <= BAND\.midM \+ h\)/);
});

test('[31G-FIX7] §24/§25/§26: camera dirty + refresh throttle + settle', () => {
  assert.match(html, /const CAM_MOVE_EPS_M = \d+;/);
  assert.match(html, /const moved = \(lastTgtX == null\) \|\| Math\.hypot/);
  assert.match(html, /settleTimer = setTimeout/);
  assert.match(html, /const SETTLE_MS = \d+;/);
});

test('[31G-FIX7] §22/§23: byte-budget LRU（visible / Ward pin は evict しない・shared material は dispose しない）', () => {
  assert.match(html, /const MAX_CACHE_MB = \d+;/);
  assert.match(html, /\.filter\(\(\[, e\]\) => !e\.group\.visible && !\(e\.pinnedByWard && e\.pinnedByWard === lastWard\)\)/);
  // shared material 保護（FIX5 由来）を維持
  assert.match(html, /if \(!\(x\.userData && x\.userData\.crShared\)\) x\.dispose\(\)/);
});

test('[31G-FIX7] §34: stale request cancel（AbortController + wantSet 外を破棄）', () => {
  assert.match(html, /new AbortController\(\)/);
  assert.match(html, /function drainStaleQueues\(\)/);
  assert.match(html, /for \(const \[k, ac\] of abortByKey\) if \(!wantSet\.has\(k\)\)/);
});

test('[31G-FIX7] §15/§18: near band の GLOBAL 地図は mid tile（near/roads 1.4MB を回避）', () => {
  assert.match(html, /if \(band === 'near'\) return GLOBAL_LAYERS\.has\(layer\) \? 'mid' : 'near';/);
});

test('[31G-FIX7] §10/§11: near band 建物は距離リング（内側 near tile / 外側 far tile）', () => {
  assert.match(html, /if \(layer === 'buildings' && currentBand === 'near'\) \{/);
  assert.match(html, /want\.push\(\['buildings', 'far', tx, tz\]\)/);
  assert.match(html, /reach = Math\.min\(reach, band === 'near' \? 1300/);
});

test('[31G-FIX7] §0: 高速化しても canonical geometry / 色 / placement / ward scope を落とさない', () => {
  assert.match(html, /const CR_USAGE_COLOR = \{/);                 // 用途色維持
  assert.match(html, /async function ensurePlacement\(tx, tz\)/); // placement 維持
  assert.match(html, /function buildingWardId\(\)/);              // ward scope 維持
  assert.match(html, /const GLOBAL_LAYERS = new Set\(\['roads', 'water', 'parks', 'rail'\]\)/);
  assert.match(html, /window\.__CANONICAL_OWNS_BASE__ = !!hidden/); // legacy residual guard 維持
});

test('[31G-FIX7] §38: 性能 HUD を status に常時表示（FPS / frame ms / tri / draw / MB）', () => {
  assert.match(html, /' fps　'/);
  assert.match(html, /' ms　'/);
  assert.match(html, /Loading detail…/);
});

// ── Mission 31G-FIX8B 白飛び根本修正（style / lighting のみ）──
test('[31G-FIX8B] §2/§3: 白飛びの主因を潰す — 建物基色を中間トーンへ（pale パステルを廃止）', () => {
  const m = html.match(/const CR_USAGE_COLOR = \{([\s\S]*?)\n  \};/);
  assert.ok(m, 'CR_USAGE_COLOR が抽出できない');
  // pale パステル（輝度 ~0.85）が原因だった → CR パレットから廃止（legacy PRESET_WALL_COLOR は別物なので触らない）
  assert.doesNotMatch(m[1], /0xf0d9a8|0xf2c9a0|0xa8dcea/);
  // 中間トーンの基色
  assert.match(m[1], /residential_low: 0xcaa870,/);
  assert.match(m[1], /office:\s*0x6d93c4,/);
  // カテゴリ判定ロジックは FIX5 のまま
  assert.match(html, /function crUsageCategory\(a\)/);
  assert.match(html, /return \(typeof c === 'string' && CR_USAGE_COLOR\[c\]\) \? c : 'other';/);
});

test('[31G-FIX8B] §9: FAR/MID/NEAR 白寄せ（NEAR < MID < FAR・NEAR を白くしすぎない）', () => {
  const m = html.match(/const CR_USAGE_WHITEN = \{ far: ([\d.]+), mid: ([\d.]+), near: ([\d.]+) \}/);
  assert.ok(m, 'CR_USAGE_WHITEN が抽出できない');
  const far = +m[1], mid = +m[2], near = +m[3];
  assert.ok(near < mid && mid < far, `near(${near}) < mid(${mid}) < far(${far}) であること`);
  assert.ok(near <= 0.2, 'near を白くしすぎない（<= 0.2）');
});

test('[31G-FIX8B] §5/§6/§10/§17: canonical style profile（exposure + ambient/hemi + sun）を適用・可逆', () => {
  assert.match(html, /const CR_STYLE = \{ exposure: [\d.]+, hemi: [\d.]+, sun: [\d.]+, fill: [\d.]+ \};/);
  // ambient/hemi を下げ、directional(sun) を上げる
  const cs = html.match(/const CR_STYLE = \{ exposure: ([\d.]+), hemi: ([\d.]+), sun: ([\d.]+), fill: ([\d.]+) \};/);
  assert.ok(+cs[2] < 1.0, 'hemi を模型昼 1.02 より下げる');
  assert.ok(+cs[3] > 1.1, 'sun を模型昼 1.08 より上げる（面の陰影）');
  assert.ok(+cs[1] < 1.0, 'exposure を模型昼 1.05 より下げる');
  assert.match(html, /if \(hidden\) applyCanonicalExposure\(\); else restoreLegacyExposure\(\);/);
  assert.match(html, /hemiLight\.intensity = CR_STYLE\.hemi/);
  assert.match(html, /sun\.intensity = CR_STYLE\.sun/);
  // 可逆: legacy 復帰で元値へ
  assert.match(html, /function restoreLegacyExposure\(\)[\s\S]{0,600}hemiLight\.intensity = __legacyStyle\.hemi/);
  assert.match(html, /sun\.intensity = __legacyStyle\.sun/);
});

test('[31G-FIX8B] §16/§18: applyModelStyle / applyTimeOfDay で白へ戻されても drift 再適用', () => {
  assert.match(html, /const hemiDrift = /);
  assert.match(html, /if \(expDrift \|\| hemiDrift \|\| sunDrift\) applyCanonicalExposure\(\);/);
  // 模型昼のみ・canonical 所有中のみ
  assert.match(html, /if \(window\.__CANONICAL_OWNS_BASE__ && crExposureApplicable\(\)\) \{/);
});

test('[31G-FIX8B] §4: 白飛び診断（Console 入力不要）', () => {
  assert.match(html, /window\.__CANONICAL_STYLE_DIAGNOSE__ = function/);
  assert.match(html, /styleDiagnose\(opts\)/);
  // 色経路（base → afterWhiten）と lighting / renderer / fog を返す
  assert.match(html, /afterWhiten: hx\(after\)/);
  assert.match(html, /approxTotalIrradiance:/);
  assert.match(html, /clipsToWhite:/);
});

test('[31G-FIX8B] §7/§14: 建物は lighting 対応 material・立体感は directional shading（outline 追加なし）', () => {
  // MeshLambertMaterial（lighting 効く）を使用、MeshBasicMaterial 主体でない
  // [Mission 35H] vertexColors（面ごとの明暗）が付いたが、lighting 対応の Lambert であることは不変。
  assert.match(html, /new THREE\.MeshLambertMaterial\(\{ color: col, side: THREE\.DoubleSide, vertexColors: depthEnabled\(\) \}\)/);
  assert.match(html, /buildingMaterialType: 'MeshLambertMaterial'/);
});

test('[31G-FIX8B] §0/§21: geometry / mesh 数は不変（style / lighting のみ変更）', () => {
  // [Mission 35H] pushExtrude に colors（頂点カラー）が、meshFromPositions に colors 渡しが増えた。
  //   positions の積み方・mesh 数・三角形数は不変（頂点カラーは attribute であって geometry ではない）。
  assert.match(html, /function pushExtrude\(positions, geometryType, coordinates, h, colors\)/);
  assert.match(html, /function pushPolygon\(positions, geometryType, coordinates, yLevel\)/);
  assert.match(html, /material: crBuildingDiffGray \? crBuildingGrayMaterial\(\) : crBuildingMaterial\(cat, band\),/);
  assert.match(html, /colors: bucket\.col,/);
  // CanonicalRuntime ブロック内で新規ライト・outline mesh を作っていない
  const s = html.indexOf('const CanonicalRuntime = (function');
  const e = html.indexOf("console.log('[CanonicalRuntime] READY');");
  const block = html.slice(s, e);
  assert.doesNotMatch(block, /new THREE\.(Directional|Ambient|Hemisphere)Light/);
  assert.doesNotMatch(block, /new THREE\.EdgesGeometry|new THREE\.WireframeGeometry/);
});

test('[31G-FIX8B] §2/§15: style / renderer 状態を getDebug で確認できる', () => {
  assert.match(html, /buildingBaseColors: \{ \.\.\.CR_USAGE_COLOR \}/);
  assert.match(html, /lights: \{[\s\S]{0,120}hemi:/);
  assert.match(html, /toneMapping: \(typeof renderer/);
});

// ── Mission 31G-FIX9 Ward Mode 一区全建物固定表示 ──
test('[31G-FIX9] §2: Ward 選択で区の全 building tile を want に入れる（camera で減らさない）', () => {
  // [32N] ward index は建物版（V1/V2）に対応する base から読む
  assert.match(html, /const bBase = buildingDataBase\(\);/);
  assert.match(html, /fetch\(bBase \+ '\/building-ward-index\.json'\)/);
  assert.match(html, /const wardTiles = \(wardId && wardIndex && wardIndex\[wardId\]\) \? wardIndex\[wardId\]\.tiles : null;/);
  assert.match(html, /if \(layer === 'buildings' && wardTiles\) \{[\s\S]{0,400}for \(const tk of wardTiles\) \{[\s\S]{0,200}want\.push\(\['buildings', 'mid', tx, tz\]\)/);
  // City Mode の camera-bounded LOD へ入らない
  assert.match(html, /continue;   \/\/ §8: City Mode の camera-bounded LOD へは入らない/);
});

test('[31G-FIX9] §3: camera move / zoom / rotate で選択区 tile を hide/dispose しない', () => {
  // ward tile は常に wantSet に入る（mid は毎回 push）→ 可視 & pin
  assert.match(html, /if \(e\.band === 'mid' && e\.tx != null && wardTiles\.has\(e\.tx \+ '_' \+ e\.tz\)\) e\.pinnedByWard = wardId;/);
  // evictLRU が pin を除外
  assert.match(html, /\.filter\(\(\[, e\]\) => !e\.group\.visible && !\(e\.pinnedByWard && e\.pinnedByWard === lastWard\)\)/);
});

test('[31G-FIX9] §4/§21: progressive load（一区を同期一括生成しない）', () => {
  // 既存の fetch queue + frame budget build を使う（新規同期ロードなし）
  assert.match(html, /function pumpFetch\(\)/);
  assert.match(html, /while \(buildQ\.length && frameBuildMs < BUILD_BUDGET_MS\)/);
  // ward tile も jobPrio（camera 中心距離）で優先度付け
  assert.match(html, /fetchQ\.push\(\{ key: k, layer, band, tx, tz, prio: jobPrio\(layer, tx, tz/);
});

test('[31G-FIX9] §6/§7: Ward 切替で旧区 unpin・新区 pin。同区再選択は cache 即再表示', () => {
  assert.match(html, /for \(const \[k, e\] of tileCache\) if \(e\.layer === 'buildings'\) \{ e\.group\.visible = false; e\.pinnedByWard = null; \}/);
  // 同区: tileCache に残っていれば cached.group.visible = true（既存の enqueue ループ）
  assert.match(html, /const cached = tileCache\.get\(k\);\s*\n\s*if \(cached\) \{ cached\.group\.visible = true; cached\.lastUse = performance\.now\(\); continue; \}/);
});

test('[31G-FIX9] §10/§11: 遠距離も必ず representation あり・LOD handoff は new ready → old hide', () => {
  // 区全 tile = mid（常時）。near は camera 近傍のみ追加（mid を消さない）
  assert.match(html, /const WARD_NEAR_REACH_M = \d+;/);
  assert.match(html, /if \(nearBand && Math\.hypot\([\s\S]{0,80}<= WARD_NEAR_REACH_M\)/);
  // near build 完了で mid を隠す（逆順ではない）
  assert.match(html, /job\.band === 'near'\) \{ const ms = tileCache\.get\('mid\/buildings\/'[\s\S]{0,80}ms\.group\.visible = false;/);
  assert.match(html, /job\.band === 'mid'\) \{ const ns = tileCache\.get\('near\/buildings\/'[\s\S]{0,80}gb\.group\.visible = false;/);
});

test('[31G-FIX9] §12/§13/§14: expected / loaded / represented を追跡し status 表示', () => {
  assert.match(html, /function updateWardLoadStat\(\)/);
  assert.match(html, /wardLoad\.renderableExpected = idx\.renderableCount;/);
  assert.match(html, /wardLoad\.ready = \(built >= wardLoad\.tilesExpected/);
  assert.match(html, /Bldg ' \+ nm \+ ': ' \+ wardLoad\.tilesBuilt \+ '\/' \+ wardLoad\.tilesExpected/);
  assert.match(html, /Ward buildings ready/);
  assert.match(html, /wardBuildings: wardLoad\.wardId \?/);
});

test('[31G-FIX9] §8: City Mode の従来 LOD（far mass ring）は不変', () => {
  // ward-index 無し / City Mode では従来の near-ring + far-mass
  assert.match(html, /if \(layer === 'buildings' && currentBand === 'near'\) \{\s*\n\s*const Rf = tileRange\('buildings', 'far'\)/);
  assert.match(html, /want\.push\(\['buildings', 'far', tx, tz\]\)/);
});

test('[31G-FIX9] §15/§16/§17/§18: placement policy / usage color / selection scope / GLOBAL map 維持', () => {
  assert.match(html, /async function ensurePlacement\(tx, tz\)/);           // placement 維持
  assert.match(html, /const CR_USAGE_COLOR = \{/);                          // usage color 維持
  assert.match(html, /if \(layer === 'buildings' && wardId\) \{[\s\S]{0,120}f\.attributes\.wardId\) === wardId/); // selection scope（区外除外）維持
  assert.match(html, /const GLOBAL_LAYERS = new Set\(\['roads', 'water', 'parks', 'rail'\]\)/);  // GLOBAL map 維持
});

test('[31G-FIX9] §19/§20: cache/memory — pin は mid tile 主体・raw payload 解放', () => {
  // build 後に feats（raw JSON）を解放
  assert.match(html, /job\.feats = null;/);
  // pin されるのは mid（区全域・~43KB）。near は非 pin（camera 近傍・evictable）
  assert.match(html, /if \(e\.band === 'mid' && e\.tx != null && wardTiles\.has/);
  assert.doesNotMatch(html, /if \(e\.band === 'near'[\s\S]{0,40}e\.pinnedByWard = wardId/);
});

test('[31G-FIX9] building-ward-index データ整合（precompute 済みのとき）', { skip: !fs.existsSync(P('data', 'processed', 'osaka-city', 'derived', 'building-ward-index.json')) && 'no index' }, () => {
  const wi = JSON.parse(fs.readFileSync(P('data', 'processed', 'osaka-city', 'derived', 'building-ward-index.json'), 'utf-8'));
  assert.equal(Object.keys(wi.wards).length, 24, '24 区');
  for (const [w, v] of Object.entries(wi.wards)) {
    assert.ok(v.tileCount === v.tiles.length && v.tileCount > 0, w + ' tile 一覧');
    assert.ok(v.renderableCount === v.buildingCount - v.suppressCount, w + ' renderable = building - suppress（§15）');
    assert.ok(v.renderableCount > 0, w + ' renderable > 0');
  }
  // public にも配置
  assert.ok(fs.existsSync(P('public', 'map-data', 'osaka-city', 'derived', 'building-ward-index.json')), 'public 配置');
});

test('[31G-FIX7] §42: canonical-runtime-performance validator が PASS', { skip: !rpt('canonical-runtime-performance.json') && 'no report' }, () => {
  const v = rpt('canonical-runtime-performance.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.duplicateFetch, 0);
  assert.equal(v.checks.manifestReload, 0);
  assert.equal(v.checks.frameIdleRefresh, 0);
  assert.equal(v.checks.globalReloadOnWardSwitch, 0);
  assert.equal(v.checks.legacyResidualGuard, 1);
  assert.equal(v.checks.placementPolicyActive, 1);
  assert.equal(v.checks.usagePaletteActive, 1);
  assert.equal(v.runtimeGeometryMissing, 0);
});

test('[31G] §14/§15: LOD band + tile streaming + LRU', () => {
  assert.match(html, /BAND = \{ farM: 9000, midM: 3500 \}/);
  assert.match(html, /function evictLRU\(\)/);
  assert.match(html, /TILE_KEEP/);
  assert.match(html, /THROTTLE_MS/);
});

test('[31G] §20 debug API が必須キーを返す', () => {
  for (const k of ['loadedTiles', 'visibleBuildings', 'visibleRoadFeatures', 'visibleWaterFeatures', 'visibleParkFeatures', 'visibleRailFeatures', 'vertices', 'triangles', 'drawCalls', 'fallbackCounts']) {
    assert.ok(html.includes(k + ':') || html.includes(k), 'debug key ' + k + ' が無い');
  }
});

test('[31G] validator PASS / production・protected 不変', { skip: !rpt('canonical-runtime-validation.json') && 'no report' }, () => {
  const v = rpt('canonical-runtime-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.moduleWired, true);
  assert.equal(v.checks.oldRenderIntact, true);
  assert.equal(v.checks.productionUnchanged, true);
  assert.equal(v.checks.protectedUnchanged, true);
  assert.equal(v.checks.derivedPublicPresent, true);
});

test('[31G] derived public data: far/mid/near × 5 layer + rail-stations', { skip: !rpt('derived-public-build.json') && 'no report' }, () => {
  const b = rpt('derived-public-build.json');
  assert.equal(b.RESULT, 'PUBLISHED');
  assert.deepEqual(b.lods, ['far', 'mid', 'near']);
  assert.ok(b.files > 3000);
  const idxPath = P('public', 'map-data', 'osaka-city', 'derived', 'manifest.json');
  assert.ok(fs.existsSync(idxPath));
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
  assert.ok(idx.lodDistanceBands && idx.lodDistanceBands.farM === 9000);
  assert.ok(fs.existsSync(P('public', 'map-data', 'osaka-city', 'derived', 'rail-stations.json')));
});

test('[31G] protected HTML に canonical runtime の混入なし（production は 32U cutover で promoted build）', () => {
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = P('public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(h, /CanonicalRuntime|__CANONICAL_RUNTIME__|osaka-city\/derived/);
  }
});
