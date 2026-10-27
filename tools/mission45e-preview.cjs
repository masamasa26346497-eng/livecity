#!/usr/bin/env node
'use strict';
// Mission 45E: loopback-only, read-only local preview of a Mission 45D output root (24 wards, local 3D Tiles).
//   node tools/mission45e-preview.cjs --src <legacy buildings dir> [--out-root <45D root>]            (plan: verifies, serves nothing)
//   node tools/mission45e-preview.cjs --src <legacy buildings dir> [--out-root <45D root>] --serve [--port 8137]
// 45D layout: <root>/.livecity-45d-root.json, state.json, completion.json, pc23/<ward>-aN (23 wards, 43F), sumiyoshi-aN/sumiyoshi (nested).
// Nothing is trusted from state.json / completion.json alone: the 45D verify-only proof is recomputed from the files on disk
// against the legacy source (complete, 24/24 wards, sourceBuildings === convertedBuildings), and only then is each ward mapped.
// Binds 127.0.0.1 only. GET/HEAD only. Host/Origin must be loopback. Whitelisted file kinds, regular files only, realpath must stay in the
// ward dir, links are never followed. No writes, no deletes, no copies into public/, Git, Vercel, an artifact or a OneDrive folder.
// "Local" means the DATA is not uploaded. The viewer page still loads CesiumJS (jsDelivr CDN) and base-map tiles from external servers.
const http = require('http');
const fs = require('fs');
const path = require('path');
const D = require('./mission45d-convert-all.cjs');
const G = require('./mission43g-verify-local.cjs');
const P = require('./mission43g-local-preview.cjs');

const ROOT = path.resolve(__dirname, '..');
const PREFIX = '/ext-3dtiles/';
const INDEX = 'index.json';
const PAGE = '/mission37g-osaka-24ward-mvp.html';
const SCHEMA = 'livecity.mission45e.preview/1';
const err = (msg, code) => Object.assign(new Error(msg), { code });
const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };
const registry = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;

function defaultRoot() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'LiveCity-3DTiles-Out-24');
  return null;
}
// OneDrive / sync roots: refuse to serve out of a folder that a sync client could be uploading (same rule as 45D convert).
function syncRoots() {
  const r = [];
  for (const v of [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]) if (v) r.push(v);
  if (process.env.USERPROFILE) r.push(path.join(process.env.USERPROFILE, 'OneDrive'));
  return r.map((x) => path.resolve(x));
}
function underSync(p) {
  const q = path.resolve(p).toLowerCase() + path.sep;
  return syncRoots().some((s) => q.startsWith(s.toLowerCase() + path.sep));
}

// Recompute the 45D proof and map every ward to its on-disk tileset dir. Throws a coded, path-free error on any doubt.
function plan(opts) {
  const outRoot = opts.outRoot || defaultRoot();
  if (!outRoot) throw err('--out-root required (no default outside Windows)', 2);
  if (!opts.src) throw err('--src (legacy buildings dir) required: the proof is recomputed against the source', 2);
  if (underSync(outRoot)) throw err('output root is inside a OneDrive sync root; refusing', 4);
  const o = path.resolve(outRoot);
  const st = lst(o);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) throw err('45D root missing or not a real directory', 4);
  let marker = null; try { marker = JSON.parse(fs.readFileSync(path.join(o, D.MARKER), 'utf8')); } catch (e) { /* foreign */ }
  if (!marker || marker.schema !== D.SCHEMA) throw err('45D root marker missing or foreign', 4);
  // 45D verify-only: re-proves everything from disk (also enforces root outside repo / separate from source / no links)
  const proof = D.run({ src: opts.src, outRoot: o, verifyOnly: true, synthetic: false, sumiyoshiRun: opts.sumiyoshiRun });
  const synthetic = proof.kind === 'synthetic';
  if (proof.mode === 'refused') throw err('source audit not ready', 3);
  if (synthetic && !opts.allowSynthetic) throw err('synthetic proof refused', 3);
  const reg = registry();
  if (proof.complete !== true || proof.verifiedWards !== 24 || proof.totalWards !== 24 || proof.sourceBuildings !== proof.convertedBuildings || proof.failures !== 0) {
    const e = err('45D proof not complete (' + proof.verifiedWards + '/24 wards); nothing is served', 3); e.proof = proof; throw e;
  }
  const dirs = {};
  // 23 PC wards: 43G re-verification of pc23/ (marker + per-ward disk checks) -> pc23/<ward>-aN
  const pcRoot = path.join(o, 'pc23');
  const pcV = G.verifyRoot({ outRoot: pcRoot, src: require('./mission43f-pc-convert.cjs').checkSource(opts.src) });
  for (const w of pcV.wards) if (w.state === 'verified') dirs[w.ward] = { dir: path.join(pcRoot, w.ward + '-a' + w.attempt), buildings: w.buildings };
  // Sumiyoshi: state.json gives the attempt number only; the tileset dir is what is actually on disk (nested preferred)
  const state = D.readState(o);
  const sEntry = state && state.sumiyoshi;
  if (sEntry && sEntry.state === 'ok' && Number.isInteger(sEntry.attempt)) {
    const d = D.sumiyoshiOutDir(path.join(o, 'sumiyoshi-a' + sEntry.attempt));
    if (d) dirs.sumiyoshi = { dir: d, buildings: sEntry.buildings };
  }
  const servable = reg.filter((w) => dirs[w.id]).map((w) => ({ ward: w.id, wardCode: w.code, dir: dirs[w.id].dir, buildings: dirs[w.id].buildings }));
  if (servable.length !== 24) { const e = err('only ' + servable.length + '/24 wards map to an on-disk tileset; nothing is served', 3); throw e; }
  return { outRoot: o, proof, servable, synthetic };
}

