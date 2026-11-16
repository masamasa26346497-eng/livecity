// tools/experiments/mission150_town_labels_e2e.mjs
// [Mission 150] 町丁目名ラベルが正規ページ (mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1) の Cesium 上で実際に show されるかを
// headless Chrome で確認する。入力は public/mission145-data/towns-24.local.json（e-Stat 2020 の実データ。gitignore 済み・commit しない）。
//   data 段階: ファイルの HTTP 200 / スキーマ / 24 区網羅 / 件数
//   描画段階: 中央区・住吉区・北区へ視点を移し、高度ごと(区名のみ / 町名 / 町丁目名)に stats.towns145.shownTexts を読む。
// headless Chrome に日本語フォントが無い場合、スクリーンショットの文字は読めない（豆腐になる）。判定は shownTexts（Cesium Label の text）で行う。
// 使い方: node tools/experiments/mission150_town_labels_e2e.mjs   （事前に towns-24.local.json を生成しておく）
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT_DIR = 'data/reports/mission150-towns';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE_HOSTS = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const LOCAL = path.resolve('public/mission145-data/towns-24.local.json');
if (!fs.existsSync(LOCAL)) { console.error('ABORT: ' + LOCAL + ' not found. Generate it first: node tools/mission141-local-24.mjs --fetch-towns (or mission145-build-towns.cjs --zip <e-Stat ZIP>)'); process.exit(2); }
const data = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
const byWard = {}; for (const t of data.towns) (byWard[t.w] = byWard[t.w] || []).push(t);

const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8150, r));
const URL_ = 'http://localhost:8150/mission37g-osaka-24ward-mvp.html?qa=1&nobuiltin=1&ext45=1';

const out = { mission: '150', url: URL_, generatedAt: new Date().toISOString(), dataStage: { source: data.source, license: data.license, total: data.towns.length, wards: Object.keys(byWard).length, byWard: Object.fromEntries(Object.entries(byWard).map(([k, v]) => [k, v.length])) }, googleRequests: [], failed404: [], jsErrors: [], checks: {}, views: {} };
let b;
try {
  b = await launchBrowser({ width: 1500, height: 940 });
  const page = b.page;
  page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
  page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE_HOSTS.test(new URL(e.request.url).hostname)) out.googleRequests.push(e.request.url); } catch { /* data: */ } });
  page.on('Network.responseReceived', (e) => {
    if (/towns-24\.local\.json/.test(e.response.url)) out.townsHttpStatus = e.response.status;
    if (e.response.status >= 400 && !/tile\.|cyberjapandata|favicon|ext-3dtiles\/index\.json|towns-24\.json|stations-24\.local\.json/.test(e.response.url)) out.failed404.push(e.response.status + ' ' + e.response.url);
  });
  const ev = (js) => page.evaluate(js);
  const shot = async (name) => { const { data: d } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 }); fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(d, 'base64')); return `${OUT_DIR}/${name}.jpg`; };
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    if ((await ev('!!(window.__mission37dQA && window.__mission37g && window.__mission37g.towns145 && window.__mission37g.towns145.total)').catch(() => false)) === true) break;
  }
  const s0 = await ev('JSON.stringify(window.__mission37g.towns145)').then(JSON.parse).catch(() => null);
  out.checks.townsLoadedInViewer = !!s0 && s0.total === data.towns.length;
  out.checks.townsHttp200 = out.townsHttpStatus === 200;
  out.checks.all24Wards = out.dataStage.wards === 24;
  out.checks.sumiyoshi104 = (byWard.sumiyoshi || []).length === 104;

  // 画面: 各区の「面積最大の町丁目」を中心に、高度 4500m(町名) と 1000m(町丁目名) で読む
  for (const ward of ['chuo', 'kita', 'sumiyoshi']) {
    const list = byWard[ward]; const ref = list.slice().sort((x, y) => y.a - x.a)[Math.floor(list.length / 4)];
    out.views[ward] = { ref: ref.n };
    for (const [alt, tag] of [[4500, 'base'], [1000, 'full']]) {
      let st = null;
      for (let i = 0; i < 12; i++) {
        await ev(`window.__mission37dQA.lookAtLocal(${ref.x}, ${ref.z}, 0, ${alt}, -70, 0)`);   // 初期飛行に上書きされることがあるので毎回かけ直す
        await sleep(1500);
        st = await ev('JSON.stringify({ t: window.__mission37g.towns145, s: window.__mission37g.towns })').then(JSON.parse);
        if (ward === 'sumiyoshi' ? (st.s && st.s.labelsShown > 1 && st.s.labelTier === tag) : (st.t.tier === tag && st.t.shownTexts && st.t.shownTexts.length)) break;
      }
      const v = ward === 'sumiyoshi' ? { tier: st.s && st.s.labelTier, shown: st.s && st.s.labelsShown, note: 'Sumiyoshi uses the 37D layer (boundary-aware); count only' }
        : { tier: st.t.tier, altitudeM: st.t.altitudeM, shown: st.t.shownTexts.length, texts: st.t.shownTexts.slice(0, 15), live: st.t.live };
      out.views[ward][tag] = v; v.screenshot = await shot(ward + '-' + tag);
    }
  }
  const has = (w, tag, re) => (out.views[w][tag].texts || []).some((t) => re.test(t));
  out.checks.chuoBaseShown = out.views.chuo.base.shown > 0;
  out.checks.chuoFullShowsChome = has('chuo', 'full', /丁目$/);
  out.checks.kitaFullShowsChome = has('kita', 'full', /丁目$/);
  out.checks.fullLabelsAreOfficialNames = ['chuo', 'kita'].every((w) => (out.views[w].full.texts || []).every((t) => byWard[w].some((x) => x.n === t)));
  out.checks.baseLabelsHaveNoChome = ['chuo', 'kita'].every((w) => (out.views[w].base.texts || []).every((t) => !/丁目$/.test(t)));
  out.checks.fullWithinCap = ['chuo', 'kita'].every((w) => out.views[w].full.shown <= 48);
  out.checks.sumiyoshiLabelsShown = (out.views.sumiyoshi.base.shown || 0) > 1 && (out.views.sumiyoshi.full.shown || 0) > 1;
  out.checks.pageHasNoJsErrors = out.jsErrors.length === 0;
  out.checks.googleRequestsZero = out.googleRequests.length === 0;
  out.checks.noUnexpected404 = out.failed404.length === 0;
  out.pass = Object.values(out.checks).every(Boolean);
} catch (e) {
  out.error = String(e && e.stack || e).slice(0, 600); out.pass = false;
} finally {
  try { if (b) await b.close(); } catch { /* noop */ }
  srv.close();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ pass: out.pass, checks: out.checks, dataStage: { total: out.dataStage.total, wards: out.dataStage.wards }, views: out.views, jsErrors: out.jsErrors, googleRequests: out.googleRequests.length, failed404: out.failed404, error: out.error }, null, 1));
}
process.exit(out.pass ? 0 : 1);
