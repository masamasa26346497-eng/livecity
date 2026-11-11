// LOD1 / LOD2 共通の建物配色(Mission 207)。LOD1 builder(tools/mission37b-build-3dtiles.cjs)の式をそのまま移したもの。
// h = 建物高さ(m)。戻り値は [0,255] 整数 RGB。
function colorFor(h) {
  const t = Math.min(h / 60, 1);
  return [Math.round(190 - 70 * t), Math.round(200 - 50 * t), Math.round(215 - 20 * t)];
}
const wallFrom = (roof) => roof.map((v) => Math.round(v * 0.78));
/** { roof, wall } どちらも [0,255] 整数 RGB */
function buildingColors(h) { const roof = colorFor(h); return { roof, wall: wallFrom(roof) }; }
module.exports = { colorFor, wallFrom, buildingColors };
