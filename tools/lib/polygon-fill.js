// tools/lib/polygon-fill.js
// P1-6E: 水域/公園などの「面フィル」の三角形分割を安全に行うための共通ロジック。
//
// 【背景】public/osaka_3d_buildings.ward-ux-v1.html の CityTileLayer が water(area) を
//   THREE.ShapeUtils.triangulateShape（= mapbox/earcut）で塗っていたが、実機で
//   「巨大な水色polygon/帯が画面を横断する」問題が出た。
//   調査の結果 earcut 自体の分割は正しい（triArea/polyArea ≈ 1.000）が、
//     - outer/holes の重複頂点・巻き方向・hole が outer 外にあるケースを正規化していない
//     - 分割結果を一切検証せず、壊れた入力（自己交差・退化）でも黙って描画していた
//   ことが分かった。ここで「入力正規化」と「分割結果の検証」を行い、HTML 側へ同じ処理を inline する。
//
// 座標は世界 XZ（[x, z] のペア。znorth-neg-v1）。THREE 非依存。earcut は tools/lib/earcut.js を使う
//   （THREE r128 が内部で使うのと同一アルゴリズム）。

import { triangulateShape } from './earcut.js';

const EPS = 0.01; // 1cm。連続重複頂点の除去しきい値。

export function signedAreaXZ(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % ring.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}
export const ringAreaXZ = (ring) => Math.abs(signedAreaXZ(ring));

function finitePair(p) { return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]); }

/** 終点=始点の重複を落とし、連続する（ほぼ）同一点・非有限点を除去する。 */
export function cleanRingXZ(ring, eps = EPS) {
  if (!Array.isArray(ring)) return [];
  let s = ring.filter(finitePair);
  if (s.length > 1) {
    const [ax, az] = s[0];
    const [bx, bz] = s[s.length - 1];
    if (Math.hypot(ax - bx, az - bz) <= eps) s = s.slice(0, -1);
  }
  const out = [];
  for (const p of s) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) out.push([p[0], p[1]]);
  }
  // 先頭と末尾も潰す（1周して重なるケース）
  if (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  return out;
}

/**
 * 長い辺に中点を挿入する。疎ノードの河川ポリゴンを earcut に渡すと「地物を横断する巨大な
 * 三角形」ができ、実河道の形からかけ離れて見える。辺を細分すると earcut が形状に沿った
 * 小さな三角形を返すようになる（頂点位置は変えないので polygon 形状自体は不変）。
 * @param {number[][]} ring
 * @param {number} maxSeg  この長さ(m)を超える辺を分割
 */
export function densifyRingXZ(ring, maxSeg = 150) {
  if (!Array.isArray(ring) || ring.length < 2 || !(maxSeg > 0)) return ring;
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    out.push([a[0], a[1]]);
    if (i === ring.length - 1) break; // 閉じ辺は次リング先頭で扱う（trimClosed 前提）
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d > maxSeg) {
      const n = Math.min(64, Math.ceil(d / maxSeg));
      for (let k = 1; k < n; k++) out.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]);
    }
  }
  return out;
}

/** dir: 'ccw'（signedArea>0）| 'cw'（<0）へ揃える。 */
export function ensureWindingXZ(ring, dir) {
  const a = signedAreaXZ(ring);
  const wantPositive = dir === 'ccw';
  if ((a > 0) === wantPositive || a === 0) return ring.slice();
  return ring.slice().reverse();
}

