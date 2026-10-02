#!/usr/bin/env node
// tools/build-osm-fallback-v2.js
// [Mission 32O] REBUILD OSM BUILDING FALLBACK AGAINST CORRECTED V2
//
//   旧 OSM fallback（41,505 棟・Mission 21B/29）は、回転していた V1 PLATEAU を基準に
//   「PLATEAU が無い場所」として選ばれていた（tools/build-osm-building-fallback.js）。
//   V2（生 CityGML → equirect）では 22,758 棟が PLATEAU と重なる（Mission 32N §A）。
//   ここでは **V2 PLATEAU だけを基準に** fallback を選び直す（旧 V1 footprint は一切読まない §3）。
//
//   ■ 選定（旧ルールの「場所」の条件は同じ。基準を V2 PLATEAU に替え、重複判定を面積ベースにする）
//     候補 = OSM building way（roof/construction 等を除く）で、footprint が有効（8〜60,000m²・自己交差なし）、
//            N03 2026 の区の内側にあるもの。
//     場所: (hole) V2 PLATEAU footprint が 50m cell + 8 近傍に無い
//           (sparse-mismatch) 100m cell で OSM 面積 >= 2.5 × V2 PLATEAU 面積 かつ OSM >= 5 棟
//     重複: tools/lib/osm-fallback-v2-classify.js（CLEAR / LIKELY は除外、AMBIGUOUS / VALID は採用）
//
//   ■ 出力（V1・V2(旧 OSM) には触れない。新 namespace）
//     data/processed/osaka-city/canonical/buildings-v2-osm-fallback/   … 新 fallback だけ（§1 source 分離）
//     data/processed/osaka-city/canonical/buildings-v2-osmv2/          … V2 PLATEAU（無変更で複製）+ 新 fallback
//     data/processed/osaka-city/derived-v2-osmv2/ と public/map-data/osaka-city/derived-v2-osmv2/
//     data/processed/osaka-city/osm-fallback-v2/candidates.json        … 候補ごとの計測値（再分類用）
//     data/reports/osm-fallback-v2-build.json
//
//   実行: node --max-old-space-size=12288 tools/build-osm-fallback-v2.js [--stage=analyze|write|derived|all]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { latLonToLiveCityWorld, LIVECITY_COORDINATE_SYSTEM_ID } from './lib/livecity-coordinate-system.js';
import { representativePoint } from './lib/building-representative-point.js';
import { classifyPointToWard } from './lib/point-in-polygon.js';
import { pbfPrimitiveStream } from './lib/osm-pbf-stream.js';
import {
  buildPlateauPresenceGrid, isInPlateauHole, buildFootprintDensityGrid, isSparseMismatch,
  isFallbackEligibleBuilding, isValidFootprint, toFallbackRecord, ringBbox, ringCentroid, ringArea,
} from './lib/osm-building-fallback.js';
import { buildPlateauIndex, measureOverlap, classifyOverlap, isRetainedClass, TH, FALLBACK_V2_CLASS } from './lib/osm-fallback-v2-classify.js';
import { polygonAreaM2, makeProvenance } from './lib/canonical-geometry-schema.js';
import { processDerivedLayer, buildingLayerOpts, DERIVED_LOD_ORDER } from './build-derived-geometry.js';
import { writeFilesVerified, readFileRetry } from './lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const O2 = {
  pbf: P('data', 'raw', 'osm', 'osaka-latest.osm.pbf'),
  v2Dir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-corrected'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  fallbackDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osm-fallback'),
  mergedDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  derivedRoot: P('data', 'processed', 'osaka-city', 'derived-v2-osmv2'),
  publicRoot: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2'),
  workDir: P('data', 'processed', 'osaka-city', 'osm-fallback-v2'),
  candidates: P('data', 'processed', 'osaka-city', 'osm-fallback-v2', 'candidates.json'),
  report: P('data', 'reports', 'osm-fallback-v2-build.json'),
};
export const OSM_FALLBACK_ID_PREFIX = 'cg_bldg_osm_';
const TILE_SIZE = 500;
const CELL_M = 50;
const MIN_FP_AREA_M2 = 8, MAX_FP_AREA_M2 = 60000; // 旧 fallback と同じ（Mission 29 §9）
const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 }; // build-canonical-buildings.js と同じ
const CITY_MARGIN = 2000;
const r2 = (v) => Math.round(v * 100) / 100;
const rj = (p) => JSON.parse(readFileRetry(p));
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const tileKeyOfBbox = (bb) => Math.floor(((bb.minX + bb.maxX) / 2) / TILE_SIZE) + '_' + Math.floor(((bb.minZ + bb.maxZ) / 2) / TILE_SIZE);

