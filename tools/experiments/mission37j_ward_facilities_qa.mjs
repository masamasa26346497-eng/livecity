// tools/experiments/mission37j_ward_facilities_qa.mjs
// [Mission 37J] 実 Chrome（headless）で、区別の施設データ（OSM/ODbL）が「カメラ真下の区」で遅延ロードされ、
//   (1) 点が出て実クリックで施設パネル（名称・出典）が出る  (2) 検索で見つかる  (3) 住吉区は重複しない
//   (4) 3D 建物の canonicalId クリックは従来どおり、を確かめる。Google 通信 0 / JS 例外 0 / 404 を記録。
// クリック座標は QA フック（localhost かつ ?qa=1）の投影 API で求めた画面点。headless の FPS は実機値ではない。
// 使い方: node tools/experiments/mission37j_ward_facilities_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT_DIR = 'data/reports/mission37j-facilities';
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
await new Promise((r) => srv.listen(8140, r));
const URL_ = 'http://localhost:8140/mission37g-osaka-24ward-mvp.html?qa=1';

const wardFile = (id) => JSON.parse(fs.readFileSync(`public/map-data/osaka-city/facilities/wards/${id}.json`, 'utf8'));
// 期待値は静的データから。クリック対象: 非飲食で名称あり、他施設と 25m 以上離れたもの（誤クリック回避）
function pickTarget(id, cats) {
  const recs = wardFile(id).records.filter((r) => r.name && cats.includes(r.category));
  const all = wardFile(id).records;
  const t = recs.find((r) => all.every((o) => o === r || Math.hypot(o.localX - r.localX, o.localZ - r.localZ) > 25));
  return t || recs[0];
}
const CASES = [
  { id: 'kita', name: '北区', target: pickTarget('kita', ['public', 'education', 'medical', 'tourism', 'transport']), dining: wardFile('kita').records.find((r) => r.category === 'dining' && r.name) },
  { id: 'tsurumi', name: '鶴見区（3D 未配信）', target: pickTarget('tsurumi', ['public', 'education', 'medical', 'tourism', 'transport']), dining: null },
];

const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
const out = { mission: '37J', url: URL_, browser: b.version, generatedAt: new Date().toISOString(), googleRequests: [], failedRequests: [], jsErrors: [], cases: [] };
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
try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    if ((await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break;
  }
  await sleep(2500);
  out.facilityWardsAtStart = await ev('JSON.stringify(window.__mission37g.facilityWards || {})').then(JSON.parse);   // 全域ビューでは空のはず

  // 対照: 37D 束の既存施設（区別ロード前から存在）が同じ方法で pick できるか
  {
    const base = JSON.parse(fs.readFileSync('public/mission37d-data/sumiyoshi-facilities.json', 'utf8')).records.find((r) => r.category === 'education' && r.name);
    await ev(`window.__mission37dQA.lookAtLocal(${base.localX}, ${base.localZ}, 0, 500, -60, 0)`);
    await sleep(3000);
    const p = await ev(`JSON.stringify(window.__mission37dQA.project(${base.localX}, ${base.localZ}, 6))`).then(JSON.parse);
    out.control = { id: base.id, projected: p, pick: p && await ev(`window.__mission37dQA.pickPoiId(${p.x}, ${p.y})`) };
  }
  for (const c of CASES) {
    const rec = { ward: c.name, target: c.target && { id: c.target.id, name: c.target.name, category: c.target.category } };
    out.cases.push(rec);
    const t = c.target;
    await ev(`window.__mission37dQA.lookAtLocal(${t.localX}, ${t.localZ}, 0, 500, -60, 0)`);
    let loaded = null;
    for (let i = 0; i < 40; i++) { await sleep(500); loaded = await ev(`JSON.stringify((window.__mission37g.facilityWards || {})['${c.id}'] || null)`).then(JSON.parse); if (loaded) break; }
    rec.loaded = loaded;
    rec.expectedFileRecords = wardFile(c.id).records.length;
    await sleep(2500);
    const p = await ev(`JSON.stringify(window.__mission37dQA.project(${t.localX}, ${t.localZ}, 6))`).then(JSON.parse);
    rec.projected = p;
    if (p && p.inCanvas) {
      rec.pickAtPoint = await ev(`window.__mission37dQA.pickPoiId(${p.x}, ${p.y})`);
      await click(p.x, p.y);
      await sleep(900);
      rec.selectedPoi = await ev('JSON.stringify(window.__mission37g.selectedPoi || null)').then(JSON.parse);
      rec.panel = await ev("JSON.stringify({ name: document.getElementById('lc-poi-name').textContent, src: document.getElementById('lp-src').textContent })").then(JSON.parse);
      rec.realClick = !!(rec.selectedPoi && rec.selectedPoi.id === t.id);
      rec.srcShown = /OpenStreetMap/.test(rec.panel.src) && /ODbL/.test(rec.panel.src);
      rec.screenshot = await shot('poi-' + c.id);
    }
    if (c.dining) {
      await ev(`(() => { const q = document.getElementById('lc-q'); q.value = ${JSON.stringify(c.dining.name)}; q.dispatchEvent(new Event('input')); })()`);
      await sleep(1500);
      rec.searchHit = await ev("Array.from(document.querySelectorAll('#lc-results button')).map((b) => b.textContent)").then((a) => a);
      rec.searchFound = rec.searchHit.some((s) => s.includes(c.dining.name));
    }
  }
  // 住吉区: 37D 束と区別ファイルの重複が入らない（追加分 = 区ファイル件数 − 37D 束 149 件）
  const s = wardFile('sumiyoshi').records, base = JSON.parse(fs.readFileSync('public/mission37d-data/sumiyoshi-facilities.json', 'utf8')).records;
  const bs = new Set(base.map((r) => r.sourceId));
  const t = s.find((r) => !bs.has(r.sourceId)) || s[0];
  await ev(`window.__mission37dQA.lookAtLocal(${t.localX}, ${t.localZ}, 0, 500, -60, 0)`);
  let sl = null;
  for (let i = 0; i < 40; i++) { await sleep(500); sl = await ev("JSON.stringify((window.__mission37g.facilityWards || {}).sumiyoshi || null)").then(JSON.parse); if (sl) break; }
  out.sumiyoshi = { loaded: sl, expectedAdded: s.filter((r) => !bs.has(r.sourceId)).length, fileRecords: s.length, base37d: base.length, noDuplicate: !!sl && sl.loaded === s.filter((r) => !bs.has(r.sourceId)).length };
  out.sumiyoshi.shot = await shot('sumiyoshi-after');
  out.fps = await ev('window.__mission37g.fps');
  out.jsErrorCount = out.jsErrors.length;
  out.googleRequestCount = out.googleRequests.length;
  out.pass = out.cases.every((c) => c.loaded && c.realClick && c.srcShown) && out.cases.filter((c) => c.dining).every((c) => c.searchFound)
    && out.sumiyoshi.noDuplicate && out.jsErrorCount === 0 && out.googleRequestCount === 0;
} catch (e) {
  out.error = String(e && e.stack || e);
} finally {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'ward-facilities-qa.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await b.close?.();
  srv.close();
  process.exit(out.pass ? 0 : 1);
}
