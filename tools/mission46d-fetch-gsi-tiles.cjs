#!/usr/bin/env node
'use strict';
// Mission 46D-R2: fetch GSI vector tiles (optimal_bvmap-v1, BldA/RdEdg) covering each ward bbox. Free public data, no key.
//   node tools/mission46d-fetch-gsi-tiles.cjs --out <cache dir> [--wards a,b] [--zoom 16] [--max-tiles-per-ward 40] [--max-requests 200] [--margin 100] [--plan]
// --inside-only keeps tiles whose centre is inside the ward polygon; --sample N takes an evenly spaced N of them (a SAMPLE, not full coverage).
// Output: <out>/<wardId>/<z>_<x>_<y>.pbf (+ <out>/fetch-manifest.json). The cache dir must be OUTSIDE the repo or git-ignored (refused if inside tracked tree).
// Source: GSI (Geospatial Information Authority of Japan) vector tile, https://maps.gsi.go.jp/development/ichiran.html — cite GSI when publishing.
// Safety: only https://cyberjapandata.gsi.go.jp is contacted; sequential; timeout + bounded retries; responses checked (size, MVT decode).
const fs = require('fs');
const path = require('path');
const https = require('https');
const M = require('./lib/mission46d-mvt.cjs');
const ROOT = path.resolve(__dirname, '..');
const HOST = 'cyberjapandata.gsi.go.jp';
const BASE_PATH = '/xyz/optimal_bvmap-v1/';
const MAX_BYTES = 2 * 1024 * 1024;
const UA = 'livecity-mission46d-accuracy/1 (read-only research; contact via GitHub masamasa26346497-eng/livecity)';
const R2D = 180 / Math.PI;

// local metres -> lon/lat (inverse of the existing geoToThree constants)
function localToLonLat(x, z) {
  const C = M.CONST;
  return { lon: C.clon + x / (Math.cos((C.clat * Math.PI) / 180) * C.mpd), lat: C.clat - z / C.mpd };
}
function lonLatToTile(lon, lat, zoom) {
  const n = 2 ** zoom, s = Math.sin((lat * Math.PI) / 180);
  return { x: Math.floor(((lon + 180) / 360) * n), y: Math.floor(((1 - Math.log((1 + s) / (1 - s)) / (2 * Math.PI)) / 2) * n) };
}
// all tiles covering bbox (+margin metres)
function tilesForBbox(bbox, zoom, margin = 0) {
  const a = localToLonLat(bbox.minX - margin, bbox.minZ - margin), b = localToLonLat(bbox.maxX + margin, bbox.maxZ + margin);
  const t0 = lonLatToTile(Math.min(a.lon, b.lon), Math.max(a.lat, b.lat), zoom), t1 = lonLatToTile(Math.max(a.lon, b.lon), Math.min(a.lat, b.lat), zoom);
  const out = [];
  for (let x = t0.x; x <= t1.x; x++) for (let y = t0.y; y <= t1.y; y++) out.push({ z: zoom, x, y });
  return out;
}
// tile centre in local metres
function tileCenterLocal(t) { const g = M.tilePointToLonLat(t.z, t.x, t.y, 2, 1, 1); const l = M.lonLatToLocal(g.lon, g.lat); return [l.x, l.z]; }
function inRing(x, z, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, zi] = ring[i], [xj, zj] = ring[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; }
// keep only tiles whose centre is inside the ward polygon (outer minus holes); optionally an evenly spaced sample of n tiles
function sampleWardTiles(ward, tiles, n) {
  const polys = ward.polygons || [];
  const inside = tiles.filter((t) => { const [x, z] = tileCenterLocal(t); return polys.some((p) => inRing(x, z, p.outer) && !(p.holes || []).some((h) => inRing(x, z, h))); });
  if (!n || inside.length <= n) return inside;
  const step = inside.length / n; return Array.from({ length: n }, (_, i) => inside[Math.floor(i * step)]);
}
const tileName = (t) => t.z + '_' + t.x + '_' + t.y + '.pbf';
const safeWardId = (id) => /^[a-z][a-z0-9-]{1,31}$/.test(id);

function assertOutDirSafe(out) {
  const abs = path.resolve(out), rel = path.relative(ROOT, abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    // inside repo: only allow git-ignored locations
    const ok = /^(temp|data[\\/]cache)[\\/]/.test(rel + path.sep) || rel.startsWith('temp') || rel.startsWith(path.join('data', 'cache'));
    if (!ok) throw new Error('refusing to write tiles inside the repo outside temp/ or data/cache/: ' + rel);
  }
  return abs;
}

