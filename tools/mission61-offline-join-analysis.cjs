#!/usr/bin/env node
// [Mission 61] 完全オフラインの接合分析。外部 GET は一切行わない（http/https/fetch を使わない。テストで保証）。
// 入力はすべて Git 追跡済みの既存資産:
//   建物: public/map-data/osaka-city/buildings/osaka-sumiyoshi/tile_*.json（fp = 足元 footprint, h = 高さ）
//   OSM 道路中心線/水域: public/mission37c-layers/osaka-sumiyoshi-9tile/{roads,waterways}.json
//   GSI 道路縁/水域面（独立ラスタ系統）: public/mission49-data/gsi-roadedge-sumiyoshi-9tile.json, public/mission57-data/gsi-sumiyoshi-9tile.json
// 出力: data/reports/mission61/offline-join.json
// 方針: 異なる地物を同一対応点として差分化しない。「系統的な一様ずれ（平均ベクトル）」と「シフトスイープの最小位置」だけを見る。
const fs = require('node:fs');
const path = require('node:path');

const OUT = 'data/reports/mission61';
const rd = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const CLAT = 34.604208, MPD = 111320, D = Math.PI / 180;

// ---------- 空間インデックス（線分グリッド） ----------
class SegIndex {
  constructor(cell = 25) { this.c = cell; this.m = new Map(); }
  add(a, b) {
    const c = this.c, x0 = Math.floor(Math.min(a[0], b[0]) / c), x1 = Math.floor(Math.max(a[0], b[0]) / c);
    const z0 = Math.floor(Math.min(a[1], b[1]) / c), z1 = Math.floor(Math.max(a[1], b[1]) / c);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) { const k = i + ',' + j; (this.m.get(k) || this.m.set(k, []).get(k)).push([a, b]); }
  }
  addPoly(pts, closed) { for (let i = 0; i + 1 < pts.length; i++) this.add(pts[i], pts[i + 1]); if (closed && pts.length > 2) this.add(pts[pts.length - 1], pts[0]); }
  // 最近点（半径 R 以内）。無ければ null
  nearest(p, R) {
    const c = this.c, ci = Math.floor(p[0] / c), cj = Math.floor(p[1] / c), n = Math.ceil(R / c);
    let best = null;
    for (let i = ci - n; i <= ci + n; i++) for (let j = cj - n; j <= cj + n; j++) {
      const L = this.m.get(i + ',' + j); if (!L) continue;
      for (const [a, b] of L) {
        const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
        let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0; t = Math.max(0, Math.min(1, t));
        const qx = a[0] + t * dx, qz = a[1] + t * dz, d = Math.hypot(p[0] - qx, p[1] - qz);
        if (d <= R && (!best || d < best.d)) best = { d, q: [qx, qz] };
      }
    }
    return best;
  }
}
const pct = (arr, q) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2); };
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

// ---------- 1. 視差の理論式 ----------
// 真上向き針穴モデル。カメラ高さ H（地表から）、地表点の天底からの水平距離 r、物体高さ h。
// 屋根点の画面位置は地表換算で r*H/(H-h) の位置に写る → 地表に対する見かけ外向きずれ s = r*h/(H-h)。足元（h=0）は s=0。
function parallaxTable() {
  const rows = [];
  for (const cam of [{ k: 'persp60-r350', H: 350 }, { k: 'ortho-like-fov2-r12000', H: 12000 }]) {
    for (const r of [0, 60, 120, 144]) for (const h of [10, 34.4]) rows.push({ cam: cam.k, H: cam.H, r_m: r, roofHeight_m: h, apparentOutwardShift_m: +(r * h / (cam.H - h)).toFixed(2), footShift_m: 0 });
  }
  return rows;
}

