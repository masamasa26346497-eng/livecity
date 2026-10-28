/* Mission 45Y: 建物の「地上輪郭」診断オーバーレイの純ロジック（DOM / Cesium 非依存。Node でテスト可能）。
 * 座標は Live City 局所座標（x=東, z=南が正, m）。ビューア側が ?gfp=1（localhost 限定）のときだけ使う診断用で、元データ・建物 GLB は変更しない。 */
(function (root) {
  'use strict';
  const TILE = 500;
  /** 中心 (cx,cz) から半径 r(m) に触れる旧建物タイルの (tx,tz)。tile_<tx>_<tz> = floor(x/500), floor(z/500)。 */
  function tilesNear(cx, cz, r, tile) {
    tile = tile || TILE;
    const out = [];
    for (let tx = Math.floor((cx - r) / tile); tx <= Math.floor((cx + r) / tile); tx++) {
      for (let tz = Math.floor((cz - r) / tile); tz <= Math.floor((cz + r) / tile); tz++) out.push([tx, tz]);
    }
    return out;
  }
  const tileName = (tx, tz) => 'tile_' + tx + '_' + tz + '.json';
  /** 建物配列 → 閉じた輪郭の配列（頂点 >=3 のみ。始点を末尾に複製して閉じる）。 */
  function loops(buildings, maxLoops) {
    const out = [];
    for (const b of buildings || []) {
      if (!Array.isArray(b.fp) || b.fp.length < 3) continue;
      const ring = b.fp.map((p) => [p[0], p[1]]);
      const a = ring[0], z = ring[ring.length - 1];
      if (a[0] !== z[0] || a[1] !== z[1]) ring.push([a[0], a[1]]);
      out.push({ id: b.id, ring });
      if (maxLoops && out.length >= maxLoops) break;
    }
    return out;
  }
  function pip(ring, x, z) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if ((ring[i][1] > z) !== (ring[j][1] > z) && x < ((ring[j][0] - ring[i][0]) * (z - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]) c = !c;
    }
    return c;
  }
  /** 道路中心線を step(m) でサンプルし、footprint 内に入る点の割合（貫通の指標。橋・高架下は少数含まれる）。 */
  function roadInsideFraction(roadLines, rings, step) {
    step = step || 5;
    let n = 0, k = 0;
    const bb = rings.map((r) => {
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (const p of r) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1]; }
      return [a, b, c, d];
    });
    for (const l of roadLines) {
      for (let i = 0; i + 1 < l.length; i++) {
        const L = Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]), m = Math.max(1, Math.ceil(L / step));
        for (let s = 0; s < m; s++) {
          const x = l[i][0] + (l[i + 1][0] - l[i][0]) * s / m, z = l[i][1] + (l[i + 1][1] - l[i][1]) * s / m;
          n++;
          for (let q = 0; q < rings.length; q++) {
            const b = bb[q];
            if (x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3] && pip(rings[q], x, z)) { k++; break; }
          }
        }
      }
    }
    return { samples: n, inside: k, fraction: n ? k / n : null };
  }
  const api = { TILE, tilesNear, tileName, loops, roadInsideFraction, pip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LC45Y = api;
})(typeof window !== 'undefined' ? window : globalThis);
