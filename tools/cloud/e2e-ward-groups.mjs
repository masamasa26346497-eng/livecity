// Mission 219B: ?wardgroups=1 の実ブラウザ(headless Chromium+SwiftShader)E2E。合成 fixture(24区・各区に空 GLB 1 枚)で配線・要求数・切替を検証する。
//   ※ 実データ/実GPU ではない。ネットワーク要求の「どの区が・いつ」要求されたか、破棄・世代トークンの挙動の確認専用。FPS は SwiftShader 値で実GPUとは別物。
//   使い方: node tools/cloud/e2e-ward-groups.mjs [--chrome /usr/bin/chromium] [--out report.json]
//   Cesium 1.121.1 は jsDelivr CDN から読む(HTML 既存仕様)。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const CHROME = opt('chrome', '/usr/bin/chromium'), OUT = opt('out', null);
const PUB = path.join(ROOT, 'public');
const wardsData = JSON.parse(fs.readFileSync(path.join(PUB, 'mission37g-data/osaka-24-wards.json'), 'utf8'));
const groupsDef = JSON.parse(fs.readFileSync(path.join(PUB, 'mission37g-data/ward-groups.json'), 'utf8'));
// ---- fixture: 24 区 × (source.json / build-report.json / tileset.json / tiles/0.glb) ----
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-e2e-'));
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320, COS = Math.cos(CLAT * Math.PI / 180);
const lon = (x) => CLON + x / (COS * MPD), lat = (z) => CLAT - z / MPD, rad = (d) => d * Math.PI / 180;
function tinyGlb() { const j = Buffer.from(JSON.stringify({ asset: { version: '2.0' } })); const jj = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]); const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(20 + jj.length, 8); const c = Buffer.alloc(8); c.writeUInt32LE(jj.length, 0); c.write('JSON', 4); return Buffer.concat([h, c, jj]); }
for (const w of wardsData.wards) {
  const d = path.join(ext, w.wardId); fs.mkdirSync(path.join(d, 'tiles'), { recursive: true });
  fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify({ wardCode: w.wardCode, wardId: w.wardId, vintage: 2025 }));
  fs.writeFileSync(path.join(d, 'build-report.json'), JSON.stringify({ totals: { buildings: 2 }, selectedTiles: 1, tiles: 1 }));
  fs.writeFileSync(path.join(d, 'tiles/0.glb'), tinyGlb());
  const b = w.bbox, reg = [rad(lon(b.minX)), rad(lat(b.maxZ)), rad(lon(b.maxX)), rad(lat(b.minZ)), 0, 60];
  fs.writeFileSync(path.join(d, 'tileset.json'), JSON.stringify({ asset: { version: '1.1' }, geometricError: 500, root: { boundingVolume: { region: reg }, geometricError: 50, refine: 'ADD', content: { uri: 'tiles/0.glb' } } }));
}
fs.writeFileSync(path.join(ext, 'index.json'), JSON.stringify({ wards: wardsData.wards.map((w) => ({ ward: w.wardId })), verified: true, lod0Wards: [], layersWards: [] }));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary' };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]); let f;
  if (u.startsWith('/ext-3dtiles/')) f = path.join(ext, u.slice(13)); else f = path.join(PUB, u === '/' ? 'mission37g-osaka-24ward-mvp.html' : u);
  if (!f.startsWith(ext) && !f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d); });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
