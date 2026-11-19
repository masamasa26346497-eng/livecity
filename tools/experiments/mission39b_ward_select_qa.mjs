// tools/experiments/mission39b_ward_select_qa.mjs
// [Mission 39B] 3D 建物を「選択された区」だけ mount する動作を、実 Chrome（headless・ローカルサーバー）で確認する。
//   初期 0 区 → 住吉 → 北 → 中央 → 選択解除 → 住吉再訪 → 未整備区 → 競合（連続呼び出し）→ 区セレクト UI。
//   各段階で scene.primitives 上の Cesium3DTileset 数・mount 中の base・転送量・heap を記録し、建物を実クリックして canonicalId/sidecar を確認する。
//   headless はソフトウェア描画。時間・FPS は実機値ではない。使い方: node tools/experiments/mission39b_ward_select_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT_DIR = 'data/reports/mission39b-ward-select';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE_HOSTS = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8143, r));
const URL_ = 'http://localhost:8143/mission37g-osaka-24ward-mvp.html?qa=1&fac=0';

// 期待値は静的データから
function loadTargets(dir, n) {
  const byId = {};
  for (const f of fs.readdirSync(dir + 'attrs')) Object.assign(byId, JSON.parse(fs.readFileSync(dir + 'attrs/' + f, 'utf8')).byId);
  return Object.entries(byId).filter(([, a]) => a[0] >= 40 && a[0] <= 120).sort((a, b) => b[1][0] - a[1][0]).slice(0, n).map(([id, a]) => ({ id, h: a[0], x: a[2], z: a[3] }));
}
const SUMI = { code: '27120', name: '住吉区', targets: loadTargets('public/mission37c-layers/osaka-sumiyoshi-9tile/', 2) };
const mk = (id, name, d) => ({ code: JSON.parse(fs.readFileSync(d + 'source.json', 'utf8')).wardCode, name, targets: loadTargets(d, 2) });
const KITA = mk('kita', '北区', 'public/mission37h-3dtiles/kita-sample/');
const CHUO = mk('chuo', '中央区', 'public/mission37h-3dtiles/chuo-sample/');
const NONE_CODE = '27103';   // 3D 未整備の区（COVERAGE に無い）

const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
const out = { mission: '39B', url: URL_, browser: b.version, generatedAt: new Date().toISOString(), googleRequests: [], failedRequests: [], jsErrors: [], steps: [] };
let bytes = 0;
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE_HOSTS.test(new URL(e.request.url).hostname)) out.googleRequests.push(e.request.url); } catch { /* data: */ } });
page.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/tile\.|cyberjapandata/.test(e.response.url)) out.failedRequests.push(e.response.status + ' ' + e.response.url); });
page.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength || 0; });
const ev = (js) => page.evaluate(js);
async function click(x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const shot = async (name) => {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 75 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64'));
};
const J = (js) => ev(`JSON.stringify(${js})`).then(JSON.parse);
async function waitReady() {
  for (let i = 0; i < 80; i++) { if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(500); }
  await sleep(800);
}
async function snap(label, extra = {}) {
  const t = await J('window.__mission37dQA.tilesetCount()');
  const rec = { label, tilesets: t.n, bases: t.bases, heapMB: t.heapMB,
    buildingWard: await ev('window.__mission37g.buildingWard'), state: await ev('window.__mission37g.buildingState'),
    note: await ev("document.getElementById('bldg-ward-note').textContent"), hsBldg: await ev("document.getElementById('hs-bldg').textContent"),
    transferKB: Math.round(bytes / 1024), ...extra };
  out.steps.push(rec);
  return rec;
}
async function clickOne(t) {
  await ev(`window.__mission37dQA.lookAtLocal(${t.x}, ${t.z}, ${t.h / 2}, 300, -50, 0)`);
  await sleep(1500); await waitReady();
  for (const f of [0.5, 1, 0.1, 0]) {
    const base = await J(`window.__mission37dQA.project(${t.x}, ${t.z}, ${t.h * f})`);
    if (!base || !base.inCanvas) continue;
    for (const [dx, dy] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [12, 6], [-12, 6], [12, -6], [-12, -6], [20, 0], [-20, 0], [0, 20], [0, -20]]) {
      if ((await ev(`window.__mission37dQA.pickId(${base.x + dx}, ${base.y + dy})`)) === t.id) {
        await click(base.x + dx, base.y + dy);
        for (let i = 0; i < 40; i++) { if ((await ev('window.__mission37g.selectedCanonicalId')) === t.id) break; await sleep(250); }
        return { id: t.id, realClick: true, selected: (await ev('window.__mission37g.selectedCanonicalId')) === t.id };
      }
    }
  }
  return { id: t.id, realClick: false, selected: false };
}
const setWard = async (code) => { await ev(`window.__mission37dQA.setBuildingWard(${code ? `'${code}'` : 'null'})`); await waitReady(); };

