'use strict';
// Mission 45J: 座標規約の「検証」ライブラリ（読み取り専用・ネットワークなし）。
// 旧 OSM タイルの manifest が宣言する規約（znorth-neg-v1）を鵜呑みにせず、(1) manifest の形、(2) N03 区ポリゴンとの突き合わせ（独立した基準）、
// (3) 建物代表点との最近傍距離から見た回転（yaw）を数値で出す。4 クラスタ以上で一致しない限り角度は断定しない。
const V = (() => { const m = require('../../public/mission45i-vec.js'); return m && m.makeInsideTester ? m : globalThis.LC45I; })();   // package.json が type:module のため .js は ESM 扱い → globalThis.LC45I

const EXPECT = { convention: 'znorth-neg-v1', system: 'meters-local' };
// 大阪市域は原点から ±40km 程度。これを大きく超える値は単位 (km / deg) 違いや原点違いの疑い。
const SANE_ABS_M = 60000;

/** manifest の宣言を検証する。投影原点は manifest に記録されないため「記録なし」を証拠に残す（N03 突合で間接確認）。 */
function validateSourceManifest(m) {
  const problems = [], notes = [];
  if (!m || typeof m !== 'object') return { ok: false, problems: ['manifest missing or not an object'], notes, declared: null };
  if (m.coordinateConvention !== EXPECT.convention) problems.push('coordinateConvention is ' + JSON.stringify(m.coordinateConvention) + ', expected ' + EXPECT.convention);
  if (m.coordinateSystem !== EXPECT.system) problems.push('coordinateSystem is ' + JSON.stringify(m.coordinateSystem) + ', expected ' + EXPECT.system);
  const b = m.bboxLocal;
  if (!b || !['minX', 'maxX', 'minZ', 'maxZ'].every((k) => Number.isFinite(b[k]))) problems.push('bboxLocal missing / not finite');
  else {
    if (b.minX >= b.maxX || b.minZ >= b.maxZ) problems.push('bboxLocal is empty or inverted');
    if ([b.minX, b.maxX, b.minZ, b.maxZ].some((v) => Math.abs(v) > SANE_ABS_M)) problems.push('bboxLocal exceeds +-' + SANE_ABS_M + ' m (unit / origin suspect)');
  }
  if (m.layerBounds && b) {
    const lb = m.layerBounds, slack = (m.tileSize || 2000) + (m.buffer || 0);
    if (lb.minX < b.minX - slack || lb.maxX > b.maxX + slack || lb.minZ < b.minZ - slack || lb.maxZ > b.maxZ + slack) problems.push('layerBounds lies outside bboxLocal');
  }
  if (!m.projection && !m.projectionOrigin) notes.push('projection origin / metersPerDegree are not recorded in the manifest; checked indirectly against the N03 ward polygon');
  return { ok: problems.length === 0, problems, notes, declared: { coordinateConvention: m.coordinateConvention || null, coordinateSystem: m.coordinateSystem || null, tileSize: m.tileSize || null } };
}

// x,z の取り違え・符号違い（8 通りの二面体変換）
const TRANSFORMS = {
  identity: (x, z) => [x, z],
  flipZ: (x, z) => [x, -z],
  flipX: (x, z) => [-x, z],
  rot180: (x, z) => [-x, -z],
  swap: (x, z) => [z, x],
  swapFlipX: (x, z) => [-z, x],
  swapFlipZ: (x, z) => [z, -x],
  swapRot180: (x, z) => [-z, -x],
};

/** points: [[x,z]...]（区の bbox を覆う旧タイルから取った道路頂点）。N03 ポリゴン内に入る割合を、8 通りの変換で比べる。 */
function probeConvention(points, wardPolys) {
  const inside = V.makeInsideTester(wardPolys, 64);
  const frac = {};
  for (const [name, fn] of Object.entries(TRANSFORMS)) {
    let n = 0; for (const p of points) { const q = fn(p[0], p[1]); if (inside(q[0], q[1])) n++; }
    frac[name] = points.length ? Math.round((n / points.length) * 1000) / 1000 : null;
  }
  const alt = Math.max(...Object.entries(frac).filter(([k]) => k !== 'identity').map(([, v]) => v || 0));
  const id = frac.identity || 0;
  const verdict = !points.length ? 'no-points' : id >= 0.15 && id >= alt + 0.1 ? 'identity-confirmed' : id < 0.02 && alt > 0.15 ? 'alternative-fits-better' : 'inconclusive';
  return { sampled: points.length, insideFraction: frac, verdict };
}

