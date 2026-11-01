// Mission 80: PLATEAU 2025 で再構築した区の 3D Tiles を、実 Cesium(37G ページ) + headless Chrome で描画・クリック確認する。
//   node tools/experiments/mission80_ward2025_e2e.mjs nishi fukushima
// 入力: temp/mission79/<ward>-2025（mission79-run.mjs の出力。Git 非管理）。読み取り専用で 127.0.0.1 から配信するだけ。
// headless はソフトウェア描画。FPS・時間は実機値ではない。Google 通信は 0 であることも記録する。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const wards = process.argv.slice(2).length ? process.argv.slice(2) : ['nishi', 'fukushima'];
const OUT = 'data/reports/mission80-ward2025';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.png': 'image/png' };
const pub = path.resolve('public');
// 入力は mission79 出力、なければ mission80 バッチ出力（Mission 83B）。いずれも temp/ 配下・読み取り専用。
const extDir = (name) => {
  const base = name.replace(/25$/, '') + '-2025';
  const c = [path.resolve('temp/mission79', base), path.resolve('temp/mission80/out', base)];
  return c.find((d) => fs.existsSync(path.join(d, 'source.json'))) || c[0];
};
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let p;
  const m = u.match(/^\/ext-3dtiles\/([a-z0-9]+)\/(.*)$/);
  if (m) { const root = extDir(m[1]); p = path.resolve(root, m[2]); if (!p.startsWith(root + path.sep)) p = null; } else { p = path.resolve(pub, '.' + u); if (!p.startsWith(pub + path.sep)) p = null; }
  if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8180, '127.0.0.1', r));

