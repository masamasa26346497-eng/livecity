// tools/experiments/mission37e_billing_guard_qa.mjs
// [Mission 37E] 実ブラウザで Mission 37D ページを開き、
//   1. Google のどのホストにも 1 本もリクエストが出ないこと（課金対象 0 件の証拠）
//   2. VERIFIED 建物を選ぶと照合済み表示になり、Place ID が保持されること
//   3. 未照合建物では Place ID が残らないこと（他建物の写真が出ない）
//   4. 連続選択で古い結果が勝たないこと
//   5. 既存の Wikimedia 写真スロットが壊れていないこと
//   を確かめる。全リクエスト URL を記録して報告する。
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/cdp-browser.js';

const URL_ = process.env.MISSION37E_URL || 'http://localhost:8137/mission37d-sumiyoshi-mvp.html';
const OUT_DIR = 'data/reports/mission37e-places-ui-kit';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 課金の恐れがあるホスト。1 本でも出たら失格。
const GOOGLE_HOSTS = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;

// 実データから VERIFIED / 非 VERIFIED の canonicalId を取る
const index = JSON.parse(fs.readFileSync('public/mission37d-data/verified-google-place-ids.json', 'utf-8')).byBuildingId;
const idsDir = 'public/mission37b-3dtiles/osaka-sumiyoshi-9tile/ids';
const verified = [];
for (const f of fs.readdirSync(idsDir).filter((x) => x.startsWith('t_'))) {
  for (const id of JSON.parse(fs.readFileSync(path.join(idsDir, f), 'utf-8'))) {
    if (index['cg_bldg_' + id]) verified.push({ canonicalId: id, placeId: index['cg_bldg_' + id] });
    if (verified.length >= 3) break;
  }
  if (verified.length >= 3) break;
}

const b = await launchBrowser({ width: 1500, height: 940 });
const page = b.page;
const out = {
  mission: '37E', url: URL_, browser: b.version, generatedAt: new Date().toISOString(),
  requests: [], googleRequests: [], jsErrors: [], steps: {},
  verifiedSamples: verified,
};
page.on('Runtime.exceptionThrown', (e) => {
  try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ }
});
page.on('Network.requestWillBeSent', (e) => {
  try {
    const u = e.request.url;
    out.requests.push(u);
    const host = new URL(u).hostname;
    if (GOOGLE_HOSTS.test(host)) out.googleRequests.push(u);
  } catch { /* data: URL 等 */ }
});

const panelState = `(() => {
  const el = document.getElementById('lc-google-place-staging');
  const photo = document.getElementById('lc-photo-slot');
  return JSON.stringify({
    text: el ? el.textContent : null,
    placeId: el ? (el.dataset.googlePlaceId || null) : null,
    photoSlotText: photo ? photo.textContent.slice(0, 60) : null,
    kitEnabled: window.LiveCityPlacesUiKit37E ? window.LiveCityPlacesUiKit37E.ENABLED : null,
    kitPresent: !!window.LiveCityPlacesUiKit37E,
    panelWired: !!(window.__mission37dGooglePlacesStaging && window.__mission37dGooglePlacesStaging.panel()),
  });
})()`;
const pick = (id) => page.evaluate(
  `(() => { window.dispatchEvent(new CustomEvent('livecity:37d-building-selected', { detail: { canonicalId: ${JSON.stringify(id)} } })); return 1; })()`);

try {
  await page.send('Network.enable');
  await page.send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const ready = await page.evaluate('!!(window.LiveCityPlacesUiKit37E && window.__mission37dGooglePlacesStaging)').catch(() => false);
    if (ready === true) break;
  }
  await sleep(3000);
  out.steps.initial = JSON.parse(await page.evaluate(panelState));

  // VERIFIED 建物
  await pick(verified[0].canonicalId);
  await sleep(2500);
  out.steps.verified = JSON.parse(await page.evaluate(panelState));

  // 未照合建物（直後に Place ID が残っていないこと）
  await pick('bldg_00000000-0000-0000-0000-000000000000');
  await sleep(2000);
  out.steps.unmatched = JSON.parse(await page.evaluate(panelState));

  // 連続選択（古い結果が勝たないこと）
  await pick(verified[0].canonicalId);
  await pick(verified[1].canonicalId);
  await sleep(2500);
  out.steps.rapid = JSON.parse(await page.evaluate(panelState));

  // 選択解除
  await pick(null);
  await sleep(1200);
  out.steps.cleared = JSON.parse(await page.evaluate(panelState));

  // 要素生成が本当に止まるか（課金境界）
  out.steps.createBlocked = JSON.parse(await page.evaluate(`(() => {
    try {
      window.LiveCityPlacesUiKit37E.createPlaceDetailsElement(document, ${JSON.stringify(verified[0].placeId)});
      return JSON.stringify({ threw: false });
    } catch (e) { return JSON.stringify({ threw: true, code: e.code, blockers: (e.blockers || []).length }); }
  })()`));
  out.steps.gmpElementsInDom = await page.evaluate(
    "document.querySelectorAll('gmp-place-details, gmp-place-details-compact, gmp-place-media').length");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.writeFileSync(path.join(OUT_DIR, 'panel.jpg'), Buffer.from(data, 'base64'));
} finally {
  try { await b.close(); } catch { /* noop */ }
}

const hosts = [...new Set(out.requests.map((u) => { try { return new URL(u).hostname; } catch { return 'data:'; } }))].sort();
out.summary = {
  totalRequests: out.requests.length,
  distinctHosts: hosts,
  googleRequestCount: out.googleRequests.length,
  billableRequestsZero: out.googleRequests.length === 0,
  jsErrors: out.jsErrors.length,
  kitPresent: out.steps.initial?.kitPresent,
  kitEnabled: out.steps.initial?.kitEnabled,
  panelWired: out.steps.initial?.panelWired,
  verifiedShowsMatch: /照合済み/.test(out.steps.verified?.text || '') && out.steps.verified?.placeId === verified[0].placeId,
  unmatchedClearsPlaceId: out.steps.unmatched?.placeId === null && /対応データなし/.test(out.steps.unmatched?.text || ''),
  rapidKeepsLatest: out.steps.rapid?.placeId === verified[1].placeId,
  clearedEmpty: out.steps.cleared?.placeId === null,
  createPlaceDetailsBlocked: out.steps.createBlocked?.threw === true && out.steps.createBlocked?.code === 'E_BILLING_LOCKED',
  noGmpElementsInDom: out.steps.gmpElementsInDom === 0,
  wikimediaSlotIntact: typeof out.steps.initial?.photoSlotText === 'string' && out.steps.initial.photoSlotText.length > 0,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'billing-guard-qa.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
if (out.googleRequests.length) console.log('GOOGLE REQUESTS:', JSON.stringify(out.googleRequests, null, 1));
if (out.jsErrors.length) console.log('jsErrors:', JSON.stringify(out.jsErrors.slice(0, 5), null, 1));
console.log('out', OUT_DIR);
