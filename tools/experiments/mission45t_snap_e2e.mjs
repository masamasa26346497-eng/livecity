// Mission 45T: 45S-2 の対応点スナップ(線分交点/線上最近点/半径拒否/緑線)を 45O 診断画面で実マウスクリック E2E。合成 fixture のみ。
//   node tools/experiments/mission45t_snap_e2e.mjs [--out <json>]
// 地理院タイルは Network.setBlockedURLs で遮断（外部へは一切出ない）。実 Windows Chrome の確認ではない。ブラウザが無ければ exit 0 で { skipped }。
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

// 2 本の斜め線(交点 (250,250) に頂点なし)、孤立した 1 本(線上最近点用)。頂点は交点から >100 m。
export function fixtureSnap() {
  return { meta: { origin: { lat: 34.604208, lon: 135.52502 }, mpd: 111320, unit: 'm', axes: 'fixture', ward: 'fixture', bbox: { minX: 0, maxX: 500, minZ: 0, maxZ: 500 },
    source: { buildings: 'synthetic fixture', roadsConvention: 'znorth-neg-v1' } },
  footprints: [[[20, 20], [60, 20], [60, 60], [20, 60]]],
  roads: [[[100, 100], [400, 400]], [[100, 400], [400, 100]], [[50, 480], [450, 480]]] };
}

