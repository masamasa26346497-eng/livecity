// tools/lib/river-ribbon.js
// [河川再構築] centerline + width から「帯(ribbon)」ジオメトリを作る（THREE 非依存・純粋関数）。
//
// 方針（指示書 4・5節）: OSMのriverbank areaをそのまま巨大meshとして塗るのをやめ、
//   centerline（中心線）に幅を持たせたribbonを生成する。
//   - 曲がり角で巨大三角形を作らない: miter長を width基準でclampする（clamp方式。bevel全実装はしない）
//   - segment間の隙間を作らない: 各頂点の左右offset点を隣接三角形が共有する構造にする
//   - 長い直線区間は事前にdensify（中間点を挿入）し、幅方向のoffsetが不自然に伸びないようにする

const EPS = 0.01;

function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

/** 連続重複点を除去する（開いたpolyline用。閉リング特有の終端処理はしない）。 */
export function cleanPolylineXZ(points, eps = EPS) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const p of points) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const q = out[out.length - 1];
    if (!q || dist(p, q) > eps) out.push([p[0], p[1]]);
  }
  return out;
}

/** maxSeg を超える辺に中間点を挿入する（開いたpolyline版。頂点位置=形状は変えない）。 */
export function densifyPolylineXZ(points, maxSeg = 60) {
  if (!Array.isArray(points) || points.length < 2 || !(maxSeg > 0)) return points;
  const out = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const d = dist(a, b);
    if (d > maxSeg) {
      const n = Math.min(64, Math.ceil(d / maxSeg));
      for (let k = 1; k < n; k++) out.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]);
    }
    out.push(b);
  }
  return out;
}

function normalize2(x, z) {
  const len = Math.hypot(x, z);
  return len > 1e-9 ? [x / len, z / len] : [0, 0];
}

/**
 * centerline の各頂点に対応する左右offset点を求める。
 * ribbon幅 `width` は数値（一定幅）または頂点ごとの配列（可変幅。[Mission04] 川幅を滑らかに
 * 変化させるために使う。長さは centerline と一致すること）。
 * 角の内側でoffset点が飛び出さないよう、miter長を maxMiterRatio*halfWidth でclampする
 * （clamp方式。鋭角では厳密なmiterではなくclamp後の近似形状になるが、巨大spikeを防ぐ）。
 * @param {number[][]} centerline  cleanPolylineXZ 済みであること（重複点なし）
 * @param {number|number[]} width
 * @param {{maxMiterRatio?:number}} [opts]
 * @returns {{left:number[][], right:number[][]}}
 */
export function offsetCenterline(centerline, width, opts = {}) {
  const n = centerline.length;
  const widthArr = Array.isArray(width);
  const halfAt = (i) => (widthArr ? (width[Math.min(i, width.length - 1)] || 0) : width) / 2;
  const maxMiterRatio = opts.maxMiterRatio ?? 2.5;
  const left = new Array(n), right = new Array(n);
  if (n < 2) return { left: [], right: [] };
  for (let i = 0; i < n; i++) {
    const half = halfAt(i);
    const prev = centerline[Math.max(0, i - 1)];
    const cur = centerline[i];
    const next = centerline[Math.min(n - 1, i + 1)];
    const [d1x, d1z] = normalize2(cur[0] - prev[0], cur[1] - prev[1]);
    const [d2x, d2z] = normalize2(next[0] - cur[0], next[1] - cur[1]);
    let nx, nz, scale;
    if (i === 0) { nx = -d2z; nz = d2x; scale = 1; }
    else if (i === n - 1) { nx = -d1z; nz = d1x; scale = 1; }
    else {
      const n1x = -d1z, n1z = d1x, n2x = -d2z, n2z = d2x;
      let bx = n1x + n2x, bz = n1z + n2z;
      const blen = Math.hypot(bx, bz);
      if (blen < 1e-6) { nx = n1x; nz = n1z; scale = 1; } // ほぼ180度反転（U字折返し）: bisectorが不定→片側normalで代用
      else {
        bx /= blen; bz /= blen;
        const cosHalf = bx * n1x + bz * n1z; // = cos(角度差/2) 相当
        scale = 1 / Math.max(cosHalf, 1e-3);
        scale = Math.min(scale, maxMiterRatio); // [clamp] 鋭角でのspike防止
        nx = bx; nz = bz;
      }
    }
    left[i] = [cur[0] + nx * half * scale, cur[1] + nz * half * scale];
    right[i] = [cur[0] - nx * half * scale, cur[1] - nz * half * scale];
  }
  return { left, right };
}