// 45F: verified=true only when plan() recomputed a complete, non-synthetic 45D proof (24/24, source == converted). The viewer uses it for the full/partial label.
function indexJson(servable, synthetic) {
  return JSON.stringify({ schema: SCHEMA, kind: 'local-only', verified: synthetic === false, wards: servable.map((s) => ({ ward: s.ward, wardCode: s.wardCode, buildings: s.buildings })) });
}
// <ward>/<rel> inside a servable ward dir; whitelist + regular-file-only + realpath stays inside
function resolveExt(servable, rest) {
  let dec; try { dec = decodeURIComponent(rest); } catch (e) { return null; }
  if (dec.includes('\0') || dec.includes('\\') || dec.includes('..')) return null;
  const i = dec.indexOf('/');
  if (i < 1) return null;
  const ward = dec.slice(0, i), rel = dec.slice(i + 1);
  const s = servable.find((x) => x.ward === ward);
  if (!s || !P.ALLOWED.some((re) => re.test(rel))) return null;
  const file = path.join(s.dir, ...rel.split('/'));
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const real = fs.realpathSync(file), realBase = fs.realpathSync(s.dir);
    if (!real.startsWith(realBase + path.sep)) return null;
  } catch (e) { return null; }
  return file;
}
function makeServer(servable, getPort, synthetic) {
  const idx = Buffer.from(indexJson(servable, synthetic));
  return http.createServer((req, res) => {
    const port = getPort();
    const deny = (c, m) => { res.writeHead(c, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(m); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'method not allowed');
    if (!P.hostOk(req.headers.host, port)) return deny(403, 'bad host');
    if (!P.originOk(req.headers.origin, port)) return deny(403, 'bad origin');
    const u = (req.url || '/').split('?')[0];
    if (u === PREFIX + INDEX) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': idx.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : idx);
    }
    const file = u.startsWith(PREFIX) ? resolveExt(servable, u.slice(PREFIX.length)) : P.resolveStatic(u === '/' ? PAGE : u);
    if (!file) return deny(404, 'not found');
    fs.lstat(file, (e, st) => {
      if (e || !st.isFile() || st.isSymbolicLink()) return deny(404, 'not found');
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon' })[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  });
}
async function serve(opts) {
  const p = plan(opts);
  let port = Number.isInteger(opts.port) ? opts.port : 8137;
  const server = makeServer(p.servable, () => port, p.synthetic);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { port = server.address().port; resolve({ server, port, plan: p }); });
  });
}
function summary(p) {
  return { schema: SCHEMA, readOnly: true, uploaded: 0, uploadAllowed: 0, published: false, gates: G.GATES, kind: p.synthetic ? 'synthetic' : 'real',
    verifiedWards: p.proof.verifiedWards, sourceBuildings: p.proof.sourceBuildings, convertedBuildings: p.proof.convertedBuildings, servableWards: p.servable.length,
    scope: 'LOCAL VIEWING ONLY. Not publication; licence / secret / personal-data gates stay false.' };
}
function main() {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const opts = { src: opt('src'), outRoot: opt('out-root'), port: opt('port') ? parseInt(opt('port'), 10) : undefined };
  const fail = (e) => { console.error(Number.isInteger(e.code) ? e.message : 'error: operation failed (details suppressed)'); process.exit(Number.isInteger(e.code) ? e.code : 1); };
  try {
    if (!a.includes('--serve')) { console.log(JSON.stringify(Object.assign({ mode: 'plan', serving: false }, summary(plan(opts))), null, 1)); process.exit(0); }
    serve(opts).then((r) => {
      console.log(JSON.stringify(summary(r.plan)));
      console.log('serving 24 verified wards read-only on http://127.0.0.1:' + r.port + ' (loopback only)');
      console.log('open: http://127.0.0.1:' + r.port + PAGE + '?ext45=1');
      console.log('note: the page loads CesiumJS (jsDelivr CDN) and base-map tiles from external servers; only the building data stays local.');
    }, fail);
  } catch (e) { fail(e); }
}
module.exports = { plan, serve, makeServer, resolveExt, indexJson, underSync, SCHEMA, PREFIX };
if (require.main === module) main();
