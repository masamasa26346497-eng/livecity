// Mission 215 第3サイクル: 検索のキーボード操作を実ブラウザ(headless Chromium + CDP の実キー入力)で検証する。
// 使い方: node tools/mission215-search-e2e.mjs [--html <検証する HTML。既定 public/mission37g-osaka-24ward-mvp.html>] [--chrome /usr/bin/chromium] [--out r.json]
// fixture: labels.json への fetch を合成の複数候補(テスト公園A/B/C)で差し替える(実データ・外部 tile・有料 API は不使用)。
//   検索インデックス/結果リスト/キー操作/DOM/aria は実ページの実コード。地図遷移は camera.positionWC の変化で判定(遷移先は合成座標=模擬)。
//   Cesium は CDN(jsdelivr)から取得。到達不可なら NOT_TESTED。旧 HTML を --html で渡すと FAIL になることで fail→pass を示せる。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const CHROME = arg('chrome', '/usr/bin/chromium'); const OUT = arg('out', null);
const HTML = path.resolve(arg('html', 'public/mission37g-osaka-24ward-mvp.html')); const PUB = path.resolve('public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const FIX = { items: [['テスト公園A', 0], ['テスト公園B', 400], ['テスト公園C', 800]].map(([name, x], i) => ({ kind: 'park', name, x: 1000 + x, z: 1000 + 300 * i, importance: 'major' })) };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u.endsWith('/labels.json') && !u.includes('ext-3dtiles/')) { r.writeHead(200, { 'content-type': MIME['.json'] }); return r.end(JSON.stringify(FIX)); }
  const f = u === '/' ? HTML : path.join(PUB, u); if (!f.startsWith(PUB) && f !== HTML) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); }
    if (f === HTML) { const k = 'const scene = viewer.scene;'; let t = d.toString('utf8'); if (t.includes(k)) d = Buffer.from(t.replace(k, k + ' window.__v = viewer;')); }
    r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
const port = 9300 + Math.floor(Math.random() * 500); const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'm215s-'));
const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
let tg; for (let i = 0; i < 60 && !tg; i++) { try { tg = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await new Promise((r) => setTimeout(r, 500)); } }
const ws = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KC = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, Tab: 9 };
const key = async (k) => { const o = { key: k, code: k, windowsVirtualKeyCode: KC[k], nativeVirtualKeyCode: KC[k] }; await send('Input.dispatchKeyEvent', { type: k === 'Enter' ? 'keyDown' : 'rawKeyDown', ...o, ...(k === 'Enter' ? { text: '\r' } : {}) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...o }); await sleep(120); };
const type = async (t) => { await ev(`(()=>{const q=document.getElementById('lc-q');q.value='';q.focus()})()`); await send('Input.insertText', { text: t }); };
const waitFor = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
const S = `(()=>{const q=document.getElementById('lc-q'),rb=document.getElementById('lc-results');const o=[...rb.querySelectorAll('button[role=option]')];
 return {n:o.length,open:rb.classList.contains('on'),expanded:q.getAttribute('aria-expanded'),role:q.getAttribute('role'),ctrl:q.getAttribute('aria-controls'),ad:q.getAttribute('aria-activedescendant'),
 sel:o.map((b)=>b.getAttribute('aria-selected')),cls:o.map((b)=>b.classList.contains('active')),ids:o.map((b)=>b.id),val:q.value,focus:document.activeElement&&document.activeElement.id,names:o.map((b)=>b.textContent)}})()`;
