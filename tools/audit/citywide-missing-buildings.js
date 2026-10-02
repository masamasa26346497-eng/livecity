#!/usr/bin/env node
// tools/audit/citywide-missing-buildings.js
// [Mission 35D §3/§4/§6] 大阪 24 区全域で「実在するのに現在の表示に入っていない建物」を再監査する。
//
//   34C（tools/audit/building-coverage-citywide.js）との違い:
//     1. **早期重複判定を撤廃**。34C は「重心が中 かつ bbox IoU>=0.5」の 419,146 棟を
//        測らずに CLEAR_DUPLICATE にしていた。本当に重複かを全部測り直す。
//     2. **除外された棟も捨てずに記録**する。outsideCity / tooSmall / badFootprint が
//        本当に妥当かを数字で確かめられるようにする（34C はここを検証していない）。
//     3. OSM PBF の**緯度ヒストグラム**を取り、北側クリップの影響を建物についても確かめる。
//     4. §3 の指標（overlapAreaWithPlateau / overlapAreaWithFinalSet / overlapRatioToOsm /
//        centroidInsidePlateau / bboxIoUWithNearestPlateau / nearestPlateauDistance /
//        ward / area / aspect ratio）を候補ごとに全部出す。
//     5. 水面の中・細長すぎる形など、実在建物とみなせないものを明示的に落とす。
//
//   ここでは **judge するだけ**で canonical は 1 バイトも書かない（再構築は build 側）。
//   実行: node --max-old-space-size=12288 tools/audit/citywide-missing-buildings.js
//   出力: data/reports/citywide-missing-buildings.json
//         data/processed/osaka-city/missing-recovery-v4/candidates.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';
import { representativePoint } from '../lib/building-representative-point.js';
import {
  isFallbackEligibleBuilding, isValidFootprint, ringBbox, ringCentroid, ringArea,
} from '../lib/osm-building-fallback.js';
import {
  buildPlateauIndex, measureOverlap, classifyOverlap, isRetainedClass, FALLBACK_V2_CLASS,
} from '../lib/osm-fallback-v2-classify.js';

const P = (...s) => resolveProjectPath(path.join(...s));
/**
 * OSM の元データ。既定は広域版（osaka-latest は北 lat 34.73 で建物が切れている。
 * 34C まではこれに気付いておらず、東淀川区の回収数が異常に少なかった）。
 * 広域版が無ければ従来の osaka-latest を使う。--pbf で明示もできる。
 */
