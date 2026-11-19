'use strict';
// [Mission 74] 近景の「建物と道路がずれて見える」切り分け用の純粋モデル（読み取り専用・ネットワークなし）。
// 異なるソースの道路中心線と建物外形が一致すべき、とは仮定しない。ここでは
//   (1) source(local m) -> WGS84 -> ECEF -> tile ENU -> ECEF の往復誤差
//   (2) 高さ h の屋根を、鉛直から offNadir だけ傾いた視線で見たときの「見かけの水平ずれ」= h * tan(offNadir)
// だけを計算する。後者は座標ずれではなく視差。
const B = require('./mission37b-build-3dtiles.cjs');
const PROJ = { clat: 34.604208, clon: 135.525020, mpd: 111320 };
const COS = Math.cos(PROJ.clat * Math.PI / 180);
const toLon = (x) => PROJ.clon + x / (COS * PROJ.mpd);
const toLat = (z) => PROJ.clat - z / PROJ.mpd;
const toLocal = (lon, lat) => ({ x: (lon - PROJ.clon) * COS * PROJ.mpd, z: -(lat - PROJ.clat) * PROJ.mpd });

// 変換器とは独立に書いた WGS84 -> ECEF（Cesium.Cartesian3.fromDegrees と同じ式）。
function ecefIndep(lonDeg, latDeg, h) {
  const a = 6378137, e2 = 0.00669437999014, r = Math.PI / 180, l = lonDeg * r, p = latDeg * r, s = Math.sin(p), c = Math.cos(p);
  const N = a / Math.sqrt(1 - e2 * s * s);
  return [(N + h) * c * Math.cos(l), (N + h) * c * Math.sin(l), (N * (1 - e2) + h) * s];
}
// tile 中心フレームの ENU を経由して ECEF に戻した点と、直接 ECEF 化した点との距離（m）。
function chainError(x, z, h, frameLocal) {
  const f = B.makeFrame(toLon(frameLocal.x), toLat(frameLocal.z));
  const enu = B.toEnu(f, toLon(x), toLat(z), h);
  const p = [0, 1, 2].map((i) => f.t[i] + f.b.e[i] * enu[0] + f.b.n[i] * enu[1] + f.b.u[i] * enu[2]);
  const direct = ecefIndep(toLon(x), toLat(z), h);
  return Math.hypot(p[0] - direct[0], p[1] - direct[1], p[2] - direct[2]);
}
function parallaxShift(roofHeightM, offNadirDeg) { return roofHeightM * Math.tan(offNadirDeg * Math.PI / 180); }
module.exports = { PROJ, toLon, toLat, toLocal, chainError, parallaxShift };
