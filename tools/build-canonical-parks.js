#!/usr/bin/env node
// tools/build-canonical-parks.js
// [Mission 31F §6/§7] Canonical Parks 正式化。
//   OSM leisure=park / landuse=recreation_ground 等を canonical geometry として採用。
//   ★ landuse=grass を一律「公園」扱いしない（§7）。parkClass 属性で分類し、grass は grass のまま。
//   ★ 31E の RECLASSIFY 23 件（建物 share > 80% ＝ 実質街区）を parkClass=misclassified-block へ反映。
//   ★ 82 件の possibly-too-broad は source 証拠が無いので clip しない（§7）。qaFlag のみ。
//
//   projection / znorth-neg-v1 不変。production / protected HTML 不変。
//   出力: data/processed/osaka-city/canonical/parks/{manifest.json, tile_*.json}
//         data/reports/canonical-parks-build.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import {
  COORDINATE_CONVENTION, CONFIDENCE, SOURCE_PRIORITY, makeProvenance, makeCanonicalFeature,
  validateCanonicalFeature, ringAreaM2, bboxOf,
} from './lib/canonical-geometry-schema.js';
import { ringSelfIntersects } from './lib/geometry-simplify.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AREA = P('config', 'areas', 'osaka-city.json');
const RAW = P('data', 'raw', 'osaka-city', 'parks-osm.json');
const PARK_TILES = P('public', 'map-data', 'osaka-city', 'parks');
const MANUAL_REVIEW = P('data', 'reports', 'canonical-manual-review.json');
const CORR_ADVISORY = P('data', 'processed', 'osaka-city', 'canonical', 'corrections', 'parks', 'park-polygon-reclassify-advisory.json');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'parks');
const REPORT = P('data', 'reports', 'canonical-parks-build.json');

const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const MARGIN = 2000;
const TILE_SIZE = 2000;
const MIN_AREA_M2 = 40;
const GIANT_AREA_M2 = 4_000_000;

// §7 分類: OSM タグ → parkClass。grass を park と同一視しない。
export function classifyPark(tags) {
  const l = tags.leisure, u = tags.landuse, n = (tags.natural || '');
  if (l === 'park') return { parkClass: 'park', isGreenSpace: true, rankable: true };
  if (l === 'garden') return { parkClass: 'garden', isGreenSpace: true, rankable: true };
  if (l === 'playground') return { parkClass: 'playground', isGreenSpace: true, rankable: true };
  if (l === 'pitch' || l === 'sports_centre' || l === 'stadium' || l === 'track' || l === 'golf_course') return { parkClass: 'sports_ground', isGreenSpace: false, rankable: true };
  if (l === 'nature_reserve') return { parkClass: 'green_space', isGreenSpace: true, rankable: true };
  if (l === 'water_park') return { parkClass: 'other', isGreenSpace: false, rankable: false };
  if (u === 'recreation_ground') return { parkClass: 'recreation_ground', isGreenSpace: true, rankable: true };
  if (u === 'forest' || u === 'meadow' || n === 'wood' || n === 'scrub') return { parkClass: 'green_space', isGreenSpace: true, rankable: false };
  if (u === 'grass' || u === 'village_green') return { parkClass: 'grass', isGreenSpace: true, rankable: false };
  if (u === 'cemetery') return { parkClass: 'other', isGreenSpace: false, rankable: false };
  return { parkClass: 'other', isGreenSpace: false, rankable: false };
}

function projector(area) {
  const { centerLat, centerLon, metersPerDegree } = area.projection;
  const cosf = Math.cos((centerLat * Math.PI) / 180);
  return (lon, lat) => [
    +(((lon - centerLon) * cosf * metersPerDegree)).toFixed(2),
    +(-((lat - centerLat) * metersPerDegree)).toFixed(2), // znorth-neg-v1
  ];
}

function loadReclassifyTargets() {
  // 31E advisory（park-polygon-reclassify-advisory.json）の parkId / parkName を集める。
  const byId = new Map(), byName = new Map();
  if (fs.existsSync(CORR_ADVISORY)) {
    const adv = JSON.parse(fs.readFileSync(CORR_ADVISORY, 'utf-8'));
    for (const t of (adv.targets || [])) {
      if (t.parkId) byId.set(t.parkId, t);
      if (t.parkName) byName.set(t.parkName, t);
    }
  }
  return { byId, byName };
}
function loadTooBroadTargets() {
  const names = new Set();
  if (fs.existsSync(MANUAL_REVIEW)) {
    const mr = JSON.parse(fs.readFileSync(MANUAL_REVIEW, 'utf-8'));
    for (const it of (mr.items || [])) {
      if (it.pairType === 'PARK_BUILDING' && it.causeCandidate === 'park-polygon-possibly-too-broad' && it.names && it.names.park) names.add(it.names.park);
    }
  }
  return names;
}

