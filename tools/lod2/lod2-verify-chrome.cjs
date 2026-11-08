#!/usr/bin/env node
'use strict';
// Mission 161: 実 Chrome(headless) で LOD2 オーバーレイを検証する。tilesLoaded だけを成功条件にしない。
//   node tools/lod2/lod2-verify-chrome.cjs [--port 8152] [--out temp/lod2-verify] [--chrome /usr/bin/chromium]
// 前提: lod2-preview-build.mjs 実行済み。サーバ(lod2-preview-serve.cjs)は本スクリプトが子プロセスで起動する。
// 成功条件(全て満たす): tileset HTTP200 / tileLoad>0 / tileVisible>0 / numberOfTrianglesSelected>0 / LOD2 表示 ON/OFF の画素差>0。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const port = Number(opt('port', 8152)), cport = Number(opt('cdp', 9332));
const out = path.resolve(opt('out', 'temp/lod2-verify'));
const chromeBin = opt('chrome', ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p)));
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'lod2-preview-serve.cjs'), '--port', String(port)], { stdio: 'inherit' });
  const chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--window-size=1280,800', '--remote-debugging-port=' + cport, '--user-data-dir=' + path.join(out, 'profile'), 'about:blank'], { stdio: 'ignore' });
  const result = { chrome: chromeBin, httpResponses: [], console: [] };
  try {
    let targets; for (let i = 0; i < 50; i++) { try { targets = await getJson('http://127.0.0.1:' + cport + '/json'); break; } catch (e) { await sleep(200); } }
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pend = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d.error); pend.delete(d.id); return; }
      if (d.method === 'Network.responseReceived') { const u = d.params.response.url; if (/lod2-preview\//.test(u)) result.httpResponses.push({ url: u.replace(/^.*\/lod2-preview\//, ''), status: d.params.response.status }); }
      if (d.method === 'Runtime.exceptionThrown') result.console.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).slice(0, 200));
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') result.console.push('ERR ' + d.params.args.map((a) => a.value || a.description).join(' ').slice(0, 200));
    };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result ? r.result.value : r; };
    await send('Network.enable'); await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://localhost:' + port + '/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1&lod2=1' });
    for (let i = 0; i < 120; i++) { const s = await ev('window.__lc152 && window.__lc152.state.status'); if (s === 'ready' || s === 'error' || s === 'refused') break; await sleep(500); }
    result.overlayStatus = await ev('JSON.stringify(window.__lc152 && window.__lc152.state)');
    await sleep(8000);   // アプリ自身の初期 flyTo(全域ビュー)が終わってからカメラを置く
    await ev('window.__lc152.lookAtFirst && window.__lc152.lookAtFirst(330, -38)');
    for (let i = 0; i < 40; i++) { await sleep(500); const s = JSON.parse(await ev('JSON.stringify(window.__lc152.state)')); if (s.tileLoad > 0 && s.tileVisible > 0) break; }
    await sleep(6000);   // 地図タイル/LOD1 の読み込み待ち
    result.camera = await ev('JSON.stringify(window.__lc152.camera())');
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, name); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return { f, b: Buffer.from(r.data, 'base64') }; };
    await ev('window.__lc152.setShow(true)'); await sleep(1500);
    const on = await shot('lod2-on.png');
    result.stats = await ev('JSON.stringify(window.__lc152.stats())');
    result.state = JSON.parse(await ev('JSON.stringify(window.__lc152.state)'));
    await ev('window.__lc152.setShow(false)'); await sleep(1500);
    const off = await shot('lod2-off.png');
    await ev('window.__lc152.setShow(true)');
    // 画素差: 2 枚の PNG をページ内で decode して比較(LOD2 ON/OFF のみが違う)
    const dpx = await ev('(async () => { const ld = (b) => new Promise((r) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const x = c.getContext("2d"); x.drawImage(i, 0, 0); r(x.getImageData(0, 0, i.width, i.height).data); }; i.src = "data:image/png;base64," + b; }); const A = await ld(' + JSON.stringify(on.b.toString('base64')) + '), B = await ld(' + JSON.stringify(off.b.toString('base64')) + '); let n = 0; for (let k = 0; k < A.length; k += 4) if (Math.abs(A[k] - B[k]) + Math.abs(A[k+1] - B[k+1]) + Math.abs(A[k+2] - B[k+2]) > 24) n++; return n; })()');
    result.visiblePixelDiff = dpx;
    result.screenshots = { on: on.f, off: off.f, onBytes: on.b.length, offBytes: off.b.length, identical: Buffer.compare(on.b, off.b) === 0 };
    result.renderErrors = await ev('JSON.stringify((window.__qaRenderErrors||[]).slice(0,3))');
    const s = result.state, st = JSON.parse(result.stats);
    result.pass = result.httpResponses.some((r) => r.url === 'tileset.json' && r.status === 200) && result.httpResponses.some((r) => /lod2\.glb/.test(r.url) && r.status === 200) &&
      s.tileLoad > 0 && s.tileVisible > 0 && st.numberOfTrianglesSelected > 0 && result.visiblePixelDiff > 200;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 1));
    console.log(JSON.stringify(result, null, 1));
    ws.close();
  } finally { chrome.kill(); srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
