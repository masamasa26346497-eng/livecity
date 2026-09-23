#!/usr/bin/env node
// tools/audit/canonical-conflicts.js
// [Mission 31A §6/§19] Canonical layer 同士の geometry conflict 監査。
//   「重なり = 即 ERROR」ではない。EXPLAINED 可能な重なり（bridge / station / over-water 構造 /
//   OSM 誤描画 / centerline ずれ）を意味付けし、説明不能な大面積相互貫入だけ HIGH にする。
//
//   31A では canonical water prototype だけが存在するため、実計算できるのは Building ∩ Water のみ。
//   他ペア（Building∩Road / Road∩Water / …）は canonical roads/buildings が未構築のため pending。
//
//   出力: data/reports/canonical-conflicts.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

// conflict の安定 ID。pair prefix + feature 群のソート済みハッシュ（build ごとに不変）。
function mkConflictId(prefix, anchorId, otherIds) {
  const key = [anchorId || '?', ...(otherIds || []).filter(Boolean).sort()].join('|');
  return prefix + '_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}
import {
  CONFLICT_PAIRS, CONFLICT_EXPLANATIONS, classifyConflictSeverity, ringAreaM2, polygonAreaM2,
} from '../lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON_WATER = P('data', 'processed', 'osaka-city', 'canonical', 'water.json');
const CANON_ROADS_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const BUILD_DIR = P('public', 'map-data', 'osaka-city', 'buildings');
const ROADS_DIR = P('public', 'map-data', 'osaka-city', 'roads');
const REPORT = P('data', 'reports', 'canonical-conflicts.json');

const GRID_M = 8;
const MIN_WATER_AREA_M2 = 300;   // これ未満の水面は skip（細水路・ミクロ池）
const HASH_M = 60;

function pointInRing(x, z, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) ins = !ins;
  }
  return ins;
}
function ringBbox(ring) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const [x, z] of ring) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
  return { minX: a, maxX: b, minZ: c, maxZ: d };
}

function loadBuildings() {
  const list = [];
  for (const ds of fs.readdirSync(BUILD_DIR)) {
    const dp = path.join(BUILD_DIR, ds);
    if (!fs.statSync(dp).isDirectory() || ds === 'unclassified') continue;
    const src = ds === 'osaka-osm-fallback' ? 'osm-building' : 'plateau-building';
    const conf = ds === 'osaka-osm-fallback' ? 0.82 : 0.95;
    for (const f of fs.readdirSync(dp)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      const t = JSON.parse(fs.readFileSync(path.join(dp, f), 'utf-8'));
      for (const b of (t.buildings || [])) {
        if (!Array.isArray(b.fp) || b.fp.length < 3) continue;
        // usage / ulabel は semantic evidence（§12）。PLATEAU は usage コード、fallback は usageCategory。
        list.push({
          id: b.id || null, fp: b.fp, rb: ringBbox(b.fp), src, conf, area: ringAreaM2(b.fp),
          h: b.h != null ? +b.h : (b.renderHeight != null ? +b.renderHeight : null),
          usage: b.usage || b.normalizedUsage || null,
          ulabel: b.ulabel || b.usageLabel || null,
          usageCategory: b.usageCategory || null,
          wardId: b.wardId || (ds.startsWith('osaka-') ? ds.slice(6) : null),
          fallbackReason: b.fallbackReason || null,
        });
      }
    }
  }
  return list;
}
function buildHash(buildings) {
  const h = new Map();
  for (const b of buildings) {
    for (let cx = Math.floor(b.rb.minX / HASH_M); cx <= Math.floor(b.rb.maxX / HASH_M); cx++)
      for (let cz = Math.floor(b.rb.minZ / HASH_M); cz <= Math.floor(b.rb.maxZ / HASH_M); cz++) {
        const k = cx + ',' + cz;
        if (!h.has(k)) h.set(k, []);
        h.get(k).push(b);
      }
  }
  return h;
}

