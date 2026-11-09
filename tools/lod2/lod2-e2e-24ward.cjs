#!/usr/bin/env node
'use strict';
// Mission 172: 37G の実ページ(mission37g-osaka-24ward-mvp.html)で「住吉以外の区が実際に描画されるか」を headless Chrome で測る E2E。
//   node tools/lod2/lod2-e2e-24ward.cjs [--wards sumiyoshi,higashiyodogawa,asahi,chuo] [--lod2] [--chrome <path>] [--out temp/lod2-e2e24]
// fixture: 45D 出力ルートの形(43F/45D)に合わせた「描画できる GLB」入りの合成データ(実データではない)。各区の中心に 6x6 の箱を置く。
//   実 Windows データではない。ここで測れるのは「37G が 45D 形式を区ごとに mount して描くか」「LOD2 の ClippingPolygon が他区を消さないか」。
// 判定: 区ごとに「全域3D の建物あり」と「建物なし(単一区モードへ戻す)」の同一視点スクリーンショットの画素差 > 0。
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(__dirname, '..', '..');
const WARDS = (opt('wards', 'sumiyoshi,higashiyodogawa,asahi,chuo')).split(',');
const WITH_LOD2 = argv.includes('--lod2');
const AUTO = argv.includes('--auto');   // Mission 173: lod2auto3d=0 を付けず、launcher 既定 URL の自動 全域3D を再現
const NFP = Number(opt('nfp', 1));   // LOD2 足跡の数(実運用 --all は 10,698)。住吉の中心の 1 つ + 大阪全域へ疑似乱数で散布
const port = Number(opt('port', 8172)), cport = Number(opt('cdp', 9372));
const out = path.resolve(opt('out', path.join(ROOT, 'temp/lod2-e2e24')));
const chromeBin = opt('chrome', ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
const PROJ = { clat: 34.604208, clon: 135.525020, mpd: 111320 }, COS = Math.cos(PROJ.clat * Math.PI / 180);

function box(cx, cy, w, hgt, col) {   // ENU (x東 y北 z上) の箱 12 三角形
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - w / 2, y1 = cy + w / 2;
  const v = [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0], [x0, y0, hgt], [x1, y0, hgt], [x1, y1, hgt], [x0, y1, hgt]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const pos = [], colr = []; for (const t of f) for (const i of t) { pos.push(v[i]); colr.push(col); }
  return { pos, colr };
}

async function main() {
  const G = await import(path.join(ROOT, 'tools/lod2/lod2-to-glb.js'));
  const regs = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
  const wd = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const local = path.join(out, 'localappdata'), root = path.join(local, 'LiveCity-3DTiles-Out-24');
  fs.mkdirSync(path.join(root, 'pc23'), { recursive: true });
  fs.writeFileSync(path.join(root, '.livecity-45d-root.json'), JSON.stringify({ schema: 'livecity.mission45d.convert-all/1' }));
  const centers = {};
  for (const id of WARDS) {
    const w = regs.find((x) => x.id === id), d = wd.find((x) => x.wardId === id);
    const cx = (d.bbox.minX + d.bbox.maxX) / 2, cz = (d.bbox.minZ + d.bbox.maxZ) / 2;
    const lon = PROJ.clon + cx / (COS * PROJ.mpd), lat = PROJ.clat - cz / PROJ.mpd; centers[id] = [lon, lat];
    const org = { lat, lon, h: 0 }, pos = [], col = [];
    for (let i = -3; i < 3; i++) for (let j = -3; j < 3; j++) { const b = box(i * 300 + 150, j * 300 + 150, 150, 90, [0.7, 0.75, 0.85]); pos.push(...b.pos); col.push(...b.colr); }
    const mesh = { positions: pos, colors: col, extentEnu: { x: [-900, 900], y: [-900, 900], z: [0, 90] } };
    const dir = id === 'sumiyoshi' ? path.join(root, 'sumiyoshi-a1', 'sumiyoshi') : path.join(root, 'pc23', id + '-a1');
    fs.mkdirSync(path.join(dir, 'tiles'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tiles', 't_0_0.glb'), G.meshToGlb(mesh));
    fs.writeFileSync(path.join(dir, 'tileset.json'), JSON.stringify(G.buildTileset(mesh, org, 'tiles/t_0_0.glb')));
    fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ mission: '40B', wardId: id, wardCode: w.code }));
    fs.writeFileSync(path.join(dir, 'build-report.json'), JSON.stringify({ selectedTiles: 1, totals: { buildings: 36, skipped: 0 } }));
    if (id === 'sumiyoshi') fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ sumiyoshi: { state: 'ok', attempt: 1, buildings: 36 } }));
  }
  // LOD2 fixture(任意): 住吉の中心に 1 棟、足跡つき。住吉以外の区の LOD1 を ClippingPolygon が消さないかの確認用。
  const lod2 = path.join(out, 'lod2');
  fs.mkdirSync(lod2, { recursive: true });
  if (WITH_LOD2) {
    const [lon, lat] = centers[WARDS[0]]; const org = { lat, lon, h: 0 };
    const b = box(0, 0, 60, 40, [0.8, 0.3, 0.2]);
    const mesh = { positions: b.pos, colors: b.colr, extentEnu: { x: [-30, 30], y: [-30, 30], z: [0, 40] } };
    fs.writeFileSync(path.join(lod2, 'lod2.glb'), G.meshToGlb(mesh));
    fs.writeFileSync(path.join(lod2, 'tileset.json'), JSON.stringify(G.buildTileset(mesh, org, 'lod2.glb')));
    const dl = 30 / (COS * PROJ.mpd), dt = 30 / PROJ.mpd;
    const fps = [{ id: 'fx1', hull: [[lon - dl, lat - dt], [lon + dl, lat - dt], [lon + dl, lat + dt], [lon - dl, lat + dt]] }];
    let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 1; i < NFP; i++) { const x = 135.30 + rnd() * 0.32, y = 34.55 + rnd() * 0.27; fps.push({ id: 'fx' + (i + 1), hull: [[x - dl, y - dt], [x + dl, y - dt], [x + dl, y + dt], [x - dl, y + dt]] }); }
    fs.writeFileSync(path.join(lod2, 'footprints.json'), JSON.stringify({ footprints: fps }));
    fs.writeFileSync(path.join(lod2, 'report.json'), JSON.stringify({ converted: 1, lod1Remaining: 0, glbBytes: 1, meshes: ['fx'], source: { name: 'fixture' }, bbox: { west: lon - 0.001, south: lat - 0.001, east: lon + 0.001, north: lat + 0.001 } }));
  }
  const srv = spawn(process.execPath, [path.join(__dirname, 'lod2-preview-serve.cjs'), '--port', String(port), '--lod2-dir', lod2, '--no-auto-layers'], { stdio: 'inherit', env: { ...process.env, LOCALAPPDATA: local } });
  const chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--window-size=1280,800', '--remote-debugging-port=' + cport, '--user-data-dir=' + path.join(out, 'profile'), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = ''; chrome.stderr.on('data', (d) => { chromeErr += d; });
  const result = { fixture: 'synthetic (not real data)', withLod2: WITH_LOD2, chrome: chromeBin, http: [], console: [], wards: {} };
  try {
    let targets; for (let i = 0; i < 150; i++) { try { targets = await getJson('http://127.0.0.1:' + cport + '/json'); break; } catch (e) { await sleep(200); } }
    if (!targets) throw new Error('Chrome のデバッグポートに接続できません(chrome=' + chromeBin + ') stderr=' + chromeErr.split('\n').filter((l) => !/dbus/.test(l)).slice(-8).join(' | '));
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pend = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d.error); pend.delete(d.id); return; }
      if (d.method === 'Network.responseReceived') { const u = d.params.response.url; if (/ext-3dtiles|lod2-preview/.test(u)) result.http.push({ url: u.replace(/^.*localhost:\d+/, ''), status: d.params.response.status }); }
      if (d.method === 'Runtime.exceptionThrown') result.console.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).slice(0, 200));
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') result.console.push('ERR ' + d.params.args.map((a) => a.value || a.description).join(' ').slice(0, 200));
    };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result ? r.result.value : r; };
    await send('Network.enable'); await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://localhost:' + port + '/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1' + (WITH_LOD2 ? (AUTO ? '&lod2=1&lod2ov=1' : '&lod2=1&lod2auto3d=0') : '') });   // AUTO: launcher --all の既定 URL そのまま(自動 全域3D)
    for (let i = 0; i < 120; i++) { const n = await ev('(window.__mission37g && window.__mission37g.extraMeta && window.__mission37g.extraMeta.length) || 0'); if (n >= WARDS.length) break; await sleep(500); if (i === 119) result.note = 'extraMeta が揃いません'; }
    if (WITH_LOD2) for (let i = 0; i < 60; i++) { const s = await ev('window.__lc152 && window.__lc152.state.status'); if (s === 'ready' || s === 'error' || s === 'refused') break; await sleep(500); }
    result.extraMeta = await ev('JSON.stringify(window.__mission37g.extraMeta)');
    result.lod2State = WITH_LOD2 ? await ev('JSON.stringify(window.__lc152 && window.__lc152.state)') : null;
    if (AUTO) {
      // 手動切替をしない: オーバーレイの自動 全域3D が実際に働くかを、時系列で記録する。
      result.autoTrace = [];
      for (let i = 0; i < 40; i++) {
        const t = JSON.parse(await ev('JSON.stringify({sel: document.getElementById("sel-bldg-mode").value, on: window.__mission37g.allMode.on, ticks: window.__mission37g.allMode.ticks, mounted: Object.keys(window.__mission37g.allMode.mounted||{}), plan: window.__mission37g.allMode.lastPlan, err: window.__mission37g.allMode.lastError, auto3d: window.__lc152.state.auto3d, cam: window.__lc152.camera && window.__lc152.camera()})'));
        if (i % 4 === 0) result.autoTrace.push(t);
        if (t.on && t.mounted.length) break; await sleep(750);
      }
      result.autoOk = (result.autoTrace[result.autoTrace.length - 1] || {}).on === true;
      result.diagnose = JSON.parse(await ev('window.__lc152.diagnose ? window.__lc152.diagnose().then(JSON.stringify) : "null"'));
    } else await ev('(()=>{const m=document.getElementById("sel-bldg-mode");m.value="all";m.dispatchEvent(new Event("change"));})()');
    await sleep(3000);
    const pixels = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' }); const b = Buffer.from(r.data, 'base64'); fs.writeFileSync(path.join(out, name), b); return b;
    };
    const diff = (a, b) => ev('(async () => { const ld = (s) => new Promise((r) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const x = c.getContext("2d"); x.drawImage(i, 0, 0); r(x.getImageData(0, 0, i.width, i.height).data); }; i.src = "data:image/png;base64," + s; }); const A = await ld(' + JSON.stringify(a.toString('base64')) + '), B = await ld(' + JSON.stringify(b.toString('base64')) + '); let n = 0; for (let k = 0; k < A.length; k += 4) if (Math.abs(A[k] - B[k]) + Math.abs(A[k+1] - B[k+1]) + Math.abs(A[k+2] - B[k+2]) > 24) n++; return n; })()');
    for (const wid of WARDS) {
      const [lon, lat] = centers[wid];
      // 視点を区の中心へ(lookAtFirst は LOD2 用 API。LOD2 無しでは使えないので、37G 自身の局所座標 API が無い場合は Cesium の global で直接)
      await ev('(()=>{ const cs=Cesium; const vs = cs.Viewer; return 1; })()');
      await ev('window.__lc152 && window.__lc152.lookAtFirst(1800, -50, [' + lon + ',' + lat + '])');
      if (!WITH_LOD2) result.wards[wid] = { skipped: 'LOD2 なしでは視点操作 API が無い(--lod2 を付ける)' };
      let on = null;
      for (let i = 0; i < 16; i++) { await sleep(1000); const m = JSON.parse(await ev('JSON.stringify(window.__mission37g.allMode)')); if (m.mounted && m.mounted[regs.find((x) => x.id === wid).code]) { await sleep(2500); break; } }
      on = await pixels('on-' + wid + '.png');
      const st = JSON.parse(await ev('JSON.stringify({allMode: window.__mission37g.allMode, extraSets: window.__mission37g.extraSets, loaded: window.__mission37g.loadedTilesTotal})'));
      await ev('(()=>{const m=document.getElementById("sel-bldg-mode");m.value="single";m.dispatchEvent(new Event("change"));})()'); await sleep(2500);
      const off = await pixels('off-' + wid + '.png');
      await ev('(()=>{const m=document.getElementById("sel-bldg-mode");m.value="all";m.dispatchEvent(new Event("change"));})()'); await sleep(1500);
      result.wards[wid] = { mounted: st.allMode.mounted, plan: st.allMode.lastPlan, lastError: st.allMode.lastError, extraSets: st.extraSets, pixelDiff: await diff(on, off) };
      result.wards[wid].drawn = result.wards[wid].pixelDiff > 200;
    }
    result.clipState = WITH_LOD2 ? JSON.parse(await ev("JSON.stringify({clipped: window.__lc152.state.clippedTilesets, status: window.__lc152.state.status, error: window.__lc152.state.error})")) : null;
    result.pass = WARDS.every((w) => result.wards[w] && result.wards[w].drawn);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 1));
    console.log(JSON.stringify(result, null, 1));
    ws.close();
  } finally { chrome.kill(); srv.kill(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
