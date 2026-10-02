// tools/lib/label-engine.js
// [見た目改善 Mission15] 共通 LabelEngine の純粋ロジック（THREE 非依存）。
//   駅名 / 区名 / 地名 / 河川名 / 公園名 / 公共施設名 を 1 つの priority queue で扱い、
//   type 別の独立 collision 実装を増やさない。将来の全国展開でも使える汎用設計。
//
//   共通 label 構造:
//     { id, type, name, x, z, priority, importance, minBand, styleKey, sourceId }
//   band: 'far'(>9000m) / 'mid'(3500-9000m) / 'near'(<=3500m)（道路・鉄道・公園LODと一致）

export const LABEL_TYPES = ['ward', 'station', 'river', 'place', 'park', 'public_facility'];

// type + importance から priority を決める共通体系（数値が大きいほど優先）。
export const LABEL_PRIORITY = {
  ward:            { major: 1000, medium: 980, local: 960 },
  station:         { major: 900,  medium: 700, local: 500 },
  river:           { major: 850,  medium: 620, local: 480 },
  place:           { major: 820,  medium: 600, local: 460 },
  public_facility: { major: 800,  medium: 640, local: 440 },
  park:            { major: 650,  medium: 560, local: 400 },
};

export function labelPriority(type, importance) {
  const t = LABEL_PRIORITY[type] || LABEL_PRIORITY.place;
  return t[importance] || t.local || 400;
}

// type + importance から最小表示 band（この band 以遠では出さない）。
//   far で出るもの = ward / major station / major river / major place / major public_facility。
export function labelMinBand(type, importance) {
  if (importance === 'major') {
    if (type === 'park') return 'mid';       // 大規模公園も名称は mid から
    return 'far';
  }
  if (importance === 'medium') return 'mid';
  return 'near';
}

export const LABEL_BANDS = { farM: 9000, midM: 3500 };
export function labelBand(distance) {
  const d = Number.isFinite(distance) ? distance : 0;
  if (d > LABEL_BANDS.farM) return 'far';
  if (d > LABEL_BANDS.midM) return 'mid';
  return 'near';
}
const BAND_RANK = { far: 0, mid: 1, near: 2 };
/** minBand が現在の band で表示可能か（near は全部、far は far ラベルのみ）。 */
export function labelVisibleAtBand(minBand, distance) {
  return BAND_RANK[labelBand(distance)] >= BAND_RANK[minBand || 'near'];
}

// band 別の画面全体 label 上限（collision しなくても際限なく出さない）。
export const LABEL_DENSITY_CAP = { far: 34, mid: 78, near: 120 };
// viewport grid（中央部だけ大量にならないよう 1 セルあたりの上限）。
export const LABEL_GRID = { cols: 8, rows: 6, perCell: 4 };

// type 別 canonical style（白模型に合う。派手色・黒ベタ禁止）。
export const LABEL_STYLES = {
  ward:            { font: 17,  weight: '650', text: '#46515b', bg: 'transparent',              border: 'transparent',                halo: 'rgba(255,255,255,0.85)' },
  place:           { font: 14,  weight: '600', text: '#525c66', bg: 'transparent',              border: 'transparent',                halo: 'rgba(255,255,255,0.85)' },
  station_major:   { font: 15,  weight: '600', text: '#3f4852', bg: 'rgba(255,255,255,0.90)',   border: 'rgba(120,130,140,0.30)',     halo: null },
  station_medium:  { font: 12,  weight: '500', text: '#4f5963', bg: 'rgba(255,255,255,0.84)',   border: 'rgba(120,130,140,0.24)',     halo: null },
  station_local:   { font: 10.5,weight: '500', text: '#5a636d', bg: 'rgba(255,255,255,0.80)',   border: 'rgba(120,130,140,0.20)',     halo: null },
  river:           { font: 13,  weight: '500', text: '#5b8795', bg: 'transparent',              border: 'transparent',                halo: 'rgba(255,255,255,0.70)', italic: true },
  park:            { font: 12,  weight: '500', text: '#60775a', bg: 'transparent',              border: 'transparent',                halo: 'rgba(255,255,255,0.80)' },
  public_facility: { font: 12,  weight: '500', text: '#59636d', bg: 'rgba(255,255,255,0.78)',   border: 'rgba(120,130,140,0.20)',     halo: null },
};

export function labelStyleKey(type, importance) {
  if (type === 'station') return `station_${importance === 'major' ? 'major' : importance === 'medium' ? 'medium' : 'local'}`;
  return type;
}

/** 共通 label record を組み立てる（欠損は補完）。 */
export function makeLabel(o) {
  const type = LABEL_TYPES.includes(o.type) ? o.type : 'place';
  const importance = ['major', 'medium', 'local'].includes(o.importance) ? o.importance : 'local';
  return {
    id: String(o.id),
    type, name: String(o.name || ''),
    x: +o.x, z: +o.z,
    importance,
    priority: Number.isFinite(o.priority) ? o.priority : labelPriority(type, importance),
    minBand: o.minBand || labelMinBand(type, importance),
    styleKey: o.styleKey || labelStyleKey(type, importance),
    sourceId: o.sourceId || null,
    pinned: !!o.pinned, // selected ward 等、collision で消さない
  };
}

