#!/usr/bin/env node
'use strict';
// Mission 45M: 実 GLB の頂点を独立に復元し、元 footprint と比較する read-only 検証ツール。
//   GLB の POSITION(glTF Y-up) → Y-up→Z-up(+90deg about X: (x,y,z)->(x,-z,y)) → 子 transform → 親 transform
//   → ECEF → (Bowring 反復で) 測地座標 → geoToThree と同じ順変換で local(x,z) → 元 tile JSON の fp / z0 / top と比較。
//   ビルダー(mission37b-build-3dtiles.cjs)の関数は一切 import しない（独立実装）。入力は読み取り専用、何も書かない。
// 使い方:
//   node tools/mission45m-verify-glb-geometry.cjs --tileset <dir> --src <buildings dataset dir> [--max-tiles N] [--tol 1] [--json out.json]
//   既定: tracked の osaka-sumiyoshi-9tile と public/map-data/osaka-city/buildings/osaka-sumiyoshi
// 出力は集計値のみ（建物ID・座標・パスは出さない）。--json は集計のみ書く。
const fs = require('fs');
const path = require('path');

const CLAT = 34.604208, CLON = 135.525020, MPD = 111320; // geoToThree と同一
const D2R = Math.PI / 180;
const WA = 6378137, WF = 1 / 298.257223563, WE2 = WF * (2 - WF);

// geoToThree(): x = (lon-CLON)*cos(CLAT)*MPD, z = -((lat-CLAT)*MPD)
const geoToLocal = (lon, lat) => [(lon - CLON) * Math.cos(CLAT * D2R) * MPD, -((lat - CLAT) * MPD)];

function ecefToGeodetic(X, Y, Z) { // Bowring 反復
  const lon = Math.atan2(Y, X), p = Math.hypot(X, Y);
  let lat = Math.atan2(Z, p * (1 - WE2)), h = 0;
  for (let i = 0; i < 8; i++) {
    const s = Math.sin(lat), N = WA / Math.sqrt(1 - WE2 * s * s);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(Z, p * (1 - WE2 * N / (N + h)));
  }
  return { lon: lon / D2R, lat: lat / D2R, h };
}
// column-major 4x4
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const apply = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];

function readGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error('not GLB');
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jl).toString('utf8'));
  const bo = 20 + jl + 8;
  const bin = buf.slice(bo, bo + buf.readUInt32LE(20 + jl));
  const prim = json.meshes[0].primitives[0];
  const acc = (i) => json.accessors[i], bv = (a) => json.bufferViews[acc(a).bufferView];
  const pa = acc(prim.attributes.POSITION), pv = bv(prim.attributes.POSITION);
  const fa = acc(prim.attributes._FEATURE_ID_0), fv = bv(prim.attributes._FEATURE_ID_0);
  const pos = [], fid = [];
  for (let i = 0; i < pa.count; i++) {
    const o = pv.byteOffset + (pa.byteOffset || 0) + i * 12;
    pos.push([bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8)]);
    fid.push(bin.readFloatLE(fv.byteOffset + (fa.byteOffset || 0) + i * 4));
  }
  const nodeM = json.nodes && json.nodes[0] && json.nodes[0].matrix ? json.nodes[0].matrix : I4; // glTF node transform
  const hasTRS = !!(json.nodes && json.nodes[0] && (json.nodes[0].translation || json.nodes[0].rotation || json.nodes[0].scale));
  return { pos, fid, nodeM, hasTRS };
}
// Cesium: glTF は Y-up、3D Tiles は Z-up。gltfUpAxis=Y のとき X 軸まわり +90deg: (x,y,z) -> (x,-z,y)
const YUP_TO_ZUP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

