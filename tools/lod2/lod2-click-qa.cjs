#!/usr/bin/env node
'use strict';
// Mission 213: 実マウスクリック QA。静的に配信した merged ツリー(lod2-cloud-merge の出力)を headless Chrome で開き、
//   画面グリッドを drillPick で走査 → 建物(canonicalId が bldg_ で始まる)が出る画面点を見つけ → CDP の Input.dispatchMouseEvent で
//   本物の mousePressed/Released を送る → 37G の ScreenSpaceEventHandler → stats.selectedCanonicalId → 右パネル(#lc-bldg-body) を検査する。
//   GLB メタデータの確認だけでは「クリック成功」とは扱わない。LOD2 建物か LOD1 建物かは lod2-preview/footprints.json の ids で区別。
//   node tools/lod2/lod2-click-qa.cjs [--bundle temp/cloud-merged] [--lod1 sumiyoshi,hirano,ikuno] [--out temp/click-qa]
// 判定: PASS=選択が反映 / FAIL=pick できるのに選択が反映されない / NO-TARGET=その視点に建物が無い(FAIL ではなく未検証)。
// LOD1 サイドカー(属性)未配信は DIAG(sidecar-unconnected)であり、選択自体の FAIL ではない。SwiftShader。実 GPU・ユーザー PC は未測定。
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), http = require('http');

// ---- 純関数(テスト対象) ----
function classifyClick(r) {
  // Mission 215: API 不在・例外・ID 形式不一致は NO-TARGET に丸めず FAIL にする(原因を握り潰さない)
  if (r.apiError) return { verdict: 'FAIL', reason: 'pick API が使えない/例外: ' + r.apiError };
  if (!r.found && r.idFormatMismatch) return { verdict: 'FAIL', reason: 'pick は成功したが canonicalId が bldg_ 形式でない(37G は町丁目クリック扱いにする): ' + r.idFormatMismatch };
  if (!r.found) return { verdict: 'NO-TARGET', reason: 'この視点の画面グリッドに bldg_ の建物が無い(未検証)' };
  if (!r.clicked) return { verdict: 'FAIL', reason: 'クリックを送れなかった' };
  if (r.selectedCanonicalId !== r.id) return { verdict: 'FAIL', reason: r.selectedCanonicalId ? '別の建物が選択された' : 'pick できるのに 37G が選択しなかった(ScreenSpaceEventHandler 経路)' };
  if (!r.panelOn) return { verdict: 'FAIL', reason: '選択 ID は入ったが建物パネルが開かない' };
  const diag = [];
  if (/未配信|照合中|—/.test(r.sidecarText || '')) diag.push('sidecar-unconnected');
  return { verdict: 'PASS', reason: '実クリック → pick → canonicalId → 建物パネル', diag };
}
function gridPoints(W, H, left = 330, right = 340, top = 90, bottom = 50, nx = 26, ny = 14) {
  const pts = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push([Math.round(left + ((W - left - right) * (i + 0.5)) / nx), Math.round(top + ((H - top - bottom) * (j + 0.5)) / ny)]);
  // 中央から外へ(中心付近の建物を優先)
  const cx = W / 2, cy = H / 2; return pts.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
}
module.exports = { classifyClick, gridPoints };
if (require.main !== module) return;

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE = path.resolve(ROOT, opt('bundle', 'temp/cloud-merged'));
const out = path.resolve(ROOT, opt('out', 'temp/click-qa'));
const port = Number(opt('port', 8213)), cport = Number(opt('cdp', 9413));
const HOST = 'lc-cloud.test';
const chromeBin = opt('chrome', ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[click-qa]', ...a);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary' };
const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname); const f = path.resolve(BUNDLE, '.' + (p === '/' ? '/index.html' : p));
  if (!f.startsWith(BUNDLE + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
function wardCenter(w) { try { const t = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'ext-3dtiles', w, 'tileset.json'), 'utf8')); const g = t.root.boundingVolume.region; if (g) return [((g[0] + g[2]) / 2) * 180 / Math.PI, ((g[1] + g[3]) / 2) * 180 / Math.PI]; } catch (e) { /* noop */ } return null; }