// ---------- 2. 層の高さによる見かけのずれ（斜め視点） ----------
// 層が高さ dh だけ建物底面(z0=0)から浮くと、仰角 e の視線では地表上で dh/tan(e) の見かけのずれ。
function layerHeightParallax() {
  const H = { waterways: 0.5, parks: 0.9, roadsCasing: 1.3, roads: 1.4, railways: 2.0 };
  const rows = [];
  for (const [layer, h] of Object.entries(H)) for (const e of [90, 60, 45, 30, 15]) rows.push({ layer, layerHeight_m: h, elevationDeg: e, apparentGroundShift_m: e === 90 ? 0 : +(h / Math.tan(e * D)).toFixed(2) });
  return rows;
}

// ---------- 3. 実データ読込 ----------
const bdir = 'public/map-data/osaka-city/buildings/osaka-sumiyoshi';
const tiles = fs.readdirSync(bdir).filter((f) => /^tile_-[4-6]_-[1-3]\.json$/.test(f));
const bldgs = [];
for (const f of tiles) for (const b of rd(path.join(bdir, f)).buildings) bldgs.push(b);
const W = { minX: -3300, maxX: -1200, minZ: -1800, maxZ: 300 };
const inW = (p) => p[0] >= W.minX && p[0] <= W.maxX && p[1] >= W.minZ && p[1] <= W.maxZ;

const edge = rd('public/mission49-data/gsi-roadedge-sumiyoshi-9tile.json');
const edgeIdx = new SegIndex(25); for (const l of edge.lines) edgeIdx.addPoly(l, false);
const gsi = rd('public/mission57-data/gsi-sumiyoshi-9tile.json');
const gsiWaterIdx = new SegIndex(25); for (const w of gsi.water) { gsiWaterIdx.addPoly(w.outer, true); for (const h of w.holes || []) gsiWaterIdx.addPoly(h, true); }
const roads = rd('public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json').features.filter((f) => f.kind === 'line' && f.p);
const water = rd('public/mission37c-layers/osaka-sumiyoshi-9tile/waterways.json').features;

