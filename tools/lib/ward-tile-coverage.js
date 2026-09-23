// tools/lib/ward-tile-coverage.js
// P1-6E: Ward の bbox（znorth-neg-v1 world XZ）を覆う tile 座標を列挙する共通ロジック。
//
// 実機で「建物は Ward の一部分だけ、道路等は広範囲」という表示範囲の不整合が出た。
// 原因は建物レイヤー（500m tile・camera 中心 ring 5 = ±2.5km）と都市レイヤー（2000m tile・
// camera 中心 RING 1）が、どちらも「camera 周辺」しか見ておらず、選択した Ward 全域（4〜8km 四方）を
// カバーしていなかったこと。Ward 切替時にこの関数で「区の bbox を覆う tile」を列挙し、
// 建物・都市レイヤー双方が同じ footprint を段階ロードする。
//
// public/osaka_3d_buildings.ward-ux-v1.html の wardTilesForBboxXZ() と同一ロジック（HTML へ inline）。

/**
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} bbox
 * @param {number} tileSize  タイル一辺（m）
 * @param {object} [opts]
 * @param {number} [opts.cap=0]        返す tile 数の上限（0=無制限）。中心に近い順に切る。
 * @param {number} [opts.bufferMeters=0] bbox を外側へ広げる余白（m）
 * @returns {Array<{tx:number,tz:number}>}  中心 → 外 の順（progressive load 用）
 */
export function tilesCoveringBboxXZ(bbox, tileSize, opts = {}) {
  if (!bbox || !Number.isFinite(bbox.minX) || !Number.isFinite(tileSize) || tileSize <= 0) return [];
  const cap = opts.cap || 0;
  const b = opts.bufferMeters || 0;
  const tx0 = Math.floor((bbox.minX - b) / tileSize);
  const tx1 = Math.floor((bbox.maxX + b) / tileSize);
  const tz0 = Math.floor((bbox.minZ - b) / tileSize);
  const tz1 = Math.floor((bbox.maxZ + b) / tileSize);
  const cx = (tx0 + tx1) / 2;
  const cz = (tz0 + tz1) / 2;
  const list = [];
  for (let tz = tz0; tz <= tz1; tz++) {
    for (let tx = tx0; tx <= tx1; tx++) list.push({ tx, tz });
  }
  list.sort((a, c) => (Math.hypot(a.tx - cx, a.tz - cz) - Math.hypot(c.tx - cx, c.tz - cz)));
  return cap > 0 ? list.slice(0, cap) : list;
}

/** bbox の4隅がすべて、返り tile 集合のいずれかに含まれるか（cap を掛けていない前提の網羅確認用）。 */
export function bboxFullyCovered(bbox, tileSize, tiles) {
  const set = new Set(tiles.map((t) => `${t.tx}_${t.tz}`));
  const corners = [
    [bbox.minX, bbox.minZ], [bbox.maxX, bbox.minZ],
    [bbox.minX, bbox.maxZ], [bbox.maxX, bbox.maxZ],
  ];
  return corners.every(([x, z]) => set.has(`${Math.floor(x / tileSize)}_${Math.floor(z / tileSize)}`));
}
