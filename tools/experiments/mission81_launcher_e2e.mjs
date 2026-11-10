// Mission 81: ランチャー(tools/mission81-local-preview.mjs)を子プロセスで起動し、その URL を headless Chrome で開いて検証する。
//   node tools/experiments/mission81_launcher_e2e.mjs [nishi]
// 検証: 127.0.0.1 のみ bind / tileset+GLB の HTTP 200 / HUD 棟数 / 建物 tileset 表示 ON-OFF の画素差分 / 真上・斜め / 実マウスクリックで canonicalId /
//       区境界(N03)に対する建物の範囲。headless はソフトウェア描画で FPS は実機値ではない。道路ポリラインとの重ね描きは未検証。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchBrowser } from '../lib/cdp-browser.js';

const ward = process.argv[2] || 'nishi';
const PORT = 8182, OUT = 'data/reports/mission81';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;

const child = spawn(process.execPath, ['tools/mission81-local-preview.mjs', '--ward', ward, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
let url = null;
for (let i = 0; i < 600 && !url; i++) { await sleep(500); const m = log.match(/\[81\] open: (\S+)/); if (m) url = m[1]; if (child.exitCode != null) break; }
if (!url) { console.error('launcher did not print a URL\n' + log.slice(-800)); process.exit(1); }

const out = { mission: '81', ward, url, headless: true, note: 'software rendering; timings are not device values; road polyline overlay not tested',
  launcherLogHasLoopbackOnly: /loopback only/.test(log), urlHost: new URL(url).hostname, googleRequests: [], httpErrors: [], http200: 0, glb200: 0, tileset200: 0, jsErrors: [] };
const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE.test(new URL(e.request.url).hostname)) out.googleRequests.push(e.request.url); } catch { /* data: */ } });
page.on('Network.responseReceived', (e) => { const u = e.response.url; if (!u.includes('127.0.0.1:' + PORT)) return; const s = e.response.status;
  if (s >= 400) out.httpErrors.push(s + ' ' + u.replace(/^.*?:\d+/, '')); else if (s === 200) { out.http200++; if (/\.glb$/.test(u)) out.glb200++; if (/tileset\.json$/.test(u)) out.tileset200++; } });
