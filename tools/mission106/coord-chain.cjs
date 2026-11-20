// Mission 106: coordinate-chain fixture (offline, read-only, no network).
// local(x east, z south-positive) -> WGS84 -> ECEF -> tile ENU. Expected: ENU east == x - tileCenterX, north == -(z - tileCenterZ), up ~ 0.
// Reports round-trip error at 9 points per ward bbox. No shift/offset patch exists or is applied.
'use strict';
const b = require('../mission37b-build-3dtiles.cjs');
const wardsData = require('../../public/mission37g-data/osaka-24-wards.json');
const TILE = 500, D2R = Math.PI / 180, WA = 6378137, WE2 = 0.00669437999014;
const ecef = (lon, lat, h) => { const l = lon * D2R, p = lat * D2R, s = Math.sin(p), c = Math.cos(p), N = WA / Math.sqrt(1 - WE2 * s * s); return [(N + h) * c * Math.cos(l), (N + h) * c * Math.sin(l), (N * (1 - WE2) + h) * s]; };
const dot = (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
function probe(x, z, h = 0) {
  const lon = b.localToLon(x), lat = b.localToLat(z);
  const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
  const cx = (tx + 0.5) * TILE, cz = (tz + 0.5) * TILE;
  const f = b.makeFrame(b.localToLon(cx), b.localToLat(cz));
  const p = ecef(lon, lat, h), d = [p[0] - f.t[0], p[1] - f.t[1], p[2] - f.t[2]];
  const e = dot(d, f.b.e), n = dot(d, f.b.n), u = dot(d, f.b.u);
  return { x, z, lon, lat, tile: [tx, tz], enu: [e, n, u], errEast: e - (x - cx), errNorth: n - (-(z - cz)), errUp: u - h };
}
function wardSamples(w) {
  const { minX, maxX, minZ, maxZ } = w.bbox, pts = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) pts.push(probe(minX + (maxX - minX) * (i + .5) / 3, minZ + (maxZ - minZ) * (j + .5) / 3));
  return pts;
}
function run() {
  return wardsData.wards.map(w => {
    const s = wardSamples(w), mx = (k) => Math.max(...s.map(p => Math.abs(p[k])));
    return { wardId: w.wardId, wardCode: w.wardCode, samples: s.length, maxAbsEastErrM: mx('errEast'), maxAbsNorthErrM: mx('errNorth'), maxAbsUpErrM: mx('errUp') };
  });
}
module.exports = { probe, run, wardSamples };
if (require.main === module) console.log(JSON.stringify(run(), null, 1));
