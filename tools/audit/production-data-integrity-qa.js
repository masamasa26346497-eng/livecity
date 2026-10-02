#!/usr/bin/env node
// tools/audit/production-data-integrity-qa.js
// [Mission 32S §12/§13] 実ブラウザ（Edge headless・実 GPU）で property card の表示内容を確認する。
//   - 6 地点（梅田 / 本町 / 難波 / 天王寺 / 住吉 / 東淀川）で建物をクリックし、card の全文に
//     推定階数 / 推定利回り / 想定賃料 / 仮メモ / 「町丁目データなし」/ 徒歩◯分 が出ないことを確認
//   - 出ている項目（用途・高さ・底面積・区・最寄駅・ID）が canonical の実データと一致することを確認
//   - 高さの実測タグが無い OSM fallback 建物（heightUnknown）では高さ行ごと消えることを確認
//   前提: `npm run preview`（http://localhost:8000）。出力: data/reports/production-data-integrity-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';
import { readFileRetry } from '../lib/synced-dir-writer.js';
import { PROBE } from './legacy-residual-probe.js';
import { CARD_SITES } from './pre-production-cleanup-qa.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const OUT = P('data', 'reports', 'production-data-integrity-qa.json');
const SHOTS = P('data', 'reports', 'production-data-integrity-qa');
const BUILDINGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2');
const rj = (p) => JSON.parse(readFileRetry(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// card に出てはいけない文言（§2/§4/§5/§6/§7/§10）
export const FORBIDDEN_CARD_TEXT = [
  // 階数は PLATEAU bldg:storeysAboveGround の実値だけを出すようにしたので「推定階数」だけを禁止する
  { id: 'estimated-floors', re: /推定階数/ },
  { id: 'yield', re: /推定利回り|利回り/ },
  { id: 'rent', re: /想定賃料|賃料|\/\s*月/ },
  { id: 'memo', re: /日当たり|閑静|再開発|人通り|幹線道路沿い|管理状態/ },
  { id: 'disclaimer', re: /仮の参考値|自動算出/ },
  { id: 'town-no-data', re: /町丁目データなし|データなし/ },
  { id: 'walk-time', re: /徒歩/ },
  { id: 'estimate-label', re: /推定(?!値)/ },
];

/** 各地点の対象建物: 中心に近い PLATEAU 建物と、（あれば）heightUnknown の OSM fallback 建物 */
function targets() {
  const out = [];
  for (const s of CARD_SITES) {
    let plateau = null, osmUnknown = null;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const f = path.join(BUILDINGS, `tile_${Math.floor(s.x / 500) + dx}_${Math.floor(s.z / 500) + dz}.json`);
      if (!fs.existsSync(f)) continue;
      const t = rj(f); const a = rj(path.join(BUILDINGS, 'attributes', path.basename(f))).attributes;
      for (const ft of t.features) {
        const at = a[ft.canonicalId];
        const d = Math.hypot(ft.centroid[0] - s.x, ft.centroid[1] - s.z);
        const rec = { id: ft.canonicalId, c: ft.centroid, areaM2: ft.areaM2, d, attr: { source: at.source, usageLabel: at.usageLabel, usage: at.usage ?? null, heightM: at.heightM, heightSource: at.heightSource ?? null, heightUnknown: !!at.heightUnknown, wardId: at.wardId ?? null, levels: at.levels ?? null } };
        if (at.source === 'plateau-building' && ft.areaM2 >= 400 && ft.areaM2 <= 4000 && d <= 250) { if (!plateau || d < plateau.d) plateau = rec; }
        if (at.source !== 'plateau-building' && at.heightUnknown && ft.areaM2 >= 150 && d <= 1200) { if (!osmUnknown || d < osmUnknown.d) osmUnknown = rec; }
      }
    }
    out.push({ site: s.id, siteName: s.name, plateau, osmUnknown });
  }
  return out;
}

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  camera: (x, z, r, ph) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) cancelAnimationFrame(searchAnim); cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${r}; cs.ph = ${ph}; cs.th = 0; camUpd(); return 1; })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  status: `(() => { const el = document.getElementById('canonical-runtime-status'); return el ? el.innerText.split(String.fromCharCode(10)) : null; })()`,
  // hover tooltip「建物属性」の表示内容（§8: 高さ / 底面→頂部 も card と同じ基準で出す）
  tip: `(() => {
    const t = document.getElementById('tip');
    const row = (id) => { const e = document.getElementById(id); return (e && getComputedStyle(e).display !== 'none') ? e.textContent.trim() : null; };
    return { display: t.style.display, usage: row('tr1') , r2: row('tr2'), r3: row('tr3'), text: t.innerText.replace(/\s+/g, ' ').trim(), pick: window.__HOVER_PICK_ID__ || null };
  })()`,
  // card の実際の表示（DOM の可視テキスト + 開発用フック）
  card: `(() => {
    const card = document.getElementById('prop-card');
    // 表示中の要素のテキストだけを集める。値と単位が分かれている（「13」+ span「階」）ので、
    // 子要素だけでなく要素が直接持つ text node も拾う。
    const visibleText = (root) => {
      let s = '';
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType === 3) { s += ' ' + c.textContent.trim(); continue; }
          if (c.nodeType !== 1) continue;
          const st = getComputedStyle(c);
          if (st.display === 'none' || st.visibility === 'hidden') continue;
          walk(c);
        }
      };
      walk(root); return s.replace(/\\s+/g, ' ').trim();
    };
    const dbg = window.__PROPERTY_CARD_DEBUG__ ? window.__PROPERTY_CARD_DEBUG__() : null;
    const pick = window.__LAST_BUILDING_PICK__;
    return {
      pick: pick ? pick.id : null, pickHeight: pick ? pick.h : null, pickHeightUnknown: pick ? !!pick.heightUnknown : null, pickHeightSource: pick ? (pick.heightSource || null) : null,
      cardDisplay: card.style.display, visibleText: visibleText(card), debug: dbg,
      townSectionDisplay: getComputedStyle(document.getElementById('pc-town-section')).display,
      missingElements: ['pc-yield', 'pc-rent', 'pc-memo'].filter((id) => !document.getElementById(id)),
    };
  })()`,
};
async function settle(page, min = 2500, max = 60000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return Date.now() - t0; await sleep(700); }
  return -1;
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 78 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name + '.jpg'), Buffer.from(data, 'base64'));
  return 'data/reports/production-data-integrity-qa/' + name + '.jpg';
}
async function clickAt(page, x, y) {
  await page.evaluate(`(() => { window.__LAST_BUILDING_PICK__ = null; if (typeof closePropCard === 'function' && document.getElementById('prop-card').style.display === 'block') closePropCard(); return 1; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(450);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(900);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 600 });
  await sleep(200);
}

/** 建物を真上から選択して card を読む（近づいても選べない場合は半径を詰めて再試行） */
async function inspect(page, t, tag) {
  const vp = await page.evaluate(`[innerWidth, innerHeight]`);
  await page.evaluate(JS.ward(t.c[0], t.c[1])); await sleep(1200);
  let card = null, tip = null, tipAfter = null;
  for (const r of [260, 140, 80]) {
    await page.evaluate(JS.camera(t.c[0], t.c[1], r, 0.03)); await settle(page, 1500);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(vp[0] / 2), y: Math.round(vp[1] / 2) });
    await sleep(500);
    tip = await page.evaluate(JS.tip);
    // 実使用に近い状態: facts tile が届いたあと（マウスを 1px 動かして再描画させる）
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(vp[0] / 2) + 1, y: Math.round(vp[1] / 2) });
    await sleep(600);
    tipAfter = await page.evaluate(JS.tip);
    await clickAt(page, Math.round(vp[0] / 2), Math.round(vp[1] / 2));
    card = await page.evaluate(JS.card);
    if (card.pick === t.id) break;
  }
  const forbidden = FORBIDDEN_CARD_TEXT.filter((f) => f.re.test(card.visibleText || '')).map((f) => f.id);
  return {
    target: t.id, attr: t.attr, pickedExpected: card.pick === t.id, ...card, tip, tipAfter,
    forbiddenTextHits: forbidden,
    shot: await shot(page, tag),
  };
}

async function main() {
  const T = targets();
  console.log('[di-qa] targets', JSON.stringify(T.map((t) => [t.site, t.plateau && t.plateau.id.slice(-8), t.osmUnknown && t.osmUnknown.id.slice(-8)])));
  const report = { version: 1, generatedAt: new Date().toISOString(), missionId: '32S', url: URL_, forbiddenPatterns: FORBIDDEN_CARD_TEXT.map((f) => ({ id: f.id, re: String(f.re) })), targets: T };
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)));
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(40000);
    report.startup = { status: await page.evaluate(JS.status), residual: (await page.evaluate(PROBE)).selfCheck.total, hasCardDebugHook: await page.evaluate(`typeof window.__PROPERTY_CARD_DEBUG__ === 'function'`) };
    console.log('[di-qa] startup', JSON.stringify(report.startup).slice(0, 260));

    report.sites = [];
    for (const t of T) {
      const r = { site: t.site, siteName: t.siteName, plateau: await inspect(page, t.plateau, `card-${t.site}`) };
      if (t.osmUnknown) r.osmUnknown = await inspect(page, t.osmUnknown, `osm-unknown-height-${t.site}`);
      report.sites.push(r);
      console.log('[di-qa]', t.site, JSON.stringify({ pick: r.plateau.pickedExpected, forbidden: r.plateau.forbiddenTextHits, fields: r.plateau.debug && r.plateau.debug.fields, town: r.plateau.townSectionDisplay, osm: r.osmUnknown && { pick: r.osmUnknown.pickedExpected, heightVisible: r.osmUnknown.debug && r.osmUnknown.debug.heightVisible } }));
    }
    await page.evaluate(`closePropCard()`); await sleep(400);
    report.afterClose = await page.evaluate(`document.getElementById('prop-card').style.display`);
    report.finalResidual = (await page.evaluate(PROBE)).selfCheck.total;
    report.consoleErrors = errors.slice(0, 30);
  } finally {
    await b.close();
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  main().then((r) => {
    console.log('[di-qa] errors', JSON.stringify(r.consoleErrors));
    console.log('[di-qa] out', OUT);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
