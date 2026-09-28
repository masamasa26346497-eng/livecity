// tools/experiments/mission36a_photo_display_qa.mjs
// [Mission 36A 追加要件 §10/§11] 写真が crop されず・歪まず・はみ出さないことを実機で測る。
//   縦長 / 横長 / 正方形 / 超横長 の実例を索引から選び、hover カードへ実際に描いて
//   「表示サイズと元画像の縦横比が一致しているか」を測る（見た目の印象ではなく数値で）。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION36A_URL || 'http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html';
const OUT_DIR = 'data/reports/mission36a-footprint-photo-matching';
const INDEX = 'public/map-data/osaka-city/derived/building-photo-index.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const idx = JSON.parse(fs.readFileSync(INDEX, 'utf-8'));

/** §11 実機確認対象。索引に入っていれば使う。 */
const WANT_NAMES = ['あべのハルカス', '通天閣', 'グランフロント大阪', 'グラングリーン大阪',
  '大阪中之島美術館', 'なんばパークス'];

/** 索引から縦横比のばらつく標本を選ぶ（§10 縦長/横長/正方形/超横長/超縦長）。 */
function pickSamples() {
  const withSize = [];
  for (const r of idx.records) {
    if (!r.photos || !r.photos.length) continue;
    const p = r.photos[0];
    if (!p.width || !p.height) continue;
    withSize.push({ r, p, ratio: p.width / p.height });
  }
  const byBand = { panorama: [], landscape: [], square: [], portrait: [], tall: [] };
  for (const x of withSize) {
    const r = x.ratio;
    if (r >= 2.4) byBand.panorama.push(x);
    else if (r >= 1.15) byBand.landscape.push(x);
    else if (r > 0.87) byBand.square.push(x);
    else if (r > 0.6) byBand.portrait.push(x);
    else byBand.tall.push(x);
  }
  const out = [];
  for (const [band, list] of Object.entries(byBand)) {
    for (const x of list.slice(0, 2)) out.push({ band, ...x });
  }
  // §11 名指しの建物も足す
  for (const name of WANT_NAMES) {
    const hit = withSize.find((x) => (x.r.wikidataLabel || x.r.curatedName || '').includes(name));
    if (hit) out.push({ band: 'named:' + name, ...hit });
  }
  return out;
}

/** hover カードへ直接 1 枚描いて、表示サイズを測る。 */
const RENDER = (url, title) => `new Promise((res) => {
  const c = document.getElementById('bldg-photo-card');
  c.innerHTML = '<div class="bp-title">' + ${JSON.stringify(title)} + '</div>'
    + '<div class="bp-figure"><img class="bp-img" src="' + ${JSON.stringify(url)} + '"></div>'
    + '<div class="bp-meta"><span class="bp-src">Wikimedia Commons</span><span class="bp-lic">CC</span></div>'
    + '<div class="bp-by">author</div><div class="bp-hint">クリックで詳細</div>';
  c.style.display = 'block';
  const img = c.querySelector('.bp-img');
  const fig = c.querySelector('.bp-figure');
  const done = () => {
    const r = img.naturalWidth / img.naturalHeight;
    const k = (r >= 2.4) ? 'is-panorama' : (r >= 1.15) ? 'is-landscape'
      : (r <= 0.87) ? 'is-portrait' : 'is-square';
    fig.className = 'bp-figure ' + k;
    // class を当ててからレイアウトを測る
    requestAnimationFrame(() => {
      const ib = img.getBoundingClientRect();
      const cb = c.getBoundingClientRect();
      const st = getComputedStyle(img);
      const lic = c.querySelector('.bp-lic');
      const lb = lic ? lic.getBoundingClientRect() : null;
      res(JSON.stringify({
        licenseVisible: !!(lb && lb.width > 0 && lb.height > 0
          && lb.bottom <= innerHeight + 0.5 && lb.top >= -0.5
          && lb.bottom <= cb.bottom + 0.5),
        cardFitsViewport: cb.bottom <= innerHeight + 0.5 && cb.top >= -0.5,
        natural: [img.naturalWidth, img.naturalHeight],
        naturalRatio: +r.toFixed(4),
        shown: [+ib.width.toFixed(1), +ib.height.toFixed(1)],
        shownRatio: +(ib.width / ib.height).toFixed(4),
        objectFit: st.objectFit,
        cardW: +cb.width.toFixed(1), cardH: +cb.height.toFixed(1),
        overflowsCard: (ib.width > cb.width + 1) || (ib.right > cb.right + 1) || (ib.bottom > cb.bottom + 1),
        orientationClass: k,
      }));
    });
  };
  if (img.complete && img.naturalWidth) done();
  else { img.addEventListener('load', done, { once: true });
         img.addEventListener('error', () => res(JSON.stringify({ error: 'load failed' })), { once: true }); }
})`;