/** V2 canonical の PLATEAU（リングのみ）と旧 fallback（feature + attributes）を読む。 */
function loadV2() {
  const plateau = [];
  const oldFallback = new Map(); // canonicalId -> {feature, attrs, tile}
  const attrsByTile = new Map();
  for (const f of fs.readdirSync(O2.v2Dir)) {
    if (!isTile(f)) continue;
    const t = rj(path.join(O2.v2Dir, f));
    for (const ft of t.features) {
      if (ft.source.geometrySource === 'plateau-building') {
        plateau.push({ id: ft.canonicalId, ring: ft.coordinates[0], bb: ft.bbox, area: ft.areaM2 });
      } else {
        let at = attrsByTile.get(f);
        if (!at) attrsByTile.set(f, (at = rj(path.join(O2.v2Dir, 'attributes', f)).attributes));
        oldFallback.set(ft.canonicalId, { feature: ft, attrs: at[ft.canonicalId], tile: f });
      }
    }
  }
  return { plateau, oldFallback };
}

async function readOsmBuildings() {
  const bways = new Map();
  for await (const p of pbfPrimitiveStream(O2.pbf)) {
    if (p.type !== 'way') continue;
    const t = p.tags || {};
    if (!isFallbackEligibleBuilding(t.building)) continue;
    bways.set(p.id, { refs: p.refs, tags: { building: t.building, height: t.height, 'building:levels': t['building:levels'], name: t.name } });
  }
  const need = new Set();
  for (const v of bways.values()) for (const r of v.refs) need.add(r);
  const coord = new Map();
  for await (const p of pbfPrimitiveStream(O2.pbf)) {
    if (p.type !== 'node' || !need.has(p.id)) continue;
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) coord.set(p.id, [p.lat, p.lon]);
  }
  return { bways, coord };
}

