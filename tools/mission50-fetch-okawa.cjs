#!/usr/bin/env node
'use strict';
// Mission 50: fetch GSI optimal_bvmap-v1 z16 tiles for a small Okawa/Nakanoshima window (Kita/Chuo) into a git-ignored cache. Sequential, public, no key.
//   node tools/mission50-fetch-okawa.cjs --out temp/gsi50/okawa --bbox minX,maxX,minZ,maxZ
const fs = require('fs'), path = require('path'), https = require('https');
const M = require('./lib/mission46d-mvt.cjs');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const out = arg('--out'); const bb = (arg('--bbox') || '').split(',').map(Number);
if (!out || bb.length !== 4 || !/^temp[\\/]/.test(out)) { console.error('usage: --out temp/<dir> --bbox minX,maxX,minZ,maxZ'); process.exit(2); }
const C = M.CONST, z = 16, n = 2 ** z;
const ll = (x, zz) => ({ lon: C.clon + x / (Math.cos(C.clat * Math.PI / 180) * C.mpd), lat: C.clat - zz / C.mpd });
const tile = (lon, lat) => { const s = Math.sin(lat * Math.PI / 180); return { x: Math.floor((lon + 180) / 360 * n), y: Math.floor((1 - Math.log((1 + s) / (1 - s)) / (2 * Math.PI)) / 2 * n) }; };
const a = ll(bb[0], bb[2]), b = ll(bb[1], bb[3]);
const t0 = tile(Math.min(a.lon, b.lon), Math.max(a.lat, b.lat)), t1 = tile(Math.max(a.lon, b.lon), Math.min(a.lat, b.lat));
const list = []; for (let x = t0.x; x <= t1.x; x++) for (let y = t0.y; y <= t1.y; y++) list.push({ x, y });
if (list.length > 20) { console.error('too many tiles ' + list.length); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const get = (t) => new Promise((res, rej) => https.get({ host: 'cyberjapandata.gsi.go.jp', path: '/xyz/optimal_bvmap-v1/' + z + '/' + t.x + '/' + t.y + '.pbf', timeout: 20000, headers: { 'User-Agent': 'livecity-mission50 (read-only research; github masamasa26346497-eng/livecity)' } }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ s: r.statusCode, b: Buffer.concat(c) })); }).on('error', rej));
(async () => {
  const rep = [];
  for (const t of list) {
    const r = await get(t); if (r.s !== 200) { rep.push(Object.assign({}, t, { status: r.s })); continue; }
    fs.writeFileSync(path.join(out, z + '_' + t.x + '_' + t.y + '.pbf'), r.b);
    const L = M.decodeMvt(r.b);
    rep.push(Object.assign({}, t, { status: 200, bytes: r.b.length, layers: Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.features.length])) }));
    await new Promise((s) => setTimeout(s, 1000));
  }
  console.log(JSON.stringify(rep));
})();