function triArea2(a, b, c) {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

function triMaxEdge(t) {
  return Math.max(dist(t[0], t[1]), dist(t[1], t[2]), dist(t[2], t[0]));
}

/**
 * left/right offsetから三角形リスト（flat XZ、Yは呼び出し側で乗せる）を作る。
 * quad(left[i],right[i],left[i+1],right[i+1]) を2三角形に分割。
 * @returns {{trianglesXZ:number[][][], triangleCount:number, maxTriangleArea:number, maxTriangleEdge:number}}
 *   trianglesXZ: 各要素が [[x,z],[x,z],[x,z]] の三角形配列
 *   maxTriangleEdge: 全三角形中の最長辺(m)。centerline方向の辺が異常に長い場合
 *     （sourceの継ぎ目・巨大ジャンプ等）を検出するための指標（幅方向の辺は width 程度が正常）。
 */
export function triangulateRibbon(left, right) {
  const triangles = [];
  let maxArea = 0, maxEdge = 0;
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n - 1; i++) {
    const a = left[i], b = right[i], c = left[i + 1], d = right[i + 1];
    const t1 = [a, c, b], t2 = [b, c, d];
    for (const t of [t1, t2]) {
      const area = triArea2(t[0], t[1], t[2]);
      if (area > maxArea) maxArea = area;
      const edge = triMaxEdge(t);
      if (edge > maxEdge) maxEdge = edge;
      triangles.push(t);
    }
  }
  return { trianglesXZ: triangles, triangleCount: triangles.length, maxTriangleArea: maxArea, maxTriangleEdge: maxEdge };
}

/**
 * centerline + width から ribbon（left/right offset polyline + 三角形統計）を一括生成する。
 * @param {number[][]} centerlineRaw
 * @param {number} width
 * @param {{maxSeg?:number, maxMiterRatio?:number}} [opts]
 */
export function buildRiverRibbon(centerlineRaw, width, opts = {}) {
  const cleaned = cleanPolylineXZ(centerlineRaw);
  if (cleaned.length < 2 || !(width > 0)) {
    return { ok: false, reason: cleaned.length < 2 ? 'too-few-points' : 'invalid-width', left: [], right: [], centerline: cleaned, triangleCount: 0, maxTriangleArea: 0, maxTriangleEdge: 0, bbox: null, centerlineLength: 0, rawMaxSegment: 0 };
  }
  // [指示書9節] 「数km級の横飛び」検出用: densify前（元のOSM点列）での最大隣接距離を報告する。
  //   densify後は中間点が挿入され見た目上は滑らかになるため、元データ由来のジャンプはここで見る。
  let rawMaxSegment = 0, centerlineLength = 0;
  for (let i = 0; i < cleaned.length - 1; i++) {
    const d = dist(cleaned[i], cleaned[i + 1]);
    if (d > rawMaxSegment) rawMaxSegment = d;
    centerlineLength += d;
  }
  const dense = densifyPolylineXZ(cleaned, opts.maxSeg ?? 60);
  const { left, right } = offsetCenterline(dense, width, opts);
  const { trianglesXZ, triangleCount, maxTriangleArea, maxTriangleEdge } = triangulateRibbon(left, right);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of [...left, ...right]) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
  }
  return {
    ok: true, centerline: dense, left, right, trianglesXZ, triangleCount, maxTriangleArea, maxTriangleEdge,
    bbox: Number.isFinite(minX) ? { minX, maxX, minZ, maxZ } : null,
    centerlineLength, rawMaxSegment,
  };
}

/**
 * [Mission04] densify 済み centerline の各頂点に「滑らかに変化する幅」を割り当てる。
 *  1. profile（[{t,w}]、t は 0..1 の正規化弧長）を弧長で線形補間して各頂点の目標幅を出す
 *  2. 隣接頂点間の幅変化を maxDeltaPer100m で前方・後方の2パスclamp（階段状の急変を除去）
 * @param {number[][]} dense  densifyPolylineXZ 済み
 * @param {{t:number,w:number}[]} profile  少なくとも1点。昇順でなくてもよい（内部でソート）
 * @param {{maxDeltaPer100m?:number}} [opts]
 * @returns {number[]}  length === dense.length
 */