export function resolvePbf(explicit) {
  if (explicit) return path.resolve(explicit);
  const wide = P('data', 'raw', 'osm', 'osaka-full-coverage.osm.pbf');
  if (fs.existsSync(wide)) return wide;
  return P('data', 'raw', 'osm', 'osaka-latest.osm.pbf');
}
export const M = {
  pbf: resolvePbf(),
  canonDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  waterDir: P('data', 'processed', 'osaka-city', 'canonical', 'water'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  workDir: P('data', 'processed', 'osaka-city', 'missing-recovery-v4'),
  scanCache: P('data', 'processed', 'osaka-city', 'missing-recovery-v4', 'osm-scan.json'),
  scanCacheFor: (pbf) => P('data', 'processed', 'osaka-city', 'missing-recovery-v4',
    'osm-scan-' + path.basename(pbf).replace(/\.osm\.pbf$/, '') + '.json'),
  candidates: P('data', 'processed', 'osaka-city', 'missing-recovery-v4', 'candidates.json'),
  out: P('data', 'reports', 'citywide-missing-buildings.json'),
};
/** 現行 fallback と同じ有効範囲（新しい基準を勝手に作らない）。 */
export const MIN_FP_AREA_M2 = 8, MAX_FP_AREA_M2 = 60000;
export const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
export const CITY_MARGIN = 2000;
/**
 * 区の外と判定された棟のうち、区界からこの距離以内のものは「境界処理の都合で落ちた可能性」
 * として記録する（自動採用はしない。§2 の「勝手に生成しない」を守る）。
 */
export const WARD_EDGE_TOLERANCE_M = 30;
/** §5 実在建物とみなせない形。 */
export const SHAPE_GUARD = {
  minAreaM2: MIN_FP_AREA_M2,
  maxAreaM2: MAX_FP_AREA_M2,
  maxAspect: 25,          // 細長すぎる（道路や塀を建物として登録した誤りを弾く）
  minRectangularity: 0.15, // OBB に対する充填率がこれ未満は形が壊れている
};
const r2 = (v) => Math.round(v * 100) / 100;
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

export function bboxIoU(a, b) {
  const ox = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const oz = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
  const inter = ox * oz;
  const u = (a.maxX - a.minX) * (a.maxZ - a.minZ) + (b.maxX - b.minX) * (b.maxZ - b.minZ) - inter;
  return u > 0 ? inter / u : 0;
}
export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * §3 形状の健全性。主慣性軸で OBB を取り、縦横比と充填率を出す。
 * 建物として不自然なものだけを落とすためのもので、普通の建物は全部通る。
 */
export function shapeMetrics(ring) {
  const n = ring.length;
  let cx = 0, cz = 0;
  for (const p of ring) { cx += p[0]; cz += p[1]; }
  cx /= n; cz /= n;
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of ring) { const dx = p[0] - cx, dz = p[1] - cz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
  sxx /= n; szz /= n; sxz /= n;
  const th = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ux = Math.cos(th), uz = Math.sin(th);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of ring) {
    const dx = p[0] - cx, dz = p[1] - cz;
    const u = dx * ux + dz * uz, v = -dx * uz + dz * ux;
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const longM = Math.max(u1 - u0, v1 - v0), shortM = Math.min(u1 - u0, v1 - v0);
  const area = ringArea(ring);
  const obbArea = Math.max(1e-6, (u1 - u0) * (v1 - v0));
  return { longM: +longM.toFixed(2), shortM: +shortM.toFixed(2),
    aspect: shortM > 0.01 ? +(longM / shortM).toFixed(2) : 999,
    rectangularity: +(area / obbArea).toFixed(3), areaM2: +area.toFixed(1) };
}
/** §5 実在建物とみなせる形か。 */
export function shapeIsPlausible(sm, g = SHAPE_GUARD) {
  if (!(sm.areaM2 >= g.minAreaM2)) return { ok: false, reason: 'too-small' };
  if (sm.areaM2 > g.maxAreaM2) return { ok: false, reason: 'too-big' };
  if (sm.aspect > g.maxAspect) return { ok: false, reason: 'too-elongated' };
  if (sm.rectangularity < g.minRectangularity) return { ok: false, reason: 'degenerate-shape' };
  return { ok: true };
}

/** canonical の水域を読み、点が水の中かを判定できるようにする。 */
export function loadWater() {
  const polys = [];
  if (!fs.existsSync(M.waterDir)) return { polys, index: new Map(), cellM: 200 };
  for (const f of fs.readdirSync(M.waterDir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    for (const ft of ((rj(path.join(M.waterDir, f)) || {}).features || [])) {
      const rings = ft.geometryType === 'Polygon' ? [ft.coordinates]
        : ft.geometryType === 'MultiPolygon' ? ft.coordinates : null;
      if (!rings) continue;
      for (const poly of rings) {
        const outer = poly && poly[0];
        if (outer && outer.length >= 3) polys.push({ ring: outer, bb: ringBbox(outer) });
      }
    }
  }
  const cellM = 200, index = new Map();
  polys.forEach((p, i) => {
    for (let cx = Math.floor(p.bb.minX / cellM); cx <= Math.floor(p.bb.maxX / cellM); cx++) {
      for (let cz = Math.floor(p.bb.minZ / cellM); cz <= Math.floor(p.bb.maxZ / cellM); cz++) {
        const k = cx + ',' + cz;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(i);
      }
    }
  });
  return { polys, index, cellM };
}
export function isInWater(x, z, water) {
  const k = Math.floor(x / water.cellM) + ',' + Math.floor(z / water.cellM);
  for (const i of (water.index.get(k) || [])) {
    const p = water.polys[i];
    if (x < p.bb.minX || x > p.bb.maxX || z < p.bb.minZ || z > p.bb.maxZ) continue;
    if (pointInRing(x, z, p.ring)) return true;
  }
  return false;
}

/** canonical V2N（PLATEAU + 既存 fallback）の footprint。 */
export function loadFinalSet(dir = M.canonDir) {
  const plateau = [], fallback = [];
  const existingWayIds = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const doc = rj(path.join(dir, f));
    if (!doc) continue;
    for (const ft of (doc.features || [])) {
      const ring = ft.coordinates && ft.coordinates[0];
      if (!ring || ring.length < 3) continue;
      const rec = { id: ft.canonicalId, ring, bb: ringBbox(ring), area: ft.areaM2 != null ? ft.areaM2 : ringArea(ring) };
      if (ft.source && ft.source.geometrySource === 'plateau-building') plateau.push(rec);
      else {
        fallback.push(rec);
        const m = /^cg_bldg_osm_(\d+)$/.exec(ft.canonicalId);
        if (m) existingWayIds.add(Number(m[1]));
      }
    }
  }
  return { plateau, fallback, existingWayIds };
}

/**
 * 区界からの距離（代表点が外にあるとき、どれだけ外か）。
 * ward-classification-polygons.json の polygon は `{outer, holes}`。
 * bbox で粗く絞ってから辺までの距離を測る（全区の全辺を毎回なめない）。
 */
export function distanceToNearestWard(x, z, wards, { maxM = 200 } = {}) {
  let best = Infinity;
  for (const w of wards) {
    const bb = w.bbox;
    if (bb && (x < bb.minX - maxM || x > bb.maxX + maxM || z < bb.minZ - maxM || z > bb.maxZ + maxM)) continue;
    for (const poly of (w.polygons || [])) {
      const ring = poly && poly.outer;
      if (!ring || ring.length < 3) continue;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const ax = ring[j][0], az = ring[j][1], bx = ring[i][0], bz = ring[i][1];
        const dx = bx - ax, dz = bz - az;
        const L = dx * dx + dz * dz;
        let t = L > 0 ? ((x - ax) * dx + (z - az) * dz) / L : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
        if (d < best) best = d;
      }
    }
  }
  return best === Infinity ? null : +best.toFixed(1);
}

