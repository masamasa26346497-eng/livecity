// tools/experiments/mission37e_photo_display_qa.mjs
// [Mission 37E] 実ブラウザで「3D 建物を実クリック → Wikimedia 写真が画面に実際に出る」ことを確かめる。
//   - カメラは 36L 索引でなく建物 tile の属性サイドカー（attrs/）の代表点(repX,repZ,h)へ寄せる。名称検索・総当たりクリックは使わない。
//   - クリック座標は QA 専用フック（localhost かつ ?qa=1 のときだけ存在）の Cesium 投影 API で求め、
//     scene.pick が目的の canonicalId を返す点だけを CDP Input.dispatchMouseEvent で実クリックする。
//   - 合格(displayed)は、実クリックで目的の建物が選ばれ、かつ <img> が索引の URL と一致・complete・naturalWidth>0・表示幅>0、
//     作者/ライセンス/Commons リンクが DOM にあるときだけ。イベントの直接 dispatch は使わない。
//   - Google への通信 0 件・JS 例外 0 件も同時に確認する。無課金（Wikimedia の公開画像のみ）。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const BASE = process.env.MISSION37E_URL || 'http://localhost:8137/mission37d-sumiyoshi-mvp.html';
const URL_ = BASE + (BASE.includes('?') ? '&' : '?') + 'qa=1';
const OUT_DIR = 'data/reports/mission37e-places-ui-kit';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE_HOSTS = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const ONLY = (process.env.MISSION37E_ONLY || '').split(',').filter(Boolean); // 例: ONLY=東福寺,荘厳浄土寺
const T0 = Date.now();

// 9 tile 内で写真が表示条件を満たす建物（tools/mission37d-verify-photo-join.cjs の結果）
const TARGETS = [
  { name: '阪和病院', id: 'bldg_ec74351a-f344-4b61-b2e6-04b660b05aa0' },
  { name: '阪和住吉総合病院', id: 'bldg_ef3be94e-ff1b-4174-acd2-646dd9c4542d' },
  { name: '荘厳浄土寺', id: 'bldg_867c2448-0dcd-4a35-bfa6-3d7b7b93c1d8' },
  { name: '止止呂支比売命神社', id: 'bldg_1a63a520-ada1-45fe-96dd-e45b7c7cbceb' },
  { name: '東福寺', id: 'bldg_43fb9581-ca25-402e-a552-2953d62e210a' },
].filter((t) => !ONLY.length || ONLY.includes(t.name));

// 期待値は静的データから（画面の値とは独立に）求める
const photoIdx = JSON.parse(fs.readFileSync('public/map-data/osaka-city/derived/building-photo-index.json', 'utf8'));
const attrDir = 'public/mission37c-layers/osaka-sumiyoshi-9tile/attrs/';
const attrs = {};
for (const f of fs.readdirSync(attrDir)) Object.assign(attrs, JSON.parse(fs.readFileSync(attrDir + f, 'utf8')).byId);
for (const t of TARGETS) {
  const a = attrs[t.id];
  if (!a) throw new Error('attrs に無い: ' + t.id);
  [t.h, , t.x, t.z] = a;
  const e = photoIdx.byCanonicalId['cg_bldg_' + t.id];
  const p = e.photos.find((q) => /^https:/.test(q.thumbnailUrl) && q.license);
  t.expect = { thumb: p.thumbnailUrl, author: p.author, license: p.license, source: p.sourcePageUrl, conf: e.matchConfidence };
}

const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
const out = { mission: '37E', kind: 'photo-display', url: URL_, browser: b.version, generatedAt: new Date().toISOString(), googleRequests: [], imageRequests: [], jsErrors: [], targets: [], sequence: null };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => {
  try {
    const u = e.request.url;
    const host = new URL(u).hostname;
    if (GOOGLE_HOSTS.test(host)) out.googleRequests.push(u);
    if (/wikimedia\.org$/i.test(host)) out.imageRequests.push(u);
  } catch { /* data: URL 等 */ }
});

