// tools/lib/building-representative-point.js
// 建物フットプリント（[x,z] 頂点列）から、所属区判定に使う「代表点」を求める（P1-3）。
//
// 単純な bbox 中心は L字・コの字の建物で建物外に落ちて誤判定するため、次の順で決める:
//   1. 面積重心（polygon centroid）。重心が自ポリゴン内なら採用。
//   2. 重心が外（凹形状）なら、重心のz高さで水平スキャンラインを引き、ポリゴン内部に入る
//      最も広い区間の中点を採用（"interior point"。多くのGISが使う手法）。
//   3. それも失敗（自己交差・退化等）なら bbox 中心にフォールバック（method で明示）。
//
// 返り値の method を分類レポートへ残し、フォールバック建物を可視化できるようにする。

import { pointInRing } from './point-in-polygon.js';

function areaCentroid(fp) {
  let a2 = 0, cx = 0, cz = 0;
  const n = fp.length;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = fp[i];
    const [x1, z1] = fp[(i + 1) % n];
    const cross = x0 * z1 - x1 * z0;
    a2 += cross;
    cx += (x0 + x1) * cross;
    cz += (z0 + z1) * cross;
  }
  if (Math.abs(a2) < 1e-9) {
    // 退化（面積ゼロ）: 頂点平均
    let sx = 0, sz = 0;
    for (const [x, z] of fp) { sx += x; sz += z; }
    return { x: sx / n, z: sz / n, area: 0 };
  }
  const area = a2 / 2;
  return { x: cx / (3 * a2), z: cz / (3 * a2), area: Math.abs(area) };
}

function bbox(fp) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of fp) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

// z 高さの水平線とポリゴン辺の交点を求め、内部区間の最長区間の中点を返す。
function scanlineInteriorPoint(fp, z) {
  const xs = [];
  const n = fp.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const zi = fp[i][1], zj = fp[j][1];
    if ((zi > z) !== (zj > z)) {
      const t = (z - zi) / (zj - zi);
      xs.push(fp[i][0] + t * (fp[j][0] - fp[i][0]));
    }
  }
  xs.sort((a, b) => a - b);
  // xs は偶数個。[xs[0],xs[1]] [xs[2],xs[3]] ... が内部区間。
  let bestMid = null, bestLen = -1;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const len = xs[k + 1] - xs[k];
    if (len > bestLen) { bestLen = len; bestMid = (xs[k] + xs[k + 1]) / 2; }
  }
  return bestMid === null ? null : { x: bestMid, z };
}

/**
 * @param {number[][]} fp 建物フットプリント [[x,z],...]（閉じていても開いていても可）
 * @returns {{x:number, z:number, method:'centroid'|'interior-scanline'|'bbox-center'|'vertex-mean', valid:boolean}}
 */
export function representativePoint(fp) {
  if (!Array.isArray(fp) || fp.length < 3 || fp.some((p) => !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
    return { x: NaN, z: NaN, method: 'bbox-center', valid: false };
  }
  // 閉リングなら終点重複を落とす（重心計算の退化を避ける）
  const ring = (fp.length > 3 && fp[0][0] === fp[fp.length - 1][0] && fp[0][1] === fp[fp.length - 1][1])
    ? fp.slice(0, -1) : fp;
  if (ring.length < 3) return { x: NaN, z: NaN, method: 'bbox-center', valid: false };

  const c = areaCentroid(ring);
  if (c.area > 0 && pointInRing(c.x, c.z, ring)) {
    return { x: round(c.x), z: round(c.z), method: 'centroid', valid: true };
  }

  const bb = bbox(ring);
  // 重心の z、だめなら bbox 中央の z でスキャンライン
  for (const z of [c.z, (bb.minZ + bb.maxZ) / 2, bb.minZ + (bb.maxZ - bb.minZ) * 0.5]) {
    const p = scanlineInteriorPoint(ring, z);
    if (p && pointInRing(p.x, p.z, ring)) {
      return { x: round(p.x), z: round(p.z), method: 'interior-scanline', valid: true };
    }
  }

  // 複数のzを試すスキャン（凹凸が強い建物）
  const steps = 9;
  for (let s = 1; s < steps; s++) {
    const z = bb.minZ + ((bb.maxZ - bb.minZ) * s) / steps;
    const p = scanlineInteriorPoint(ring, z);
    if (p && pointInRing(p.x, p.z, ring)) {
      return { x: round(p.x), z: round(p.z), method: 'interior-scanline', valid: true };
    }
  }

  // 最終フォールバック: bbox 中心（分類レポートで method='bbox-center' の件数を監視する）
  return { x: round((bb.minX + bb.maxX) / 2), z: round((bb.minZ + bb.maxZ) / 2), method: 'bbox-center', valid: true };
}

function round(v) {
  return Math.round(v * 100) / 100;
}

export { areaCentroid };
