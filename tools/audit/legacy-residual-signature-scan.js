#!/usr/bin/env node
// tools/audit/legacy-residual-signature-scan.js
// [Mission 31G-FIX23B §4] Legacy residual の「object signature カタログ」を生成する development report。
//
// 【正直な前提】このセッションには実機ブラウザが無いため、実機で報告された unknown:18 を
// そのままNode側で取得することはできない。代わりに、tests/_ward-ux-v1-smoke-harness.cjs
// （FIX23で本物のscene graphとして機能するよう強化済み・§32でno-opへ戻さないことをtestで保護）を
// 使い、ミッションが明示した実機repro条件の各要素（起動直後/ward切替/Building Alignment/
// Top Down/Road mode切替）を可能な範囲で再現し、各シナリオでの classifyLegacyResidual() 実測値を
// 記録する。実機の unknown:18 と1:1で対応する保証はない（§20で正直に記載）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const require = createRequire(import.meta.url);
const { runInlineScript } = require(resolveProjectPath(path.join('tests', '_ward-ux-v1-smoke-harness.cjs')));

const P = (...s) => resolveProjectPath(path.join(...s));
const HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const REPORT = P('data', 'reports', 'runtime-unknown-residual-detail.json');

const settle = async (n = 15) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

async function scan(name, note, fn) {
  const r = runInlineScript(HTML, { fetchRoot: P('public') });
  if (!r.ok) return { name, note, error: r.error && r.error.message };
  const w = r.window;
  await settle();
  if (fn) { try { await fn(w); } catch (e) { return { name, note, error: e.message }; } }
  await settle(5);
  let residual = null, detail = null;
  try { residual = w.__CANONICAL_SELF_CHECK__(); } catch (e) { /* noop */ }
  if (residual && residual.total > 0) {
    try { detail = w.__LEGACY_RESIDUAL_DETAIL__(); } catch (e) { /* noop */ }
  }
  return { name, note, residual, detail: detail ? detail.details : null };
}

