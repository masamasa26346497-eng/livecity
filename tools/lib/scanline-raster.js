// tools/lib/scanline-raster.js
// [Mission 32P] 1m ラスタへの polygon 塗り（scanline・even-odd）。
//   セル中心 (minX+i+0.5, minZ+j+0.5) が polygon 内のセルを塗る（point-in-polygon と同じ判定）。
//   穴（hole）を持つ polygon は、同じ polygon の全リングを一緒に渡すと even-odd で正しく抜ける。
//   1 セル = 1m²。計算量は「行数 × 辺数」で、セル数 × 頂点数にならない（全市ラスタ用）。

/**
 * @param {{minX:number,minZ:number,nx:number,nz:number}} g  ラスタ（整数原点）
 * @param {number[][][]} rings  同じ polygon のリング群（outer + holes）
 * @param {(i:number,j:number)=>void} [cell]  塗る各セルで呼ぶ（指定しない場合は spans を返す）
 * @returns {number} 塗ったセル数
 */
export function scanFill(g, rings, cell) {
  let minZ = Infinity, maxZ = -Infinity;
  for (const r of rings) for (const p of r) { if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; }
  const j0 = Math.max(0, Math.ceil(minZ - g.minZ - 0.5));
  const j1 = Math.min(g.nz - 1, Math.floor(maxZ - g.minZ - 0.5));
  if (j1 < j0) return 0;
  // 辺を行範囲でソートしておく（行ごとに走査する辺を絞る）
  const edges = [];
  for (const r of rings) {
    const n = r.length;
    for (let k = 0, l = n - 1; k < n; l = k++) {
      const a = r[l], b = r[k];
      if (a[1] === b[1]) continue;
      const lo = a[1] < b[1] ? a : b, hi = a[1] < b[1] ? b : a;
      edges.push([lo[0], lo[1], hi[0], hi[1]]);
    }
  }
  edges.sort((e1, e2) => e1[1] - e2[1]);
  let count = 0;
  const active = [];
  let ei = 0;
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = g.minZ + j + 0.5;
    while (ei < edges.length && edges[ei][1] <= z) active.push(edges[ei++]);
    xs.length = 0;
    for (let k = active.length - 1; k >= 0; k--) {
      const e = active[k];
      if (e[3] <= z) { active[k] = active[active.length - 1]; active.pop(); continue; }
      // 半開区間 [lo, hi) で交差（頂点の二重計上を防ぐ）
      xs.push(e[0] + ((z - e[1]) * (e[2] - e[0])) / (e[3] - e[1]));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] - g.minX - 0.5));
      const i1 = Math.min(g.nx - 1, Math.ceil(xs[k + 1] - g.minX - 0.5) - 1);
      for (let i = i0; i <= i1; i++) { if (cell) cell(i, j); count++; }
    }
  }
  return count;
}

/** mask[j*nx+i] |= bit で塗る。 */
export function fillBits(g, mask, rings, bit) {
  return scanFill(g, rings, (i, j) => { mask[j * g.nx + i] |= bit; });
}

/**
 * water mask（非 0 = 水）から「最も近い陸セルまでの距離（m）」を 2-pass chamfer（3-4）で求める。
 * ラスタ外は水とみなす（境界で深さを過小評価しないため。必要な余白は呼び出し側で取る）。
 * @returns {Float32Array}  陸セルは 0
 */
export function waterDepth(g, isWater) {
  const { nx, nz } = g;
  const INF = 1e9;
  const d = new Float32Array(nx * nz);
  for (let k = 0; k < d.length; k++) d[k] = isWater[k] ? INF : 0;
  const A = 1, B = Math.SQRT2;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i; if (!d[k]) continue;
    let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + A);
    if (j > 0) { v = Math.min(v, d[k - nx] + A); if (i > 0) v = Math.min(v, d[k - nx - 1] + B); if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + B); }
    d[k] = v;
  }
  for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i; if (!d[k]) continue;
    let v = d[k];
    if (i < nx - 1) v = Math.min(v, d[k + 1] + A);
    if (j < nz - 1) { v = Math.min(v, d[k + nx] + A); if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + B); if (i > 0) v = Math.min(v, d[k + nx - 1] + B); }
    d[k] = v;
  }
  return d;
}
