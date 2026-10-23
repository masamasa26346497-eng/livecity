#!/usr/bin/env node
// Mission 40F: serve public/ plus locally converted 3D Tiles (not in Git) on 127.0.0.1, read-only.
//   node tools/mission40f-serve-local.cjs --ext ..\livecity-3dtiles-out-fukushima [--port 8137]
//   <ext>/<name>/tileset.json  ->  /ext-3dtiles/<name>/tileset.json   (open /mission37g-osaka-24ward-mvp.html?ext=<name>)
// GET/HEAD only, loopback only, no directory listing, path traversal rejected. Nothing is copied, written or deleted.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon' };
const PREFIX = '/ext-3dtiles/';

function resolveUnder(root, rel) {
  let dec; try { dec = decodeURIComponent(rel); } catch (e) { return null; }
  if (dec.includes('\0')) return null;
  const r = path.resolve(root);
  const abs = path.resolve(r, '.' + path.sep + dec.replace(/^[/\\]+/, ''));
  return abs === r || abs.startsWith(r + path.sep) ? abs : null;
}
function makeServer(opts) {
  const pub = path.resolve(opts.publicDir), ext = opts.extDir ? path.resolve(opts.extDir) : null;
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }
    const u = (req.url || '/').split('?')[0];
    let file;
    if (u.startsWith(PREFIX)) {
      if (!ext) { res.writeHead(404); return res.end('no --ext'); }
      file = resolveUnder(ext, u.slice(PREFIX.length));
    } else file = resolveUnder(pub, u === '/' ? '/mission37g-osaka-24ward-mvp.html' : u);
    if (!file) { res.writeHead(400); return res.end('bad path'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
}
module.exports = { makeServer, resolveUnder };

if (require.main === module) {
  const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const ext = get('--ext'), port = +(get('--port') || 8137);
  const pub = path.join(__dirname, '..', 'public');
  if (!ext || !fs.existsSync(ext)) { console.error('usage: --ext <dir containing <ward>/tileset.json>'); process.exit(2); }
  const names = fs.readdirSync(ext, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(ext, d.name, 'tileset.json'))).map((d) => d.name);
  if (!names.length) { console.error('no <ward>/tileset.json under ' + ext); process.exit(2); }
  makeServer({ publicDir: pub, extDir: ext }).listen(port, '127.0.0.1', () => {
    console.log('serving public/ + ' + ext + ' (read-only) on http://127.0.0.1:' + port);
    console.log('open: http://127.0.0.1:' + port + '/mission37g-osaka-24ward-mvp.html?ext=' + names.join(','));
  });
}