const port2 = 9333 + Math.floor(Math.random() * 500), prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1000,700', '--remote-debugging-port=' + port2, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
const result = { fixture: 'synthetic(24区・空GLB)', headless: 'SwiftShader(実GPUではない)', checks: {}, console: [], steps: [] };
let ws; const cleanup = () => { try { ws && ws.close(); } catch {} try { ch.kill('SIGKILL'); } catch {} srv.close(); };
try {
  let targets; for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port2}/json`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  if (!targets) throw new Error('chrome のデバッグポートに接続できません');
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); }
    else if (j.method === 'Runtime.consoleAPICalled' && j.params.type === 'error') result.console.push('error: ' + j.params.args.map((x) => x.value ?? x.description).join(' ').slice(0, 300));
    else if (j.method === 'Runtime.exceptionThrown') result.console.push('exception: ' + (j.params.exceptionDetails.exception?.description || j.params.exceptionDetails.text).slice(0, 300)); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error'); return r.result.result.value; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await send('Runtime.enable'); await send('Page.enable');
  const snap = () => ev('JSON.stringify(window.__lcWG && window.__lcWG.snapshot())').then((s) => (s ? JSON.parse(s) : null));
  const waitFor = async (fn, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(400); } return null; };
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/mission37g-osaka-24ward-mvp.html?wardgroups=1&wgdebug=1&nobuiltin=1&ext45=1&lod2auto3d=0` });
  const ready = await waitFor(() => ev('!!window.__lcWG'), 90000);
  result.checks.pageReady = !!ready;
  if (!ready) throw new Error('__lcWG が現れません(起動失敗)');
  await sleep(5500);   // 起動直後の自動アサート(4s)を待つ
  const s0 = await snap(); result.steps.push({ step: 'initial', snap: s0 });
  result.checks.initialDetailRequests0 = !!s0.initialAssert && s0.initialAssert.pass === true && s0.net.detailGlb === 0 && s0.net.detailTileset === 0;
  result.checks.initialNoWardMounted = s0.loadedWards.length === 0 && s0.loadedTilesets === 0;
  result.checks.groupUiPresent = await ev(`document.querySelectorAll('#wg-row button').length === ${groupsDef.groups.length}`);
  const wardsOf = (gid) => groupsDef.groups.find((g) => g.id === gid).wards;
  const idOf = Object.fromEntries(wardsData.wards.map((w) => [w.wardCode, w.wardId]));
  // 1) グループ選択 → その所属区だけ詳細要求
  await ev(`window.__lcWG.select('south')`);
  const s1 = await waitFor(async () => { const s = await snap(); return s.state === 'done' || s.state === 'failed' ? s : null; }, 90000) || await snap();
  result.steps.push({ step: 'select south', snap: s1 });
  const allowed1 = new Set(wardsOf('south').map((c) => idOf[c]));
  result.checks.selectOnlyGroupWardsRequested = s1.net.wardsWithDetail.length > 0 && s1.net.wardsWithDetail.every((w) => allowed1.has(w));
  result.checks.selectLoadedWardsInGroup = s1.loadedWards.every((c) => wardsOf('south').includes(c));
  // 2) 急速な連続切替 → 最終グループ以外が残らない
  for (const g of ['north', 'core', 'bay', 'east', 'southeast']) { await ev(`window.__lcWG.select(${JSON.stringify(g)})`); await sleep(120); }
  const s2 = await waitFor(async () => { const s = await snap(); return s.groupId === 'southeast' && (s.state === 'done' || s.state === 'failed') ? s : null; }, 90000) || await snap();
  result.steps.push({ step: 'rapid switch → southeast', snap: s2 });
  result.checks.rapidSwitchOnlyFinalGroup = s2.groupId === 'southeast' && s2.loadedWards.every((c) => wardsOf('southeast').includes(c)) && s2.allowedWards.every((c) => wardsOf('southeast').includes(c));
  result.checks.oldGroupDropped = !s2.loadedWards.some((c) => wardsOf('south').includes(c)) && s2.dropsTotal >= 1 || s1.loadedWards.length === 0;
  // 3) 解除 → 詳細 0 区に戻る
  await ev(`window.__lcWG.clear()`); await sleep(2500);
  const s3 = await snap(); result.steps.push({ step: 'clear', snap: s3 });
  result.checks.clearReleasesAll = s3.loadedWards.length === 0 && s3.loadedTilesets === 0;
  result.checks.noPageErrors = result.console.filter((c) => !/Failed to load resource|favicon|net::ERR|GLB|glTF|towns24|未接続/i.test(c)).length === 0;
  result.consoleErrors = result.console.slice(0, 20);
  result.ok = Object.values(result.checks).every(Boolean);
} catch (e) { result.ok = false; result.error = String(e.message || e); }
finally { cleanup(); }
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, checks: result.checks, error: result.error, consoleErrors: result.consoleErrors }, null, 1));
process.exit(result.ok ? 0 : 1);
