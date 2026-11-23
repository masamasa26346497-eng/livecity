// Mission 215: 実ブラウザ(headless Chromium + CDP)で public/mission37g-osaka-24ward-mvp.html の UI 状態機械を検証する。
// 使い方: node tools/mission215-ui-e2e.mjs [--chrome /usr/bin/chromium] [--out report.json]
// 注意: 建物/施設/町丁目の選択は実データ(3D Tiles 等)が無いと発火できないため、コードと同一の DOM 更新を再現して CSS/状態を検証する(emulated)。
//       区ボタン・Escape・閉じる・検索結果リストは実ページの実イベント。Cesium は CDN から取得(到達不可なら NOT_TESTED)。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const CHROME = arg('chrome', '/usr/bin/chromium'); const OUT = arg('out', null);
const PUB = path.resolve('public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(PUB, u === '/' ? 'mission37g-osaka-24ward-mvp.html' : u); if (!f.startsWith(PUB)) { r.writeHead(403); return r.end(); } fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
const port = 9300 + Math.floor(Math.random() * 500); const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'm215-'));
const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
let tg; for (let i = 0; i < 60 && !tg; i++) { try { tg = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await new Promise((r) => setTimeout(r, 500)); } }
const ws = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = async (k) => { for (const t of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type: t, key: k, code: k }); };
const sizes = [[360, 640, true], [390, 844, true], [768, 1024, false], [1366, 768, false]];
const report = { sizes: {}, notes: [] };
const R = `(()=>{const o={};for(const s of ['#lc-left','#lc-right','#lc-ward-card','#lc-results','#lc-header','#btn-panels','canvas']){const e=document.querySelector(s);if(!e){o[s]=null;continue}const cs=getComputedStyle(e);const b=e.getBoundingClientRect();o[s]={d:cs.display,x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}}return o})()`;
const vis = (o) => !!o && o.d !== 'none' && o.w > 0 && o.h > 0;
const hit = (a, b) => vis(a) && vis(b) && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
await send('Page.enable'); await send('Runtime.enable');
for (const [w, h, mobile] of sizes) {
  const S = { checks: {}, rects: {} }; report.sizes[`${w}x${h}`] = S;
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await send('Page.navigate', { url: base + '/' });
  let ready = false; for (let i = 0; i < 80 && !ready; i++) { await sleep(500); ready = await ev(`!!(document.querySelector('.lc-wardbtn') && typeof Cesium!=='undefined')`).catch(() => false); }
  if (!ready) { S.checks.pageLoaded = 'NOT_TESTED(区ボタン/Cesium が現れない: CDN 未到達の可能性)'; continue; }
  S.checks.pageLoaded = 'PASS';
  const empty = () => ev(`(()=>{const o=document.getElementById('lc-bldg-empty');return {rightDisplay:getComputedStyle(document.getElementById('lc-right')).display}})()`);
  const st = async (name) => { const o = await ev(R); S.rects[name] = o; return o; };
  // 状態 1: 未選択
  let o = await st('unselected');
  S.checks.unselected_right_hidden_on_mobile = (w <= 720) ? (o['#lc-right'].d === 'none' ? 'PASS' : 'FAIL') : (o['#lc-right'].d !== 'none' ? 'PASS' : 'FAIL');
  S.checks.canvas_visible = vis(o['canvas']) ? 'PASS' : 'FAIL';
  // 状態 2-4: emulated 選択(コードと同一の DOM 更新)
  for (const [nm, body] of [['poi', 'lc-poi-body'], ['town', 'lc-town-body'], ['bldg', 'lc-bldg-body']]) {
    await ev(`(()=>{document.getElementById('lc-bldg-empty').style.display='none';document.getElementById('${body}').classList.add('on')})()`);
    o = await st('sel_' + nm);
    S.checks[`${nm}_card_visible`] = vis(o['#lc-right']) ? 'PASS(emulated DOM)' : 'FAIL(emulated DOM)';
    if (mobile) { const m = o['#lc-right']; S.checks[`${nm}_card_within_viewport`] = (m.x >= 0 && m.y >= 0 && m.x + m.w <= w && m.y + m.h <= h) ? 'PASS' : 'FAIL'; }
    if (mobile && nm === 'poi') { // 閉じるボタンの実クリック
      const bx = await ev(`(()=>{const b=document.getElementById('lc-info-close').getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2,b.width,b.height]})()`);
      S.checks.close_button_44px = (bx[2] >= 44 && bx[3] >= 44) ? 'PASS' : 'FAIL';
      for (const t of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x: bx[0], y: bx[1], button: 'left', clickCount: 1 });
      await sleep(200); const a = await ev(`({ds:document.getElementById('lc-bldg-empty').style.display, on:document.getElementById('lc-poi-body').classList.contains('on'), act:document.activeElement&&document.activeElement.id})`);
      o = await st('after_close');
      S.checks.close_resets_state = (!a.on && a.ds !== 'none' && o['#lc-right'].d === 'none') ? 'PASS' : 'FAIL ' + JSON.stringify(a);
      S.checks.close_focus_target = `activeElement=${a.act}(モバイルは btn-panels 固定)`;
      continue;
    }
    await ev(`(()=>{document.getElementById('lc-bldg-empty').style.display='';document.getElementById('${body}').classList.remove('on')})()`);
  }
  // 区ボタンの実クリック → 区カード、Escape
  if (mobile) { await ev(`document.getElementById('btn-panels').click()`); await sleep(150); o = await st('left_open'); S.checks.left_open = vis(o['#lc-left']) ? 'PASS' : 'FAIL'; S.checks.aria_expanded_open = (await ev(`document.getElementById('btn-panels').getAttribute('aria-expanded')`)) === 'true' ? 'PASS' : 'FAIL'; }
  const camBefore = await ev(`(()=>{const v=window.__v; return null})()`);
  const bc = await ev(`(()=>{const b=document.querySelector('.lc-wardbtn');if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2,r.width,r.height]})()`);
  if (bc) {
    if (mobile) S.checks.wardbtn_44px = (bc[2] >= 44 && bc[3] >= 44) ? 'PASS' : `FAIL(${Math.round(bc[2])}x${Math.round(bc[3])})`;
    for (const t of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x: bc[0], y: bc[1], button: 'left', clickCount: 1 });
    await sleep(500); o = await st('ward_selected');
    S.checks.ward_card_visible = vis(o['#lc-ward-card']) ? 'PASS' : 'FAIL';
    if (mobile) { S.checks.ward_select_closes_left = !vis(o['#lc-left']) ? 'PASS' : 'FAIL'; S.checks.ward_card_vs_right_overlap = hit(o['#lc-ward-card'], o['#lc-right']) ? 'FAIL' : 'PASS'; S.checks.aria_expanded_after_ward = (await ev(`document.getElementById('btn-panels').getAttribute('aria-expanded')`)) === 'false' ? 'PASS' : 'FAIL'; }
    S.checks.ward_card_vs_header_overlap = hit(o['#lc-ward-card'], o['#lc-header']) ? 'FAIL' : 'PASS';
    const wasHome = await ev(`document.querySelectorAll('.lc-wardbtn[aria-pressed=true]').length`);
    await key('Escape'); await sleep(300); o = await st('after_escape');
    S.checks.escape_closes_ward = (!vis(o['#lc-ward-card']) && (await ev(`document.querySelectorAll('.lc-wardbtn[aria-pressed=true]').length`)) === 0 && wasHome === 1) ? 'PASS' : 'FAIL';
  } else S.checks.ward_flow = 'NOT_TESTED(区ボタンなし)';
  // 検索結果と区カード/右パネルの重なり(emulated: results に on を付与して矩形を測る)
  if (mobile) { await ev(`document.querySelector('.lc-wardbtn') && document.querySelector('.lc-wardbtn').click()`); await sleep(300); }
  await ev(`(()=>{const rb=document.getElementById('lc-results'); rb.innerHTML='<button type="button">テスト結果</button>'; rb.classList.add('on')})()`);
  o = await st('results_open'); S.checks.results_visible = vis(o['#lc-results']) ? 'PASS(emulated 内容)' : 'FAIL';
  { const z = await ev(`[getComputedStyle(document.getElementById('lc-results')).zIndex, getComputedStyle(document.getElementById('lc-ward-card')).zIndex].map(Number)`); S.checks.results_vs_ward_card_overlap = !hit(o['#lc-results'], o['#lc-ward-card']) ? 'PASS' : (z[0] > z[1] ? 'INFO(重なるが検索結果が前面 z=' + z[0] + '>' + z[1] + '。Escape/外側クリックで閉じる一時的なドロップダウン)' : 'FAIL(区カードが検索結果を隠す)'); }
  S.checks.results_vs_right_overlap = hit(o['#lc-results'], o['#lc-right']) ? 'FAIL(重なる)' : 'PASS';
  await key('Escape'); await sleep(200);
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.sizes, (k, v) => (k === 'rects' ? undefined : v), 1));
ch.kill(); srv.close(); process.exit(0);
