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
const DEV_UI_HTML = 'osaka_3d_buildings.ward-ux-v1.html';
const BUILDING_PHOTO_INDEX = path.join(
  PUBLIC_DIR,
  'map-data',
  'osaka-city',
  'derived',
  'building-google-place-index.json',
);
const CORE_DEV_UI_SCRIPTS = [
  '/livecity-dev-ui-coordinator.js',
  '/livecity-building-click-performance.js',
];

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

function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded.replace(/^\/+/, '');
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return null;
  return abs;
}

function getDevUiScripts() {
  const scripts = [...CORE_DEV_UI_SCRIPTS];
  // Mission 36L: never load the expensive runtime-name fallback by accident.
  // The Google photo bridge is injected only after the exact local building->Place index exists.
  if (existsSync(BUILDING_PHOTO_INDEX)) scripts.push('/livecity-building-photo-bridge.js');
  return scripts;
}

// Mission 36I/36K/36L: 開発版HTMLだけにdev coordinator/performance/photo bridgeを注入する。
// 巨大な地図HTMLそのものを書き換えず、production/protected HTMLへ一切影響させない。
function injectDevUiCoordinator(abs, body) {
  if (path.basename(abs) !== DEV_UI_HTML) return body;
  let html = body.toString('utf8');
  const tags = getDevUiScripts()
    .filter((src) => !html.includes(src))
    .map((src) => `<script src="${src}"></script>`)
    .join('\n');
  if (!tags) return body;
  html = html.includes('</body>') ? html.replace('</body>', `${tags}\n</body>`) : `${html}\n${tags}`;
  return Buffer.from(html, 'utf8');
}

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

  if (existsSync(BUILDING_PHOTO_INDEX)) {
    console.log('建物写真: 厳密インデックスあり（Google Places写真ブリッジを有効化）');
  } else {
    console.log('建物写真: 厳密インデックス未生成（軽量化のため写真ブリッジを無効化）');
    console.log('  → 有効化: node tools/photos/build-building-google-place-index.mjs');
  }

  const server = http.createServer(async (req, res) => {
    let urlPath = req.url || '/';
    if (urlPath.split('?')[0] === '/') urlPath = '/' + DEV_UI_HTML;
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
      let body = await readFile(abs);
      body = injectDevUiCoordinator(abs, body);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
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
    const url = `http://localhost:${args.port}/${DEV_UI_HTML}`;
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