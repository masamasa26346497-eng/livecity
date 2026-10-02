// tools/lib/geometry-simplify.js
// [Mission 31F §20/§21] derived geometry 専用の topology-safe simplify。
//   canonical 本体は絶対に simplify しない（§0）。derived/ 生成時のみ使う。
//   - polygon: ring ごとに Visvalingam-Whyatt（面積ベース）。ring が退化 / 自己交差する手前で止める。
//   - line: Douglas-Peucker。端点は保持。
//   すべて znorth-neg-v1 局所メートル座標（[x,z]）前提。tolerance は「メートル」。

/** 線分 (a,b) と (c,d) が交差するか（端点接触は非交差扱い）。 */
function segCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** ring（閉じていない [x,z] 配列）が自己交差するか。n>600 は打ち切り（true 扱いで simplify を保守的に）。 */
export function ringSelfIntersects(ring) {
  const n = ring.length;
  if (n < 4) return false;
  if (n > 600) return true;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segCross(a, b, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

function ringSignedArea(r) {
  let s = 0;
  for (let i = 0; i < r.length; i++) { const q = r[(i + 1) % r.length]; s += r[i][0] * q[1] - q[0] * r[i][1]; }
  return s / 2;
}
export function ringArea(r) { return Math.abs(ringSignedArea(r)); }

/** 三角形 (a,b,c) の面積。Visvalingam の「重要度」。 */
function triArea(a, b, c) {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

/**
 * Visvalingam-Whyatt で ring を simplify。
 * @param {Array<[number,number]>} ring 閉じていない座標列
 * @param {number} toleranceM 除去する三角形面積のしきい値（m²相当。おおよそ tolerance^2）
 * @param {number} minPts 最低頂点数
 * @returns {Array<[number,number]>} simplify 後 ring（元と同じく閉じていない）
 */
export function simplifyRing(ring, toleranceM, minPts = 4) {
  if (!Array.isArray(ring) || ring.length <= minPts) return ring.slice();
  const areaThresh = toleranceM * toleranceM;
  // 双方向リンクリスト
  const pts = ring.map((p, i) => ({ p, prev: i - 1, next: i + 1, idx: i, removed: false }));
  const n = pts.length;
  pts[0].prev = n - 1; pts[n - 1].next = 0;
  const eff = (i) => {
    const a = pts[pts[i].prev].p, b = pts[i].p, c = pts[pts[i].next].p;
    return triArea(a, b, c);
  };
  // 単純な O(n^2) ループ（park/water polygon は頂点数が小さいので十分）。
  let live = n;
  while (live > minPts) {
    let minI = -1, minA = Infinity;
    for (let i = 0; i < n; i++) {
      if (pts[i].removed) continue;
      const a = eff(i);
      if (a < minA) { minA = a; minI = i; }
    }
    if (minI < 0 || minA > areaThresh) break;
    // minI を除去したら自己交差しないか確認
    const before = pts[minI].prev, after = pts[minI].next;
    pts[minI].removed = true;
    pts[before].next = after; pts[after].prev = before;
    const kept = [];
    let cur = before, guard = 0;
    do { kept.push(pts[cur].p); cur = pts[cur].next; } while (cur !== before && ++guard < n + 5);
    if (kept.length >= 3 && ringSelfIntersects(kept)) {
      // 巻き戻す
      pts[minI].removed = false;
      pts[before].next = minI; pts[after].prev = minI;
      break;
    }
    live--;
  }
  const out = [];
  let cur = 0, guard = 0;
  // 最初の未除去点を探す
  while (pts[cur].removed && guard < n) { cur++; guard++; }
  const start = cur;
  do { out.push(pts[cur].p); cur = pts[cur].next; } while (cur !== start && out.length < n + 5);
  return out.length >= 3 ? out : ring.slice();
}

/** Polygon（[outer, ...holes]）を simplify。退化した hole は落とす。outer が退化したら null。 */
export function simplifyPolygon(poly, toleranceM) {
  if (!Array.isArray(poly) || !poly.length) return null;
  const outer = simplifyRing(poly[0], toleranceM, 4);
  if (outer.length < 3 || ringArea(outer) < toleranceM * toleranceM) return null;
  const holes = [];
  for (let h = 1; h < poly.length; h++) {
    const hs = simplifyRing(poly[h], toleranceM, 4);
    if (hs.length >= 3 && ringArea(hs) >= toleranceM * toleranceM * 2 && !ringSelfIntersects(hs)) holes.push(hs);
  }
  return [outer, ...holes];
}

/** geometryType + coordinates を simplify。空になったら null。 */
export function simplifyGeometry(geometryType, coordinates, toleranceM) {
  if (toleranceM <= 0) return { geometryType, coordinates };
  if (geometryType === 'Polygon') {
    const p = simplifyPolygon(coordinates, toleranceM);
    return p ? { geometryType: 'Polygon', coordinates: p } : null;
  }
  if (geometryType === 'MultiPolygon') {
    const parts = coordinates.map((p) => simplifyPolygon(p, toleranceM)).filter(Boolean);
    if (!parts.length) return null;
    return parts.length === 1 ? { geometryType: 'Polygon', coordinates: parts[0] } : { geometryType: 'MultiPolygon', coordinates: parts };
  }
  if (geometryType === 'LineString') {
    const l = simplifyLine(coordinates, toleranceM);
    return l.length >= 2 ? { geometryType: 'LineString', coordinates: l } : null;
  }
  if (geometryType === 'MultiLineString') {
    const parts = coordinates.map((l) => simplifyLine(l, toleranceM)).filter((l) => l.length >= 2);
    if (!parts.length) return null;
    return parts.length === 1 ? { geometryType: 'LineString', coordinates: parts[0] } : { geometryType: 'MultiLineString', coordinates: parts };
  }
  return { geometryType, coordinates };
}

/** Douglas-Peucker（line）。端点保持。 */
export function simplifyLine(line, toleranceM) {
  if (!Array.isArray(line) || line.length <= 2) return line.slice();
  const sqTol = toleranceM * toleranceM;
  const keep = new Uint8Array(line.length);
  keep[0] = 1; keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let maxD = -1, idx = -1;
    const a = line[lo], b = line[hi];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1e-9;
    for (let i = lo + 1; i < hi; i++) {
      const px = line[i][0] - a[0], py = line[i][1] - a[1];
      let t = (px * dx + py * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - t * dx, ey = py - t * dy;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sqTol && idx > lo) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < line.length; i++) if (keep[i]) out.push(line[i]);
  return out;
}

/** feature（canonical schema）を derived 用に simplify。geometry が空になったら null。 */
export function simplifyFeatureGeometry(feature, toleranceM) {
  const g = simplifyGeometry(feature.geometryType, feature.coordinates, toleranceM);
  if (!g) return null;
  return g;
}
