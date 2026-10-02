// tools/lib/park-lod.js
// [見た目改善 Mission12] 公園・緑地の距離LOD（純粋ロジック・THREE 非依存）。
//   面積で LARGE / MEDIUM / SMALL の3段階に分類し、道路LOD（tools/lib/road-lod.js）と同じ
//   FAR(>9000m) / MID(3500-9000m) / NEAR(<=3500m) band で表示を絞る:
//     FAR  = LARGE only          （大阪城公園・鶴見緑地・長居公園 等が都市骨格として残る）
//     MID  = LARGE + MEDIUM
//     NEAR = ALL                 （街区公園も地図として読める）
//   canonical。public/osaka_3d_buildings.ward-ux-v1.html の CityTileLayer / ParkLayer へ同じ計算を inline する。
//
// 実データ監査（public/map-data/osaka-city/parks、2685 area feature / 総 10.69 km²）:
//   >=100,000 m²        : 13  （LARGE）
//   10,000–100,000 m²   : 120 （MEDIUM）
//   <10,000 m²          : 2552（SMALL。うち <2,000 m² が 2063 = 遠景の点状ノイズ源）

export const PARK_AREA_LARGE_M2 = 100000;  // >= 10ha → LARGE
export const PARK_AREA_MEDIUM_M2 = 10000;  // 1ha–10ha → MEDIUM（未満は SMALL）

/** 面積(m²) → 'large' | 'medium' | 'small'。非有限・非正は 'small' 扱い（描画は NEAR のみ）。 */
export function classifyParkArea(areaM2) {
  if (!Number.isFinite(areaM2) || areaM2 <= 0) return 'small';
  if (areaM2 >= PARK_AREA_LARGE_M2) return 'large';
  if (areaM2 >= PARK_AREA_MEDIUM_M2) return 'medium';
  return 'small';
}

export const PARK_LOD_BANDS = { farM: 9000, midM: 3500 }; // 道路LODと一致

/** カメラ距離 → 'far' | 'mid' | 'near'。 */
export function parkLodBand(distance) {
  const d = Number.isFinite(distance) ? distance : 0;
  if (d > PARK_LOD_BANDS.farM) return 'far';
  if (d > PARK_LOD_BANDS.midM) return 'mid';
  return 'near';
}

/** その面積クラスが与えられた距離で見えるか。large=常時 / medium=far以外 / small=nearのみ。 */
export function parkClassVisible(cls, distance) {
  const band = parkLodBand(distance);
  if (cls === 'large') return true;
  if (cls === 'medium') return band !== 'far';
  return band === 'near';
}

// 距離バンド別 opacity。公園は建物・道路より主張しない。LARGE は遠景でも薄すぎて消えない下限を確保。
export const PARK_TIER_OPACITY = {
  large:  { near: 0.80, mid: 0.62, far: 0.46 },
  medium: { near: 0.78, mid: 0.58, far: 0.58 }, // medium は far で非表示のため far 値は未使用
  small:  { near: 0.75, mid: 0.75, far: 0.75 }, // small は near のみ表示
};

export function parkTierOpacity(cls, distance) {
  return (PARK_TIER_OPACITY[cls] || PARK_TIER_OPACITY.small)[parkLodBand(distance)];
}

/** XZ リング（[[x,z],...]）の符号なし面積（shoelace）。 */
export function ringAreaXZ(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

/** 外周 - 穴 の実面積。 */
export function polygonAreaWithHoles(outer, holes) {
  let a = ringAreaXZ(outer);
  if (Array.isArray(holes)) for (const h of holes) a -= ringAreaXZ(h);
  return Math.max(0, a);
}

/** feature 配列を面積クラスで集計する。feature は {p:[[x,z]...], holes?} 形式。 */
export function countByParkClass(features) {
  const out = { large: 0, medium: 0, small: 0, invalid: 0, total: 0 };
  for (const f of features || []) {
    out.total++;
    if (!f || !Array.isArray(f.p) || f.p.length < 3) { out.invalid++; out.small++; continue; }
    const a = polygonAreaWithHoles(f.p, f.holes);
    out[classifyParkArea(a)]++;
  }
  return out;
}
