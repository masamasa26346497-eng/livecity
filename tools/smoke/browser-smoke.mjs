#!/usr/bin/env node
// tools/smoke/browser-smoke.mjs
// 実行: node tools/smoke/browser-smoke.mjs [--page osaka_3d_buildings.html] [--three-js <local three.min.js>] [--out artifacts/smoke]
//
// 目的（Mission 38 / A3）: main上に実在するページの正常ロード・ブラウザ例外・スクリーンショットを確認する。
// 方針:
//   - Playwright は package.json に追加しない（依存追加なし）。未導入なら「未実行」と明示して exit 2。
//   - localhost の静的サーバーのみ。localhost 以外への通信は全てブロックし、ブロックした URL を記録する。
//   - 本番HTMLは three.js r128 を CDN から読むため、--three-js でローカルファイルを渡した場合のみ代替配信する。
//     渡さない場合は three.js が読み込めず、ページの動作確認は「未実行」扱い（成功とは報告しない）。
//   - green は「ページが例外なくロードした」ことのみを意味し、実画面の機能保証ではない。
import http from 'http';
import { readFile, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const page = opt('--page', 'osaka_3d_buildings.html');
const threeJs = opt('--three-js', null);
const outDir = path.resolve(ROOT, opt('--out', 'artifacts/smoke'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

function serve() {
  const server = http.createServer(async (req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    // 区切り文字付きで比較し、public-evil/ のような兄弟ディレクトリへの脱出を防ぐ
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const started = Date.now();
  const result = { page, status: 'not-run', reason: '', pageErrors: [], consoleErrors: [], blockedExternal: [], screenshot: null, durationMs: 0 };
  const pw = await loadPlaywright();
  if (!pw) {
    result.reason = 'playwright 未導入（依存を追加しない方針）。未実行であり成功ではない。';
  } else if (!threeJs) {
    result.reason = '--three-js 未指定: CDN を使わないため three.js が無く、ページ動作確認は未実行。';
  } else {
    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
      browser = await pw.chromium.launch();
      const pg = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await pg.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.startsWith(base)) return route.continue();
        if (/three\.min\.js/.test(url)) {
          return route.fulfill({ contentType: 'text/javascript', body: await readFile(threeJs) });
        }
        result.blockedExternal.push(url);
        return route.abort();
      });
      pg.on('pageerror', (e) => result.pageErrors.push(String(e.message || e)));
      pg.on('console', (m) => m.type() === 'error' && result.consoleErrors.push(m.text()));
      await pg.goto(`${base}/${page}`, { waitUntil: 'load', timeout: 60000 });
      await pg.waitForTimeout(3000);
      await mkdir(outDir, { recursive: true });
      result.screenshot = path.join(outDir, `${path.basename(page, '.html')}.png`);
      await pg.screenshot({ path: result.screenshot });
      result.status = result.pageErrors.length ? 'fail' : 'pass';
      result.reason = result.status === 'pass' ? 'ページは例外なくロードした（機能保証ではない）' : 'pageerror あり';
    } catch (e) {
      result.status = 'fail';
      result.reason = String(e.message || e);
    } finally {
      if (browser) await browser.close();
      server.close();
    }
  }
  result.durationMs = Date.now() - started;
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'smoke-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'pass' ? 0 : result.status === 'not-run' ? 2 : 1);
}

main();
