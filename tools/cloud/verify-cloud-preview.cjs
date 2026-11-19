#!/usr/bin/env node
'use strict';
// Mission 196B: cloud-preview build output を「純静的 HTTP サーバ(特別なルート無し=Vercel と同等)」で配信し、
//   (1) 参照される全ファイルの HTTP ステータス  (2) headless Chrome での 37G 梅田近景の LOD1/LOD2 描画実測 を行う。
//   node tools/cloud/verify-cloud-preview.cjs [--dir temp/cloud-preview/static] [--out temp/cloud-verify] [--chrome PATH] [--no-chrome]
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const DIR = path.resolve(opt('dir', 'temp/cloud-preview/static')), OUT = path.resolve(opt('out', 'temp/cloud-verify'));
const chromeBin = opt('chrome', ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/local/share/chromium/chrome-linux/chrome'].find((p) => fs.existsSync(p)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary', '.css': 'text/css', '.png': 'image/png' };
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = { total: 0, ok: 0, notOk: [] };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p;
  try { p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  let f = path.join(DIR, p); if (!f.startsWith(DIR)) { res.writeHead(403); return res.end(); }
  if (p.endsWith('/')) f = path.join(f, 'index.html');
  tally.total++;
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { tally.notOk.push({ path: p, status: 404 }); res.writeHead(404); return res.end('not found'); }
    tally.ok++;
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
});
(async () => {
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  const result = { staticServer: 'pure fs static, no custom routes', dir: path.relative(process.cwd(), DIR) };
  const get = (p) => new Promise((res) => http.get({ host: '127.0.0.1', port, path: p }, (x) => { let n = 0; x.on('data', (d) => (n += d.length)); x.on('end', () => res({ p, status: x.statusCode, bytes: n })); }).on('error', () => res({ p, status: 0, bytes: 0 })));
  // (1) 必須ファイル + tileset が参照する全 GLB の HTTP 200
  const must = ['/', '/mission37g-osaka-24ward-mvp.html', '/cloud-preview.json', '/__lod2/diag.json', '/ext-3dtiles/index.json', '/lod2-preview/overlay.js', '/lod2-preview/clipnear.js', '/lod2-preview/diagnose.js', '/lod2-preview/tileset.json', '/lod2-preview/footprints.json'];
  const idx = JSON.parse(fs.readFileSync(path.join(DIR, 'ext-3dtiles/index.json'), 'utf8'));
  const uris = [];
  const walk = (n, base) => { if (!n) return; if (n.content && n.content.uri) uris.push(base + n.content.uri); (n.children || []).forEach((c) => walk(c, base)); };
  for (const w of idx.wards) { must.push('/ext-3dtiles/' + w.ward + '/tileset.json', '/ext-3dtiles/' + w.ward + '/source.json'); walk(JSON.parse(fs.readFileSync(path.join(DIR, 'ext-3dtiles', w.ward, 'tileset.json'), 'utf8')).root, '/ext-3dtiles/' + w.ward + '/'); }
  walk(JSON.parse(fs.readFileSync(path.join(DIR, 'lod2-preview/tileset.json'), 'utf8')).root, '/lod2-preview/');
  const all = must.concat(uris), res = [];
  for (let i = 0; i < all.length; i += 16) res.push(...(await Promise.all(all.slice(i, i + 16).map(get))));
  result.files = { checked: res.length, http200: res.filter((r) => r.status === 200 && r.bytes > 0).length, bad: res.filter((r) => !(r.status === 200 && r.bytes > 0)).slice(0, 10), glbReferenced: uris.length };
  result.pass200 = result.files.checked === result.files.http200;
  tally.total = 0; tally.ok = 0; tally.notOk = [];
  if (argv.includes('--no-chrome') || !chromeBin) { result.chrome = chromeBin ? 'skipped' : 'chrome not found'; console.log(JSON.stringify(result, null, 1)); srv.close(); process.exit(result.pass200 ? 0 : 1); }

  // (2) headless Chrome
  const cport = 9400 + Math.floor(Math.random() * 300);
  const chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,800',
    '--remote-debugging-port=' + cport, '--user-data-dir=' + path.join(OUT, 'profile'), 'about:blank'], { stdio: 'ignore' });
  const getJson = (u) => new Promise((rs, rj) => http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { rs(JSON.parse(b)); } catch (e) { rj(e); } }); }).on('error', rj));
  result.chrome = chromeBin; result.httpByKind = {}; result.consoleErrors = []; result.external = {};
  try {
    let targets; for (let i = 0; i < 60; i++) { try { targets = await getJson('http://127.0.0.1:' + cport + '/json'); break; } catch (e) { await sleep(250); } }
    if (!targets) throw new Error('Chrome debug port not reachable');
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pend = new Map(); const reqUrl = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d.error); pend.delete(d.id); return; }
      if (d.method === 'Network.responseReceived') {
        const u = d.params.response.url, s = d.params.response.status; let k = 'other';
        if (u.startsWith('http://127.0.0.1:' + port)) k = /\/lod2-preview\//.test(u) ? (/\.glb/.test(u) ? 'lod2-glb' : 'lod2-meta') : /\/ext-3dtiles\//.test(u) ? (/\.glb/.test(u) ? 'lod1-glb' : 'lod1-meta') : 'site';
        else { const h = new URL(u).host; result.external[h] = result.external[h] || { ok: 0, bad: 0 }; result.external[h][s < 400 ? 'ok' : 'bad']++; return; }
        const b = result.httpByKind[k] = result.httpByKind[k] || { n: 0, non200: [] }; b.n++; if (s !== 200 && s !== 304) b.non200.push(s + ' ' + u.replace(/^.*127\.0\.0\.1:\d+/, '').slice(0, 80));
      }
      if (d.method === 'Network.loadingFailed') result.consoleErrors.push('NETFAIL ' + (d.params.errorText || '') + ' ' + (d.params.blockedReason || ''));
      if (d.method === 'Runtime.exceptionThrown') result.consoleErrors.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).slice(0, 200));
    };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result ? r.result.value : r; };
    await send('Network.enable'); await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/mission37g-osaka-24ward-mvp.html' }); // クエリ無し: 既定クエリ注入も検証
    for (let i = 0; i < 160; i++) { const s = await ev('window.__lc152 && window.__lc152.state && window.__lc152.state.status'); if (s === 'ready' || s === 'error' || s === 'refused') break; await sleep(500); }
    result.finalQuery = await ev('location.search');
    result.overlayStatus = await ev('window.__lc152 && window.__lc152.state && window.__lc152.state.status');
    result.bannerVisible = await ev('!!document.getElementById("lc196-banner")');
    await sleep(8000);
    await ev('document.getElementById("lc196-umeda").click()');   // 画面の UI ボタンそのもの
    for (let i = 0; i < 60; i++) { await sleep(500); const s = JSON.parse(await ev('JSON.stringify(window.__lc152.state)')); if (s.tileLoad > 0 && s.tileVisible > 0) break; }
    await sleep(10000);
    result.camera = await ev('JSON.stringify(window.__lc152.camera())');
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); return r.data; };
    await ev('window.__lc152.setShow(true)'); await sleep(2000);
    const on = await shot('umeda-lod2-on.png');
    result.lod2Stats = await ev('JSON.stringify(window.__lc152.stats())');
    result.state = await ev('JSON.stringify(window.__lc152.state)').then((s) => { const o = JSON.parse(s); return { status: o.status, tileLoad: o.tileLoad, tileVisible: o.tileVisible, tileFailed: o.tileFailed, exclusion: o.exclusion, error: o.error }; });
    await ev('window.__lc152.setShow(false)'); await sleep(2000);
    const off = await shot('umeda-lod2-off.png');
    await ev('window.__lc152.setShow(true)');
    result.lod2OnOffPixelDiff = await ev('(async () => { const ld = (b) => new Promise((r) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const x = c.getContext("2d"); x.drawImage(i, 0, 0); r(x.getImageData(0, 0, i.width, i.height).data); }; i.src = "data:image/png;base64," + b; }); const A = await ld(' + JSON.stringify(on) + '), B = await ld(' + JSON.stringify(off) + '); let n = 0; for (let k = 0; k < A.length; k += 4) if (Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2]) > 24) n++; return n; })()');
    result.lod1Evidence = { lod1GlbHttp200: (result.httpByKind['lod1-glb'] || {}).n || 0, lod1Non200: (result.httpByKind['lod1-glb'] || {}).non200 || [], panelText: (await ev('(document.getElementById("lc152-wards")||document.body).innerText.slice(0,0)')) || '' };
    result.lod1Wards = await ev('(window.__lc152.state.wardSt)?JSON.stringify(window.__lc152.state.wardSt):null');
    result.mode = await ev('(function(){var m=document.getElementById("sel-bldg-mode");var o=m&&m.querySelector(\'option[value="all"]\');return JSON.stringify({value:m&&m.value,allExists:!!o,allDisabled:o&&o.disabled,auto3d:window.__lc152.state.auto3d})})()');
    result.app = await ev('JSON.stringify({errors:(window.__mission37g.errors||[]).slice(0,6),extraMeta:window.__mission37g.extraMeta,ext45:window.__mission37g.ext45,extraSets:window.__mission37g.extraSets})');
    result.panelText = await ev('document.body.innerText.split("\\n").filter(function(l){return /LOD1|区ごと|kita|北/.test(l)}).slice(0,12).join(" | ")');
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
    ws.close();
  } catch (e) { result.error = String(e && e.message || e); }
  finally { chrome.kill(); srv.close(); }
  console.log(JSON.stringify(result, null, 1));
  process.exit(result.pass200 && !result.error ? 0 : 1);
})();
