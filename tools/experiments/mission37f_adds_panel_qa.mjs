// tools/experiments/mission37f_adds_panel_qa.mjs
// [Mission 37F-4] photo-review.json の adds（承認済み新規写真）が、実ページの renderPhoto で写真パネルに出ることを実 Chrome で確認する。
//   ※ 対象建物は 9 tile 外のため 3D 実クリックはできない。QA フック renderPhotoOnly で「写真パネルの描画だけ」を実コードで行う（実クリックではない）。
//   Before = adds を無効にした同じ建物の先頭写真（索引＋検証済み日付）、After = 実ページが描いた <img>。
//   合格: img が complete・naturalWidth>0・表示幅>0、src が adds の thumbnailUrl と一致、作者/ライセンス/Commons リンク/撮影日が DOM にある。Google 通信 0・JS 例外 0。
import fs from 'node:fs';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = (process.env.MISSION37E_URL || 'http://localhost:8137/mission37d-sumiyoshi-mvp.html') + '?qa=1';
const OUT_DIR = 'data/reports/mission37f-adds';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const D = 'public/map-data/osaka-city/derived/';
const review = JSON.parse(fs.readFileSync(D + 'photo-review.json', 'utf8'));
const index = JSON.parse(fs.readFileSync(D + 'building-photo-index.json', 'utf8')).byCanonicalId;
const dates = JSON.parse(fs.readFileSync(D + 'photo-dates.json', 'utf8')).dates;

const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
const out = { mission: '37F-4', kind: 'adds-panel-render (not a real 3D click)', url: URL_, browser: b.version, generatedAt: new Date().toISOString(), googleRequests: [], jsErrors: [], items: [] };
page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE.test(new URL(e.request.url).hostname)) out.googleRequests.push(e.request.url); } catch { /* noop */ } });
const ev = (js) => page.evaluate(js);
try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    if ((await ev("!!(window.__mission37d && window.__mission37dQA && window.__mission37dQA.renderPhotoOnly)").catch(() => false)) === true) break;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const a of review.adds) {
    const id = a.canonicalId.replace(/^cg_bldg_/, '');
    const e = index[a.canonicalId];
    const first = e.photos.find((p) => /^https:/.test(p.thumbnailUrl) && p.license && !review.holds.some((h) => h.file === decodeURIComponent((p.sourcePageUrl.match(/File:([^?#]+)$/) || [])[1] || '')));
    const beforeFile = first ? decodeURIComponent(first.sourcePageUrl.match(/File:([^?#]+)$/)[1]) : null;
    const rec = { canonicalId: a.canonicalId, name: e.buildingName, before: { file: beforeFile, takenAt: (dates[beforeFile] && dates[beforeFile].verified && dates[beforeFile].takenAt) || null }, expectAfter: { file: a.photo.title, takenAt: a.takenAt, thumb: a.photo.thumbnailUrl }, realClick: false };
    out.items.push(rec);
    await ev(`window.__mission37dQA.renderPhotoOnly(${JSON.stringify(id)})`);
    let s = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      s = JSON.parse(await ev(`(() => { const slot = document.getElementById('lc-photo-slot'), img = slot.querySelector('img'), cap = slot.querySelector('.cap');
        const t = slot.querySelector('[data-photo-taken]');
        return JSON.stringify({ slotText: slot.textContent.slice(0, 240), img: img ? { src: img.src, complete: img.complete, naturalWidth: img.naturalWidth, shownWidth: Math.round(img.getBoundingClientRect().width) } : null,
          caption: cap ? cap.textContent : null, taken: t ? t.getAttribute('data-photo-taken') : null, links: [...slot.querySelectorAll('a')].map((x) => x.href) }); })()`));
      if (s.img && s.img.complete) break;
    }
    rec.after = s;
    rec.displayed = !!(s.img && s.img.complete && s.img.naturalWidth > 0 && s.img.shownWidth > 0 && s.img.src === a.photo.thumbnailUrl
      && s.caption && s.caption.includes(a.photo.author) && s.caption.includes(a.photo.license) && s.links.includes(a.photo.sourcePageUrl) && s.taken === a.takenAt);
    // パネルを画面に出して撮影
    await ev("(() => { const el = document.getElementById('lc-photo-slot'); el.scrollIntoView({ block: 'center' }); })()");
    const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    rec.screenshot = `${OUT_DIR}/adds-${a.canonicalId.slice(-8)}.jpg`;
    fs.writeFileSync(rec.screenshot, Buffer.from(data, 'base64'));
    console.log(rec.name, rec.displayed ? 'displayed' : 'NOT displayed', JSON.stringify(s.img));
  }
} finally {
  out.allDisplayed = out.items.length > 0 && out.items.every((i) => i.displayed);
  out.googleRequestCount = out.googleRequests.length;
  fs.writeFileSync(`${OUT_DIR}/adds-panel-qa.json`, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ allDisplayed: out.allDisplayed, googleRequestCount: out.googleRequestCount, jsErrors: out.jsErrors.length }));
  await b.close();
}