/**
 * 市域 + 余白の緯度経度 bbox。GROUND_EXTENT / CITY_MARGIN と同じ範囲を緯度経度で表したもの。
 * 広域 PBF（関西全域）を使うときは、これで先に node を絞らないと
 * 建物 way の ref 集合が V8 の Set 上限（約 1,677 万）を超えて落ちる。
 */
export function cityLatLonBbox() {
  const C = { lat: 34.604208, lon: 135.52502, mpd: 111320 };
  const x0 = GROUND_EXTENT.minX - CITY_MARGIN, x1 = GROUND_EXTENT.maxX + CITY_MARGIN;
  const z0 = GROUND_EXTENT.minZ - CITY_MARGIN, z1 = GROUND_EXTENT.maxZ + CITY_MARGIN;
  const north = C.lat - z0 / C.mpd, south = C.lat - z1 / C.mpd;
  const k = Math.cos(((north + south) / 2) * Math.PI / 180) * C.mpd;
  return { south, north, west: C.lon + x0 / k, east: C.lon + x1 / k };
}

/**
 * 建物 way とその座標を読む。
 * 1 パス目で **市域の node だけ** を拾い、2 パス目でその node を使う building way だけ残す。
 * 34C は「建物 way の ref を全部集めてから座標を引く」順だったため、
 * 広域 PBF では ref 集合が Set の上限を超えて落ちる。
 */
