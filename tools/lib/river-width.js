// tools/lib/river-width.js
// [河川再構築] 河川centerlineの実幅推定（THREE 非依存・純粋関数）。
//
// 優先順位（指示書 6項目）:
//   1. width タグ（現在の waterways 変換パイプラインは tags を tile 出力に保持していないため、
//      本モジュールでは呼び出し側が widthTag を渡した場合のみ使う。無ければ2へ）
//   2. riverbank polygon（waterway=riverbank 等、waterClass river/canal の area）から
//      centerline に沿って複数地点で断面幅を実測し、中央値(median)を採用
//   3. waterway種別（waterClass/subtype）による default 幅
//
// 断面計測: centerline上のサンプル点で局所接線に垂直な線分を左右に飛ばし、対応する
//   riverbank polygon の外周(outer ring)との交点までの距離を測る（内側の穴(hole)は無視。
//   本流の川幅計測が目的で、中州等の穴は対象外でよい）。
//   [重要] 左右の交点は必ず「サンプル点を内包する同一polygon」から取る。合流部などで複数の
//   riverbank polygonがbuffer範囲内に入ると、左右で別々のpolygon（本流と支流・隣接水面）から
//   distanceを拾ってしまい、無関係な遠い辺を幅として合算する事故が起きるため（実データで
//   寝屋川の一部区間がこの理由でwidth=500m clamp上限に達した）。

import { pointInRingXZ, ringAreaXZ } from './polygon-fill.js';

const MIN_RIVER_WIDTH_M = 6;     // これ未満は計測誤差とみなしclamp
const MAX_RIVER_WIDTH_M = 500;   // 淀川河口・大和川河口級を超える値はclamp（暴走防止）

export const RIVER_WIDTH_LIMITS = Object.freeze({ min: MIN_RIVER_WIDTH_M, max: MAX_RIVER_WIDTH_M });

// waterway種別のdefault幅（riverbank polygon が無い/計測不能な場合の最終fallbackのみに使う）。
export const DEFAULT_WIDTH_BY_CLASS = Object.freeze({
  river: 30,   // 一般河川
  canal: 12,   // 運河・水路
});

// [Mission04-B] minor waterway（主要7河川以外）の保守的な幅ルール。
//   建物を貫通しないことを最優先し、現状より細めへ寄せる。
export const MINOR_WIDTH_LIMITS = Object.freeze({ min: 3, max: 30 });
export const MINOR_DEFAULT_WIDTH_BY_CLASS = Object.freeze({
  river: 16,     // 市街地内の小河川（12〜24の下寄り）
  canal: 8,      // 運河（5〜12の中間）
  stream: 4, drain: 4, ditch: 3, // 細水路相当（2〜6）
});

// [Mission28 §3] MICRO waterway（drain / ditch / ごく小さい stream）。太くしすぎない。
//   drain 1.5〜4m / ditch 1〜3m / stream 3〜8m の下寄り。
export const MICRO_WIDTH_LIMITS = Object.freeze({ min: 1, max: 8 });
export const MICRO_DEFAULT_WIDTH_BY_CLASS = Object.freeze({
  stream: 4, drain: 2.5, ditch: 1.5,
});
/**
 * micro waterway の幅。measured があれば micro 上限で clamp、無ければ tag ベースの控えめ default。
 * @param {string} waterwayTag  drain | ditch | stream | canal
 * @param {number|null} measuredWidth
 * @returns {{width:number, method:'measured-clamped'|'micro-default'}}
 */
export function conservativeMicroWidth(waterwayTag, measuredWidth) {
  const L = MICRO_WIDTH_LIMITS;
  if (Number.isFinite(measuredWidth) && measuredWidth > 0) {
    return { width: Math.max(L.min, Math.min(L.max, measuredWidth)), method: 'measured-clamped' };
  }
  const def = MICRO_DEFAULT_WIDTH_BY_CLASS[waterwayTag] || MICRO_DEFAULT_WIDTH_BY_CLASS.drain;
  return { width: Math.max(L.min, Math.min(L.max, def)), method: 'micro-default' };
}
/**
 * minor waterway の幅を保守的に決める。measured があればそれを minor 上限で clamp、
 * 無ければ waterClass ベースの conservative default。
 * @param {string} waterClass
 * @param {number|null} measuredWidth
 * @returns {{width:number, method:'measured-clamped'|'conservative-default'}}
 */
