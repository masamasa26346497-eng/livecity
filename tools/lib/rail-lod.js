// tools/lib/rail-lod.js
// [見た目改善 Mission13] 鉄道の距離LOD（純粋ロジック・THREE 非依存）。
//   鉄道を「道路と似た灰色の線」から、独立した交通レイヤーとして整理する。
//   OSM tag（railway= のみ。実データに name/operator/usage/service/bridge は無い）+ 線分長で
//   MAJOR / URBAN / LOCAL の3クラスへ汎用分類し、道路・公園LODと同じ FAR/MID/NEAR band で絞る:
//     FAR  (>9000m)     = MAJOR only
//     MID  (3500-9000m) = MAJOR + URBAN
//     NEAR (<=3500m)    = ALL
//
// 実データ監査（public/map-data/osaka-city/railways）:
//   line feature 2828（rail 2349 / subway 414 / light_rail 65）、station node 233（全件 name 付き）。
//   rail の線分長: median 102m / <60m が 900 本弱（渡り線・側線・ヤード）→ LOCAL(近景のみ)へ。
export const RAIL_MAJOR_MIN_LEN_M = 60; // これ未満の rail way は本線でなく側線扱い（LOCAL）

/**
 * railway tag と way の総延長(m) から 'major' | 'urban' | 'local' を返す。
 *   subway → urban（地下鉄）/ light_rail → local（新交通・路面系）/
 *   rail → 長さ >= RAIL_MAJOR_MIN_LEN_M なら major（JR・大手私鉄の本線骨格）、未満は local（側線）。
 */
export function classifyRail(railway, lengthM) {
  const r = String(railway || '').toLowerCase();
  if (r === 'subway' || r === 'metro') return 'urban';
  if (r === 'light_rail' || r === 'tram' || r === 'monorail') return 'local';
  if (r === 'rail' || r === 'narrow_gauge') {
    return (Number.isFinite(lengthM) && lengthM >= RAIL_MAJOR_MIN_LEN_M) ? 'major' : 'local';
  }
  return 'local';
}

// 現役旅客交通のみ canonical 表示。工事中・廃線はデバッグのみ（実データには存在しないが将来のため）。
export const RAIL_EXCLUDED_TAGS = new Set(['construction', 'proposed', 'disused', 'abandoned', 'razed', 'dismantled']);
export function railIncluded(railway) {
  return !RAIL_EXCLUDED_TAGS.has(String(railway || '').toLowerCase());
}

export const RAIL_LOD_BANDS = { farM: 9000, midM: 3500 }; // 道路・公園LODと一致

export function railLodBand(distance) {
  const d = Number.isFinite(distance) ? distance : 0;
  if (d > RAIL_LOD_BANDS.farM) return 'far';
  if (d > RAIL_LOD_BANDS.midM) return 'mid';
  return 'near';
}

/** そのクラスが与えられた距離で見えるか。major=常時 / urban=far以外 / local=nearのみ。 */
export function railClassVisible(cls, distance) {
  const band = railLodBand(distance);
  if (cls === 'major') return true;
  if (cls === 'urban') return band !== 'far';
  return band === 'near';
}

// 距離バンド別 opacity。鉄道は道路より少し濃いが黒すぎない。地下鉄(urban)は地上と重なるため弱め。
export const RAIL_TIER_OPACITY = {
  major: { near: 0.82, mid: 0.72, far: 0.6 },
  urban: { near: 0.5, mid: 0.4, far: 0.4 }, // urban は far 非表示のため far 値は未使用
  local: { near: 0.6, mid: 0.6, far: 0.6 }, // local は near のみ表示
};
export function railTierOpacity(cls, distance) {
  return (RAIL_TIER_OPACITY[cls] || RAIL_TIER_OPACITY.local)[railLodBand(distance)];
}

// MODEL_STYLE の鉄道色: 道路（light gray）より少し濃い medium neutral gray。黒すぎない。
//   BUILDING(white) > ROAD(light gray) > RAIL(medium gray) > (RIVER cyan / PARK green) の階層。
export const RAIL_COLORS = { major: 0x8f969d, urban: 0xa0a6ac, local: 0xadb2b7 };

/** XZ polyline（[[x,z],...]）の総延長(m)。 */
export function polylineLengthXZ(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return 0;
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    L += Math.hypot(pts[i][0] - pts[i + 1][0], pts[i][1] - pts[i + 1][1]);
  }
  return L;
}

/** 最長の1線分(m)。異常に長いセグメント検出用。 */
export function maxSegmentLengthXZ(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return 0;
  let m = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i][0] - pts[i + 1][0], pts[i][1] - pts[i + 1][1]);
    if (d > m) m = d;
  }
  return m;
}

/**
 * [Mission24] 鉄道ネットワークのクラスを「連結」で救済する。
 *   本線（JR環状線・私鉄本線）は OSM で橋・踏切・分岐で短い way に分割され、そのままだと
 *   長さ < RAIL_MAJOR_MIN_LEN_M の断片が local 扱い → City Mode FAR で本線に点線状の欠落が出る。
 *   ルール:
 *     - 路線名を持つ rail way は major（名前 = 実在の営業路線）
 *     - 名無しでも、両端が major rail way の端点に接続する短い rail way は major（分岐/橋の断片）
 *   subway(urban) / light_rail(local) は据え置き。
 * @param {Array<{railway?:string, name?:string, p:number[][]}>} features
 * @returns {Map<number, 'major'|'urban'|'local'>}  feature index → class
 */
export function reclassifyRailNetwork(features, opts = {}) {
  const tolM = opts.tolM ?? 20;
  const base = (features || []).map((f) => (railIncluded(f && f.railway) ? classifyRail(f && f.railway, polylineLengthXZ(f && f.p)) : 'excluded'));
  // major rail way の端点 grid
  const cell = tolM;
  const grid = new Map();
  const gkey = (x, z) => Math.round(x / cell) + ',' + Math.round(z / cell);
  (features || []).forEach((f, i) => {
    if (base[i] !== 'major' || !f || !Array.isArray(f.p) || f.p.length < 2) return;
    if (String(f.railway).toLowerCase() !== 'rail') return;
    for (const idx of [0, f.p.length - 1]) {
      const p = f.p[idx];
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const k = gkey(p[0] + dx * cell, p[1] + dz * cell);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(p);
      }
    }
  });
  const nearMajorEnd = (p) => {
    const b = grid.get(gkey(p[0], p[1]));
    if (!b) return false;
    for (const q of b) if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= tolM) return true;
    return false;
  };
  const out = new Map();
  (features || []).forEach((f, i) => {
    let c = base[i];
    if (c === 'local' && f && String(f.railway).toLowerCase() === 'rail') {
      if (f.name) c = 'major'; // 名前付き = 実在路線
      else if (Array.isArray(f.p) && f.p.length >= 2 && nearMajorEnd(f.p[0]) && nearMajorEnd(f.p[f.p.length - 1])) c = 'major'; // 両端が本線に接続
    }
    out.set(i, c);
  });
  return out;
}

/** line feature 配列（{railway, p}）をクラスで集計する。 */
export function countByRailClass(features) {
  const out = { major: 0, urban: 0, local: 0, excluded: 0, invalid: 0, total: 0 };
  for (const f of features || []) {
    out.total++;
    if (!f || !Array.isArray(f.p) || f.p.length < 2) { out.invalid++; out.local++; continue; }
    if (!railIncluded(f.railway)) { out.excluded++; continue; }
    out[classifyRail(f.railway, polylineLengthXZ(f.p))]++;
  }
  return out;
}
