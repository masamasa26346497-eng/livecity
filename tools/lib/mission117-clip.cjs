'use strict';
// Mission 117: exact boundary clipping for per-ward layers (pure functions, no I/O).
// Why: the 45I builder kept the NEXT vertex outside the ward on each line (so lines would not "float" at the edge) and kept
// water/park AREA rings whole. Those vertices can lie far outside the ward bbox (a long segment, or a whole river polygon), which the
// Mission 115 verifier correctly flags. Here the outside vertex is replaced by the point where the segment crosses the ward boundary
// (bisection against the same inside tester), and area rings are clipped to the ward clip box (Sutherland-Hodgman, exact for a rectangle).
const r1 = (v) => Math.round(v * 10) / 10;

/** Bisect segment a(inside)->b(outside) for the last inside point. */
function crossing(a, b, inside) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (inside(a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m)) lo = m; else hi = m;
  }
  return [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo];
}

/** Polyline -> runs whose every vertex is inside; each run starts/ends at the boundary crossing. */
function clipLineExact(pts, inside) {
  const runs = [];
  let cur = null, prev = null, prevIn = false;
  for (const p of pts) {
    const ins = !!inside(p[0], p[1]);
    if (prev) {
      if (prevIn && !ins) { cur.push(crossing(prev, p, inside)); runs.push(cur); cur = null; }
      else if (!prevIn && ins) { cur = [crossing(p, prev, inside), p]; }
      else if (prevIn && ins) cur.push(p);
    } else if (ins) cur = [p];
    prev = p; prevIn = ins;
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.length >= 2).map((r) => r.map((q) => [r1(q[0]), r1(q[1])]));
}

/** Ring -> ring clipped to the box (Sutherland-Hodgman). Returns null when nothing remains. */
function clipRingToBox(ring, box) {
  let pts = ring.slice();
  const closed = pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  if (closed) pts.pop();
  const edges = [
    [(p) => p[0] >= box.minX, (a, b) => { const t = (box.minX - a[0]) / (b[0] - a[0]); return [box.minX, a[1] + (b[1] - a[1]) * t]; }],
    [(p) => p[0] <= box.maxX, (a, b) => { const t = (box.maxX - a[0]) / (b[0] - a[0]); return [box.maxX, a[1] + (b[1] - a[1]) * t]; }],
    [(p) => p[1] >= box.minZ, (a, b) => { const t = (box.minZ - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, box.minZ]; }],
    [(p) => p[1] <= box.maxZ, (a, b) => { const t = (box.maxZ - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, box.maxZ]; }],
  ];
  for (const [keep, cut] of edges) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], ka = keep(a), kb = keep(b);
      if (ka) out.push(a);
      if (ka !== kb) out.push(cut(a, b));
    }
    pts = out;
    if (pts.length < 3) return null;
  }
  pts = pts.map((q) => [Math.min(box.maxX, Math.max(box.minX, r1(q[0]))), Math.min(box.maxZ, Math.max(box.minZ, r1(q[1])))]);
  if (closed) pts.push(pts[0].slice());
  return pts;
}

module.exports = { clipLineExact, clipRingToBox, crossing };
