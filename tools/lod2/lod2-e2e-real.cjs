#!/usr/bin/env node
'use strict';
// Mission 179: 実 PLATEAU 2025 データ(合成 fixture ではない)を 37G の実ページ + ext45 接続形式で配信し、headless Chrome で測る E2E。
//   1) node tools/mission79-run.mjs --ward chuo ; --ward higashiyodogawa   (公式 CityGML 2025 -> 区 3D Tiles。temp/mission79/<ward>-2025)
//   2) node tools/lod2/lod2-build-all.mjs                                  (実 LOD2 10,698 棟 -> temp/lod2-all)
//   3) node tools/lod2/lod2-e2e-real.cjs --wards chuo,higashiyodogawa [--chrome /usr/bin/google-chrome]
// 出力は temp/ のみ(gitignore)。小さな結果 JSON だけを --report で data/reports/ に書ける。
// 区ごと: HTTP / tileLoad・tileVisible 相当(Cesium3DTileset の選択タイル・三角形) / ON-OFF 画素差 / buildings meta。
// LOD2: 実 LOD2 建物の上空で LOD2 ON/OFF・LOD1 のみ・LOD2 のみ を同一カメラで撮り、三角形数と画素差を記録する。
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), http = require('http');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(__dirname, '..', '..');
const WARDS = opt('wards', 'chuo,higashiyodogawa').split(',');
const QUERY = opt('query', '?lod2=1&lod2ov=1&lod2clip=near');
const port = Number(opt('port', 8179)), cport = Number(opt('cdp', 9379));
const out = path.resolve(opt('out', path.join(ROOT, 'temp/lod2-e2e-real')));
const lod2Dir = path.resolve(opt('lod2-dir', path.join(ROOT, 'temp/lod2-all')));
const chromeBin = opt('chrome', ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p)));
const log = (...a) => console.error('[e2e-real]', new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
const ALLOW = [/^tileset\.json$/, /^source\.json$/, /^build-report\.json$/, /^tiles$/, /^lod$/, /^ids$/, /^attrs$/];

async function main() {
  const regs = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const local = path.join(out, 'localappdata'), root = path.join(local, 'LiveCity-3DTiles-Out-24');
  fs.mkdirSync(path.join(root, 'pc23'), { recursive: true });
  fs.writeFileSync(path.join(root, '.livecity-45d-root.json'), JSON.stringify({ schema: 'livecity.mission45d.convert-all/1' }));
  const info = {};
  for (const id of WARDS) {
    const w = regs.find((x) => x.id === id), src = path.join(ROOT, 'temp/mission79', id + (opt('variant', '') ? '-2025-' + opt('variant') : '-2025'));
    if (!fs.existsSync(path.join(src, 'tileset.json'))) throw new Error('実データ未生成: ' + src + ' (tools/mission79-run.mjs --ward ' + id + ')');
    const dst = path.join(root, 'pc23', id + '-a1'); fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) if (ALLOW.some((re) => re.test(n))) fs.cpSync(path.join(src, n), path.join(dst, n), { recursive: true });
    const rep = JSON.parse(fs.readFileSync(path.join(dst, 'build-report.json'), 'utf8'));
    const tsj = JSON.parse(fs.readFileSync(path.join(dst, 'tileset.json'), 'utf8'));
    const glbs = fs.existsSync(path.join(dst, 'tiles')) ? fs.readdirSync(path.join(dst, 'tiles')).length : 0;
    info[id] = { code: w.code, buildingsMeta: rep.totals && rep.totals.buildings, selectedTiles: rep.selectedTiles, glbFiles: glbs, rootRegion: tsj.root && tsj.root.boundingVolume && tsj.root.boundingVolume.region };
    // source.json の wardCode が無い/違う場合は 37G が登録しない。実データの値を尊重し、無ければ明示して失敗させる(捏造しない)。
    const sj = path.join(dst, 'source.json'); info[id].sourceWardCode = fs.existsSync(sj) ? JSON.parse(fs.readFileSync(sj, 'utf8')).wardCode : null;
  }
  const srv = spawn(process.execPath, [path.join(__dirname, 'lod2-preview-serve.cjs'), '--port', String(port), '--lod2-dir', lod2Dir, '--no-auto-layers'], { stdio: 'inherit', env: { ...process.env, LOCALAPPDATA: local } });
  const chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--window-size=1280,800', '--remote-debugging-port=' + cport, '--user-data-dir=' + path.join(out, 'profile'), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const result = { fixture: 'REAL PLATEAU 2025 (official CityGML via tools/mission79-run.mjs)', swiftshader: true, chrome: chromeBin, wardsInfo: info, http: { ok: 0, bad: [] }, console: [], wards: {}, lod2: {} };
  try {
    let targets; for (let i = 0; i < 150; i++) { try { targets = await getJson('http://127.0.0.1:' + cport + '/json'); break; } catch (e) { await sleep(200); } }
    if (!targets) throw new Error('Chrome のデバッグポートに接続できません');
    log('chrome debug port ok, navigating');
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pend = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d.error); pend.delete(d.id); return; }
      if (d.method === 'Network.responseReceived') { const u = d.params.response.url; if (/ext-3dtiles|lod2-preview/.test(u)) { if (d.params.response.status === 200) result.http.ok++; else result.http.bad.push({ url: u.replace(/^.*localhost:\d+/, ''), status: d.params.response.status }); } }
      if (d.method === 'Runtime.exceptionThrown') result.console.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).slice(0, 200));
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') result.console.push('ERR ' + d.params.args.map((a) => a.value || a.description).join(' ').slice(0, 200));
    };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const EV_TIMEOUT = Number(opt('ev-timeout', 60000));
    const ev = async (expr) => {
      const r = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), sleep(EV_TIMEOUT).then(() => ({ __timeout: true }))]);
      if (r.__timeout) { result.hang = 'ページが ' + EV_TIMEOUT + 'ms 応答しません(メインスレッド停止の疑い): ' + expr.slice(0, 80); throw new Error(result.hang); }
      return r.result ? r.result.value : r;
    };
    await send('Network.enable'); await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://localhost:' + port + '/mission37g-osaka-24ward-mvp.html' + QUERY });
    for (let i = 0; i < 120; i++) { const n = await ev('(window.__mission37g && window.__mission37g.extraMeta && window.__mission37g.extraMeta.length) || 0'); if (n >= WARDS.length) break; await sleep(500); if (i === 119) result.note = 'extraMeta が揃いません'; }
    for (let i = 0; i < 90; i++) { const s = await ev('window.__lc152 && window.__lc152.state.status'); if (s === 'ready' || s === 'error' || s === 'refused') break; await sleep(500); }
    result.lod2Status = await ev('JSON.stringify(window.__lc152 && {status: window.__lc152.state.status, error: window.__lc152.state.error, clipMode: window.__lc152.state.clipMode})');
    result.extraMeta = JSON.parse(await ev('JSON.stringify(window.__mission37g.extraMeta)') || 'null');
    const pixels = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const b = Buffer.from(r.data, 'base64'); fs.writeFileSync(path.join(out, name), b); return b; };
    const diff = (a, b) => ev('(async () => { const ld = (s) => new Promise((r) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const x = c.getContext("2d"); x.drawImage(i, 0, 0); r(x.getImageData(0, 0, i.width, i.height).data); }; i.src = "data:image/png;base64," + s; }); const A = await ld(' + JSON.stringify(a.toString('base64')) + '), B = await ld(' + JSON.stringify(b.toString('base64')) + '); let n = 0; for (let k = 0; k < A.length; k += 4) if (Math.abs(A[k] - B[k]) + Math.abs(A[k+1] - B[k+1]) + Math.abs(A[k+2] - B[k+2]) > 24) n++; return n; })()');
    const setMode = (v) => ev('(()=>{const m=document.getElementById("sel-bldg-mode");m.value="' + v + '";m.dispatchEvent(new Event("change"));})()');
    const tsStats = async () => JSON.parse(await ev('window.__lc152.diagnose().then(d => JSON.stringify(d.tilesets))'));
    log('page ready', result.lod2Status); await setMode('all'); await sleep(2000);
    for (const wid of WARDS) {
      const r = regs.find((x) => x.id === wid), rg = info[wid].rootRegion;
      const lon = rg ? ((rg[0] + rg[2]) / 2) * 180 / Math.PI : 135.5, lat = rg ? ((rg[1] + rg[3]) / 2) * 180 / Math.PI : 34.69;
      await ev('window.__lc152.lookAtFirst(1800, -50, [' + lon + ',' + lat + '])');
      for (let i = 0; i < 30; i++) { await sleep(1000); const m = JSON.parse(await ev('JSON.stringify(window.__mission37g.allMode)')); if (m.mounted && m.mounted[r.code]) { await sleep(5000); break; } }
      log(wid, 'capturing on'); const on = await pixels('on-' + wid + '.png');
      const st = JSON.parse(await ev('JSON.stringify({allMode: window.__mission37g.allMode})'));
      log(wid, 'tsStats'); const ts = await tsStats();
      await setMode('single'); await sleep(3000);
      const off = await pixels('off-' + wid + '.png');
      await setMode('all'); await sleep(1500);
      const mine = ts.filter((t) => t.ward === wid || t.ward === r.code);
      result.wards[wid] = { center: [+lon.toFixed(4), +lat.toFixed(4)], mounted: !!(st.allMode.mounted && st.allMode.mounted[r.code]), lastError: st.allMode.lastError, tilesets: ts, wardTilesets: mine, pixelDiff: await diff(on, off) };
      result.wards[wid].drawn = result.wards[wid].pixelDiff > 200;
    }
    log('wards done'); fs.writeFileSync(path.join(out, 'result-partial.json'), JSON.stringify(result, null, 1));
    // ---- LOD2 の実測(実 LOD2 建物のある中央区の LOD2 地点) ----
    const spots = await ev('JSON.stringify(window.__lc152.state.spots || null)');
    const fp = await getJson('http://127.0.0.1:' + port + '/lod2-preview/footprints.json').catch(() => null);
    const near = fp && fp.footprints ? fp.footprints.filter((f) => f.hull && f.hull[0] && f.hull[0][0] > 135.49 && f.hull[0][0] < 135.52 && f.hull[0][1] > 34.67 && f.hull[0][1] < 34.70) : [];
    result.lod2.footprintsNearChuo = near.length;
    if (near.length) {
      // 足跡が密な点(最初の 1 棟の重心)
      const hs = near[Math.floor(near.length / 2)].hull; const lon = hs.reduce((s, p) => s + p[0], 0) / hs.length, lat = hs.reduce((s, p) => s + p[1], 0) / hs.length;
      result.lod2.at = [lon, lat];
      await setMode('all'); await ev('window.__lc152.lookAtFirst(500, -45, [' + lon + ',' + lat + '])'); await sleep(9000);
      const camA = await ev('JSON.stringify(window.__lc152.camera())');
      const both = await pixels('lod2-both.png'); const tBoth = await tsStats();
      await ev('window.__lc152.setShow(false)'); await sleep(2500);
      const lod1only = await pixels('lod2-off-lod1only.png'); const tL1 = await tsStats();
      await ev('window.__lc152.setShow(true)'); await setMode('single'); await sleep(3500);
      const lod2only = await pixels('lod2-only.png'); const tL2 = await tsStats();
      await setMode('all'); await sleep(1500);
      result.lod2 = { ...result.lod2, camera: JSON.parse(camA), tris: { both: tBoth, lod1Only: tL1, lod2Only: tL2 }, pixelDiff: { bothVsLod1Only: await diff(both, lod1only), bothVsLod2Only: await diff(both, lod2only), lod2OnlyVsLod1Only: await diff(lod2only, lod1only) },
        clip: await ev('JSON.stringify({clipMode: window.__lc152.state.clipMode, clipped: window.__lc152.state.clippedTilesets, near: window.__lc152.state.nearClip || null})') };
    }
    result.diagnose = await ev('window.__lc152.diagnose().then(d => JSON.stringify({hints: d.hints, allMode: d.allMode, wards: d.wards}))').then((s) => JSON.parse(s)).catch((e) => String(e));
    result.serverTrace = await getJson('http://127.0.0.1:' + port + '/__lod2/diag.json').then((d) => ({ requests: d.requests, extServed: d.extServed, extAttach: d.extAttach && { attached: d.extAttach.attached, wards: d.extAttach.chosen && d.extAttach.chosen.wards, brokenWards: d.extAttach.chosen && d.extAttach.chosen.brokenWards } })).catch((e) => String(e));
    result.pass = WARDS.every((w) => result.wards[w] && result.wards[w].drawn);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 1));
    console.log(JSON.stringify(result, null, 1));
    ws.close();
  } finally { chrome.kill(); srv.kill(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
