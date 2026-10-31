#!/usr/bin/env node
'use strict';
// Read-only: 阪和病院/阪和記念病院の 36L 索引エントリと、旧/新病棟の座標が属する footprint を Live City 座標系で照合する。
// geoToThree() と同一の局所正角円筒図法（CLAT/CLON/MPD は osaka_3d_buildings.html の定数と同じ）。
const fs = require('node:fs'), path = require('node:path');
const R = path.resolve(__dirname, '..', 'public', 'map-data', 'osaka-city') + '/';
const D = R + 'buildings/osaka-sumiyoshi/';
const idx = JSON.parse(fs.readFileSync(R + 'derived/building-photo-index.json', 'utf8'));
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320;
const toXZ = (lat, lon) => [(lon - CLON) * Math.cos(CLAT * Math.PI / 180) * MPD, -((lat - CLAT) * MPD)];
const inPoly = (p, fp) => { let c = false; for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) { const [a, b] = fp[i], [x, y] = fp[j]; if ((b > p[1]) !== (y > p[1]) && p[0] < (x - a) * (p[1] - b) / (y - b) + a) c = !c; } return c; };
const all = [];
for (const f of fs.readdirSync(D).filter((f) => /^tile_/.test(f))) for (const b of JSON.parse(fs.readFileSync(D + f, 'utf8')).buildings) all.push(b);
const pts = { wikidataHanwaHospital: [34.6044, 135.5051], wikidataMemorial2022: [34.6038056, 135.5036944] };
const dist = (a, b) => { const [x1, z1] = toXZ(...a), [x2, z2] = toXZ(...b); return Math.hypot(x1 - x2, z1 - z2); };
console.log('distance between points (m):', dist(pts.wikidataHanwaHospital, pts.wikidataMemorial2022).toFixed(1));
for (const [k, p] of Object.entries(pts)) {
  const q = toXZ(...p);
  console.log(k, 'xz', q.map((v) => v.toFixed(1)).join(','));
  console.log('  inside:', all.filter((b) => inPoly(q, b.fp)).map((b) => b.id + ' h' + b.h + ' usage' + b.usage).join(' | ') || 'none');
  console.log('  nearest(<60m rep):', all.map((b) => [b, Math.hypot(b.repX - q[0], b.repZ - q[1])]).filter((x) => x[1] < 60).sort((a, b) => a[1] - b[1]).slice(0, 6).map(([b, d]) => b.id + ' d' + d.toFixed(0) + ' h' + b.h + ' u' + b.usage).join(' | '));
}
for (const k of Object.keys(idx.byCanonicalId).filter((k) => /hanwa|阪和/i.test(JSON.stringify(idx.byCanonicalId[k])))) console.log(k, JSON.stringify(idx.byCanonicalId[k]));
