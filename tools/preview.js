#!/usr/bin/env node
// tools/preview.js
// 実行: node tools/preview.js [--port 8000] [--area osaka-sumiyoshi]
//
// 目的（ご指示3）: public/ フォルダをローカルHTTPサーバーで配信し、Live Cityを http://localhost 経由で
//   正しく確認できるようにする。file:// 直開きによる統計JSONのfetch失敗を回避するための開発用サーバー。
//
// 方針:
//   - 追加依存を増やさない: Node.js組み込みの http/fs/path のみで実装（package.jsonのdependenciesは空のまま）。
//   - データ更新とは完全に分離: 起動時に一切のダウンロード・変換・生成を行わない。
//   - 起動時に必要な map-data の存在を確認し、不足していれば警告する（ただし勝手に仮データは作らない）。
//   - 確認用URLを表示する。

import http from 'http';
import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

function parseArgs(argv) {
  const args = { port: 8000, area: 'osaka-sumiyoshi' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = parseInt(argv[++i], 10) || 8000;
    else if (argv[i] === '--area') args.area = argv[++i];
  }
  return args;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.geojson': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// パストラバーサル対策: 正規化後に PUBLIC_DIR 配下であることを保証する。
function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded.replace(/^\/+/, '');
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return null;
  return abs;
}

// 起動前に、HTMLが読み込む4つの統計JSONの存在を確認して警告する（生成はしない）。
function checkMapData(areaId) {
  const base = path.join(PUBLIC_DIR, 'map-data', areaId);
  const required = [
    path.join(base, 'demographics', 'summary.json'),
    path.join(base, 'demographics', 'age-structure.json'),
    path.join(base, 'demographics', 'town-stats.json'),
    path.join(base, 'facilities', 'facilities.json'),
  ];
  const missing = required.filter((f) => !existsSync(f));
  if (missing.length === 0) {
    console.log(`統計データ: 4ファイルすべて存在します (public/map-data/${areaId}/)`);
  } else {
    console.warn('⚠ 統計データが不足しています。地図は起動しますが、一部の統計が表示されない可能性があります:');
    for (const f of missing) console.warn(`   - ${path.relative(ROOT, f)}`);
    console.warn('  → 生成するには `npm run data:update:all` を実行してください（このコマンドは自動生成しません）。');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(PUBLIC_DIR)) {
    console.error(`public フォルダが見つかりません: ${PUBLIC_DIR}`);
    process.exit(1);
  }
  checkMapData(args.area);

  const server = http.createServer(async (req, res) => {
    let urlPath = req.url || '/';
    if (urlPath === '/') urlPath = '/osaka_3d_buildings.html';
    const abs = resolveSafe(urlPath);
    if (!abs) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    try {
      const st = await stat(abs);
      if (st.isDirectory()) {
        res.writeHead(403); res.end('Directory listing disabled'); return;
      }
      const ext = path.extname(abs).toLowerCase();
      const body = await readFile(abs);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`ポート ${args.port} は使用中です。別のポートを指定してください: npm run preview -- --port 8080`);
    } else {
      console.error('サーバーエラー:', err.message);
    }
    process.exit(1);
  });

  server.listen(args.port, () => {
    const url = `http://localhost:${args.port}/osaka_3d_buildings.html`;
    console.log('\n==================================================');
    console.log('Live City プレビューサーバーを起動しました。');
    console.log(`  ${url}`);
    console.log('\n確認用（統計JSONのHTTP取得チェック）:');
    const base = `http://localhost:${args.port}/map-data/${args.area}`;
    console.log(`  ${base}/demographics/summary.json`);
    console.log(`  ${base}/demographics/age-structure.json`);
    console.log(`  ${base}/demographics/town-stats.json`);
    console.log(`  ${base}/facilities/facilities.json`);
    console.log('\n停止するには Ctrl+C を押してください。');
    console.log('==================================================');
  });
}

main().catch((err) => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