async function main() {
  if (!fs.existsSync(path.join(BUNDLE, 'ext-3dtiles', 'index.json'))) throw new Error('バンドル未生成: ' + BUNDLE);
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const targets = [{ name: 'umeda-kita-LOD2', expect: 'lod2', at: [135.4959, 34.7055] }, { name: 'chuo-LOD2', expect: 'lod2', at: [135.5041, 34.6721] }];
  for (const w of opt('lod1', 'sumiyoshi,hirano,ikuno').split(',').filter(Boolean)) { const c = wardCenter(w); if (c) targets.push({ name: w + '-LOD1', expect: 'lod1', at: c }); else targets.push({ name: w + '-LOD1', expect: 'lod1', at: null }); }
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--host-resolver-rules=MAP ' + HOST + ' 127.0.0.1', '--window-size=1280,800', '--remote-debugging-port=' + cport, '--user-data-dir=' + path.join(out, 'profile'), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const R = { kind: 'REAL merged tree, real CDP mouse clicks (not fixture)', swiftshader: true, results: [], console: [] };
  try {
    let tg; for (let i = 0; i < 150; i++) { try { tg = await getJson('http://127.0.0.1:' + cport + '/json'); break; } catch (e) { await sleep(200); } }
    if (!tg) throw new Error('Chrome のデバッグポートに接続できません');
    const ws = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
    let id = 0; const pend = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d.error); pend.delete(d.id); return; }
      if (d.method === 'Runtime.exceptionThrown') R.console.push('EXC ' + String(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).slice(0, 160)); };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), sleep(90000).then(() => ({ __t: 1 }))]); if (r.__t) throw new Error('応答停止'); return r.result ? r.result.value : r; };
    await send('Runtime.enable'); await send('Page.enable'); await send('Input.setIgnoreInputEvents', { ignore: false });
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://' + HOST + ':' + port + '/' });
    for (let i = 0; i < 120; i++) { if ((await ev('!!document.getElementById("sel-bldg-mode")')) === true) break; await sleep(500); }
    await ev('(()=>{const m=document.getElementById("sel-bldg-mode");m.value="all";m.dispatchEvent(new Event("change"));})()');
    const WARDS = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'ext-3dtiles', 'index.json'), 'utf8')).wards.length;
    for (let i = 0; i < 400; i++) { const n = await ev('(window.__mission37g && window.__mission37g.extraMeta && window.__mission37g.extraMeta.length) || 0').catch(() => 0); if (n >= WARDS) break; await sleep(500); }
    for (let i = 0; i < 360; i++) { const s = await ev('window.__lc152 && window.__lc152.state.status'); if (s === 'ready' || s === 'error' || s === 'refused') break; await sleep(500); }
    R.lod2Status = await ev('window.__lc152 && window.__lc152.state.status'); R.wards = WARDS;
    const lod2Ids = new Set(await ev('fetch("/lod2-preview/footprints.json").then(r=>r.json()).then(j=>j.ids||[])'));
    R.lod2IdCount = lod2Ids.size;
    for (const t of targets) {
      const rec = { name: t.name, expect: t.expect, found: false, clicked: false };
      if (!t.at) { rec.verdict = 'NO-TARGET'; rec.reason = '区の tileset 領域から中心を取れない'; R.results.push(rec); continue; }
      await ev('window.__mission37g.clearSelection && window.__mission37g.clearSelection()').catch(() => 0);
      await ev('window.__lc152.lookAtFirst(450, -50, [' + t.at[0] + ',' + t.at[1] + '])');
      // タイルが実際に読み込まれて選択されるまで待つ(固定 sleep だけに頼らない。SwiftShader は遅い)
      rec.waitLog = [];
      for (let i = 0; i < 40; i++) {
        await sleep(3000);
        const st = await ev('JSON.stringify({ready: window.__mission37g.tilesReady && window.__mission37g.tilesReady(), lod2: window.__lc152.stats && window.__lc152.stats(), cam: window.__lc152.camera && window.__lc152.camera()})').then(JSON.parse).catch((e) => ({ err: String(e.message || e) }));
        rec.waitLog.push(st); if (rec.waitLog.length > 3) rec.waitLog.shift();
        const lod2sel = st.lod2 && st.lod2.numberOfTrianglesSelected > 0;
        if (st.ready && (t.expect === 'lod1' || lod2sel) && i >= 3) break;
      }
      rec.camera = await ev('JSON.stringify(window.__lc152.camera())').then(JSON.parse).catch(() => null);
      rec.tilesets = await ev('JSON.stringify({c: window.__mission37g.cameraVsTilesets && window.__mission37g.cameraVsTilesets(), n: window.__mission37g.tilesetCount && window.__mission37g.tilesetCount().n})').then(JSON.parse).catch((e) => ({ err: String(e.message || e) }));
      const api = await ev('typeof window.__mission37g.drillIds'); rec.drillIdsType = api;
      const hits = []; const seen = { points: 0, withAnyId: 0, nonBldg: {}, errors: 0, firstError: null };
      if (api !== 'function') rec.apiError = 'window.__mission37g.drillIds が関数でない(' + api + ')';
      else for (const [x, y] of gridPoints(1280, 800)) {
        // ページ内で実行し、例外は握り潰さず記録する
        const r = await ev('(()=>{try{return JSON.stringify({ids: window.__mission37g.drillIds(' + x + ',' + y + ')})}catch(e){return JSON.stringify({err:String(e&&e.message||e)})}})()').then((q) => JSON.parse(q)).catch((e) => ({ err: 'evaluate: ' + String(e && e.message || e) }));
        seen.points++;
        if (r.err) { seen.errors++; seen.firstError = seen.firstError || r.err; continue; }
        const ids = (r.ids || []).filter((v) => typeof v === 'string' && v);
        if (ids.length) seen.withAnyId++;
        for (const v of ids) if (!/^bldg_/.test(v)) { const k = v.slice(0, 5); seen.nonBldg[k] = (seen.nonBldg[k] || 0) + 1; }
        const bid = ids.find((v) => /^bldg_/.test(v));
        if (bid) { const src = lod2Ids.has(bid) ? 'lod2' : 'lod1'; hits.push({ x, y, id: bid, src }); if (hits.some((h) => h.src === t.expect)) break; }
      }
      rec.scan = seen;
      if (!rec.apiError && seen.points > 0 && seen.errors === seen.points) rec.apiError = seen.firstError;
      if (!hits.length && seen.withAnyId > 0) rec.idFormatMismatch = JSON.stringify(seen.nonBldg);
      const h = hits.find((v) => v.src === t.expect) || null;
      if (h) {
        rec.found = true; rec.id = h.id; rec.source = h.src; rec.px = [h.x, h.y];
        for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await send('Input.dispatchMouseEvent', { type, x: h.x, y: h.y, ...extra });
        rec.clicked = true; await sleep(2500);
        const s = JSON.parse(await ev('JSON.stringify({sel: window.__mission37g.selectedCanonicalId, on: document.getElementById("lc-bldg-body").classList.contains("on"), cid: document.getElementById("lc-cid").textContent, side: document.getElementById("lb-side").textContent, ward: document.getElementById("lb-ward").textContent})'));
        rec.selectedCanonicalId = s.sel; rec.panelOn = s.on; rec.panelId = s.cid; rec.sidecarText = s.side; rec.panelWard = s.ward;
        const buf = Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'); fs.writeFileSync(path.join(out, t.name + '.png'), buf);
      } else if (hits.length) { rec.otherSourceOnly = hits[0].src; }
      rec.waitLog = rec.waitLog && rec.waitLog.slice(-1);
      Object.assign(rec, classifyClick(rec));
      if (rec.id) rec.id = rec.id.slice(0, 13) + '…';   // 公開 gml:id の先頭のみ記録
      if (rec.selectedCanonicalId) rec.selectedCanonicalId = String(rec.selectedCanonicalId).slice(0, 13) + '…';
      if (rec.panelId) rec.panelId = String(rec.panelId).slice(0, 13) + '…';
      R.results.push(rec); log(t.name, rec.verdict, rec.reason);
    }
    R.summary = { pass: R.results.filter((r) => r.verdict === 'PASS').length, fail: R.results.filter((r) => r.verdict === 'FAIL').length, noTarget: R.results.filter((r) => r.verdict === 'NO-TARGET').length };
    R.pass = R.summary.fail === 0 && R.summary.pass >= 1 && R.results.filter((r) => r.expect === 'lod2').some((r) => r.verdict === 'PASS');
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(R, null, 1)); console.log(JSON.stringify(R, null, 1)); ws.close();
    process.exitCode = R.pass ? 0 : 6;
  } finally { chrome.kill(); srv.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
