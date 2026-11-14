#!/usr/bin/env node
'use strict';
// Mission 49: FIX24 analogue. Old Three.js NEAR LOD simplification (tolM=2) moved outlines by up to 49.96 m.
// Does the tracked Cesium leaf GLB still equal the source footprint? Compare GLB-recovered base ring against the
// tracked legacy tile footprint (read-only), per vertex (nearest source vertex) and as polygon area ratio.
//   node tools/mission49-footprint-exact.cjs [--ts public/mission37b-3dtiles/osaka-sumiyoshi-9tile] [--src public/map-data/osaka-city/buildings/osaka-sumiyoshi] [--out file]
const fs = require('fs'), path = require('path');
const G = require('./lib/mission49-glb-footprints.cjs');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const TS = arg('--ts', 'public/mission37b-3dtiles/osaka-sumiyoshi-9tile');
const SRC = arg('--src', 'public/map-data/osaka-city/buildings/osaka-sumiyoshi');
const OUT = arg('--out', 'data/reports/mission49/footprint-exact-sumiyoshi.json');
const src = new Map();
for (const f of fs.readdirSync(SRC)) if (/^tile_.*\.json$/.test(f)) for (const b of JSON.parse(fs.readFileSync(path.join(SRC, f))).buildings) src.set(b.id, b.fp);
const area = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(s) / 2; };
const fps = G.allFootprints(TS);
const dev = []; const ratio = []; let missing = 0, worst = null;
for (const b of fps) {
  const s = src.get(b.id);
  if (!s) { missing++; continue; }
  let mx = 0;
  for (const [x, z] of b.ring) { let m = Infinity; for (const [sx, sz] of s) m = Math.min(m, Math.hypot(x - sx, z - sz)); mx = Math.max(mx, m); }
  dev.push(mx);
  ratio.push(area(b.ring) / Math.max(area(s), 1e-9));
  if (!worst || mx > worst.maxVertexDevM) worst = { id: b.id, maxVertexDevM: +mx.toFixed(3) };
}
dev.sort((a, b) => a - b); ratio.sort((a, b) => a - b);
const q = (a, p) => +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(4);
const rep = {
  generated: new Date().toISOString(), tileset: TS, source: SRC, glbBuildings: fps.length, matchedToSource: dev.length, missingInSource: missing,
  maxVertexDeviationM: { median: q(dev, 0.5), p95: q(dev, 0.95), p99: q(dev, 0.99), max: q(dev, 0.9999) },
  over0_5m: dev.filter((d) => d > 0.5).length, over1m: dev.filter((d) => d > 1).length, over2m: dev.filter((d) => d > 2).length,
  areaRatio: { min: q(ratio, 0), p01: q(ratio, 0.01), median: q(ratio, 0.5), p99: q(ratio, 0.99), max: q(ratio, 0.9999) },
  worst,
  note: 'Float32 GLB + ECEF round trip gives ~cm noise. Old FIX24 symptom (tolM=2 simplification) would show >1 m deviations and area-ratio drift for ~12% of buildings.',
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
console.log(JSON.stringify(rep, null, 1));