try {
  await page.send('Network.enable');
  const t0 = Date.now();
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false) === true) break;
  }
  out.startupMs = Date.now() - t0;
  await sleep(1500);
  const s0 = await snap('初期（区未選択）');
  s0.pass = s0.tilesets === 0 && s0.state === 'none';
  s0.status = await ev('window.__mission37g.status');
  await shot('00-initial');

  for (const w of [SUMI, KITA, CHUO]) {
    const t1 = Date.now();
    await setWard(w.code);
    const r = await snap('選択: ' + w.name, { mountMs: Date.now() - t1 });
    r.pass = r.tilesets === 1 && r.state === 'ready' && r.buildingWard === w.code;
    r.click = await clickOne(w.targets[0]);
    r.pass = r.pass && r.click.realClick && r.click.selected;
    await shot('sel-' + w.code);
  }

  await setWard(null);
  const rn = await snap('選択解除（建物を表示しない）'); rn.pass = rn.tilesets === 0 && rn.state === 'none';

  await setWard(SUMI.code);
  const rs = await snap('住吉区 再訪'); rs.pass = rs.tilesets === 1 && rs.state === 'ready';
  rs.click = await clickOne(SUMI.targets[0]); if (!rs.click.realClick) rs.click = await clickOne(SUMI.targets[1]); rs.pass = rs.pass && rs.click.realClick && rs.click.selected;

  await ev(`window.__mission37dQA.setBuildingWard('${NONE_CODE}')`);
  await sleep(800);
  const ru = await snap('未整備区 ' + NONE_CODE);
  ru.pass = ru.tilesets === 0 && ru.state === 'unavailable' && /未整備/.test(ru.note);

  // 競合: await せず連続で切り替える。最後に選んだ区だけが残ること
  await ev(`(() => { const f = window.__mission37dQA.setBuildingWard; f('${KITA.code}'); f('${CHUO.code}'); f('${SUMI.code}'); f('${KITA.code}'); })()`);
  await waitReady(); await sleep(3000); await waitReady();
  const rr = await snap('競合（北→中央→住吉→北を連続）');
  rr.pass = rr.tilesets === 1 && rr.buildingWard === KITA.code && rr.state === 'ready' && rr.bases.every((x) => /kita-sample/.test(x));

  // 繰り返し切替でメモリが増え続けないこと（tileset 数が 1 のまま）
  const loop = [];
  for (let i = 0; i < 6; i++) { await setWard(i % 2 ? KITA.code : CHUO.code); loop.push(await J('window.__mission37dQA.tilesetCount()')); }
  out.loop = { tilesets: loop.map((x) => x.n), heapMB: loop.map((x) => x.heapMB) };
  const rl = await snap('繰り返し切替 6 回'); rl.pass = loop.every((x) => x.n === 1);

  // 区セレクト UI
  await ev("(() => { const s = document.getElementById('sel-bldg-ward'); s.value = ''; s.dispatchEvent(new Event('change')); })()");
  await sleep(500);
  const ru2 = await snap('セレクト: 建物を表示しない'); ru2.pass = ru2.tilesets === 0;
  out.selectOptions = await ev("document.getElementById('sel-bldg-ward').options.length");
  await ev(`(() => { const s = document.getElementById('sel-bldg-ward'); s.value = '${SUMI.code}'; s.dispatchEvent(new Event('change')); })()`);
  await waitReady(); await sleep(2000); await waitReady();
  const ru3 = await snap('セレクト: 住吉区'); ru3.pass = ru3.tilesets === 1 && ru3.buildingWard === SUMI.code;

  out.fps = await ev('window.__mission37g.fps');
  out.jsErrorCount = out.jsErrors.length; out.googleRequestCount = out.googleRequests.length;
  out.pass = out.steps.every((s) => s.pass !== false) && out.jsErrors.length === 0 && out.googleRequests.length === 0;
} catch (e) {
  out.fatal = String(e && e.stack || e);
} finally {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'ward-select-qa.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ pass: out.pass, startupMs: out.startupMs, steps: out.steps.map((s) => ({ l: s.label, ts: s.tilesets, st: s.state, ward: s.buildingWard, kb: s.transferKB, heap: s.heapMB, pass: s.pass, click: s.click })), loop: out.loop, jsErrors: out.jsErrors.length, google: out.googleRequests.length, failed: out.failedRequests, fatal: out.fatal }, null, 1));
  try { await b.close(); } catch { /* noop */ }
  srv.close();
  process.exit(0);
}