const cam = () => ev(`(()=>{const c=__v.camera.positionWC;return [c.x,c.y,c.z]})()`);
const report = { html: path.relative('.', HTML), sizes: {} }; let fails = 0;
await send('Page.enable'); await send('Runtime.enable');
for (const [w, h, mobile] of [[390, 844, true], [1366, 768, false]]) {
  const C = {}; report.sizes[`${w}x${h}`] = C;
  const chk = (n, ok, info) => { C[n] = ok ? 'PASS' : 'FAIL' + (info ? ' ' + JSON.stringify(info) : ''); if (!ok) fails++; };
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await send('Page.navigate', { url: base + '/' });
  if (!(await waitFor(`!!window.__v && !!document.getElementById('lc-q')`, 40000))) { C.pageLoaded = 'NOT_TESTED(Cesium/viewer 未初期化: CDN 未到達の可能性)'; continue; }
  C.pageLoaded = 'PASS';
  if (mobile) await ev(`document.body.classList.add('show-left')`);
  // 1. 入力 → 3 候補 + ARIA
  await type('テスト公園'); const okRes = await waitFor(`document.querySelectorAll('#lc-results button[role=option]').length===3`);
  let s = await ev(S); chk('three_candidates', okRes && s.n === 3, s);
  chk('aria_combobox_expanded', s.role === 'combobox' && s.expanded === 'true' && s.ctrl === 'lc-results', s);
  chk('initial_no_highlight', !s.cls.some(Boolean) && !s.ad, s);
  // 2. ArrowDown ×2 → 2 番目、ArrowUp → 1 番目
  await key('ArrowDown'); await key('ArrowDown'); s = await ev(S);
  chk('arrowdown_moves_highlight', s.cls[1] === true && s.cls.filter(Boolean).length === 1 && s.sel[1] === 'true' && s.ad === s.ids[1] && s.focus === 'lc-q', s);
  await key('ArrowUp'); s = await ev(S); chk('arrowup_moves_highlight', s.cls[0] === true && s.ad === s.ids[0], s);
  // 3. ArrowDown → Enter: ハイライト済み(2 番目)を選択し、地図が動く
  await key('ArrowDown'); const c0 = await cam(); await key('Enter');
  const moved = await waitFor(`(()=>{const c=__v.camera.positionWC;return Math.hypot(c.x-(${c0[0]}),c.y-(${c0[1]}),c.z-(${c0[2]}))>50})()`, 15000);
  s = await ev(S); chk('enter_selects_highlighted', s.val === 'テスト公園B' && !s.open && s.expanded === 'false', s);
  chk('enter_moves_map(合成座標=模擬)', moved);
  // 4. Escape: 閉じて検索欄に focus
  await type('テスト公園'); await waitFor(`document.querySelectorAll('#lc-results button[role=option]').length===3`); await key('ArrowDown'); await key('Escape'); s = await ev(S);
  chk('escape_closes_and_focuses_input', !s.open && s.expanded === 'false' && !s.ad && s.focus === 'lc-q', s);
  // 5. Tab: 閉じ込めない(結果が閉じ、フォーカスが検索欄から出る)
  await type('テスト公園'); await waitFor(`document.querySelectorAll('#lc-results button[role=option]').length===3`); await key('Tab'); await sleep(100); s = await ev(S);
  chk('tab_not_trapped', !s.open && s.focus !== 'lc-q', s);
  // 6. 0 件: 矢印キーでエラーにならず、既定動作(preventDefault しない)を妨げない
  await type('zzzzqq'); await waitFor(`!!document.querySelector('#lc-results .empty') && !/検索中/.test(document.getElementById('lc-results').textContent)`);
  const pd = await ev(`(()=>{const e=new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true});document.getElementById('lc-q').dispatchEvent(e);return e.defaultPrevented})()`);
  s = await ev(S); chk('zero_hits_safe_no_preventDefault', s.n === 0 && pd === false, { s, pd });
  // 7. 結果が出ていないとき(閉じた状態)の矢印キーは preventDefault しない
  await key('Escape'); const pd2 = await ev(`(()=>{const e=new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true});document.getElementById('lc-q').dispatchEvent(e);return e.defaultPrevented})()`);
  chk('closed_arrow_not_prevented', pd2 === false);
}
report.fails = fails; if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1)); ch.kill(); srv.close(); process.exit(fails ? 1 : 0);