// ────────────────────────────── stage 1: analyze ──────────────────────────────
export async function analyze() {
  const t0 = Date.now();
  console.log('[osm-fb-v2] V2 canonical 読み込み…');
  const { plateau, oldFallback } = loadV2();
  console.log('[osm-fb-v2] V2 PLATEAU', plateau.length, '旧 fallback', oldFallback.size);
  const plateauRings = plateau.map((p) => p.ring);
  const presence = buildPlateauPresenceGrid(plateauRings, CELL_M);
  const platDensity = buildFootprintDensityGrid(plateauRings, 100);
  const index = buildPlateauIndex(plateau, 40);
  const wards = rj(O2.wardPolys).wards;

  console.log('[osm-fb-v2] OSM PBF 読み込み…');
  const { bways, coord } = await readOsmBuildings();
  const stats = { buildingWays: bways.size, badFootprint: 0, tooSmall: 0, tooBig: 0, selfIntersect: 0, outsideCity: 0, cityBboxViolation: 0, inCity: 0 };
  const inCity = [];
  const osmDensity = new Map();
  for (const [wid, v] of bways) {
    const ring = [];
    for (const r of v.refs) { const ll = coord.get(r); if (ll) { const w = latLonToLiveCityWorld(ll[0], ll[1]); ring.push([r2(w.x), r2(w.z)]); } }
    if (ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    if (ring.length < 3 || v.refs.length < 4) { stats.badFootprint++; continue; }
    const vf = isValidFootprint(ring, { minArea: MIN_FP_AREA_M2, maxArea: MAX_FP_AREA_M2 });
    if (!vf.ok) {
      if (vf.reason === 'too-small') stats.tooSmall++; else if (vf.reason === 'too-big') stats.tooBig++;
      else if (vf.reason === 'self-intersect') stats.selfIntersect++; else stats.badFootprint++;
      continue;
    }
    const bb = ringBbox(ring);
    if (bb.maxX < GROUND_EXTENT.minX - CITY_MARGIN || bb.minX > GROUND_EXTENT.maxX + CITY_MARGIN
      || bb.maxZ < GROUND_EXTENT.minZ - CITY_MARGIN || bb.minZ > GROUND_EXTENT.maxZ + CITY_MARGIN) { stats.cityBboxViolation++; continue; }
    // §12: 区は N03 2026（旧ラベルは使わない）。V2 PLATEAU と同じ representativePoint + classifyPointToWard。
    const rp = representativePoint(ring);
    const wr = rp.valid ? classifyPointToWard(rp.x, rp.z, wards) : { wardId: null, status: 'no-representative-point' };
    if (!wr.wardId) { stats.outsideCity++; continue; }
    stats.inCity++;
    const c = ringCentroid(ring);
    const gk = Math.floor(c[0] / 100) + ',' + Math.floor(c[1] / 100);
    const od = osmDensity.get(gk) || { count: 0, area: 0 };
    od.count++; od.area += vf.area; osmDensity.set(gk, od);
    inCity.push({ wid, ring, c, gk, area: vf.area, wardId: wr.wardId, wardStatus: wr.status, tags: v.tags });
  }
  bways.clear(); coord.clear();
  console.log('[osm-fb-v2] in-city OSM', inCity.length, JSON.stringify(stats));

  const sparseCells = new Set();
  for (const [gk, od] of osmDensity) if (isSparseMismatch(platDensity.get(gk), od)) sparseCells.add(gk);

  // 旧 fallback の OSM way id
  const oldWayIds = new Set([...oldFallback.keys()].map((id) => Number(id.slice(OSM_FALLBACK_ID_PREFIX.length))));
  const seenOld = new Set();
  const candidates = [];
  let measured = 0;
  for (const o of inCity) {
    const inHole = isInPlateauHole(o.c[0], o.c[1], presence, CELL_M);
    const inSparse = sparseCells.has(o.gk);
    const isOld = oldWayIds.has(o.wid);
    if (!inHole && !inSparse && !isOld) continue;
    if (isOld) seenOld.add(o.wid);
    const m = measureOverlap(o.ring, index);
    const k = classifyOverlap(m);
    measured++;
    if (measured % 20000 === 0) console.log('[osm-fb-v2] measured', measured);
    candidates.push({
      wayId: o.wid, canonicalId: OSM_FALLBACK_ID_PREFIX + o.wid, isOld,
      area: 'gap', gapReason: inHole ? 'hole' : (inSparse ? 'sparse-mismatch' : null),
      wardId: o.wardId, wardStatus: o.wardStatus, tags: o.tags, ring: o.ring,
      metrics: {
        osmArea: +m.osmArea.toFixed(2), intersectionArea: +m.intersectionArea.toFixed(2), coveredFraction: +m.coveredFraction.toFixed(4),
        plateauPartners: m.plateauPartners, partnerIds: m.partnerIds, maxIoU: +m.maxIoU.toFixed(4),
        maxPlateauInside: +m.maxPlateauInside.toFixed(4), maxPlateauInsideShare: +m.maxPlateauInsideShare.toFixed(4),
        centroidInPlateau: m.centroidInPlateau, maxBboxIoU: +m.maxBboxIoU.toFixed(4),
        nearestDistanceM: m.nearestDistanceM == null ? null : +m.nearestDistanceM.toFixed(2), samples: m.samples,
      },
      cls: k.cls, rule: k.rule,
    });
  }
  const notReproduced = [...oldWayIds].filter((w) => !seenOld.has(w));
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '32O',
    v2Canonical: { generatedAt: rj(path.join(O2.v2Dir, 'manifest.json')).generatedAt, plateau: plateau.length, oldFallback: oldFallback.size },
    thresholds: TH, stats, sparseCells: sparseCells.size, presenceCells: presence.size,
    oldFallbackNotReproduced: notReproduced.length, oldFallbackNotReproducedSample: notReproduced.slice(0, 20),
    elapsedMs: Date.now() - t0,
    candidates,
  };
  fs.mkdirSync(O2.workDir, { recursive: true });
  writeFilesVerified(O2.workDir, new Map([['candidates.json', JSON.stringify(out)]]), { label: 'osm-fallback-v2 candidates', settleMs: 5000, removeStray: false });
  console.log('[osm-fb-v2] candidates', candidates.length, 'old not reproduced', notReproduced.length, Math.round((Date.now() - t0) / 1000) + 's');
  return out;
}

