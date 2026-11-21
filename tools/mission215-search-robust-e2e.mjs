// Mission 215 第4サイクル: 検索の信頼性(IME・古い応答の競合・失敗時表示・Cloud案内文)を実ブラウザ(headless Chromium + CDP)で検証する。
// 使い方: node tools/mission215-search-robust-e2e.mjs [--html <HTML>] [--chrome /usr/bin/chromium] [--out r.json]
// 区分: REAL = CDP の実入力(Input.imeSetComposition / dispatchKeyEvent / insertText)。FIXTURE = サーバ側で応答遅延・失敗・index.json を合成。
//   遷移先座標・候補は合成(テスト公園A/B/C)。実データ・外部 tile・有料 API は不使用。Cesium は CDN。到達不可なら NOT_TESTED。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const CHROME = arg('chrome', '/usr/bin/chromium'); const OUT = arg('out', null);
const HTML = path.resolve(arg('html', 'public/mission37g-osaka-24ward-mvp.html')); const PUB = path.resolve('public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const FIX = { items: [['テスト公園A', 0], ['テスト公園B', 400], ['テスト公園C', 800]].map(([name, x], i) => ({ kind: 'park', name, x: 1000 + x, z: 1000 + 300 * i, importance: 'major' })) };
const cfg = { labelsDelayFirstMs: 0, labelsFail: false, labelsReq: 0, indexJson: null }; // シナリオごとに書き換える
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u.endsWith('/labels.json') && !u.includes('ext-3dtiles/')) {
    const n = ++cfg.labelsReq; const d = n === 1 ? cfg.labelsDelayFirstMs : 0;
    return setTimeout(() => { if (cfg.labelsFail) { r.writeHead(500); return r.end(); } r.writeHead(200, { 'content-type': MIME['.json'] }); r.end(JSON.stringify(FIX)); }, d);
  }
  if (u === '/ext-3dtiles/index.json') { if (cfg.indexJson === 'fail') { r.writeHead(500); return r.end(); } if (cfg.indexJson) { r.writeHead(200, { 'content-type': MIME['.json'] }); return r.end(JSON.stringify(cfg.indexJson)); } }
  const f = u === '/' ? HTML : path.join(PUB, u); if (!f.startsWith(PUB) && f !== HTML) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); }
    if (f === HTML) { const k = 'const scene = viewer.scene;'; const t = d.toString('utf8'); if (t.includes(k)) d = Buffer.from(t.replace(k, k + ' window.__v = viewer;')); }
    r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
const port = 9300 + Math.floor(Math.random() * 500); const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'm215r-'));
const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
let tg; for (let i = 0; i < 60 && !tg; i++) { try { tg = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await new Promise((r) => setTimeout(r, 500)); } }
const ws = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 150) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } return false; };
const KC = { ArrowDown: 40, Enter: 13, Escape: 27 };
const key = async (k, extra = {}) => { const o = { key: k, code: k, windowsVirtualKeyCode: extra.vk ?? KC[k], nativeVirtualKeyCode: extra.vk ?? KC[k] }; await send('Input.dispatchKeyEvent', { type: k === 'Enter' && !extra.vk ? 'keyDown' : 'rawKeyDown', ...o, ...(k === 'Enter' && !extra.vk ? { text: '\r' } : {}) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...o }); await sleep(120); };
const focusQ = () => ev(`(()=>{const q=document.getElementById('lc-q');q.value='';q.focus()})()`);
const type = async (t) => { await focusQ(); await send('Input.insertText', { text: t }); };
const S = `(()=>{const q=document.getElementById('lc-q'),rb=document.getElementById('lc-results');const o=[...rb.querySelectorAll('button[role=option]')];
 return {n:o.length,open:rb.classList.contains('on'),val:q.value,names:o.map((b)=>b.textContent),text:rb.textContent,searching:/検索中/.test(rb.textContent)}})()`;