/** XZ ポリゴンリングの面積加重セントロイド（representative point 近似）。 */
export function polygonCentroidXZ(ring) {
  let a2 = 0, cx = 0, cz = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    const cr = p[0] * q[1] - q[0] * p[1];
    a2 += cr; cx += (p[0] + q[0]) * cr; cz += (p[1] + q[1]) * cr;
  }
  if (Math.abs(a2) < 1e-6) {
    let sx = 0, sz = 0; for (const p of ring) { sx += p[0]; sz += p[1]; }
    return { x: n ? sx / n : 0, z: n ? sz / n : 0, area: 0 };
  }
  return { x: cx / (3 * a2), z: cz / (3 * a2), area: Math.abs(a2 / 2) };
}
export function multiRingCentroidXZ(rings) {
  let sx = 0, sz = 0, sw = 0;
  for (const r of rings || []) {
    if (!r || r.length < 3) continue;
    const c = polygonCentroidXZ(r);
    const w = c.area > 0 ? c.area : 1e-6;
    sx += c.x * w; sz += c.z * w; sw += w;
  }
  return sw ? { x: sx / sw, z: sz / sw } : null;
}

/** centerline（[[x,z],...]）の弧長 t（0..1）付近の点。河川ラベルのアンカー用。 */
export function centerlineAnchor(centerline, t = 0.5) {
  if (!Array.isArray(centerline) || centerline.length < 2) return centerline && centerline[0] ? { x: centerline[0][0], z: centerline[0][1] } : null;
  let total = 0;
  for (let i = 0; i < centerline.length - 1; i++) total += Math.hypot(centerline[i][0] - centerline[i + 1][0], centerline[i][1] - centerline[i + 1][1]);
  const target = total * Math.max(0, Math.min(1, t));
  let acc = 0;
  for (let i = 0; i < centerline.length - 1; i++) {
    const seg = Math.hypot(centerline[i][0] - centerline[i + 1][0], centerline[i][1] - centerline[i + 1][1]);
    if (acc + seg >= target) {
      const f = seg > 0 ? (target - acc) / seg : 0;
      return { x: centerline[i][0] + (centerline[i + 1][0] - centerline[i][0]) * f, z: centerline[i][1] + (centerline[i + 1][1] - centerline[i][1]) * f };
    }
    acc += seg;
  }
  const last = centerline[centerline.length - 1];
  return { x: last[0], z: last[1] };
}

/**
 * 全 type の label 候補を 1 つの priority queue で解決する。
 * @param {Array} candidates makeLabel() 済みの配列。各要素に screen 座標 {sx, sy in NDC} と bbox 半径 {hw, hh} を付けたもの。
 * @param {{distance:number, densityCap?:object, grid?:object}} opts
 * @returns {{visibleIds:Set<string>, stats:object}}
 */
export function resolveLabelCollisions(candidates, opts = {}) {
  const distance = opts.distance || 0;
  const band = labelBand(distance);
  const cap = (opts.densityCap || LABEL_DENSITY_CAP)[band] || 999;
  const grid = opts.grid || LABEL_GRID;

  const stats = { total: candidates.length, hiddenByLOD: 0, hiddenByViewport: 0, hiddenByCollision: 0, hiddenByDensityCap: 0, hiddenByGrid: 0, visible: 0 };
  // 1. LOD + viewport
  let pool = [];
  for (const c of candidates) {
    if (!labelVisibleAtBand(c.minBand, distance)) { stats.hiddenByLOD++; continue; }
    if (c.sx == null || c.sx < -1.1 || c.sx > 1.1 || c.sy < -1.1 || c.sy > 1.1 || c.behind) { stats.hiddenByViewport++; continue; }
    pool.push(c);
  }
  // 2. priority（高い順）→ 中心距離が近い順
  pool.sort((a, b) => (b.priority - a.priority) || ((a.distToCenter || 0) - (b.distToCenter || 0)));

  // 3. grid セル別カウント
  const cellCount = new Map();
  const cellOf = (c) => {
    const gx = Math.min(grid.cols - 1, Math.max(0, Math.floor((c.sx + 1) / 2 * grid.cols)));
    const gy = Math.min(grid.rows - 1, Math.max(0, Math.floor((c.sy + 1) / 2 * grid.rows)));
    return gx + ',' + gy;
  };

  const placed = [];
  const visibleIds = new Set();
  for (const c of pool) {
    if (visibleIds.size >= cap && !c.pinned) { stats.hiddenByDensityCap++; continue; }
    // grid density
    const cell = cellOf(c);
    if (!c.pinned && (cellCount.get(cell) || 0) >= grid.perCell) { stats.hiddenByGrid++; continue; }
    // screen-space AABB collision
    let overlap = false;
    if (!c.pinned) {
      for (const q of placed) {
        if (Math.abs(c.sx - q.sx) < (c.hw + q.hw) && Math.abs(c.sy - q.sy) < (c.hh + q.hh)) { overlap = true; break; }
      }
    }
    if (overlap) { stats.hiddenByCollision++; continue; }
    placed.push(c);
    cellCount.set(cell, (cellCount.get(cell) || 0) + 1);
    visibleIds.add(c.id);
  }
  stats.visible = visibleIds.size;
  return { visibleIds, stats, band };
}
