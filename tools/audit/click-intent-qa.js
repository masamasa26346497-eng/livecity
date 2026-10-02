#!/usr/bin/env node
// tools/audit/click-intent-qa.js
// [Mission 34C §27] 実ブラウザで本物の mouse event を送って、
//   「クリックしたときだけ property card が開く」ことを数える。
//   各地点で single click / pan / rotate / wheel zoom を 20 回ずつ。
//   前提: `npm run preview`。出力: data/reports/click-intent-qa.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { launchBrowser } from '../lib/cdp-browser.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const URL_ = process.env.LIVECITY_DEV_URL || 'http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html';
const OUT = P('data', 'reports', 'click-intent-qa.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SITES = [
  { id: 'umeda', name: '梅田', x: -2668, z: -10942 },
  { id: 'dojima', name: '堂島', x: -2607, z: -10386 },
  { id: 'honmachi', name: '本町', x: -2073, z: -8693 },
  { id: 'namba', name: '難波', x: -1360, z: -6890 },
  { id: 'shinosaka', name: '新大阪', x: -2110, z: -14380 },
];
export const REPS = 20;                 // §27 各操作 20 回
export const VIEW = { r: 520, ph: (90 - 52) * Math.PI / 180, th: -0.35 };   // near モード（建物クリックが有効な距離）
export const ACCEPT = { singleClickSuccessPct: 95, panFalseOpen: 0, rotateFalseOpen: 0, wheelFalseOpen: 0 };

const JS = {
  ward: (x, z) => `(() => { const wid = WardModeManager.detectWardAt(${x}, ${z}); if (CityModeManager.isActive()) CityModeManager.exit(wid); if (wid) WardModeManager.switchWard(wid); return wid; })()`,
  // 建物をクリックすると selectBuilding が最後に flyTo でその建物へ寄る（既存仕様）。
  //   次の計測へ移る前に視点を必ず元へ戻す（戻さないと事前に調べた座標が建物から外れる）。
  camera: (x, z) => `(() => { if (typeof searchAnim !== 'undefined' && searchAnim) { cancelAnimationFrame(searchAnim); searchAnim = null; }
    cs.tgt.x = ${x}; cs.tgt.z = ${z}; cs.r = ${VIEW.r}; cs.ph = ${VIEW.ph}; cs.th = ${VIEW.th}; camUpd(); return interactionMode(cs.r); })()`,
  settled: `(() => { const p = CanonicalRuntime.getPerf(); return p.tiles.queuedBuild + p.tiles.queuedFetch + p.tiles.inflight; })()`,
  cardOpen: `(() => { const p = document.getElementById('prop-card'); return !!p && p.style.display === 'block'; })()`,
  cardId: `(() => { const e = document.getElementById('pc-id'); return e ? e.textContent : null; })()`,
  closeCard: `(() => { closePropCard(); if (typeof closeFacilityCard === 'function') closeFacilityCard(); return true; })()`,
  facilityOpen: `(() => { const a = document.getElementById('facility-card'); return !!a && a.style.display === 'block'; })()`,
  reset: `(() => { window.__CLICK_INTENT_RESET__(); closePropCard(); return true; })()`,
  debug: `(() => window.__CLICK_INTENT_DEBUG__())()`,
  camState: `(() => ({ x: +cs.tgt.x.toFixed(2), z: +cs.tgt.z.toFixed(2), r: +cs.r.toFixed(2), th: +cs.th.toFixed(4), ph: +cs.ph.toFixed(4) }))()`,
  // 画面上で「建物に当たる」点を探す。pickHit と同じ経路（mouse を動かして raycast）で調べる。
  hitPoints: (n, skip = 0) => `(() => {
    const pts = [];
    const W = innerWidth, H = innerHeight;
    // 画面中央寄りを格子状に走査（UI パネルの下は避ける）
    for (let gy = 0.28; gy <= 0.80 && pts.length < ${n} * 8; gy += 0.018) {
      for (let gx = 0.14; gx <= 0.66 && pts.length < ${n} * 8; gx += 0.018) {
        const x = Math.round(W * gx), y = Math.round(H * gy);
        const h = pickHit({ clientX: x, clientY: y });
        if (!h || !h.d || !h.d.id) continue;
        // §22 施設ラベルは建物より先に判定される（ラベルをクリックしたら施設カード）。
        //   建物クリックの成功率を測るので、ラベルに当たる点は最初から избегается。
        const mx = (x / W) * 2 - 1, my = -(y / H) * 2 + 1;
        if (typeof FacilityLayer !== 'undefined' && FacilityLayer.pickHit && FacilityLayer.pickHit(mx, my, camera)) continue;
        if (typeof LabelLayer !== 'undefined' && LabelLayer.pickHit && LabelLayer.pickHit(mx, my, camera)) continue;
        // 念のため building 側も同じ点で再確認（ラベル判定で camera 行列が動いていないこと）
        pts.push({ x, y, id: h.d.id });
      }
    }
    // 同じ建物ばかりにならないよう id で間引き、skip 件ぶんずらして別の建物を返す
    const seen = new Set(), uniq = [];
    for (const p of pts) { if (seen.has(p.id)) continue; seen.add(p.id); uniq.push(p); }
    const start = uniq.length ? (${skip} % uniq.length) : 0;
    const out = [];
    for (let i = 0; i < uniq.length && out.length < ${n}; i++) out.push(uniq[(start + i) % uniq.length]);
    return out;
  })()`,
};