const report = { html: path.relative('.', HTML), kind: {}, sizes: {} }; let fails = 0;
await send('Page.enable'); await send('Runtime.enable');
const load = async (qs = '') => { cfg.labelsReq = 0; await send('Page.navigate', { url: base + '/' + qs }); return waitFor(`!!window.__v && !!document.getElementById('lc-q')`, 40000); };
for (const [w, h, mobile] of [[390, 844, true], [1366, 768, false]]) {
  const C = {}; report.sizes[`${w}x${h}`] = C;
  const chk = (n, ok, info, kind = 'REAL') => { C[n] = (ok ? 'PASS' : 'FAIL' + (info ? ' ' + JSON.stringify(info).slice(0, 300) : '')) + ` [${kind}]`; if (!ok) fails++; };
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  Object.assign(cfg, { labelsDelayFirstMs: 0, labelsFail: false, indexJson: null });
  if (!(await load())) { C.pageLoaded = 'NOT_TESTED(Cesium CDN 未到達の可能性)'; continue; }
  if (mobile) await ev(`document.body.classList.add('show-left')`);
  // ── 1. IME(CDP の imeSetComposition = 実ブラウザの composition イベント) ──
  await focusQ();
  await ev(`window.__ev=[];const q=document.getElementById('lc-q');for(const n of ['compositionstart','compositionupdate','compositionend','input'])q.addEventListener(n,(e)=>__ev.push(n));document.getElementById('lc-search').addEventListener('submit',()=>__ev.push('submit'),true)`);
  await send('Input.imeSetComposition', { text: 'てすと', selectionStart: 3, selectionEnd: 3 });
  await waitFor(`__ev.includes('compositionstart')`, 2000);
  // 変換中の Enter(変換確定キー。Chromium は keyCode 229 / isComposing=true)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(250);
  const evComp = await ev(`__ev.slice()`);
  chk('ime_enter_during_composition_no_submit', evComp.includes('compositionstart') && !evComp.includes('submit'), evComp);
  await send('Input.insertText', { text: 'テスト公園' }); // 変換確定(compositionend + 確定文字列)
  const upd = await waitFor(`document.querySelectorAll('#lc-results button[role=option]').length===3`);
  const evEnd = await ev(`__ev.slice()`);
  chk('ime_commit_updates_candidates', upd && evEnd.includes('compositionend'), evEnd);
  // 候補が出ている状態で、変換中の Enter が候補を確定しない(選択されない=入力欄の値が候補名で上書きされない)
  await ev(`window.__ev=[]`);
  await send('Input.imeSetComposition', { text: 'こうえん', selectionStart: 4, selectionEnd: 4 });
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(250);
  let s = await ev(S); const evC2 = await ev(`__ev.slice()`);
  chk('ime_enter_with_open_results_no_choose', !evC2.includes('submit') && !/^テスト公園[ABC]$/.test(s.val), { evC2, val: s.val });
  await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  // Safari 型の並び(compositionend の後に keyCode 229 の Enter keydown): isComposing=false でも 229 を送る合成イベントでガードを検証(EMULATED)
  await focusQ(); await send('Input.insertText', { text: 'テスト公園' }); await waitFor(`document.querySelectorAll('#lc-results button[role=option]').length===3`);
  await ev(`window.__ev=[];`);
  const prevented = await ev(`(()=>{const q=document.getElementById('lc-q');const e=new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true});q.dispatchEvent(e);return e.defaultPrevented})()`);
  s = await ev(S);
  chk('safari_style_enter_229_after_compositionend_not_chosen', prevented === true && /^テスト公園$/.test(s.val), { prevented, val: s.val }, 'EMULATED');
  // 通常の Enter は引き続き候補を選ぶ(回帰)
  await key('ArrowDown'); await key('Enter'); s = await ev(S);
  chk('plain_enter_still_chooses', s.val === 'テスト公園A' && !s.open, s);
  // ── 2. 検索失敗時(labels.json 500): 失敗を成功扱いしない ──
  Object.assign(cfg, { labelsFail: true, labelsDelayFirstMs: 0 }); await load(); if (mobile) await ev(`document.body.classList.add('show-left')`);
  await type('テスト公園'); await waitFor(`!document.querySelector('#lc-results .empty')||!/検索中/.test(document.getElementById('lc-results').textContent)`);
  await sleep(600); s = await ev(S);
  chk('failed_labels_shows_partial_notice', !s.searching && /不完全|読み込めなかった/.test(s.text), s, 'FIXTURE');
  chk('failed_labels_no_fake_hits', s.n === 0 || !s.names.some((n) => /テスト公園/.test(n)), s, 'FIXTURE');
  Object.assign(cfg, { labelsFail: false }); await load(); if (mobile) await ev(`document.body.classList.add('show-left')`);
  await type('テスト公園'); const rec = await waitFor(`document.querySelectorAll('#lc-results button[role=option]').length===3`);
  chk('recovery_after_reload', rec, null, 'FIXTURE');
  // ── 3. 競合(最初の labels.json 応答を 2.5s 遅延 = インデックス構築が2本並走し、先発 A が後着) ──
  const race = async (name, fn) => { Object.assign(cfg, { labelsDelayFirstMs: 2500, labelsFail: false }); await load(); if (mobile) await ev(`document.body.classList.add('show-left')`); await fn(); };
  await race('A_then_B', async () => {
    await type('テスト公園A'); await sleep(200); await type('テスト公園C'); // B が先着(2本目は遅延なし)、A は 2.5s 後に到着
    await waitFor(`document.querySelectorAll('#lc-results button[role=option]').length>0`); await sleep(3200); const s2 = await ev(S);
    chk('race_A_slow_B_fast_final_is_B', s2.val === 'テスト公園C' && s2.names.length === 1 && s2.names[0].includes('テスト公園C'), s2, 'FIXTURE');
  });
  await race('escape', async () => {
    await type('テスト公園'); await sleep(200); await key('Escape'); await sleep(3200); const s2 = await ev(S);
    chk('race_escape_then_stale_response_stays_closed', !s2.open && s2.n === 0, s2, 'FIXTURE');
  });
  await race('chosen', async () => {
    await type('テスト公園A'); await sleep(200);
    await type('テスト公園C'); await waitFor(`document.querySelectorAll('#lc-results button[role=option]').length===1`, 4000);
    await key('ArrowDown'); await key('Enter'); const afterChoose = await ev(S); await sleep(3200); const s2 = await ev(S);
    chk('race_choose_then_stale_response_no_reopen', afterChoose.val === 'テスト公園C' && !s2.open && s2.n === 0 && s2.val === 'テスト公園C', { afterChoose, s2 }, 'FIXTURE');
  });
  // ── 4. Cloud 案内文(?ext45=1 + index.json 合成) ──
  const cloud = async (idx) => { cfg.indexJson = idx; Object.assign(cfg, { labelsDelayFirstMs: 0 }); await load('?ext45=1'); await waitFor(`document.getElementById('ward-cov-note').textContent.includes('配信 index に登録')`, idx && idx !== 'fail' && idx.wards.length > 1 ? 25000 : 6000); await sleep(500); return ev(`({note:document.getElementById('ward-cov-note').textContent,loadingDone:document.getElementById('lc-loading').classList.contains('done'),msg:document.getElementById('lc-loading-msg').textContent,err:document.getElementById('lc-loading').classList.contains('err')})`); };
  const OLD = '3D建物が見えるのは'; // ローカル文言(初期 HTML か、coverage 読込後の「N 区…の一部だけ」)。Cloud 文言(配信 index に登録)とは別
  let c = await cloud({ verified: true, wards: [{ ward: 'a' }, { ward: 'b' }, { ward: 'c' }] });
  chk('cloud_3wards_note_not_claiming_all_rendered', /3 区分/.test(c.note) && !c.note.includes(OLD) && !/全24区.*描画済|描画確認済/.test(c.note), c, 'FIXTURE');
  c = await cloud({ verified: true, wards: [{ ward: 'a' }] });
  chk('cloud_1ward_keeps_local_wording', c.note.includes(OLD) && !c.note.includes('配信 index に登録'), c, 'FIXTURE');
  c = await cloud('fail');
  chk('cloud_index_fail_keeps_local_wording_and_page_alive', c.note.includes(OLD) && !c.note.includes('配信 index に登録'), c, 'FIXTURE');
  c = await cloud(null); // 実 public/ には ext-3dtiles が無い = 404
  chk('cloud_index_404_keeps_local_wording', c.note.includes(OLD) && !c.note.includes('配信 index に登録'), c, 'FIXTURE');
  cfg.indexJson = null; await load(); await sleep(3000);
  const loc = await ev(`({note:document.getElementById('ward-cov-note').textContent})`);
  chk('local_mode_no_ext45_old_wording', loc.note.includes(OLD) && !loc.note.includes('配信 index に登録'), loc);
  C.loadingMsgGoneNote = 'lc-loading の消灯は index 合成時に tile が無いため実データでは未確認(NOT_TESTED)';
}
report.fails = fails; if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1)); ch.kill(); srv.close(); process.exit(fails ? 1 : 0);
