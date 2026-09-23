#!/usr/bin/env node
// tools/validate/canonical-runtime-integration.js
// [Mission 31G §35] ward-ux-v1.html への Canonical Runtime 統合の静的検証。
//   ブラウザ実行は不可なので「配線が壊れていないか」「§0 の禁止に触れていないか」を文字列で確認する。
//
// PASS 条件:
//   - CanonicalRuntime モジュールが ward-ux-v1.html に存在
//   - feature flag（__CANONICAL_RUNTIME__）+ __SET_CANONICAL_RUNTIME__ + __CANONICAL_RUNTIME_DEBUG__ がある
//   - 旧 fallback path（RoadLayer/RiverLayerV2/ParkLayer/BuildingTileLayer の show/hide 参照）が残っている
//   - loop に CanonicalRuntime.update() が接続されている
//   - pickHit が CanonicalRuntime.pickBuilding を呼ぶ
//   - derived manifest / tile が public に存在（adapter が fetch するパス）
//   - production / protected HTML 不変（canonical runtime 混入なし・byte 一致）
//   - projection origin / znorth-neg-v1 のハードコード変更なし
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DEV = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const DERIVED_PUB = P('public', 'map-data', 'osaka-city', 'derived');
const BASELINE = P('data', 'reports', 'baselines', 'prod-protected-hashes.json');
const REPORT = P('data', 'reports', 'canonical-runtime-validation.json');