// ────────────────────────────── stage 2: write canonical ──────────────────────────────
function newFallbackFeature(c, generatedAt) {
  const rec = toFallbackRecord(c.wayId, c.ring, c.tags, c.gapReason, c.wardId);
  const bb = ringBbox(c.ring);
  const cen = ringCentroid(c.ring);
  const coords = [c.ring.map(([x, z]) => [r2(x), r2(z)])];
  const feature = {
    canonicalId: c.canonicalId, layer: 'buildings', geometryType: 'Polygon', coordinates: coords,
    bbox: { minX: r2(bb.minX), maxX: r2(bb.maxX), minZ: r2(bb.minZ), maxZ: r2(bb.maxZ) },
    areaM2: +polygonAreaM2('Polygon', coords).toFixed(2), centroid: [r2(cen[0]), r2(cen[1])],
    coordinateConvention: 'znorth-neg-v1', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID,
    source: makeProvenance({
      geometrySource: 'osm-building', attributeSources: ['osm-building'], confidence: +rec.confidence.toFixed(2),
      sourceIds: ['way/' + c.wayId], generatedAt, notes: '[32O] OSM fallback V2（V2 PLATEAU 基準で新規採用）',
    }),
    qaFlags: ['fallback:' + c.gapReason, 'fallback-v2:' + c.cls],
  };
  if (rec.heightUnknown) feature.qaFlags.push('height-unknown');
  const attrs = {
    source: 'osm-building', wardId: c.wardId, usage: rec.usage, normalizedUsage: rec.normalizedUsage,
    usageCategory: rec.usageCategory, usageLabel: rec.usageLabel, heightM: rec.h, heightSource: rec.heightSource,
    heightUnknown: !!rec.heightUnknown, levels: null, confidence: feature.source.confidence, repMethod: 'centroid',
    fallbackReason: c.gapReason, wardIdV1: null, wardStatus: c.wardStatus, rawWardName: null, rawSourceKind: 'osm',
    fallbackV2Class: c.cls, fallbackV2Rule: c.rule, fallbackV2Status: 'new',
  };
  return { feature, attrs };
}
function retainedOldFeature(old, c, generatedAt) {
  // 旧 fallback の geometry / canonicalId はそのまま（stable ID §11）。場所の理由・区・分類だけ更新する。
  const feature = JSON.parse(JSON.stringify(old.feature));
  feature.qaFlags = (feature.qaFlags || []).filter((q) => !/^fallback:/.test(q) && !/^fallback-v2:/.test(q));
  feature.qaFlags.unshift('fallback:' + c.gapReason);
  feature.qaFlags.push('fallback-v2:' + c.cls);
  feature.source = { ...feature.source, generatedAt, notes: '[32O] OSM fallback V2（旧 fallback を V2 PLATEAU 基準で再判定し採用）' };
  const attrs = {
    ...old.attrs, wardIdV1: old.attrs.wardIdV1 ?? null, wardIdV2Old: old.attrs.wardId,
    wardId: c.wardId, wardStatus: c.wardStatus, fallbackReason: c.gapReason,
    fallbackV2Class: c.cls, fallbackV2Rule: c.rule, fallbackV2Status: 'retained',
  };
  return { feature, attrs };
}

export function selectFallback(cands) {
  // 旧 fallback の除外理由: 重複（CLEAR/LIKELY）/ 場所が PLATEAU gap でなくなった / OSM 側で再現できない
  const selected = [], removed = [];
  for (const c of cands) {
    if (c.gapReason && isRetainedClass(c.cls)) selected.push(c);
    else if (c.isOld) removed.push({ c, reason: isRetainedClass(c.cls) ? 'NOT_IN_PLATEAU_GAP' : c.cls });
  }
  return { selected, removed };
}

