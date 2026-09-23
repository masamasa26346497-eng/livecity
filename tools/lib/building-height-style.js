// tools/lib/building-height-style.js
// [見た目改善 Mission10] 高層建物の高さ表現強化（純粋ロジック）。
// ══════════════════════════════════════════════════════════════════════════════════
// 目的: 実高さデータ（dz / height / z0）を一切書き換えず、視覚表現（頂点カラーの明度係数）
//       だけで「梅田・中之島・難波・天王寺のスカイライン構造」が白い都市模型のまま自然に
//       読み取れるようにする。
//
// 原則:
//   - geometry の実高度は変更しない（このモジュールは高さを分類し、明度係数を返すだけ）。
//   - カラフルにしない。高さ階級で色相を変えない（明度のごく僅かな上下のみ）。
//   - 新しい material / mesh / draw call を生まない（呼び出し側は既存の vertexColors 配列に
//     この係数を掛けるだけ）。
//   - 異常データ（dz=29997 等の外れ値）は very_tall に飽和させ、効果を一定に保つ。
//
// 実データ分布（osaka-city 24区 574,112棟, dz）:
//   median 7.2 / p90 12.5 / p95 18.1 / p99 39.5 / >=30m:15708 / >=60m:599 / >=100m:202 / >=150m:59
//   → 下記しきい値で LOW が約 92%（現状の白基調を維持）、HIGH 以上は 1% 未満。
// ══════════════════════════════════════════════════════════════════════════════════

export const HEIGHT_THRESHOLDS = Object.freeze({
  MID: 15,          // LOW  < 15m
  HIGH: 40,         // MID  15–40m
  SKYSCRAPER: 100,  // HIGH 40–100m
  VERY_TALL: 150,   // SKYSCRAPER 100–150m / VERY_TALL >= 150m
});

export const HEIGHT_CLASSES = Object.freeze(['low', 'mid', 'high', 'skyscraper', 'very_tall']);

/**
 * 高さ h[m] を階級へ分類する。NaN / 欠損 / 非正 は 'low'（＝表現に一切手を加えない安全側）。
 * @param {number} h
 * @returns {'low'|'mid'|'high'|'skyscraper'|'very_tall'}
 */
export function classifyBuildingHeight(h) {
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return 'low';
  const T = HEIGHT_THRESHOLDS;
  if (h < T.MID) return 'low';
  if (h < T.HIGH) return 'mid';
  if (h < T.SKYSCRAPER) return 'high';
  if (h < T.VERY_TALL) return 'skyscraper';
  return 'very_tall';
}

// 階級ごとの明度係数（既存の shade 係数に「掛ける」倍率）。
//   bottomMul: 壁下端（接地側）をさらにわずかに暗く → 垂直コントラスト
//   topMul   : 壁上端をわずかに明るく
//   roofMul  : 屋根をわずかに明るく
//   edgeMul  : Mission08 のエッジ opacity 倍率（現状 HTML では未配線。将来用・debug 表示用）
// low / mid は全て 1.0（＝現状表現を厳密に維持。全建物の 9 割以上がここ）。
const STYLE_BY_CLASS = Object.freeze({
  low:        Object.freeze({ bottomMul: 1.000, topMul: 1.000, roofMul: 1.000, edgeMul: 1.00 }),
  mid:        Object.freeze({ bottomMul: 1.000, topMul: 1.000, roofMul: 1.000, edgeMul: 1.00 }),
  high:       Object.freeze({ bottomMul: 0.985, topMul: 1.010, roofMul: 1.015, edgeMul: 1.00 }),
  skyscraper: Object.freeze({ bottomMul: 0.955, topMul: 1.030, roofMul: 1.045, edgeMul: 1.20 }),
  very_tall:  Object.freeze({ bottomMul: 0.940, topMul: 1.040, roofMul: 1.055, edgeMul: 1.30 }),
});

// 最終 shade 値の許容範囲（真っ黒・白飛びを避ける安全クランプ）。
export const SHADE_FLOOR = 0.70;
export const SHADE_CEIL = 1.09;

export function clampShade(v) {
  if (!Number.isFinite(v)) return 1.0;
  return Math.max(SHADE_FLOOR, Math.min(SHADE_CEIL, v));
}

/**
 * 高さ h と描画系 mode に応じた明度係数セットを返す。
 * @param {number} h  建物高さ[m]（b.dz 相当）
 * @param {'detail'|'cityLOD'} [mode]  detail=近景の実体建物壁 / cityLOD=遠景の軽量merged
 * @returns {{class:string, bottomMul:number, topMul:number, roofMul:number, edgeMul:number}}
 */
export function getHeightStyle(h, mode = 'detail') {
  const cls = classifyBuildingHeight(h);
  const s = STYLE_BY_CLASS[cls];
  // cityLOD は遠景で密集して見えるため、垂直コントラストを detail の 7 割程度に抑える
  //   （近景ほど陰影を効かせ、遠景ではベタッと潰れないが騒がしくもしない）。
  const k = mode === 'cityLOD' ? 0.7 : 1.0;
  const lerp1 = (mul) => 1 + (mul - 1) * k;
  return {
    class: cls,
    bottomMul: lerp1(s.bottomMul),
    topMul: lerp1(s.topMul),
    roofMul: lerp1(s.roofMul),
    edgeMul: 1 + (s.edgeMul - 1) * (mode === 'cityLOD' ? 0 : 1), // cityLOD はエッジ無し
  };
}

/**
 * 高さ分布のヒストグラム集計（validator / debug 用）。
 * @param {number[]} heights
 */
export function summarizeHeights(heights) {
  const valid = heights.filter((h) => typeof h === 'number' && Number.isFinite(h) && h > 0).sort((a, b) => a - b);
  const n = valid.length;
  const q = (p) => (n ? valid[Math.min(n - 1, Math.floor(p * n))] : 0);
  const ge = (v) => valid.filter((h) => h >= v).length;
  const byClass = { low: 0, mid: 0, high: 0, skyscraper: 0, very_tall: 0 };
  for (const h of valid) byClass[classifyBuildingHeight(h)]++;
  return {
    total: heights.length,
    valid: n,
    min: n ? +valid[0].toFixed(2) : 0,
    p25: +q(0.25).toFixed(2), median: +q(0.5).toFixed(2), p75: +q(0.75).toFixed(2),
    p90: +q(0.90).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2),
    max: n ? +valid[n - 1].toFixed(2) : 0,
    ge30: ge(30), ge60: ge(60), ge100: ge(100), ge150: ge(150), ge200: ge(200),
    byClass,
    thresholds: HEIGHT_THRESHOLDS,
  };
}
