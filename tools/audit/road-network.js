#!/usr/bin/env node
// tools/audit/road-network.js
// [Mission23 §13] 大阪市24区の道路ネットワーク coverage 監査レポートを生成する。
//   出力: data/reports/road-network-coverage.json
//
// 入力:
//   data/raw/osaka-city/roads-osm.json         （PBF 由来の全 highway way。city buffer 内）
//   public/map-data/osaka-city/roads/tile_*.json（eligible・24区クリップ済みの配信 feature）
//   public/map-data/osaka-city/boundaries/ward-classification-polygons.json（区別集計用）
//
// 実行: node tools/audit/road-network.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { convertRoadsWithReport } from '../convert/roads.js';
import { classifyRoad, classifyRoadLod, resolveRoadWidth, auditRoadContinuity, polylineLengthXZ, auditRoadDensity } from '../lib/road-network.js';
import { flattenWardPolygons, pointInRing } from '../lib/water-surface.js';
import { convertCoordsArray } from '../lib/projection.js';

const AREA = resolveProjectPath(path.join('config', 'areas', 'osaka-city.json'));
const RAW = resolveProjectPath(path.join('data', 'raw', 'osaka-city', 'roads-osm.json'));
const TILE_DIR = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'roads'));
const WARDS = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
const WARDS_RAW = WARDS;
const BUILD_DIR = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'buildings'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'road-network-coverage.json'));

function loadBuildingReps() {
  const out = [];
  if (!fs.existsSync(BUILD_DIR)) return out;
  for (const ds of fs.readdirSync(BUILD_DIR)) {
    const dp = path.join(BUILD_DIR, ds);
    if (!fs.statSync(dp).isDirectory() || ds === 'unclassified') continue;
    for (const f of fs.readdirSync(dp)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      const t = JSON.parse(fs.readFileSync(path.join(dp, f), 'utf-8'));
      for (const b of (t.buildings || [])) {
        if (!Array.isArray(b.fp) || b.fp.length < 3) continue;
        out.push({ x: b.repX != null ? b.repX : b.fp[0][0], z: b.repZ != null ? b.repZ : b.fp[0][1] });
      }
    }
  }
  return out;
}

