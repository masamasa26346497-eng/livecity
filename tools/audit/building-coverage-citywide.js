#!/usr/bin/env node
// tools/audit/building-coverage-citywide.js
// [Mission 34C §4/§8/§9/§16] 大阪 24 区全域で「実データがあるのに表示されていない建物」を全件抽出する。
//
//   分かっていること（§2/§3 の fixture 調査より）:
//     現行 fallback 選定（tools/build-osm-fallback-v2.js）は OSM 建物のうち
//       (hole)  50m セル + 8 近傍に V2 PLATEAU が 1 棟も無い
//       (sparse) 100m セルで OSM 面積 >= 2.5 × PLATEAU 面積 かつ OSM >= 5 棟
//     のどちらかに入るものだけを候補にしている。周りが既存 PLATEAU で埋まっている
//     再開発の 1 棟はどちらにも入らず、**重複判定に掛けられる前に落ちていた**。
//
//   ここでは前段フィルタを外し、市内の OSM 建物 全件 を既存の重複判定
//   （tools/lib/osm-fallback-v2-classify.js）へ掛け直す。重複判定そのものは変えない（§9）。
//
//   実行: node --max-old-space-size=12288 tools/audit/building-coverage-citywide.js
//   出力: data/reports/building-coverage-citywide.json
//         data/processed/osaka-city/osm-fallback-v3/missing-candidates.json
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
import { buildPlateauIndex, measureOverlap, classifyOverlap, isRetainedClass, FALLBACK_V2_CLASS } from '../lib/osm-fallback-v2-classify.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const C = {
  pbf: P('data', 'raw', 'osm', 'osaka-latest.osm.pbf'),
  canonDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  workDir: P('data', 'processed', 'osaka-city', 'osm-fallback-v3'),
  missing: P('data', 'processed', 'osaka-city', 'osm-fallback-v3', 'missing-candidates.json'),
  osmCache: P('data', 'processed', 'osaka-city', 'osm-fallback-v3', 'osm-city-buildings.json'),
  out: P('data', 'reports', 'building-coverage-citywide.json'),
};
// 現行 fallback と同じ有効範囲（新しい基準を勝手に作らない）
export const MIN_FP_AREA_M2 = 8, MAX_FP_AREA_M2 = 60000;
const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const CITY_MARGIN = 2000;
// 全件に重い sampling を掛けると現実的な時間で終わらないので、確実に同一建物と言える
//   ものだけ先に落とす（重心が PLATEAU の内側 かつ bbox IoU が高い）。
//   この早期判定は「重複側」へ倒すので、欠落건物を多めに数えることはない。
export const EARLY_DUP = { bboxIoU: 0.5 };
const r2 = (v) => Math.round(v * 100) / 100;
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

function bboxIoU(a, b) {
  const ox = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const oz = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
  const inter = ox * oz;
  const u = (a.maxX - a.minX) * (a.maxZ - a.minZ) + (b.maxX - b.minX) * (b.maxZ - b.minZ) - inter;
  return u > 0 ? inter / u : 0;
}
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

