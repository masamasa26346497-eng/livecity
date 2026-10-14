// Mission 38F browser QA via Chrome DevTools Protocol (no deps; needs Node 22 global WebSocket).
// Usage: node tools/qa/mission38f-cdp-qa.mjs [chrome-path] > report.json
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const chrome = process.argv[2] || '/usr/bin/chromium';
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': p.endsWith('.json') ? 'application/json' : p.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const dbg = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${dbg}`, '--user-data-dir=/tmp/m38f-qa-' + dbg, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const requests = []; const sizes = {};
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === 'Network.requestWillBeSent') requests.push(d.params.request.url);
  if (d.method === 'Network.loadingFinished') sizes[d.params.requestId] = d.params.encodedDataLength;
  if (d.method === 'Network.responseReceived') sizes[d.params.requestId + ':url'] = d.params.response.url;
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
await send('Network.enable'); await send('Runtime.enable');
const base = `http://127.0.0.1:${port}/mission38f-facility-preview.html`;
const out = { checks: [], timings: {} };
const check = (name, ok, extra) => out.checks.push({ name, ok: !!ok, ...(extra !== undefined ? { extra } : {}) });
const waitFor = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return Date.now() - t0; await sleep(50); } throw new Error('timeout: ' + expr); };

const t0 = Date.now();
await send('Page.navigate', { url: base });
await waitFor(`document.querySelectorAll('#list li').length>0 && document.querySelectorAll('#ward option').length===25`);
out.timings.initialSampleMs = Date.now() - t0;
check('initial sample = 1120', await ev(`window.__m38f.state.records.length`) === 1120);
check('initial counts text labels sample', (await ev(`document.getElementById('counts').textContent`)).includes('初期サンプル'));
check('no ward file fetched at startup', !requests.some((u) => u.includes('/wards/')));

for (const [wardId, expected] of [['sumiyoshi', null], ['chuo', 5084]]) {
  const s = Date.now();
  await ev(`(()=>{const s=document.getElementById('ward');s.value='${wardId}';s.dispatchEvent(new Event('change'));})()`);
  await waitFor(`window.__m38f.state.loadedWardId==='${wardId}'`);
  out.timings[`${wardId}LoadMs`] = Date.now() - s;
  const n = await ev(`window.__m38f.state.records.length`);
  const man = await (await fetch(`http://127.0.0.1:${port}/map-data/osaka-city/facilities/ward-manifest.json`)).json();
  const want = expected ?? man.wards.find((w) => w.wardId === wardId).recordCount;
  check(`${wardId}: full ward loaded (${want})`, n === want, n);
  check(`${wardId}: counts text shows 全件`, (await ev(`document.getElementById('counts').textContent`)).includes('全件'));
  // search
  const name = await ev(`window.__m38f.state.records.find(r=>r.name).name`);
  await ev(`(()=>{const q=document.getElementById('q');q.value=${JSON.stringify(name)};q.dispatchEvent(new Event('input'));})()`);
  check(`${wardId}: search finds "${name}"`, await ev(`[...document.querySelectorAll('#list b')].some(b=>b.textContent===${JSON.stringify(name)})`));
  // detail
  await ev(`document.querySelector('#list li').click()`);
  const detail = await ev(`document.getElementById('detail').textContent`);
  check(`${wardId}: detail has OSM/ODbL`, detail.includes('ODbL') && detail.includes('OpenStreetMap'));
  check(`${wardId}: missing fields show 情報なし`, detail.includes('情報なし'));
  await ev(`(()=>{const q=document.getElementById('q');q.value='';q.dispatchEvent(new Event('input'));})()`);
}

// XSS: textContent only
await ev(`window.__m38f.state.records=[{name:'<img src=x onerror="window.__xss=1">',sourceId:'x',category:'dining',latitude:34.6,longitude:135.5}];document.getElementById('q').dispatchEvent(new Event('input'));document.querySelector('#list li').click();`);
check('markup in data is inert', (await ev(`window.__xss===undefined && document.querySelectorAll('#detail img,#list img').length===0`)));

// failure + recovery: block ward file, then unblock
await send('Network.setBlockedURLs', { urls: ['*/wards/nishi.json'] });
await ev(`(()=>{const s=document.getElementById('ward');s.value='nishi';s.dispatchEvent(new Event('change'));})()`);
await waitFor(`document.getElementById('status').className==='err'`);
check('failure shows error + retry button', await ev(`!document.getElementById('retry').hidden`));
await send('Network.setBlockedURLs', { urls: [] });
await ev(`document.getElementById('retry').click()`);
await waitFor(`window.__m38f.state.loadedWardId==='nishi'`);
check('recovers after retry (nishi 2,071)', await ev(`window.__m38f.state.records.length`) === 2071);

// resources
const urls = requests.filter((u) => u.startsWith('http'));
check('Google / external requests = 0', urls.every((u) => u.startsWith(`http://127.0.0.1:${port}/`)), urls.filter((u) => !u.startsWith(`http://127.0.0.1:${port}/`)));
out.timings.fileBytes = Object.fromEntries(['facilities-startup.json', 'ward-manifest.json', 'wards/sumiyoshi.json', 'wards/chuo.json', 'wards/nishi.json']
  .map((f) => [f, fs.statSync(path.join(root, 'map-data/osaka-city/facilities', f)).size]));
out.loaderStats = await ev(`JSON.stringify(window.__m38f.loader.getStats())`).then(JSON.parse);
out.externalRequests = urls.filter((u) => !u.startsWith(`http://127.0.0.1:${port}/`));
out.passed = out.checks.every((c) => c.ok);
out.chrome = (await send('Browser.getVersion')).result.product;
const reportPath = path.join(root, '..', 'docs', 'development', 'mission38f-qa-report.json');
fs.writeFileSync(reportPath, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ passed: out.passed, failed: out.checks.filter((c) => !c.ok), reportPath }, null, 2));
ws.close(); proc.kill(); server.close();
process.exit(out.passed ? 0 : 1);
