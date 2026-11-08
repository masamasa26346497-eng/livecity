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

// Mission 162: 診断(ファイル存在・37G HTML の attach フック等)。秘密情報・絶対パスは含めない。
function diagnose() {
  const lodDir = mounts[0][1];
  const f = (n) => { const p = path.join(lodDir, n); return fs.existsSync(p) ? { ok: true, bytes: fs.statSync(p).size } : { ok: false }; };
  const htmlP = path.join(ROOT, 'public', 'mission37g-osaka-24ward-mvp.html');
  const html = fs.existsSync(htmlP) ? fs.readFileSync(htmlP, 'utf8') : '';
  let report = null; try { report = JSON.parse(fs.readFileSync(path.join(lodDir, 'report.json'), 'utf8')); } catch (e) { /* none */ }
  return {
    server: 'lod2-preview-serve', port, lod2Dir: path.relative(ROOT, lodDir) || lodDir,
    files: { 'tileset.json': f('tileset.json'), 'lod2.glb': f('lod2.glb'), 'footprints.json': f('footprints.json'), 'report.json': f('report.json') },
    overlayJs: fs.existsSync(path.join(__dirname, 'lod2-overlay.js')),
    html37g: { exists: !!html, hasLod2Hook: html.includes('/lod2-preview/overlay.js') && html.includes('LC152.attach') },
    extRoot: opt('ext-root') ? { ok: fs.existsSync(path.resolve(opt('ext-root'))) } : null,
    converted: report ? report.converted : null, lod1Remaining: report ? report.lod1Remaining : null,
  };
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/__lod2/diag.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(diagnose())); return; }
    let f = resolve(u.pathname);
    if (f && fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!f || !fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { res.writeHead(400); res.end('bad request'); }
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? '[LOD2] ポート ' + port + ' は既に使用中です。別ポートなら --port 8153 を指定するか、既存のサーバを閉じてください' : '[LOD2] サーバエラー: ' + e.message);
  process.exit(2);
});
if (require.main === module) server.listen(port, '127.0.0.1', () => {
  console.log('LOD2 preview (localhost only): http://localhost:' + port + '/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1&lod2=1&lod2fly=1');
  console.log('lod2 dir: ' + mounts[0][1] + (opt('ext-root') ? '  ext-3dtiles: ' + opt('ext-root') : '  (ext-3dtiles 未指定: 既存の内蔵サンプル区のみ)'));
});
module.exports = { server, resolve, diagnose };