const ev = (js) => page.evaluate(js);
const J = (js) => ev(`JSON.stringify(${js})`).then(JSON.parse);
const shotBuf = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name + '.jpg'), Buffer.from(data, 'base64')); return data; };
async function click(x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function waitReady() { for (let i = 0; i < 120; i++) { if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(500); } await sleep(1000); }
// 画素差分: raw RGBA を Chrome 内の canvas でデコードして比較（外部依存なし）
async function diffPct(b64a, b64b) {
  return ev(`(async () => { const L = (d) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/jpeg;base64,' + d; });
    const [a, b] = await Promise.all([L(${JSON.stringify(b64a)}), L(${JSON.stringify(b64b)})]); const c = document.createElement('canvas'); c.width = a.width; c.height = a.height; const g = c.getContext('2d');
    g.drawImage(a, 0, 0); const A = g.getImageData(0, 0, c.width, c.height).data; g.drawImage(b, 0, 0); const B = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 30) n++; return { diffPx: n, totalPx: A.length / 4 }; })()`);
}
const dir = path.resolve('temp/mission81/out', ward + '-2025');
const rep = JSON.parse(fs.readFileSync(path.join(dir, 'build-report.json'), 'utf8'));
const src = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
const byId = {};
for (const f of fs.readdirSync(path.join(dir, 'attrs'))) Object.assign(byId, JSON.parse(fs.readFileSync(path.join(dir, 'attrs', f), 'utf8')).byId);
const entries = Object.entries(byId);
const targets = entries.filter(([, a]) => a[0] >= 30 && a[0] <= 120).sort((a, b) => b[1][0] - a[1][0]).slice(0, 3).map(([id, a]) => ({ id, h: a[0], x: a[2], z: a[3] }));

try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: url + '&qa=1&fac=0' }); // qa=1 は localhost 限定の診断フック（投影・pick）
  for (let i = 0; i < 90; i++) { await sleep(1000); if ((await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break; }
  await sleep(1500);
  await ev(`window.__mission37dQA.setBuildingWard('${src.wardCode}')`); await waitReady();
  out.tilesets = await J('window.__mission37dQA.tilesetCount()');
  out.buildingState = await ev('window.__mission37g.buildingState');
  out.hudBuildings = await ev("document.getElementById('hs-bldg').textContent");
  out.coverageNote = await ev("document.getElementById('bldg-ward-note').textContent");
  const t0 = targets[0];
  // 真上
  await ev(`window.__mission37dQA.lookAtLocal(${t0.x}, ${t0.z}, 0, 2500, -90, 0)`); await sleep(2500); await waitReady();
  const topOn = await shotBuf('top-on');
  await ev('window.__mission37dQA.setTilesetShow(false)'); await sleep(1500);
  const topOff = await shotBuf('top-off');
  await ev('window.__mission37dQA.setTilesetShow(true)'); await sleep(1500);
  out.topDown = { ...(await diffPct(topOn, topOff)), camera: await J('window.__mission37dQA.cameraVsTilesets()') };
  // 斜め
  await ev(`window.__mission37dQA.lookAtLocal(${t0.x}, ${t0.z}, 0, 1200, -45, 30)`); await sleep(2500); await waitReady();
  const obOn = await shotBuf('oblique-on');
  await ev('window.__mission37dQA.setTilesetShow(false)'); await sleep(1500);
  const obOff = await shotBuf('oblique-off');
  await ev('window.__mission37dQA.setTilesetShow(true)'); await sleep(1000);
  out.oblique = await diffPct(obOn, obOff);
  // 実マウスクリック
  out.clicks = [];
  for (const t of targets) {
    let rec = { id: t.id, height: t.h, realMouseClick: false, selected: false };
    outer: for (const range of [250, 400]) {
      await ev(`window.__mission37dQA.lookAtLocal(${t.x}, ${t.z}, ${t.h / 2}, ${range}, -50, 0)`); await sleep(1500); await waitReady();
      for (const f of [0.5, 1, 0.1]) {
        const p = await J(`window.__mission37dQA.project(${t.x}, ${t.z}, ${t.h * f})`);
        if (!p || !p.inCanvas) continue;
        for (const [dx, dy] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [10, 5], [-10, 5], [10, -5], [-10, -5], [18, 0], [-18, 0]]) {
          if ((await ev(`window.__mission37dQA.pickId(${p.x + dx}, ${p.y + dy})`)) !== t.id) continue;
          await click(p.x + dx, p.y + dy);
          for (let i = 0; i < 40; i++) { if ((await ev('window.__mission37g.selectedCanonicalId')) === t.id) break; await sleep(250); }
          rec = { id: t.id, height: t.h, realMouseClick: true, selected: (await ev('window.__mission37g.selectedCanonicalId')) === t.id };
          break outer;
        }
      }
    }
    if (rec.selected && out.clicks.every((c) => !c.shot)) { await shotBuf('click-' + t.id.slice(5, 13)); rec.shot = 'click-' + t.id.slice(5, 13) + '.jpg'; }
    out.clicks.push(rec);
  }
  // 建物の座標範囲 vs 区境界(N03 bbox)
  const polys = JSON.parse(fs.readFileSync('data/processed/osaka-city/boundaries/ward-classification-polygons.json', 'utf8'));
  const w = polys.wards.find((x) => x.wardId === ward);
  const xs = entries.map(([, a]) => a[2]), zs = entries.map(([, a]) => a[3]);
  const inb = entries.filter(([, a]) => a[2] >= w.bbox.minX && a[2] <= w.bbox.maxX && a[3] >= w.bbox.minZ && a[3] <= w.bbox.maxZ).length;
  out.coverage = { buildings: entries.length, bboxX: [Math.min(...xs), Math.max(...xs)].map(Math.round), bboxZ: [Math.min(...zs), Math.max(...zs)].map(Math.round), wardBbox: w.bbox, insideWardBboxPct: +(100 * inb / entries.length).toFixed(2) };
} catch (e) { out.fatal = String(e && e.stack || e); }
child.kill('SIGINT'); for (let i = 0; i < 20 && child.exitCode == null; i++) await sleep(250);
const sm = log.match(/stopped\. (\{.*\})/); out.serverStats = sm ? JSON.parse(sm[1]) : null; // GLB は Cesium の worker が取得し、ページ側の Network イベントに出ないためサーバー側で数える
const exp = rep.totals.buildings;
out.pass = !out.fatal && out.tilesets?.n === 1 && out.buildingState === 'ready' && String(out.hudBuildings).replace(/,/g, '').includes(String(exp)) && exp === 12603
  && out.topDown?.diffPx > 5000 && out.oblique?.diffPx > 5000 && out.clicks?.filter((c) => c.selected).length >= 1
  && out.serverStats?.glb200 > 0 && out.serverStats?.tileset200 > 0 && out.jsErrors.length === 0 && out.googleRequests.length === 0 && out.urlHost === '127.0.0.1' && out.launcherLogHasLoopbackOnly
  && out.httpErrors.every((x) => /(index\.json|layers-report\.json|labels\.json|favicon)/.test(x));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'e2e.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ pass: out.pass, hud: out.hudBuildings, tilesets: out.tilesets, state: out.buildingState, top: out.topDown?.diffPx, oblique: out.oblique?.diffPx, clicks: out.clicks?.map((c) => c.selected), http200: out.http200, server: out.serverStats, httpErrors: out.httpErrors.slice(0, 6), js: out.jsErrors.slice(0, 3), google: out.googleRequests.length, coverage: out.coverage, fatal: out.fatal }, null, 1));
await b.close?.(); process.exit(out.pass ? 0 : 1);