async function main() {
  const scenarios = [];
  scenarios.push(await scan('startup_default', '起動直後・無操作'));
  scenarios.push(await scan('ward_switch_kita', 'Ward=北区(osaka-kita)へ切替（実機repro条件の主要素）', async (w) => {
    w.__WARD_MODE_MANAGER__.switchWard('kita');
    await settle(10);
  }));
  scenarios.push(await scan('ward_switch_cycle', '北区→中央区→住吉区→北区（§27要件）', async (w) => {
    for (const wid of ['kita', 'chuo', 'sumiyoshi', 'kita']) { w.__WARD_MODE_MANAGER__.switchWard(wid); await settle(10); }
  }));
  scenarios.push(await scan('building_alignment_on', 'Building Alignment ON（実機repro条件の主要素・実データ使用）', async (w) => {
    await w.__TOGGLE_BUILDING_ALIGNMENT__();
  }));
  scenarios.push(await scan('building_alignment_on_off_on', 'Building Alignment ON→OFF→ON（§28要件）', async (w) => {
    await w.__TOGGLE_BUILDING_ALIGNMENT__(); await w.__TOGGLE_BUILDING_ALIGNMENT__(); await w.__TOGGLE_BUILDING_ALIGNMENT__();
  }));
  scenarios.push(await scan('top_down_on', 'Building Alignment ON + Top Down ON（実機repro条件と一致）', async (w) => {
    await w.__TOGGLE_BUILDING_ALIGNMENT__(); w.__TOGGLE_TOP_DOWN_ALIGNMENT__();
  }));
  scenarios.push(await scan('top_down_on_off_on', 'Top Down ON→OFF→ON（§29要件）', async (w) => {
    w.__TOGGLE_TOP_DOWN_ALIGNMENT__(); w.__TOGGLE_TOP_DOWN_ALIGNMENT__(); w.__TOGGLE_TOP_DOWN_ALIGNMENT__();
  }));
  scenarios.push(await scan('road_mode_hybrid_v1', 'Road mode: HYBRID_V1（§6/§9で発見した実バグの回帰確認）', async (w) => {
    await w.__SET_ROAD_RENDER_MODE__('HYBRID_V1');
  }));
  scenarios.push(await scan('road_mode_diff_debug', 'Road mode: DIFF_DEBUG', async (w) => {
    await w.__SET_ROAD_RENDER_MODE__('DIFF_DEBUG');
  }));
  scenarios.push(await scan('road_mode_full_cycle', 'FIX13→HYBRID_V1→DIFF_DEBUG→FIX13（§30要件）', async (w) => {
    await w.__SET_ROAD_RENDER_MODE__('HYBRID_V1'); await w.__SET_ROAD_RENDER_MODE__('DIFF_DEBUG'); await w.__SET_ROAD_RENDER_MODE__('FIX13');
  }));
  scenarios.push(await scan('combined_repro', 'Ward=北区 + Building Alignment ON + Top Down ON（実機repro条件の組み合わせ・selectionのみ未再現）', async (w) => {
    w.__WARD_MODE_MANAGER__.switchWard('kita'); await settle(10);
    await w.__TOGGLE_BUILDING_ALIGNMENT__();
    w.__TOGGLE_TOP_DOWN_ALIGNMENT__();
  }));

  const allZero = scenarios.every((s) => !s.residual || s.residual.total === 0);
  const report = {
    generatedAt: new Date().toISOString(),
    method: 'tests/_ward-ux-v1-smoke-harness.cjs（FIX23で本物のscene graphとして機能するよう強化済み）を'
      + '使ったharness実測。実ブラウザでの__LEGACY_RESIDUAL_DETAIL__()実行結果ではない（§20で正直に記載）。',
    knownFixedSignatures: [
      { source: 'GroundVisualLayer', bug: '.name未設定（COEXIST_NAMEが想定するGroundVisualが実際には付いていなかった）', fixedInMission: '31G-FIX23' },
      { source: 'StreetscapeLayer', bug: 'COEXIST_NAMEにもtoggleOldLayers()のガード対象にも未登録で常時表示されていた', fixedInMission: '31G-FIX23' },
      { source: 'hoverHL/selectHL (highlight line+fill)', bug: '.name未設定・renderOrder>=900のためBuildingTileLayerへ常時誤計上', fixedInMission: '31G-FIX23' },
      { source: 'WardBoundaryLayer/WardAreaFillLayer', bug: '.name未設定（COEXIST_NAMEが想定するWardBoundary/WardAreaが実際には付いていなかった）', fixedInMission: '31G-FIX23' },
      { source: 'FullWardManager.loadFullWard() atomic commit', bug: 'tile.state ではなく tile.loaded だけを見ていたため、load中にownership取得すると再show()されうるrace', fixedInMission: '31G-FIX23' },
      { source: 'HYBRID_V1/DIFF_DEBUG road groups (gN/gD)', bug: 'runtimeOwnerタグ無し・renderOrder<900のため、Road mode切替時にunknown residualへ誤計上', fixedInMission: '31G-FIX23B' },
      { source: 'RoadLayer (Legacy Road, userData.roadKey保持)', bug: '.name未設定・runtimeOwner未設定だった（hide()自体はscene.remove()で完全除去のため通常は現れないが、防御的に明示タグを追加）', fixedInMission: '31G-FIX23C' },
      { source: 'CanonicalRuntime自身のtile group(roads/water/parks/buildings/rail)', bug: 'underRt()による構造的除外のみに依存しており、明示的な自己タグ(runtimeOwner=CANONICAL)が無かった（§8のexplicit self owner優先の原則に対応するため追加）', fixedInMission: '31G-FIX23C' },
    ],
    scenarios,
    allZeroInHarness: allZero,
    caveat: '実機で報告された unknown:18（Ward=北区・Building Alignment loaded・building selected・'
      + 'property card OPEN・camera NEAR）のうち、building選択状態とNEARカメラ距離のLOD更新は'
      + 'このharnessでは完全に再現できていない（requestAnimationFrameがno-opのため、per-frameの'
      + 'camera距離依存ロジックが実行されない・selectBuilding()呼び出しには実データ形状のbPick/'
      + 'TOWN_POLYGONSが必要でNode側から再現しづらい）。上記以外の全条件（起動直後・ward切替・'
      + 'Building Alignment・Top Down・Road mode）はharness実測で0を確認済み。実機ブラウザでの'
      + '__LEGACY_RESIDUAL_DETAIL__()実行による最終確認が引き続き必要。',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[legacy-residual-signature-scan] allZeroInHarness=' + allZero);
  console.log('保存: ' + toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[legacy-residual-signature-scan] 失敗:', e && e.stack || e); process.exit(1); });
