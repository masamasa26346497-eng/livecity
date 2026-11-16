#!/usr/bin/env node
'use strict';
// Mission 45Z: 24区の位置整合性の証拠表（追跡済み公開データのみ・読み取り専用・ネットワークなし）。
//   node tools/mission45z-audit-24wards.cjs [--out <json>]
// 区ごとに: 利用可能ソース(tracked/public か private=利用不可)、追跡済み建物 attrs の代表点が自区 N03 ポリゴン内に入る割合、
// 代表点の tile 帰属、高さ異常、道路/水域ベクタの有無と(住吉のみ)橋・高架・地下タグを除いた地上道路 vs footprint 貫通率。
// 出力は集計値のみ（建物 ID・細密座標は出さない）。元データ・GLB・レイヤーは書き換えない。private データ(福島区等)は入手していない→「未検証」。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const rj = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const load = (p, g) => { const sb = {}; vm.runInNewContext(fs.readFileSync(path.join(ROOT, p), 'utf8'), sb); sb.globalThis = sb; return sb[g]; };
const V = load('public/mission45i-vec.js', 'LC45I');
const G = load('public/mission45y-gfp.js', 'LC45Y');
const pct = (n, d) => (d ? Math.round((n / d) * 10000) / 100 : null);
const SENTINELS = new Set([29997, 29999, 30000]);

function trackedTilesets() {
  const out = [];
  for (const top of ['public/mission37h-3dtiles', 'public/mission38e-3dtiles', 'public/mission40j-3dtiles']) {
    const base = path.join(ROOT, top);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      const dir = path.join(base, d);
      const sj = path.join(dir, 'source.json');
      if (fs.existsSync(sj) && fs.existsSync(path.join(dir, 'attrs'))) out.push({ dir, rel: path.relative(ROOT, dir), src: JSON.parse(fs.readFileSync(sj, 'utf8')) });
    }
  }
  return out;
}

function auditAttrs(ts, own, others) {
  let tileEdge = 0, n = 0, inOwn = 0, inOther = 0, inNone = 0, tileMis = 0, sentinel = 0, hBad = 0, z0nz = 0, nonFinite = 0;
  const otherHits = {};
  const ownT = V.makeInsideTester(own.polygons, 64);
  for (const f of fs.readdirSync(path.join(ts.dir, 'attrs'))) {
    const m = f.match(/^t_(-?\d+)_(-?\d+)\.json$/);
    if (!m) continue;
    const a = JSON.parse(fs.readFileSync(path.join(ts.dir, 'attrs', f), 'utf8'));
    for (const v of Object.values(a.byId || {})) {
      const h = v[0], x = v[2], z = v[3], z0 = v[4];
      n++;
      if (!Number.isFinite(x) || !Number.isFinite(z)) { nonFinite++; continue; }
      if (Math.floor(x / 500) !== +m[1] || Math.floor(z / 500) !== +m[2]) {
        // 代表点(重心)が tile 境界を僅かに越えるのは起こり得る（tile は footprint 側で決まる）。50m 超の逸脱だけを不整合とする。
        const dx = Math.max(+m[1] * 500 - x, x - (+m[1] + 1) * 500, 0);
        const dz = Math.max(+m[2] * 500 - z, z - (+m[2] + 1) * 500, 0);
        if (Math.hypot(dx, dz) > 50) tileMis++; else tileEdge++;
      }
      if (SENTINELS.has(h)) sentinel++; else if (!(h > 0 && h <= 400)) hBad++;
      if (z0) z0nz++;
      if (ownT(x, z)) inOwn++;
      else {
        let hit = null;
        for (const o of others) if (o.t(x, z)) { hit = o.wardId; break; }
        if (hit) { inOther++; otherHits[hit] = (otherHits[hit] || 0) + 1; } else inNone++;
      }
    }
  }
  return { n, insideOwnPct: pct(inOwn, n), insideOtherWardPct: pct(inOther, n), outsideAllPct: pct(inNone, n), otherWards: otherHits, tileCellMismatch: tileMis, tileEdgeStraddle: tileEdge, heightSentinel: sentinel, heightOutOfRange: hBad, z0NonZero: z0nz, nonFiniteRep: nonFinite };
}