/** 道路線を DENSE m 間隔の点列にして格子ハッシュへ。 */
function roadIndex(lines, cell) {
  cell = cell || 50;
  const map = new Map(), key = (cx, cz) => cx * 1000003 + cz;
  const add = (x, z) => { const k = key(Math.floor(x / cell), Math.floor(z / cell)); (map.get(k) || map.set(k, []).get(k)).push([x, z]); };
  for (const p of lines) {
    for (let i = 0; i + 1 < p.length; i++) {
      const L = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]), n = Math.max(1, Math.ceil(L / 10));
      for (let k = 0; k < n; k++) add(p[i][0] + (p[i + 1][0] - p[i][0]) * k / n, p[i][1] + (p[i + 1][1] - p[i][1]) * k / n);
    }
    if (p.length) add(p[p.length - 1][0], p[p.length - 1][1]);
  }
  return function nearest(x, z, max) {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell), r = Math.ceil(max / cell);
    let best = Infinity;
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      const arr = map.get(key(cx + a, cz + b)); if (!arr) continue;
      for (const q of arr) { const d = Math.hypot(q[0] - x, q[1] - z); if (d < best) best = d; }
    }
    return best;
  };
}
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

/**
 * roadLines: [[x,z]...][]、bpts: 建物代表点。建物点を原点まわりに θ 回転させ、最近の道路までの距離の中央値を比べる。
 * 1 km 角のクラスタごとに最良 θ を出し、4 クラスタ以上で ±0.1° 以内に揃い、θ=0 より 15% 以上改善する場合のみ「検出」とする。
 * 道路が建物の近くにあるのは都市では普通なので、これは「証拠」であって断定ではない。
 */
function yawScan(roadLines, bpts, opt) {
  opt = opt || {};
  const angles = opt.angles || []; if (!angles.length) for (let a = -3; a <= 3.0001; a += 0.25) angles.push(Math.round(a * 100) / 100);
  const nearest = roadIndex(roadLines, 50);
  const clusters = new Map();
  for (const p of bpts) { const k = Math.floor(p[0] / 1000) + '_' + Math.floor(p[1] / 1000); (clusters.get(k) || clusters.set(k, []).get(k)).push(p); }
  const usable = [...clusters.values()].filter((c) => c.length >= (opt.minPerCluster || 30));
  const per = usable.map((pts) => {
    const sample = pts.length > 300 ? pts.filter((_, i) => i % Math.ceil(pts.length / 300) === 0) : pts;
    const sc = angles.map((deg) => {
      const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
      return { deg, med: median(sample.map((p) => nearest(p[0] * c - p[1] * s, p[0] * s + p[1] * c, 200)).filter((d) => Number.isFinite(d))) };
    }).filter((x) => x.med != null);
    const best = sc.reduce((a, b) => (b.med < a.med ? b : a), sc[0]);
    const zero = sc.find((x) => x.deg === 0) || sc[0];
    return { n: pts.length, bestDeg: best.deg, bestMed: best.med, zeroMed: zero.med };
  }).filter(Boolean);
  const degs = per.map((c) => c.bestDeg);
  const agree = degs.length >= 4 && Math.max(...degs) - Math.min(...degs) <= 0.1 + 1e-9;
  const impr = per.length ? per.reduce((a, c) => a + (c.zeroMed - c.bestMed) / (c.zeroMed || 1), 0) / per.length : 0;
  const detected = agree && Math.abs(degs[0]) > 0.1 && impr > 0.15;
  return { clusters: per.length, perCluster: per, rotationDetected: detected, estimatedDeg: detected ? degs[0] : null,
    conclusion: per.length < 4 ? 'inconclusive: fewer than 4 independent clusters; yaw is NOT asserted' : detected ? 'consistent rotation across clusters' : 'no consistent rotation (best angle varies or ~0 across clusters)' };
}

module.exports = { validateSourceManifest, probeConvention, yawScan, roadIndex, TRANSFORMS, EXPECT, SANE_ABS_M };