export function writeCanonical(analysis) {
  const t0 = Date.now();
  const generatedAt = new Date().toISOString();
  const cands = analysis.candidates;
  const { plateau: _p, oldFallback } = loadV2();
  _p.length = 0;
  const { selected, removed } = selectFallback(cands);
  const fbFeatures = new Map(), fbAttrs = new Map(); // tileKey -> []
  const geomMismatch = { checked: 0, differs: 0, sample: [] };
  for (const c of selected) {
    let fa;
    if (c.isOld) {
      const old = oldFallback.get(c.canonicalId);
      geomMismatch.checked++;
      if (JSON.stringify(old.feature.coordinates[0]) !== JSON.stringify(c.ring)) { geomMismatch.differs++; if (geomMismatch.sample.length < 10) geomMismatch.sample.push(c.canonicalId); }
      fa = retainedOldFeature(old, c, generatedAt);
    } else {
      fa = newFallbackFeature(c, generatedAt);
    }
    const k = tileKeyOfBbox(fa.feature.bbox);
    if (!fbFeatures.has(k)) { fbFeatures.set(k, []); fbAttrs.set(k, {}); }
    fbFeatures.get(k).push(fa.feature);
    fbAttrs.get(k)[fa.feature.canonicalId] = fa.attrs;
  }
  const v2Manifest = rj(path.join(O2.v2Dir, 'manifest.json'));

  // ── fallback 単独（§1 source 分離） ──
  const fbFiles = new Map(), fbAttrFiles = new Map();
  let fbCount = 0;
  for (const [k, feats] of fbFeatures) {
    const [tx, tz] = k.split('_').map(Number);
    fbFiles.set(`tile_${tx}_${tz}.json`, JSON.stringify({ tx, tz, tileSize: TILE_SIZE, coordinateConvention: 'znorth-neg-v1', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, generatedAt, count: feats.length, features: feats }));
    fbAttrFiles.set(`tile_${tx}_${tz}.json`, JSON.stringify({ tx, tz, count: feats.length, attributes: fbAttrs.get(k) }));
    fbCount += feats.length;
  }
  fbFiles.set('manifest.json', JSON.stringify({
    version: 1, layer: 'buildings', kind: 'canonical-geometry', variant: 'v2-osm-fallback',
    sourceKind: 'OSM_FALLBACK', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, generatedAt, tileSize: TILE_SIZE,
    featureCount: fbCount, tiles: fbFeatures.size,
    selectedAgainst: { canonical: toProjectRelativePath(O2.v2Dir), generatedAt: v2Manifest.generatedAt, plateauOnly: true },
    usesV1Footprints: false,
  }, null, 2));
  const wFb = writeFilesVerified(O2.fallbackDir, fbFiles, { label: 'canonical/buildings-v2-osm-fallback' });
  const wFbA = writeFilesVerified(path.join(O2.fallbackDir, 'attributes'), fbAttrFiles, { label: 'canonical/buildings-v2-osm-fallback/attributes' });
  fbFiles.clear(); fbAttrFiles.clear();

  // ── merged（V2 PLATEAU は feature / attributes を無変更で複製 + 新 fallback） ──
  const mergedFiles = new Map(), mergedAttrFiles = new Map();
  let plateauCount = 0, mergedCount = 0;
  const keys = new Set([...fs.readdirSync(O2.v2Dir).filter(isTile).map((f) => f.slice(5, -5)), ...fbFeatures.keys()]);
  for (const k of keys) {
    const f = `tile_${k}.json`;
    const [tx, tz] = k.split('_').map(Number);
    const feats = [], attrs = {};
    if (fs.existsSync(path.join(O2.v2Dir, f))) {
      const t = rj(path.join(O2.v2Dir, f));
      const a = rj(path.join(O2.v2Dir, 'attributes', f)).attributes;
      for (const ft of t.features) {
        if (ft.source.geometrySource !== 'plateau-building') continue;
        feats.push(ft); attrs[ft.canonicalId] = a[ft.canonicalId]; plateauCount++;
      }
    }
    for (const ft of fbFeatures.get(k) || []) { feats.push(ft); attrs[ft.canonicalId] = fbAttrs.get(k)[ft.canonicalId]; }
    if (!feats.length) continue;
    mergedCount += feats.length;
    mergedFiles.set(f, JSON.stringify({ tx, tz, tileSize: TILE_SIZE, coordinateConvention: 'znorth-neg-v1', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, generatedAt, count: feats.length, features: feats }));
    mergedAttrFiles.set(f, JSON.stringify({ tx, tz, count: feats.length, attributes: attrs }));
  }
  const mergedManifest = {
    version: 2, layer: 'buildings', kind: 'canonical-geometry', variant: 'v2-corrected-osmv2',
    coordinateConvention: 'znorth-neg-v1', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, generatedAt, tileSize: TILE_SIZE,
    featureCount: mergedCount, plateauCount, fallbackCount: fbCount, tiles: mergedFiles.size,
    sources: {
      PLATEAU: { from: toProjectRelativePath(O2.v2Dir), generatedAt: v2Manifest.generatedAt, count: plateauCount, copiedVerbatim: true },
      OSM_FALLBACK: { from: toProjectRelativePath(O2.fallbackDir), count: fbCount, selectedAgainst: 'V2 PLATEAU' },
    },
    zone7Used: false,
  };
  mergedFiles.set('manifest.json', JSON.stringify(mergedManifest, null, 2));
  const wM = writeFilesVerified(O2.mergedDir, mergedFiles, { label: 'canonical/buildings-v2-osmv2' });
  const wMA = writeFilesVerified(path.join(O2.mergedDir, 'attributes'), mergedAttrFiles, { label: 'canonical/buildings-v2-osmv2/attributes' });
  mergedFiles.clear(); mergedAttrFiles.clear();

  const deprecated = removed.map(({ c, reason }) => ({ canonicalId: c.canonicalId, reason, rule: c.rule, replacedBy: c.metrics.partnerIds.map((x) => x) }));
  const missingOld = analysis.oldFallbackNotReproducedSample;
  return {
    generatedAt, plateauCount, fallbackCount: fbCount, total: mergedCount,
    retainedOld: selected.filter((c) => c.isOld).length, newlyAdded: selected.filter((c) => !c.isOld).length,
    removedOld: removed.length + analysis.oldFallbackNotReproduced,
    removedByReason: removed.reduce((a, { reason }) => ((a[reason] = (a[reason] || 0) + 1), a), analysis.oldFallbackNotReproduced ? { SOURCE_NOT_REPRODUCED: analysis.oldFallbackNotReproduced } : {}),
    oldNotReproducedSample: missingOld,
    retainedGeometryCheck: geomMismatch,
    deprecated,
    writes: { fallback: wFb, fallbackAttrs: wFbA, merged: wM, mergedAttrs: wMA },
    elapsedMs: Date.now() - t0,
  };
}

