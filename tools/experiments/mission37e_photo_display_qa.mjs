// tools/experiments/mission37e_photo_display_qa.mjs
// [Mission 37E] 実ブラウザで「建物クリック → Wikimedia 写真が画面に実際に出る」ことを確かめる。
//   索引が成功しただけでは合格にしない。<img> の complete / naturalWidth と、作者・ライセンス・出典 DOM を見る。
//   手順: 施設名で検索してカメラを寄せ → 画面上を格子状に実クリック(CDP Input) → 目的の canonicalId が選ばれるまで繰り返す。
//   Google への通信は 0 件であること、JS 例外 0 件も同時に確認する。無課金（Wikimedia の公開画像のみ）。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION37E_URL || 'http://localhost:8137/mission37d-sumiyoshi-mvp.html';
const OUT_DIR = 'data/reports/mission37e-places-ui-kit';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE_HOSTS = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;

// 9 tile 内で写真が表示条件を満たす建物（tools/mission37d-verify-photo-join.cjs の結果）
const TARGETS = [
  { name: '阪和病院', id: 'bldg_ec74351a-f344-4b61-b2e6-04b660b05aa0' },
  { name: '阪和住吉総合病院', id: 'bldg_ef3be94e-ff1b-4174-acd2-646dd9c4542d' },
  { name: '荘厳浄土寺', id: 'bldg_867c2448-0dcd-4a35-bfa6-3d7b7b93c1d8' },
  { name: '止止呂支比売命神社', id: 'bldg_1a63a520-ada1-45fe-96dd-e45b7c7cbceb' },
  { name: '東福寺', id: 'bldg_43fb9581-ca25-402e-a552-2953d62e210a' },
];

const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
const out = { mission: '37E', kind: 'photo-display', url: URL_, browser: b.version, generatedAt: new Date().toISOString(), googleRequests: [], imageRequests: [], jsErrors: [], targets: [] };
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
const selected = () => page.evaluate('(window.__mission37d && window.__mission37d.selectedCanonicalId) || null');
const photoState = () => page.evaluate(`(() => {
  const slot = document.getElementById('lc-photo-slot');
  const img = slot.querySelector('img');
  const cap = slot.querySelector('.cap');
  return JSON.stringify({
    slotText: slot.textContent.slice(0, 200),
    ariaBusy: slot.getAttribute('aria-busy'),
    img: img ? { src: img.src, complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, alt: img.alt } : null,
    caption: cap ? cap.textContent : null,
    links: [...slot.querySelectorAll('a')].map((a) => ({ text: a.textContent, href: a.href })),
  });
})()`).then(JSON.parse);

try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const ok = await page.evaluate("!!(window.__mission37d && document.getElementById('lc-loading') && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false);
    if (ok === true) break;
  }
  await sleep(3000);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const t of TARGETS) {
    const rec = { ...t, searchHits: null, clicked: false, clicks: 0, photo: null };
    out.targets.push(rec);
    console.log('target:', t.name);
    // 検索 → flyTo
    await page.evaluate(`(() => { const q = document.getElementById('lc-q'); q.value = ${JSON.stringify(t.name)}; q.dispatchEvent(new Event('input')); return 1; })()`);
    await sleep(1500);
    rec.searchHits = await page.evaluate("document.querySelectorAll('#lc-results button').length");
    if (!rec.searchHits) { rec.note = '検索で施設が見つからず、カメラを寄せられなかった'; continue; }
    await page.evaluate("document.querySelector('#lc-results button').click()");
    await sleep(4500);
    // 画面中央から外側へ格子状にクリック
    const cx = 750, cy = 470;
    const pts = [];
    for (let r = 0; r <= 8; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) pts.push([cx + dx * 18, cy + dy * 18]);
    for (const [x, y] of pts) {
      await click(x, y);
      rec.clicks++;
      await sleep(120);
      if ((await selected()) === t.id) { rec.clicked = true; break; }
    }
    if (!rec.clicked) { rec.note = '目的の建物を実クリックで選べなかった（格子 ±144px 内）'; rec.lastSelected = await selected(); continue; }
    // 画像の実表示を待つ
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      rec.photo = await photoState();
      if (rec.photo.img && rec.photo.img.complete) break;
      if (!rec.photo.img && !/確認中/.test(rec.photo.slotText)) break;
    }
    const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    fs.writeFileSync(path.join(OUT_DIR, `photo-${t.id.slice(5, 13)}.jpg`), Buffer.from(data, 'base64'));
  }
} finally {
  try { await b.close(); } catch { /* noop */ }
}

const verdict = (t) => {
  const p = t.photo;
  if (!t.clicked) return 'not-clicked';
  if (!p || !p.img) return 'index-only-no-image';
  if (!p.img.complete || p.img.naturalWidth === 0) return 'index-only-image-failed';
  const hasAuthor = /作者:/.test(p.caption || '');
  const hasLicense = /ライセンス:/.test(p.caption || '');
  const hasSource = p.links.some((l) => /commons\.wikimedia\.org/.test(l.href));
  return hasAuthor && hasLicense && hasSource ? 'displayed' : 'image-without-attribution';
};
for (const t of out.targets) t.verdict = verdict(t);
out.summary = {
  googleRequestCount: out.googleRequests.length,
  jsErrors: out.jsErrors.length,
  verdicts: Object.fromEntries(out.targets.map((t) => [t.name, t.verdict])),
  displayed: out.targets.filter((t) => t.verdict === 'displayed').length,
  total: out.targets.length,
};
fs.writeFileSync(path.join(OUT_DIR, 'photo-display-qa.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
if (out.jsErrors.length) console.log('jsErrors:', JSON.stringify(out.jsErrors.slice(0, 5), null, 1));