async function readOsmBuildings(pbf = M.pbf, bbox = cityLatLonBbox()) {
  const coord = new Map();
  let scannedNodes = 0;
  for await (const p of pbfPrimitiveStream(pbf)) {
    if (p.type !== 'node') continue;
    scannedNodes++;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (p.lat < bbox.south || p.lat > bbox.north || p.lon < bbox.west || p.lon > bbox.east) continue;
    coord.set(p.id, [p.lat, p.lon]);
  }
  console.log('[missing] node 走査', scannedNodes, '→ 市域内', coord.size);
  const bways = new Map();
  for await (const p of pbfPrimitiveStream(pbf)) {
    if (p.type !== 'way') continue;
    const t = p.tags || {};
    if (!isFallbackEligibleBuilding(t.building)) continue;
    if (!p.refs || !p.refs.some((r) => coord.has(r))) continue;   // 市域外の建物は持たない
    bways.set(p.id, { refs: p.refs, tags: { building: t.building, height: t.height,
      'building:levels': t['building:levels'], name: t.name, start_date: t.start_date,
      construction_date: t.construction_date, 'addr:suburb': t['addr:suburb'] } });
  }
  console.log('[missing] 市域に関わる建物 way', bways.size);
  return { bways, coord };
}

/** §6 PBF が北で切れていないか、建物についても確かめる。 */
export function latitudeCliff(hist) {
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
  let cliff = null;
  for (let i = 1; i < keys.length; i++) {
    const prev = hist[keys[i - 1]], cur = hist[keys[i]];
    if (prev >= 500 && cur > 0 && prev / cur >= 10) {
      cliff = { atLat: keys[i], before: prev, after: cur, ratio: +(prev / cur).toFixed(1) };
    }
    if (prev >= 500 && cur === 0) cliff = { atLat: keys[i], before: prev, after: 0, ratio: Infinity };
  }
  return cliff;
}