// ────────────────────────────── stage 3: derived / sidecars ──────────────────────────────
function publishDir(src, dst, label) {
  const m = JSON.parse(readFileRetry(path.join(src, 'manifest.json')));
  const files = new Map([['manifest.json', readFileRetry(path.join(src, 'manifest.json'))]]);
  let bytes = 0;
  for (const t of m.tiles || []) { const body = readFileRetry(path.join(src, t.file)); files.set(t.file, body); bytes += Buffer.byteLength(body); }
  const w = writeFilesVerified(dst, files, { label });
  return { files: files.size, bytes, rewrites: w.rewrites, strayRemoved: w.strayRemoved };
}
function runTool(label, script, env) {
  console.log('[osm-fb-v2] ' + label + ' …');
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', P('tools', script)], { env: { ...process.env, ...env }, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(label + ' が失敗 (exit ' + r.status + ')');
}
export function buildDerived() {
  const t0 = Date.now();
  const m = rj(path.join(O2.mergedDir, 'manifest.json'));
  const derived = processDerivedLayer('buildings', buildingLayerOpts({
    srcDir: O2.mergedDir, attrDir: path.join(O2.mergedDir, 'attributes'),
    generatedAt: m.generatedAt, sourceVersion: m.generatedAt,
    outRoot: O2.derivedRoot, layerDir: 'buildings', syncedWrite: true,
  }));
  const published = {};
  for (const lod of DERIVED_LOD_ORDER) published[lod] = publishDir(path.join(O2.derivedRoot, lod, 'buildings'), path.join(O2.publicRoot, lod, 'buildings'), 'public osmv2 ' + lod);
  // §21: placement policy は新しい建物集合で作り直す（31E 索引は V1 座標由来なので使わない）
  const placementDir = path.join(O2.derivedRoot, 'building-placement');
  runTool('placement policy (V2+OSMv2)', 'build-building-placement-policy.js', {
    PLACEMENT_BUILD_DIR: O2.mergedDir, PLACEMENT_ATTR_DIR: path.join(O2.mergedDir, 'attributes'),
    PLACEMENT_OUT_DIR: placementDir, PLACEMENT_REPORT: P('data', 'reports', 'building-placement-policy-v2-osmv2.json'),
    PLACEMENT_NO_31E: '1', PLACEMENT_SYNCED_WRITE: '1',
  });
  const wardIndex = path.join(O2.derivedRoot, 'building-ward-index.json');
  runTool('ward index (V2+OSMv2)', 'build-ward-building-index.js', {
    WARD_INDEX_BUILD_DIR: O2.mergedDir, WARD_INDEX_ATTR_DIR: path.join(O2.mergedDir, 'attributes'),
    WARD_INDEX_PLACE_DIR: placementDir, WARD_INDEX_OUT: wardIndex,
    WARD_INDEX_REPORT: P('data', 'reports', 'ward-building-index-v2-osmv2.json'),
  });
  published.placement = publishDir(placementDir, path.join(O2.publicRoot, 'building-placement'), 'public osmv2 placement');
  writeFilesVerified(O2.publicRoot, new Map([
    ['building-ward-index.json', readFileRetry(wardIndex)],
    ['manifest.json', JSON.stringify({
      version: 1, kind: 'buildings-v2-corrected-osmv2', generatedAt: new Date().toISOString(),
      coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID,
      note: 'Mission 32O。V2 PLATEAU + V2 基準で選び直した OSM fallback の派生物だけを置く。道路等は derived/ を使う。',
      contents: ['{far,mid,near}/buildings', 'building-placement', 'building-ward-index.json'],
    }, null, 2)],
  ]), { label: 'public osmv2 top', settleMs: 5000, removeStray: false });
  return { derived: derived.lod, published, elapsedMs: Date.now() - t0 };
}