async function settle(page, min = 2500, max = 90000) {
  const t0 = Date.now(); await sleep(min); let z = 0;
  while (Date.now() - t0 < max) { const q = await page.evaluate(JS.settled); z = q === 0 ? z + 1 : 0; if (z >= 3) return; await sleep(700); }
}
const mouse = (page, type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', {
  type, x, y, button: extra.button || 'left', buttons: extra.buttons != null ? extra.buttons : (type === 'mouseMoved' && extra.dragging ? 1 : (type === 'mousePressed' ? 1 : 0)),
  clickCount: extra.clickCount != null ? extra.clickCount : (type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0),
  ...(extra.deltaX != null ? { deltaX: extra.deltaX, deltaY: extra.deltaY } : {}),
});

// 単発クリック: 同じ座標で押して離す（動かさない）
async function singleClick(page, x, y) {
  await mouse(page, 'mouseMoved', x, y);
  await sleep(40);
  await mouse(page, 'mousePressed', x, y);
  await sleep(45);
  await mouse(page, 'mouseReleased', x, y);
  await sleep(220);
}
// ドラッグ: 押してから段階的に動かして離す（pan / rotate はボタンと距離で決まる）
async function drag(page, x, y, dx, dy, button = 'left') {
  await mouse(page, 'mouseMoved', x, y);
  await sleep(30);
  await mouse(page, 'mousePressed', x, y, { button, buttons: button === 'right' ? 2 : 1 });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await mouse(page, 'mouseMoved', Math.round(x + dx * i / steps), Math.round(y + dy * i / steps), { dragging: true, buttons: button === 'right' ? 2 : 1, button });
    await sleep(16);
  }
  await mouse(page, 'mouseReleased', Math.round(x + dx), Math.round(y + dy), { button, buttons: 0 });
  await sleep(220);
}
async function wheel(page, x, y, deltaY) {
  await mouse(page, 'mouseMoved', x, y);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, buttons: 0 });
  await sleep(200);
}

