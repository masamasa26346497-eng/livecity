// tools/lib/polygon-clip.js
// [Mission 32E §7] Sutherland-Hodgman polygon clip。GSI再構成roadway(小さいquad)をPLATEAU tran
// road envelope(大きいpolygon)へ安全clipするために使う。
//
//   注意（正直な制約）: Sutherland-Hodgman は clip polygon が凸(convex)であることを厳密には要求するが、
//   道路polygonはカーブ部で局所的に非凸になり得る。本用途ではsubject(quad)がclip polygon(道路本体)に
//   比べて極めて小さい(数m四方)ため、局所的な非凸の影響は実用上ほぼ無視できると判断し採用する
//   （汎用の正確なpolygon boolean演算ライブラリは導入しない §0方針を踏襲）。envelope外へ大きくはみ出す
//   quadはこのclipではなく§18のGSI_CONFLICT判定で別途弾く。
function clipEdge(subject, a, b) {
  // 半平面 (a→b の左側) でsubjectをclipする。
  const out = [];
  const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
  const intersect = (p, q) => {
    // 直線 a→b と 線分 p→q の交点（標準的な2直線交点の公式）。
    const dx1 = b[0] - a[0], dz1 = b[1] - a[1];
    const dx2 = q[0] - p[0], dz2 = q[1] - p[1];
    const denom = dx1 * dz2 - dz1 * dx2;
    if (Math.abs(denom) < 1e-12) return q; // 平行（退化ケース）: 元の点を返す
    const t = ((p[0] - a[0]) * dz2 - (p[1] - a[1]) * dx2) / denom;
    return [a[0] + t * dx1, a[1] + t * dz1];
  };
  for (let i = 0; i < subject.length; i++) {
    const cur = subject[i], prev = subject[(i - 1 + subject.length) % subject.length];
    const curIn = inside(cur), prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}

/** ringは反時計回り/時計回りいずれでもよい（向きを自動判定して凸側半平面を揃える）。 */
function ensureCCW(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; area += x1 * z2 - x2 * z1; }
  return area < 0 ? ring.slice().reverse() : ring;
}

/**
 * subject(小さいquad等のring・[[x,z],...]) を clipRing(道路polygonの外周・[[x,z],...]) へclipする。
 * @returns {Array<[number,number]>} clip後のring（空配列なら完全にclip範囲外）
 */
export function clipPolygonToRing(subject, clipRing) {
  if (!subject || subject.length < 3 || !clipRing || clipRing.length < 3) return [];
  const clip = ensureCCW(clipRing);
  let output = subject.slice();
  for (let i = 0; i < clip.length && output.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    output = clipEdge(output, a, b);
  }
  return output;
}

export function ringAreaAbs(ring) {
  if (!ring || ring.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; a += x1 * z2 - x2 * z1; }
  return Math.abs(a) / 2;
}