export async function run({ rescan = false, pbf = null } = {}) {
  const t0 = Date.now();
  fs.mkdirSync(M.workDir, { recursive: true });
  const pbfPath = resolvePbf(pbf);
  const scanCache = M.scanCacheFor(pbfPath);
  console.log('[missing] OSM 元データ', path.basename(pbfPath));

  console.log('[missing] 現在の final set（V2N）を読み込み…');
  const { plateau, fallback, existingWayIds } = loadFinalSet();
  console.log('[missing] PLATEAU', plateau.length, '既存 fallback', fallback.length);
  // §3 PLATEAU だけの index と、final set 全体の index を別々に持つ
  const plateauIndex = buildPlateauIndex(plateau, 40);
  const finalIndex = buildPlateauIndex(plateau.concat(fallback), 40);
  const wards = (rj(M.wardPolys) || {}).wards || [];
  const water = loadWater();
  console.log('[missing] 水域ポリゴン', water.polys.length);

  let scan = rescan ? null : rj(scanCache);
  if (scan) console.log('[missing] OSM 走査結果を再利用', scan.buildings.length);
  else {
    console.log('[missing] OSM PBF 読み込み…');
    const { bways, coord } = await readOsmBuildings(pbfPath);
    const stats = { buildingWays: bways.size, badFootprint: 0, tooSmall: 0, tooBig: 0,
      selfIntersect: 0, elongated: 0, degenerate: 0,
      cityBboxViolation: 0, outsideCity: 0, outsideCityNearEdge: 0, inCity: 0 };
    const latHist = {};
    const buildings = [];
    const excluded = [];            // 落とした理由を残す（34C はここを捨てていた）
    for (const [wid, v] of bways) {
      const ring = [];
      let latSum = 0, latN = 0;
      for (const r of v.refs) {
        const ll = coord.get(r);
        if (!ll) continue;
        latSum += ll[0]; latN++;
        const w = latLonToLiveCityWorld(ll[0], ll[1]);
        ring.push([r2(w.x), r2(w.z)]);
      }
      if (latN) { const k = (Math.floor((latSum / latN) * 100) / 100).toFixed(2); latHist[k] = (latHist[k] || 0) + 1; }
      if (ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
      if (ring.length < 3 || v.refs.length < 4) { stats.badFootprint++; continue; }
      const vf = isValidFootprint(ring, { minArea: MIN_FP_AREA_M2, maxArea: MAX_FP_AREA_M2 });
      const sm = shapeMetrics(ring);
      if (!vf.ok) {
        if (vf.reason === 'too-small') stats.tooSmall++;
        else if (vf.reason === 'too-big') stats.tooBig++;
        else if (vf.reason === 'self-intersect') stats.selfIntersect++;
        else stats.badFootprint++;
        if (excluded.length < 4000) excluded.push({ wayId: wid, reason: vf.reason, areaM2: sm.areaM2, name: v.tags.name || null });
        continue;
      }
      const sp = shapeIsPlausible(sm);
      if (!sp.ok) {
        if (sp.reason === 'too-elongated') stats.elongated++; else stats.degenerate++;
        if (excluded.length < 4000) excluded.push({ wayId: wid, reason: sp.reason, areaM2: sm.areaM2, aspect: sm.aspect, rect: sm.rectangularity, name: v.tags.name || null });
        continue;
      }
      const bb = ringBbox(ring);
      if (bb.maxX < GROUND_EXTENT.minX - CITY_MARGIN || bb.minX > GROUND_EXTENT.maxX + CITY_MARGIN
        || bb.maxZ < GROUND_EXTENT.minZ - CITY_MARGIN || bb.minZ > GROUND_EXTENT.maxZ + CITY_MARGIN) {
        stats.cityBboxViolation++; continue;
      }
      const rp = representativePoint(ring);
      const wr = rp.valid ? classifyPointToWard(rp.x, rp.z, wards) : { wardId: null, status: 'no-representative-point' };
      if (!wr.wardId) {
        stats.outsideCity++;
        // 区界のすぐ外なら「境界処理の都合で落ちた可能性」として記録だけ残す
        if (rp.valid) {
          const d = distanceToNearestWard(rp.x, rp.z, wards);
          if (d != null && d <= WARD_EDGE_TOLERANCE_M) {
            stats.outsideCityNearEdge++;
            if (excluded.length < 4000) excluded.push({ wayId: wid, reason: 'outside-city-near-edge',
              distanceToWardM: d, areaM2: sm.areaM2, name: v.tags.name || null });
          }
        }
        continue;
      }
      stats.inCity++;
      buildings.push({ wayId: wid, ring, area: Math.round(sm.areaM2), wardId: wr.wardId,
        aspect: sm.aspect, rect: sm.rectangularity, tags: v.tags });
    }
    bways.clear(); coord.clear();
    scan = { pbf: path.basename(pbfPath), stats, latHist, latCliff: latitudeCliff(latHist), buildings, excluded };
    fs.writeFileSync(scanCache, JSON.stringify(scan));
    // 互換: 直近の走査結果を既定名でも参照できるようにする
    fs.writeFileSync(M.scanCache, JSON.stringify(scan));
    console.log('[missing] in-city OSM', buildings.length, JSON.stringify(stats));
  }

  // ── §3 全件を測り直す（早期判定なし）──────────────────────────────
  const counts = { total: 0, noCandidate: 0, measured: 0, inWater: 0,
    CLEAR_DUPLICATE: 0, LIKELY_DUPLICATE: 0, AMBIGUOUS: 0, VALID_FALLBACK: 0,
    alreadyDisplayedFallback: 0, newlyRecoverable: 0,
    // 34C の早期判定なら重複にされていたが、測ったら重複ではなかったもの
    wouldBeEarlyDuplicate: 0, earlyDuplicateFalsePositive: 0 };
  const byWard = {};
  const candidates = [];
  let n = 0;
  for (const b of scan.buildings) {
    counts.total++;
    if (++n % 50000 === 0) {
      console.log('[missing] …' + n + '/' + scan.buildings.length + ' 候補 ' + candidates.length
        + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
    }
    const bb = ringBbox(b.ring);
    const c = ringCentroid(b.ring);

    // bbox が重なる final set の棟を集める（§3 の指標用）
    const cands = new Set();
    let maxBboxIoUFinal = 0, centroidInFinalBbox = false;
    for (let cx = Math.floor(bb.minX / finalIndex.cellM); cx <= Math.floor(bb.maxX / finalIndex.cellM); cx++) {
      for (let cz = Math.floor(bb.minZ / finalIndex.cellM); cz <= Math.floor(bb.maxZ / finalIndex.cellM); cz++) {
        for (const r of finalIndex.grid.get(cx + ',' + cz) || []) {
          if (r.bb.maxX < bb.minX || r.bb.minX > bb.maxX || r.bb.maxZ < bb.minZ || r.bb.minZ > bb.maxZ) continue;
          if (cands.has(r)) continue;
          cands.add(r);
          const iou = bboxIoU(bb, r.bb); if (iou > maxBboxIoUFinal) maxBboxIoUFinal = iou;
          if (!centroidInFinalBbox && c[0] >= r.bb.minX && c[0] <= r.bb.maxX
            && c[1] >= r.bb.minZ && c[1] <= r.bb.maxZ && pointInRing(c[0], c[1], r.ring)) centroidInFinalBbox = true;
        }
      }
    }
    const wouldEarlyDrop = centroidInFinalBbox && maxBboxIoUFinal >= 0.5;
    if (wouldEarlyDrop) counts.wouldBeEarlyDuplicate++;

    let cls, rule, mFinal = null, mPlateau = null;
    if (!cands.size) { counts.noCandidate++; cls = FALLBACK_V2_CLASS.VALID_FALLBACK; rule = 'no-bbox-candidate'; }
    else {
      counts.measured++;
      mFinal = measureOverlap(b.ring, finalIndex);
      const k = classifyOverlap(mFinal);
      cls = k.cls; rule = k.rule;
      // §3 PLATEAU だけに対する重なりも別に測る
      mPlateau = measureOverlap(b.ring, plateauIndex);
    }
    // 34C の早期判定が取り違えていたか
    if (wouldEarlyDrop && isRetainedClass(cls)) counts.earlyDuplicateFalsePositive++;

    counts[cls] = (counts[cls] || 0) + 1;
    if (!isRetainedClass(cls)) continue;
    if (existingWayIds.has(b.wayId)) { counts.alreadyDisplayedFallback++; continue; }
    // §5 水面の中の偽建物は採らない
    if (isInWater(c[0], c[1], water)) { counts.inWater++; continue; }

    counts.newlyRecoverable++;
    const w = (byWard[b.wardId] = byWard[b.wardId] || { newlyRecoverable: 0, areaM2: 0, withLevels: 0, withName: 0, maxLevels: 0 });
    w.newlyRecoverable++; w.areaM2 += b.area;
    if (b.tags.name) w.withName++;
    const lv = Number(b.tags['building:levels']);
    if (Number.isFinite(lv)) { w.withLevels++; if (lv > w.maxLevels) w.maxLevels = lv; }

    candidates.push({
      wayId: b.wayId, canonicalId: 'cg_bldg_osm_' + b.wayId, wardId: b.wardId,
      areaM2: b.area, centroid: [r2(c[0]), r2(c[1])], tags: b.tags, cls, rule,
      // §3 指標
      metrics: {
        overlapAreaWithFinalSet: mFinal ? +mFinal.intersectionArea.toFixed(1) : 0,
        overlapAreaWithPlateau: mPlateau ? +mPlateau.intersectionArea.toFixed(1) : 0,
        overlapRatioToOsm: mFinal ? +mFinal.coveredFraction.toFixed(4) : 0,
        centroidInsidePlateau: mPlateau ? !!mPlateau.centroidInPlateau : false,
        centroidInsideFinalSet: mFinal ? !!mFinal.centroidInPlateau : false,
        bboxIoUWithNearestPlateau: mFinal ? +mFinal.maxBboxIoU.toFixed(4) : 0,
        maxIoU: mFinal ? +mFinal.maxIoU.toFixed(4) : 0,
        nearestPlateauDistanceM: mFinal && mFinal.nearestDistanceM != null ? +mFinal.nearestDistanceM.toFixed(2) : null,
        partners: mFinal ? mFinal.plateauPartners : 0,
        aspect: b.aspect, rectangularity: b.rect,
        wouldBeEarlyDroppedBy34C: wouldEarlyDrop,
      },
      ring: b.ring,
    });
  }
  for (const w of Object.values(byWard)) w.areaM2 = Math.round(w.areaM2);

  // 区ごとの既存棟数
  const plateauByWard = {}, fallbackByWard = {};
  const countByWard = (list, into) => {
    for (const r of list) {
      const rp = representativePoint(r.ring);
      const wr = rp.valid ? classifyPointToWard(rp.x, rp.z, wards) : null;
      const k = (wr && wr.wardId) || 'unknown';
      into[k] = (into[k] || 0) + 1;
    }
  };
  console.log('[missing] 区ごとの既存棟数を集計…');
  countByWard(plateau, plateauByWard);
  countByWard(fallback, fallbackByWard);

  const wardRanking = Object.entries(byWard)
    .map(([k, v]) => ({ wardId: k, newlyRecoverable: v.newlyRecoverable, areaM2: v.areaM2,
      withName: v.withName, plateau: plateauByWard[k] || 0, fallback: fallbackByWard[k] || 0 }))
    .sort((a, b) => b.newlyRecoverable - a.newlyRecoverable);

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35D',
    baseline: 'buildings-v2-osmv2（dev の既定 V2N）',
    osmSource: path.basename(pbfPath),
    osmScan: scan.stats,
    latitudeCliff: scan.latCliff,
    latitudeHistogramTop: Object.fromEntries(Object.entries(scan.latHist)
      .sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 14)),
    excludedSamples: (scan.excluded || []).slice(0, 40),
    shapeGuard: SHAPE_GUARD, wardEdgeToleranceM: WARD_EDGE_TOLERANCE_M,
    canonical: { plateau: plateau.length, fallback: fallback.length, total: plateau.length + fallback.length },
    counts, byWard, wardRanking,
    topMissing: candidates.slice().sort((a, b) => b.areaM2 - a.areaM2).slice(0, 40)
      .map((x) => ({ wayId: x.wayId, wardId: x.wardId, areaM2: x.areaM2, name: x.tags.name || null,
        levels: x.tags['building:levels'] || null, building: x.tags.building, rule: x.rule })),
    namedMissing: candidates.filter((x) => x.tags.name).length,
    elapsedMs: Date.now() - t0 };

  fs.writeFileSync(M.candidates, JSON.stringify({ version: 1, generatedAt: out.generatedAt,
    missionId: '35D', count: candidates.length, candidates }));
  fs.mkdirSync(path.dirname(M.out), { recursive: true });
  fs.writeFileSync(M.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const rescan = process.argv.includes('--rescan');
  const pbfArg = (process.argv.find((a) => a.startsWith('--pbf=')) || '').slice(6) || null;
  run({ rescan, pbf: pbfArg }).then((o) => {
    console.log('[missing] OSM 元データ', o.osmSource);
    console.log('[missing] OSM 走査', JSON.stringify(o.osmScan));
    console.log('[missing] 緯度の崖', JSON.stringify(o.latitudeCliff));
    console.log('[missing] 判定', JSON.stringify(o.counts));
    console.log('[missing] 早期判定の取り違え', o.counts.earlyDuplicateFalsePositive, '/', o.counts.wouldBeEarlyDuplicate);
    console.log('[missing] 新規回収可能', o.counts.newlyRecoverable, '（名前あり', o.namedMissing, '）');
    console.log('[missing] 区ランキング（上位 8）');
    for (const w of o.wardRanking.slice(0, 8)) console.log('   ', w.wardId.padEnd(18), '+' + w.newlyRecoverable, '(PLATEAU', w.plateau, '/ fallback', w.fallback + ')');
    console.log('[missing] out', M.out);
  }).catch((e) => { console.error(e); process.exit(1); });
}
