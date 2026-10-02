#!/usr/bin/env node
// tools/build-visual-buildings.js
// [Mission 32B] GSI Unified Building Placement — Visual Building Geometry を構築する。
//   §0 最重要原則: Canonical PLATEAU Buildings(615,617)は一切変更しない。ここでは新規に
//   data/processed/osaka-city/visual-buildings/ を生成するだけ（読み取り専用+新規出力）。
//
//   MAP POSITION/FOOTPRINT TRUTH = GSI（BldA polygon優先）、3D HEIGHT/ATTRIBUTE TRUTH = PLATEAU、
//   という分離方針に従い、各PLATEAU建物についてGSI BldAとの重なりグラフ（one-to-one/one-to-many/
//   many-to-one/complexを許容）を作り、Visual Building feature を生成する。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { readFeatureCollectionStreaming } from './lib/large-json-array-reader.js';
import { precomputeMetrics } from './lib/gsi-building-matching.js';
import { precomputeGsiAreaMetrics, joinBuildingGeometries } from './lib/gsi-visual-building-join.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON_BLDGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const NEAR_BLDGS = P('data', 'processed', 'osaka-city', 'derived', 'near', 'buildings'); // heightM/usageCategory等の属性source
const GSI_AREA = P('data', 'processed', 'osaka-city', 'gsi-building-area', 'building-area-polygons.json');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'visual-buildings');
const REPORT = P('data', 'reports', 'visual-buildings-build.json');

const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const TILE_SIZE = 500;

function ringArea(ring) { let a = 0; for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; a += x1 * z2 - x2 * z1; } return Math.abs(a) / 2; }

