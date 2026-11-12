#!/usr/bin/env node
// Mission 138: 既存の 24 区ページ (public/mission37g-osaka-24ward-mvp.html) に、手元の非公開データを localhost だけで読み取り専用配信する。
//   node tools/mission138-serve-local.cjs [--footprints-root <旧 buildings dir>] [--layers-root <Mission115→アダプター出力>] [--ext <3D Tiles 出力>] [--port 8137]
//   --footprints-root : <root>/osaka-<ward>/{manifest.json,tile_x_z.json}   -> /ext-3dtiles/<ward>/footprints/...   (旧 Live City の建物タイル。private release を展開した先でよい)
//   --layers-root     : <root>/<ward>/layers/{roads,waterways,water-surface,status}.json -> /ext-3dtiles/<ward>/layers/...   (tools/mission135 の build-ward-layers 出力)
//   --ext             : 40F と同じ (<ext>/<ward>/tileset.json -> /ext-3dtiles/<ward>/...)
// 開く URL: http://127.0.0.1:<port>/mission37g-osaka-24ward-mvp.html?fp=1
// 公開しない: 127.0.0.1 のみ bind、GET/HEAD のみ、許可ファイル名の allowlist、symlink 拒否、Host/Origin 検査。何も書かず・コピーせず・削除しない。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeServer } = require('./mission40f-serve-local.cjs');

const NAME = /^[a-z0-9-]+$/;
const FP_FILE = /^(manifest\.json|tile_-?\d+_-?\d+\.json)$/;
const LAYER_FILE = /^(roads|waterways|water-surface|parks|railways|status|layers-report)\.json$/;
const PREFIX = '/ext-3dtiles/';

const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };
/** root 配下の通常ファイルのみ（symlink・root 外は null）。 */
function safeFile(root, rel) {
  if (!root || rel.includes('\0') || rel.includes('\\') || rel.split('/').includes('..')) return null;
  const f = path.join(root, ...rel.split('/')), st = lst(f);
  if (!st || !st.isFile() || st.isSymbolicLink()) return null;
  try { const rr = fs.realpathSync(root); return fs.realpathSync(f).startsWith(rr + path.sep) ? f : null; } catch (e) { return null; }
}
/** /ext-3dtiles/<ward>/(footprints|layers)/<file> を、許可された root 内の実ファイルへ解決する。該当しなければ null。 */
function resolveExt(urlPath, roots) {
  if (!urlPath.startsWith(PREFIX)) return null;
  const parts = urlPath.slice(PREFIX.length).split('/'), ward = parts.shift(), kind = parts.shift(), file = parts.join('/');
  if (!NAME.test(ward || '')) return null;
  if (kind === 'footprints' && FP_FILE.test(file)) return safeFile(roots.footprints, 'osaka-' + ward + '/' + file);
  if (kind === 'layers' && LAYER_FILE.test(file)) return safeFile(roots.layers, ward + '/layers/' + file);
  return null;
}
const hostOk = (host, port) => host === '127.0.0.1:' + port || host === 'localhost:' + port;
const originOk = (origin, port) => !origin || origin === 'http://127.0.0.1:' + port || origin === 'http://localhost:' + port;

function createServer(opts) {
  const base = makeServer({ publicDir: opts.publicDir, extDir: opts.extDir || null });
  const roots = { footprints: opts.footprintsRoot ? path.resolve(opts.footprintsRoot) : null, layers: opts.layersRoot ? path.resolve(opts.layersRoot) : null };
  const getPort = opts.getPort || (() => 0);
  const srv = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }
    if (!hostOk(req.headers.host, getPort()) || !originOk(req.headers.origin, getPort())) { res.writeHead(403); return res.end('forbidden'); }
    let u; try { u = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(404); return res.end('not found'); }
    const m = /^\/ext-3dtiles\/[^/]+\/(footprints|layers)\//.exec(u);
    if (m) {
      const f = resolveExt(u, roots);
      if (!f) { res.writeHead(404); return res.end('not found'); }   // 欠落は必ず 404（偽の 200 / 空 JSON を返さない）
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
    }
    return base.emit('request', req, res);   // それ以外は 40F と同じ（public/ と --ext の 3D Tiles）
  });
  return srv;
}
function listen(opts, port) {
  let actual = port;
  const srv = createServer(Object.assign({}, opts, { getPort: () => actual }));
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => { actual = srv.address().port; resolve({ srv, port: actual, url: 'http://127.0.0.1:' + actual + '/' }); }));
}
module.exports = { createServer, listen, resolveExt, safeFile, hostOk, originOk };

if (require.main === module) {
  const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const fp = get('--footprints-root'), layers = get('--layers-root'), ext = get('--ext'), port = +(get('--port') || 8137);
  for (const [k, v] of [['--footprints-root', fp], ['--layers-root', layers], ['--ext', ext]]) if (v && !fs.existsSync(v)) { console.error(k + ' not found: ' + v); process.exit(2); }
  listen({ publicDir: path.join(__dirname, '..', 'public'), footprintsRoot: fp, layersRoot: layers, extDir: ext }, port).then((s) => {
    console.log('serving public/ (read-only, 127.0.0.1 only) on ' + s.url);
    if (fp) console.log('footprints: ' + fp + '  ->  ' + fs.readdirSync(fp).filter((d) => /^osaka-/.test(d)).length + ' osaka-<ward> dirs');
    console.log('open: ' + s.url + 'mission37g-osaka-24ward-mvp.html?fp=1');
  });
}