// water feature を「対象 polygon 群」に展開（Polygon / MultiPolygon 両対応。ring = outer のみ使用）。
function waterOuterRings(wf) {
  if (wf.geometryType === 'Polygon') return [wf.coordinates[0]];
  if (wf.geometryType === 'MultiPolygon') return wf.coordinates.map((poly) => poly[0]).filter(Boolean);
  return [];
}
function loadRoadSegs() {
  const segs = [];
  if (!fs.existsSync(ROADS_DIR)) return segs;
  const seen = new Set();
  for (const f of fs.readdirSync(ROADS_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(ROADS_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (ft.kind !== 'line' || !Array.isArray(ft.p) || seen.has(ft.id)) continue;
      seen.add(ft.id);
      for (let i = 0; i + 1 < ft.p.length; i++) segs.push([ft.p[i][0], ft.p[i][1], ft.p[i + 1][0], ft.p[i + 1][1], ft.highway || 'road', ft.bridge ? 1 : 0, ft.tunnel ? 1 : 0, ft.id, ft.underground ? 1 : 0, ft.layer != null ? +ft.layer : 0]);
  }
  }
  return segs;
}
// canonical road polygon（major + mid tier のみ・Building∩Road 用）を読む。
function loadCanonicalRoadsMajorMid() {
  const list = [];
  if (!fs.existsSync(path.join(CANON_ROADS_DIR, 'manifest.json'))) return list;
  const seen = new Set();
  for (const f of fs.readdirSync(CANON_ROADS_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(CANON_ROADS_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (seen.has(ft.canonicalId)) continue;
      const lod = ft.attributes && ft.attributes.lodClass;
      if (lod !== 'major' && lod !== 'mid') continue;
      seen.add(ft.canonicalId);
      const rings = ft.geometryType === 'Polygon' ? [ft.coordinates[0]] : (ft.coordinates || []).map((poly) => poly[0]).filter(Boolean);
      const qf = ft.qaFlags || [];
      list.push({
        id: ft.canonicalId, rings, bbox: ft.bbox,
        highway: ft.attributes.highway, lodClass: lod, name: ft.attributes.name || null,
        bridge: !!ft.attributes.bridge || qf.includes('bridge'),
        tunnel: !!ft.attributes.tunnel || qf.includes('tunnel'),
        underground: !!ft.attributes.underground,
        // 31C2: PLATEAU sectionType 由来の構造区分（elevated/bridge/intersection/…）も高架判定に使う
        structure: ft.attributes.plateauStructure || null,
        elevated: qf.includes('elevated'),
        layer: ft.attributes.layer || 0, confidence: ft.source.confidence,
        geometrySource: ft.source.geometrySource,
      });
    }
  }
  return list;
}
function segHashBuild(segs) {
  const h = new Map();
  for (const s of segs) {
    const bb = { minX: Math.min(s[0], s[2]), maxX: Math.max(s[0], s[2]), minZ: Math.min(s[1], s[3]), maxZ: Math.max(s[1], s[3]) };
    for (let cx = Math.floor(bb.minX / HASH_M); cx <= Math.floor(bb.maxX / HASH_M); cx++)
      for (let cz = Math.floor(bb.minZ / HASH_M); cz <= Math.floor(bb.maxZ / HASH_M); cz++) {
        const k = cx + ',' + cz;
        if (!h.has(k)) h.set(k, []);
        h.get(k).push(s);
      }
  }
  return h;
}
function segLen(s) { return Math.hypot(s[2] - s[0], s[3] - s[1]); }

const RAIL_DIR = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'railways'));
const PARK_DIR = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'parks'));
function loadRailSegs() {
  const segs = [];
  if (!fs.existsSync(RAIL_DIR)) return segs;
  const seen = new Set();
  for (const f of fs.readdirSync(RAIL_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    for (const ft of (JSON.parse(fs.readFileSync(path.join(RAIL_DIR, f), 'utf-8')).features || [])) {
      if (ft.kind !== 'line' || !Array.isArray(ft.p) || seen.has(ft.id)) continue;
      seen.add(ft.id);
      const isSubway = ft.railway === 'subway';
      for (let i = 0; i + 1 < ft.p.length; i++) segs.push([ft.p[i][0], ft.p[i][1], ft.p[i + 1][0], ft.p[i + 1][1], ft.railway || 'rail', isSubway ? 1 : 0, ft.name || null]);
    }
  }
  return segs;
}
// [31F §23] resolved canonical parks があればそれを正とする（parkClass で grass を除外できる）。
const CANON_PARK_DIR = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'canonical', 'parks'));
function loadParks() {
  const out = [];
  const seen = new Set();
  if (fs.existsSync(path.join(CANON_PARK_DIR, 'manifest.json'))) {
    for (const f of fs.readdirSync(CANON_PARK_DIR)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      for (const ft of (JSON.parse(fs.readFileSync(path.join(CANON_PARK_DIR, f), 'utf-8')).features || [])) {
        if (seen.has(ft.canonicalId)) continue;
        seen.add(ft.canonicalId);
        const a = ft.attributes || {};
        // grass / green_space / misclassified-block は「公園」として conflict 判定しない（§7）。
        if (a.parkClass === 'grass' || a.parkClass === 'green_space' || a.parkClass === 'misclassified-block' || a.parkClass === 'other') continue;
        const ring = ft.geometryType === 'Polygon' ? ft.coordinates[0] : (ft.coordinates[0] && ft.coordinates[0][0]);
        if (!Array.isArray(ring) || ring.length < 3) continue;
        out.push({ id: ft.canonicalId, ring, bbox: ringBbox(ring), tag: 'leisure_park', parkClass: a.parkClass, name: a.name || null, canonicalSource: true });
      }
    }
    return out;
  }
  if (!fs.existsSync(PARK_DIR)) return out;
  for (const f of fs.readdirSync(PARK_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    for (const ft of (JSON.parse(fs.readFileSync(path.join(PARK_DIR, f), 'utf-8')).features || [])) {
      if (ft.kind !== 'area' || !Array.isArray(ft.p) || ft.p.length < 3 || seen.has(ft.id)) continue;
      seen.add(ft.id);
      out.push({ id: ft.id, ring: ft.p, bbox: ringBbox(ft.p), tag: ft.tag || 'park', name: ft.name || null });
    }
  }
  return out;
}
function pointNearSeg(px, pz, s, r) {
  const dx = s[2] - s[0], dz = s[3] - s[1], l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - s[0]) * dx + (pz - s[1]) * dz) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s[0] + t * dx), pz - (s[1] + t * dz)) <= r;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const conflicts = [];
  const pairStatus = {};

  const water = fs.existsSync(CANON_WATER) ? JSON.parse(fs.readFileSync(CANON_WATER, 'utf-8')) : null;
  const buildings = loadBuildings();
  const hash = buildHash(buildings);
  const roadSegs = loadRoadSegs();

  // ── Building ∩ Water（実計算・Polygon/MultiPolygon 対応）──
  if (water && (water.features || []).length) {
    let checked = 0;
    for (const wf of water.features) {
      const rings = waterOuterRings(wf);
      if (!rings.length) continue;
      const area = polygonAreaM2(wf.geometryType, wf.coordinates);
      if (area < MIN_WATER_AREA_M2) continue;
      checked++;
      const inRings = (x, z) => rings.some((rg) => pointInRing(x, z, rg));
      const wb = ringBbox(rings.flat());
      let anyNear = false;
      for (let cx = Math.floor(wb.minX / HASH_M); cx <= Math.floor(wb.maxX / HASH_M) && !anyNear; cx++)
        for (let cz = Math.floor(wb.minZ / HASH_M); cz <= Math.floor(wb.maxZ / HASH_M); cz++)
          if (hash.has(cx + ',' + cz)) { anyNear = true; break; }
      if (!anyNear) continue;
      let inside = 0, overlap = 0;
      const bySrc = { 'plateau-building': 0, 'osm-building': 0 };
      let smallFallbackOnly = true;
      const olBuildings = new Map(); // b -> cells
      let sumX = 0, sumZ = 0;
      for (let x = wb.minX; x <= wb.maxX; x += GRID_M) {
        for (let z = wb.minZ; z <= wb.maxZ; z += GRID_M) {
          if (!inRings(x, z)) continue;
          inside++;
          const bucket = hash.get(Math.floor(x / HASH_M) + ',' + Math.floor(z / HASH_M));
          if (!bucket) continue;
          for (const b of bucket) {
            if (b.rb.minX <= x && x <= b.rb.maxX && b.rb.minZ <= z && z <= b.rb.maxZ && pointInRing(x, z, b.fp)) {
              overlap++; bySrc[b.src]++; sumX += x; sumZ += z;
              olBuildings.set(b, (olBuildings.get(b) || 0) + 1);
              if (b.src === 'plateau-building' || b.area > 250) smallFallbackOnly = false;
              break;
            }
          }
        }
      }
      if (overlap === 0) continue;
      const cell = GRID_M * GRID_M;
      const overlapAreaM2 = overlap * cell;
      const frac = inside ? overlap / inside : 0;
      const olCentroid = [+(sumX / overlap).toFixed(1), +(sumZ / overlap).toFixed(1)];
      const olBuildingList = [...olBuildings.entries()]
        .map(([b, cells]) => ({ id: b.id, src: b.src, usage: b.usage, ulabel: b.ulabel, areaM2: Math.round(b.area), heightM: b.h, olAreaM2: cells * cell, wardId: b.wardId }))
        .sort((a, b) => b.olAreaM2 - a.olAreaM2);
      let explanation = null;
      const wc = (wf.attributes && wf.attributes.waterClass) || '';
      if (smallFallbackOnly) explanation = 'osm-building-drawn-on-water';
      else if (/canal|drainage/.test(wc) && frac < 0.15) explanation = 'over-water-structure';
      else if (frac < 0.06) explanation = 'centerline-offset';
      else if (wf.qaFlags && wf.qaFlags.some((q) => q.startsWith('geometry-from-centerline-ribbon')) && frac < 0.2) explanation = 'centerline-offset';
      const severity = classifyConflictSeverity({ overlapAreaM2, aAreaM2: area, bAreaM2: overlapAreaM2, explanation });
      conflicts.push({
        conflictId: mkConflictId('BW', wf.canonicalId, olBuildingList.map((b) => b.id)),
        code: 'BUILDING_WATER', severity,
        waterCanonicalId: wf.canonicalId, waterName: (wf.attributes && wf.attributes.name) || null,
        waterClass: wc || null, waterConfidence: wf.source.confidence, waterGeometrySource: wf.source.geometrySource,
        waterAreaM2: Math.round(area), overlapAreaM2: Math.round(overlapAreaM2), overlapFraction: +frac.toFixed(4),
        overlapCentroid: olCentroid, overlapBuildings: olBuildingList.slice(0, 12), overlapBuildingCount: olBuildingList.length,
        buildingBySource: bySrc, explanation,
        source: bySrc['plateau-building'] >= bySrc['osm-building'] ? 'plateau-building' : 'osm-building',
        cause: explanation || (bySrc['plateau-building'] > bySrc['osm-building'] ? 'plateau-building-encroaches-water' : 'osm-building-encroaches-water'),
      });
    }
    pairStatus.BUILDING_WATER = { computed: true, waterFeaturesChecked: checked, conflicts: conflicts.filter((c) => c.code === 'BUILDING_WATER').length };
  } else {
    pairStatus.BUILDING_WATER = { computed: false, reason: 'canonical water が無い' };
  }

  // ── Road ∩ Water（§11/§21。bridge / culvert / river-crossing は EXPLAINED）──
  if (water && (water.features || []).length && roadSegs.length) {
    const segHash = segHashBuild(roadSegs);
    let checked = 0;
    for (const wf of water.features) {
      const rings = waterOuterRings(wf);
      if (!rings.length) continue;
      const area = polygonAreaM2(wf.geometryType, wf.coordinates);
      if (area < MIN_WATER_AREA_M2) continue;
      checked++;
      const inRings = (x, z) => rings.some((rg) => pointInRing(x, z, rg));
      const wb = ringBbox(rings.flat());
      const near = new Set();
      for (let cx = Math.floor(wb.minX / HASH_M); cx <= Math.floor(wb.maxX / HASH_M); cx++)
        for (let cz = Math.floor(wb.minZ / HASH_M); cz <= Math.floor(wb.maxZ / HASH_M); cz++)
          for (const s of (segHash.get(cx + ',' + cz) || [])) near.add(s);
      if (!near.size) continue;
      // 水面内に入る道路 centerline 長を粗く積算（両端点サンプル）
      let crossLenM = 0, bridgeLenM = 0, tunnelLenM = 0;
      const roadClasses = {};
      for (const s of near) {
        const midx = (s[0] + s[2]) / 2, midz = (s[1] + s[3]) / 2;
        const inA = inRings(s[0], s[1]), inB = inRings(s[2], s[3]), inM = inRings(midx, midz);
        if (!inA && !inB && !inM) continue;
        const l = segLen(s);
        crossLenM += l;
        if (s[5]) bridgeLenM += l;
        if (s[6]) tunnelLenM += l;
        roadClasses[s[4]] = (roadClasses[s[4]] || 0) + 1;
      }
      if (crossLenM < 8) continue;
      const bridgeFrac = crossLenM ? bridgeLenM / crossLenM : 0;
      const tunnelFrac = crossLenM ? tunnelLenM / crossLenM : 0;
      let explanation = null;
      if (bridgeFrac >= 0.5) explanation = 'bridge';
      else if (tunnelFrac >= 0.5) explanation = 'culvert';
      else if (bridgeFrac > 0 || tunnelFrac > 0) explanation = 'bridge';
      else explanation = 'river-crossing'; // 橋/トンネルタグ無しの横断（OSM タグ欠落。ERROR にしない＝qaFlag）
      // Road∩Water は「単純な polygon overlap を ERROR にしない」（§11）→ 全件 INFO
      conflicts.push({
        conflictId: mkConflictId('RW', wf.canonicalId, Object.keys(roadClasses)),
        code: 'ROAD_WATER', severity: 'INFO',
        waterCanonicalId: wf.canonicalId, waterName: (wf.attributes && wf.attributes.name) || null,
        waterClass: (wf.attributes && wf.attributes.waterClass) || null,
        waterConfidence: wf.source.confidence, waterGeometrySource: wf.source.geometrySource,
        roadCrossLengthM: Math.round(crossLenM), bridgeFraction: +bridgeFrac.toFixed(3), tunnelFraction: +tunnelFrac.toFixed(3),
        roadClasses, explanation, source: 'osm-road-centerline',
        cause: explanation,
        qaFlag: explanation === 'river-crossing' ? 'road-crosses-water-without-bridge-tag(OSM タグ欠落)' : null,
      });
    }
    pairStatus.ROAD_WATER = { computed: true, waterFeaturesChecked: checked, conflicts: conflicts.filter((c) => c.code === 'ROAD_WATER').length, note: '単純 overlap は ERROR にしない（§11）。全件 INFO＋qaFlag。' };
  } else {
    pairStatus.ROAD_WATER = { computed: false, reason: 'canonical water または roads が無い' };
  }

  // ── Building ∩ Road（§11。canonical roads の major/mid tier のみ。bridge/tunnel/layer で意味付け §13）──
  const canonRoads = loadCanonicalRoadsMajorMid();
  if (canonRoads.length) {
    let checked = 0;
    for (const rf of canonRoads) {
      if (!rf.rings.length || !rf.bbox) continue;
      const roadAreaM2 = rf.rings.reduce((s, rg) => s + ringAreaM2(rg), 0);
      if (roadAreaM2 < 40) continue;
      checked++;
      const inRoad = (x, z) => rf.rings.some((rg) => pointInRing(x, z, rg));
      const rb = rf.bbox;
      let anyNear = false;
      for (let cx = Math.floor(rb.minX / HASH_M); cx <= Math.floor(rb.maxX / HASH_M) && !anyNear; cx++)
        for (let cz = Math.floor(rb.minZ / HASH_M); cz <= Math.floor(rb.maxZ / HASH_M); cz++)
          if (hash.has(cx + ',' + cz)) { anyNear = true; break; }
      if (!anyNear) continue;
      let inside = 0, overlap = 0;
      const bySrc = { 'plateau-building': 0, 'osm-building': 0 };
      const olBuildings = new Map();
      let sumX = 0, sumZ = 0;
      const G = 6;
      for (let x = rb.minX; x <= rb.maxX; x += G) {
        for (let z = rb.minZ; z <= rb.maxZ; z += G) {
          if (!inRoad(x, z)) continue;
          inside++;
          const bucket = hash.get(Math.floor(x / HASH_M) + ',' + Math.floor(z / HASH_M));
          if (!bucket) continue;
          for (const b of bucket) {
            if (b.rb.minX <= x && x <= b.rb.maxX && b.rb.minZ <= z && z <= b.rb.maxZ && pointInRing(x, z, b.fp)) {
              overlap++; bySrc[b.src]++; sumX += x; sumZ += z;
              olBuildings.set(b, (olBuildings.get(b) || 0) + 1);
              break;
            }
          }
        }
      }
      if (overlap === 0) continue;
      const cell = G * G;
      const overlapAreaM2 = overlap * cell;
      const frac = inside ? overlap / inside : 0;
      const olCentroid = [+(sumX / overlap).toFixed(1), +(sumZ / overlap).toFixed(1)];
      const olBuildingList = [...olBuildings.entries()]
        .map(([b, cells]) => ({ id: b.id, src: b.src, usage: b.usage, ulabel: b.ulabel, areaM2: Math.round(b.area), heightM: b.h, olAreaM2: cells * cell, wardId: b.wardId }))
        .sort((a, b) => b.olAreaM2 - a.olAreaM2);
      // 建物側の「深く侵入した 1 棟」の被覆率（footprint に対する overlap の割合）。実侵入の判定に使う。
      const deepest = olBuildingList[0] ? +(olBuildingList[0].olAreaM2 / Math.max(1, olBuildingList[0].areaM2)).toFixed(3) : 0;
      // 意味付け（§13: bridge/tunnel/layer を使う）
      let explanation = null;
      if (rf.bridge || rf.elevated || rf.structure === 'elevated' || rf.structure === 'bridge' || (rf.layer && rf.layer > 0)) explanation = 'building-over-road'; // 高架道路の下に建物＝正常
      else if (rf.tunnel || rf.underground || rf.structure === 'tunnel' || rf.structure === 'underpass' || (rf.layer && rf.layer < 0)) explanation = 'covered-road'; // 地下・トンネル道路の上に建物＝正常
      else if (frac < 0.05) explanation = 'centerline-offset'; // 端部のかすり
      else if (frac < 0.15 && bySrc['osm-building'] > bySrc['plateau-building']) explanation = 'station-building';
      const severity = classifyConflictSeverity({ overlapAreaM2, aAreaM2: roadAreaM2, bAreaM2: overlapAreaM2, explanation });
      conflicts.push({
        conflictId: mkConflictId('BR', rf.id, olBuildingList.map((b) => b.id)),
        code: 'BUILDING_ROAD', severity,
        roadCanonicalId: rf.id, roadName: rf.name, roadClass: rf.highway, roadLodClass: rf.lodClass,
        roadConfidence: rf.confidence, roadBridge: rf.bridge, roadTunnel: rf.tunnel, roadLayer: rf.layer,
        roadGeometrySource: rf.geometrySource || null, roadStructure: rf.structure || null,
        roadAreaM2: Math.round(roadAreaM2), overlapAreaM2: Math.round(overlapAreaM2), overlapFraction: +frac.toFixed(4),
        deepestBuildingCoverage: deepest,
        overlapCentroid: olCentroid, overlapBuildings: olBuildingList.slice(0, 12), overlapBuildingCount: olBuildingList.length,
        buildingBySource: bySrc, explanation,
        source: bySrc['plateau-building'] >= bySrc['osm-building'] ? 'plateau-building' : 'osm-building',
        cause: explanation || (bySrc['plateau-building'] > bySrc['osm-building'] ? 'plateau-building-encroaches-road' : 'osm-building-encroaches-road'),
      });
    }
    pairStatus.BUILDING_ROAD = { computed: true, roadFeaturesChecked: checked, scope: 'canonical roads major/mid tier のみ（local は幅が細く OSM alignment ノイズが支配的なため除外）', conflicts: conflicts.filter((c) => c.code === 'BUILDING_ROAD').length };
  } else {
    pairStatus.BUILDING_ROAD = { computed: false, reason: 'canonical roads が無い（先に build-canonical-roads.js）' };
  }

  // ── Building ∩ Rail（§15。subway=地下 / station は EXPLAINED。§13 高架・地下考慮）──
  const railSegs = loadRailSegs();
  if (railSegs.length) {
    const railHash = segHashBuild(railSegs.map((s) => s.slice(0, 4)));
    const railBySeg = new Map(); railSegs.forEach((s, i) => railBySeg.set(i, s));
    let checked = 0;
    const RAIL_HALF_W = 4; // 複線 ~8m 相当の半幅
    // building hash を走査（rail 近傍の building セルだけ）
    const railCells = new Set();
    for (const s of railSegs) {
      const bb = { minX: Math.min(s[0], s[2]) - RAIL_HALF_W, maxX: Math.max(s[0], s[2]) + RAIL_HALF_W, minZ: Math.min(s[1], s[3]) - RAIL_HALF_W, maxZ: Math.max(s[1], s[3]) + RAIL_HALF_W };
      for (let cx = Math.floor(bb.minX / HASH_M); cx <= Math.floor(bb.maxX / HASH_M); cx++)
        for (let cz = Math.floor(bb.minZ / HASH_M); cz <= Math.floor(bb.maxZ / HASH_M); cz++) railCells.add(cx + ',' + cz);
    }
    const seenB = new Set();
    for (const ck of railCells) {
      for (const b of (hash.get(ck) || [])) {
        if (seenB.has(b)) continue; seenB.add(b);
        const bx = (b.rb.minX + b.rb.maxX) / 2, bz = (b.rb.minZ + b.rb.maxZ) / 2;
        // この建物 centroid が rail 帯に入るか
        let onRail = null, subway = false;
        const rc = Math.floor(bx / HASH_M) + ',' + Math.floor(bz / HASH_M);
        for (const [i, s] of railBySeg) {
          if (pointNearSeg(bx, bz, s, RAIL_HALF_W)) { onRail = s; if (s[5]) subway = true; break; }
        }
        if (!onRail) continue;
        checked++;
        // 日本の都市鉄道は高架・地平が大半で、線路脇/高架下に建物があるのは正常。
        //   高架タグが OSM 側に無いため、subway=地下 / 大型=駅ビル 以外は elevated-rail-or-alignment として EXPLAINED。
        const explanation = subway ? 'underground'
          : (b.area > 400 ? 'station-building'
            : (b.src === 'osm-building' && b.area < 150 ? 'centerline-offset' : 'elevated-rail-or-alignment'));
        const severity = classifyConflictSeverity({ overlapAreaM2: Math.min(b.area, RAIL_HALF_W * 2 * 20), aAreaM2: b.area, bAreaM2: b.area, explanation });
        conflicts.push({
          conflictId: mkConflictId('BL', b.id || (bx.toFixed(0) + ':' + bz.toFixed(0)), [onRail[6] || onRail[4]]),
          code: 'BUILDING_RAIL', severity,
          railName: onRail[6], railway: onRail[4], subway,
          buildingId: b.id, buildingSource: b.src, buildingAreaM2: Math.round(b.area),
          buildingUsage: b.usage, buildingUlabel: b.ulabel, buildingWardId: b.wardId,
          overlapCentroid: [+bx.toFixed(1), +bz.toFixed(1)],
          explanation, source: b.src,
          cause: explanation || 'building-overlaps-rail',
        });
      }
    }
    pairStatus.BUILDING_RAIL = { computed: true, buildingsOnRailCorridor: checked, note: 'rail 帯 ±4m に centroid が入る建物。subway=地下 / 大型建物=駅ビル は EXPLAINED（§13/§15）。', conflicts: conflicts.filter((c) => c.code === 'BUILDING_RAIL').length };
  } else {
    pairStatus.BUILDING_RAIL = { computed: false, reason: 'railways データが無い' };
  }

  // ── Park ∩ Building（§16。公園内施設＝管理棟/トイレ/売店/スポーツ施設 は正常候補。ERROR 化しない）──
  const parks = loadParks();
  if (parks.length) {
    let checked = 0;
    for (const pk of parks) {
      const area = ringAreaM2(pk.ring);
      if (area < 200) continue;
      checked++;
      const pb = pk.bbox;
      let anyNear = false;
      for (let cx = Math.floor(pb.minX / HASH_M); cx <= Math.floor(pb.maxX / HASH_M) && !anyNear; cx++)
        for (let cz = Math.floor(pb.minZ / HASH_M); cz <= Math.floor(pb.maxZ / HASH_M); cz++)
          if (hash.has(cx + ',' + cz)) { anyNear = true; break; }
      if (!anyNear) continue;
      const G = 8;
      let inside = 0, overlap = 0, bCount = 0;
      const bset = new Set();
      const bySrc = { 'plateau-building': 0, 'osm-building': 0 };
      const olBuildings = new Map();
      let sumX = 0, sumZ = 0;
      for (let x = pb.minX; x <= pb.maxX; x += G) {
        for (let z = pb.minZ; z <= pb.maxZ; z += G) {
          if (!pointInRing(x, z, pk.ring)) continue;
          inside++;
          const bucket = hash.get(Math.floor(x / HASH_M) + ',' + Math.floor(z / HASH_M));
          if (!bucket) continue;
          for (const b of bucket) {
            if (b.rb.minX <= x && x <= b.rb.maxX && b.rb.minZ <= z && z <= b.rb.maxZ && pointInRing(x, z, b.fp)) {
              overlap++; bySrc[b.src]++; sumX += x; sumZ += z;
              olBuildings.set(b, (olBuildings.get(b) || 0) + 1);
              if (!bset.has(b)) { bset.add(b); bCount++; } break;
            }
          }
        }
      }
      if (overlap === 0) continue;
      const overlapAreaM2 = overlap * G * G;
      const frac = inside ? overlap / inside : 0;
      const olCentroid = [+(sumX / overlap).toFixed(1), +(sumZ / overlap).toFixed(1)];
      const olBuildingList = [...olBuildings.entries()]
        .map(([b, cells]) => ({ id: b.id, src: b.src, usage: b.usage, ulabel: b.ulabel, areaM2: Math.round(b.area), heightM: b.h, olAreaM2: cells * G * G, wardId: b.wardId }))
        .sort((a, b) => b.olAreaM2 - a.olAreaM2);
      // 建物合計面積が公園面積に占める割合。公園全体が建物で埋まっている＝公園誤分類の強い証拠。
      const buildingShareOfPark = +(olBuildingList.reduce((s, b) => s + b.areaM2, 0) / Math.max(1, area)).toFixed(3);
      // 意味付け（§16）: leisure_park + 小面積の建物群 = park-facility。landuse_grass に大量の建物 = 公園誤分類の可能性。
      let explanation = null;
      if (pk.tag === 'leisure_park' && frac < 0.35) explanation = 'park-facility';
      else if (/緑地|公園/.test(pk.name || '') && frac < 0.2) explanation = 'park-facility';
      else if (frac < 0.08) explanation = 'boundary-rounding';
      // landuse=grass / recreation_ground は「公園」ではなく緑地区画。集合住宅周りの芝生等で建物を含むのは
      //   タグの粒度問題であり ERROR ではない（§16）。leisure_park のみ厳しく見る。
      else if (pk.tag !== 'leisure_park') explanation = 'park-polygon-may-be-misclassified';
      const severity = explanation ? 'INFO' : classifyConflictSeverity({ overlapAreaM2, aAreaM2: area, bAreaM2: overlapAreaM2 });
      conflicts.push({
        conflictId: mkConflictId('PB', pk.id, olBuildingList.map((b) => b.id)),
        code: 'PARK_BUILDING', severity,
        parkId: pk.id, parkName: pk.name, parkTag: pk.tag, parkClass: pk.parkClass || null,
        parkCanonicalSource: !!pk.canonicalSource, parkAreaM2: Math.round(area),
        overlapAreaM2: Math.round(overlapAreaM2), overlapFraction: +frac.toFixed(4), buildingCount: bCount,
        buildingShareOfPark,
        overlapCentroid: olCentroid, overlapBuildings: olBuildingList.slice(0, 12), overlapBuildingCount: olBuildingList.length,
        buildingBySource: bySrc, explanation,
        source: bySrc['plateau-building'] >= bySrc['osm-building'] ? 'plateau-building' : 'osm-building',
        cause: explanation || (pk.tag === 'landuse_grass' && frac > 0.4 ? 'park-polygon-may-be-misclassified' : 'building-in-park'),
      });
    }
    pairStatus.PARK_BUILDING = { computed: true, parksChecked: checked, note: '公園内施設（管理棟/トイレ/売店/スポーツ施設）は EXPLAINED。単純 overlap を ERROR にしない（§16）。', conflicts: conflicts.filter((c) => c.code === 'PARK_BUILDING').length };
  } else {
    pairStatus.PARK_BUILDING = { computed: false, reason: 'parks データが無い' };
  }

  // ── 残ペア（LAND_SEA）: canonical land が未構築 → pending ──
  for (const pair of CONFLICT_PAIRS) {
    if (pairStatus[pair.code]) continue;
    pairStatus[pair.code] = {
      computed: false,
      reason: `canonical ${pair.a} / ${pair.b} が未構築（land layer は 31F 以降）`,
      explanationsWhenReady: CONFLICT_EXPLANATIONS[pair.code] || [],
    };
  }

  const bySeverity = conflicts.reduce((m, c) => { m[c.severity] = (m[c.severity] || 0) + 1; return m; }, {});
  const byCause = conflicts.reduce((m, c) => { m[c.cause] = (m[c.cause] || 0) + 1; return m; }, {});
  const bySource = conflicts.reduce((m, c) => { m[c.source || '?'] = (m[c.source || '?'] || 0) + 1; return m; }, {});
  const byConfidence = conflicts.reduce((m, c) => {
    const cv = c.waterConfidence != null ? c.waterConfidence : c.roadConfidence;
    const b = cv >= 0.85 ? 'conf>=0.85' : cv >= 0.7 ? 'conf 0.7-0.85' : 'conf<0.7';
    m[b] = (m[b] || 0) + 1; return m;
  }, {});
  const byCode = conflicts.reduce((m, c) => { m[c.code] = (m[c.code] || 0) + 1; return m; }, {});
  const byRoadClass = conflicts.filter((c) => c.roadClass || c.roadClasses).reduce((m, c) => {
    if (c.roadClass) m[c.roadClass] = (m[c.roadClass] || 0) + 1;
    else for (const k of Object.keys(c.roadClasses || {})) m[k] = (m[k] || 0) + 1;
    return m;
  }, {});
  const unexplainedHigh = conflicts.filter((c) => (c.severity === 'HIGH' || c.severity === 'CRITICAL') && !c.explanation);

  const report = {
    generatedAt,
    method: 'canonical water/road polygon を grid サンプリング。Building∩Water/Road は重なり面積、Road∩Water は横断長。bridge/tunnel/layer で高架・地下を意味付け（§13）。EXPLAINED は severity=INFO。',
    pairs: CONFLICT_PAIRS.map((p) => p.code),
    pairStatus,
    totalConflicts: conflicts.length,
    byCode, bySeverity, byCause, bySource, byConfidence, byRoadClass,
    unexplainedHighCount: unexplainedHigh.length,
    unexplainedHighByCode: unexplainedHigh.reduce((m, c) => { m[c.code] = (m[c.code] || 0) + 1; return m; }, {}),
    topBuildingWater: conflicts.filter((c) => c.code === 'BUILDING_WATER').sort((a, b) => b.overlapAreaM2 - a.overlapAreaM2).slice(0, 20),
    topBuildingRoad: conflicts.filter((c) => c.code === 'BUILDING_ROAD').sort((a, b) => b.overlapAreaM2 - a.overlapAreaM2).slice(0, 20),
    roadWaterSample: conflicts.filter((c) => c.code === 'ROAD_WATER').slice(0, 15),
    buildingRailSample: conflicts.filter((c) => c.code === 'BUILDING_RAIL').slice(0, 15),
    parkBuildingSample: conflicts.filter((c) => c.code === 'PARK_BUILDING').sort((a, b) => b.overlapAreaM2 - a.overlapAreaM2).slice(0, 15),
    note: '31D: Building∩Water + Building∩Road + Road∩Water + Building∩Rail + Park∩Building を実計算。LAND_SEA のみ canonical land 未構築で pending。geometry 書き換えは 31E。',
    RESULT: 'AUDIT-DONE',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  // [31E §2] 分類ツール（canonical-conflict-resolution.js）が読む全件エクスポート。
  //   HIGH/MEDIUM は全件、INFO は pair ごとに 200 件サンプル（件数は byCode で担保）。
  const ALL = P('data', 'reports', 'canonical-conflicts-all.json');
  const infoByCode = {};
  const exported = [];
  for (const c of conflicts) {
    if (c.severity === 'HIGH' || c.severity === 'CRITICAL' || c.severity === 'MEDIUM') { exported.push(c); continue; }
    infoByCode[c.code] = (infoByCode[c.code] || 0) + 1;
    if (infoByCode[c.code] <= 200) exported.push(c);
  }
  await writeJson(ALL, {
    generatedAt, note: 'HIGH/MEDIUM は全件、INFO は pair ごと 200 件サンプル。件数の正は canonical-conflicts.json の byCode/bySeverity。',
    byCode, bySeverity, counts: { total: conflicts.length, exported: exported.length }, conflicts: exported,
  });

  console.log('[canonical-conflicts] total=' + conflicts.length + ' byCode=' + JSON.stringify(byCode));
  console.log('  bySeverity: ' + JSON.stringify(bySeverity));
  console.log('  byCause: ' + JSON.stringify(byCause));
  console.log('  bySource: ' + JSON.stringify(bySource) + '  byRoadClass: ' + JSON.stringify(byRoadClass));
  console.log('  unexplained HIGH/CRITICAL: ' + unexplainedHigh.length + ' ' + JSON.stringify(report.unexplainedHighByCode));
  console.log('  pending pairs: ' + Object.entries(pairStatus).filter(([, v]) => !v.computed).map(([k]) => k).join(', '));
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
}

main().catch((e) => { console.error('[canonical-conflicts] 失敗:', e && e.stack || e); process.exit(1); });