async function main() {
  const stageArg = (process.argv.find((a) => a.startsWith('--stage=')) || '--stage=all').slice(8);
  const prev = fs.existsSync(O2.report) ? rj(O2.report) : {};
  const report = { ...prev, version: 1, missionId: '32O' };
  let analysis = null;
  if (stageArg === 'analyze' || stageArg === 'all') {
    analysis = await analyze();
    const { candidates, ...rest } = analysis;
    report.analysis = rest;
  }
  if (stageArg === 'write' || stageArg === 'all') {
    analysis = analysis || rj(O2.candidates);
    const w = writeCanonical(analysis);
    const { deprecated, ...rest } = w;
    report.canonical = rest;
    report.deprecatedCount = deprecated.length;
    writeFilesVerified(O2.workDir, new Map([['deprecated-ids.json', JSON.stringify({ generatedAt: w.generatedAt, count: deprecated.length, ids: deprecated })]]), { label: 'deprecated ids', settleMs: 5000, removeStray: false });
    console.log('[osm-fb-v2] canonical', JSON.stringify(rest));
  }
  if (stageArg === 'derived' || stageArg === 'all') {
    report.derived = buildDerived();
    console.log('[osm-fb-v2] derived', JSON.stringify(report.derived.derived));
  }
  report.generatedAt = new Date().toISOString();
  fs.writeFileSync(O2.report, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  main().then(() => { console.log('[osm-fb-v2] DONE'); process.exit(0); })
    .catch((e) => { console.error('[osm-fb-v2] 失敗:', e && e.stack || e); process.exit(1); });
}
