#!/usr/bin/env node
// Mission 182A: same-viewpoint coexistence measurement in headless Chrome + CesiumJS (local 127.0.0.1 only, QA).
//   node tools/mission182/compare-views.mjs --full <lod1 dir> --complement <dir> --standin <dir> --out <report.json>
// Views (identical camera from --full's bounding sphere):
//   V1 = full LOD1                      (baseline, today's LOD1-only output)
//   V2 = complement only                (LOD1 minus buildings that have LOD2)
//   V3 = complement + stand-in          (stand-in = LOD1 extrusions of the LOD2 ids; QA proxy for real LOD2 meshes)
// Expectations: V3 == V1 pixel-wise (no building lost, no double draw); V2 != V1 (removed buildings are really gone).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : null; };
const dirs = { F: path.resolve(opt('full')), C: path.resolve(opt('complement')), S: path.resolve(opt('standin')) };
const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.json': 'application/json', '.glb': 'model/gltf-binary', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f;
  if (u === '/compare.html') f = path.join(here, 'compare.html');
  else { const m = /^\/([FCS])\/(.*)$/.exec(u); if (m) f = path.join(dirs[m[1]], path.normalize('/' + m[2])); }
  if (!f || (f !== path.join(here, 'compare.html') && !Object.values(dirs).some((d) => f.startsWith(d)))) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('no chrome'); process.exit(2); }

async function view(ts) {
  const prof = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'm182-chrome-'));
  const url = base + '/compare.html?ref=/F/tileset.json&ts=' + ts.join(',');
  const out = await new Promise((resolve) => {
    const p = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--user-data-dir=' + prof, '--virtual-time-budget=60000', '--dump-dom', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    p.stdout.on('data', (d) => { so += d; });
    const k = setTimeout(() => p.kill('SIGKILL'), 150000);
    p.on('close', () => { clearTimeout(k); resolve(so); });
  });
  fs.rmSync(prof, { recursive: true, force: true });
  const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(out);
  try { return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch { return { status: 'unparsed' }; }
}
const diff = (x, y) => { let n = 0; for (let i = 0; i < x.length; i += 3) if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 24) n++; return n; };
const nonBg = (x) => { let n = 0; const b = [x[0], x[1], x[2]]; for (let i = 0; i < x.length; i += 3) if (Math.abs(x[i] - b[0]) + Math.abs(x[i + 1] - b[1]) + Math.abs(x[i + 2] - b[2]) > 24) n++; return n; };

const V = { V1_fullLod1: await view(['/F/tileset.json']), V2_complementOnly: await view(['/C/tileset.json']), V3_complementPlusStandin: await view(['/C/tileset.json', '/S/tileset.json']) };
server.close();
const px = {};
for (const [k, v] of Object.entries(V)) px[k] = v.rgb64 ? Buffer.from(v.rgb64, 'base64') : null;
const rep = { views: {}, pixelDiffs: {} };
for (const [k, v] of Object.entries(V)) { const { rgb64, ...rest } = v; rep.views[k] = { ...rest, buildingPixels: px[k] ? nonBg(px[k]) : null }; }
if (px.V1_fullLod1 && px.V2_complementOnly && px.V3_complementPlusStandin) {
  rep.pixelDiffs = { 'V1_vs_V2 (removed LOD2 buildings visible as gap)': diff(px.V1_fullLod1, px.V2_complementOnly), 'V1_vs_V3 (must be ~0: no loss, no double draw)': diff(px.V1_fullLod1, px.V3_complementPlusStandin), totalPx: 640 * 400 };
}
const o = opt('out');
if (o) { fs.mkdirSync(path.dirname(path.resolve(o)), { recursive: true }); fs.writeFileSync(o, JSON.stringify(rep, null, 1)); }
console.log(JSON.stringify(rep, null, 1));