// 2D Procrustes (回転・一様スケール・平行移動、鏡像は別途判定)
function fit2d(src, dst) {
  const n = src.length; let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let a = 0, b = 0, ss = 0, cr = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - sx, py = src[i][1] - sy, qx = dst[i][0] - dx, qy = dst[i][1] - dy;
    a += px * qx + py * qy; b += px * qy - py * qx; ss += px * px + py * py;
  }
  return { angleDeg: Math.atan2(b, a) / D2R, scale: Math.hypot(a, b) / (ss || 1), tx: dx - sx, ty: dy - sy };
}
const pct = (arr, q) => { if (!arr.length) return null; const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const stat = (arr) => ({ n: arr.length, p50: pct(arr, 0.5), p95: pct(arr, 0.95), max: arr.length ? Math.max(...arr) : null });

function leafTransform(ancestors) { return ancestors.reduce((m, t) => (t ? mul(m, t) : m), I4); }
function collectLeaves(node, anc, out) {
  const a = anc.concat([node.transform || null]);
  if (node.content && node.extras && node.extras.tx !== undefined) out.push({ node, chain: a });
  (node.children || []).forEach(c => collectLeaves(c, a, out));
}

function verify(opts) {
  const tilesetPath = path.join(opts.tileset, 'tileset.json');
  const ts = JSON.parse(fs.readFileSync(tilesetPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.src, 'manifest.json'), 'utf8'));
  const fileOf = new Map(manifest.tiles.map(t => [t.tx + '_' + t.tz, t.file]));
  const leaves = []; collectLeaves(ts.root, [], leaves);
  const picked = opts.maxTiles ? leaves.slice(0, opts.maxTiles) : leaves;
  const R = { tilesChecked: 0, buildingsChecked: 0, buildingsMissingInGlb: 0, vertexNoMatch: 0, nodeMatrixPresent: false, nodeTRSPresent: false,
    errXY: [], errH: [], regionViolations: 0, fitAngle: [], fitScale: [], mirrorSuspect: 0, idsMismatch: 0 };
  const eXs = [], eYs = [];
  for (const { node, chain } of picked) {
    const { tx, tz } = node.extras;
    const file = fileOf.get(tx + '_' + tz) || ('tile_' + tx + '_' + tz + '.json');
    const srcTile = JSON.parse(fs.readFileSync(path.join(opts.src, file), 'utf8'));
    const ids = JSON.parse(fs.readFileSync(path.join(opts.tileset, node.extras.idsUri), 'utf8'));
    const glb = readGlb(fs.readFileSync(path.join(opts.tileset, node.content.uri)));
    if (glb.nodeM !== I4) R.nodeMatrixPresent = true;
    if (glb.hasTRS) R.nodeTRSPresent = true;
    const M = mul(leafTransform(chain), mul(YUP_TO_ZUP, glb.nodeM));
    // 頂点を featureId ごとに local(x,z,h) へ復元
    const byF = new Map(); const reg = node.boundingVolume.region;
    for (let i = 0; i < glb.pos.length; i++) {
      const w = apply(M, glb.pos[i]);
      const g = ecefToGeodetic(w[0], w[1], w[2]);
      const [x, z] = geoToLocal(g.lon, g.lat);
      const f = glb.fid[i]; if (!byF.has(f)) byF.set(f, []); byF.get(f).push({ x, z, h: g.h });
      const lr = g.lon * D2R, pr = g.lat * D2R, tol = 2e-7; // ~1.3m
      if (lr < reg[0] - tol || lr > reg[2] + tol || pr < reg[1] - tol || pr > reg[3] + tol || g.h < reg[4] - 1 || g.h > reg[5] + 1) R.regionViolations++;
    }
    const srcById = new Map(srcTile.buildings.map(b => [b.id, b]));
    R.tilesChecked++;
    let sampled = 0;
    ids.forEach((id, f) => {
      const b = srcById.get(id); const vs = byF.get(f);
      if (!b || !vs) { R.idsMismatch++; return; }
      if (opts.sample && (sampled++ % opts.sample)) return;
      R.buildingsChecked++;
      const z0 = b.z0 || 0, top = z0 + (b.dz || b.h || 3);
      const roof = vs.filter(v => Math.abs(v.h - top) < 0.5), floor = vs.filter(v => Math.abs(v.h - z0) < 0.5);
      if (!roof.length || !floor.length) R.errH.push(Math.max(...vs.map(v => v.h)) - top);
      const pairs = [];
      for (const p of b.fp) {
        let best = null, bd = Infinity;
        for (const v of roof) { const d = Math.hypot(v.x - p[0], v.z - p[1]); if (d < bd) { bd = d; best = v; } }
        if (!best) continue;
        R.errXY.push(bd); eXs.push(best.x - p[0]); eYs.push(best.z - p[1]);
        pairs.push([[p[0], -p[1]], [best.x, -best.z]]); // (east,north)
        if (bd > 5) R.vertexNoMatch++;
      }
      if (roof.length) { R.errH.push(Math.abs(roof[0].h - top)); }
      if (floor.length) { R.errH.push(Math.abs(floor[0].h - z0)); }
      if (pairs.length >= 3) {
        const fit = fit2d(pairs.map(p => p[0]), pairs.map(p => p[1]));
        R.fitAngle.push(Math.abs(fit.angleDeg)); R.fitScale.push(Math.abs(fit.scale - 1));
        // 鏡像: 符号付き面積が反転していないか（ring 順は変わり得るので roof 頂点の対応が取れた場合のみ）
        const sa = (q) => q.reduce((s, p, i) => { const n = q[(i + 1) % q.length]; return s + p[0] * n[1] - n[0] * p[1]; }, 0);
        const A = sa(pairs.map(p => p[0])), B = sa(pairs.map(p => p[1]));
        if (Math.abs(A) > 1 && Math.abs(B) > 1 && Math.sign(A) !== Math.sign(B)) R.mirrorSuspect++;
      }
    });
  }
  const tol = opts.tol;
  const res = {
    tool: 'mission45m-verify-glb-geometry', tolM: tol,
    tilesChecked: R.tilesChecked, buildingsChecked: R.buildingsChecked, idsMismatch: R.idsMismatch, glbNodeMatrixPresent: R.nodeMatrixPresent, glbNodeTRSPresent: R.nodeTRSPresent,
    horizontalErrM: stat(R.errXY), heightErrM: stat(R.errH),
    meanOffsetEastM: eXs.length ? eXs.reduce((a, b) => a + b, 0) / eXs.length : null,
    meanOffsetSouthM: eYs.length ? eYs.reduce((a, b) => a + b, 0) / eYs.length : null, // local z は南が正
    fitRotationDegAbs: stat(R.fitAngle), fitScaleErrAbs: stat(R.fitScale),
    mirrorSuspectBuildings: R.mirrorSuspect, vertexNoMatchOver5m: R.vertexNoMatch, regionViolations: R.regionViolations,
  };
  res.pass = res.buildingsChecked > 0 && res.horizontalErrM.max < tol && (res.heightErrM.max === null || res.heightErrM.max < tol) &&
    res.mirrorSuspectBuildings === 0 && res.regionViolations === 0 && res.idsMismatch === 0 && res.vertexNoMatchOver5m === 0;
  return res;
}

