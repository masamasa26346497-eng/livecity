// tools/experiments/mission148_station_operator_e2e.mjs
// [Mission 148] 駅の運営会社 → 描画色 → 駅名ラベルの濃さ を、正規ページ (mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1) を
// headless Chrome で実際に開いて確認するスモーク。
//   入力: 駅の実座標(public/mission145-data/stations-24.json) の近くを通る **合成の** 路線 (railways.json, 名前だけ実在の路線名)。
//         ※路線形状は合成。実OSMの路線ではない。ローカルPCの実データでの確認は別（ランチャー実行後に同じ画面で確認）。
//   手順: 合成 layers root を OS の temp に作る → mission145-build-stations.cjs --layers-root で stations-24.local.json を生成
//         (gitignore 済み。既に存在する場合は中止＝利用者のファイルを上書きしない) → ページを開く → 色/ラベルを読む → ローカル版を削除。
// 使い方: node tools/experiments/mission148_station_operator_e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { launchBrowser } from '../lib/cdp-browser.js';

const OUT_DIR = 'data/reports/mission148-stations';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE_HOSTS = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const LOCAL = path.resolve('public/mission145-data/stations-24.local.json');
if (fs.existsSync(LOCAL)) { console.error('ABORT: ' + LOCAL + ' exists (not overwritten). Move it away and re-run.'); process.exit(2); }

// ── 合成 layers root ──
const all = JSON.parse(fs.readFileSync('public/mission145-data/stations-24.json', 'utf8')).stations;
const pick = (ward, name) => all.find((s) => s.wardId === ward && s.name === name);
const FIX = [
  { st: pick('sumiyoshi', '住吉大社'), line: '南海電気鉄道南海本線', ward: 'sumiyoshi', expect: 'nankai' },
  { st: pick('kita', '大阪'), line: 'JR大阪環状線', ward: 'kita', expect: 'jr' },
  { st: pick('chuo', 'なんば'), line: '大阪市高速電気軌道千日前線', ward: 'chuo', expect: 'metro' },
  { st: pick('kita', '梅田'), line: '阪急電鉄神戸本線', ward: 'kita', expect: 'hankyu' },
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc148-layers-'));
const byWard = {};
FIX.forEach((f, i) => { (byWard[f.ward] = byWard[f.ward] || []).push({ id: 'syn_' + i, kind: 'line', railway: 'rail', name: f.line, p: [[f.st.x - 80, f.st.z - 20], [f.st.x, f.st.z], [f.st.x + 80, f.st.z + 20]] }); });
for (const [w, features] of Object.entries(byWard)) { fs.mkdirSync(path.join(tmp, w, 'layers'), { recursive: true }); fs.writeFileSync(path.join(tmp, w, 'layers', 'railways.json'), JSON.stringify({ layer: 'railways', synthetic: true, features })); }
const built = JSON.parse(execFileSync(process.execPath, ['tools/mission145-build-stations.cjs', '--layers-root', tmp, '--out', LOCAL], { encoding: 'utf8' }));

const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8148, r));
const URL_ = 'http://localhost:8148/mission37g-osaka-24ward-mvp.html?qa=1&nobuiltin=1&ext45=1';

const out = { mission: '148', note: 'rail lines are SYNTHETIC fixtures near real station coordinates; stations/names are real OSM data', url: URL_, generatedAt: new Date().toISOString(), build: { withOperator: built.withOperator, operatorUnknown: built.operatorUnknown, byBasis: built.byBasis, operatorData: built.operatorData }, googleRequests: [], failed404: [], jsErrors: [], checks: {} };
let b;
try {
  b = await launchBrowser({ width: 1500, height: 940 });
  const page = b.page;
  page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
  page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE_HOSTS.test(new URL(e.request.url).hostname)) out.googleRequests.push(e.request.url); } catch { /* data: */ } });
  page.on('Network.responseReceived', (e) => { if (e.response.status >= 400 && !/tile\.|cyberjapandata|favicon|ext-3dtiles\/index\.json|towns-24(\.local)?\.json/.test(e.response.url)) out.failed404.push(e.response.status + ' ' + e.response.url); });
  const ev = (js) => page.evaluate(js);
  const shot = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 }); fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), Buffer.from(data, 'base64')); return `${OUT_DIR}/${name}.jpg`; };
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    if ((await ev("!!(window.__mission37dQA && window.__mission37g && window.__mission37g.stations145 && window.__mission37g.stations145.render)").catch(() => false)) === true) break;
  }
  await sleep(1500);
  const s145 = await ev('JSON.stringify(window.__mission37g.stations145)').then(JSON.parse);
  out.stations145 = s145;
  const colors = s145.render.pointColors;
  out.checks.operatorDataConnected = s145.operatorDataConnected === true && /local\.json$/.test(s145.origin);
  out.checks.fixtureOperatorsResolved = built.withOperator >= FIX.length - 0 && (built.byBasis['nearby-line-name'] || 0) >= FIX.length;
  out.checks.atLeastTwoDistinctPointColors = colors.filter((c) => c !== '#8a949e').length >= 2;
  out.checks.noLabelDistanceFade = s145.render.labelsWithDistanceFade === 0;
  out.checks.labelFillOpaque = s145.render.labelMinFillAlpha === 1;
  out.checks.nameLabelsWhite = s145.render.whiteNameLabels === s145.total;
  // 実際の描画: 住吉大社の近景 / 区選択直後相当の中景で撮影し、ラベルを読む
  const t = FIX[0].st;
  for (const [alt, tag] of [[900, 'near'], [4000, 'mid']]) {
    await ev(`window.__mission37dQA.lookAtLocal(${t.x}, ${t.z}, 0, ${alt}, -60, 0)`);
    await sleep(4000);
    out['shot_' + tag] = await shot('sumiyoshi-' + tag);
  }
  out.checks.pageHasNoJsErrors = out.jsErrors.length === 0;
  out.checks.googleRequestsZero = out.googleRequests.length === 0;
  out.checks.noUnexpected404 = out.failed404.length === 0;
  out.pass = Object.values(out.checks).every(Boolean);
} catch (e) {
  out.error = String(e && e.stack || e).slice(0, 600); out.pass = false;
} finally {
  try { if (b) await b.close(); } catch { /* noop */ }
  srv.close();
  fs.rmSync(LOCAL, { force: true });          // この QA が作った合成ローカル版だけを消す（開始時に存在しないことを確認済み）
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ pass: out.pass, checks: out.checks, build: out.build, render: out.stations145 && out.stations145.render, jsErrors: out.jsErrors, googleRequests: out.googleRequests.length, failed404: out.failed404, error: out.error }, null, 1));
}
process.exit(out.pass ? 0 : 1);