export function pointInRingXZ(pt, ring) {
  let inside = false;
  const x = pt[0], z = pt[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    const hit = ((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

export function centroidXZ(ring) {
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return [x / ring.length, z / ring.length];
}

export function bboxXZ(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, maxX, minZ, maxZ, width: maxX - minX, height: maxZ - minZ, diag: Math.hypot(maxX - minX, maxZ - minZ) };
}

/**
 * outer/holes を三角形分割前に正規化する。
 *  - 重複/非有限頂点の除去
 *  - outer は CCW、holes は CW へ
 *  - outer の外側にある hole（重心も全頂点も outer 外）は捨てる（earcut の bridge 暴走防止）
 * @returns {{outer:number[][], holes:number[][][], droppedHoles:number}}
 */
export function prepareFill(outerRaw, holesRaw, opts = {}) {
  // densify は既定 0（無効）。疎ノードの実河川では earcut に collinear 点を渡すことになり
  // 細片三角形の重心が境界外に落ちやすく、かえって描画拒否を招くため。将来 ribbon 化(P1-7)で対応。
  const densify = opts.densifyMaxSeg ?? 0;
  let outer = cleanRingXZ(outerRaw);
  if (densify > 0) outer = densifyRingXZ(outer, densify);
  outer = ensureWindingXZ(outer, 'ccw');
  const holes = [];
  let droppedHoles = 0;
  for (const hRaw of (holesRaw || [])) {
    let h = cleanRingXZ(hRaw);
    if (h.length < 3) { droppedHoles++; continue; }
    const cIn = pointInRingXZ(centroidXZ(h), outer);
    const anyVertIn = h.some((v) => pointInRingXZ(v, outer));
    if (!cIn && !anyVertIn) { droppedHoles++; continue; } // outer と無関係な hole
    if (densify > 0) h = densifyRingXZ(h, densify);
    holes.push(ensureWindingXZ(h, 'cw'));
  }
  return { outer, holes, droppedHoles };
}

/** earcut で分割。faces は points（outer→holes 連結）へのインデックス三つ組。 */
export function triangulateFillXZ(outer, holes) {
  const points = outer.concat(...(holes || []));
  let faces = [];
  try { faces = triangulateShape(outer, holes || []); } catch (e) { faces = []; }
  return { points, faces };
}

/**
 * 分割結果の健全性チェック。earcut は基本正しいが、自己交差・退化入力では
 * 総面積が polygon 面積から大きくずれたり、1枚の三角形が polygon の大半を覆ったりする。
 * これらを「巨大面の兆候」として検出し、フィーチャ単位で描画を止められるようにする。
 *
 * @param {object} opts
 *   areaRatioTol=0.15   |triArea/polyArea - 1| がこれを超えたら reject
 *   dominantRatioMax=0.7 1枚の三角形面積 / polyArea がこれを超え、かつ outer>6頂点なら reject
 *   maxOutsideCentroid=0 三角形重心が outer 外（または hole 内）である枚数の許容上限
 *   centroidSampleLimit=4000
 */
export function validateFillXZ(outer, holes, faces, points, opts = {}) {
  const areaRatioTol = opts.areaRatioTol ?? 0.15;
  const dominantRatioMax = opts.dominantRatioMax ?? 0.85;
  // 細く蛇行する実河川ポリゴンは earcut の細片三角形の重心が境界の外側/内側ギリギリに
  // 落ちることがある。少数なら正常。全体の一定割合を超えたときだけ「連結崩れ」と判定する。
  const outsideCentroidFracMax = opts.outsideCentroidFracMax ?? 0.06;
  const outsideCentroidAbsMax = opts.outsideCentroidAbsMax ?? 3;
  const sampleLimit = opts.centroidSampleLimit ?? 8000;

  let polyArea = ringAreaXZ(outer);
  for (const h of (holes || [])) polyArea -= ringAreaXZ(h);
  polyArea = Math.max(polyArea, 1e-6);

  let triArea = 0;
  let maxTriArea = 0;
  let maxTriEdge = 0;
  let outsideCentroid = 0;
  const checkCentroid = faces.length <= sampleLimit;

  for (const fc of faces) {
    const a = points[fc[0]], b = points[fc[1]], c = points[fc[2]];
    if (!a || !b || !c) return { ok: false, reason: 'face-index-out-of-range', polyArea, triArea, areaRatio: 0, triangleCount: faces.length, maxTriEdge, dominantRatio: 0, outsideCentroid };
    const ar = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    triArea += ar;
    if (ar > maxTriArea) maxTriArea = ar;
    const e = Math.max(
      Math.hypot(a[0] - b[0], a[1] - b[1]),
      Math.hypot(b[0] - c[0], b[1] - c[1]),
      Math.hypot(c[0] - a[0], c[1] - a[1]),
    );
    if (e > maxTriEdge) maxTriEdge = e;
    if (checkCentroid) {
      const cen = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
      if (!pointInRingXZ(cen, outer) || (holes || []).some((h) => pointInRingXZ(cen, h))) outsideCentroid++;
    }
  }

  const areaRatio = triArea / polyArea;
  const dominantRatio = maxTriArea / polyArea;
  const outsideFrac = faces.length ? outsideCentroid / faces.length : 0;
  let ok = true;
  let reason = '';
  if (faces.length === 0) { ok = false; reason = 'no-faces'; }
  else if (Math.abs(areaRatio - 1) > areaRatioTol) { ok = false; reason = `area-ratio ${areaRatio.toFixed(3)}`; }
  else if (outer.length > 6 && dominantRatio > dominantRatioMax) { ok = false; reason = `dominant-triangle ${dominantRatio.toFixed(3)}`; }
  else if (checkCentroid && outsideCentroid > outsideCentroidAbsMax && outsideFrac > outsideCentroidFracMax) {
    ok = false; reason = `centroid-outside ${outsideCentroid}/${faces.length} (${(outsideFrac * 100).toFixed(1)}%)`;
  }

  return {
    ok, reason,
    polyArea, triArea, areaRatio,
    triangleCount: faces.length,
    maxTriEdge, dominantRatio, outsideCentroid,
  };
}

/**
 * フィーチャ1件 → フィル用の頂点配列（[x,y,z,...]）と診断情報。
 * @param {{kind?:string, p:number[][], holes?:number[][][], id?:string}} feature
 * @param {number} y
 * @param {object} [opts]  validateFillXZ の opts に加え tileId
 * @returns {{positions:number[], debug:object, rejected:boolean, reason:string}}
 */
export function buildFillPositions(feature, y, opts = {}) {
  const dbg = {
    featureId: feature.id || '(no-id)',
    sourceType: feature.source ? feature.source.type : null,
    sourceId: feature.source ? feature.source.id : null,
    sourceName: feature.source ? (feature.source.name || '') : (feature.name || ''),
    geometryType: feature.kind || 'area',
    outerPointCount: Array.isArray(feature.p) ? feature.p.length : 0,
    holeCount: Array.isArray(feature.holes) ? feature.holes.length : 0,
    bboxWidth: 0, bboxHeight: 0, triangleCount: 0, areaRatio: 0, maxTriEdge: 0,
    tileId: opts.tileId || '',
  };
  if (feature.kind && feature.kind !== 'area') {
    return { positions: [], debug: dbg, rejected: true, reason: 'not-area' };
  }
  if (!Array.isArray(feature.p) || feature.p.length < 3) {
    return { positions: [], debug: dbg, rejected: true, reason: 'degenerate-input' };
  }
  const { outer, holes, droppedHoles } = prepareFill(feature.p, feature.holes, opts);
  dbg.droppedHoles = droppedHoles;
  if (outer.length < 3) return { positions: [], debug: dbg, rejected: true, reason: 'degenerate-outer' };
  const bb = bboxXZ(outer);
  dbg.bboxWidth = Math.round(bb.width);
  dbg.bboxHeight = Math.round(bb.height);

  const { points, faces } = triangulateFillXZ(outer, holes);
  const v = validateFillXZ(outer, holes, faces, points, opts);
  dbg.triangleCount = v.triangleCount;
  dbg.areaRatio = +v.areaRatio.toFixed(3);
  dbg.maxTriEdge = Math.round(v.maxTriEdge);
  dbg.dominantRatio = +v.dominantRatio.toFixed(3);
  if (!v.ok) return { positions: [], debug: dbg, rejected: true, reason: v.reason };

  const positions = [];
  for (const fc of faces) for (const idx of fc) { const p = points[idx]; if (p) positions.push(p[0], y, p[1]); }
  return { positions, debug: dbg, rejected: false, reason: '' };
}
