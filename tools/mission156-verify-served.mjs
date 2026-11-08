#!/usr/bin/env node
// Mission 156: serve a generated ward tileset locally (QA only, never public) and verify
//  (1) every URI in tileset.json (recursively) answers HTTP 200,  (2) region bounds are inside Osaka-city,
//  (3) optional headless Chrome + CesiumJS loads it (WebGL JS exceptions captured).
//   node tools/mission156-verify-served.mjs --dir temp/mission156/sumiyoshi/tiles --ward sumiyoshi [--chrome] [--record]
// --record writes http200Verified / browserVerified into data/reports/mission156/progress.json (only when the checks actually pass).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const a = process.argv.slice(2);
const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const dir = path.resolve(opt('dir') || '');
const ward = opt('ward');
if (!opt('dir') || !fs.existsSync(path.join(dir, 'tileset.json'))) { console.error('need --dir <tiles dir with tileset.json>'); process.exit(2); }
const OSAKA = { west: 135.35, east: 135.65, south: 34.5, north: 34.85 };
const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.json': 'application/json', '.glb': 'model/gltf-binary', '.html': 'text/html' };

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = u === '/verify.html' ? path.join(here, 'mission156', 'verify.html') : path.join(dir, path.normalize(u).replace(/^(\.\.[\\/])+/, ''));
  if (!f.startsWith(dir) && u !== '/verify.html') { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

const result = { ward, dir, uris: 0, non200: [], regionOk: null, region: null };
const seen = new Set();
async function crawl(uri) {
  if (seen.has(uri)) return; seen.add(uri);
  const r = await fetch(base + '/' + uri);
  result.uris++;
  if (r.status !== 200) { result.non200.push({ uri, status: r.status }); return; }
  if (uri.endsWith('.json')) {
    const j = await r.json();
    const walk = async (n) => {
      if (n.boundingVolume && n.boundingVolume.region && !result.region) result.region = n.boundingVolume.region;
      const c = n.content && (n.content.uri || n.content.url);
      if (c) await crawl(path.posix.join(path.posix.dirname(uri), c));
      if (n.extras && n.extras.idsUri) await crawl(path.posix.join(path.posix.dirname(uri), n.extras.idsUri));
      for (const ch of n.children || []) await walk(ch);
    };
    if (j.root) await walk(j.root);
  }
}
await crawl('tileset.json');
if (result.region) {
  const [w, s, e, n] = result.region.map((v, i) => (i < 4 ? v * 180 / Math.PI : v));
  result.regionDeg = { west: w, south: s, east: e, north: n };
  result.regionOk = w > OSAKA.west && e < OSAKA.east && s > OSAKA.south && n < OSAKA.north;
}
result.http200 = result.non200.length === 0 && result.uris > 1;

if (a.includes('--chrome')) {
  const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  if (!chrome) result.browser = { status: 'no-chrome' };
  else {
    const prof = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'm156-chrome-'));
    // spawn (async) so this process's http server keeps serving
    const out = await new Promise((resolve) => {
      const p = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
        '--user-data-dir=' + prof, '--virtual-time-budget=40000', '--dump-dom', base + '/verify.html?tileset=/tileset.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      const kill = setTimeout(() => p.kill('SIGKILL'), 120000);
      p.on('close', () => { clearTimeout(kill); resolve({ stdout, stderr }); });
    });
    const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(out.stdout || '');
    try { result.browser = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch (e) { result.browser = { status: 'unparsed', stderr: String(out.stderr || '').slice(0, 300), stdout: String(out.stdout || '').slice(0, 200) }; }
    fs.rmSync(prof, { recursive: true, force: true });
  }
}
server.close();
const b = result.browser;
result.browserOk = !!(b && b.status === 'ok' && b.gl && (b.jsErrors || []).length === 0 && b.tilesLoaded);
console.log(JSON.stringify(result, null, 1));

if (a.includes('--record') && ward) {
  const f = path.resolve('data/reports/mission156/progress.json');
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (p.wards[ward]) {
    p.wards[ward].http200Verified = result.http200 && result.regionOk === true;
    if (a.includes('--chrome')) p.wards[ward].browserVerified = result.browserOk;
    fs.writeFileSync(f, JSON.stringify(p, null, 1));
  }
}
process.exit(result.http200 && result.regionOk ? 0 : 1);