// ---------- 4. 一様ずれの検出（平均ベクトル） ----------
// 道路縁は中心線の両側にあるので、無バイアスなら中心線から最近縁への向きが左右で相殺する（平均ベクトル≈0）。
function roadCenterlineVsEdge() {
  const vs = [], ds = [];
  for (const f of roads) {
    if (f.tier === 'minor') continue;
    for (let i = 0; i + 1 < f.p.length; i++) {
      const a = f.p[i], b = f.p[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
      for (let s = 0; s < L; s += 10) {
        const t = s / L, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; if (!inW(p)) continue;
        const n = edgeIdx.nearest(p, 15); if (!n) continue;
        vs.push([n.q[0] - p[0], n.q[1] - p[1]]); ds.push(n.d);
      }
    }
  }
  return { nSamples: vs.length, nearestEdgeDist_m: { p10: pct(ds, 0.1), p50: pct(ds, 0.5), p90: pct(ds, 0.9) }, meanVectorToNearestEdge_m: { east: +mean(vs.map((v) => v[0])).toFixed(2), south: +mean(vs.map((v) => v[1])).toFixed(2) }, note: '無バイアスなら 0 付近。道路が東西/南北の偏りを持つ街区では片側に寄ることがある（符号の一貫性は sweep で確認）。' };
}
// OSM 水域面の頂点 → GSI 水域面境界の最近点。
function osmWaterVsGsiWater() {
  const vs = [], ds = [];
  for (const f of water) {
    if (f.kind !== 'area') continue;
    for (const p of f.p) { const n = gsiWaterIdx.nearest(p, 40); if (!n) continue; vs.push([n.q[0] - p[0], n.q[1] - p[1]]); ds.push(n.d); }
  }
  return { nVerts: vs.length, nearestGsiWaterBoundary_m: { p10: pct(ds, 0.1), p50: pct(ds, 0.5), p90: pct(ds, 0.9) }, meanVector_m: vs.length ? { east: +mean(vs.map((v) => v[0])).toFixed(2), south: +mean(vs.map((v) => v[1])).toFixed(2) } : null, osmAreaFeatures: water.filter((f) => f.kind === 'area').length, gsiPolygons: gsi.water.length, note: '定義が異なる（OSM=自然水域の手動トレース、GSI=基盤地図）。近傍距離は「同一境界線の差」ではなく、最近の別境界線との距離。' };
}
// 建物 footprint 頂点 → GSI 道路縁: シフトスイープ。建物は道路縁に接しがち（敷地境界）なので、距離中央値が最小になるシフトが 0 に近いか。
function buildingVsEdgeSweep() {
  const verts = []; for (const b of bldgs) for (const p of b.fp) if (inW(p)) verts.push(p);
  const sample = verts.filter((_, i) => i % 3 === 0);
  const res = [];
  for (let dx = -8; dx <= 8; dx += 2) for (let dz = -8; dz <= 8; dz += 2) {
    const ds = []; for (const p of sample) { const n = edgeIdx.nearest([p[0] + dx, p[1] + dz], 30); ds.push(n ? n.d : 30); }
    res.push({ dx, dz, median: pct(ds, 0.5), within1m: +(ds.filter((d) => d <= 1).length / ds.length * 100).toFixed(1) });
  }
  const bestMed = [...res].sort((a, b) => a.median - b.median || b.within1m - a.within1m)[0];
  const zero = res.find((r) => r.dx === 0 && r.dz === 0);
  return { nVertsSampled: sample.length, zeroShift: zero, bestByMedian: bestMed, bestByWithin1m: [...res].sort((a, b) => b.within1m - a.within1m)[0] };
}
// 建物 footprint と GSI 水域面の包含（重なり）
function buildingInGsiWater() {
  const polys = gsi.water.map((w) => w.outer);
  const inside = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  let n = 0, hit = 0; const ids = [];
  for (const b of bldgs) { if (!b.repX && b.repX !== 0) continue; const p = [b.repX, b.repZ]; if (!inW(p)) continue; n++; if (polys.some((pl) => inside(p, pl))) { hit++; ids.push(b.id); } }
  return { buildingsChecked: n, repPointInGsiWater: hit, ids: ids.slice(0, 10) };
}
// 阪和病院 footprint と道路縁/道路中心線の近傍距離（実物の足元と道路の関係）
function hanwaFoot() {
  const c = [-1825.2, -21.4];
  const b = bldgs.find((x) => x.fp && (function (poly) { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], q = poly[j]; if ((a[1] > c[1]) !== (q[1] > c[1]) && c[0] < (q[0] - a[0]) * (c[1] - a[1]) / (q[1] - a[1]) + a[0]) ins = !ins; } return ins; })(x.fp));
  if (!b) return { found: false };
  const ds = b.fp.map((p) => edgeIdx.nearest(p, 40)).map((n) => (n ? +n.d.toFixed(2) : null));
  return { found: true, id: b.id, h: b.h, z0: b.z0, nVerts: b.fp.length, vertexToGsiRoadEdge_m: ds, minVertexToEdge_m: Math.min(...ds.filter((d) => d !== null)) };
}

const out = {
  mission: '61', network: { externalGets: 0, note: 'このスクリプトは http/https/fetch を使わない。入力は Git 追跡済みの既存 JSON のみ。' },
  inputs: { buildingTiles: tiles.length, buildings: bldgs.length, gsiRoadEdgeLines: edge.lines.length, gsiWaterPolys: gsi.water.length, osmRoadLines: roads.length, osmWaterFeatures: water.length },
  parallaxTheory: parallaxTable(),
  layerHeightApparentShift: layerHeightParallax(),
  roadCenterlineVsGsiEdge: roadCenterlineVsEdge(),
  osmWaterAreaVsGsiWater: osmWaterVsGsiWater(),
  buildingFootVsGsiEdgeSweep: buildingVsEdgeSweep(),
  buildingRepPointInGsiWater: buildingInGsiWater(),
  hanwaHospitalFootprint: hanwaFoot(),
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'offline-join.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ inputs: out.inputs, roadCenterlineVsGsiEdge: out.roadCenterlineVsGsiEdge, osmWaterAreaVsGsiWater: out.osmWaterAreaVsGsiWater, sweep: out.buildingFootVsGsiEdgeSweep, inWater: out.buildingRepPointInGsiWater, hanwa: out.hanwaHospitalFootprint }, null, 1));