export function conservativeMinorWidth(waterClass, measuredWidth) {
  const L = MINOR_WIDTH_LIMITS;
  if (Number.isFinite(measuredWidth) && measuredWidth > 0) {
    return { width: Math.max(L.min, Math.min(L.max, measuredWidth)), method: 'measured-clamped' };
  }
  const def = MINOR_DEFAULT_WIDTH_BY_CLASS[waterClass] || MINOR_DEFAULT_WIDTH_BY_CLASS.river;
  return { width: Math.max(L.min, Math.min(L.max, def)), method: 'conservative-default' };
}
// 大阪の主要7河川は、riverbank polygonが取得できない異常時のみこの値を使う
// （通常は下記 estimateRiverWidth の実測値が優先される）。
export const MAJOR_RIVER_DEFAULT_WIDTH = Object.freeze({
  '淀川': 400, '大和川': 250, '神崎川': 120, '安治川': 200, '木津川': 150, '寝屋川': 60, '道頓堀川': 40,
});

export function clampWidth(w) {
  if (!Number.isFinite(w)) return null;
  return Math.max(MIN_RIVER_WIDTH_M, Math.min(MAX_RIVER_WIDTH_M, w));
}

export function bboxOfPoints(points) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of (points || [])) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, maxX, minZ, maxZ };
}

export function bboxOverlaps(a, b, bufferM = 0) {
  if (!a || !b) return false;
  return a.minX - bufferM <= b.maxX && a.maxX + bufferM >= b.minX &&
         a.minZ - bufferM <= b.maxZ && a.maxZ + bufferM >= b.minZ;
}

/**
 * 光線 origin+dir*t (t>0) と線分 [a,b] の交点距離 t を返す（無ければ null）。
 * 2D (XZ平面) の standard ray-segment intersection。
 */
export function raySegmentHit(ox, oz, dx, dz, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az;
  const denom = dx * ez - dz * ex;
  if (Math.abs(denom) < 1e-9) return null; // 平行
  const t = ((ax - ox) * ez - (az - oz) * ex) / denom;
  const u = ((ax - ox) * dz - (az - oz) * dx) / denom;
  if (t < 0 || u < 0 || u > 1) return null;
  return t;
}

/** origin から dir 方向へ ring（外周のみ）に当たる最短距離。無ければ null。 */
export function nearestRingHitDistance(origin, dir, ring) {
  let best = null;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    if (!a || !b) continue;
    const t = raySegmentHit(origin[0], origin[1], dir[0], dir[1], a[0], a[1], b[0], b[1]);
    if (t != null && (best == null || t < best)) best = t;
  }
  return best;
}