// pure response validation (unit-tested)
function validateTileBuffer(buf) {
  if (!buf || !buf.length) return { ok: false, reason: 'empty' };
  if (buf.length > MAX_BYTES) return { ok: false, reason: 'too large' };
  const head = buf.slice(0, 16).toString('latin1');
  if (/^\s*</.test(head) || /^\s*\{/.test(head)) return { ok: false, reason: 'looks like html/json, not a tile' };
  try {
    const layers = M.decodeMvt(buf);
    const names = Object.keys(layers);
    if (!names.length) return { ok: false, reason: 'no layers' };
    return { ok: true, layers: names, bldA: layers.BldA ? layers.BldA.features.length : 0, rdEdg: layers.RdEdg ? layers.RdEdg.features.length : 0 };
  } catch (e) { return { ok: false, reason: 'decode failed: ' + e.message }; }
}

function httpGet(t, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: HOST, path: BASE_PATH + t.z + '/' + t.x + '/' + t.y + '.pbf', headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' }, timeout: timeoutMs }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > MAX_BYTES) { req.destroy(new Error('response too large')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTile(t, opts, get = httpGet) {
  let lastErr = null;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const r = await get(t, opts.timeoutMs);
      if (r.status === 404) return { state: 'absent' }; // GSI has no tile there (e.g. sea)
      if (r.status === 200) { const v = validateTileBuffer(r.body); return v.ok ? { state: 'ok', body: r.body, info: v } : { state: 'invalid', reason: v.reason }; }
      if (r.status === 429 || r.status >= 500) lastErr = new Error('HTTP ' + r.status); else return { state: 'error', reason: 'HTTP ' + r.status };
    } catch (e) { lastErr = e; }
    if (attempt < opts.retries) await sleep(opts.backoffMs * 2 ** attempt);
  }
  return { state: 'error', reason: lastErr ? lastErr.message : 'unknown' };
}

async function run(opts, wards, get = httpGet) {
  const out = assertOutDirSafe(opts.out);
  const plan = [], skippedWards = [];
  for (const w of wards) {
    if (!safeWardId(w.wardId)) throw new Error('unsafe wardId ' + w.wardId);
    let tiles = tilesForBbox(w.bbox, opts.zoom, opts.margin);
    if (opts.insideOnly) tiles = sampleWardTiles(w, tiles, opts.sample);
    if (tiles.length > opts.maxTilesPerWard) { skippedWards.push({ wardId: w.wardId, tilesNeeded: tiles.length, reason: 'exceeds --max-tiles-per-ward' }); continue; }
    plan.push({ wardId: w.wardId, tiles });
  }
  const totalTiles = plan.reduce((s, p) => s + p.tiles.length, 0);
  const manifest = { schema: 'livecity.mission46d.gsi-fetch/1', source: 'GSI optimal_bvmap-v1 (BldA, RdEdg) https://' + HOST + BASE_PATH, zoom: opts.zoom, margin: opts.margin,
    fetchedAt: new Date().toISOString(), plannedTiles: totalTiles, skippedWards, wards: {} };
  if (opts.plan) return { manifest, written: 0, requests: 0 };
  let requests = 0, stoppedByCap = false;
  for (const p of plan) {
    const dir = path.join(out, p.wardId); fs.mkdirSync(dir, { recursive: true });
    const st = { requested: p.tiles.length, ok: 0, cached: 0, absent: 0, invalid: 0, error: 0, bldAFeatures: 0, rdEdgFeatures: 0 };
    for (const t of p.tiles) {
      const file = path.join(dir, tileName(t));
      if (fs.existsSync(file)) { st.cached++; continue; }
      if (requests >= opts.maxRequests) { stoppedByCap = true; break; }
      requests++;
      const r = await fetchTile(t, opts, get);
      if (r.state === 'ok') { const tmp = file + '.tmp'; fs.writeFileSync(tmp, r.body); fs.renameSync(tmp, file); st.ok++; st.bldAFeatures += r.info.bldA; st.rdEdgFeatures += r.info.rdEdg; }
      else st[r.state]++;
      if (opts.delayMs) await sleep(opts.delayMs);
    }
    manifest.wards[p.wardId] = st;
    if (stoppedByCap) break;
  }
  manifest.requests = requests; manifest.stoppedByRequestCap = stoppedByCap;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'fetch-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, requests };
}

async function main() {
  const a = process.argv.slice(2), get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  if (!get('--out')) { console.error('usage: --out <cache dir> [--wards a,b] [--zoom 16] [--max-tiles-per-ward 40] [--max-requests 200] [--margin 100] [--plan] [--inside-only] [--sample N]'); process.exit(2); }
  const opts = { out: get('--out'), zoom: +get('--zoom', 16), maxTilesPerWard: +get('--max-tiles-per-ward', 40), maxRequests: +get('--max-requests', 200), margin: +get('--margin', 100),
    retries: 3, backoffMs: 1000, timeoutMs: 15000, delayMs: 300, plan: a.includes('--plan'), insideOnly: a.includes('--inside-only') || !!get('--sample'), sample: +get('--sample', 0) };
  if (!(opts.zoom >= 14 && opts.zoom <= 16)) { console.error('zoom must be 14..16 (optimal_bvmap-v1 max is 16)'); process.exit(2); }
  const only = get('--wards') ? get('--wards').split(',') : null;
  const wards = require(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json')).wards.filter((w) => !only || only.includes(w.wardId));
  const r = await run(opts, wards);
  console.error('planned ' + r.manifest.plannedTiles + ' tiles, requests ' + r.requests + ', skipped wards ' + r.manifest.skippedWards.length);
  console.log(JSON.stringify(r.manifest, null, 2));
}
module.exports = { sampleWardTiles, localToLonLat, lonLatToTile, tilesForBbox, tileName, validateTileBuffer, fetchTile, run, assertOutDirSafe };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
