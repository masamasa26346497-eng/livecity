// tools/lib/feature-ward-overlap.js
// P1-6F: 都市レイヤーの feature が「大阪市24区の陸域ポリゴン」と実際に重なるかを判定する。
//
// 【背景】tools/import/osm-pbf-city.js は feature を「24区 bbox（外接矩形）と交差するか」だけで
//   フィルタしていた。24区 bbox は夢洲・舞洲・咲洲や南北端を含むため非常に大きく、尼崎市側の
//   猪名川・神崎川など**大阪市の外にある巨大河川ポリゴン**が矩形の隅をかすめるだけで通過し、
//   実機で「左上へ数km伸びる巨大な楔形」として描画されていた（実測: rel 16551409 / rel 8445877 は
//   24区ポリゴン内の点がゼロ）。
//
//   ここでは data/processed/osaka-city/boundaries/ward-classification-polygons.json（znorth-neg-v1）を
//   使い、feature の点列が「いずれかの区ポリゴン内、または境界から bufferM 以内」に入るかで判定する。
//   境界河川（大和川・神崎川など）は buffer で残す。

const DEG = null; // 座標は既に znorth-neg-v1 のローカル m

function ringBbox(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, maxX, minZ, maxZ };
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

function distToRing(x, z, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + t * dx, pz = a[1] + t * dz;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) best = d;
  }
  return best;
}

/** ward-classification-polygons.json → 平坦な {wardId, outer, holes, bbox}[] */
export function buildWardIndex(wardPolygons) {
  const out = [];
  for (const w of (wardPolygons && wardPolygons.wards) || []) {
    for (const p of w.polygons || []) {
      if (!Array.isArray(p.outer) || p.outer.length < 3) continue;
      out.push({ wardId: w.wardId, wardName: w.wardName, outer: p.outer, holes: p.holes || [], bbox: ringBbox(p.outer) });
    }
  }
  return out;
}

/** 点 (x,z) が「いずれかの区ポリゴン内 or 境界から bufferM 以内」か。該当 wardId か null。 */
export function pointNearWards(x, z, index, bufferM = 0) {
  for (const p of index) {
    if (x < p.bbox.minX - bufferM || x > p.bbox.maxX + bufferM || z < p.bbox.minZ - bufferM || z > p.bbox.maxZ + bufferM) continue;
    if (pointInRing(x, z, p.outer)) {
      let inHole = false;
      for (const h of p.holes) if (pointInRing(x, z, h)) { inHole = true; break; }
      if (!inHole) return p.wardId;
    }
    if (bufferM > 0 && distToRing(x, z, p.outer) <= bufferM) return p.wardId;
  }
  return null;
}

/**
 * feature の点列（znorth-neg-v1 [x,z]）が24区とどれだけ重なるか。
 * @param {number[][]} points
 * @param {object[]} index buildWardIndex の結果
 * @param {{bufferM?:number, sample?:number}} [opts]
 * @returns {{inCount:number, total:number, fraction:number, wards:string[]}}
 */
export function featureWardOverlap(points, index, opts = {}) {
  const bufferM = opts.bufferM ?? 400;
  const sample = opts.sample ?? 80;
  if (!Array.isArray(points) || points.length === 0) return { inCount: 0, total: 0, fraction: 0, wards: [] };
  const step = Math.max(1, Math.floor(points.length / sample));
  let inCount = 0, total = 0;
  const wards = new Set();
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    total++;
    const w = pointNearWards(p[0], p[1], index, bufferM);
    if (w) { inCount++; wards.add(w); }
  }
  // 最後の点も必ず見る（短い feature でサンプルが1点だけにならないように）
  const last = points[points.length - 1];
  if (last && Number.isFinite(last[0])) {
    total++;
    const w = pointNearWards(last[0], last[1], index, bufferM);
    if (w) { inCount++; wards.add(w); }
  }
  return { inCount, total, fraction: total ? inCount / total : 0, wards: [...wards] };
}
