'use strict';
// Mission 59: 3D Tiles の変換チェーンを独立に検算する（ビルダーの関数は import しない）。
// GLB 頂点 → glTF Y-up→Z-up → leaf transform → group transform → root(無し) → ECEF → WGS84(反復法)
// を元 tile JSON の footprint（geoToThree 逆変換）と比較する。読み取り専用。
const fs = require('fs');
const path = require('path');
const SET = process.argv[2] || 'public/mission37b-3dtiles/osaka-sumiyoshi-9tile';
const SRC = process.argv[3] || 'public/map-data/osaka-city/buildings/osaka-sumiyoshi';
const PER_TILE = 4;
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320;
const D2R = Math.PI / 180, A = 6378137, E2 = 0.00669437999014;

function readGlb(file) {
  const b = fs.readFileSync(file);
  const jl = b.readUInt32LE(12);
  const json = JSON.parse(b.slice(20, 20 + jl).toString('utf8'));
  const bin = b.slice(20 + jl + 8);
  return { json, bin };
}
function accessor(g, idx) {
  const a = g.json.accessors[idx], bv = g.json.bufferViews[a.bufferView];
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const Ctor = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array }[a.componentType];
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride && bv.byteStride !== n * Ctor.BYTES_PER_ELEMENT ? bv.byteStride : 0;
  if (stride) throw new Error('interleaved not supported');
  const buf = g.bin.buffer.slice(g.bin.byteOffset + off, g.bin.byteOffset + off + a.count * n * Ctor.BYTES_PER_ELEMENT);
  return { data: new Ctor(buf), n, count: a.count };
}
const mulMat = (m, v) => [ // column-major 4x4 * point
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
function toGeodetic(x, y, z) { // 反復法（ビルダーの順変換とは別実装）
  const lon = Math.atan2(y, x), p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2)), h = 0;
  for (let i = 0; i < 12; i++) {
    const s = Math.sin(lat), N = A / Math.sqrt(1 - E2 * s * s);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - E2 * N / (N + h)));
  }
  return { lon: lon / D2R, lat: lat / D2R, h };
}
const localToLonLat = (x, z) => ({ lon: CLON + x / (Math.cos(CLAT * D2R) * MPD), lat: CLAT - z / MPD });

const ts = JSON.parse(fs.readFileSync(path.join(SET, 'tileset.json'), 'utf8'));
const rootT = ts.root.transform || null; // 無ければ単位行列
const leaves = [];
(function walk(n, chain) {
  const c = n.transform ? chain.concat([n.transform]) : chain;
  if (n.content && /^tiles\//.test(n.content.uri)) leaves.push({ uri: n.content.uri, chain: c, extras: n.extras });
  (n.children || []).forEach(k => walk(k, c));
})(ts.root, rootT ? [rootT] : []);

const rows = [], perTile = [];
let allH = [], allV = [];
for (const lf of leaves) {
  const g = readGlb(path.join(SET, lf.uri));
  const prim = g.json.meshes[0].primitives[0];
  const pos = accessor(g, prim.attributes.POSITION);
  const fidKey = Object.keys(prim.attributes).find(k => /FEATURE_ID/i.test(k));
  const fid = accessor(g, prim.attributes[fidKey]);
  const ids = JSON.parse(fs.readFileSync(path.join(SET, lf.extras.idsUri), 'utf8'));
  const idList = Array.isArray(ids) ? ids : (ids.ids || Object.values(ids));
  const tile = JSON.parse(fs.readFileSync(path.join(SRC, `tile_${lf.extras.tx}_${lf.extras.tz}.json`), 'utf8'));
  const byId = new Map(tile.buildings.map(b => [b.id, b]));
  // node transform (glTF) — 無ければ恒等
  const nodeM = (g.json.nodes && g.json.nodes[0] && g.json.nodes[0].matrix) || null;
  const picks = []; const seen = new Set();
  for (let i = 0; i < pos.count && picks.length < PER_TILE; i++) {
    const f = fid.data[i];
    if (seen.has(f)) continue; seen.add(f);
    if (f % 97 === 3 || picks.length < PER_TILE) picks.push(f);
  }
  const tH = [], tV = [];
  for (const f of picks) {
    const b = byId.get(idList[f]); if (!b) { rows.push({ tile: lf.uri, f, id: idList[f], err: 'id not in source tile' }); continue; }
    const n = b.fp.length; // 頂点順: 屋根 n 個が連続（ビルダー仕様）。先頭の feature 頂点 n 個を屋根とみなす
    let first = -1; for (let i = 0; i < pos.count; i++) if (fid.data[i] === f) { first = i; break; }
    const top = b.z0 + b.dz;
    for (let k = 0; k < n; k++) {
      let v = [pos.data[(first + k) * 3], pos.data[(first + k) * 3 + 1], pos.data[(first + k) * 3 + 2]];
      if (nodeM) v = mulMat(nodeM, v);
      v = [v[0], -v[2], v[1]]; // glTF Y-up → Z-up（x, -z, y）
      for (let c = lf.chain.length - 1; c >= 0; c--) v = mulMat(lf.chain[c], v);
      const geo = toGeodetic(v[0], v[1], v[2]);
      // 元 footprint は cleanRing/逆順で並びが変わり得るので、最近傍の元頂点と比べる
      let best = Infinity, bd = null;
      for (const p of b.fp) {
        const ll = localToLonLat(p[0], p[1]);
        const dE = (geo.lon - ll.lon) * Math.cos(geo.lat * D2R) * 111319.49, dN = (geo.lat - ll.lat) * 110574;
        const d = Math.hypot(dE, dN); if (d < best) { best = d; bd = { dE, dN }; }
      }
      tH.push(best); tV.push(geo.h - top);
      if (k === 0) rows.push({ tile: lf.uri, id: b.id, ring: n, horiz_m: +best.toFixed(3), dE_m: +bd.dE.toFixed(3), dN_m: +bd.dN.toFixed(3), vert_m: +(geo.h - top).toFixed(3), lon: +geo.lon.toFixed(7), lat: +geo.lat.toFixed(7) });
    }
  }
  const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  perTile.push({ tile: lf.uri, nPts: tH.length, horizMax_m: +Math.max(...tH).toFixed(3), horizP95_m: +q(tH, .95).toFixed(3), vertAbsMax_m: +Math.max(...tV.map(Math.abs)).toFixed(3), vertMean_m: +(tV.reduce((a, b) => a + b, 0) / tV.length).toFixed(3) });
  allH.push(...tH); allV.push(...tV);
}
const out = {
  set: SET, nTiles: leaves.length, nPoints: allH.length,
  horizMax_m: +Math.max(...allH).toFixed(3), horizMean_m: +(allH.reduce((a, b) => a + b, 0) / allH.length).toFixed(3),
  vertAbsMax_m: +Math.max(...allV.map(Math.abs)).toFixed(3),
  note: 'GLB頂点→(node)→Y-up→Z-up→leaf→group→ECEF→WGS84(反復)。比較先は元tile JSON footprintの最近傍頂点(geoToThree逆変換)。ビルダー関数は未使用。',
  perTile, samples: rows.slice(0, 40),
};
fs.mkdirSync('data/reports/mission59', { recursive: true });
fs.writeFileSync('data/reports/mission59/glb-chain-check.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, samples: undefined, perTile: perTile.map(p => `${p.tile} max=${p.horizMax_m} v=${p.vertAbsMax_m}`) }, null, 1));
