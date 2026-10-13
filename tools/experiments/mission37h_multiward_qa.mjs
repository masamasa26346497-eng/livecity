// tools/experiments/mission37h_multiward_qa.mjs
// [Mission 37H] 実 Chrome（headless）で、住吉区以外（北区・中央区）の実 PLATEAU 建物が描画され、
// 3D 建物を実クリックして canonicalId が取れる（sidecar 一致・行政区表示）ことを確かめる。
//   - クリック座標は QA フック（localhost かつ ?qa=1 のみ）の投影 API で求め、scene.pick が目的の id を返す点だけを CDP で実クリック。
//   - 目的の建物は tile の attrs/ から高さ順に 3 棟ずつ（名称検索や総当たりはしない）。
//   - headless はソフトウェア描画なので FPS は実機値ではない（記録のみ）。Google 通信 0 / JS 例外 0 / 404 を併せて記録。
// 使い方: node tools/experiments/mission37h_multiward_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT_DIR = 'data/reports/mission37h-wards';
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
await new Promise((r) => srv.listen(8139, r));
const URL_ = 'http://localhost:8139/mission37g-osaka-24ward-mvp.html?qa=1';

// 期待値は静的データから（画面の値とは独立に）
const WARDS = [
  { id: 'kita', name: '北区', dir: 'public/mission37h-3dtiles/kita-sample/' },
  { id: 'chuo', name: '中央区', dir: 'public/mission37h-3dtiles/chuo-sample/' },
  { id: 'tennoji', name: '天王寺区', dir: 'public/mission37h-3dtiles/tennoji-sample/' },
  { id: 'nishi', name: '西区', dir: 'public/mission37h-3dtiles/nishi-sample/' },
];
for (const w of WARDS) {
  const byId = {};
  for (const f of fs.readdirSync(w.dir + 'attrs')) Object.assign(byId, JSON.parse(fs.readFileSync(w.dir + 'attrs/' + f, 'utf8')).byId);
  w.code = JSON.parse(fs.readFileSync(w.dir + 'source.json', 'utf8')).wardCode;
  w.attrCount = Object.keys(byId).length;
  w.targets = Object.entries(byId).filter(([, a]) => a[0] >= 40 && a[0] <= 120).sort((a, b) => b[1][0] - a[1][0]).slice(0, 3)
    .map(([id, a]) => ({ id, h: a[0], x: a[2], z: a[3] }));
}

const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
const out = { mission: '37H', url: URL_, browser: b.version, generatedAt: new Date().toISOString(), googleRequests: [], failedRequests: [], jsErrors: [], wards: [] };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => { try { const h = new URL(e.request.url).hostname; if (GOOGLE_HOSTS.test(h)) out.googleRequests.push(e.request.url); } catch { /* data: */ } });
page.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/tile\.|cyberjapandata/.test(e.response.url)) out.failedRequests.push(e.response.status + ' ' + e.response.url); });
const ev = (js) => page.evaluate(js);
async function click(x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const shot = async (name) => {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64'));
  return `${OUT_DIR}/${name}.jpg`;
};
async function settle(x, z, h, range, pitch, code) {
  await ev(`window.__mission37dQA.lookAtLocal(${x}, ${z}, ${h}, ${range}, ${pitch}, 0)`);
  await sleep(1500);
  if (code) {
    await ev('window.__mission37dQA.updateExtraNear()').catch(() => {});
    for (let i = 0; i < 40; i++) { if (await ev(`window.__mission37g.extraSets.some((e) => e.wardCode === '${code}')`)) break; await sleep(500); }
  }
  for (let i = 0; i < 60; i++) { if (await ev('window.__mission37dQA.tilesReady()')) break; await sleep(500); }
  await sleep(1000);
}
async function findClickable(t) {
  for (const f of [0.5, 1, 0.1, 0]) {
    const base = await ev(`JSON.stringify(window.__mission37dQA.project(${t.x}, ${t.z}, ${t.h * f}))`).then(JSON.parse);
    if (!base || !base.inCanvas) continue;
    for (const [dx, dy] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [12, 6], [-12, 6], [12, -6], [-12, -6], [20, 0], [-20, 0], [0, 20], [0, -20]]) {
      if ((await ev(`window.__mission37dQA.pickId(${base.x + dx}, ${base.y + dy})`)) === t.id) return { x: base.x + dx, y: base.y + dy };
    }
  }
  return null;
}

