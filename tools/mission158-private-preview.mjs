#!/usr/bin/env node
// Mission 158: LOCAL-ONLY preview of tiles stored in the private Release. The credential stays in this Node process;
// the browser only talks to http://127.0.0.1 and never sees a token. Binds to loopback only. Not for publishing.
//   LIVECITY_3D_DATA_TOKEN=... node tools/mission158-private-preview.mjs --tag m158-<id> --ward sumiyoshi [--port 8158]
// Restores the ward archive (hash-checked) via mission158-private-release.mjs `get`, then serves <dir>/tileset.json.
// Canonical viewer hookup (no HTML edit): in the viewer page console / a local QA wrapper use
//   import('/tools/mission156/viewer-adapter.mjs') or point a Cesium3DTileset at http://127.0.0.1:8158/tileset.json
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const a = process.argv.slice(2);
const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const tag = opt('tag'), ward = opt('ward'), port = Number(opt('port', '8158'));
if (!tag || !ward) { console.error('need --tag --ward'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(opt('out', 'temp/mission158/preview'));
execFileSync(process.execPath, [path.join(here, 'mission158-private-release.mjs'), 'get', '--tag', tag, '--ward', ward, '--out', outDir], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
const root = path.join(outDir, ward);
const MIME = { '.json': 'application/json', '.glb': 'model/gltf-binary' };
http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(root, path.normalize(u).replace(/^(\.\.[\\/])+/, ''));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    // CORS limited to local origins so a local viewer page can fetch tiles; no credentials exposed
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(b);
  });
}).listen(port, '127.0.0.1', () => console.log(`preview http://127.0.0.1:${port}/tileset.json (loopback only, QA only)`));