/** canonical V2N（PLATEAU + 既存 fallback）の footprint を全部読む。 */
export function loadCanonical() {
  const plateau = [], fallback = [];
  const existingWayIds = new Set();
  for (const f of fs.readdirSync(C.canonDir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const doc = rj(path.join(C.canonDir, f));
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

async function readOsmBuildings() {
  const bways = new Map();
  for await (const p of pbfPrimitiveStream(C.pbf)) {
    if (p.type !== 'way') continue;
    const t = p.tags || {};
    if (!isFallbackEligibleBuilding(t.building)) continue;
    bways.set(p.id, { refs: p.refs, tags: { building: t.building, height: t.height,
      'building:levels': t['building:levels'], name: t.name, 'start_date': t.start_date, 'construction_date': t.construction_date } });
  }
  const need = new Set();
  for (const v of bways.values()) for (const r of v.refs) need.add(r);
  const coord = new Map();
  for await (const p of pbfPrimitiveStream(C.pbf)) {
    if (p.type !== 'node' || !need.has(p.id)) continue;
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) coord.set(p.id, [p.lat, p.lon]);
  }
  return { bways, coord };
}

export async function run() {
  const t0 = Date.now();
  fs.mkdirSync(C.workDir, { recursive: true });

  console.log('[coverage] canonical V2N 読み込み…');
  const { plateau, fallback, existingWayIds } = loadCanonical();
  console.log('[coverage] PLATEAU', plateau.length, '既存 fallback', fallback.length);
  // §9 重複は PLATEAU だけでなく既存 fallback に対しても見る（二重建物を増やさない）
  const index = buildPlateauIndex(plateau.concat(fallback), 40);
  const wards = (rj(C.wardPolys) || {}).wards || [];

  let osm = rj(C.osmCache);
  if (osm) console.log('[coverage] OSM 走査結果を再利用', C.osmCache, osm.buildings.length);
  else {
    console.log('[coverage] OSM PBF 読み込み…');
    const { bways, coord } = await readOsmBuildings();
    const stats = { buildingWays: bways.size, badFootprint: 0, tooSmall: 0, tooBig: 0, selfIntersect: 0, outsideCity: 0, cityBboxViolation: 0, inCity: 0 };
    const buildings = [];
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
      const rp = representativePoint(ring);
      const wr = rp.valid ? classifyPointToWard(rp.x, rp.z, wards) : { wardId: null, status: 'no-representative-point' };
      if (!wr.wardId) { stats.outsideCity++; continue; }
      stats.inCity++;
      buildings.push({ wayId: wid, ring, area: Math.round(vf.area), wardId: wr.wardId, tags: v.tags });
    }
    bways.clear(); coord.clear();
    osm = { stats, buildings };
    fs.writeFileSync(C.osmCache, JSON.stringify(osm));
    console.log('[coverage] in-city OSM', buildings.length, JSON.stringify(stats));
  }

  // ── 全件を重複判定へ掛け直す（前段フィルタ無し）─────────────────────────
  const counts = { total: 0, earlyDuplicate: 0, noCandidate: 0, measured: 0,
    CLEAR_DUPLICATE: 0, LIKELY_DUPLICATE: 0, AMBIGUOUS: 0, VALID_FALLBACK: 0,
    alreadyDisplayedFallback: 0, newlyRecoverable: 0 };
  const byWard = {};
  const missing = [];
  let n = 0;
  for (const b of osm.buildings) {
    counts.total++;
    if (++n % 50000 === 0) console.log('[coverage] …' + n + '/' + osm.buildings.length + ' 欠落候補 ' + missing.length + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
    const bb = ringBbox(b.ring);
    const c = ringCentroid(b.ring);
    // 早期判定: bbox が重なる canonical が 1 つも無ければ、そもそも重なりは 0
    const cands = [];
    let maxIoU = 0, centroidIn = false;
    for (let cx = Math.floor((bb.minX) / index.cellM); cx <= Math.floor((bb.maxX) / index.cellM); cx++) {
      for (let cz = Math.floor((bb.minZ) / index.cellM); cz <= Math.floor((bb.maxZ) / index.cellM); cz++) {
        for (const r of index.grid.get(cx + ',' + cz) || []) {
          if (r.bb.maxX < bb.minX || r.bb.minX > bb.maxX || r.bb.maxZ < bb.minZ || r.bb.minZ > bb.maxZ) continue;
          if (cands.includes(r)) continue;
          cands.push(r);
          const iou = bboxIoU(bb, r.bb); if (iou > maxIoU) maxIoU = iou;
          if (!centroidIn && c[0] >= r.bb.minX && c[0] <= r.bb.maxX && c[1] >= r.bb.minZ && c[1] <= r.bb.maxZ && pointInRing(c[0], c[1], r.ring)) centroidIn = true;
        }
      }
    }
    let cls, rule, m = null;
    if (!cands.length) { counts.noCandidate++; cls = FALLBACK_V2_CLASS.VALID_FALLBACK; rule = 'no-bbox-candidate'; }
    else if (centroidIn && maxIoU >= EARLY_DUP.bboxIoU) { counts.earlyDuplicate++; cls = FALLBACK_V2_CLASS.CLEAR_DUPLICATE; rule = 'early: centroid-in + bboxIoU>=' + EARLY_DUP.bboxIoU; }
    else {
      counts.measured++;
      m = measureOverlap(b.ring, index);
      const k = classifyOverlap(m);
      cls = k.cls; rule = k.rule;
    }
    counts[cls] = (counts[cls] || 0) + 1;
    if (!isRetainedClass(cls)) continue;                 // 重複とみなされたものは対象外（§9）
    const already = existingWayIds.has(b.wayId);
    if (already) { counts.alreadyDisplayedFallback++; continue; }
    counts.newlyRecoverable++;
    const w = (byWard[b.wardId] = byWard[b.wardId] || { newlyRecoverable: 0, areaM2: 0, withLevels: 0, maxLevels: 0 });
    w.newlyRecoverable++; w.areaM2 += b.area;
    const lv = Number(b.tags['building:levels']);
    if (Number.isFinite(lv)) { w.withLevels++; if (lv > w.maxLevels) w.maxLevels = lv; }
    missing.push({ wayId: b.wayId, canonicalId: 'cg_bldg_osm_' + b.wayId, wardId: b.wardId, areaM2: b.area,
      centroid: [r2(c[0]), r2(c[1])], tags: b.tags, cls, rule,
      metrics: m ? { coveredFraction: +m.coveredFraction.toFixed(4), maxIoU: +m.maxIoU.toFixed(4),
        centroidInPlateau: m.centroidInPlateau, maxBboxIoU: +m.maxBboxIoU.toFixed(4), plateauPartners: m.plateauPartners,
        nearestDistanceM: m.nearestDistanceM == null ? null : +m.nearestDistanceM.toFixed(2) } : null,
      ring: b.ring });
  }

  for (const w of Object.values(byWard)) w.areaM2 = Math.round(w.areaM2);
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34C',
    osmScan: osm.stats,
    canonical: { plateau: plateau.length, fallback: fallback.length, total: plateau.length + fallback.length },
    earlyDuplicateRule: EARLY_DUP, counts, byWard,
    // 大きい順に少しだけレポートへ（全件は missing-candidates.json）
    topMissing: missing.slice().sort((a, b2) => b2.areaM2 - a.areaM2).slice(0, 40)
      .map((x) => ({ wayId: x.wayId, wardId: x.wardId, areaM2: x.areaM2, name: x.tags.name || null,
        levels: x.tags['building:levels'] || null, building: x.tags.building, rule: x.rule })),
    elapsedMs: Date.now() - t0 };
  fs.writeFileSync(C.missing, JSON.stringify({ version: 1, generatedAt: out.generatedAt, count: missing.length, candidates: missing }));
  fs.mkdirSync(path.dirname(C.out), { recursive: true });
  fs.writeFileSync(C.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => {
    console.log('[coverage] counts', JSON.stringify(o.counts));
    console.log('[coverage] 区別', JSON.stringify(o.byWard));
    console.log('[coverage] out', C.out);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
