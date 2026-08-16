// tools/convert/roads.js
// 道路レイヤー変換: Overpassの生データ -> RoadLayerが読み込む {highway, p} 形式。
import { convertCoordsArray } from '../lib/projection.js';

/**
 * 生のOverpass要素配列から、RoadLayer互換のroads配列を生成する。
 */
export function convertRoads(rawElements, projection) {
  const roads = [];
  for (const el of rawElements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const highway = el.tags && el.tags.highway;
    if (!highway) continue;
    const coords = el.geometry.map((pt) => [pt.lon, pt.lat]);
    const p = convertCoordsArray(coords, projection);
    if (p.length < 2) continue;
    roads.push({ highway, p });
  }
  return mergeParallelDuplicates(roads);
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
  for (let i = 0; i < n; i++) {
    if (!majorTypes.has(roads[i].highway)) continue;
    for (let j = i + 1; j < n; j++) {
      if (roads[j].highway !== roads[i].highway) continue;
      if (avgMinDist(roads[i], roads[j]) < distThreshold) {
        union(i, j);
      }
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