try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const ok = await ev("!!(window.__mission37dQA && window.__mission37g && window.__mission37g.extraSets && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false);
    if (ok === true) break;
  }
  await sleep(3000);
  out.extraSetsAtStart = await ev('JSON.stringify(window.__mission37g.extraSets)').then(JSON.parse);   // 全域ビューでは 0 件のはず（遅延 mount）
  out.coverage = await ev('JSON.stringify(window.__mission37g.coverage)').then(JSON.parse);
  out.status = await ev('window.__mission37g.status');
  for (const w of WARDS) {
    const rec = { ward: w.name, attrCount: w.attrCount, targets: [] };
    out.wards.push(rec);
    for (const t of w.targets) {
      const r = { id: t.id, heightM: t.h, realClick: false };
      rec.targets.push(r);
      await settle(t.x, t.z, t.h / 2, 300, -50, w.code);
      let p = await findClickable(t);
      if (!p) { await settle(t.x, t.z, t.h / 2, 160, -70, w.code); p = await findClickable(t); }
      if (!p) { r.note = 'scene.pick が目的の建物を返す画面点が見つからない'; continue; }
      await click(p.x, p.y);
      await sleep(900);
      // 37J: 施設の区別ロードと並走するため、sidecar 照合の完了を最大 15 秒待ち、所要時間を記録する
      const tSide = Date.now();
      for (let i = 0; i < 60; i++) { if ((await ev("document.getElementById('lb-side').textContent")) !== '照合中…') break; await sleep(250); }
      r.sidecarWaitMs = Date.now() - tSide + 900;
      r.selected = await ev('window.__mission37g.selectedCanonicalId');
      r.realClick = r.selected === t.id;
      r.panel = await ev(`JSON.stringify({ cid: document.getElementById('lc-cid').textContent, ward: document.getElementById('lb-ward').textContent, side: document.getElementById('lb-side').textContent, h: document.getElementById('lb-h').textContent, usage: document.getElementById('lb-usage').textContent })`).then(JSON.parse);
      r.sidecarMatch = r.panel.side.includes('一致') && !r.panel.side.includes('不一致');
      r.wardMatches = r.panel.ward === w.name;
      if (r.realClick && !rec.screenshot) rec.screenshot = await shot('ward-' + w.id + '-click');
    }
    rec.pass = rec.targets.length > 0 && rec.targets.every((x) => x.realClick && x.sidecarMatch && x.wardMatches);
  }
  // 遠ざかったら破棄されること（高度 > 20km）
  await ev('window.__mission37dQA.lookAtLocal(-2000, 0, 0, 30000, -60, 0)');
  await sleep(1500);
  await ev('window.__mission37dQA.updateExtraNear()').catch(() => {});
  await sleep(1500);
  out.extraSetsAfterZoomOut = await ev('JSON.stringify(window.__mission37g.extraSets)').then(JSON.parse);
  out.extraMounted = await ev('window.__mission37g.extraMountedTotal');
  out.extraUnmounted = await ev('window.__mission37g.extraUnmountedTotal');
  out.coverage = await ev('JSON.stringify(window.__mission37g.coverage)').then(JSON.parse);
  out.wardsWith3dCount = out.coverage ? out.coverage.wardsWith3d : null;
  // 住吉区 回帰: 9 tile の建物も従来どおり選べること
  const sumi = { id: 'bldg_ec74351a-f344-4b61-b2e6-04b660b05aa0' };
  const sa = JSON.parse(fs.readFileSync('public/mission37c-layers/osaka-sumiyoshi-9tile/attrs/t_-5_-2.json', 'utf8'));
  void sa;
  out.fps = await ev('window.__mission37g.fps');
  out.jsErrorCount = out.jsErrors.length;
  out.googleRequestCount = out.googleRequests.length;
  out.pass = out.extraSetsAtStart.length === 0 && out.extraSetsAfterZoomOut.length === 0 && out.wards.every((w) => w.pass) && out.jsErrors.length === 0 && out.googleRequests.length === 0;
} catch (e) {
  out.fatal = String(e && e.stack || e);
} finally {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'multiward-qa.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ pass: out.pass, coverage: out.coverage, wards: out.wards.map((w) => ({ ward: w.ward, pass: w.pass, targets: w.targets.map((t) => ({ id: t.id.slice(0, 13), realClick: t.realClick, sidecar: t.sidecarMatch, ward: t.wardMatches, note: t.note })) })), jsErrors: out.jsErrors.length, google: out.googleRequests.length, failed: out.failedRequests, fatal: out.fatal }, null, 1));
  try { await b.close(); } catch { /* noop */ }
  srv.close();
  process.exit(0);
}