export async function run() {
  const b = await launchBrowser({ width: 1600, height: 1000 });
  const page = b.page;
  const errors = [];
  page.on('Runtime.exceptionThrown', (e) => errors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 240)));
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34C', url: URL_,
    reps: REPS, accept: ACCEPT, sites: [], errors: [] };
  try {
    await page.send('Page.navigate', { url: URL_ });
    await sleep(42000);
    out.thresholds = (await page.evaluate(JS.debug)).thresholds;

    for (const s of SITES) {
      await page.evaluate(JS.ward(s.x, s.z)); await sleep(2200);
      const mode = await page.evaluate(JS.camera(s.x, s.z));
      await settle(page);
      await sleep(1500);
      const rec = { site: s.id, siteName: s.name, interactionMode: mode,
        singleClick: { attempts: 0, opened: 0, noTarget: 0 },
        pan: { attempts: 0, falseOpen: 0, cameraMoved: 0 },
        rotate: { attempts: 0, falseOpen: 0, cameraMoved: 0 },
        wheelZoom: { attempts: 0, falseOpen: 0, cameraMoved: 0 },
        gestureSamples: [] };

      // ── 1) single click × 20（毎回、同じ視点へ戻してから別の建物を狙う）──
      await page.evaluate(JS.reset);
      const pts = await page.evaluate(JS.hitPoints(REPS));
      for (let i = 0; i < REPS; i++) {
        rec.singleClick.attempts++;
        // 前のクリックの flyTo で視点がずれているので戻す
        await page.evaluate(JS.camera(s.x, s.z));
        await sleep(450);
        await page.evaluate(JS.closeCard);
        const p = (await page.evaluate(JS.hitPoints(1, i)))[0];
        if (!p) { rec.singleClick.noTarget++; continue; }
        await singleClick(page, p.x, p.y);
        if (await page.evaluate(JS.cardOpen)) rec.singleClick.opened++;
        else {
          // 失敗の内訳: 施設カードが出た / gesture 判定で弾かれた
          if (await page.evaluate(JS.facilityOpen)) rec.singleClick.facilityCard = (rec.singleClick.facilityCard || 0) + 1;
          if (rec.gestureSamples.length < 4) rec.gestureSamples.push({ kind: 'click-miss', at: p, gesture: await page.evaluate(JS.debug) });
        }
      }
      rec.singleClick.successPct = +(100 * rec.singleClick.opened / Math.max(1, rec.singleClick.attempts)).toFixed(1);

      // ── 2) pan × 20（右ドラッグ = 全距離で pan）──
      await page.evaluate(JS.reset);
      await page.evaluate(JS.camera(s.x, s.z)); await sleep(800);
      for (let i = 0; i < REPS; i++) {
        const p = pts[i % Math.max(1, pts.length)] || { x: 700, y: 520 };
        const before = await page.evaluate(JS.camState);
        rec.pan.attempts++;
        await drag(page, p.x, p.y, (i % 2 ? -1 : 1) * (40 + i * 3), (i % 3 ? 1 : -1) * (25 + i * 2), 'right');
        const after = await page.evaluate(JS.camState);
        if (Math.hypot(after.x - before.x, after.z - before.z) > 1) rec.pan.cameraMoved++;
        if (await page.evaluate(JS.cardOpen)) {
          rec.pan.falseOpen++;
          if (rec.gestureSamples.length < 8) rec.gestureSamples.push({ kind: 'pan-false-open', gesture: await page.evaluate(JS.debug) });
          await page.evaluate(JS.closeCard);
        }
      }

      // ── 3) rotate × 20（左ドラッグ・近景は rotationFactor=1 で回転）──
      await page.evaluate(JS.reset);
      await page.evaluate(JS.camera(s.x, s.z)); await sleep(800);
      for (let i = 0; i < REPS; i++) {
        const p = pts[i % Math.max(1, pts.length)] || { x: 700, y: 520 };
        const before = await page.evaluate(JS.camState);
        rec.rotate.attempts++;
        await drag(page, p.x, p.y, (i % 2 ? -1 : 1) * (55 + i * 2), (i % 2 ? 18 : -14), 'left');
        const after = await page.evaluate(JS.camState);
        if (Math.abs(after.th - before.th) > 1e-4 || Math.abs(after.ph - before.ph) > 1e-4
          || Math.hypot(after.x - before.x, after.z - before.z) > 1) rec.rotate.cameraMoved++;
        if (await page.evaluate(JS.cardOpen)) {
          rec.rotate.falseOpen++;
          if (rec.gestureSamples.length < 8) rec.gestureSamples.push({ kind: 'rotate-false-open', gesture: await page.evaluate(JS.debug) });
          await page.evaluate(JS.closeCard);
        }
      }

      // ── 4) wheel zoom × 20 ──
      await page.evaluate(JS.reset);
      await page.evaluate(JS.camera(s.x, s.z)); await sleep(800);
      for (let i = 0; i < REPS; i++) {
        const p = pts[i % Math.max(1, pts.length)] || { x: 700, y: 520 };
        const before = await page.evaluate(JS.camState);
        rec.wheelZoom.attempts++;
        await wheel(page, p.x, p.y, i % 2 ? 100 : -100);
        const after = await page.evaluate(JS.camState);
        if (Math.abs(after.r - before.r) > 1) rec.wheelZoom.cameraMoved++;
        if (await page.evaluate(JS.cardOpen)) {
          rec.wheelZoom.falseOpen++;
          if (rec.gestureSamples.length < 8) rec.gestureSamples.push({ kind: 'wheel-false-open', gesture: await page.evaluate(JS.debug) });
          await page.evaluate(JS.closeCard);
        }
      }

      // ── 5) §24 card が camera 操作で勝手に切り替わらない ──
      await page.evaluate(JS.reset);
      await page.evaluate(JS.camera(s.x, s.z));
      await sleep(1200);
      const p0 = (await page.evaluate(JS.hitPoints(1)))[0];
      rec.persistence = { opened: false, idBefore: null, idAfter: null, stayedOpen: null, sameBuilding: null };
      if (p0) {
        await singleClick(page, p0.x, p0.y);
        rec.persistence.opened = await page.evaluate(JS.cardOpen);
        rec.persistence.idBefore = await page.evaluate(JS.cardId);
        await drag(page, 800, 520, 120, 60, 'right');
        await drag(page, 800, 520, -90, 40, 'left');
        await wheel(page, 800, 520, -100);
        await sleep(600);
        rec.persistence.stayedOpen = await page.evaluate(JS.cardOpen);
        rec.persistence.idAfter = await page.evaluate(JS.cardId);
        rec.persistence.sameBuilding = rec.persistence.idBefore === rec.persistence.idAfter;
        await page.evaluate(JS.closeCard);
      }

      rec.intent = await page.evaluate(JS.debug);
      out.sites.push(rec);
      console.log('[click-qa]', s.id, JSON.stringify({
        click: rec.singleClick.opened + '/' + rec.singleClick.attempts + ' (' + rec.singleClick.successPct + '%)',
        panFalse: rec.pan.falseOpen, rotFalse: rec.rotate.falseOpen, wheelFalse: rec.wheelZoom.falseOpen,
        panMoved: rec.pan.cameraMoved, rotMoved: rec.rotate.cameraMoved, wheelMoved: rec.wheelZoom.cameraMoved,
        persist: rec.persistence.stayedOpen + '/' + rec.persistence.sameBuilding,
      }));
    }
    out.errors = errors.slice(0, 20);
  } finally { await b.close(); }

  const tot = out.sites.reduce((a, s) => ({
    clickAttempts: a.clickAttempts + s.singleClick.attempts, clickOpened: a.clickOpened + s.singleClick.opened,
    panFalseOpen: a.panFalseOpen + s.pan.falseOpen, rotateFalseOpen: a.rotateFalseOpen + s.rotate.falseOpen,
    wheelFalseOpen: a.wheelFalseOpen + s.wheelZoom.falseOpen,
    panMoved: a.panMoved + s.pan.cameraMoved, rotateMoved: a.rotateMoved + s.rotate.cameraMoved, wheelMoved: a.wheelMoved + s.wheelZoom.cameraMoved,
  }), { clickAttempts: 0, clickOpened: 0, panFalseOpen: 0, rotateFalseOpen: 0, wheelFalseOpen: 0, panMoved: 0, rotateMoved: 0, wheelMoved: 0 });
  tot.singleClickSuccessPct = +(100 * tot.clickOpened / Math.max(1, tot.clickAttempts)).toFixed(1);
  tot.persistenceOk = out.sites.every((s) => s.persistence && s.persistence.opened && s.persistence.stayedOpen && s.persistence.sameBuilding);
  out.totals = tot;
  out.pass = tot.singleClickSuccessPct >= ACCEPT.singleClickSuccessPct && tot.panFalseOpen === ACCEPT.panFalseOpen
    && tot.rotateFalseOpen === ACCEPT.rotateFalseOpen && tot.wheelFalseOpen === ACCEPT.wheelFalseOpen;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => { console.log('[click-qa] totals', JSON.stringify(o.totals), 'pass=' + o.pass); console.log('[click-qa] out', OUT); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
