// [Mission 60] GSI(WebMercator XYZ)タイルを Cesium 既定(Geographic)で解釈した場合に、同じ z/x/y が覆う位置の差を計算する。
// 純計算・通信なし。 node tools/mission60-tilingscheme-math.cjs
const pts = [['hanwa', 34.6044, 135.5051], ['taisha', 34.6114, 135.4930], ['park-ne', 34.6050, 135.4990], ['north', 34.6090, 135.5020]];
const D = Math.PI / 180, MPD = 111320, out = [];
for (const z of [14, 16, 17]) for (const [n, lat, lon] of pts) {
  const N = 2 ** z;
  const tx = Math.floor((lon + 180) / 360 * N);
  const ty = Math.floor((1 - Math.log(Math.tan(lat * D) + 1 / Math.cos(lat * D)) / Math.PI) / 2 * N);
  const lonW = tx / N * 360 - 180, lonE = (tx + 1) / N * 360 - 180;
  const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / N))) / D, latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / N))) / D;
  const gW = -180 + tx * (360 / (2 * N)), gE = gW + 360 / (2 * N), gN = 90 - ty * (180 / N), gS = gN - 180 / N;
  const cE = ((lonW + lonE) / 2 - (gW + gE) / 2) * Math.cos(lat * D) * MPD / 1000, cN = ((latN + latS) / 2 - (gN + gS) / 2) * MPD / 1000;
  out.push({ z, n, tile: tx + '/' + ty, trueCentre: [(lonW + lonE) / 2, (latN + latS) / 2].map((v) => +v.toFixed(4)), geoInterpCentre: [(gW + gE) / 2, (gN + gS) / 2].map((v) => +v.toFixed(3)), offsetKm: { east: Math.round(cE), north: Math.round(cN) }, trueTileWidthM: Math.round((lonE - lonW) * Math.cos(lat * D) * MPD), geoTileWidthM: Math.round((gE - gW) * Math.cos(lat * D) * MPD) });
}
console.log(JSON.stringify(out));
