#!/usr/bin/env node
'use strict';
// Mission 198: 静的配信バンドル(lod2-cloud-bundle.mjs の出力)を、LOD2 専用サーバ無しの素の静的 HTTP + 非 localhost ホスト名で開き、headless Chrome で測る。
//   node tools/lod2/lod2-cloud-verify.cjs [--bundle temp/cloud-bundle] [--at 135.4959,34.7055] [--out temp/cloud-verify]
// 実データ(公式 PLATEAU 2025)。SwiftShader。実 GPU / Vercel 上の挙動は未測定。
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), http = require('http');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE = path.resolve(ROOT, opt('bundle', 'temp/cloud-bundle'));
const out = path.resolve(ROOT, opt('out', 'temp/cloud-verify'));
const AT = opt('at', '135.4959,34.7055').split(',').map(Number);
const port = Number(opt('port', 8198)), cport = Number(opt('cdp', 9398));
const HOST = 'lc-cloud.test';
const chromeBin = opt('chrome', ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[cloud-verify]', ...a);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary' };
const served = { ok: 0, notFound: [] };
// 素朴な静的サーバ(Vercel 相当)。/__lod2/ などの動的エンドポイントは無い。
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  const f = path.resolve(BUNDLE, '.' + p);
  if (!f.startsWith(BUNDLE + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { served.notFound.push(p); res.writeHead(404); res.end('nf'); return; }
  served.ok++; res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

// BUNDLE_MANIFEST.json (cloud-bundle) or ext-3dtiles/index.json (cloud-merged: lod2-cloud-merge does not copy the manifest).
function wardsListPath() { const m = path.join(BUNDLE, 'BUNDLE_MANIFEST.json'); return fs.existsSync(m) ? m : path.join(BUNDLE, 'ext-3dtiles', 'index.json'); }
async function main() {
  if (!fs.existsSync(wardsListPath())) throw new Error('バンドル未生成: ' + BUNDLE);
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--host-resolver-rules=MAP ' + HOST + ' 127.0.0.1', '--window-size=1280,800', '--remote-debugging-port=' + cport, '--user-data-dir=' + path.join(out, 'profile'), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const R = { kind: 'REAL PLATEAU 2025 static bundle (not fixture)', host: HOST, swiftshader: true, http: { ok: 0, bad: [] }, console: [] };
  try {
    let targets; for (let i = 0; i < 150; i++) { try { targets = await getJson('http://127.0.0.1:' + cport + '/json'); break; } catch (e) { await sleep(200); } }
    if (!targets) throw new Error('Chrome のデバッグポートに接続できません');
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
    let id = 0; const pend = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d.error); pend.delete(d.id); return; }
      if (d.method === 'Network.responseReceived') { const u = d.params.response.url, s = d.params.response.status; if (u.includes(HOST)) { if (s === 200) R.http.ok++; else R.http.bad.push({ url: u.replace(/^.*lc-cloud\.test:\d+/, ''), status: s }); } }
      if (d.method === 'Runtime.exceptionThrown') R.console.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).slice(0, 200));
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') R.console.push('ERR ' + d.params.args.map((a) => a.value || a.description).join(' ').slice(0, 200)); };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), sleep(90000).then(() => ({ __t: 1 }))]); if (r.__t) throw new Error('応答停止: ' + expr.slice(0, 60)); return r.result ? r.result.value : r; };
    await send('Network.enable'); await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://' + HOST + ':' + port + '/' });   // クエリ無し(既定の補完は HTML 内蔵)
    const WARDS = JSON.parse(fs.readFileSync(wardsListPath(), 'utf8')).wards.length;
    for (let i = 0; i < 120; i++) { if ((await ev('!!document.getElementById("sel-bldg-mode")')) === true) break; await sleep(500); }
    await ev('(()=>{const m=document.getElementById("sel-bldg-mode");m.value="all";m.dispatchEvent(new Event("change"));})()');   // 利用者が「全域3D」を選ぶ操作に相当
    for (let i = 0; i < 400; i++) { const n = await ev('(window.__mission37g && window.__mission37g.extraMeta && window.__mission37g.extraMeta.length) || 0').catch(() => 0); if (i % 20 === 0) log('extraMeta', n, 'n=' + i, R.console.slice(-1)[0] || ''); if (n >= WARDS) break; await sleep(500); }
    for (let i = 0; i < 360; i++) { const s = await ev('window.__lc152 && window.__lc152.state.status'); if (i % 20 === 0) log('lod2 status', s, 'n=' + i); if (s === 'ready' || s === 'error' || s === 'refused') break; await sleep(500); }
    R.search = await ev('location.search'); R.cloudFlag = await ev('JSON.stringify(window.__lcCloud||null)');
    R.lod2State = JSON.parse(await ev('JSON.stringify(window.__lc152 && {status: window.__lc152.state.status, error: window.__lc152.state.error, clipMode: window.__lc152.state.clipMode, lod2Buildings: window.__lc152.state.lod2Buildings})'));
    R.extraMeta = JSON.parse(await ev('JSON.stringify(window.__mission37g.extraMeta)'));
    const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const b = Buffer.from(r.data, 'base64'); fs.writeFileSync(path.join(out, n), b); return b; };
    const diff = (a, b) => ev('(async () => { const ld = (s) => new Promise((r) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const x = c.getContext("2d"); x.drawImage(i, 0, 0); r(x.getImageData(0, 0, i.width, i.height).data); }; i.src = "data:image/png;base64," + s; }); const [p, q] = await Promise.all([ld("' + a.toString('base64') + '"), ld("' + b.toString('base64') + '")]); let n = 0; for (let k = 0; k < p.length; k += 4) if (Math.abs(p[k] - q[k]) + Math.abs(p[k + 1] - q[k + 1]) + Math.abs(p[k + 2] - q[k + 2]) > 24) n++; return n; })()');
    const setMode = (v) => ev('(()=>{const m=document.getElementById("sel-bldg-mode");m.value="' + v + '";m.dispatchEvent(new Event("change"));})()');
    const tsStats = async () => JSON.parse(await ev('window.__lc152.diagnose().then(d => JSON.stringify(d.tilesets))'));
    await setMode('all'); await sleep(2000);
    await ev('window.__lc152.lookAtFirst(500, -45, [' + AT[0] + ',' + AT[1] + '])'); await sleep(14000);
    R.camera = JSON.parse(await ev('JSON.stringify(window.__lc152.camera())'));
    const both = await shot('both.png'); R.tilesBoth = await tsStats();
    await ev('window.__lc152.setShow(false)'); await sleep(3000);
    const l1 = await shot('lod1-only.png'); R.tilesLod1Only = await tsStats();
    await ev('window.__lc152.setShow(true)'); await sleep(2500);
    R.pixelDiff = { bothVsLod1Only: await diff(both, l1) };
    R.lod2Tile = { tileVisible: await ev('window.__lc152.state.tileVisible'), tileLoad: await ev('window.__lc152.state.tileLoad'), tileFailed: await ev('window.__lc152.state.tileFailed') };
    R.static = { filesServed200: served.ok, notFound: served.notFound.slice(0, 20), notFoundAll: [...new Set(served.notFound)].slice(0, 400), notFoundCount: served.notFound.length };
    const sel = (R.tilesBoth || []).filter((t) => /lod2/i.test(String(t.ward || t.id || t.kind || '')));
    R.pass = R.lod2State.status === 'ready' && R.extraMeta.length >= WARDS && R.pixelDiff.bothVsLod1Only > 200 && !(R.http.bad.some((b) => /^\/(ext-3dtiles|lod2-preview|mission37g-data)\//.test(b.url) || b.status >= 500)) && R.lod2Tile.tileFailed === 0;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(R, null, 1));
    console.log(JSON.stringify(R, null, 1)); ws.close();
  } finally { chrome.kill(); srv.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