function normalize2(x, z) {
  const len = Math.hypot(x, z);
  return len > 1e-9 ? [x / len, z / len] : [0, 0];
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * centerline に沿って riverbank polygon群 との断面幅を複数地点で計測し、中央値を返す。
 * @param {number[][]} centerline  [[x,z],...]
 * @param {{p:number[][], holes?:number[][][]}[]} riverbankPolygons  outer ring（p）のみ使用
 * @param {{sampleCount?:number, marginRatio?:number}} [opts]
 * @returns {{width:number|null, samples:number[], sampleCount:number, method:'measured'|'insufficient'}}
 */
export function measureCenterlineWidth(centerline, riverbankPolygons, opts = {}) {
  const sampleCount = opts.sampleCount || 9;
  const marginRatio = opts.marginRatio ?? 0.1; // 両端付近(合流部で歪みやすい)を避ける
  const n = centerline.length;
  if (n < 2 || !riverbankPolygons || !riverbankPolygons.length) {
    return { width: null, samples: [], sampleCount: 0, method: 'insufficient' };
  }
  // 弧長パラメータ化してサンプル位置を決める
  const segLens = [];
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = Math.hypot(centerline[i + 1][0] - centerline[i][0], centerline[i + 1][1] - centerline[i][1]);
    segLens.push(d); total += d;
  }
  if (total <= 0) return { width: null, samples: [], sampleCount: 0, method: 'insufficient' };

  function pointAndTangentAt(s) {
    let acc = 0;
    for (let i = 0; i < segLens.length; i++) {
      if (acc + segLens[i] >= s || i === segLens.length - 1) {
        const t = segLens[i] > 0 ? (s - acc) / segLens[i] : 0;
        const a = centerline[i], b = centerline[i + 1];
        const px = a[0] + (b[0] - a[0]) * t, pz = a[1] + (b[1] - a[1]) * t;
        const [tx, tz] = normalize2(b[0] - a[0], b[1] - a[1]);
        return { point: [px, pz], tangent: [tx, tz] };
      }
      acc += segLens[i];
    }
    return null;
  }

  // ring面積が小さい順（＝最も「局所的」なpolygon）を優先候補にする。合流部で複数polygonが
  // 重なっている場合、より広い隣接水面より本流自体のpolygonを選びやすくするため。
  const polysByArea = riverbankPolygons
    .filter((poly) => Array.isArray(poly.p) && poly.p.length >= 3)
    .map((poly) => ({ poly, area: ringAreaXZ(poly.p) }))
    .sort((a, b) => a.area - b.area);

  const samples = [];
  const lo = total * marginRatio, hi = total * (1 - marginRatio);
  for (let k = 0; k < sampleCount; k++) {
    const s = sampleCount === 1 ? total / 2 : lo + (hi - lo) * (k / (sampleCount - 1));
    const pt = pointAndTangentAt(s);
    if (!pt) continue;
    const normal = [-pt.tangent[1], pt.tangent[0]]; // 接線に垂直
    if (normal[0] === 0 && normal[1] === 0) continue;
    // サンプル点を内包する polygon の中から測る（左右で別polygonを混ぜない）。
    const containing = polysByArea.find(({ poly }) => pointInRingXZ(pt.point, poly.p));
    if (!containing) continue; // 内包するpolygonが無ければそのサンプルは捨てる（無関係な遠い辺を拾わない）
    const ring = containing.poly.p;
    const dLeft = nearestRingHitDistance(pt.point, normal, ring);
    const dRight = nearestRingHitDistance(pt.point, [-normal[0], -normal[1]], ring);
    if (dLeft != null && dRight != null) samples.push(dLeft + dRight);
  }
  if (samples.length < 3) return { width: null, samples, sampleCount: samples.length, method: 'insufficient' };
  // 外れ値除去: 中央値から大きく外れるサンプル（河口の急拡大・データ不整合等）を1回だけ trim する。
  const rawMedian = median(samples);
  const trimmed = samples.filter((w) => w <= rawMedian * 2.5 && w >= rawMedian * 0.35);
  const finalSamples = trimmed.length >= 3 ? trimmed : samples;
  return { width: median(finalSamples), samples: finalSamples, sampleCount: finalSamples.length, method: 'measured' };
}

/**
 * 1本のcenterline featureに対応するriverbank polygon群を選び、幅を決定する。
 * @param {{name?:string, p:number[][]}} lineFeature
 * @param {{name?:string, waterClass:string, p:number[][]}[]} riverbankFeatures  waterClass river/canalのみ渡すこと
 * @param {{bufferM?:number, widthTag?:number}} [opts]
 */
export function resolveRiverWidth(lineFeature, riverbankFeatures, opts = {}) {
  // 1. width タグ（渡された場合のみ）
  if (Number.isFinite(opts.widthTag) && opts.widthTag > 0) {
    return { width: clampWidth(opts.widthTag), method: 'tag', matchedRiverbanks: 0, sampleCount: 0 };
  }
  // 2. riverbank polygon から実測
  const bufferM = opts.bufferM ?? 300;
  const lineBbox = bboxOfPoints(lineFeature.p);
  const matched = (riverbankFeatures || []).filter((af) => {
    const abbox = bboxOfPoints(af.p);
    if (!bboxOverlaps(lineBbox, abbox, bufferM)) return false;
    if (lineFeature.name && af.name) return lineFeature.name === af.name;
    return true; // 名称不明な側は形状の近さのみで許容
  });
  const measured = measureCenterlineWidth(lineFeature.p, matched, opts);
  if (measured.width != null) {
    return { width: clampWidth(measured.width), method: 'measured', matchedRiverbanks: matched.length, sampleCount: measured.sampleCount, samples: (measured.samples || []).map((s) => +s.toFixed(2)) };
  }
  // 3. default（種別 or 主要河川名）
  const byName = lineFeature.name && MAJOR_RIVER_DEFAULT_WIDTH[lineFeature.name];
  const byClass = DEFAULT_WIDTH_BY_CLASS[lineFeature.waterClass] || DEFAULT_WIDTH_BY_CLASS.river;
  return { width: clampWidth(byName || byClass), method: 'default', matchedRiverbanks: matched.length, sampleCount: 0 };
}