const b = await launchBrowser({ width: 1440, height: 900 });
const page = b.page;
const out = { url: URL_, generatedAt: new Date().toISOString(), mission: '36A', samples: [], jsErrors: [] };
page.on && page.on('Runtime.exceptionThrown', (e) => {
  try { out.jsErrors.push(String(e.exceptionDetails && e.exceptionDetails.text)); } catch { /* noop */ }
});
try {
  await page.send('Runtime.enable').catch(() => {});
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const ok = await page.evaluate("(!!document.getElementById('bldg-photo-card') && typeof CanonicalRuntime !== 'undefined')",
      { timeoutMs: 30000 }).catch(() => false);
    if (ok === true || ok === 'true') break;
  }
  await sleep(4000);
  await page.evaluate(`(() => { for (const el of document.querySelectorAll('div,button,select')) {
    const id = el.id || '';
    if (/road-v2|ward-diag|canonical-runtime|perf-hud|^fps$|^pl$|^pr$|gsi-|hybrid-|visual-|lod-|max-lod|inferred-|landmark-hd|coverage-qa|missing-recovery|mission35s-focus|town-click|debug|dev-/.test(id)) el.style.display = 'none'; }
    return 1; })()`);

  const samples = pickSamples();
  console.log('[36A-display] 標本 ' + samples.length + ' 件');
  let shotN = 0;
  for (const s of samples) {
    const url = s.p.thumbnailUrl || s.p.imageUrl;
    const title = s.r.wikidataLabel || s.r.curatedName || '(no name)';
    let m;
    try { m = JSON.parse(await page.evaluate(RENDER(url, title), { timeoutMs: 60000, awaitPromise: true })); }
    catch (e) { m = { error: String(e.message).slice(0, 80) }; }
    // 元の縦横比が保たれているか（歪んでいないか）
    const distorted = (m.naturalRatio && m.shownRatio)
      ? Math.abs(m.shownRatio - m.naturalRatio) / m.naturalRatio > 0.02 : null;
    out.samples.push({ band: s.band, title, photoTitle: s.p.title, ...m, distorted });
    if (!m.error) {
      // band が重なると上書きされてしまうので連番を付ける（縦長・超縦長も必ず残す）
      const nm = 'display-' + String(++shotN).padStart(2, '0') + '-'
        + s.band.replace(/[^\w-]/g, '_') + '-' + (m.orientationClass || 'x');
      const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, nm + '.jpg'), Buffer.from(data, 'base64'));
      m.shot = nm + '.jpg';
    }
    console.log('  ' + s.band.padEnd(22), (m.natural || []).join('x').padEnd(11),
      'ratio ' + String(m.naturalRatio).padEnd(7) + '→' + String(m.shownRatio).padEnd(7),
      'fit=' + m.objectFit, 'overflow=' + m.overflowsCard, 'distorted=' + distorted);
  }
} finally { try { await b.close(); } catch { /* noop */ } }

const ok = out.samples.filter((s) => !s.error);
out.summary = {
  samples: out.samples.length,
  measured: ok.length,
  allContain: ok.length > 0 && ok.every((s) => s.objectFit === 'contain'),
  noneDistorted: ok.length > 0 && ok.every((s) => s.distorted === false),
  noneOverflow: ok.length > 0 && ok.every((s) => s.overflowsCard === false),
  licenseAlwaysVisible: ok.length > 0 && ok.every((s) => s.licenseVisible === true),
  cardAlwaysFitsViewport: ok.length > 0 && ok.every((s) => s.cardFitsViewport === true),
  orientations: ok.reduce((a, s) => { a[s.orientationClass] = (a[s.orientationClass] || 0) + 1; return a; }, {}),
  bands: [...new Set(out.samples.map((s) => s.band))],
  loadFailures: out.samples.filter((s) => s.error).length,
  jsErrors: out.jsErrors.length,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'display-qa.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log('[36A-display] out', OUT_DIR);
