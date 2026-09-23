#!/usr/bin/env node
// tools/audit/production-ui-visibility.js
// [Mission 32U §16/§17] production HTML で「開発用 QA UI が 1 つも見えない」「通常 UI は出ている」を網羅確認する。
//   HTML 内で id を振っている要素を静的に列挙し、実ブラウザで getComputedStyle / 位置を見て分類する。
//   前提: `npm run preview`。出力: data/reports/production-ui-visibility.json（+ screenshot）
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_PROD_URL || 'http://localhost:8000/osaka_3d_buildings.html';
const PROD = P('public', 'osaka_3d_buildings.html');
const OUT = P('data', 'reports', 'production-ui-visibility.json');
const SHOT = P('data', 'reports', 'production-cutover-qa', 'ui-visibility.jpg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// §16 で「通常ユーザーから見えないこと」と指定された開発用 UI
export const DEV_UI_ID_PATTERNS = [
  /^canonical-runtime-/, /^buildings-version-/, /^road-v2-mode-/, /^display-preset-/, /^camera-mode-/,
  /^map-audit-/, /^umeda-poc-/, /^umeda-block-qa/, /^hybrid-sample-/, /^reference-alignment-/,
  /^gsi-/, /^land-block-qa/, /^visible-align-qa/, /^reality-qa/, /^ground-fp-qa/, /^scale-ruler/,
  /^residual-detail/, /^building-alignment-toggle$/, /^top-down-alignment-toggle$/, /^visual-buildings-toggle$/,
  /^ward-diag$/, /^perf-hud$/, /^fps$/,
];
// §17 で残すと指定された通常 UI
export const USER_UI_IDS = [
  'search-box', 'search-input', 'prop-card', 'facility-card', 'tip', 'controls', 'visual-panel', 'vp-toggle',
  'compass', 'layer-toggle-panel', 'ward-selector-panel', 'ward-current-area-label',
];

/** HTML（markup の id=".." と JS の .id = '..'）から id を集める */
export function collectIds(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\sid="([a-zA-Z][\w-]*)"/g)) ids.add(m[1]);
  for (const m of html.matchAll(/\.id = '([a-zA-Z][\w-]*)'/g)) ids.add(m[1]);
  return [...ids].sort();
}
export const isDevUiId = (id) => DEV_UI_ID_PATTERNS.some((re) => re.test(id));

async function main() {
  const html = fs.readFileSync(PROD, 'utf-8');
  const ids = collectIds(html);
  const devIds = ids.filter(isDevUiId);
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 200)));
  let report;
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(35000);
    const probe = (list) => `(() => {
      const out = {};
      for (const id of ${JSON.stringify(list)}) {
        const el = document.getElementById(id);
        if (!el) { out[id] = 'absent'; continue; }
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const hidden = s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0 || (r.width === 0 && r.height === 0);
        out[id] = hidden ? 'hidden' : 'visible';
      }
      return out;
    })()`;
    const dev = await page.evaluate(probe(devIds));
    const user = await page.evaluate(probe(USER_UI_IDS));
    // 画面に実際に出ている固定 overlay をすべて列挙し、開発用が混ざっていないかも見る
    const overlays = await page.evaluate(`(() => {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const s = getComputedStyle(el);
        if (s.position !== 'fixed' && s.position !== 'absolute') continue;
        if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        if (el.parentElement && el.parentElement.closest('[id]') && getComputedStyle(el.parentElement).position !== 'static') continue;
        out.push({ id: el.id || null, cls: el.className && String(el.className).slice(0, 40), rect: [r.left, r.top, r.width, r.height].map(Math.round), text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 60) });
      }
      return out.slice(0, 60);
    })()`);
    const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(data, 'base64'));
    const visibleDev = Object.entries(dev).filter(([, v]) => v === 'visible').map(([k]) => k);
    const missingUser = Object.entries(user).filter(([, v]) => v === 'absent').map(([k]) => k);
    report = {
      version: 1, generatedAt: new Date().toISOString(), missionId: '32U', url: URL_,
      buildProfile: await page.evaluate(`document.documentElement.getAttribute('data-livecity-build')`),
      devUiIdCount: devIds.length, devUi: dev, visibleDevUi: visibleDev,
      userUi: user, missingUserUi: missingUser,
      visibleOverlays: overlays,
      consoleErrors: errors.slice(0, 10),
      shot: 'data/reports/production-cutover-qa/ui-visibility.jpg',
    };
  } finally { await b.close(); }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  main().then((r) => {
    console.log('[ui-vis] profile', r.buildProfile, 'devIds', r.devUiIdCount, 'visibleDev', JSON.stringify(r.visibleDevUi));
    console.log('[ui-vis] missingUser', JSON.stringify(r.missingUserUi));
    console.log('[ui-vis] overlays', JSON.stringify(r.visibleOverlays.map((o) => o.id || o.cls)));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
