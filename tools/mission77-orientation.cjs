'use strict';
// [Mission 77] 座標の向き（鏡映/回転/軸入替/原点差）を、2D アフィン当てはめで判定する純粋関数。
// 注意: roundTripM（往復誤差）が小さいことは、座標の「方位」が正しいことの証明にならない。
// 往復は鏡映していても 0 になり得るため、ここでは異なる 2 経路の出力同士を非共線 3 点以上で比較する。
function fitAffine(src, dst) { // dst = A*src + t（最小二乗）
  const n = src.length; let sx = 0, sz = 0, dx = 0, dz = 0;
  for (let i = 0; i < n; i++) { sx += src[i][0]; sz += src[i][1]; dx += dst[i][0]; dz += dst[i][1]; }
  const mx = sx / n, mz = sz / n, ex = dx / n, ez = dz / n;
  let a = 0, b = 0, d = 0, p = 0, q = 0, r = 0, s = 0;
  for (let i = 0; i < n; i++) {
    const u = src[i][0] - mx, v = src[i][1] - mz, X = dst[i][0] - ex, Z = dst[i][1] - ez;
    a += u * u; b += u * v; d += v * v; p += u * X; q += v * X; r += u * Z; s += v * Z;
  }
  const det = a * d - b * b; if (Math.abs(det) < 1e-9) throw new Error('collinear input');
  const A00 = (p * d - q * b) / det, A01 = (q * a - p * b) / det, A10 = (r * d - s * b) / det, A11 = (s * a - r * b) / det;
  const t = [ex - (A00 * mx + A01 * mz), ez - (A10 * mx + A11 * mz)];
  let res = 0;
  for (let i = 0; i < n; i++) res = Math.max(res, Math.hypot(A00 * src[i][0] + A01 * src[i][1] + t[0] - dst[i][0], A10 * src[i][0] + A11 * src[i][1] + t[1] - dst[i][1]));
  return { A: [[A00, A01], [A10, A11]], t, det: A00 * A11 - A01 * A10, rotDeg: Math.atan2(A10 - A01, A00 + A11) * 180 / Math.PI, residualM: res };
}
function classify(src, dst, o) {
  o = Object.assign({ posTolM: 0.05, scaleTol: 1e-4, angTolDeg: 0.01 }, o || {});
  const f = fitAffine(src, dst), issues = [];
  if (f.det < 0) issues.push('mirror(det<0)');
  if (Math.abs(Math.sqrt(Math.abs(f.det)) - 1) > o.scaleTol) issues.push('scale');
  if (f.det > 0 && Math.abs(f.rotDeg) > o.angTolDeg) issues.push('rotation(' + f.rotDeg.toFixed(3) + 'deg)');
  if (Math.hypot(f.t[0], f.t[1]) > o.posTolM) issues.push('origin-offset(' + f.t.map((v) => v.toFixed(3)).join(',') + 'm)');
  if (f.residualM > o.posTolM) issues.push('nonrigid-residual(' + f.residualM.toFixed(3) + 'm)');
  return { ok: issues.length === 0, issues, fit: f };
}
module.exports = { fitAffine, classify };
