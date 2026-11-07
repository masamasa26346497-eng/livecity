// [Mission 58] 「地表・道路面・水域面・建物のプレートが噛み合っているか」を描画後の depth 読み戻しで測る。
// 各サンプル点: データ座標(x,z,h) を画面へ投影 → scene.pickPosition(depth) で実際に描かれた面の位置を局所座標へ戻し、
// 期待値との水平偏差(m)・高さ差(m)を出す。真上・近距離(range 120m)で 1px≈0.15m の分解能。
// 地表 ON/OFF と背景 imagery ON/OFF の撮影も行う。headless=ソフトウェア描画。
// 使い方: node tools/experiments/mission58_plate_join_qa.mjs [label] [basemap]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launchBrowser } from '../lib/cdp-browser.js';

const LABEL = process.argv[2] || 'run';
const BASEMAP = process.argv[3] || 'none';
const OUT_DIR = 'data/reports/mission58-plates';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8158, r));
const URL_ = `http://localhost:8158/mission37g-osaka-24ward-mvp.html?qa=1&extra=0&fac=0&bw=27120&basemap=${BASEMAP}`;

// ── サンプル選定（データのみ）──
const bt = JSON.parse(fs.readFileSync('public/map-data/osaka-city/buildings/osaka-sumiyoshi/tile_-5_-2.json', 'utf8')).buildings;
const roads = JSON.parse(fs.readFileSync('public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json', 'utf8')).features;
const wat = JSON.parse(fs.readFileSync('public/mission37c-layers/osaka-sumiyoshi-9tile/waterways.json', 'utf8')).features;
const gsi = JSON.parse(fs.readFileSync('public/mission57-data/gsi-sumiyoshi-9tile.json', 'utf8')).water;
const H = { waterways: 0.5, roads: 1.4 };
const samples = [];
// 建物: tile_-5_-2 から高さ 8m 以上を 10 棟、屋根中心(repX,repZ,h)
for (const b of bt.filter((x) => x.h >= 8).slice(0, 400).filter((_, i) => i % 40 === 0).slice(0, 10)) samples.push({ kind: 'building', id: b.id, x: b.repX, z: b.repZ, h: b.h });
// 道路: 同タイル付近(x -2750..-2250, z -1000..-500)の major/mid/local 頂点
const rd = roads.filter((f) => f.kind === 'line' && f.p.some((p) => p[0] > -2750 && p[0] < -2250 && p[1] > -1000 && p[1] < -500));
for (const f of rd.slice(0, 200).filter((_, i) => i % 12 === 0).slice(0, 10)) { const p = f.p[Math.floor(f.p.length / 2)]; samples.push({ kind: 'road', id: f.id, tier: f.tier, x: p[0], z: p[1], h: H.roads }); }
// 水域: OSM area 頂点 5 + GSI WA 頂点 5（窓内）
const wa = wat.filter((f) => f.kind === 'area');
for (const f of wa.slice(0, 5)) samples.push({ kind: 'water-osm', id: f.id, x: f.p[0][0], z: f.p[0][1], h: H.waterways });
for (const w of gsi.slice(0, 5)) samples.push({ kind: 'water-gsi', id: w.id || 'gsi', x: w.outer[0][0], z: w.outer[0][1], h: H.waterways });