const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
const out = { mission: '80', browser: b.version, generatedAt: new Date().toISOString(), headless: true, note: 'software rendering; timings are not device values', googleRequests: [], httpErrors: [], http200: 0, jsErrors: [], wards: [] };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE.test(new URL(e.request.url).hostname)) out.googleRequests.push(e.request.url); } catch { /* data: */ } });
page.on('Network.responseReceived', (e) => { const u = e.response.url; if (!/127\.0\.0\.1/.test(u)) return; if (e.response.status >= 400 && !/favicon/.test(u)) out.httpErrors.push(e.response.status + ' ' + u); else if (e.response.status === 200) out.http200++; });
const ev = (js) => page.evaluate(js);
const J = (js) => ev(`JSON.stringify(${js})`).then(JSON.parse);
const shot = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name + '.jpg'), Buffer.from(data, 'base64')); return name + '.jpg'; };
async function click(x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function waitReady() { for (let i = 0; i < 120; i++) { if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(500); } await sleep(1000); }
function targets(ward, n) {
  const d = path.join(extDir(ward), 'attrs'); const byId = {};
  for (const f of fs.readdirSync(d)) Object.assign(byId, JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')).byId);
  return Object.entries(byId).filter(([, a]) => a[0] >= 30 && a[0] <= 120).sort((a, b) => b[1][0] - a[1][0]).slice(0, n).map(([id, a]) => ({ id, h: a[0], x: a[2], z: a[3] }));
}
async function tryClick(t) {
  for (const range of [250, 400]) {
    await ev(`window.__mission37dQA.lookAtLocal(${t.x}, ${t.z}, ${t.h / 2}, ${range}, -50, 0)`);
    await sleep(1500); await waitReady();
    for (const f of [0.5, 1, 0.1]) {
      const base = await J(`window.__mission37dQA.project(${t.x}, ${t.z}, ${t.h * f})`);
      if (!base || !base.inCanvas) continue;
      for (const [dx, dy] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [10, 5], [-10, 5], [10, -5], [-10, -5], [18, 0], [-18, 0], [0, 18], [0, -18]]) {
        if ((await ev(`window.__mission37dQA.pickId(${base.x + dx}, ${base.y + dy})`)) === t.id) {
          await click(base.x + dx, base.y + dy);
          for (let i = 0; i < 40; i++) { if ((await ev('window.__mission37g.selectedCanonicalId')) === t.id) break; await sleep(250); }
          return { id: t.id, height: t.h, realMouseClick: true, selected: (await ev('window.__mission37g.selectedCanonicalId')) === t.id };
        }
      }
    }
  }
  return { id: t.id, height: t.h, realMouseClick: false, selected: false };
}

try {
  await page.send('Network.enable');
  for (const w of wards) {
    const src = JSON.parse(fs.readFileSync(path.join(extDir(w), 'source.json'), 'utf8'));
    const rep = JSON.parse(fs.readFileSync(path.join(extDir(w), 'build-report.json'), 'utf8'));
    const url = `http://127.0.0.1:8180/mission37g-osaka-24ward-mvp.html?qa=1&fac=0&nobuiltin=1&ext=${w}25`;
    const rec = { ward: w, wardCode: src.wardCode, vintage: src.vintage, expectedBuildings: rep.totals.buildings, url, steps: {} };
    const t0 = Date.now();
    await page.send('Page.navigate', { url });
    for (let i = 0; i < 90; i++) { await sleep(1000); if (await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false) === true) break; }
    await sleep(1500);
    rec.startupMs = Date.now() - t0;
    const t1 = Date.now();
    await ev(`window.__mission37dQA.setBuildingWard('${src.wardCode}')`); await waitReady();
    rec.mountMs = Date.now() - t1;
    rec.tilesets = await J('window.__mission37dQA.tilesetCount()');
    rec.buildingState = await ev('window.__mission37g.buildingState');
    rec.hudBuildings = await ev("document.getElementById('hs-bldg').textContent");
    rec.coverageNote = await ev("document.getElementById('bldg-ward-note').textContent");
    rec.tilesetStats = await J(`(() => { const o = []; const s = document.querySelector('canvas'); return window.__mission37g && window.__mission37g.stats ? { tilesetStats: window.__mission37g.stats.tilesetStats || null } : null; })()`).catch(() => null);
    const tg = targets(w, 3);
    // 遠景: 区全体(LOD 親のみ) / 近景
    const c = rep.tiles ? null : null;
    const first = tg[0];
    await ev(`window.__mission37dQA.lookAtLocal(${first.x}, ${first.z}, 0, 9000, -60, 0)`); await sleep(2500); await waitReady();
    rec.far = { shot: await shot(w + '-far'), tilesets: await J('window.__mission37dQA.tilesetCount()'), camera: await J('window.__mission37dQA.cameraVsTilesets()') };
    await ev(`window.__mission37dQA.lookAtLocal(${first.x}, ${first.z}, 0, 1500, -60, 0)`); await sleep(2500); await waitReady();
    rec.mid = { shot: await shot(w + '-mid') };
    rec.clicks = [];
    for (const t of tg) { const r = await tryClick(t); rec.clicks.push(r); if (r.selected) { r.shot = await shot(w + '-click-' + t.id.slice(5, 13)); r.panel = await ev("(document.getElementById('lc-bldg-id')||document.body).textContent").then((x) => String(x).slice(0, 80)).catch(() => null); } }
    rec.near = { shot: await shot(w + '-near') };
    rec.pass = rec.tilesets.n === 1 && rec.buildingState === 'ready' && rec.clicks.some((c2) => c2.selected) && String(rec.hudBuildings).replace(/,/g, '').includes(String(rec.expectedBuildings));
    out.wards.push(rec);
  }
} catch (e) { out.fatal = String(e && e.stack || e); }
out.pass = !out.fatal && out.wards.length === wards.length && out.wards.every((x) => x.pass) && out.jsErrors.length === 0 && out.googleRequests.length === 0 && out.httpErrors.length === 0;
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'e2e.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ pass: out.pass, wards: out.wards.map((x) => ({ w: x.ward, pass: x.pass, hud: x.hudBuildings, tilesets: x.tilesets && x.tilesets.n, state: x.buildingState, startupMs: x.startupMs, mountMs: x.mountMs, clicks: x.clicks.map((c) => c.selected) })), http200: out.http200, httpErrors: out.httpErrors.slice(0, 5), jsErrors: out.jsErrors.slice(0, 3), google: out.googleRequests.length, fatal: out.fatal }, null, 1));
await b.close?.(); srv.close(); process.exit(out.pass ? 0 : 1);
