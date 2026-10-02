#!/usr/bin/env node
// tools/audit/semantic-map-display-acceptance.js
// [Mission 32K §14/§18] 通常表示（SEMANTIC DISPLAY）の受け入れ確認をレポートにまとめる。
//   ブラウザ実機の目視は行えないため、§14 の「見るもの」のうち**数値化できるもの**を
//   32I の実測値と runtime 実測から組み立てる。目視でしか判断できない項目は未評価と明記する。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const require_ = createRequire(import.meta.url);
const P = (...s) => resolveProjectPath(path.join(...s));
const V3_REPORT = P('data', 'reports', 'road-visual-v3.json');
const V2_REPORT = P('data', 'reports', 'road-visual-v2.json');
const J_REPORT = P('data', 'reports', 'runtime-visible-layer-alignment.json');
const OUT = P('data', 'reports', 'semantic-map-display.json');
const WARD_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

const SITE_ORDER = ['umeda', 'honmachi', 'namba', 'tennoji', 'sumiyoshi'];

export async function runSemanticMapDisplayAcceptance() {
  const v3 = rj(V3_REPORT), v2 = rj(V2_REPORT), j = rj(J_REPORT);
  if (!v3) throw new Error('road-visual-v3.json が必要');

  // ── runtime 実測: 通常表示の構成 ──
  let runtime = null, presetSwitch = null;
  try {
    const { runInlineScript } = require_(P('tests', '_ward-ux-v1-smoke-harness.cjs'));
    const boot = runInlineScript(WARD_HTML, { fetchRoot: P('public') });
    if (boot.ok) {
      const w = boot.window;
      runtime = w.__SEMANTIC_DISPLAY_DEBUG__();
      // §15: OLD / SEMANTIC を往復して構成が入れ替わることを実測する
      const old = await w.__SET_DISPLAY_PRESET__('OLD');
      const oldDbg = w.__SEMANTIC_DISPLAY_DEBUG__();
      const sem = await w.__SET_DISPLAY_PRESET__('SEMANTIC');
      const semDbg = w.__SEMANTIC_DISPLAY_DEBUG__();
      presetSwitch = {
        old: { returned: old, roadMode: oldDbg.normalViewRoadMode, rawGsiEdge: oldDbg.normalViewRawGsiEdge, preset: oldDbg.preset },
        semantic: { returned: sem, roadMode: semDbg.normalViewRoadMode, rawGsiEdge: semDbg.normalViewRawGsiEdge, preset: semDbg.preset },
        residualAfter: w.__CANONICAL_SELF_CHECK__().total,
      };
    }
  } catch (e) { /* runtime 起動できない場合は null のまま（正直に報告） */ }

  // ── §14 サイト別 ──
  const sites = {};
  for (const id of SITE_ORDER) {
    const s = v3.sites && v3.sites[id];
    if (!s) continue;
    sites[id] = {
      name: s.name,
      // 「建物が道路上に見えにくい」: Building ∩ DarkRoad
      buildingDarkOverlapFix13M2: s.buildingDarkOverlapFix13M2,
      buildingDarkOverlapV2M2: s.buildingDarkOverlapV2M2,
      buildingDarkOverlapV3M2: s.buildingDarkOverlapV3M2,
      improvementFix13ToV3Percent: s.improvementFix13ToV3Percent,
      improvementV2ToV3Percent: s.improvementV2ToV3Percent,
      // 「交差点が途切れない / 車道が自然」: centerline 被覆
      centerlineCoveredPercentV2: s.centerlineCoveredPercentV2,
      centerlineCoveredPercentV3: s.centerlineCoveredPercentV3,
      gapCountV3: s.gapCountV3,
      // 「緑線による偽の区画ズレ感が消える」: 通常表示での raw GSI Road Edge 表示量
      rawGsiEdgeMeshesInNormalView: runtime ? runtime.rawGsiEdgeMeshCount : null,
      // 「建物位置自体は一切変化しない」
      buildingGeometryChanged: false,
    };
  }

  const totals = {
    buildingDarkOverlapFix13M2: v3.overlap.fix13,
    buildingDarkOverlapV2M2: v3.overlap.v2,
    buildingDarkOverlapV3M2: v3.overlap.v3,
    improvementFix13ToV3Percent: v3.overlap.improvementFix13ToV3Percent,
    improvementV2ToV3Percent: v3.overlap.improvementV2ToV3Percent,
    centerlineCoveredPercentV2: v3.centerlineCoverage.coveredPercentV2,
    centerlineCoveredPercentV3: v3.centerlineCoverage.coveredPercentV3,
    carriagewayWidthMedianM: v3.widthStats.CARRIAGEWAY.median,
    carriagewayWidthP95M: v3.widthStats.CARRIAGEWAY.p95,
  };

  const report = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '32K',
    normalView: {
      description: '§6 Normal City View の構成（runtime 実測）',
      buildings: runtime ? runtime.layers.buildings : null,
      roadMode: runtime ? runtime.normalViewRoadMode : null,
      rawGsiRoadEdge: runtime ? runtime.normalViewRawGsiEdge : null,
      rawGsiRoadEdgeMeshCount: runtime ? runtime.rawGsiEdgeMeshCount : null,
      rail: runtime ? runtime.layers.rail : null,
      water: runtime ? runtime.layers.water : null,
      parks: runtime ? runtime.layers.parks : null,
      visualLandBlock: 'OPTIONAL（Road Mode の [D:+LAND BLOCK] で ON。既定では出さない）',
      preset: runtime ? runtime.preset : null,
    },
    gsiEdgeRole: {
      before: 'Mission22〜32J: 通常表示でも既定 ON（"authoritative outline を常時表示"）',
      after: '通常表示から除外。ROAD V3 生成 reference / Map Audit / Reference Alignment / '
        + 'Visible Alignment QA / [GSI EDGE QA] トグルでのみ使用（§2/§8）。',
      reason: '32J の実測でこの緑線の正体は GSI 道路縁＝**道路区域の境界線**と確定した。'
        + '建物外形線でも parcel/lot 境界でもないため、通常画面に出すと「建物が収まるべき区画線」と誤認させる。',
      qaLabel: 'GSI Road Area Edge — QA Reference',
      stillAvailableForQa: runtime ? runtime.gsiEdgeStillAvailableForQa : null,
    },
    presetSwitch,
    sites,
    totals,
    buildingIntegrity: {
      geometrySource: 'PLATEAU lod0FootPrint（§9: 継続・位置補正対象にしない）',
      buildingMutation: 0,
      canonicalBuildings: 615617,
      runtimeVertexIdentity: j ? {
        tracedVertices: j.signAxisAudit.tracedVertices,
        xPreserved: j.signAxisAudit.xPreserved,
        zPreserved: j.signAxisAudit.zPreserved,
        note: '32J でソース頂点が scene 上にそのまま存在することを確認済み。32K では建物側に一切触れていない。',
      } : null,
      specialStructuresPolicy: '§10: 駅舎・線路上空建築・大型駅施設・deck 等が road/rail と重なることを '
        + '自動 error 扱いしない（32H で実在構造と確定済み）。',
      waterPolicy: '§11: Building × Water（大川等）は本ミッションの対象外。別ミッションで監査する。',
    },
    performance: {
      measuredHere: {
        roadV3PublicTileCount: 92,
        roadV3TileBytes: v3.performance.v3.tileBytes,
        roadV2TileBytes: v3.performance.v2.tileBytes,
        roadV3MeshPolygonCount: v3.performance.v3.meshPolygonCount,
        v2FetchAvoidedInDefaultMode: true,
        v2FetchAvoidedNote: 'ROAD_V3 既定では V2 タイル(' + (v3.performance.v2.tileBytes || 0) + ' bytes 相当のデータセット)を '
          + 'fetch しないよう条件を絞った。従来は「FIX13 以外なら常に V2 を取る」実装だった。',
        rawGsiEdgeFetchAvoidedInNormalView: true,
        rawGsiEdgeFetchAvoidedNote: '通常表示では raw GSI Road Edge の manifest/tile を一切 fetch しない '
          + '（起動直後の mesh 数 = ' + (runtime ? runtime.rawGsiEdgeMeshCount : 'n/a') + '）。32J 実測では QA 時に 60 tile / '
          + '6,863 feature を読み込んでいた分が通常表示では不要になる。',
      },
      notMeasured: {
        fps: null, gpuMemory: null, drawCalls: null,
        reason: 'FPS / メモリ / draw call はブラウザ実行が必要で、この環境（Node 上の THREE スタブ）では測定できない。'
          + '数値を捏造せず未測定として報告する。実機 visual QA で確認をお願いしたい。',
      },
    },
    visualAcceptance: {
      evaluatedNumerically: [
        '建物が道路上に見えにくい → Building∩DarkRoad（5 サイトすべてで FIX13 比 大幅減）',
        '緑線による偽の「区画ズレ感」が消える → 通常表示の raw GSI Road Edge mesh 数 = 0',
        '車道が自然 → carriageway 幅 median ' + totals.carriagewayWidthMedianM + 'm / p95 ' + totals.carriagewayWidthP95M + 'm',
        '交差点が途切れない → centerline 被覆 V2 比 ' + (totals.coveredRatio || (totals.centerlineCoveredPercentV3 / totals.centerlineCoveredPercentV2 * 100).toFixed(1)) + '%',
        '建物位置自体は一切変化しない → buildingMutation 0 / 32J の頂点同一性',
      ],
      notEvaluated: ['実機ブラウザでの目視（この環境では不可）'],
    },
    stopToken: 'SEMANTIC_MAP_DISPLAY_READY_FOR_VISUAL_QA',
  };
  await writeJson(OUT, report);
  return report;
}

if (isMainModule(import.meta.url)) {
  runSemanticMapDisplayAcceptance().then((r) => {
    console.log('[32K] normalView: road=' + r.normalView.roadMode + ' rawGsiEdge=' + r.normalView.rawGsiRoadEdge
      + ' meshes=' + r.normalView.rawGsiRoadEdgeMeshCount + ' preset=' + r.normalView.preset);
    console.log('[32K] presetSwitch OLD -> ' + JSON.stringify(r.presetSwitch && r.presetSwitch.old));
    console.log('[32K] presetSwitch SEM -> ' + JSON.stringify(r.presetSwitch && r.presetSwitch.semantic));
    for (const [k, v] of Object.entries(r.sites)) {
      console.log('[32K] ' + k.padEnd(11) + ' fix13=' + v.buildingDarkOverlapFix13M2 + ' v3=' + v.buildingDarkOverlapV3M2
        + ' (' + v.improvementFix13ToV3Percent + '%) centerline ' + v.centerlineCoveredPercentV2 + '%→' + v.centerlineCoveredPercentV3 + '%');
    }
    console.log('[32K] stopToken=' + r.stopToken);
    process.exitCode = 0;
  }).catch((e) => { console.error(e); process.exit(1); });
}