// 既存 park tile の id を name で引けるように（31E conflict の parkId と対応づけるため）
function loadExistingParkIds() {
  const byName = new Map();
  if (!fs.existsSync(PARK_TILES)) return byName;
  const seen = new Set();
  for (const f of fs.readdirSync(PARK_TILES)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    for (const ft of (JSON.parse(fs.readFileSync(path.join(PARK_TILES, f), 'utf-8')).features || [])) {
      if (seen.has(ft.id) || !ft.name) continue;
      seen.add(ft.id);
      if (!byName.has(ft.name)) byName.set(ft.name, ft.id);
    }
  }
  return byName;
}

async function main() {
  if (!fs.existsSync(RAW)) { console.error('[canonical-parks] raw parks-osm.json が無い（ローカル取得物）'); process.exit(1); }
  const generatedAt = new Date().toISOString();
  const area = JSON.parse(fs.readFileSync(AREA, 'utf-8'));
  const toXZ = projector(area);
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf-8'));
  const reclass = loadReclassifyTargets();
  const tooBroad = loadTooBroadTargets();
  const existingIds = loadExistingParkIds();

  const out = [];
  const stats = {
    inputElements: (raw.elements || []).length,
    byParkClass: {}, byGeom: { Polygon: 0, MultiPolygon: 0 },
    reclassified: 0, flaggedTooBroad: 0, grassNotPark: 0,
    rejected: { 'too-small': 0, 'giant': 0, 'self-intersection': 0, 'few-points': 0, 'bbox-violation': 0, 'not-way': 0, 'no-tags': 0 },
    schemaErrors: 0,
  };

  for (const el of (raw.elements || [])) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) { stats.rejected['not-way']++; continue; }
    const tags = el.tags || {};
    if (!tags.leisure && !tags.landuse && !tags.natural) { stats.rejected['no-tags']++; continue; }
    const cls = classifyPark(tags);
    let ring = el.geometry.map((pt) => toXZ(pt.lon, pt.lat));
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring = ring.slice(0, -1);
    if (ring.length < 3) { stats.rejected['few-points']++; continue; }
    const a = ringAreaM2(ring);
    if (a < MIN_AREA_M2) { stats.rejected['too-small']++; continue; }
    if (a > GIANT_AREA_M2) { stats.rejected['giant']++; continue; }
    if (ringSelfIntersects(ring)) { stats.rejected['self-intersection']++; continue; }
    const bb = bboxOf([ring]);
    if (bb.maxX < GROUND_EXTENT.minX - MARGIN || bb.minX > GROUND_EXTENT.maxX + MARGIN
      || bb.maxZ < GROUND_EXTENT.minZ - MARGIN || bb.minZ > GROUND_EXTENT.maxZ + MARGIN) { stats.rejected['bbox-violation']++; continue; }

    const name = tags.name || null;
    // canonicalId は OSM way id ベースで一意（同名公園が複数あるため name ベースは衝突する）。
    const stableId = 'osm_' + el.id;
    const legacyTileId = name ? (existingIds.get(name) || null) : null; // 31E conflict の parkId 対応づけ用
    const qaFlags = [];
    let parkClass = cls.parkClass;
    let confidence = CONFIDENCE.OSM_PARK_POLYGON; // 0.88

    // §7: grass は park 扱いしない
    if (parkClass === 'grass') { stats.grassNotPark++; qaFlags.push('landuse-grass-not-park'); confidence = 0.70; }

    // 31E RECLASSIFY（building share > 80% ＝ 実質街区）
    const rc = (name && reclass.byName.get(name)) || (legacyTileId && reclass.byId.get(legacyTileId));
    if (rc) {
      parkClass = 'misclassified-block';
      confidence = 0.45;
      qaFlags.push('reclassified-31E:park-polygon-not-a-park', 'building-share-' + (rc.buildingShareOfPark != null ? Math.round(rc.buildingShareOfPark * 100) + 'pct' : 'high'));
      stats.reclassified++;
    } else if (name && tooBroad.has(name)) {
      // 82 件 possibly-too-broad: clip せず flag のみ（§7）
      qaFlags.push('possibly-too-broad-31E:manual-review');
      confidence = Math.min(confidence, 0.78);
      stats.flaggedTooBroad++;
    }

    const prov = makeProvenance({
      geometrySource: 'osm-park-polygon',
      attributeSources: ['osm-park', name ? 'osm-name' : null].filter(Boolean),
      confidence: +confidence.toFixed(2),
      sourceIds: ['way/' + el.id],
      generatedAt,
      notes: `OSM ${tags.leisure ? 'leisure=' + tags.leisure : tags.landuse ? 'landuse=' + tags.landuse : 'natural=' + tags.natural} → parkClass=${parkClass}。` + (rc ? ' 31E RECLASSIFY 反映。' : ''),
    });
    const f = makeCanonicalFeature({
      canonicalId: 'cg_park_' + stableId.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60),
      layer: 'parks', geometryType: 'Polygon', coordinates: [ring],
      provenance: prov,
      attributes: {
        name, parkClass, legacyTileId,
        osmLeisure: tags.leisure || null, osmLanduse: tags.landuse || null, osmNatural: tags.natural || null,
        isGreenSpace: cls.isGreenSpace, rankable: cls.rankable && parkClass !== 'misclassified-block' && parkClass !== 'grass',
        operator: tags.operator || null,
      },
      qaFlags,
      centerlineRef: null, widthProfile: null,
    });
    const v = validateCanonicalFeature(f);
    if (!v.ok) { stats.schemaErrors++; f.qaFlags.push('schema-error:' + v.errors[0]); }
    out.push(f);
    stats.byParkClass[parkClass] = (stats.byParkClass[parkClass] || 0) + 1;
    stats.byGeom.Polygon++;
  }

  // ── tile 化 ──
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tileMap = new Map();
  for (const f of out) {
    for (let tx = Math.floor(f.bbox.minX / TILE_SIZE); tx <= Math.floor(f.bbox.maxX / TILE_SIZE); tx++)
      for (let tz = Math.floor(f.bbox.minZ / TILE_SIZE); tz <= Math.floor(f.bbox.maxZ / TILE_SIZE); tz++) {
        const k = tx + '_' + tz;
        if (!tileMap.has(k)) tileMap.set(k, []);
        tileMap.get(k).push(f);
      }
  }
  const tiles = [];
  for (const [k, feats] of [...tileMap.entries()].sort()) {
    const [tx, tz] = k.split('_').map(Number);
    fs.writeFileSync(path.join(OUT_DIR, `tile_${tx}_${tz}.json`), JSON.stringify({ tx, tz, tileSize: TILE_SIZE, coordinateConvention: COORDINATE_CONVENTION, count: feats.length, features: feats }));
    tiles.push({ tx, tz, file: `tile_${tx}_${tz}.json`, count: feats.length });
  }
  const bbox = bboxOf(out.map((f) => f.coordinates));
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({
    version: 1, layer: 'parks', kind: 'canonical-geometry', coordinateConvention: COORDINATE_CONVENTION,
    generatedAt, tileSize: TILE_SIZE, featureCount: out.length, bbox,
    sourcePriority: SOURCE_PRIORITY.parks,
    byParkClass: stats.byParkClass,
    classificationNote: 'landuse=grass は parkClass=grass（park 扱いしない §7）。31E RECLASSIFY 23 は parkClass=misclassified-block。',
    simplification: 'none。LOD simplify は derived/ で。',
    tiles,
  }, null, 2));

  const report = {
    generatedAt, tileDir: toProjectRelativePath(OUT_DIR),
    inputElements: stats.inputElements, featureCount: out.length,
    byParkClass: stats.byParkClass, byGeom: stats.byGeom,
    grassClassifiedAsGrass: stats.grassNotPark,
    reclassifiedFrom31E: stats.reclassified,
    flaggedTooBroadFrom31E: stats.flaggedTooBroad,
    rejected: stats.rejected, schemaErrors: stats.schemaErrors,
    tiles: tiles.length, bbox,
    RESULT: (out.length > 500 && stats.schemaErrors === 0) ? 'PASS' : (stats.schemaErrors > 0 ? 'SCHEMA-FAIL' : 'EMPTY'),
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[canonical-parks] features=' + out.length + '  byParkClass=' + JSON.stringify(stats.byParkClass));
  console.log('  grass→grass ' + stats.grassNotPark + ' / 31E reclassified ' + stats.reclassified + ' / flagged too-broad ' + stats.flaggedTooBroad);
  console.log('  rejected: ' + JSON.stringify(stats.rejected) + '  schemaErrors=' + stats.schemaErrors + '  tiles=' + tiles.length);
  console.log('保存: ' + toProjectRelativePath(OUT_DIR) + ' / ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (report.RESULT !== 'PASS') process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[canonical-parks] 失敗:', e && e.stack || e); process.exit(1); });