export function buildVertexWidths(dense, profile, opts = {}) {
  const n = dense.length;
  if (n === 0) return [];
  const prof = [...(profile || [])].filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.w) && p.w > 0).sort((a, b) => a.t - b.t);
  if (!prof.length) return new Array(n).fill(0);
  // 弧長パラメータ
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + dist(dense[i - 1], dense[i]));
  const total = cum[n - 1] || 1;
  const widths = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = cum[i] / total;
    if (t <= prof[0].t) { widths[i] = prof[0].w; continue; }
    if (t >= prof[prof.length - 1].t) { widths[i] = prof[prof.length - 1].w; continue; }
    let j = 0;
    while (j < prof.length - 1 && prof[j + 1].t < t) j++;
    const a = prof[j], b = prof[j + 1];
    const f = (b.t - a.t) > 1e-9 ? (t - a.t) / (b.t - a.t) : 0;
    widths[i] = a.w + (b.w - a.w) * f;
  }
  // rate-of-change clamp（前方→後方の2パス。両端の指定幅は保ちつつ中間の急変だけ均す）。
  //   絶対量(maxDeltaPer100m)と比率(maxRatioPer100m)の両方を課す。比率は「幅が100mで N 倍を
  //   超えて変わらない」＝指示書11節の「2〜3倍級の瞬間jump」を構造的に防ぐ。
  const perM = (opts.maxDeltaPer100m ?? 40) / 100;
  const ratioPer100 = opts.maxRatioPer100m ?? 1.3;
  const logRatePerM = Math.log(ratioPer100) / 100;
  const clampStep = (from, to, segLen) => {
    const maxAbs = Math.max(0.01, perM * segLen);
    const maxLog = logRatePerM * segLen;
    let t = Math.max(from - maxAbs, Math.min(from + maxAbs, to));
    const hi = from * Math.exp(maxLog), lo = from * Math.exp(-maxLog);
    return Math.max(lo, Math.min(hi, t));
  };
  for (let i = 1; i < n; i++) widths[i] = clampStep(widths[i - 1], widths[i], cum[i] - cum[i - 1]);
  for (let i = n - 2; i >= 0; i--) widths[i] = clampStep(widths[i + 1], widths[i], cum[i + 1] - cum[i]);
  return widths;
}

/**
 * [Mission04] centerline + 幅プロファイル（両端/複数点）から、幅が滑らかに変化する ribbon を作る。
 * 手順（指示書8節）: raw centerline → clean → densify → width interpolate（頂点単位）→ offset。
 * @param {number[][]} centerlineRaw
 * @param {{t:number,w:number}[]} widthProfile  t=0..1 の正規化弧長。単一点なら一定幅。
 * @param {{maxSeg?:number, maxMiterRatio?:number, maxDeltaPer100m?:number}} [opts]
 */
export function buildRiverRibbonTapered(centerlineRaw, widthProfile, opts = {}) {
  const cleaned = cleanPolylineXZ(centerlineRaw);
  const prof = (widthProfile || []).filter((p) => p && p.w > 0);
  if (cleaned.length < 2 || !prof.length) {
    return { ok: false, reason: cleaned.length < 2 ? 'too-few-points' : 'invalid-width', left: [], right: [], centerline: cleaned, widths: [], triangleCount: 0, maxTriangleArea: 0, maxTriangleEdge: 0, bbox: null, centerlineLength: 0, rawMaxSegment: 0 };
  }
  let rawMaxSegment = 0, centerlineLength = 0;
  for (let i = 0; i < cleaned.length - 1; i++) {
    const d = dist(cleaned[i], cleaned[i + 1]);
    if (d > rawMaxSegment) rawMaxSegment = d;
    centerlineLength += d;
  }
  const dense = densifyPolylineXZ(cleaned, opts.maxSeg ?? 60);
  const widths = buildVertexWidths(dense, prof, opts);
  const { left, right } = offsetCenterline(dense, widths, opts);
  const { trianglesXZ, triangleCount, maxTriangleArea, maxTriangleEdge } = triangulateRibbon(left, right);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of [...left, ...right]) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
  }
  // 幅変化率の統計（100mあたり最大幅差）
  let maxWidthDeltaPer100m = 0;
  for (let i = 1; i < dense.length; i++) {
    const segLen = dist(dense[i - 1], dense[i]);
    if (segLen > 1e-3) maxWidthDeltaPer100m = Math.max(maxWidthDeltaPer100m, Math.abs(widths[i] - widths[i - 1]) / segLen * 100);
  }
  return {
    ok: true, centerline: dense, widths, left, right, trianglesXZ, triangleCount, maxTriangleArea, maxTriangleEdge,
    bbox: Number.isFinite(minX) ? { minX, maxX, minZ, maxZ } : null,
    centerlineLength, rawMaxSegment, maxWidthDeltaPer100m,
  };
}
