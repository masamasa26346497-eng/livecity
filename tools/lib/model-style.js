// tools/lib/model-style.js
// P1-6H: 「クリアで綺麗な都市模型」表現のためのパレット/不透明度ヘルパ（純粋・THREE 非依存）。
//   canonical。public/osaka_3d_buildings.ward-ux-v1.html に同じ計算を inline する。
//
// 方針（参照: 白い建物・淡い水色の川・整然とした道路の都市模型ビュー）:
//   - 建物: 用途色（クリスタル系の鮮やかなパレット）を暖色オフホワイトへ強く寄せ、マット化。
//   - 河川: 淡いシアン、距離で滑らかに減衰する低 opacity（帯・板に見せない）。
//   - 道路: 明るいグレーへ。地面: 中立の明るい色。

/** 0xRRGGBB を分解 */
export function hexToRgb(hex) {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}
export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

/** hex を target へ t（0..1）だけ線形補間する。 */
export function blendHexToward(hex, target, t) {
  const a = hexToRgb(hex), b = hexToRgb(target);
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k);
}

// 建物の模型色: 暖色オフホワイト。用途ごとの色相はごく僅かだけ残す（見分けは弱く）。
export const MODEL_BUILDING_WHITE = 0xeef0ec;
// [Mission09] 屋根は壁よりごく僅かに明るい白（roof/wall の立体差）。
export const MODEL_ROOF_WHITE = 0xf6f7f3;

/**
 * 用途色 → 模型用の白寄り色（壁）。[Mission07] 既定 amount=0.92（=元色は 8% だけ残る）。
 *   通常表示では住宅/事務所/工場等の差はほぼ分からず、ごく僅かな色温度差のみ残る。
 * @param {number} usageHex
 * @param {number} [amount=0.92]
 */
export function modelBuildingColor(usageHex, amount = 0.92) {
  return blendHexToward(usageHex, MODEL_BUILDING_WHITE, amount);
}

/**
 * 用途色 → 模型用の白寄り色（屋根）。壁よりごく僅かに明るい白へ寄せる。[Mission07] 既定 amount=0.93。
 * @param {number} usageHex
 * @param {number} [amount=0.93]
 */
export function modelRoofColor(usageHex, amount = 0.93) {
  return blendHexToward(usageHex, MODEL_ROOF_WHITE, amount);
}

// 河川フィルの淡い色（family 別）。
export const MODEL_WATER_COLOR = {
  linear: 0xbcdce6,   // 淡いシアン（河川・運河）
  basin: 0xb2d6e2,    // 池・湖（ほんの少し濃い）
  harbour: 0x9fc4d2,  // 港湾（背景寄り）
};

/**
 * 距離に応じた河川フィル opacity（滑らかに減衰。帯・板を作らない）。
 * @param {object} p
 * @param {number} p.distance
 * @param {'linear'|'basin'|'harbour'} [p.family='linear']
 * @param {boolean} [p.giant=false]
 * @param {'legacy'|'shoreline'|'lod'} [p.mode='lod']
 * @returns {number} 0..~0.34
 */
export function modelWaterFillOpacity(p = {}) {
  const mode = p.mode || 'lod';
  if (mode === 'legacy') return p.family === 'harbour' ? 0 : 0.5;
  if (mode === 'shoreline') return 0;
  const d = Number.isFinite(p.distance) ? p.distance : 4000;
  const fam = p.family || 'linear';

  if (fam === 'harbour') return d > 9000 ? 0 : lerpClamp(d, 2000, 9000, 0.10, 0.04);
  if (fam === 'basin') return lerpClamp(d, 1500, 9000, 0.34, 0.14); // 池湖は距離があっても残す

  // linear（河川）: 近で 0.28、遠でゼロへ。giant はより早く薄く。
  if (p.giant) return lerpClamp(d, 1800, 5200, 0.20, 0.0);
  return lerpClamp(d, 2200, 6200, 0.30, 0.0);
}

/** 岸線 opacity（模型では控えめ。近景でうっすら、遠景でやや見える程度）。 */
export function modelShorelineOpacity(p = {}) {
  const mode = p.mode || 'lod';
  if (mode === 'legacy') return 0;
  const d = Number.isFinite(p.distance) ? p.distance : 4000;
  if (mode === 'shoreline') return lerpClamp(d, 1000, 8000, 0.5, 0.75);
  // lod: 近では fill があるので岸線は薄め、遠では fill が消えるので岸線をやや強める（形状維持）。
  return lerpClamp(d, 2500, 7000, 0.22, 0.5);
}

function lerpClamp(x, x0, x1, y0, y1) {
  if (x1 === x0) return y0;
  const t = Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
  return y0 + (y1 - y0) * t;
}

// 道路（模型: 明るいグレー）。RoadLayer.colorReal / CityTileLayer roads を寄せる先。
export const MODEL_ROAD_COLOR = {
  motorway: 0xc7ccd2, trunk: 0xc9ced3, primary: 0xccd0d5,
  secondary: 0xd0d3d7, tertiary: 0xd3d6da, residential: 0xd8dade, _default: 0xd6d8dc,
};
export const MODEL_GROUND_COLOR = 0xdcdcd6;   // 模型台座（中立のやや暖かい明るいグレー）
export const MODEL_SKY_COLOR = 0xc4ccd2;      // 背景（落ち着いた明るいブルーグレー）
