'use strict';
// Mission 182B: launcher --all 相当URL(自動全域3D ON, clip OFF)の初回表示の時系列を実Chromeで測る。手動のモード切替はしない。
// 実データ: temp/mission79/<ward>-2025 (tools/mission79-run.mjs) / temp/lod2-all (lod2-build-all.mjs)。SwiftShader。
const fs = require('fs'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(__dirname, '..', '..');
const WARDS = opt('wards', 'chuo,higashiyodogawa').split(',');
const QUERY = opt('query', '?nobuiltin=1&ext45=1&lod2=1&lod2ov=1&lod2auto3d=1');
const DUR = Number(opt('duration', 60)) * 1000, STEP = Number(opt('step', 2)) * 1000;
const port = Number(opt('port', 8182)), cport = Number(opt('cdp', 9382));
const out = path.resolve(opt('out', path.join(ROOT, 'temp/lod2-e2e-auto3d')));
const lod2Dir = path.resolve(opt('lod2-dir', path.join(ROOT, 'temp/lod2-all')));
const chromeBin = opt('chrome', ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[auto3d]', new Date().toISOString().slice(11, 19), ...a);
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
const ALLOW = [/^tileset\.json$/, /^source\.json$/, /^build-report\.json$/, /^tiles$/, /^lod$/, /^ids$/, /^attrs$/];
(async () => {
  const regs = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const local = path.join(out, 'localappdata'), root = path.join(local, 'LiveCity-3DTiles-Out-24');
  fs.mkdirSync(path.join(root, 'pc23'), { recursive: true });
  fs.writeFileSync(path.join(root, '.livecity-45d-root.json'), JSON.stringify({ schema: 'livecity.mission45d.convert-all/1' }));
  const info = {};
  for (const id of WARDS) {
    const src = path.join(ROOT, 'temp/mission79', id + '-2025');
    const dst = id === 'sumiyoshi' ? path.join(root, 'sumiyoshi-a1') : path.join(root, 'pc23', id + '-a1'); fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) if (ALLOW.some((re) => re.test(n))) fs.cpSync(path.join(src, n), path.join(dst, n), { recursive: true });
    const rep = JSON.parse(fs.readFileSync(path.join(dst, 'build-report.json'), 'utf8'));
    info[id] = { code: regs.find((x) => x.id === id).code, buildings: rep.totals.buildings, tiles: fs.readdirSync(path.join(dst, 'tiles')).length };
  }
  const srv = spawn(process.execPath, [path.join(__dirname, 'lod2-preview-serve.cjs'), '--port', String(port), '--lod2-dir', lod2Dir, '--no-auto-layers'], { stdio: 'inherit', env: { ...process.env, LOCALAPPDATA: local } });
  const chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,800', '--remote-debugging-port=' + cport, '--user-data-dir=' + path.join(out, 'profile'), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const result = { data: 'REAL PLATEAU 2025 LOD1 (mission79-run) + real LOD2', swiftshader: true, query: QUERY, wardsInfo: info, http: { ok: 0, bad: [], glb: 0 }, timeline: [], console: [] };
  try {
    let targets; for (let i = 0; i < 150; i++) { try { targets = await getJson('http://127.0.0.1:' + cport + '/json'); break; } catch (e) { await sleep(200); } }
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pend = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d.error); pend.delete(d.id); return; }
      if (d.method === 'Network.responseReceived') { const u = d.params.response.url; if (/ext-3dtiles|lod2-preview/.test(u)) { if (d.params.response.status === 200) { result.http.ok++; if (/\.glb/.test(u)) result.http.glb++; } else result.http.bad.push({ url: u.replace(/^.*localhost:\d+/, ''), status: d.params.response.status }); } }
      if (d.method === 'Runtime.exceptionThrown') result.console.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).slice(0, 200));
    };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr, to = 30000) => { const r = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), sleep(to).then(() => ({ __timeout: true }))]); return r.__timeout ? { __timeout: true } : (r.result ? r.result.value : r); };
    await send('Network.enable'); await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const t0 = Date.now();
    await send('Page.navigate', { url: 'http://localhost:' + port + '/mission37g-osaka-24ward-mvp.html' + QUERY });
    let shot35 = false;
    const probe = 'JSON.stringify((()=>{const g=window.__mission37g||{},a=g.allMode||{},l=window.__lc152;const cam=l&&l.camera&&l.camera();const tx=(i)=>(document.getElementById(i)||{}).textContent;return {sel:(document.getElementById("sel-bldg-mode")||{}).value,on:a.on,ticks:a.ticks,mounted:Object.keys(a.mounted||{}),lastErr:a.lastError,plan:a.lastPlan&&JSON.stringify(a.lastPlan).slice(0,300),culled:a.culledTotal,metas:(g.extraMeta||[]).length,cam:cam,lc152:l&&l.state.status,auto3d:l&&l.state.auto3d,tiles:tx("hs-tiles"),fps:tx("hs-fps")}})())';
    while (Date.now() - t0 < DUR) {
      const t = Date.now() - t0; const v = await ev(probe, 20000);
      const row = { t: +(t / 1000).toFixed(1), http: result.http.ok };
      if (v && v.__timeout) row.hang = true; else { try { Object.assign(row, JSON.parse(v)); } catch (e) { row.raw = String(v).slice(0, 80); } }
      result.timeline.push(row); log(JSON.stringify(row).slice(0, 330));
      if (!shot35 && t >= 35000) { shot35 = true; const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.data) fs.writeFileSync(path.join(out, 't35.png'), Buffer.from(s.data, 'base64')); }
      await sleep(STEP);
    }
    result.diagnose = await ev('window.__lc152 && window.__lc152.diagnose().then(d => JSON.stringify({hints: d.hints, allMode: d.allMode, tilesets: d.tilesets, wards: d.wards}))', 60000).then((s) => { try { return JSON.parse(s); } catch (e) { return String(s); } });
    result.server = await getJson('http://127.0.0.1:' + port + '/__lod2/diag.json').then((d) => ({ requests: d.requests, extServed: d.extServed })).catch((e) => String(e));
    const first = result.timeline.find((r) => r.mounted && r.mounted.length); result.firstMountAtSec = first ? first.t : null;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 1));
    console.log(JSON.stringify({ ...result, timeline: result.timeline.length + ' rows' }, null, 1)); ws.close();
  } finally { chrome.kill(); srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
