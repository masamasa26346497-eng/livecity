'use strict';
// Mission 49: recover building base footprints (local znorth-neg metres) from 3D Tiles leaf GLBs written by
// tools/mission37b-build-3dtiles.cjs, reading only the tracked tileset (read-only).
// Vertex layout per building (see buildGlb): n roof vertices, then 4 vertices per side quad (v0,v1 at z0; v2,v3 at top).
// Base ring = v0 of each quad = vertex index n + 4*i.
// Frame: glTF (E,U,-N) -> ENU -> composed tile transforms -> ECEF -> lon/lat -> local (same constants as geoToThree()).
const fs = require('fs');
const path = require('path');
const D2R = Math.PI / 180, WA = 6378137, WE2 = 0.00669437999014;
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320;

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function apply(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}
function ecefToLonLat(X, Y, Z) {
  const lon = Math.atan2(Y, X), p = Math.hypot(X, Y);
  let lat = Math.atan2(Z, p * (1 - WE2));
  for (let i = 0; i < 6; i++) { const s = Math.sin(lat), N = WA / Math.sqrt(1 - WE2 * s * s); lat = Math.atan2(Z + WE2 * N * s, p); }
  return { lon: lon / D2R, lat: lat / D2R };
}
const lonLatToLocal = (lon, lat) => ({ x: (lon - CLON) * Math.cos(CLAT * D2R) * MPD, z: -((lat - CLAT) * MPD) });

function parseGlb(buf) {
  const jl = buf.readUInt32LE(12);
  const j = JSON.parse(buf.slice(20, 20 + jl).toString());
  const bo = 20 + jl + 8;
  const attrs = j.meshes[0].primitives[0].attributes;
  const pa = j.accessors[attrs.POSITION], fa = j.accessors[attrs._FEATURE_ID_0];
  const pv = j.bufferViews[pa.bufferView], fv = j.bufferViews[fa.bufferView];
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const pos = new Float32Array(ab.slice(bo + pv.byteOffset, bo + pv.byteOffset + pa.count * 12));
  const fid = new Float32Array(ab.slice(bo + fv.byteOffset, bo + fv.byteOffset + fa.count * 4));
  return { pos, fid, count: pa.count };
}

// returns [{ idx, ring:[[x,z]..], top }] per feature index in this GLB
function footprintsFromGlb(glbPath, M) {
  const g = parseGlb(fs.readFileSync(glbPath));
  const per = new Map();
  for (let i = 0; i < g.count; i++) { const f = g.fid[i]; if (!per.has(f)) per.set(f, []); per.get(f).push(i); }
  const out = [];
  const toLocal = (vi) => {
    const E = g.pos[vi * 3], U = g.pos[vi * 3 + 1], Nn = -g.pos[vi * 3 + 2];
    const e = apply(M, E, Nn, U);
    const ll = ecefToLonLat(e[0], e[1], e[2]);
    return lonLatToLocal(ll.lon, ll.lat);
  };
  for (const [f, vs] of per) {
    const V = vs.length;
    if (V % 5 !== 0) continue;
    const n = V / 5;
    const ring = [];
    let top = -Infinity;
    for (let i = 0; i < n; i++) { const p = toLocal(vs[n + 4 * i]); ring.push([p.x, p.z]); }
    for (let i = 0; i < n; i++) top = Math.max(top, g.pos[vs[i] * 3 + 1]);
    out.push({ idx: f, ring, top });
  }
  return out;
}

// all leaves of a tileset: [{ uri, M (composed), extras }]
function leaves(tsDir) {
  const ts = JSON.parse(fs.readFileSync(path.join(tsDir, 'tileset.json')));
  const out = [];
  const walk = (n, M) => {
    const m = n.transform ? mul(M, n.transform) : M;
    if (n.content && /^tiles\//.test(n.content.uri)) out.push({ uri: n.content.uri, M: m, extras: n.extras });
    (n.children || []).forEach((c) => walk(c, m));
  };
  walk(ts.root, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return out;
}

function allFootprints(tsDir) {
  const res = [];
  for (const l of leaves(tsDir)) {
    const idsPath = path.join(tsDir, (l.extras && l.extras.idsUri) || ('ids/' + path.basename(l.uri, '.glb') + '.json'));
    const ids = JSON.parse(fs.readFileSync(idsPath));
    const idList = Array.isArray(ids) ? ids : (ids.ids || ids);
    for (const f of footprintsFromGlb(path.join(tsDir, l.uri), l.M)) res.push({ id: idList[f.idx], ring: f.ring, top: f.top });
  }
  return res;
}

module.exports = { allFootprints, leaves, footprintsFromGlb, lonLatToLocal, CONST: { CLAT, CLON, MPD } };