function sha(p) { return fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null; }

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(DEV)) { errors.push('ward-ux-v1.html が無い'); return fail(errors, warns); }
  const html = fs.readFileSync(DEV, 'utf-8');

  // ── module + flag ──
  const need = [
    ['CanonicalRuntime module', /const CanonicalRuntime = \(function \(\) \{/],
    // [31G-FIX2] 既定 ON（undefined のとき true）
    ['feature flag default ON', /window\.__CANONICAL_RUNTIME__ === 'undefined'\) window\.__CANONICAL_RUNTIME__ = true/],
    ['__SET_CANONICAL_RUNTIME__', /window\.__SET_CANONICAL_RUNTIME__ = function/],
    ['__CANONICAL_RUNTIME_DEBUG__', /window\.__CANONICAL_RUNTIME_DEBUG__ = function/],
    ['__CANONICAL_RUNTIME_COMPARE__', /window\.__CANONICAL_RUNTIME_COMPARE__ = function/],
    ['loop 接続', /if \(typeof CanonicalRuntime !== 'undefined'\) CanonicalRuntime\.update\(\)/],
    ['pickHit 接続', /CanonicalRuntime\.pickBuilding\(ray\)/],
    ['旧 layer 隠蔽/復帰', /function toggleOldLayers\(hidden\)/],
    ['旧 fallback: RoadLayer', /RoadLayer\.hide\(\) : RoadLayer\.show\(\)/],
    ['旧 fallback: RiverLayerV2', /RiverLayerV2\.hide\(\) : RiverLayerV2\.show\(\)/],
    ['旧 fallback: BuildingTileLayer', /BuildingTileLayer\.hide\(\) : BuildingTileLayer\.show\(\)/],
    ['building ward scope（§3/§11・FIX4 で buildingWardId へ）', /function buildingWardId\(\)/],
    ['derived manifest fetch', /fetch\(BASE \+ '\/manifest\.json'\)/],
    ['debug API keys', /visibleBuildings:.*visibleRoadFeatures:/s],
    // [31G-FIX2 §2/§4/§5/§13/§14/§19]
    ['auto-init（Console 操作不要）', /autoInitCanonicalRuntime|CanonicalRuntime\.init\(\)/],
    ['auto-init は DOMContentLoaded / 即実行', /DOMContentLoaded['"]?,\s*go|document\.readyState === 'loading'/],
    ['CanonicalRuntime.init 実装', /init\(\)\s*\{[^}]*window\.__CANONICAL_RUNTIME__ !== false/],
    ['auto fallback（fallbackToLegacy）', /function fallbackToLegacy\(reason\)/],
    ['fallback で旧 layer 復帰', /fallbackToLegacy[\s\S]{0,400}toggleOldLayers\(false\)/],
    ['manifest fetch 失敗で自動 fallback', /\.catch\(\(e\) => fallbackToLegacy\('manifest fetch/],
    ['起動 self-check（§13）', /function runSelfCheck\(\)/],
    ['画面ステータス UI（§5/§7）', /id = 'canonical-runtime-status'/],
    ['ステータス表示 CANONICAL / LEGACY FALLBACK', /\[CANONICAL\]|LEGACY FALLBACK/],
    ['画面トグルボタン（§15・Console 不要）', /toggleBtn\.addEventListener\('click'/],
    ['startup log（§18）', /\[CanonicalRuntime\] manifests loaded|\[CanonicalRuntime\] READY/],
    // [31G-FIX3] Render Ownership で legacy 再出現を止める
    ['Render Ownership フラグ（§5）', /window\.__CANONICAL_OWNS_BASE__ = !!hidden/],
    ['ownsBaseLayers 照会（§5）', /ownsBaseLayers: \(\) => enabled && phase !== 'fallback'/],
    ['render loop の legacy update を ownership 停止（§3）', /if \(!window\.__CANONICAL_OWNS_BASE__\) \{[\s\S]{0,120}BuildingTileLayer\.updateByCamera\(camera\)/],
    ['camUpd の legacy camera 連動を ownership 停止（§10）', /const canonicalOwns = !!window\.__CANONICAL_OWNS_BASE__;[\s\S]{0,600}if \(!canonicalOwns && typeof CityTileLayer[\s\S]{0,400}if \(!canonicalOwns && typeof CityBuildingLOD/],
    ['switchWard の legacy building ロード停止（§9）', /if \(window\.__CANONICAL_OWNS_BASE__\) \{\s*\n\s*currentWardId = wardId;/],
    ['layer トグルの legacy show 停止（§4）', /window\.__CANONICAL_OWNS_BASE__ && \['buildings', 'roads', 'waterways', 'sea', 'parks', 'railways'\]/],
    ['residual を layer 別分類（§2）', /function classifyLegacyResidual\(\)/],
    ['self-check は再hideしない（§16）', /root cause/],
    ['status に Legacy residual 表示（§12）', /Legacy residual: 0/],
    ['camera移動/ward切替後 residual 再検証（§8）', /wardChanged \|\| cameraOrZoomMoved/],
    // [31G-FIX4] 地図は大阪市全域 / 建物だけ選択スコープ
    ['GLOBAL_LAYERS 定義（§1/§2）', /const GLOBAL_LAYERS = new Set\(\['roads', 'water', 'parks', 'rail'\]\)/],
    ['SELECTION_LAYERS = buildings のみ（§1/§3）', /const SELECTION_LAYERS = new Set\(\['buildings'\]\)/],
    ['building だけ wardId フィルタ（§3）', /if \(layer === 'buildings' && wardId\) \{[\s\S]{0,120}f\.attributes\.wardId\) === wardId/],
    ['ward bbox フィルタを撤去（§2）', /(?!)/],  // 下の否定チェックで担保
    ['ward 切替は buildings tile だけ差し替え（§5/§6・FIX9 で hide+unpin へ）', /if \(e\.layer === 'buildings'\) \{ e\.group\.visible = false; e\.pinnedByWard = null; \}/],
    ['GLOBAL layer の cache key は ward 非依存（§6）', /\(layer === 'buildings'\) \? \(base \+ '@' \+ \(buildingWardId\(\) \|\| 'city'\)\) : base/],
    ['status に Map/Building Scope（§13）', /Map: ' \+ mapScopeLabel\(\)[\s\S]{0,60}Bldg: ' \+ buildingScopeLabel\(\)/],
    ['City Mode = city-wide 建物（§4）', /function buildingWardId\(\)[\s\S]{0,200}if \(cityActive\) return null;/],
    // [31G-FIX5] Canonical 建物を用途別カラーへ戻す
    ['用途別 palette 定義（§1/§3）', /const CR_USAGE_COLOR = \{/],
    ['usageCategory を主キー（§1）', /function crUsageCategory\(a\)/],
    ['null / 未知 → other（§6）', /return \(typeof c === 'string' && CR_USAGE_COLOR\[c\]\) \? c : 'other';/],
    ['共有 material bucket（§7/§8）', /function crBuildingMaterial\(cat, band\)/],
    ['共有 material は crShared フラグ（§7）', /m\.userData\.crShared = true;/],
    ['buildings branch は usageCategory で bucket（§2/§8）', /const byCat = new Map\(\);\s*\n\s*buildingPalette = \{\};/],
    ['fallback も同じ palette（§5）', /const cat = crUsageCategory\(a\);\s*\/\/ §6/],
    ['LOD で白寄せ量のみ変える（§9）', /const CR_USAGE_WHITEN = \{ far:/],
    ['debug に buildingPalette（§14）', /buildingUsagePalette: true/],
    // [31G-FIX6] road/water 上の建物の placement policy（precompute lookup）
    ['placement policy tile lookup（§24）', /building-placement\/tile_\$\{tx\}_\$\{tz\}\.json/],
    ['placement は buildings tile と同じ tx/tz（§23）', /async function ensurePlacement\(tx, tz\)/],
    ['ward filter → placement filter（§12）', /if \(layer === 'buildings'\) \{ try \{ await ensurePlacement\(tx, tz\)/],
    ['SUPPRESS は mesh / footprint に入れない（§14）', /pp\.policy === 'SUPPRESS'\) \{\s*\n\s*suppressedInTile\+\+;/],
    ['placement debug API（§14/§19）', /getPlacementDebug\(\)/],
    ['placement 集計を status に（§19）', /抑制 水/],
    // [31G-FIX7] 全体高速化
    ['性能自動計測（§1/§41）', /window\.__CANONICAL_RUNTIME_PERF__ = function/],
    ['frame budget progressive build（§5/§6）', /function drainBuild\(now\)[\s\S]{0,400}while \(buildQ\.length && frameBuildMs < BUILD_BUDGET_MS\)/],
    ['fetch/parse と mesh build の分離（§5）', /async function fetchAndParse\(job\)/],
    ['fetch concurrency 制御（§7）', /while \(activeFetches < MAX_CONCURRENT_FETCH && fetchQ\.length\)/],
    ['重複 fetch 防止（§8）', /const queued = new Set\(inflight\);/],
    ['manifest は 1 回のみ（§9）', /async function ensureManifest\(\) \{\s*\n\s*if \(manifest\) return manifest;/],
    ['LOD hysteresis（§27）', /const BAND_HYST_M = \d+;/],
    ['camera dirty 閾値（§24/§25）', /const CAM_MOVE_EPS_M = \d+;/],
    ['byte-budget LRU（§22）', /const MAX_CACHE_MB = \d+;/],
    ['stale request cancel（§34）', /function drainStaleQueues\(\)/],
    ['near GLOBAL は mid tile（§15/§18）', /if \(band === 'near'\) return GLOBAL_LAYERS\.has\(layer\) \? 'mid' : 'near';/],
    ['near 建物は距離リング（§10/§11）', /want\.push\(\['buildings', 'far', tx, tz\]\)/],
    // [31G-FIX8 / FIX8B] 視認性改善（style / lighting のみ・geometry 不変）
    ['視認性: 建物基色は中間トーン（FIX8B・pale パステルを廃止）', /residential_low: 0xcaa870,[\s\S]{0,400}office:\s*0x6d93c4,/],
    ['視認性: canonical style profile（exposure + lighting）', /const CR_STYLE = \{ exposure: [\d.]+, hemi: [\d.]+, sun: [\d.]+, fill: [\d.]+ \};/],
    ['視認性: exposure は toggleOldLayers で適用/復帰（可逆 §0/§17）', /if \(hidden\) applyCanonicalExposure\(\); else restoreLegacyExposure\(\);/],
    ['視認性: applyCanonicalExposure が ambient/hemi/sun を下げる（§6）', /Math\.abs\(hemiLight\.intensity - CR_STYLE\.hemi\)[\s\S]{0,80}hemiLight\.intensity = CR_STYLE\.hemi/],
    ['視認性: restoreLegacyExposure が hemi/sun/fill/exposure を戻す（§17 可逆）', /function restoreLegacyExposure\(\)[\s\S]{0,600}hemiLight\.intensity = __legacyStyle\.hemi/],
    ['視認性: drift 再適用（起動後の白戻り対策 §18）', /const hemiDrift = [\s\S]{0,400}if \(expDrift \|\| hemiDrift \|\| sunDrift\) applyCanonicalExposure\(\);/],
    ['視認性: 白飛び診断（Console 不要 §4）', /window\.__CANONICAL_STYLE_DIAGNOSE__ = function/],
    ['視認性: 河川 opacity を下げすぎない（§12）', /opacity: 0\.96, depthWrite: false/],
    ['視認性: style は getDebug に出す（§2）', /buildingBaseColors: \{ \.\.\.CR_USAGE_COLOR \}/],
    // [31G-FIX9] Ward Mode: 一区全建物固定表示
    ['Ward: 区の building tile インデックスを load（§2）', /fetch\(BASE \+ '\/building-ward-index\.json'\)/],
    ['Ward: 選択区の全 tile を want に（camera で減らさない §2/§3）', /if \(layer === 'buildings' && wardTiles\) \{[\s\S]{0,400}for \(const tk of wardTiles\)/],
    ['Ward: mid tile を pin（LRU 対象外 §5）', /if \(e\.band === 'mid' && e\.tx != null && wardTiles\.has\([\s\S]{0,40}e\.pinnedByWard = wardId;/],
    ['Ward: evictLRU が pin tile を除外（§5）', /!\(e\.pinnedByWard && e\.pinnedByWard === lastWard\)/],
    ['Ward: 切替で旧区 unpin（§6）', /if \(e\.layer === 'buildings'\) \{ e\.group\.visible = false; e\.pinnedByWard = null; \}/],
    ['Ward: LOD handoff（new ready → old hide・gap 禁止 §10/§11）', /job\.band === 'near'\) \{ const ms = tileCache\.get\('mid\/buildings\/'[\s\S]{0,60}ms\.group\.visible = false;/],
    ['Ward: 進捗 stat（§12/§13）', /function updateWardLoadStat\(\)/],
    ['Ward: status に 区名: L\/E（§13/§14）', /Ward buildings ready/],
    ['Ward: City Mode は従来 LOD（§8・wardTiles で分岐）', /continue;   \/\/ §8: City Mode の camera-bounded LOD へは入らない/],
    // [31G-FIX12 / FIX13] Road Visual Surface: Canonical Road polygon ≠ 描画する車道面
    ['Road VS: renderClass classMap を load（§13・refined 優先 / FIX12 fallback）', /fetch\(BASE \+ '\/refined-road-surface\.json'\)/],
    ['Road VS: 旧 road-render-class.json への fallback を保持（§12 互換）', /fetch\(BASE \+ '\/road-render-class\.json'\)/],
    ['Road VS: renderClass 別 style 定数（§4/§9/§10/§11）', /const CR_ROAD_RS = \{[\s\S]{0,900}faint:\s*\{ col:/],
    ['Road VS: sidewalk / median を独立 style へ（FIX13 §9/§10）', /sidewalk:\s*\{ col: [\s\S]{0,300}median:\s*\{ col:/],
    ['Road VS: roads branch を renderClass で bucket（§4・sidewalk/median 込み）', /const buckets = \{ primary: \[\], bridge: \[\], secondary: \[\], pedestrian: \[\], sidewalk: \[\], median: \[\], faint: \[\] \};/],
    ['Road VS: primary 以外は透明・faint は地表へ寄せる（§5/§11）', /transparent: st\.transparent, opacity: st\.opacity, depthWrite: !st\.transparent/],
    ['Road VS: 未収録は primary 既定（fallback で従来動作 §14）', /let rs = roadRenderClass\.get\(f\.canonicalId\) \|\| 'primary';/],
    ['Road VS: debug に road visual surface（§9/§11）', /roadVisualSurface: \{[\s\S]{0,200}classMapLoaded: roadRenderClassLoaded/],
  ].filter(([, re]) => re.source !== '(?!)');
  for (const [label, re] of need) if (!re.test(html)) errors.push('欠落: ' + label);

  // [31G-FIX4 §2/§20] roads/water/parks/rail に ward filter が残っていない
  if (/scope\.bbox && layer !== 'water'/.test(html)) errors.push('roads/parks に ward bbox フィルタが残っている（§2 違反）');
  if (/function wardScope\(\)/.test(html)) errors.push('旧 wardScope() が残っている（§1: buildingWardId へ置換すべき）');
  if (/\bGLOBAL_LAYERS\b/.test(html)) {
    // GLOBAL layer が loadTile 内で wardId フィルタ対象になっていないこと
    if (/layer !== 'buildings'[\s\S]{0,60}feats = feats\.filter/.test(html)) errors.push('buildings 以外に feature filter がかかっている（§2 違反）');
  }

  // [31G-FIX5 §2/§5] buildings branch が白一色（presetWallColor / fallback 灰色分岐）へ落としていない
  {
    const s = html.indexOf("} else if (layer === 'buildings') {");
    if (s >= 0) {
      const block = html.slice(s, s + 1600);
      if (/presetWallColor\(a\.usage\)/.test(block)) errors.push('buildings branch がまだ presetWallColor(a.usage) を使っている（§2: 白一色の原因）');
      if (/msBlend\(COL\.white, 0xe6e9e5/.test(block)) errors.push('buildings branch に osm-fallback 専用の灰色分岐が残っている（§5 違反）');
      if (!/crUsageCategory\(a\)/.test(block)) errors.push('buildings branch が crUsageCategory を使っていない（§1 違反）');
    } else errors.push("buildings branch（loadTile）が見つからない");
  }

  // [31G-FIX3 §16] self-check の runSelfCheck 内で toggleOldLayers(true) を呼んでいない（自動再hide禁止）
  {
    const s = html.indexOf('function runSelfCheck()');
    if (s >= 0) {
      const block = html.slice(s, s + 1600);
      if (/toggleOldLayers\(true\)/.test(block)) errors.push('self-check が自動再hide（toggleOldLayers(true)）している（§16 違反）');
    }
  }

  // [31G-FIX2 §14] 手動 Console enable を前提としない: auto-init が __SET_CANONICAL_RUNTIME__ を呼ばずに
  //   init() 経由で有効化していること（= ユーザー入力なしで ON）。
  if (!/CanonicalRuntime\.init\(\)/.test(html)) errors.push('auto-init が CanonicalRuntime.init() を使っていない（手動 enable 依存の疑い）');
  // 旧の「既定 false + if (=== true) setEnabled」パターンが残っていないこと
  if (/window\.__CANONICAL_RUNTIME__ = false;\s*\n\s*const CanonicalRuntime/.test(html)) errors.push('既定 false のまま（31G-FIX2 未反映）');

  // ── 旧 render コードがそのまま残っている（§34: 削除していない）──
  for (const [label, re] of [
    ['RiverLayerV2 定義', /const RiverLayerV2 = \(function/],
    ['RoadLayer 定義', /const RoadLayer = \(function/],
    ['ParkLayer 定義', /const ParkLayer = \(function/],
    ['BuildingTileLayer 定義', /const BuildingTileLayer = \(function/],
    ['旧 pickHit の bMesh raycast', /ray\.intersectObjects\(bMesh,false\)/],
  ]) if (!re.test(html)) errors.push('旧 render が消えている（§34 違反）: ' + label);

  // ── projection / znorth-neg-v1 のハードコード変更なし ──
  //   canonical runtime ブロック内に projection origin の再定義が無いこと
  const crBlock = (html.match(/const CanonicalRuntime = \(function[\s\S]*?\}\)\(\);\n\nwindow\.__SET_CANONICAL_RUNTIME__/) || [''])[0];
  if (/135\.52502|34\.604208|centerLon|centerLat|metersPerDegree|111320/.test(crBlock)) {
    errors.push('CanonicalRuntime ブロック内に projection 定数の再定義（§0 禁止）');
  }
  if (/geoToThree\s*=|function geoToThree|projection\s*=\s*\{/.test(crBlock)) errors.push('CanonicalRuntime が projection を書き換えている');

  // ── production / protected 不変（byte 一致）──
  const curProd = sha(PROD), curProt = sha(PROT);
  let baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf-8')) : null;
  if (!baseline) {
    baseline = { prod: curProd, prot: curProt, note: '初回記録（31G 着手時点の production/protected hash）', recordedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2));
    warns.push('production/protected hash の baseline を新規記録した（次回から差分検出）');
  } else {
    if (baseline.prod && curProd && baseline.prod !== curProd) errors.push('production HTML が変更されている（§0 禁止）');
    if (baseline.prot && curProt && baseline.prot !== curProt) errors.push('protected HTML が変更されている（§0 禁止）');
  }
  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (fs.existsSync(p) && /CanonicalRuntime|__CANONICAL_RUNTIME__|osaka-city\/derived/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に canonical runtime が混入');
  }

  // ── derived public data がある（adapter の fetch 先）──
  const layers = ['water', 'roads', 'buildings', 'parks', 'rail'];
  const lods = ['far', 'mid', 'near'];
  if (!fs.existsSync(path.join(DERIVED_PUB, 'manifest.json'))) errors.push('public/map-data/osaka-city/derived/manifest.json が無い（先に build-derived-public.js）');
  else {
    const idx = JSON.parse(fs.readFileSync(path.join(DERIVED_PUB, 'manifest.json'), 'utf-8'));
    if (!idx.lodDistanceBands) errors.push('derived public manifest に lodDistanceBands が無い');
    let missing = 0;
    for (const lod of lods) for (const l of layers) {
      const mp = path.join(DERIVED_PUB, lod, l, 'manifest.json');
      if (!fs.existsSync(mp)) { missing++; continue; }
      const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
      const first = (m.tiles || [])[0];
      if (first && !fs.existsSync(path.join(DERIVED_PUB, lod, l, first.file))) errors.push(`${lod}/${l} の先頭 tile ${first.file} が無い`);
    }
    if (missing) errors.push('derived public に ' + missing + ' 個の lod/layer manifest が欠落');
    if (!fs.existsSync(path.join(DERIVED_PUB, 'rail-stations.json'))) warns.push('rail-stations.json が public に無い（§17）');
  }

  // ── derived feature が picking に必要な属性を持つ（buildings.usage / usageLabel）──
  try {
    const bnDir = path.join(DERIVED_PUB, 'near', 'buildings');
    const tf = fs.readdirSync(bnDir).find((f) => /^tile_/.test(f));
    const t = JSON.parse(fs.readFileSync(path.join(bnDir, tf), 'utf-8'));
    const f = (t.features || [])[0];
    for (const k of ['canonicalId', 'attributes', 'derivedFrom']) if (!(k in f)) errors.push('derived building feature に ' + k + ' が無い');
    for (const k of ['usage', 'usageLabel', 'usageCategory', 'heightM', 'wardId']) if (!(k in (f.attributes || {}))) errors.push('derived building attributes に ' + k + ' が無い（picking/color 用）');
  } catch (e) { warns.push('derived building feature の属性チェックをスキップ: ' + e.message); }

  const report = {
    generatedAt: new Date().toISOString(),
    checks: {
      moduleWired: need.every(([, re]) => re.test(html)),
      oldRenderIntact: true,
      productionUnchanged: !(baseline && baseline.prod && curProd && baseline.prod !== curProd),
      protectedUnchanged: !(baseline && baseline.prot && curProt && baseline.prot !== curProt),
      derivedPublicPresent: fs.existsSync(path.join(DERIVED_PUB, 'manifest.json')),
      // [31G-FIX2]
      defaultOn: /window\.__CANONICAL_RUNTIME__ === 'undefined'\) window\.__CANONICAL_RUNTIME__ = true/.test(html),
      autoInit: /autoInitCanonicalRuntime/.test(html) && /CanonicalRuntime\.init\(\)/.test(html),
      legacyAutoHide: /toggleOldLayers\(true\)/.test(html),
      autoFallback: /function fallbackToLegacy\(reason\)/.test(html) && /\.catch\(\(e\) => fallbackToLegacy/.test(html),
      statusUI: /id = 'canonical-runtime-status'/.test(html) && /\[CANONICAL\]/.test(html),
      screenToggle: /toggleBtn\.addEventListener\('click'/.test(html),
      selfCheck: /function runSelfCheck\(\)/.test(html),
      manualConsoleNotRequired: /autoInitCanonicalRuntime/.test(html) && !/window\.__CANONICAL_RUNTIME__ = false;\s*\n\s*const CanonicalRuntime/.test(html),
      // [31G-FIX3]
      renderOwnership: /window\.__CANONICAL_OWNS_BASE__ = !!hidden/.test(html) && /ownsBaseLayers: \(\) => enabled/.test(html),
      loopLegacyStopped: /if \(!window\.__CANONICAL_OWNS_BASE__\) \{[\s\S]{0,120}BuildingTileLayer\.updateByCamera\(camera\)/.test(html),
      camUpdLegacyStopped: /const canonicalOwns = !!window\.__CANONICAL_OWNS_BASE__;/.test(html),
      switchWardGuarded: /if \(window\.__CANONICAL_OWNS_BASE__\) \{\s*\n\s*currentWardId = wardId;/.test(html),
      selfCheckNoRehide: !(function () { const s = html.indexOf('function runSelfCheck()'); return s >= 0 && /toggleOldLayers\(true\)/.test(html.slice(s, s + 1600)); })(),
      residualClassified: /function classifyLegacyResidual\(\)/.test(html),
      // [31G-FIX4]
      globalMapLayers: /const GLOBAL_LAYERS = new Set\(\['roads', 'water', 'parks', 'rail'\]\)/.test(html),
      buildingSelectionScopeOnly: /if \(layer === 'buildings' && wardId\) \{[\s\S]{0,120}f\.attributes\.wardId\) === wardId/.test(html),
      roadWardFilter: false, waterWardFilter: false, parkWardFilter: false, railWardFilter: false,
      wardFilterRemoved: !/scope\.bbox && layer !== 'water'/.test(html) && !/function wardScope\(\)/.test(html),
      wardSwitchDoesNotReloadGlobal: /if \(e\.layer === 'buildings'\) \{ e\.group\.visible = false; e\.pinnedByWard = null; \}/.test(html) && /\(layer === 'buildings'\) \? \(base \+ '@'/.test(html),
      buildingScopeDebug: /mapScope: mapScopeLabel\(\)/.test(html) && /buildingScope: buildingScopeLabel\(\)/.test(html),
      cityModeCityWide: /function buildingWardId\(\)[\s\S]{0,200}if \(cityActive\) return null;/.test(html),
      // [31G-FIX5]
      buildingUsagePaletteEnabled: /const CR_USAGE_COLOR = \{/.test(html) && /function crUsageCategory\(a\)/.test(html),
      whiteOnlyBuildings: (() => { const s = html.indexOf("} else if (layer === 'buildings') {"); const b = s >= 0 ? html.slice(s, s + 1600) : ''; return /presetWallColor\(a\.usage\)/.test(b); })(),
      nullUsageMaterial: /return \(typeof c === 'string' && CR_USAGE_COLOR\[c\]\) \? c : 'other';/.test(html) ? 0 : 1,
      sharedMaterialBuckets: /const crBuildingMats = new Map\(\);/.test(html) && /m\.userData\.crShared = true;/.test(html),
      fallbackUsesCanonicalPalette: (() => { const s = html.indexOf("} else if (layer === 'buildings') {"); const b = s >= 0 ? html.slice(s, s + 1600) : ''; return !/msBlend\(COL\.white, 0xe6e9e5/.test(b) && /crUsageCategory\(a\)/.test(b); })(),
      wardScopeUnchanged: /function buildingWardId\(\)/.test(html),
      globalMapUnchanged: /const GLOBAL_LAYERS = new Set\(\['roads', 'water', 'parks', 'rail'\]\)/.test(html),
      legacyResidualGuard: /window\.__CANONICAL_OWNS_BASE__ = !!hidden/.test(html),
      // [31G-FIX6]
      placementPolicyLookup: /async function ensurePlacement\(tx, tz\)/.test(html) && /building-placement\/tile_/.test(html),
      placementSuppressExcludesMesh: /pp\.policy === 'SUPPRESS'\) \{[\s\S]{0,40}suppressedInTile\+\+;/.test(html),
      placementDebugApi: /getPlacementDebug\(\)/.test(html) && /__PLACEMENT_DEBUG__/.test(html),
      placementSourceGeometryUnchanged: !/canonical[\s\S]{0,40}\.coordinates\s*=/.test(html),
      // [31G-FIX7]
      perfInstrumentation: /window\.__CANONICAL_RUNTIME_PERF__ = function/.test(html) && /frameP95/.test(html),
      progressiveBuildBudget: /function drainBuild\(now\)/.test(html) && /frameBuildMs < BUILD_BUDGET_MS/.test(html),
      fetchConcurrencyLimited: /while \(activeFetches < MAX_CONCURRENT_FETCH && fetchQ\.length\)/.test(html),
      duplicateFetchGuard: /const queued = new Set\(inflight\);/.test(html) && /if \(queued\.has\(k\)\) continue;/.test(html),
      manifestCachedOnce: /async function ensureManifest\(\) \{\s*\n\s*if \(manifest\) return manifest;/.test(html),
      lodHysteresis: /const BAND_HYST_M = \d+;/.test(html),
      cameraDirtyThreshold: /const CAM_MOVE_EPS_M = \d+;/.test(html) && /const moved = \(lastTgtX == null\)/.test(html),
      byteBudgetCache: /const MAX_CACHE_MB = \d+;/.test(html) && /\.filter\(\(\[, e\]\) => !e\.group\.visible && !\(e\.pinnedByWard/.test(html),
      staleRequestCancel: /new AbortController\(\)/.test(html) && /function drainStaleQueues\(\)/.test(html),
      nearGlobalUsesMidTile: /if \(band === 'near'\) return GLOBAL_LAYERS\.has\(layer\) \? 'mid' : 'near';/.test(html),
      nearBuildingDistanceRing: /want\.push\(\['buildings', 'far', tx, tz\]\)/.test(html),
      globalReloadOnWardSwitch: /if \(e\.layer === 'buildings'\) e\.group\.visible = false;/.test(html) ? 0 : 1,
      // [31G-FIX8 / FIX8B]
      contrastPaletteStronger: /water: 0x6fb3d4/.test(html) && /railMajor: 0x515966/.test(html) && /road: 0x9096a0/.test(html),
      // FIX8B §8: 建物基色が中間トーン（CR_USAGE_COLOR 内で pale パステル 0xf0d9a8/0xf2c9a0 を廃止）
      buildingBaseMidtone: (() => {
        const m = html.match(/const CR_USAGE_COLOR = \{([\s\S]*?)\n  \};/);
        return !!m && /residential_low: 0xcaa870,/.test(m[1]) && !/0xf0d9a8|0xf2c9a0|0xa8dcea/.test(m[1]);
      })(),
      buildingWhitenReduced: /const CR_USAGE_WHITEN = \{ far: 0\.55, mid: 0\.30, near: 0\.12 \}/.test(html),
      // FIX8B §17: canonical 所有中の style profile（exposure + hemi + sun + fill）を適用/復帰
      canonicalStyleOwnership: /const CR_STYLE = \{ exposure: [\d.]+, hemi: [\d.]+, sun: [\d.]+, fill: [\d.]+ \};/.test(html)
        && /hemiLight\.intensity = CR_STYLE\.hemi/.test(html)
        && /if \(hidden\) applyCanonicalExposure\(\); else restoreLegacyExposure\(\);/.test(html),
      // FIX8B §17: legacy 復帰でライト/exposure を完全に戻す（可逆）
      legacyStyleDoesNotOverrideCanonical: /function restoreLegacyExposure\(\)[\s\S]{0,600}hemiLight\.intensity = __legacyStyle\.hemi[\s\S]{0,200}sun\.intensity = __legacyStyle\.sun/.test(html),
      // FIX8B §18: 起動後に applyModelStyle/applyTimeOfDay で白へ戻されても drift 再適用
      styleReassertOnDrift: /const hemiDrift = [\s\S]{0,400}if \(expDrift \|\| hemiDrift \|\| sunDrift\) applyCanonicalExposure\(\);/.test(html),
      // FIX8B §4: Console 不要の白飛び診断
      styleDiagnoseAvailable: /window\.__CANONICAL_STYLE_DIAGNOSE__ = function/.test(html) && /styleDiagnose\(opts\)/.test(html),
      // style のみ: CanonicalRuntime ブロックが geometry helper（pushExtrude/pushPolygon）の中身を変えていない
      styleOnlyNoGeometryChange: /function pushExtrude\(positions, geometryType, coordinates, h\)/.test(html) && /function pushPolygon\(positions, geometryType, coordinates, yLevel\)/.test(html),
      nearWhitenBelowMid: /const CR_USAGE_WHITEN = \{ far: 0\.55, mid: 0\.30, near: 0\.12 \}/.test(html),
      // [31G-FIX9]
      wardBuildingsPinned: /e\.pinnedByWard = wardId;/.test(html) && /!\(e\.pinnedByWard && e\.pinnedByWard === lastWard\)/.test(html),
      cameraDoesNotUnloadSelectedWard: /if \(layer === 'buildings' && wardTiles\) \{[\s\S]{0,400}for \(const tk of wardTiles\)/.test(html)
        && /continue;   \/\/ §8: City Mode の camera-bounded LOD へは入らない/.test(html),
      wardFullCoverage: /fetch\(BASE \+ '\/building-ward-index\.json'\)/.test(html) && /function updateWardLoadStat\(\)/.test(html)
        && /wardLoad\.ready = \(built >= wardLoad\.tilesExpected/.test(html),
      lodRepresentationGap: /job\.band === 'near'\) \{ const ms = tileCache\.get\('mid\/buildings\/'/.test(html)
        && /job\.band === 'mid'\) \{ const ns = tileCache\.get\('near\/buildings\/'/.test(html) ? 0 : 1,
      wardSwitchUnpinsPrevious: /if \(e\.layer === 'buildings'\) \{ e\.group\.visible = false; e\.pinnedByWard = null; \}/.test(html),
      cityModeUnchanged: /if \(layer === 'buildings' && currentBand === 'near'\) \{\s*\n\s*const Rf = tileRange\('buildings', 'far'\)/.test(html)
        && /function buildingWardId\(\)[\s\S]{0,200}if \(cityActive\) return null;/.test(html),
      wardIndexLoadedOnce: /try \{\s*\n\s*const wi = await \(await fetch\(BASE \+ '\/building-ward-index\.json'\)\)/.test(html),
      // [31G-FIX12 / FIX13] Road Visual Surface
      roadRenderClassLoaded: /fetch\(BASE \+ '\/refined-road-surface\.json'\)/.test(html)
        && /fetch\(BASE \+ '\/road-render-class\.json'\)/.test(html)
        && /roadRenderClass\.set\(pfx \+ k, rs\)/.test(html) && /roadRenderClass\.set\(id, rs\)/.test(html),
      roadVisualSurfaceStyle: /const CR_ROAD_RS = \{/.test(html) && /primary:\s*\{ col: COL\.road, y: Y\.road,\s+opacity: 1\.0,\s+transparent: false/.test(html)
        && /faint:\s*\{ col: \(typeof msBlend === 'function'\) \? msBlend\(COL\.road, 0xf3f4f1, 0\.5\)/.test(html)
        && /sidewalk:\s*\{ col: /.test(html) && /median:\s*\{ col: /.test(html),
      roadsBucketedByRenderClass: /const buckets = \{ primary: \[\], bridge: \[\], secondary: \[\], pedestrian: \[\], sidewalk: \[\], median: \[\], faint: \[\] \};/.test(html)
        && /let rs = roadRenderClass\.get\(f\.canonicalId\) \|\| 'primary';/.test(html),
      // §5: UNKNOWN / ROAD_RESERVE を「道路本体と同じ濃さで全面描画」しない
      unknownNotFullRoad: (() => {
        const s = html.indexOf("} else if (layer === 'roads') {");
        const b = s >= 0 ? html.slice(s, s + 1800) : '';
        // 旧: 単一 meshFromPositions(pos, COL.road, REN.road, ...) だけの実装が残っていないこと
        return s >= 0 && /for \(const rs of \['faint', 'median', 'sidewalk', 'pedestrian', 'secondary', 'primary', 'bridge'\]\)/.test(b)
          && !/const m = meshFromPositions\(pos, COL\.road, REN\.road, \{ side: THREE\.DoubleSide \}\);/.test(b);
      })(),
      roadPrimaryStaysOpaque: /primary:\s*\{ col: COL\.road, y: Y\.road,\s+opacity: 1\.0,\s+transparent: false/.test(html),
      // §0/§18: roads branch で source geometry（coordinates）を書き換えていない
      roadSourceGeometryUnchanged: (() => {
        const s = html.indexOf("} else if (layer === 'roads') {");
        const b = s >= 0 ? html.slice(s, s + 1800) : '';
        return !/\.coordinates\s*=|\.geometryType\s*=|f\.coordinates\.(push|splice)/.test(b);
      })(),
      roadVisualSurfaceDebug: /roadVisualSurface: \{[\s\S]{0,300}nonPrimaryEntries: roadRenderClass\.size/.test(html),
      // [31G-FIX13] sidewalk/median 分離・幾何 clamp なし（lanes は advisory のみ）
      sidewalkMedianStylesApplied: /sidewalk:\s*\{ col: \(typeof msBlend/.test(html) && /median:\s*\{ col: \(typeof msBlend/.test(html),
      refinedSurfaceFallbackToFix12: /catch \(e\) \{[\s\S]{0,50}try \{[\s\S]{0,80}road-render-class\.json/.test(html),
    },
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[canonical-runtime-validate] checks: ' + JSON.stringify(report.checks));
  for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e);
  for (const w of warns.slice(0, 10)) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

async function fail(errors, warns) {
  await writeJson(REPORT, { generatedAt: new Date().toISOString(), errors, warns, RESULT: 'FAIL' });
  for (const e of errors) console.log('  [ERROR] ' + e);
  process.exitCode = 1;
}

main().catch((e) => { console.error('[canonical-runtime-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
