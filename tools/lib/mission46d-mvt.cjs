'use strict';
// Mission 46D: minimal Mapbox Vector Tile (protobuf) decoder + web-mercator tile -> Live City local metres. No dependencies, no network.
const zlib = require('zlib');
const D2R = Math.PI / 180;
const CONST = { clat: 34.604208, clon: 135.525020, mpd: 111320 };

function readVarint(b, p) {
  let r = 0, m = 1, c;
  do { c = b[p++]; r += (c & 0x7f) * m; m *= 128; } while (c & 0x80 && p < b.length + 1);
  return [r, p];
}
function fields(b, s, e) {
  const out = []; let p = s;
  while (p < e) {
    let k; [k, p] = readVarint(b, p); const f = Math.floor(k / 8), w = k % 8;
    if (w === 0) { let v; [v, p] = readVarint(b, p); out.push({ f, w, v }); }
    else if (w === 2) { let l; [l, p] = readVarint(b, p); out.push({ f, w, s: p, e: p + l }); p += l; }
    else if (w === 1) { out.push({ f, w, s: p, e: p + 8 }); p += 8; }
    else if (w === 5) { out.push({ f, w, s: p, e: p + 4 }); p += 4; }
    else throw new Error('bad wire type ' + w);
  }
  return out;
}
const zz = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);
function decodeGeometry(b, s, e) {
  const cmds = []; let p = s; while (p < e) { let v; [v, p] = readVarint(b, p); cmds.push(v); }
  const rings = []; let cur = null, x = 0, y = 0;
  for (let i = 0; i < cmds.length;) {
    const id = cmds[i] & 7, n = cmds[i] >>> 3; i++;
    if (id === 1) { for (let j = 0; j < n; j++) { x += zz(cmds[i++]); y += zz(cmds[i++]); cur = [[x, y]]; rings.push(cur); } }
    else if (id === 2) { for (let j = 0; j < n; j++) { x += zz(cmds[i++]); y += zz(cmds[i++]); cur.push([x, y]); } }
    else if (id === 7) { if (cur && cur.length) cur.closed = true; }
    else throw new Error('bad geometry command ' + id);
  }
  return rings;
}
function decodeMvt(input) {
  let b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
  const layers = {};
  for (const L of fields(b, 0, b.length)) {
    if (L.f !== 3 || L.w !== 2) continue;
    let name = '', extent = 4096; const keys = [], vals = [], feats = [];
    for (const f of fields(b, L.s, L.e)) {
      if (f.f === 1) name = b.toString('utf8', f.s, f.e);
      else if (f.f === 5) extent = f.v;
      else if (f.f === 3) keys.push(b.toString('utf8', f.s, f.e));
      else if (f.f === 4) { const vf = fields(b, f.s, f.e)[0]; vals.push(!vf ? null : vf.w === 2 ? b.toString('utf8', vf.s, vf.e) : vf.v); }
      else if (f.f === 2) feats.push(f);
    }
    layers[name] = { name, extent, features: feats.map((F) => {
      let type = 0, geom = null; const tags = [];
      for (const f of fields(b, F.s, F.e)) {
        if (f.f === 3) type = f.v;
        else if (f.f === 4) geom = decodeGeometry(b, f.s, f.e);
        else if (f.f === 2) { let p = f.s; while (p < f.e) { let v; [v, p] = readVarint(b, p); tags.push(v); } }
      }
      const props = {}; for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = vals[tags[i + 1]];
      return { type, rings: geom || [], props };
    }) };
  }
  return layers;
}
function tilePointToLonLat(z, tx, ty, extent, px, py) {
  const n = 2 ** z, xf = (tx + px / extent) / n, yf = (ty + py / extent) / n;
  return { lon: xf * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * yf))) / D2R };
}
const lonLatToLocal = (lon, lat) => ({ x: (lon - CONST.clon) * Math.cos(CONST.clat * D2R) * CONST.mpd, z: -((lat - CONST.clat) * CONST.mpd) });
function layerToLocal(layer, z, tx, ty) {
  return layer.features.map((f) => ({ type: f.type, props: f.props, rings: f.rings.map((r) => r.map(([px, py]) => { const g = tilePointToLonLat(z, tx, ty, layer.extent, px, py); const l = lonLatToLocal(g.lon, g.lat); return [l.x, l.z]; })) }));
}

// ---- encoder: used only by tests to build fixture tiles ----
function enc(n) { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; }
const ezz = (n) => (n < 0 ? -n * 2 - 1 : n * 2);
const lenField = (fn, bytes) => [...enc(fn * 8 + 2), ...enc(bytes.length), ...bytes];
function encodeMvt(name, extent, feats) {
  const keys = [], vals = [], fb = [];
  for (const f of feats) {
    const g2 = []; let cx = 0, cy = 0;
    for (const r of f.rings) {
      g2.push(...enc(1 * 8 + 1), ...enc(ezz(r[0][0] - cx)), ...enc(ezz(r[0][1] - cy))); cx = r[0][0]; cy = r[0][1];
      if (r.length > 1) g2.push(...enc((r.length - 1) * 8 + 2));
      for (let i = 1; i < r.length; i++) { g2.push(...enc(ezz(r[i][0] - cx)), ...enc(ezz(r[i][1] - cy))); cx = r[i][0]; cy = r[i][1]; }
      if (f.type === 3) g2.push(...enc(1 * 8 + 7));
    }
    const tags = [];
    for (const [k, v] of Object.entries(f.props || {})) {
      let ki = keys.indexOf(k); if (ki < 0) { ki = keys.length; keys.push(k); }
      const vs = String(v); let vi = vals.indexOf(vs); if (vi < 0) { vi = vals.length; vals.push(vs); }
      tags.push(ki, vi);
    }
    const body = [...lenField(2, tags.flatMap((t) => enc(t))), ...enc(3 * 8), ...enc(f.type), ...lenField(4, g2)];
    fb.push(...lenField(2, body));
  }
  const layer = [...lenField(1, [...Buffer.from(name)]), ...fb,
    ...keys.flatMap((k) => lenField(3, [...Buffer.from(k)])),
    ...vals.flatMap((v) => lenField(4, lenField(1, [...Buffer.from(v)]))),
    ...enc(5 * 8), ...enc(extent)];
  return Buffer.from(lenField(3, layer));
}
module.exports = { decodeMvt, layerToLocal, tilePointToLonLat, lonLatToLocal, encodeMvt, CONST };