// 元定数どおりの往復（local→lonlat→local）の誤差。同一式・同一定数なら ~0 になるはず。
function roundtripLocal(samples) {
  let max = 0;
  for (const [x, z] of samples) {
    const lon = CLON + x / (Math.cos(CLAT * D2R) * MPD), lat = CLAT - z / MPD;
    const [x2, z2] = geoToLocal(lon, lat); max = Math.max(max, Math.hypot(x2 - x, z2 - z));
  }
  return max;
}

function main() {
  const a = process.argv.slice(2); const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const root = path.join(__dirname, '..');
  const o = {
    tileset: path.resolve(opt('tileset', path.join(root, 'public', 'mission37b-3dtiles', 'osaka-sumiyoshi-9tile'))),
    src: path.resolve(opt('src', path.join(root, 'public', 'map-data', 'osaka-city', 'buildings', 'osaka-sumiyoshi'))),
    maxTiles: +opt('max-tiles', 0), tol: +opt('tol', 1), sample: +opt('sample', 0),
  };
  const r = verify(o);
  r.localRoundtripMaxM = roundtripLocal([[-3441, -2303], [0, 0], [1865, 5000], [15000, -15000], [-20000, 20000]]);
  console.log(JSON.stringify(r, null, 1));
  const j = opt('json', null); if (j) fs.writeFileSync(path.resolve(j), JSON.stringify(r, null, 1));
  process.exit(r.pass ? 0 : 1);
}
module.exports = { verify, readGlb, ecefToGeodetic, geoToLocal, roundtripLocal, YUP_TO_ZUP, mul, apply };
if (require.main === module) main();
