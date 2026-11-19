'use strict';
// Mission 45O: 元建物 footprint と元道路中心線の「幾何的な重なり」による平行移動の有無の検査（純関数。読み取り専用）。
// 原理: 道路中心線は通常 建物の内側を通らない。道路を (dx,dz) だけ動かしたとき、道路上のサンプル点が footprint 内に入る割合が
// 最小になる位置が真の相対位置。ゼロが最小（付近）なら建物と道路は相対的にずれていない。
// 最近傍距離の中央値や角度の当て推量（45J yaw）とは違い、「道路が建物を貫く」という観測可能な矛盾だけを数える。
// 注意: 橋・トンネル・建物の下を通る道路（高架下など）は少数ある。ゼロ付近の絶対値ではなくオフセット間の比較で判断する。
const CELL = 50;
const key = (i, j) => i + '_' + j;

function buildIndex(polys) {
  const grid = new Map();
  let count = 0;
  polys.forEach((ring) => {
    if (!ring || ring.length < 3) return;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    const it = { ring, x0, x1, z0, z1 };
    count++;
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
      for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(it);
      }
    }
  });
  return { grid, count };
}
function pip(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function inside(idx, x, z) {
  const c = idx.grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!c) return false;
  for (const it of c) if (x >= it.x0 && x <= it.x1 && z >= it.z0 && z <= it.z1 && pip(it.ring, x, z)) return true;
  return false;
}
/** 道路線を step(m) 間隔でサンプルした点列（[x,z]）。 */
function sampleLines(lines, step) {
  const out = [];
  for (const p of lines) {
    for (let i = 0; i + 1 < p.length; i++) {
      const L = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
      const n = Math.max(1, Math.ceil(L / step));
      for (let k = 0; k < n; k++) out.push([p[i][0] + (p[i + 1][0] - p[i][0]) * k / n, p[i][1] + (p[i + 1][1] - p[i][1]) * k / n]);
    }
  }
  return out;
}
function fractionInside(idx, pts, dx, dz) {
  if (!pts.length) return null;
  let n = 0;
  for (const [x, z] of pts) if (inside(idx, x + dx, z + dz)) n++;
  return n / pts.length;
}
/** オフセット格子 [-radius..radius] を走査。dx: 東+, dz: 南+（Live City ローカル座標。z は南が正）。 */
function scan(polys, lines, opt) {
  const radius = (opt && opt.radius) || 15, stepOff = (opt && opt.offsetStep) || 2.5, stepPt = (opt && opt.sampleStep) || 5;
  const idx = buildIndex(polys), pts = sampleLines(lines, stepPt);
  const grid = [];
  let best = null, zero = null;
  const n = Math.round(radius / stepOff);
  for (let a = -n; a <= n; a++) {
    for (let b = -n; b <= n; b++) {
      const dx = a * stepOff, dz = b * stepOff;
      const f = fractionInside(idx, pts, dx, dz);
      const row = { dx, dz, f };
      grid.push(row);
      if (a === 0 && b === 0) zero = f;
      if (f === null) continue;
      if (best === null || f < best.f - 1e-12 || (Math.abs(f - best.f) <= 1e-12 && Math.hypot(dx, dz) < Math.hypot(best.dx, best.dz))) best = row;
    }
  }
  return { buildings: idx.count, samples: pts.length, zero, best, grid };
}
/** 判定。範囲を分割した結果が同じ向きを示すときだけ「一貫した移動候補」。適用はしない。 */
function verdict(whole, parts, opt) {
  if (!whole.samples || !whole.buildings) return { verdict: 'no-data' };
  const gain = whole.zero > 0 ? (whole.zero - whole.best.f) / whole.zero : 0;
  const mag = Math.hypot(whole.best.dx, whole.best.dz);
  const g = Math.round(gain * 1000) / 1000;
  if (mag === 0 || gain < 0.15) {
    // 45P: 旧名 'aligned-at-zero' は「ずれ無し」と読めるため改名。意味は「探索半径内に、重なりを 15% 以上減らす平行移動が無い」だけ。
    //   ゼロ位置での重なりが大きいときは、橋・高架・時期差・中心線/ポリゴン品質など平行移動以外の理由が残る。位置ずれ無しの証明ではない。
    const zf = Math.round((whole.zero || 0) * 10000) / 10000;
    return {
      verdict: 'no-consistent-translation-detected' + (opt && opt.radius ? '-within-' + opt.radius + 'm' : ''), legacyVerdict: 'aligned-at-zero',
      relativeGainAtBest: g, zeroIsMinimum: mag === 0, zeroOffsetFraction: zf,
      note: 'No translation in the searched radius reduces road-through-building overlap by >=15%. This does NOT prove the layers are aligned: zero-offset overlap is ' + (zf * 100).toFixed(1) + '% (bridges, elevated roads, data vintage, centerline/polygon quality can cause it). Rotation, scale and non-uniform error are not tested.'
    };
  }
  const usable = (parts || []).filter((p) => p.samples > 200 && p.best);
  const same = usable.filter((p) => Math.hypot(p.best.dx - whole.best.dx, p.best.dz - whole.best.dz) <= 3.75);
  if (usable.length >= 2 && same.length === usable.length) {
    return { verdict: 'consistent-shift-candidate', best: { dx: whole.best.dx, dz: whole.best.dz }, relativeGainAtBest: g, note: 'candidate only. NOT applied. Must be corroborated on the 2D diagnostic page with real features before any source fix.' };
  }
  return { verdict: 'inconclusive', relativeGainAtBest: g, note: 'best offset is not consistent across sub-areas; do not treat as a true translation' };
}
module.exports = { buildIndex, inside, sampleLines, fractionInside, scan, verdict };