async function click(x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const ev = (js) => page.evaluate(js);
const selected = () => ev('(window.__mission37d && window.__mission37d.selectedCanonicalId) || null');
const photoState = () => ev(`(() => {
  const slot = document.getElementById('lc-photo-slot');
  const img = slot.querySelector('img');
  const cap = slot.querySelector('.cap');
  return JSON.stringify({
    slotText: slot.textContent.slice(0, 240),
    ariaBusy: slot.getAttribute('aria-busy'),
    img: img ? { src: img.src, complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, shownWidth: Math.round(img.getBoundingClientRect().width), alt: img.alt } : null,
    caption: cap ? cap.textContent : null,
    links: [...slot.querySelectorAll('a')].map((a) => ({ text: a.textContent, href: a.href })),
    name: document.getElementById('bs-name').textContent,
  });
})()`).then(JSON.parse);
async function waitPhoto(ms = 20000) {
  let s = null;
  for (let i = 0; i < ms / 500; i++) {
    await sleep(500);
    s = await photoState();
    if (s.img && s.img.complete) break;
    if (!s.img && s.ariaBusy !== 'true' && !/確認中/.test(s.slotText)) break;
  }
  return s;
}
async function settle(x, z, h, range, pitch, heading) {
  await ev(`window.__mission37dQA.lookAtLocal(${x}, ${z}, ${h}, ${range}, ${pitch}, ${heading || 0})`);
  await sleep(1500);
  for (let i = 0; i < 40; i++) { if (await ev('window.__mission37dQA.tilesReady()')) break; await sleep(500); }
  await sleep(800);
}
// 建物の代表点(高さ違い)の周りで scene.pick が目的の id を返す画面点を探す（クリックはしない）
async function findClickable(t) {
  let tried = 0;
  for (const f of [0.5, 1, 0.1, 0]) {
    const base = await ev(`JSON.stringify(window.__mission37dQA.project(${t.x}, ${t.z}, ${t.h * f}))`).then(JSON.parse);
    if (!base || !base.inCanvas) continue;
    for (const [dx, dy] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [12, 6], [-12, 6], [12, -6], [-12, -6], [20, 0], [-20, 0], [0, 20], [0, -20]]) {
      tried++;
      const x = base.x + dx, y = base.y + dy;
      if ((await ev(`window.__mission37dQA.pickId(${x}, ${y})`)) === t.id) return { x, y, tried, heightFrac: f };
    }
  }
  return { tried };
}

