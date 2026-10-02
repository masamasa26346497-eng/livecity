#!/usr/bin/env node
// tools/validate/semantic-map-display.js
// [Mission 32K §16] SEMANTICALLY CORRECT MAP DISPLAY の検証。
//   buildingMutation = 0 / projectionMutation = 0
//   normalViewRawGsiEdge = false / normalViewRoadMode = ROAD_V3
//   gsiEdgeStillAvailableForQa = true
//   §17: production / protected は変更禁止。
//
//   ※ 「通常表示の構成」は HTML の静的既定値だけでなく、**実際に runtime を起動して
//     __SEMANTIC_DISPLAY_DEBUG__() を読む**ことでも確認する（見かけの既定と実動作の乖離を防ぐ）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { CANONICAL_ROAD_FEATURE_COUNT } from "../lib/canonical-baseline.js";

const require_ = createRequire(import.meta.url);
const P = (...s) => resolveProjectPath(path.join(...s));
const OUT = P('data', 'reports', 'semantic-map-display-validation.json');
const WARD_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PRODUCTION_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const CANON_ROADS = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const AREA_CFG = P('config', 'areas', 'osaka-city.json');
const V3_PUBLIC = P('public', 'map-data', 'osaka-city', 'derived', 'road-visual-v3', 'tiles');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
function countUnique(dir, key) {
  if (!fs.existsSync(dir)) return null;
  const seen = new Set();
  for (const f of fs.readdirSync(dir)) { if (!isTile(f)) continue; const t = rj(path.join(dir, f)); if (!t) continue; for (const ft of t.features || []) seen.add(ft[key]); }
  return seen.size;
}

