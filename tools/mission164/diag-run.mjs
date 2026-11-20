#!/usr/bin/env node
// Mission 164: run diag.html against a generated tileset dir in headless Chrome.
//   node tools/mission164/diag-run.mjs <tilesDir> [view|set] [--no-vtb]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(process.argv[2]);
const cam = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'view';
const noVtb = process.argv.includes('--no-vtb');
const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.json': 'application/json', '.glb': 'model/gltf-binary', '.html': 'text/html' };
const reqs = [];
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  reqs.push(u);
  const f = u === '/diag.html' ? path.join(here, 'diag.html') : path.join(dir, path.normalize(u));
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + srv.address().port;
const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const prof = fs.mkdtempSync('/tmp/m164-');
const args = ['--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--window-size=1280,800', '--user-data-dir=' + prof, ...(noVtb ? [] : ['--virtual-time-budget=60000']),
  '--dump-dom', base + '/diag.html?cam=' + cam + '&tileset=/tileset.json'];
const out = await new Promise((resolve) => {
  const p = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let so = '';
  p.stdout.on('data', (d) => { so += d; });
  p.stderr.on('data', () => {});
  const k = setTimeout(() => p.kill('SIGKILL'), 150000);
  p.on('close', () => { clearTimeout(k); resolve(so); });
});
const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(out);
let r;
try { r = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch { r = { unparsed: out.slice(0, 300) }; }
r.serverRequests = { total: reqs.length, glb: reqs.filter((x) => x.endsWith('.glb')).length };
console.log(JSON.stringify(r, null, 1));
srv.close();
fs.rmSync(prof, { recursive: true, force: true });