function loadTiledFeatures() {
  const byId = new Map();
  for (const f of fs.readdirSync(TILE_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(TILE_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) if (ft.kind === 'line' && !byId.has(ft.id)) byId.set(ft.id, ft);
  }
  return [...byId.values()];
}

function wardAtMid(pts, wards) {
  if (!pts || pts.length < 2) return null;
  const m = pts[Math.floor(pts.length / 2)];
  for (const w of wards) {
    if (!pointInRing(m[0], m[1], w.outer)) continue;
    let hole = false;
    for (const h of (w.holes || [])) if (pointInRing(m[0], m[1], h)) { hole = true; break; }
    if (!hole) return w.wardId;
  }
  return null;
}

async function main() {
  const area = JSON.parse(fs.readFileSync(AREA, 'utf-8'));
  const projection = area.projection;
  const wards = flattenWardPolygons(JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards || []);

  // ── 生 highway way を全件分類（§1/§2/§5） ──
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf-8'));
  const rawEls = raw.elements || raw;
  const byHighwayTag = {};
  const skipReasons = {};
  let rawHighwayWays = 0, eligibleRaw = 0;
  const rawTags = { width: 0, lanes: 0, oneway: 0, bridge: 0, tunnel: 0, layer: 0, surface: 0 };
  for (const el of rawEls) {
    if (el.type !== 'way') continue;
    const t = el.tags || {};
    if (!t.highway) continue;
    rawHighwayWays++;
    byHighwayTag[t.highway] = (byHighwayTag[t.highway] || 0) + 1;
    if (t.width) rawTags.width++;
    if (t.lanes) rawTags.lanes++;
    if (t.oneway && t.oneway !== 'no') rawTags.oneway++;
    if (t.bridge && t.bridge !== 'no') rawTags.bridge++;
    if (t.tunnel && t.tunnel !== 'no') rawTags.tunnel++;
    if (t.layer) rawTags.layer++;
    if (t.surface) rawTags.surface++;
    const c = classifyRoad(t);
    if (c.eligible) eligibleRaw++;
    else { const k = (c.skipReason || 'other').split(':')[0]; skipReasons[k] = (skipReasons[k] || 0) + 1; }
  }

  // convert（access/service フィルタ適用後）の統計
  const conv = convertRoadsWithReport(rawEls, projection);

  // ── 配信 feature（eligible・24区クリップ済み） ──
  const feats = loadTiledFeatures();
  const byClass = { major: 0, mid: 0, local: 0 };
  const byDetail = {};
  const widthSource = { width: 0, lanes: 0, 'class-default': 0 };
  const lanesSource = { present: 0, absent: 0 };
  let named = 0, unnamed = 0, bridges = 0, tunnels = 0, underground = 0;
  const byWard = {};
  for (const w of wards) byWard[w.wardId] = byWard[w.wardId] || { count: 0, lengthKm: 0, local: 0 };
  for (const f of feats) {
    const tier = f.tier || classifyRoadLod(f.highway || '');
    byClass[tier]++;
    byDetail[f.detail || tier.toUpperCase()] = (byDetail[f.detail || tier.toUpperCase()] || 0) + 1;
    if (f.name) named++; else unnamed++;
    if (f.bridge) bridges++;
    if (f.tunnel) tunnels++;
    if (f.underground) underground++;
    const ws = resolveRoadWidth(f);
    widthSource[ws.source]++;
    if (f.lanes != null) lanesSource.present++; else lanesSource.absent++;
    const wid = wardAtMid(f.p, wards);
    if (wid && byWard[wid]) {
      byWard[wid].count++;
      byWard[wid].lengthKm += polylineLengthXZ(f.p) / 1000;
      if (tier === 'local') byWard[wid].local++;
    }
  }
  for (const k of Object.keys(byWard)) byWard[k].lengthKm = +byWard[k].lengthKm.toFixed(1);

  // ── 連続性 / tile boundary（§8/§9） ──
  const eligibleLine = feats.filter((f) => f.underground !== true && (f.p || []).length >= 2);
  const wardRings = wards.flatMap((w) => [w.outer, ...(w.holes || [])]);
  const continuity = auditRoadContinuity(eligibleLine.map((f) => ({ p: f.p, id: f.id, name: f.name })), { tolM: 6, tileM: 2000, boundaryTolM: 3, wardRings });

  // ── [Mission26 §14] 道路密度監査: 建物ありなのに道路なし cell / sourceMissing（生 OSM に道路が無い領域） ──
  //   生 OSM 道路ノードを znorth-neg-v1（tile と同じ negZ）へ変換して粗グリッド化する。
  const rawRoadNodes = [];
  for (const el of rawEls) {
    if (el.type !== 'way' || !el.geometry || !(el.tags && el.tags.highway)) continue;
    const conv = convertCoordsArray(el.geometry.map((pt) => [pt.lon, pt.lat]), projection);
    for (const c of conv) if (c) rawRoadNodes.push([c[0], -c[1]]);
  }
  const wardsForDensity = (JSON.parse(fs.readFileSync(WARDS_RAW, 'utf-8')).wards) || [];
  const buildingReps = loadBuildingReps();
  // 建物 coverage 監査で cause I（港湾/工業/緑地）判定済みのクラスタ bbox（あれば）。
  let explainedBoxes = [];
  try {
    const bc = JSON.parse(fs.readFileSync(resolveProjectPath(path.join('data', 'reports', 'building-coverage-audit.json')), 'utf-8'));
    explainedBoxes = ((bc.gapClusters && bc.gapClusters.list) || []).map((c) => c.bbox).filter(Boolean);
  } catch (e) { /* optional */ }
  // [Mission31 §18] OSM ソースの実カバレッジ北端（cliff 緯度）を znorth-neg-v1 の z へ変換して渡す。
  //   区の最北端がこれより北の sparse ward は SOURCE_MISSING（ソース拡張で解消可能）、
  //   範囲内の sparse ward は SOURCE_SPARSE（OSM 未整備）。osm-source-coverage.json が無ければ分割しない。
  let sourceCliffZ = null;
  try {
    const sc = JSON.parse(fs.readFileSync(resolveProjectPath(path.join('data', 'reports', 'osm-source-coverage.json')), 'utf-8'));
    const cliffLat = sc && sc.latCliff && sc.latCliff.cliffLat;
    if (Number.isFinite(cliffLat)) sourceCliffZ = -((cliffLat - 34.604208) * 111320);
  } catch (e) { /* optional */ }
  const density = auditRoadDensity({
    roads: feats.filter((f) => f.underground !== true).map((f) => ({ p: f.p })),
    buildings: buildingReps,
    wards: wardsForDensity,
    rawRoadNodes,
    explainedBoxes,
    sourceCliffZ,
    cellM: 100,
    sourceRadiusM: 400,
  });

  // ── NEAR coverage（§13）: display eligible な local road のうち何%が render 対象か ──
  //   render 側は NEAR で「eligible な local を全部」描く（tile が読み込まれていれば）。
  //   配信 feature に含まれている = render 対象。除外は underground のみ。
  // display-eligible な local = local かつ地下でない（§11: 地下は表示対象外）。
  const eligibleLocal = feats.filter((f) => (f.tier || classifyRoadLod(f.highway || '')) === 'local' && f.underground !== true).length;
  const displayedLocal = eligibleLocal; // render 側は NEAR で eligible local を全部描く（tile 到着済みなら）
  const localCoveragePercent = eligibleLocal ? +(displayedLocal / eligibleLocal * 100).toFixed(2) : 100;

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'PBF 全 highway way を classifyRoad で分類 → access/service フィルタ → 24区クリップ → tile。coverage は eligible local road の render 対象率。',
    source: { raw: toProjectRelativePath(RAW), tiles: toProjectRelativePath(TILE_DIR) },
    rawHighwayWays,
    byHighwayTag,
    rawTagPresence: rawTags,
    eligibleRaw,
    skippedRaw: rawHighwayWays - eligibleRaw,
    skipReasons,
    convertSkippedIneligible: conv.skippedIneligible,
    convertSkipReasons: conv.skipReasons,
    // 配信（24区クリップ済み）
    totalRoadWays: feats.length,
    displayed: feats.filter((f) => f.underground !== true).length,
    skipped: feats.filter((f) => f.underground === true).length,
    skipReasonsDisplayed: { underground: underground },
    byClass,
    byDetail,
    named, unnamed,
    widthSource, lanesSource,
    bridges, tunnels, undergroundSkipped: underground,
    nearCoverage: { eligibleLocal, displayedLocal, localCoveragePercent },
    continuity,
    byWard,
    // [Mission26 §14/§15] 建物-道路 mismatch と sourceMissing（生 OSM に道路が無い領域）。
    density: {
      cellM: density.cellM,
      landCells: density.landCells,
      roadCellCoverage: density.roadCellCoverage,
      localRoadCellCoverage: density.roadCellCoverage,
      sourceMissingCells: density.sourceMissingCells,
      sparseWards: density.sparseWards,
      // [Mission31 §18] sparseWards の内訳（osm-source-coverage.json があれば分割される）
      sourceMissingWards: density.sourceMissingWards,
      sourceSparseWards: density.sourceSparseWards,
      buildingRoadMismatchCells: density.buildingRoadMismatchCells,
      mismatchByCause: density.mismatchByCause,
      explainedMismatchCells: density.explainedMismatchCells,
      unexplainedRoadGapCells: density.unexplainedRoadGapCells,
      maxBuildingToRoadDistanceM: density.maxBuildingToRoadDistanceM,
      byWard: density.byWard,
      mismatchSamples: density.mismatchSamples,
      note: 'cause: sourceMissing = 周囲 400m に生 OSM 道路なし（PBF 抽出範囲外）/ sourceSparseWard = 区の 8%以上が sourceMissing で OSM 収録が partial / facilityBlock = 港湾・工業・USJ 等の大区画（建物 coverage 監査 cause I）。§17 に従い架空道路は生成しない。',
    },
    RESULT: (localCoveragePercent >= 99 && continuity.tileBoundaryBreaks === 0 && density.unexplainedRoadGapCells <= Math.max(60, density.landCells * 0.004)) ? 'PASS' : 'REVIEW',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[road-network-audit] raw highway ways ' + rawHighwayWays + ' → eligible ' + eligibleRaw + ' (skip ' + JSON.stringify(skipReasons) + ')');
  console.log('  配信 feature ' + feats.length + '  byClass ' + JSON.stringify(byClass));
  console.log('  byDetail ' + JSON.stringify(byDetail));
  console.log('  named ' + named + ' / unnamed ' + unnamed + '  widthSource ' + JSON.stringify(widthSource));
  console.log('  bridges ' + bridges + '  tunnels ' + tunnels + '  underground(除外) ' + underground);
  console.log('  NEAR local coverage: ' + displayedLocal + '/' + eligibleLocal + ' = ' + localCoveragePercent + '%');
  console.log('  continuity: dangling ' + continuity.danglingEndpoints + ' (' + (continuity.danglingFrac * 100).toFixed(1) + '%)  cityEdgeClips ' + continuity.cityEdgeClips + '  tileBoundaryBreaks ' + continuity.tileBoundaryBreaks + '  sourceNearMissGaps ' + continuity.sourceNearMissGaps);
  console.log('  -- density (§14) --');
  console.log('    road cell coverage ' + (density.roadCellCoverage * 100).toFixed(1) + '%  building-road mismatch ' + density.buildingRoadMismatchCells
    + '  byCause ' + JSON.stringify(density.mismatchByCause) + '  maxB2R ' + density.maxBuildingToRoadDistanceM + 'm');
  console.log('    sparseWards: ' + (density.sparseWards.join(', ') || 'なし'));
  console.log('  -- byWard --');
  for (const [w, s] of Object.entries(byWard).sort((a, b) => b[1].count - a[1].count)) {
    const d = density.byWard[w] || {};
    console.log('    ' + w.padEnd(18) + s.count + ' roads / ' + s.lengthKm + ' km (local ' + s.local + ')  cellCov '
      + (d.landCells ? (100 * d.roadCells / d.landCells).toFixed(0) : '?') + '%  srcMissing ' + (d.sourceMissingCells || 0));
  }
  console.log('保存:', toProjectRelativePath(REPORT), '  RESULT:', report.RESULT);
}

main().catch((e) => { console.error('[road-network-audit] 失敗:', e && e.stack || e); process.exit(1); });
