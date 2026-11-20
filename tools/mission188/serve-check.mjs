#!/usr/bin/env node
// Mission 188: read-only loopback HTTP check of a built folder. Serves <out>/ext-3dtiles at /ext-3dtiles/ on 127.0.0.1 (GET/HEAD only,
// no path traversal, no _manifest) and crawls index.json -> source.json -> tileset.json -> every tile uri, requiring HTTP 200.
//   node tools/mission188/serve-check.mjs --out "<dir>" [--serve]   (--serve keeps the server up for a manual 37G ?ext45=1 test)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tilesetUris } from './build-local-2025.mjs';

export function startServer(out, port = 0) {
  const root = path.resolve(out, 'ext-3dtiles');
  const srv = http.createServer((req, res) => {
    const send = (c, b) => { res.statusCode = c; res.end(b || ''); };
    if (!['GET', 'HEAD'].includes(req.method)) return send(405);
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(403);
    if (/%2e|%2f|%5c|\.\./i.test(req.url)) return send(404); // reject encoded/raw traversal before URL normalisation
    let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return send(400); }
    if (!p.startsWith('/ext-3dtiles/') || p.includes('..') || p.includes('\\') || /\/_manifest(\/|$)/.test(p)) return send(404);
    const f = path.join(root, p.slice('/ext-3dtiles/'.length));
    if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(404);
    res.setHeader('Content-Type', f.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    res.statusCode = 200; if (req.method === 'HEAD') return res.end(); fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
export async function crawl(port) {
  const get = (p) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c) })); }).on('error', () => resolve({ status: 0, body: Buffer.alloc(0) })));
  const rep = { index: 0, wards: {}, non200: [] };
  const idx = await get('/ext-3dtiles/index.json'); rep.index = idx.status; if (idx.status !== 200) return rep;
  for (const w of JSON.parse(idx.body.toString()).wards) {
    const r = { urls: 0, ok: 0 }; rep.wards[w.ward] = r;
    const chk = async (p) => { const x = await get(p); r.urls++; if (x.status === 200) r.ok++; else rep.non200.push(p + ' ' + x.status); return x; };
    await chk('/ext-3dtiles/' + w.ward + '/source.json');
    const ts = await chk('/ext-3dtiles/' + w.ward + '/tileset.json');
    if (ts.status === 200) for (const u of tilesetUris(JSON.parse(ts.body.toString()))) await chk('/ext-3dtiles/' + w.ward + '/' + u);
  }
  return rep;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2), i = a.indexOf('--out');
  if (i < 0) { console.error('need --out'); process.exit(2); }
  const { srv, port } = await startServer(a[i + 1], a.includes('--serve') ? 8188 : 0);
  const rep = await crawl(port);
  const tot = Object.values(rep.wards).reduce((n, x) => ({ urls: n.urls + x.urls, ok: n.ok + x.ok }), { urls: 0, ok: 0 });
  console.log(JSON.stringify({ indexStatus: rep.index, wards: Object.keys(rep.wards).length, ...tot, non200: rep.non200.slice(0, 10) }));
  if (a.includes('--serve') && !rep.non200.length) console.log('serving http://127.0.0.1:' + port + '/ext-3dtiles/index.json (Ctrl+C to stop)');
  else { srv.close(); process.exit(rep.non200.length || rep.index !== 200 ? 1 : 0); }
}