async function main() {
  if (!BROWSER_CANDIDATES.some((p) => fs.existsSync(p))) { console.log(JSON.stringify({ skipped: 'no browser' })); return { skipped: true }; }
  const srv = http.createServer((req, res) => {
    const f = path.join(PUB, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm45t-'));
  fs.writeFileSync(path.join(tmp, 'diag.json'), JSON.stringify(fixtureSnap()));
  const b = await launchBrowser({ width: 1280, height: 800 });
  const R = { browser: b.version, checks: {}, errors: [], externalRequests: [], blockedGsi: 0 };
  try {
    const p = b.page;
    p.on('Runtime.exceptionThrown', (e) => R.errors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
    p.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error') R.errors.push('console.error'); });
    await p.send('Network.enable');
    await p.send('Network.setBlockedURLs', { urls: ['*://cyberjapandata.gsi.go.jp/*'] });
    p.on('Network.loadingFailed', (e) => { if (e.blockedReason) R.blockedGsi++; });
    p.on('Network.requestWillBeSent', (e) => {
      const u = e.request.url;
      if (!u.startsWith('http://127.0.0.1:' + port) && !u.startsWith('data:') && !u.startsWith('https://cyberjapandata.gsi.go.jp/')) R.externalRequests.push(u);
    });
    await p.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/mission45o-align-diag.html' });
    await sleep(1000);
    const doc = await p.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await p.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    await p.send('DOM.setFileInputFiles', { nodeId, files: [path.join(tmp, 'diag.json')] });
    await sleep(500);
    const ev = (s) => p.evaluate(s);
    const rect = JSON.parse(await ev("JSON.stringify(document.getElementById('cv').getBoundingClientRect())"));
    const scr = async (x, z) => { const s = JSON.parse(await ev('JSON.stringify(window.__diag45.toScreen(' + x + ',' + z + '))')); return [rect.left + s[0], rect.top + s[1]]; };
    const click = async (x, y) => {
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(150);
    };
    const mode = () => ev('window.__diag45.cpMode()');
    const pairs = () => ev('window.__diag45.cpPairs()');
    const cpout = () => ev('window.__diag45.cpOut()');
    const cpstate = () => ev("document.getElementById('cpstate').textContent");
    const offsets = () => ev("['dx','dz','rx','rz'].map(function(i){return document.getElementById(i).value}).join(',')");
    const green = () => ev("(function(){var c=document.getElementById('cv'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,n=0;for(var i=0;i<d.length;i+=4){if(d[i]<40&&d[i+1]>140&&d[i+2]<40)n++;}return n;})()");
    const sc = await ev('(function(){var a=window.__diag45.toScreen(0,0),b=window.__diag45.toScreen(100,0);return (b[0]-a[0])/100;})()');
    R.pxPerM = sc;
    const addBtn = async () => { const r = JSON.parse(await ev("JSON.stringify(document.getElementById('cpadd').getBoundingClientRect())")); await click(r.left + r.width / 2, r.top + r.height / 2); };

    // --- 1) 交点スナップ: 頂点のない交点 (250,250) の近く(約 6 画素ずれ)をクリック
    R.checks.greenBefore = await green();
    await addBtn();
    R.checks.modeAfterAdd = await mode();
    const [ix, iy] = await scr(250, 250);
    await click(ix + 5, iy - 4);
    R.checks.mode2AfterRoadClick = (await mode()) === 2;
    let o;
    // 緑の四角(道路点)が出る
    R.checks.greenAfterRoad = await green();
    // 地理院側点: 交点から東へ 8 m ずらした位置をクリック → 差の東+ ≈ 8 m
    const [gx, gy] = await scr(258, 250);
    await click(gx, gy);
    R.checks.pairs1 = await pairs();
    o = await cpout();
    R.checks.intersectionLabel = o.includes('C1') && o.includes('[道路線分の交点にスナップ');
    const m = /C1 東\+(-?[\d.]+) m \/ 北\+(-?[\d.]+) m/.exec(o);
    R.checks.c1 = m ? { e: +m[1], n: +m[2] } : null;
    // 交点が正確にスナップされていれば東+ ≈ 8 m × (実m/局所m 比) ≈ 7.7〜8.0、北 ≈ 0。頂点スナップ(>100 m 離れる)なら大きくずれる。
    R.checks.snappedToTrueIntersection = !!m && Math.abs(+m[1] - 8) < 0.6 && Math.abs(+m[2]) < 0.6;
    R.checks.c1OnlyNoApply = o.includes('C1のみでは共通オフセットを判断できません。適用不可') && (await offsets()) === '0,0,0,0';
    R.checks.greenLineDrawn = (await green()) > R.checks.greenBefore + 30;

    // --- 2) 線上最近点: 孤立線 z=480 の 3 m 上をクリック(交点なし) → segment
    await addBtn();
    const [sx, sy] = await scr(200, 477);
    await click(sx, sy);
    // 地理院点を指定して組を確定
    const [sgx, sgy] = await scr(200, 480);
    await click(sgx, sgy);
    R.checks.pairs2 = await pairs();
    const oo = await cpout();
    R.checks.segmentKindLabel = oo.includes('C2') && oo.includes('[線上最近点(交差点ではない)');
    R.checks.segmentNoteShown = oo.includes('線に沿った方向の差は意味を持ちません');

    // --- 3) 半径拒否: どの線からも 24 画素より遠い (450,20) 付近をクリック → 拒否して mode 1 のまま、組は増えない
    await addBtn();
    R.checks.modeBeforeReject = await mode();
    const [rx, ry] = await scr(450, 20);
    const before = await pairs();
    await click(rx, ry);
    R.checks.rejectedStaysMode1 = (await mode()) === 1;
    R.checks.rejectMsg = (await cpstate()).includes('拒否しました');
    R.checks.rejectNoNewPair = (await pairs()) === before;
    // 後始末: クリアで未計測に戻る
    const clr = JSON.parse(await ev("JSON.stringify(document.getElementById('cpclr').getBoundingClientRect())"));
    await click(clr.left + 5, clr.top + 5);
    R.checks.clearReset = (await pairs()) === 0 && (await cpout()) === '(未計測)';
    R.checks.noOffsetsEver = (await offsets()) === '0,0,0,0';
  } finally { await b.close(); srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  R.checks.noExternalRequests = R.externalRequests.length === 0;
  R.checks.noJsErrors = R.errors.length === 0;
  const keys = ['intersectionLabel', 'mode2AfterRoadClick', 'snappedToTrueIntersection', 'c1OnlyNoApply', 'greenLineDrawn', 'segmentKindLabel', 'segmentNoteShown',
    'rejectedStaysMode1', 'rejectMsg', 'rejectNoNewPair', 'clearReset', 'noOffsetsEver', 'noExternalRequests', 'noJsErrors'];
  R.pass = keys.every((k) => R.checks[k] === true);
  if (out) fs.writeFileSync(out, JSON.stringify(R, null, 1));
  console.log(JSON.stringify(R, null, 1));
  return R;
}
const r = await main();
if (!r.skipped && !r.pass) process.exit(1);