function sumiyoshiVector(wards) {
  const roads = rj('public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json');
  const bb = roads.bboxLocal;
  const per = {};
  let tot = 0;
  const tests = wards.map((w) => ({ id: w.wardId, t: V.makeInsideTester(w.polygons, 64) }));
  const surface = [], all = [];
  const tagged = { bridge: 0, tunnel: 0, underground: 0, negLayer: 0 };
  for (const f of roads.features) {
    if (f.kind === 'area') continue;
    const elevated = !!f.bridge;
    const below = !!f.tunnel || !!f.underground || f.layer < 0;
    if (f.bridge) tagged.bridge++;
    if (f.tunnel) tagged.tunnel++;
    if (f.underground) tagged.underground++;
    if (f.layer < 0) tagged.negLayer++;
    all.push(f.p);
    if (!elevated && !below) surface.push(f.p);
    for (const p of f.p) {
      tot++;
      for (const w of tests) if (w.t(p[0], p[1])) { per[w.id] = (per[w.id] || 0) + 1; break; }
    }
  }
  const dir = path.join(ROOT, 'public/map-data/osaka-city/buildings/osaka-sumiyoshi');
  const rings = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    for (const b of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).buildings || []) {
      if (!Array.isArray(b.fp) || b.fp.length < 3) continue;
      const x = b.fp[0][0], z = b.fp[0][1];
      if (x >= bb.minX && x <= bb.maxX && z >= bb.minZ && z <= bb.maxZ) rings.push(b.fp);
    }
  }
  return {
    roadVertexPctByWard: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, pct(v, tot)])),
    roadVertices: tot, taggedFeatures: tagged, footprints: rings.length,
    allRoads: G.roadInsideFraction(all, rings), surfaceRoadsOnly: G.roadInsideFraction(surface, rings),
  };
}

function run() {
  const W = rj('public/mission37g-data/osaka-24-wards.json').wards;
  const tests = W.map((w) => ({ wardId: w.wardId, t: V.makeInsideTester(w.polygons, 64) }));
  const ts = trackedTilesets();
  const rows = W.map((w) => {
    const mine = ts.filter((t) => t.src.wardCode === w.wardCode);
    const others = tests.filter((o) => o.wardId !== w.wardId);
    const sumi = w.wardId === 'sumiyoshi';
    const row = {
      wardId: w.wardId, wardCode: w.wardCode, sourceBuildings: w.sourceBuildings, sourceTiles: w.sourceTiles,
      sources: {
        n03Polygon: 'tracked',
        glbTilesets: mine.map((m) => m.rel),
        plateauFootprintTiles: sumi ? 'tracked (52 tiles)' : 'private (not available here)',
        osmRoadWaterLayers: sumi ? 'tracked (9-tile bundle ~2.1km)' : 'private/none (not available here)',
      },
    };
    if (mine.length) {
      row.attrs = mine.map((m) => Object.assign({ set: path.basename(m.dir) }, auditAttrs(m, w, others)));
      const bad = row.attrs.some((a) => a.nonFiniteRep || a.tileCellMismatch || (a.insideOwnPct != null && a.insideOwnPct < 95));
      row.buildingPlacement = bad ? 'issue' : 'verified-in-ward';
    } else if (sumi) row.buildingPlacement = 'verified-in-ward (45M/45T/45Y: GLB == footprint, footprints vs roads)';
    else row.buildingPlacement = 'unverified (no tracked building data)';
    row.roadWaterVsBuilding = sumi ? 'verified (tracked 9-tile bundle; see sumiyoshiVector)' : 'unverified (vector layers/footprints are private)';
    return row;
  });
  const summary = {
    wards: rows.length,
    verifiedInWard: rows.filter((r) => /^verified-in-ward/.test(r.buildingPlacement)).length,
    issues: rows.filter((r) => r.buildingPlacement === 'issue').map((r) => r.wardId),
    unverified: rows.filter((r) => /^unverified/.test(r.buildingPlacement)).length,
    roadWaterVerified: rows.filter((r) => /^verified/.test(r.roadWaterVsBuilding)).length,
  };
  return { mission: '45Z', scope: 'tracked/public data only; private ward data (e.g. fukushima GLB/OSM layers) not available -> unverified. No data fixes applied.', summary, wards: rows, sumiyoshiVector: sumiyoshiVector(W) };
}
module.exports = { run };
if (require.main === module) {
  const r = run();
  const i = process.argv.indexOf('--out');
  if (i > 0) { fs.mkdirSync(path.dirname(process.argv[i + 1]), { recursive: true }); fs.writeFileSync(process.argv[i + 1], JSON.stringify(r, null, 1)); }
  console.log(JSON.stringify(r.summary));
  console.log(JSON.stringify(r.sumiyoshiVector));
  for (const w of r.wards) console.log(w.wardId.padEnd(15), w.buildingPlacement, w.attrs ? w.attrs.map((a) => a.set + ':' + a.n + ' own%' + a.insideOwnPct + ' other%' + a.insideOtherWardPct + ' sentinel' + a.heightSentinel + ' tileMis' + a.tileCellMismatch).join(' | ') : '');
}