export async function validateSemanticMapDisplay() {
  const errors = [], warnings = [];
  const html = fs.existsSync(WARD_HTML) ? fs.readFileSync(WARD_HTML, 'utf-8') : '';

  // ── §0: 建物・projection 不変 ──
  const buildings = countUnique(CANON_BLDGS, 'canonicalId');
  const roads = countUnique(CANON_ROADS, 'canonicalId');
  const cfg = rj(AREA_CFG); const proj = cfg && cfg.projection;
  const buildingMutation = buildings === 615617 ? 0 : 1;
  const roadMutation = roads === CANONICAL_ROAD_FEATURE_COUNT ? 0 : 1;
  const projectionMutation = proj && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320 ? 0 : 1;
  if (buildingMutation) errors.push('Canonical Buildings が 615617 でない: ' + buildings);
  if (roadMutation) errors.push('Canonical Roads が ' + CANONICAL_ROAD_FEATURE_COUNT + ' でない: ' + roads);
  if (projectionMutation) errors.push('projection(znorth-neg-v1) が変更されている');

  // ── §0: building を動かす処理を新たに入れていない ──
  const buildingUsesRawCoords = /pushExtrude\(byCat\.get\(cat\), f\.geometryType, f\.coordinates, h\)/.test(html);
  if (!buildingUsesRawCoords) errors.push('§0/§9: 建物が source 座標をそのまま使う経路でなくなっている');

  // ── §16: 静的既定値 ──
  const staticRoadMode = (html.match(/let roadVisualMode = '([A-Z0-9_]+)';/) || [])[1] || null;
  const staticGsiEdge = /let gsiEdgeEnabled = false;/.test(html);
  if (staticRoadMode !== 'ROAD_V3') errors.push('§13: roadVisualMode の既定が ROAD_V3 でない: ' + staticRoadMode);
  if (!staticGsiEdge) errors.push('§1: gsiEdgeEnabled の既定が false でない');

  // ── §16: runtime を起動して実際の通常表示構成を読む ──
  let runtime = null;
  try {
    const { runInlineScript } = require_(P('tests', '_ward-ux-v1-smoke-harness.cjs'));
    const boot = runInlineScript(WARD_HTML, { fetchRoot: P('public') });
    if (!boot.ok) throw new Error(boot.error && boot.error.message);
    runtime = boot.window.__SEMANTIC_DISPLAY_DEBUG__ ? boot.window.__SEMANTIC_DISPLAY_DEBUG__() : null;
  } catch (e) { warnings.push('runtime 起動での確認ができなかった: ' + (e && e.message)); }

  const normalViewRoadMode = runtime ? runtime.normalViewRoadMode : staticRoadMode;
  const normalViewRawGsiEdge = runtime ? runtime.normalViewRawGsiEdge : !staticGsiEdge;
  const gsiEdgeStillAvailableForQa = runtime ? runtime.gsiEdgeStillAvailableForQa
    : (/function setGsiRoadEdgeEnabled\(on\)/.test(html) && /function requestGsiEdgeForQa\(on\)/.test(html));
  if (normalViewRoadMode !== 'ROAD_V3') errors.push('§16: normalViewRoadMode が ROAD_V3 でない: ' + normalViewRoadMode);
  if (normalViewRawGsiEdge !== false) errors.push('§16: normalViewRawGsiEdge が false でない');
  if (!gsiEdgeStillAvailableForQa) errors.push('§16: QA 用に GSI Edge を出す経路が無い');

  // ── §2: QA/解析モードでは緑線を使えること（Reference Alignment が明示的に ON にする） ──
  const refAlignTurnsOn = /requestGsiEdgeForQa\(true\);\s*\n\s*await Promise\.all\(\[refreshReferenceOverlays/.test(html);
  const refAlignRestores = /requestGsiEdgeForQa\(false\); \/\/ \[Mission 32K §2\]/.test(html);
  if (!refAlignTurnsOn) errors.push('§2: Reference Alignment が raw GSI Edge を ON にしていない');
  if (!refAlignRestores) errors.push('§2: Reference Alignment 終了時に元の設定へ戻していない');

  // ── §8: QA トグルと明示ラベル ──
  const qaToggleExists = /id = 'gsi-edge-qa-toggle';/.test(html);
  const qaLabelShown = /GSI Road Area Edge \(QA Reference\)/.test(html) && /title = 'GSI Road Area Edge — QA Reference';/.test(html);
  if (!qaToggleExists) errors.push('§8: [GSI EDGE QA] トグルが無い');
  if (!qaLabelShown) errors.push('§8: "GSI Road Area Edge — QA Reference" の明示が無い');

  // ── §15: OLD / SEMANTIC 比較 ──
  const presetExists = /async function setDisplayPreset\(preset\)/.test(html)
    && /\['OLD', 'OLD DISPLAY'\], \['SEMANTIC', 'SEMANTIC DISPLAY'\]/.test(html);
  if (!presetExists) errors.push('§15: OLD / SEMANTIC 比較モードが無い');

  // ── §4: ROAD V3 の配信物が存在する ──
  const v3Tiles = fs.existsSync(V3_PUBLIC) ? fs.readdirSync(V3_PUBLIC).filter(isTile).length : 0;
  if (v3Tiles === 0) errors.push('§3/§4: ROAD V3 の配信 tile が無い');

  // ── §4: ROAD_V3 既定時に V2 データセットを無駄に読まない ──
  const v2FetchScoped = /roadVisualMode === 'ROAD_V2' \|\| roadVisualMode === 'LAND_BLOCK' \|\| roadVisualMode === 'DIFF' \|\| roadVisualMode === 'DIFF_V2_V3'/.test(html);
  if (!v2FetchScoped) warnings.push('ROAD_V3 既定でも V2 タイルを fetch する可能性がある（性能上の無駄）');

  // ── §17: production / protected 非改変 ──
  const marks = /roadVisualMode = 'ROAD_V3'|gsi-edge-qa-toggle|setDisplayPreset|requestGsiEdgeForQa/;
  const productionModified = fs.existsSync(PRODUCTION_HTML) && marks.test(fs.readFileSync(PRODUCTION_HTML, 'utf-8'));
  const protectedModified = fs.existsSync(PROTECTED_HTML) && marks.test(fs.readFileSync(PROTECTED_HTML, 'utf-8'));
  if (productionModified) errors.push('§17: production HTML が変更されている');
  if (protectedModified) errors.push('§17: protected HTML が変更されている');

  const checks = {
    buildingMutation, roadMutation, projectionMutation,
    canonicalBuildings: buildings, canonicalRoads: roads,
    buildingUsesRawCoords,
    normalViewRoadMode, normalViewRawGsiEdge, gsiEdgeStillAvailableForQa,
    staticRoadModeDefault: staticRoadMode, staticGsiEdgeDefaultOff: staticGsiEdge,
    refAlignTurnsOn, refAlignRestores,
    qaToggleExists, qaLabelShown, presetExists, v2FetchScoped,
    roadV3PublicTiles: v3Tiles,
    runtimeLayers: runtime ? runtime.layers : null,
    runtimePreset: runtime ? runtime.preset : null,
    rawGsiEdgeMeshCountAtStartup: runtime ? runtime.rawGsiEdgeMeshCount : null,
    productionModified, protectedModified,
  };
  const out = { RESULT: errors.length ? 'FAIL' : 'PASS', generatedAt: new Date().toISOString(), missionId: '32K', checks, errors, warnings };
  await writeJson(OUT, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateSemanticMapDisplay().then((out) => {
    console.log('RESULT=' + out.RESULT);
    for (const w of out.warnings || []) console.log('WARN: ' + w);
    for (const e of out.errors || []) console.log('ERROR: ' + e);
    console.log(JSON.stringify(out.checks, null, 1));
    process.exitCode = out.RESULT === 'PASS' ? 0 : 1;
  }).catch((e) => { console.error(e); process.exit(1); });
}
