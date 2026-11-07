// Mission 45Q: 45O 診断画面（mission45o-align-diag.html）の自動ブラウザ E2E。合成 fixture のみ・ネットワーク外部通信なし（GSI は OFF 既定のまま検証）。
//   node tools/experiments/mission45q_diag_ui_e2e.mjs [--out <json>]
// 実 Windows Chrome の確認ではない。ブラウザが無ければ exit 0 で { skipped } を出す。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, BROWSER_CANDIDATES } from '../lib/cdp-browser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUB = path.join(ROOT, 'public');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;

export function fixtureDiag() {
  const fp = [], roads = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) { const x = i * 100 + 20, z = j * 100 + 20; fp.push([[x, z], [x + 60, z], [x + 60, z + 60], [x, z + 60]]); }
  for (let k = 0; k <= 5; k++) { roads.push([[k * 100, 0], [k * 100, 500]]); roads.push([[0, k * 100], [500, k * 100]]); }
  return { meta: { origin: { lat: 34.604208, lon: 135.52502 }, mpd: 111320, unit: 'm', axes: 'fixture', ward: 'fixture', bbox: { minX: 0, maxX: 500, minZ: 0, maxZ: 500 },
    source: { buildings: 'synthetic fixture', buildingsMtime: '2000-01-01 .. 2000-01-02', roadsGenerated: null, roadsConvention: 'znorth-neg-v1' } }, footprints: fp, roads };
}

async function main() {
  if (!BROWSER_CANDIDATES.some((p) => fs.existsSync(p))) { console.log(JSON.stringify({ skipped: 'no browser' })); return { skipped: true }; }
  const srv = http.createServer((req, res) => {
    const f = path.join(PUB, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm45q-'));
  fs.writeFileSync(path.join(tmp, 'diag.json'), JSON.stringify(fixtureDiag()));
  fs.writeFileSync(path.join(tmp, 'bad.json'), '{"meta":{}}');
  fs.writeFileSync(path.join(tmp, 'broken.json'), '{not json');
  const b = await launchBrowser({ width: 1280, height: 800 });
  const R = { browser: b.version, checks: {}, errors: [], externalRequests: [] };
  try {
    const p = b.page;
    p.on('Runtime.exceptionThrown', (e) => R.errors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
    p.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error') R.errors.push('console.error'); });
    await p.send('Network.enable');
    p.on('Network.requestWillBeSent', (e) => { if (!e.request.url.startsWith('http://127.0.0.1:' + port) && !e.request.url.startsWith('data:')) R.externalRequests.push(e.request.url); });
    await p.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/mission45o-align-diag.html' });
    await sleep(1200);
    const st = () => p.evaluate('JSON.stringify(window.__diag45.state())').then(JSON.parse);
    const s0 = await st();
    R.checks.beforeLoad = { side: s0.sideWidth, canvas: s0.canvas, loaded: s0.loaded };
    R.checks.twoPaneBeforeLoad = s0.sideWidth >= 300 && s0.canvas[0] > 600 && !s0.loaded;
    const doc = await p.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await p.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    const pick = async (f) => { await p.send('DOM.setFileInputFiles', { nodeId, files: [path.join(tmp, f)] }); await sleep(500); };
    const info = () => p.evaluate("document.getElementById('info').textContent");
    await pick('broken.json'); R.checks.brokenJsonMsg = (await info()).startsWith('読み込み失敗'); R.checks.stillUnloadedAfterBroken = !(await st()).loaded;
    await pick('bad.json'); R.checks.badSchemaMsg = (await info()).startsWith('読み込み失敗');
    await pick('diag.json');
    const s1 = await st();
    R.checks.afterLoad = { loaded: s1.loaded, footprints: s1.footprints, roads: s1.roads, gsi: s1.gsi, side: s1.sideWidth };
    R.checks.loadedOk = s1.loaded && s1.footprints === 25 && s1.roads === 12 && s1.gsi === false;
    R.checks.provenanceShown = (await info()).includes('2000-01-01');
    // 描画ピクセル: footprint 赤 / 道路 青が実際に描かれている
    const px = await p.evaluate(`(function(){var c=document.getElementById('cv'),g=c.getContext('2d'),d=g.getImageData(0,0,c.width,c.height).data,r=0,bl=0;for(var i=0;i<d.length;i+=4){if(d[i]>180&&d[i+1]<140&&d[i+2]<140)r++;if(d[i+2]>180&&d[i]<120)bl++;}return JSON.stringify({red:r,blue:bl});})()`).then(JSON.parse);
    R.checks.pixels = px; R.checks.redAndBluePainted = px.red > 200 && px.blue > 100;
    // クリックでピン、地理院 OFF のまま
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 400, button: 'left', clickCount: 1 });
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 400, button: 'left', clickCount: 1 });
    await sleep(200);
    R.checks.pinAdded = (await st()).pins === 1;
    // リサイズ後も左ペイン幅が保たれる
    await p.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const s2 = await st(); R.checks.afterResize = { side: s2.sideWidth, canvas: s2.canvas }; R.checks.resizeKeepsSidebar = s2.sideWidth >= 300 && s2.canvas[0] > 400;
    // 視差計算
    R.checks.parallax30m30deg = await p.evaluate('window.__diag45.parallax(30,30)');
    R.checks.parallaxOk = Math.abs(R.checks.parallax30m30deg - 17.32) < 0.01;
  } finally { await b.close(); srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  R.checks.noExternalRequests = R.externalRequests.length === 0;
  R.checks.noJsErrors = R.errors.length === 0;
  const keys = ['twoPaneBeforeLoad', 'brokenJsonMsg', 'stillUnloadedAfterBroken', 'badSchemaMsg', 'loadedOk', 'provenanceShown', 'redAndBluePainted', 'pinAdded', 'resizeKeepsSidebar', 'parallaxOk', 'noExternalRequests', 'noJsErrors'];
  R.pass = keys.every((k) => R.checks[k] === true);
  if (out) fs.writeFileSync(out, JSON.stringify(R, null, 1));
  console.log(JSON.stringify(R, null, 1));
  return R;
}
const r = await main();
if (!r.skipped && !r.pass) process.exit(1);
