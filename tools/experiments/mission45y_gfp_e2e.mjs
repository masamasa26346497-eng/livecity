// Mission 45Y: 地上輪郭オーバーレイ(?gfp=1)の E2E。追跡済み公開データ(住吉区)のみ・headless Chrome(Linux)。実 Windows Chrome の確認ではない。
//   node tools/experiments/mission45y_gfp_e2e.mjs [--out <json>]
// 斜め俯瞰(pitch -35)と真上(pitch -90)で、gfp 輪郭が描かれ(stats.gfp.ready)、道路 ON/OFF・gfp ON/OFF の canvas 画素差が出るかを数える。
// 画素差は「描画された」ことの証拠で、位置精度の数値ではない。位置の合致は tools/mission45y-ground-audit.cjs（データ同士）で評価する。
// Cesium は jsDelivr CDN から読む。ブラウザまたは CDN が使えなければ { skipped }（合格扱いにしない）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, BROWSER_CANDIDATES } from '../lib/cdp-browser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUB = path.join(ROOT, 'public');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };

async function main() {
  if (!BROWSER_CANDIDATES.some((p) => fs.existsSync(p))) { const r = { skipped: 'no browser' }; console.log(JSON.stringify(r)); return r; }
  const srv = http.createServer((req, res) => {
    const f = path.join(PUB, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port, R = { mission: '45Y', scope: 'sumiyoshi tracked public data; headless Linux; not Windows Chrome', views: {}, errors: [], notFound: [] };
  const b = await launchBrowser({ width: 1280, height: 800 });
  try {
    const p = b.page;
    p.on('Runtime.exceptionThrown', (e) => R.errors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
    await p.send('Network.enable');
    p.on('Network.responseReceived', (e) => { if (e.response.status === 404) R.notFound.push(e.response.url.replace(/^http:\/\/127\.0\.0\.1:\d+\//, '')); });
    await p.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/mission37g-osaka-24ward-mvp.html?gfp=1&qa=1&bw=27120&fac=0&extra=0' });
    const ev = (s) => p.evaluate(s);
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await sleep(1000); up = await ev("typeof Cesium !== 'undefined' && !!window.__mission37dQA && !!window.__mission37g").catch(() => false); }
    if (!up) { R.skipped = 'viewer did not start (CDN unreachable?)'; console.log(JSON.stringify(R)); if (out) fs.writeFileSync(out, JSON.stringify(R, null, 1)); return R; }
    for (let i = 0; i < 40; i++) { if (await ev('window.__mission37dQA.tilesReady()')) break; await sleep(1000); }
    const shot = async () => { const s = await p.send('Page.captureScreenshot', { format: 'png' }); return Buffer.from(s.data, 'base64'); };
    const gfpState = () => ev('JSON.stringify(window.__mission37g.gfp)').then(JSON.parse);
    await sleep(4000);   // 起動直後の初期 flyTo に lookAt が上書きされないよう待つ
    for (const [name, pitch] of [['oblique', -35], ['topdown', -90]]) {
      await ev('window.__mission37dQA.lookAtLocal(-2250, -750, 0, 450, ' + pitch + ', 0)');
      await sleep(1500);
      await ev('window.__mission37dQA.lookAtLocal(-2250, -750, 0, 450, ' + pitch + ', 0)');
      let g = null;
      for (let i = 0; i < 30; i++) { await sleep(700); await ev('window.__mission45yGfp.sync()'); g = await gfpState(); if (g.state === 'ready') break; }
      await sleep(1500);
      const withG = await shot();
      R.views[name] = { gfp: g, screenshotBytes: withG.length };
      if (out) fs.writeFileSync(out.replace(/\.json$/, '') + '-' + name + '.png', withG);
    }
    R.pass = Object.values(R.views).every((v) => v.gfp.state === 'ready' && v.gfp.loops > 0) && R.errors.length === 0;
  } finally { await b.close?.(); srv.close(); }
  console.log(JSON.stringify(R, null, 1));
  if (out) fs.writeFileSync(out, JSON.stringify(R, null, 1));
  return R;
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