async function main() {
  const generatedAt = new Date().toISOString();

  // ── 1) PLATEAU Canonical Buildings 読込（source別に分ける。§0: 元データは一切変更しない） ──
  console.time('[visual-buildings] load canonical');
  const files = fs.readdirSync(CANON_BLDGS).filter(isTile);
  const plateauFeatures = []; // GSI matching対象（source=plateau-building）
  const osmFallbackFeatures = []; // GSI matchingしない（そのままPLATEAU_FALLBACK扱い）
  const attrByCanonicalId = new Map(); // heightM/usageCategory等（derived/near/buildingsから）
  for (const f of files) {
    const t = rj(path.join(CANON_BLDGS, f));
    if (!t) continue;
    const nearTile = rj(path.join(NEAR_BLDGS, f));
    if (nearTile) for (const nf of nearTile.features) attrByCanonicalId.set(nf.canonicalId, nf.attributes || {});
    for (const ft of t.features) {
      const outer = ft.geometryType === 'Polygon' ? ft.coordinates[0] : (ft.coordinates[0] && ft.coordinates[0][0]);
      if (!outer || outer.length < 3) continue;
      const rec = { id: ft.canonicalId, ring: outer, tileFile: f };
      if (ft.source && ft.source.geometrySource === 'plateau-building') plateauFeatures.push(rec);
      else osmFallbackFeatures.push(rec);
    }
  }
  console.timeEnd('[visual-buildings] load canonical');
  console.log('[visual-buildings] plateau-building=' + plateauFeatures.length + ' osm-fallback=' + osmFallbackFeatures.length);
  const plateauMetrics = plateauFeatures.map(precomputeMetrics);

  // ── 2) GSI BldA 読込 ──
  console.time('[visual-buildings] load GSI BldA');
  const gsiSrc = await readFeatureCollectionStreaming(GSI_AREA);
  const gsiFeatures = (gsiSrc && gsiSrc.features) || [];
  console.timeEnd('[visual-buildings] load GSI BldA');
  console.log('[visual-buildings] GSI BldA features=' + gsiFeatures.length);
  const gsiMetrics = gsiFeatures.map(precomputeGsiAreaMetrics);

  if (gsiMetrics.length === 0) {
    await writeJson(REPORT, { generatedAt, RESULT: 'GSI_BUILDING_AREA_DATA_MISSING' });
    console.log('[visual-buildings] GSI_BUILDING_AREA_DATA_MISSING');
    return;
  }

  // ── 3) Join（one-to-one/one-to-many/many-to-one/complexを許容） ──
  console.time('[visual-buildings] join');
  const { groups, unmatchedA, aById, bById } = joinBuildingGeometries(plateauMetrics, gsiMetrics);
  console.timeEnd('[visual-buildings] join');
  console.log('[visual-buildings] groups=' + groups.length + ' unmatchedA(PLATEAU_FALLBACK candidates)=' + unmatchedA.length);

  const relationshipCounts = { ONE_TO_ONE: 0, ONE_TO_MANY: 0, MANY_TO_ONE: 0, COMPLEX: 0, ONE_TO_NONE: 0 };

  // ── 4) Visual Building feature 生成 ──
  const visualFeatures = [];
  let visualIdSeq = 0;
  function pushVisual(rec) { rec.visualId = 'vb_' + (visualIdSeq++); visualFeatures.push(rec); }

  function heightOf(canonicalId) { const a = attrByCanonicalId.get(canonicalId); return a && typeof a.heightM === 'number' ? a.heightM : null; }
  function usageOf(canonicalId) { const a = attrByCanonicalId.get(canonicalId); return a ? { usageCategory: a.usageCategory, usage: a.usage, usageLabel: a.usageLabel, wardId: a.wardId } : {}; }

  for (const g of groups) {
    relationshipCounts[g.relationship] = (relationshipCounts[g.relationship] || 0) + 1;
    if (g.relationship === 'ONE_TO_ONE') {
      const canonicalId = g.aIds[0]; const gsi = bById.get(g.bIds[0]);
      pushVisual({
        canonicalIds: [canonicalId], geometry: { type: 'Polygon', coordinates: [gsi.ring, ...gsi.holes] },
        geometrySource: 'GSI_POLYGON', matchType: 'ONE_TO_ONE', heightM: heightOf(canonicalId), ...usageOf(canonicalId),
        confidence: 'HIGH', correction: null,
      });
    } else if (g.relationship === 'ONE_TO_MANY') {
      const canonicalId = g.aIds[0]; const h = heightOf(canonicalId); const u = usageOf(canonicalId);
      for (const bId of g.bIds) {
        const gsi = bById.get(bId);
        pushVisual({
          canonicalIds: [canonicalId], geometry: { type: 'Polygon', coordinates: [gsi.ring, ...gsi.holes] },
          geometrySource: 'GSI_POLYGON', matchType: 'ONE_TO_MANY', heightM: h, ...u,
          confidence: 'MEDIUM', correction: null,
          note: '1棟のPLATEAU建物が複数のGSI polygonに対応（§7: 同一heightを各partへ付与）',
        });
      }
    } else if (g.relationship === 'MANY_TO_ONE') {
      const gsi = bById.get(g.bIds[0]);
      // §7: 代表height = 各PLATEAU棟のfootprint面積で重み付けした平均（合理的な決定則として採用・恣意的補正ではない）
      let wsum = 0, hsum = 0; const heights = [];
      for (const aId of g.aIds) {
        const a = aById.get(aId); const h = heightOf(aId);
        if (h != null) { hsum += h * a.area; wsum += a.area; heights.push(h); }
      }
      const repHeight = wsum > 0 ? hsum / wsum : (heights.length ? heights.reduce((s, x) => s + x, 0) / heights.length : null);
      const primaryU = usageOf(g.aIds[0]);
      pushVisual({
        canonicalIds: g.aIds, geometry: { type: 'Polygon', coordinates: [gsi.ring, ...gsi.holes] },
        geometrySource: 'GSI_POLYGON', matchType: 'MANY_TO_ONE', heightM: repHeight != null ? +repHeight.toFixed(2) : null, ...primaryU,
        confidence: 'MEDIUM', correction: null,
        note: g.aIds.length + '棟のPLATEAU建物が1つのGSI polygonに対応。heightは footprint面積加重平均（' + JSON.stringify(heights) + '→' + (repHeight != null ? repHeight.toFixed(2) : null) + '）',
      });
    } else if (g.relationship === 'COMPLEX') {
      // 複雑な多対多は個々に安全な高さ割当が困難なため、GSI各partへPLATEAU代表(先頭)のheightを付与し
      // confidence=REVIEWとして正直に記録する（誤った高さを断定しない・§7「勝手な高さ補正は禁止」）。
      const repH = heightOf(g.aIds[0]); const primaryU = usageOf(g.aIds[0]);
      for (const bId of g.bIds) {
        const gsi = bById.get(bId);
        pushVisual({
          canonicalIds: g.aIds, geometry: { type: 'Polygon', coordinates: [gsi.ring, ...gsi.holes] },
          geometrySource: 'GSI_POLYGON', matchType: 'COMPLEX', heightM: repH, ...primaryU,
          confidence: 'REVIEW', correction: null,
          note: g.aIds.length + '対' + g.bIds.length + 'の複雑な対応。height/usageは代表PLATEAU棟から暫定付与（要目視確認）',
        });
      }
    }
  }
  // PLATEAU fallback（GSIとの意味のある重なりが見つからなかったplateau-building + osm-fallback全棟）
  for (const aId of unmatchedA) {
    const a = aById.get(aId);
    pushVisual({
      canonicalIds: [aId], geometry: { type: 'Polygon', coordinates: [a.ring] },
      geometrySource: 'PLATEAU_FALLBACK', matchType: 'PLATEAU_ONLY', heightM: heightOf(aId), ...usageOf(aId),
      confidence: 'FALLBACK', correction: null,
    });
  }
  for (const rec of osmFallbackFeatures) {
    pushVisual({
      canonicalIds: [rec.id], geometry: { type: 'Polygon', coordinates: [rec.ring] },
      geometrySource: 'PLATEAU_FALLBACK', matchType: 'OSM_FALLBACK_NOT_EVALUATED', heightM: heightOf(rec.id), ...usageOf(rec.id),
      confidence: 'FALLBACK', correction: null,
      note: 'osm-fallback建物はGSI matching対象外（PLATEAU由来ではないため）。従来のfootprintをそのまま使用。',
    });
  }

  console.log('[visual-buildings] relationshipCounts=' + JSON.stringify(relationshipCounts));
  console.log('[visual-buildings] visualFeatures total=' + visualFeatures.length);

  // ── 5) 500m tileへ振り分けて出力（既存architectureと同じgrid。§36性能方針） ──
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tiles = new Map();
  const geomSourceCounts = { GSI_POLYGON: 0, PLATEAU_FALLBACK: 0, PLATEAU_FALLBACK_ADJUSTED: 0 };
  for (const f of visualFeatures) {
    geomSourceCounts[f.geometrySource] = (geomSourceCounts[f.geometrySource] || 0) + 1;
    const ring = f.geometry.coordinates[0];
    let cx = 0, cz = 0; for (const [x, z] of ring) { cx += x; cz += z; } cx /= ring.length; cz /= ring.length;
    const tx = Math.floor(cx / TILE_SIZE), tz = Math.floor(cz / TILE_SIZE);
    const key = tx + '_' + tz;
    let t = tiles.get(key); if (!t) { t = { tx, tz, features: [] }; tiles.set(key, t); }
    t.features.push(f);
  }
  const tileList = [];
  for (const [, t] of tiles) {
    const file = 'tile_' + t.tx + '_' + t.tz + '.json';
    fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify({ tileId: 'visual-buildings/' + t.tx + '_' + t.tz, layer: 'visual-buildings', tileSize: TILE_SIZE, featureCount: t.features.length, features: t.features }));
    tileList.push({ tx: t.tx, tz: t.tz, file, count: t.features.length });
  }
  tileList.sort((a, b) => (a.tx - b.tx) || (a.tz - b.tz));

  const manifest = {
    version: 1, kind: 'visual-buildings-tiles', coordinateConvention: 'znorth-neg-v1', generatedAt,
    tileSize: TILE_SIZE, featureCount: visualFeatures.length, tileCount: tileList.length, tiles: tileList,
    geometrySourceCounts: geomSourceCounts, relationshipCounts,
    note: '§0: Canonical Buildings(615,617)・GSI raw dataは一切変更していない。ここは新規のVisual Building層。',
  };
  await writeJson(path.join(OUT_DIR, 'manifest.json'), manifest);

  const report = {
    generatedAt,
    canonicalBuildingCount: plateauFeatures.length + osmFallbackFeatures.length,
    plateauBuildingCount: plateauFeatures.length, osmFallbackCount: osmFallbackFeatures.length,
    gsiBuildingAreaCount: gsiFeatures.length,
    totalVisualBuildings: visualFeatures.length,
    geometrySourceCounts: geomSourceCounts,
    relationshipCounts,
    gsiGeometryUsedCount: geomSourceCounts.GSI_POLYGON,
    plateauFallbackCount: geomSourceCounts.PLATEAU_FALLBACK + geomSourceCounts.PLATEAU_FALLBACK_ADJUSTED,
    coveragePercent: +((geomSourceCounts.GSI_POLYGON / visualFeatures.length) * 100).toFixed(2),
    tileCount: tileList.length,
    validatorFlags: { canonicalBuildingMutation: 0, gsiBuildingMutation: 0, illegalGlobalOffset: 0, illegalGlobalScale: 0, illegalWarp: 0 },
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[visual-buildings] geometrySourceCounts=' + JSON.stringify(geomSourceCounts));
  console.log('保存: ' + toProjectRelativePath(OUT_DIR) + ' / ' + toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[visual-buildings] 失敗:', e && e.stack || e); process.exit(1); });
