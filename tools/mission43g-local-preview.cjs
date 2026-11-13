#!/usr/bin/env node
'use strict';
// Mission 43G: loopback-only, read-only local preview of 43F output that passed the 43G verifier.
//   node tools/mission43g-local-preview.cjs --out-root <43F root> [--src <legacy dir>] [--wards a,b]            (plan only: verifies, prints, serves nothing)
//   node tools/mission43g-local-preview.cjs --out-root <43F root> [--src <legacy dir>] --serve [--port 8137]    (explicit opt-in: starts the server)
// Serves the viewer from public/ plus, under /ext-3dtiles/<ward>/, ONLY verified wards and ONLY the tileset file kinds the viewer needs.
// Binds 127.0.0.1 only. GET/HEAD only. Host/Origin must be loopback. No directory listing. No CORS headers. Links are never followed.
// Nothing is copied into public/, committed, uploaded, put in an artifact or sent to Vercel. The data stays in the 43F output folder.
// "Local" means the DATA is not uploaded. The existing viewer page still loads CesiumJS from the jsDelivr CDN and base-map tiles from
// external tile servers, so the browser opens external connections while viewing. Use the viewer as is: this tool does not change it.
// The viewer's own gates are untouched (?ext= is honoured only on localhost/127.0.0.1; published.json approved===true is unrelated).
const http = require('http');
const fs = require('fs');
const path = require('path');
const V = require('./mission43g-verify-local.cjs');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const PREFIX = '/ext-3dtiles/';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon' };
// the only files inside a verified ward dir that can ever be served
const ALLOWED = [/^tileset\.json$/, /^source\.json$/, /^build-report\.json$/, /^tiles\/[A-Za-z0-9_.-]+\.glb$/, /^lod\/[A-Za-z0-9_.-]+\.glb$/, /^ids\/[A-Za-z0-9_.-]+\.json$/, /^attrs\/[A-Za-z0-9_.-]+\.json$/];

function plan(opts) {
  const rep = V.verifyRoot(opts);
  const servable = rep.wards.filter((w) => w.state === 'verified').map((w) => ({ ward: w.ward, dirName: w.ward + '-a' + w.attempt, buildings: w.buildings }));
  return { report: rep, servable };
}

function hostOk(host, port) { return typeof host === 'string' && (host === '127.0.0.1:' + port || host === 'localhost:' + port); }
function originOk(origin, port) { return origin === undefined || origin === 'http://127.0.0.1:' + port || origin === 'http://localhost:' + port; }

// resolve a public/ request without following links outside it
function resolveStatic(rel) {
  let dec; try { dec = decodeURIComponent(rel); } catch (e) { return null; }
  if (dec.includes('\0') || dec.includes('\\')) return null;
  const abs = path.resolve(PUBLIC, '.' + path.sep + dec.replace(/^\/+/, ''));
  if (!(abs === PUBLIC || abs.startsWith(PUBLIC + path.sep))) return null;
  if (abs.split(path.sep).some((s) => s.startsWith('.') && s.length > 1)) return null; // no dotfiles
  return abs;
}
// <ward>/<rel> inside a verified ward dir; whitelist + regular-file-only + realpath stays inside
function resolveExt(o, servable, rest) {
  let dec; try { dec = decodeURIComponent(rest); } catch (e) { return null; }
  if (dec.includes('\0') || dec.includes('\\') || dec.includes('..')) return null;
  const i = dec.indexOf('/');
  if (i < 1) return null;
  const ward = dec.slice(0, i), rel = dec.slice(i + 1);
  const s = servable.find((x) => x.ward === ward);
  if (!s || !ALLOWED.some((re) => re.test(rel))) return null;
  const base = path.join(o, s.dirName);
  const file = path.join(base, ...rel.split('/'));
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const real = fs.realpathSync(file), realBase = fs.realpathSync(base);
    if (!real.startsWith(realBase + path.sep)) return null;
  } catch (e) { return null; }
  return file;
}

function makeServer(o, servable, getPort) {
  return http.createServer((req, res) => {
    const port = getPort();
    const deny = (c, m) => { res.writeHead(c, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(m); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'method not allowed');
    if (!hostOk(req.headers.host, port)) return deny(403, 'bad host');
    if (!originOk(req.headers.origin, port)) return deny(403, 'bad origin');
    const u = (req.url || '/').split('?')[0];
    let file;
    if (u.startsWith(PREFIX)) file = resolveExt(o, servable, u.slice(PREFIX.length));
    else file = resolveStatic(u === '/' ? '/mission37g-osaka-24ward-mvp.html' : u);
    if (!file) return deny(404, 'not found');
    fs.lstat(file, (e, st) => {
      if (e || !st.isFile() || st.isSymbolicLink()) return deny(404, 'not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  });
}

// start only after a passing verification; returns { server, port }
async function serve(opts) {
  const p = plan(opts);
  if (!p.servable.length) { const e = new Error('nothing verified to serve'); e.code = 3; throw e; }
  const o = V.checkRoot(opts.outRoot);
  let port = Number.isInteger(opts.port) ? opts.port : 8137;
  const server = makeServer(o, p.servable, () => port);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { port = server.address().port; resolve({ server, port, servable: p.servable, report: p.report }); });
  });
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const opts = { outRoot: opt('out-root'), src: opt('src'), wards: opt('wards'), port: opt('port') ? parseInt(opt('port'), 10) : undefined };
  try {
    if (!a.includes('--serve')) {
      const p = plan(opts);
      console.log(JSON.stringify({ mode: 'plan', serving: false, servableWards: p.servable.map((s) => s.ward), report: p.report,
        next: p.servable.length ? 'Add --serve to start the loopback server (127.0.0.1 only).' : 'Nothing verified; nothing can be served.' }, null, 1));
      process.exit(p.report.ok ? 0 : 3);
    }
    serve(opts).then((r) => {
      console.log('serving verified wards [' + r.servable.map((s) => s.ward).join(',') + '] read-only on http://127.0.0.1:' + r.port + ' (loopback only)');
      console.log('open: http://127.0.0.1:' + r.port + '/mission37g-osaka-24ward-mvp.html?ext=' + r.servable.map((s) => s.ward).join(','));
      console.log('note: the page loads CesiumJS (jsDelivr CDN) and base-map tiles from external servers; only the building data stays local.');
    }, (e) => { console.error(Number.isInteger(e.code) ? e.message : 'error: could not start (details suppressed)'); process.exit(Number.isInteger(e.code) ? e.code : 1); });
  } catch (e) {
    console.error(Number.isInteger(e.code) ? e.message : 'error: operation failed (details suppressed)');
    process.exit(Number.isInteger(e.code) ? e.code : 1);
  }
}
module.exports = { plan, serve, makeServer, resolveExt, resolveStatic, hostOk, originOk, ALLOWED };
if (require.main === module) main();
