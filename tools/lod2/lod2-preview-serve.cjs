#!/usr/bin/env node
'use strict';
// Mission 161: localhost 限定・読み取り専用の LOD2 プレビュー用静的サーバ(token 不要・外部公開なし)。
//   node tools/lod2/lod2-preview-serve.cjs [--port 8152] [--lod2-dir temp/lod2-preview] [--ext-root <45D out-root の ext-3dtiles 相当ディレクトリ>]
// 配信:  /            -> public/            (既存 Live City。変更なし)
//        /lod2-preview/ -> temp/lod2-preview (生成物 + overlay.js = tools/lod2/lod2-overlay.js)
//        /ext-3dtiles/  -> --ext-root       (指定時のみ。ユーザーの 24 区 LOD1 を同一オリジンで見せる)
// 127.0.0.1 にだけ bind。パストラバーサルは拒否。
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const port = Number(opt('port', 8152));
const mounts = [
  ['/lod2-preview/', path.resolve(ROOT, opt('lod2-dir', 'temp/lod2-preview'))],
  ['/ext-3dtiles/', opt('ext-root') ? path.resolve(opt('ext-root')) : null],
  ['/', path.join(ROOT, 'public')],
].filter((m) => m[1]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.b3dm': 'application/octet-stream', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function resolve(urlPath) {
  for (const [prefix, dir] of mounts) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel = decodeURIComponent(urlPath.slice(prefix.length));
    if (prefix === '/lod2-preview/' && rel === 'overlay.js') return path.join(__dirname, 'lod2-overlay.js');
    const full = path.resolve(dir, rel);
    if (full !== dir && !full.startsWith(dir + path.sep)) return null;
    return full;
  }
  return null;
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    let f = resolve(u.pathname);
    if (f && fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!f || !fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { res.writeHead(400); res.end('bad request'); }
});
server.listen(port, '127.0.0.1', () => {
  console.log('LOD2 preview (localhost only): http://localhost:' + port + '/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1&lod2=1&lod2fly=1');
  console.log('lod2 dir: ' + mounts[0][1] + (opt('ext-root') ? '  ext-3dtiles: ' + opt('ext-root') : '  (ext-3dtiles 未指定: 既存の内蔵サンプル区のみ)'));
});
module.exports = { server, resolve };
