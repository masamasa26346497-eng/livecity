// tools/lib/river-building-conflict.js
// [Mission04-B] 小河川(minor waterway) ribbon と建物 footprint の干渉を検出し、
//   幅縮小 → それでもダメなら非表示（suppress）で「建物が川の中に立って見える」状態を解消する。
// THREE 非依存・純粋関数。座標は znorth-neg-v1 の XZ（[x,z]）。

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function bboxOf(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; }
  return { minX, maxX, minZ, maxZ };
}

/**
 * 建物 footprint 配列（[[x,z],...] の外周リング）を格子バケットへ索引する。
 * @param {number[][][]} footprints
 * @param {number} [cellM=150]
 */
export function buildFootprintGrid(footprints, cellM = 150) {
  const grid = new Map();
  const key = (cx, cz) => cx + '_' + cz;
  for (const fp of (footprints || [])) {
    if (!Array.isArray(fp) || fp.length < 3) continue;
    const bb = bboxOf(fp);
    const c0x = Math.floor(bb.minX / cellM), c1x = Math.floor(bb.maxX / cellM);
    const c0z = Math.floor(bb.minZ / cellM), c1z = Math.floor(bb.maxZ / cellM);
    const rec = { fp, bb };
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
      const k = key(cx, cz);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(rec);
    }
  }
  return { grid, cellM, count: footprints ? footprints.length : 0 };
}

/** 点 (x,z) がいずれかの建物 footprint 内にあるか。 */
export function pointInAnyFootprint(x, z, index) {
  if (!index || !index.grid) return false;
  const cx = Math.floor(x / index.cellM), cz = Math.floor(z / index.cellM);
  const bucket = index.grid.get(cx + '_' + cz);
  if (!bucket) return false;
  for (const rec of bucket) {
    const bb = rec.bb;
    if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) continue;
    if (pointInRing(x, z, rec.fp)) return true;
  }
  return false;
}

/**
 * ribbon（dense centerline + 頂点別 halfWidth）の建物干渉度を評価する。
 *  - centerInFrac: centerline の点が建物内にある割合（＝水路が建物ブロックを貫いて描かれている）
 *  - edgeInFrac  : 左右 offset 点が建物内にある割合（＝ribbon の縁が建物に食い込んでいる）
 * @param {number[][]} dense
 * @param {number[]} halfWidths  length === dense.length
 * @param {object} index  buildFootprintGrid の戻り値
 */
export function assessRibbonConflict(dense, halfWidths, index) {
  const n = dense.length;
  if (n < 2) return { n: 0, centerInFrac: 0, edgeInFrac: 0 };
  let centerIn = 0, edgeIn = 0;
  for (let i = 0; i < n; i++) {
    const cur = dense[i];
    if (pointInAnyFootprint(cur[0], cur[1], index)) centerIn++;
    // 局所法線: 前後の点から接線→垂直
    const p = dense[Math.max(0, i - 1)], q = dense[Math.min(n - 1, i + 1)];
    let tx = q[0] - p[0], tz = q[1] - p[1];
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    const nx = -tz, nz = tx;
    const h = halfWidths[Math.min(i, halfWidths.length - 1)] || 0;
    const lx = cur[0] + nx * h, lz = cur[1] + nz * h;
    const rx = cur[0] - nx * h, rz = cur[1] - nz * h;
    if (pointInAnyFootprint(lx, lz, index) || pointInAnyFootprint(rx, rz, index)) edgeIn++;
  }
  return { n, centerInFrac: centerIn / n, edgeInFrac: edgeIn / n };
}

export const CONFLICT_DEFAULTS = Object.freeze({
  edgeOkFrac: 0.15,        // 縁が建物内の割合がこれ以下なら OK
  centerOkFrac: 0.30,      // centerline が建物内の割合がこれ以下なら OK
  centerSuppressFrac: 0.55, // centerline がこれ以上建物内 → 幅を縮めても無意味 → 即 suppress
  scales: [1.0, 0.85, 0.70, 0.55], // 段階的縮小
  // preferShrink: 名前付きの river-class 小河川など「なるべく残したい」対象に true。
  //   さらに細い 0.40 倍まで試し、edge がまだ多くても edgeOkFracRelaxed 以下なら keep（thin表示）。
  preferShrink: false,
  extraScale: 0.40,
  edgeOkFracRelaxed: 0.35,
});

/**
 * minor waterway 1本の干渉を解決する。scales を順に試し、OK になった倍率を返す。
 * どの倍率でも OK にならなければ suppress。
 * @param {number[][]} dense
 * @param {number[]} baseHalfWidths
 * @param {object} index
 * @param {object} [opts]
 * @returns {{action:'keep'|'shrink'|'suppress', scale:number, edgeInFrac:number, centerInFrac:number, tried:number}}
 */
export function resolveMinorConflict(dense, baseHalfWidths, index, opts = {}) {
  const o = { ...CONFLICT_DEFAULTS, ...opts };
  // まず等倍で評価。centerline が大きく建物内なら即 suppress。
  const first = assessRibbonConflict(dense, baseHalfWidths, index);
  if (first.centerInFrac >= o.centerSuppressFrac) {
    return { action: 'suppress', scale: 0, edgeInFrac: first.edgeInFrac, centerInFrac: first.centerInFrac, tried: 1 };
  }
  const scaleList = o.preferShrink ? [...o.scales, o.extraScale] : o.scales;
  let last = first;
  for (let s = 0; s < scaleList.length; s++) {
    const scale = scaleList[s];
    const a = s === 0 ? first : assessRibbonConflict(dense, baseHalfWidths.map((h) => h * scale), index);
    last = a;
    if (a.edgeInFrac <= o.edgeOkFrac && a.centerInFrac <= o.centerOkFrac) {
      return { action: scale === 1 ? 'keep' : 'shrink', scale, edgeInFrac: a.edgeInFrac, centerInFrac: a.centerInFrac, tried: s + 1 };
    }
  }
  // preferShrink（残したい対象）: 最細でも center は基準内、edge が緩めの基準内なら thin 表示で残す。
  if (o.preferShrink && last.centerInFrac <= o.centerOkFrac && last.edgeInFrac <= o.edgeOkFracRelaxed) {
    return { action: 'shrink', scale: o.extraScale, edgeInFrac: last.edgeInFrac, centerInFrac: last.centerInFrac, tried: scaleList.length, thin: true };
  }
  return { action: 'suppress', scale: 0, edgeInFrac: last.edgeInFrac, centerInFrac: last.centerInFrac, tried: scaleList.length };
}
