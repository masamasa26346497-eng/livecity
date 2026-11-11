#!/usr/bin/env node
// Mission 154: read-only check that the page the browser gets is the current one and that the town-label data is connected.
//   node tools/mission154-refresh.mjs [--port 8137] [--roots C:\lc141,temp/mission141]
// Reports: build id on disk vs. the id served by a running server (stale server / stale copy), towns-24.json (committed) and towns-24.local.json counts,
// and any stray copies of the viewer HTML under the given data roots. It never writes, deletes or resets anything (no destructive git commands).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'mission37g-osaka-24ward-mvp.html';
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const buildOf = (html) => (/const BUILD_ID = '([^']+)'/.exec(html) || [])[1] || null;
const townCount = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return { n: j.towns.length, wards: new Set(j.towns.map((t) => t.w)).size }; } catch (e) { return null; } };
const get = (url) => new Promise((res) => {
  const r = http.get(url, { timeout: 3000 }, (x) => { let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => res({ status: x.statusCode, body: b })); });
  r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
});

const disk = buildOf(fs.readFileSync(path.join(ROOT, 'public', PAGE), 'utf8'));
console.log('[154] build on disk (this checkout): ' + disk);
const c = townCount(path.join(ROOT, 'public/mission145-data/towns-24.json'));
console.log('[154] committed towns-24.json: ' + (c ? c.n + ' units / ' + c.wards + ' wards' : 'MISSING -> run: git pull (file is tracked)'));
const l = townCount(path.join(ROOT, 'public/mission145-data/towns-24.local.json'));
console.log('[154] towns-24.local.json (optional, generated): ' + (l ? l.n + ' units / ' + l.wards + ' wards' + (c && l.n < c.n ? '  (smaller than committed: the page ignores it)' : '') : 'absent (fine)'));

const port = Number(opt('port', 8137));
const r = await get('http://127.0.0.1:' + port + '/' + PAGE);
if (!r) console.log('[154] no server on 127.0.0.1:' + port + ' (start: node tools/mission141-local-24.mjs --no-fetch)');
else {
  const served = buildOf(r.body);
  console.log('[154] server on :' + port + ' serves build ' + served + (served === disk ? '  OK (same as disk)' : '  STALE -> stop that server (Ctrl+C / close its window) and start it again from THIS checkout'));
  const t = await get('http://127.0.0.1:' + port + '/mission145-data/towns-24.json');
  console.log('[154] server towns-24.json: HTTP ' + (t ? t.status : 'no response') + (t && t.status !== 200 ? '  -> this server root is not this checkout\'s public/' : ''));
}

const roots = (opt('roots', 'C:\\lc141,temp/mission141')).split(',').map((x) => path.resolve(ROOT, x.trim()));
const walk = (d, depth, out) => {
  if (depth < 0) return;
  let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
  for (const e of es) {
    if (e.isDirectory()) walk(path.join(d, e.name), depth - 1, out);
    else if (e.name === PAGE) out.push(path.join(d, e.name));
  }
};
for (const rt of roots) {
  const found = []; walk(rt, 3, found);
  console.log('[154] stray copies of the viewer under ' + rt + ': ' + (found.length ? found.join('; ') + '  (the server does not use these; they can be ignored or removed by you)' : 'none'));
}
console.log('[154] open: http://127.0.0.1:' + port + '/' + PAGE + '?nobuiltin=1&ext45=1  (bottom-left badge must read build ' + disk + '; Ctrl+F5 once)');