try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const ok = await ev("!!(window.__mission37d && window.__mission37dQA && document.getElementById('lc-loading') && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false);
    if (ok === true) break;
  }
  await sleep(2000);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const t of TARGETS) {
    const t0 = Date.now();
    const rec = { name: t.name, id: t.id, repXZ: [t.x, t.z], heightM: t.h, expect: t.expect, realClick: false, pick: null, photo: null };
    out.targets.push(rec);
    console.log('target:', t.name);
    await settle(t.x, t.z, t.h / 2, 260, -55, 0);
    let pick = await findClickable(t);
    if (!pick.x) { await settle(t.x, t.z, t.h / 2, 160, -75, 0); pick = await findClickable(t); } // 近づけて再試行
    rec.pick = pick;
    if (!pick.x) {
      const base = await ev(`JSON.stringify(window.__mission37dQA.project(${t.x}, ${t.z}, ${t.h * 0.5}))`).then(JSON.parse);
      if (base) rec.drillAtRepPoint = await ev(`JSON.stringify(window.__mission37dQA.drillIds(${base.x}, ${base.y}))`).then(JSON.parse);
      rec.note = 'scene.pick が目的の建物を返す画面点を見つけられなかった（別の建物/地面に遮られた可能性）';
      rec.ms = Date.now() - t0; continue;
    }
    await click(pick.x, pick.y);
    await sleep(300);
    rec.selectedAfterClick = await selected();
    rec.realClick = rec.selectedAfterClick === t.id;
    if (!rec.realClick) { rec.note = '実クリック後に選ばれたのは別の建物'; rec.ms = Date.now() - t0; continue; }
    rec.photo = await waitPhoto();
    const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    rec.screenshot = `${OUT_DIR}/photo-${t.id.slice(5, 13)}.jpg`;
    fs.writeFileSync(rec.screenshot, Buffer.from(data, 'base64'));
    rec.ms = Date.now() - t0;
  }

  // 連続クリック / 解除: 写真あり(阪和病院) ⇄ 写真なし(隣接する別建物 0afb16c0。36L 索引に無い) を高速に切り替え、前の写真が残らないことを見る
  const A = TARGETS.find((t) => t.name === '阪和病院');
  const B = { id: 'bldg_0afb16c0-8d43-4607-a55f-36d786ec6a6b' };
  [B.h, , B.x, B.z] = attrs[B.id];
  if (A) {
    const seq = { steps: [], noPhotoBuilding: B.id };
    out.sequence = seq;
    await settle((A.x + B.x) / 2, (A.z + B.z) / 2, 10, 420, -60, 0);
    const pa = await findClickable(A), pb = await findClickable(B);
    seq.clickable = { A: !!pa.x, B: !!pb.x };
    if (pa.x && pb.x) {
      for (const [lbl, p] of [['A', pa], ['B', pb], ['A', pa], ['B', pb]]) {
        await click(p.x, p.y);
        seq.steps.push({ lbl, selected: await selected() });
        await sleep(120);
      }
      const s = await waitPhoto();
      seq.finalSelected = await selected();
      seq.finalIsB = seq.finalSelected === B.id;
      seq.finalNoStalePhoto = seq.finalIsB && !s.img; // B(写真なし)が最後に選ばれたのに A の画像が残っていないこと
      seq.finalSlotText = s.slotText;
      // 解除: 建物でない点（キャンバス左上寄り）をクリック
      const r = await ev('JSON.stringify(document.getElementById("cesiumContainer").getBoundingClientRect())').then(JSON.parse);
      let ex = null;
      for (let yy = 4; yy < 400 && !ex; yy += 12) for (let xx = 20; xx < 1400 && !ex; xx += 90) {
        if ((await ev(`window.__mission37dQA.pickId(${r.left + xx}, ${r.top + yy})`)) === null && !(await ev(`window.__mission37dQA.drillIds(${r.left + xx}, ${r.top + yy}).length`))) ex = [r.left + xx, r.top + yy];
      }
      seq.deselectPoint = ex;
      if (ex) await click(ex[0], ex[1]);
      await sleep(800);
      const after = await photoState();
      seq.afterDeselect = { selected: await selected(), imgPresent: !!after.img, slotText: after.slotText };
      seq.deselectPhotoCleared = seq.afterDeselect.selected === null ? !after.img : null; // 解除できなかった場合は判定不能(null)
    }
  }
} finally {
  try { await b.close(); } catch { /* noop */ }
}

const verdict = (t) => {
  const p = t.photo;
  if (!t.pick || !t.pick.x) return 'not-clickable';
  if (!t.realClick) return 'not-clicked';
  if (!p || !p.img) return 'index-only-no-image';
  if (p.img.src !== t.expect.thumb) return 'wrong-image';
  if (!p.img.complete || p.img.naturalWidth === 0) return 'index-only-image-failed';
  if (!(p.img.shownWidth > 0)) return 'image-not-visible';
  const authorOk = (t.expect.author && !/^own work$/i.test(t.expect.author)) ? (p.caption || '').includes(t.expect.author) : /作者:/.test(p.caption || '');
  const licenseOk = (p.caption || '').includes(t.expect.license);
  const sourceOk = p.links.some((l) => l.href === t.expect.source || /commons\.wikimedia\.org/.test(l.href));
  return authorOk && licenseOk && sourceOk ? 'displayed' : 'image-without-attribution';
};
for (const t of out.targets) t.verdict = verdict(t);
out.summary = {
  googleRequestCount: out.googleRequests.length,
  jsErrors: out.jsErrors.length,
  verdicts: Object.fromEntries(out.targets.map((t) => [t.name, t.verdict])),
  displayed: out.targets.filter((t) => t.verdict === 'displayed').length,
  total: out.targets.length,
  totalMs: Date.now() - T0,
};
fs.writeFileSync(path.join(OUT_DIR, 'photo-display-qa.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
if (out.sequence) console.log('sequence:', JSON.stringify({ finalIsB: out.sequence.finalIsB, finalNoStalePhoto: out.sequence.finalNoStalePhoto, deselectPhotoCleared: out.sequence.deselectPhotoCleared, clickable: out.sequence.clickable }));
if (out.jsErrors.length) console.log('jsErrors:', JSON.stringify(out.jsErrors.slice(0, 5), null, 1));
