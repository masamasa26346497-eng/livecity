#!/usr/bin/env node
// Mission 160: private, loopback-only (127.0.0.1) multi-ward tile server for the existing viewer. QA only; never public.
//   node tools/mission160-local-serve.mjs [--root temp/mission156] [--port 8160]
// Serves only wards in data/reports/mission156/delivery-manifest.json (HTTP200-verified) whose tiles exist under <root>/<ward>/tiles.
//   GET /manifest.json         -> delivery manifest with tileset URLs rewritten to /w/<ward>/tileset.json (no token, no private URL)
//   GET /w/<ward>/<file>       -> tile files (path-traversal safe)
// Private-Release source: restore first with `mission158-private-release.mjs get ... --out <root>` (token stays in that Node process).
// Hooking the existing 37G viewer WITHOUT editing its HTML: open the viewer, then in the devtools console run
//   (await import('http://127.0.0.1:8160/adapter.mjs')).attach(viewer, Cesium)
// Existing place names / stations / roads / rivers are untouched: this only adds Cesium3DTileset primitives.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function safeWardPath(root, ward, urlPath) {
  if (!/^[a-z0-9-]+$/.test(ward)) return null;
  const base = path.resolve(root, ward, 'tiles');
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const f = path.resolve(base, rel);
  return f === base || f.startsWith(base + path.sep) ? f : null;
}

export function localOrigin(origin) { return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin || ''); }

const ADAPTER = `export async function attach(viewer, Cesium, base = import.meta.url.replace(/\\/adapter\\.mjs.*$/, '')) {
  const m = await (await fetch(base + '/manifest.json')).json();
  const out = [];
  for (const w of m.wards) { const ts = await Cesium.Cesium3DTileset.fromUrl(w.tileset); viewer.scene.primitives.add(ts); out.push(w.ward); }
  return out;
}`;

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const root = path.resolve(opt('root', 'temp/mission156')), port = Number(opt('port', '8160'));
  const man = JSON.parse(fs.readFileSync(new URL('../data/reports/mission156/delivery-manifest.json', import.meta.url), 'utf8'));
  const wards = man.wards.filter((w) => fs.existsSync(path.join(root, w.ward, 'tiles', 'tileset.json')));
  http.createServer((req, res) => {
    const origin = req.headers.origin;
    const h = { 'cache-control': 'no-store' };
    if (localOrigin(origin)) h['access-control-allow-origin'] = origin; // local pages only
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/manifest.json') {
      const self = `http://127.0.0.1:${port}`;
      res.writeHead(200, { ...h, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...man, published: false, wards: wards.map((w) => ({ ...w, tileset: `${self}/w/${w.ward}/tileset.json` })) }));
    }
    if (u.pathname === '/adapter.mjs') { res.writeHead(200, { ...h, 'content-type': 'text/javascript' }); return res.end(ADAPTER); }
    const m = /^\/w\/([a-z0-9-]+)\/(.+)$/.exec(u.pathname);
    const f = m && wards.some((w) => w.ward === m[1]) ? safeWardPath(root, m[1], m[2]) : null;
    if (!f) { res.writeHead(404, h); return res.end(); }
    fs.readFile(f, (e, b) => {
      if (e) { res.writeHead(404, h); return res.end(); }
      res.writeHead(200, { ...h, 'content-type': f.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
      res.end(b);
    });
  }).listen(port, '127.0.0.1', () => console.log(`mission160 serving ${wards.map((w) => w.ward).join(',') || '(none)'} on http://127.0.0.1:${port} (loopback only)`));
}
