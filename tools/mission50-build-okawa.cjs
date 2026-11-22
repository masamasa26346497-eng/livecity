#!/usr/bin/env node
'use strict';
// Mission 50: export GSI WA (water area polygons) + RdEdg (road edge lines) for the Okawa / Nakanoshima window from the
// git-ignored tile cache written by tools/mission50-fetch-okawa.cjs. Local metres, znorth-neg (same as geoToThree). No shifting.
//   node tools/mission50-build-okawa.cjs --ref temp/gsi50/okawa --label okawa-nakanoshima --out public/mission50-data
// Also writes a plain-numbers audit (water area, edge length, GSI BldA vs WA overlap as a consistency control).
const fs = require('fs'), path = require('path');
const M = require('./lib/mission46d-mvt.cjs');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const REF = arg('--ref'), LABEL = arg('--label'), OUT = arg('--out', 'public/mission50-data');
if (!REF || !LABEL || !/^[a-z0-9-]{2,40}$/.test(LABEL)) { console.error('usage: --ref <dir> --label <id> [--out dir]'); process.exit(2); }
const r1 = (v) => Math.round(v * 10) / 10;
const area = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]); return s / 2; };
const inRing = (x, z, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const inPoly = (x, z, p) => inRing(x, z, p.outer) && !p.holes.some((h) => inRing(x, z, h));

const water = [], lines = [], bld = []; const bb = { minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9 }; let tiles = 0;
for (const f of fs.readdirSync(REF).filter((x) => x.endsWith('.pbf')).sort()) {
  const [z, x, y] = f.replace('.pbf', '').split('_').map(Number);
  const L = M.decodeMvt(fs.readFileSync(path.join(REF, f))); tiles++;
  for (const [cx, cy] of [[0, 0], [4096, 4096]]) { const g = M.tilePointToLonLat(z, x, y, 4096, cx, cy), l = M.lonLatToLocal(g.lon, g.lat); bb.minX = Math.min(bb.minX, l.x); bb.maxX = Math.max(bb.maxX, l.x); bb.minZ = Math.min(bb.minZ, l.z); bb.maxZ = Math.max(bb.maxZ, l.z); }
  if (L.WA) for (const ft of M.layerToLocal(L.WA, z, x, y)) {
    // MVT: exterior and interior rings have opposite winding; a ring with the same sign as the first one of a feature starts a new polygon
    let cur = null, sign = 0;
    for (const ring of ft.rings) {
      if (ring.length < 3) continue; const a = area(ring);
      if (!sign) sign = Math.sign(a);
      if (Math.sign(a) === sign) { cur = { outer: ring.map((p) => [r1(p[0]), r1(p[1])]), holes: [] }; water.push(cur); }
      else if (cur) cur.holes.push(ring.map((p) => [r1(p[0]), r1(p[1])]));
    }
  }
  if (L.RdEdg) for (const ft of M.layerToLocal(L.RdEdg, z, x, y)) for (const ring of ft.rings) if (ring.length > 1) lines.push(ring.map((p) => [r1(p[0]), r1(p[1])]));
  if (L.BldA) for (const ft of M.layerToLocal(L.BldA, z, x, y)) for (const ring of ft.rings) if (ring.length > 2) bld.push(ring);
}
// audit numbers
const waterAreaM2 = water.reduce((s, p) => s + Math.abs(area(p.outer)) - p.holes.reduce((t, h) => t + Math.abs(area(h)), 0), 0);
const edgeLenM = lines.reduce((s, l) => s + l.slice(1).reduce((t, p, i) => t + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0), 0);
let bVerts = 0, bInWater = 0, bInWaterBuildings = 0;
for (const r of bld) { let hit = 0; for (const p of r) { bVerts++; if (water.some((w) => inPoly(p[0], p[1], w))) { bInWater++; hit++; } } if (hit) bInWaterBuildings++; }
const doc = {
  mission: '50', id: LABEL, kind: 'gsi-water-roadedge', coordinateSystem: 'znorth-neg-v1 (x east m, z south m, origin CLAT/CLON)', unit: 'm',
  bboxLocal: { minX: r1(bb.minX), maxX: r1(bb.maxX), minZ: r1(bb.minZ), maxZ: r1(bb.maxZ) },
  source: '国土地理院 ベクトルタイル optimal_bvmap-v1 (WA 水域面, RdEdg 道路縁), https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/16/{x}/{y}.pbf',
  credit: '国土地理院（基盤地図情報を含む）', fetchedTiles: tiles, zoom: 16, fetchedAt: new Date().toISOString().slice(0, 10),
  note: '実測の水域面と道路縁。窓（取得タイル範囲）の外は未収録。タイル境界で図形が分割されている。座標は一切シフトしていない。',
  water, lines,
};
fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, 'gsi-' + LABEL + '.json'); fs.writeFileSync(file, JSON.stringify(doc));
const audit = { file, bytes: fs.statSync(file).size, tiles, waterPolygons: water.length, waterHoles: water.reduce((s, p) => s + p.holes.length, 0), waterAreaM2: Math.round(waterAreaM2), roadEdgeLines: lines.length, roadEdgeLengthM: Math.round(edgeLenM), gsiBldA: bld.length, gsiBldAVertsInWaterPct: r1(100 * bInWater / Math.max(1, bVerts)), gsiBldAWithAnyVertexInWater: bInWaterBuildings, bboxLocal: doc.bboxLocal };
fs.mkdirSync('data/reports/mission50', { recursive: true });
fs.writeFileSync(arg('--audit', 'data/reports/mission50/okawa-audit.json'), JSON.stringify(audit, null, 1));
console.log(JSON.stringify(audit));