const b = await launchBrowser({ width: 1400, height: 900 });
const page = b.page;
const out = { mission: '58', label: LABEL, basemap: BASEMAP, url: URL_, browser: b.version, jsErrors: [], failed: [], googleRequests: 0, samples: [], shots: [] };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.responseReceived', (e) => { if (e.response.status >= 400) out.failed.push(e.response.status + ' ' + e.response.url); });
page.on('Network.requestWillBeSent', (e) => { if (/google|googleapis|gstatic/.test(e.request.url)) out.googleRequests++; });
const ev = (js) => page.evaluate(js);
fs.mkdirSync(OUT_DIR, { recursive: true });
const shot = async (name) => {
  const { data: d } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
  const f = `${LABEL}-${name}.jpg`;
  fs.writeFileSync(path.join(OUT_DIR, f), Buffer.from(d, 'base64'));
  out.shots.push(f);
};
try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 80; i++) {
    await sleep(1500);
    if ((await ev("!!(window.__mission37dQA && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break;
  }
  await sleep(4000);
  out.renderInfo = JSON.parse(await ev('JSON.stringify(window.__mission37dQA.renderInfo())'));

  for (const globeOn of [true, false]) {
    await ev(`window.__mission37dQA.setGlobe(${globeOn})`);
    for (const s of samples) {
      await ev(`window.__mission37dQA.lookAtLocal(${s.x}, ${s.z}, ${s.h}, 120, -90, 0)`);
      await sleep(1200);
      const r = await ev(`(()=>{const q=window.__mission37dQA;const p=q.project(${s.x},${s.z},${s.h});if(!p||!p.inCanvas)return JSON.stringify({err:'offscreen'});
        const l=q.pickLocal(p.x,p.y);return JSON.stringify({px:[Math.round(p.x),Math.round(p.y)],hit:l})})()`).then(JSON.parse);
      const rec = { globe: globeOn, kind: s.kind, id: s.id, tier: s.tier, expect: { x: s.x, z: s.z, h: s.h }, ...r };
      if (r.hit) { rec.dxz = Math.hypot(r.hit.x - s.x, r.hit.z - s.z); rec.dh = r.hit.h - s.h; }
      out.samples.push(rec);
    }
  }
  await ev('window.__mission37dQA.setGlobe(true)');

  // 目視用の比較画像: 建物と道路/水が接する 3 箇所（サンプルの最初の道路・OSM水域・GSI水域）× 真上/斜め × globe ON/OFF × 道路/水 ON/OFF
  const spots = [samples.find((s) => s.kind === 'road'), samples.find((s) => s.kind === 'water-osm'), samples.find((s) => s.kind === 'water-gsi')].filter(Boolean);
  for (const [i, s] of spots.entries()) {
    for (const v of [{ n: 'top', pitch: -90, range: 220 }, { n: 'obl', pitch: -40, range: 260 }]) {
      await ev(`window.__mission37dQA.lookAtLocal(${s.x}, ${s.z}, 0, ${v.range}, ${v.pitch}, 0)`);
      await sleep(2500);
      await shot(`spot${i}-${s.kind}-${v.n}-all`);
      await ev('window.__mission37dQA.setGlobe(false)'); await sleep(1200); await shot(`spot${i}-${s.kind}-${v.n}-globeOFF`); await ev('window.__mission37dQA.setGlobe(true)');
      for (const L of ['roads', 'waterways', 'gsiwater']) await ev(`window.__mission37dQA.setLayer('${L}', false)`);
      await sleep(1500); await shot(`spot${i}-${s.kind}-${v.n}-vecOFF`);
      for (const L of ['roads', 'waterways', 'gsiwater']) await ev(`window.__mission37dQA.setLayer('${L}', true)`);
    }
  }
} catch (e) { out.fatal = String(e && e.stack || e); }

// 集計
const agg = {};
for (const r of out.samples) {
  if (!r.hit) continue;
  const k = `${r.kind}|globe=${r.globe}`;
  (agg[k] ||= { n: 0, dxz: [], dh: [] });
  agg[k].n++; agg[k].dxz.push(r.dxz); agg[k].dh.push(r.dh);
}
const st = (a) => { const s = [...a].sort((x, y) => x - y); return { min: +s[0].toFixed(2), med: +s[Math.floor(s.length / 2)].toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
out.summary = Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, { n: v.n, dxz: st(v.dxz), dh: st(v.dh) }]));
out.offscreenOrNoDepth = out.samples.filter((r) => !r.hit).length;
fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-result.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ renderInfo: out.renderInfo, summary: out.summary, noDepth: out.offscreenOrNoDepth, shots: out.shots.length, jsErrors: out.jsErrors, failed: out.failed, google: out.googleRequests, fatal: out.fatal }, null, 1));
try { await b.close(); } catch { /* noop */ }
srv.close(); process.exit(0);
