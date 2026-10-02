// tools/convert/roads.js
// 道路レイヤー変換: Overpassの生データ -> RoadLayerが読み込む {highway, p} 形式。
// [Mission23] 生活道路・細街路（*_link / living_street / unclassified / service / pedestrian / road）
//   まで対象を拡張。私有 driveway / parking_aisle / access=private は classifyRoad で eligible:false と
//   なるので除外する。access/service/bridge/tunnel/layer/oneway をフィーチャへ保持する。
import { convertCoordsArray } from '../lib/projection.js';
import { classifyRoad } from '../lib/road-network.js';

/** 後方互換: roads 配列だけ返す。 */
export function convertRoads(rawElements, projection, opts = {}) {
  return convertRoadsWithReport(rawElements, projection, opts).roads;
}

/**
 * 生のOverpass要素配列から、RoadLayer互換のroads配列 + 除外統計を返す。
 * @param {object} [opts] { keepIneligible:false — true なら除外理由つきで全件返す（audit用） }
 * @returns {{roads:object[], skippedIneligible:number, skipReasons:Record<string,number>, sourceWays:number}}
 */
export function convertRoadsWithReport(rawElements, projection, opts = {}) {
  const roads = [];
  let sourceWays = 0;
  let skippedIneligible = 0;
  const skipReasons = {};
  for (const el of rawElements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const highway = el.tags && el.tags.highway;
    if (!highway) continue;
    sourceWays++;
    const coords = el.geometry.map((pt) => [pt.lon, pt.lat]);
    const p = convertCoordsArray(coords, projection);
    if (p.length < 2) continue;
    const t = el.tags || {};
    const cls = classifyRoad(t);
    if (!cls.eligible && !opts.keepIneligible) {
      skippedIneligible++;
      const key = (cls.skipReason || 'other').split(':')[0];
      skipReasons[key] = (skipReasons[key] || 0) + 1;
      continue;
    }
    // [Mission03] 幅推定の優先順位: width → lanes×laneWidth → highway class default。
    // [Mission23] access/service/bridge/tunnel/layer/oneway を保持（audit / 高架分類 / 私有除外）。
    roads.push({
      highway,
      p,
      name: t.name || '',
      width: t.width != null ? t.width : null,
      lanes: t.lanes != null ? t.lanes : null,
      oneway: (t.oneway && t.oneway !== 'no') ? t.oneway : null,
      access: t.access || null,
      service: t.service || null,        // [Mission26] §4/§7 serviceType（alley / parking_aisle 等）
      surface: t.surface || null,        // [Mission26] §7 路面（品質向上・幅推定用）
      tracktype: t.tracktype || null,    // [Mission26] §6 track の等級
      bridge: cls.bridge || undefined,
      tunnel: cls.tunnel || undefined,
      underground: cls.underground || undefined,
      ultraLocal: cls.ultraLocal || undefined, // [Mission26] alley / track（超近景のみ表示候補）
      layer: t.layer != null ? t.layer : null,
      tier: cls.tier,
      detail: cls.detail,
      eligible: cls.eligible,
      skipReason: cls.skipReason || null,
      source: { type: 'way', id: el.id, name: t.name || '' },
    });
  }
  const merged = mergeParallelDuplicates(roads);
  return { roads: merged, skippedIneligible, skipReasons, sourceWays };
}

/**
 * 同一highway種別かつ近接して並走する道路（OSMの上下線分離等）を1本に統合する。
 * 過去の手動セッションで「シート」状の視覚的不具合の原因となった重複道路パターンを
 * 自動的に検出・除去するための処理。点数が多い(=詳細な)方を代表として残す。
 */
function mergeParallelDuplicates(roads, distThreshold = 15) {
  const n = roads.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  function pointToSegmentDist(p, a, b) {
    const [px, pz] = p, [ax, az] = a, [bx, bz] = b;
    const dx = bx - ax, dz = bz - az;
    if (dx === 0 && dz === 0) return Math.hypot(px - ax, pz - az);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
    const cx = ax + t * dx, cz = az + t * dz;
    return Math.hypot(px - cx, pz - cz);
  }
  function avgMinDist(ra, rb, sample = 10) {
    const step = Math.max(1, Math.floor(ra.p.length / sample));
    let total = 0, count = 0;
    for (let i = 0; i < ra.p.length; i += step) {
      const p = ra.p[i];
      let minD = Infinity;
      for (let j = 0; j < rb.p.length - 1; j++) {
        minD = Math.min(minD, pointToSegmentDist(p, rb.p[j], rb.p[j + 1]));
      }
      total += minD; count++;
    }
    return count ? total / count : Infinity;
  }

  const majorTypes = new Set(['motorway', 'trunk', 'primary', 'secondary']);
  // [Mission23] 細街路まで含めると n が数万に増える。並走統合の対象は major 種別のみなので、
  //   まず bbox を前計算し、外側ループも major に限定、内側は bbox 非重なりを即棄却する。
  const bb = roads.map((r) => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, z] of r.p) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
    return { a, b, c, d };
  });
  const majorIdx = [];
  for (let i = 0; i < n; i++) if (majorTypes.has(roads[i].highway)) majorIdx.push(i);
  for (let ii = 0; ii < majorIdx.length; ii++) {
    const i = majorIdx[ii];
    for (let jj = ii + 1; jj < majorIdx.length; jj++) {
      const j = majorIdx[jj];
      if (roads[j].highway !== roads[i].highway) continue;
      const bi = bb[i], bj = bb[j];
      if (bi.b + distThreshold < bj.a || bj.b + distThreshold < bi.a || bi.d + distThreshold < bj.c || bj.d + distThreshold < bi.c) continue;
      if (avgMinDist(roads[i], roads[j]) < distThreshold) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const result = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      result.push(roads[members[0]]);
    } else {
      // 点数最多のものを代表として残す
      let best = members[0];
      for (const m of members) if (roads[m].p.length > roads[best].p.length) best = m;
      result.push(roads[best]);
    }
  }
  return result;
}
