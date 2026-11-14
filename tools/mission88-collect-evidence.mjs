#!/usr/bin/env node
// Mission 88: Mission86 受入用の「区別・実ブラウザ証拠」収集器（read-only）。ユーザー PC で後日実行する想定。
//   node tools/mission88-collect-evidence.mjs --ward nishi [--root temp/mission80] [--evidence data/reports/mission86/evidence] [--port 8188] [--check-only] [--fixture]
// 動作: 入力（source-lock / batch-manifest / 出力 tileset / N03）を検証 → 127.0.0.1 の読み取り専用サーバーで出力を配信 →
//       headless Chrome (cdp-browser) で 37G ページを開き、7 項目の証拠を採取 → evidence JSON を書く。
// 守ること: 外部通信なし（Google 通信は検知して記録、非空なら受入不可）/ 入力は読み取りのみ / 書き込みは evidence JSON 1 つ（と --check-only 以外のスクリーンショットなし）。
//   origin は環境から決める。CI / GitHub Actions / --fixture では 'local-pc' を名乗らず、受入ディレクトリとは別の non-acceptance/ に書く。
//   データ欠損・採取失敗は missing/failed として failedItems に明記し、非ゼロ終了（2=入力欠損, 1=採取失敗, 0=全採取成功。受入判定は Mission86 の仕事）。
//   roadWater は独立検証が未実装のため常に 'unverified'（＝受入にならない）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const COLLECTOR_VERSION = '88.1';
export const VINTAGE = 2025;
const GOOGLE = /(^|\.)(googleapis\.com|google\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com)$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css' };

export const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const sha256File = (p) => sha256Buf(fs.readFileSync(p));

// origin は自己申告させない: 環境から導出する。CI / fixture は local-pc にならない。
export function detectOrigin(env = process.env, flags = {}) {
  if (flags.fixture) return { origin: 'fixture', fixture: true, reason: '--fixture' };
  if (env.GITHUB_ACTIONS || env.CI || env.RUNNER_OS || env.RUNNER_TEMP || env.GITHUB_RUN_ID) return { origin: 'ci-runner', fixture: false, reason: 'CI/runner environment variables present' };
  return { origin: 'local-pc', fixture: false, reason: 'no CI/runner environment variables' };
}

// 改ざん検出用ダイジェスト（署名ではない。手書き偽造を防ぐ保証はなく、取り違え・無自覚な編集の検出用）
export function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const bodyDigest = (ev) => { const { integrity, ...rest } = ev; void integrity; return sha256Buf(Buffer.from(canonicalJson(rest))); };

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
export function pointInWard(x, z, ward) {
  for (const poly of ward.polygons || []) {
    if (!pointInRing(x, z, poly.outer)) continue;
    if ((poly.holes || []).some((h) => pointInRing(x, z, h))) continue;
    return true;
  }
  return false;
}
export function insidePolygonStats(points, ward) {
  let inside = 0;
  for (const [x, z] of points) if (pointInWard(x, z, ward)) inside++;
  return { total: points.length, inside, insideWardPolygonPct: points.length ? +(100 * inside / points.length).toFixed(3) : 0 };
}

// 出力ディレクトリから attrs（代表点・高さ）と ids を読む。読み取りのみ。
export function readOutput(outDir) {
  const byId = {}; const ids = [];
  const ad = path.join(outDir, 'attrs'), idd = path.join(outDir, 'ids');
  for (const f of fs.readdirSync(ad)) Object.assign(byId, JSON.parse(fs.readFileSync(path.join(ad, f), 'utf8')).byId || {});
  for (const f of fs.readdirSync(idd)) for (const id of JSON.parse(fs.readFileSync(path.join(idd, f), 'utf8'))) ids.push(id);
  return { byId, idSet: new Set(ids), idCount: ids.length };
}

// 入力検証。欠損は missing、不整合は failed。
export function checkInputs({ ward, lock, man, polys, root, fsx = fs }) {
  const failed = [];
  const add = (item, status, why) => failed.push({ item, status, why });
  const outDir = path.join(root, 'out', ward + '-2025');
  const mw = man && man.wards && man.wards[ward];
  const w = polys && polys.wards && polys.wards.find((x) => x.wardId === ward);
  if (!lock || !lock.http || !lock.http.etag) add('sourceLock2025', 'missing', 'source-lock etag missing');
  if (!mw) add('manifest', 'missing', 'no batch-manifest entry for ' + ward);
  else if (mw.status !== 'ok') add('manifest', 'failed', 'manifest status=' + mw.status);
  else if (mw.vintage !== VINTAGE) add('manifest', 'failed', 'manifest vintage=' + mw.vintage);
  else if (lock && lock.http && mw.sourceEtag !== lock.http.etag) add('manifest', 'failed', 'manifest sourceEtag != source-lock etag');
  if (!w) add('n03', 'missing', 'no N03 polygon for ' + ward);
  const tj = path.join(outDir, 'tileset.json');
  if (!fsx.existsSync(tj)) add('tileset', 'missing', 'local tileset.json not found: ' + tj);
  else if (mw && mw.tilesetSha256 && sha256Buf(fsx.readFileSync(tj)) !== mw.tilesetSha256) add('tileset', 'failed', 'local tileset.json sha256 != manifest tilesetSha256 (output not bound to manifest)');
  for (const d of ['attrs', 'ids']) if (!fsx.existsSync(path.join(outDir, d))) add('output-' + d, 'missing', d + '/ not found in output');
  return { ok: failed.length === 0, missing: failed.some((f) => f.status === 'missing'), failed, outDir, mw, w };
}

export function pickClickTargets(byId, n = 3) {
  return Object.entries(byId).filter(([, a]) => a[0] >= 30 && a[0] <= 120).sort((a, b) => b[1][0] - a[1][0] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([id, a]) => ({ id, h: a[0], x: a[2], z: a[3] }));
}

// 失敗項目の集計。evidence の各セクションが Mission86 の期待形になっているかを自己点検する（受入判定そのものではない）。
export function selfCheck(ev) {
  const f = [];
  if (!ev.pixel || ev.pixel.method !== 'webgl-readback-on-off') f.push('pixel.method is not webgl-readback-on-off');
  else for (const k of ['topDown', 'oblique']) if (!(ev.pixel[k] && ev.pixel[k].diffPx > 0 && ev.pixel[k].totalPx > 0)) f.push('pixel.' + k + '.diffPx must be > 0');
  const good = (ev.clicks || []).filter((c) => c.realMouseClick && c.selected && c.idInOutput);
  if (good.length < 3) f.push('real clicks with idInOutput: ' + good.length + ' < 3');
  if (!ev.coverage || ev.coverage.method !== 'n03-polygon') f.push('coverage.method is not n03-polygon');
  if (!(ev.http && ev.http.tileset200 >= 1 && ev.http.glb200 >= 1)) f.push('http tileset200/glb200 < 1');
  if (ev.http && ev.http.wardAssetErrors && ev.http.wardAssetErrors.length) f.push('ward asset errors: ' + ev.http.wardAssetErrors.length);
  if (ev.jsErrors && ev.jsErrors.length) f.push('jsErrors: ' + ev.jsErrors.length);
  if (ev.googleRequests && ev.googleRequests.length) f.push('googleRequests: ' + ev.googleRequests.length);
  return f;
}

export function evidenceDestination({ evidenceDir, ward, origin, failed }) {
  const dir = origin === 'local-pc' && !failed ? evidenceDir : path.join(evidenceDir, origin === 'local-pc' ? 'failed' : 'non-acceptance');
  return path.join(dir, ward + '.json');
}

// ---------- ブラウザ採取（Chrome が必要。ユーザー PC でのみ実行する） ----------
async function collectInBrowser({ ward, outDir, mw, w, out, port, qaClicks }) {
  const { launchBrowser } = await import('./lib/cdp-browser.js');
  const pub = path.resolve('public');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stats = { tileset200: 0, glb200: 0, wardAssetErrors: [] };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let p; const m = u.match(/^\/ext-3dtiles\/([a-z0-9]+)\/(.*)$/);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
    if (m) { p = m[1] === ward + '25' || m[1] === ward ? path.resolve(outDir, m[2]) : null; if (p && !p.startsWith(outDir + path.sep)) p = null; } else { p = path.resolve(pub, '.' + u); if (!p.startsWith(pub + path.sep)) p = null; }
    if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); if (m && !/(index\.json|layers-report\.json|labels\.json|layers\/)/.test(u)) stats.wardAssetErrors.push('404 ' + u); return; }
    if (m) { if (/tileset\.json$/.test(u)) stats.tileset200++; if (/\.glb$/.test(u)) stats.glb200++; }   // GLB は Cesium の worker 取得でページ側イベントに出ないため、サーバー側で数える
    res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream'); fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const b = await launchBrowser({ width: 1500, height: 940 });
  const page = b.page;
  const ev = (js) => page.evaluate(js);
  const J = (js) => ev(`JSON.stringify(${js})`).then(JSON.parse);
  page.on('Runtime.exceptionThrown', (e) => { try { out.jsErrors.push(String(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text).slice(0, 300)); } catch { /* noop */ } });
  page.on('Network.requestWillBeSent', (e) => { try { if (GOOGLE.test(new URL(e.request.url).hostname)) out.googleRequests.push(e.request.url); } catch { /* data: */ } });
  const waitReady = async () => { for (let i = 0; i < 120; i++) { if (await ev('window.__mission37dQA.tilesReady()').catch(() => false)) break; await sleep(500); } await sleep(1000); };
  const click = async (x, y) => { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await page.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); };
  // WebGL 読み戻し（ページ側 readbackCanvas hook）を ON/OFF で 2 回取り、ブラウザ内で画素差を数える。hook が無ければ method を偽らない。
  const readbackDiff = async (view) => {
    await ev(`window.__mission37dQA.lookAtLocal(${view.x}, ${view.z}, 0, ${view.range}, ${view.pitch}, ${view.heading})`); await sleep(2500); await waitReady();
    if (!(await ev('typeof window.__mission37dQA.readbackCanvas === "function"'))) return { unsupported: true };
    return ev(`(async () => { const Q = window.__mission37dQA; const sl = (m) => new Promise((r) => setTimeout(r, m));
      const L = (u) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = u; });
      const px = async (u) => { const i = await L(u); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
      const A = await px(Q.readbackCanvas()); Q.setTilesetShow(false); await sl(1500); const B = await px(Q.readbackCanvas()); Q.setTilesetShow(true); await sl(1000);
      let n = 0; for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 30) n++;
      return { diffPx: n, totalPx: A.length / 4 }; })()`);
  };
  try {
    await page.send('Network.enable');
    out.url = `http://127.0.0.1:${port}/mission37g-osaka-24ward-mvp.html?qa=1&fac=0&nobuiltin=1&ext=${ward}25`;
    await page.send('Page.navigate', { url: out.url });
    for (let i = 0; i < 90; i++) { await sleep(1000); if ((await ev("!!(window.__mission37dQA && window.__mission37g && document.getElementById('lc-loading').classList.contains('done'))").catch(() => false)) === true) break; }
    await sleep(1500);
    await ev(`window.__mission37dQA.setBuildingWard('${mw.wardCode}')`); await waitReady();
    out.tilesets = await J('window.__mission37dQA.tilesetCount()');
    out.buildingState = await ev('window.__mission37g.buildingState');
    out.hudBuildings = await ev("document.getElementById('hs-bldg').textContent");
    const t0 = qaClicks[0];
    const top = await readbackDiff({ x: t0.x, z: t0.z, range: 2500, pitch: -90, heading: 0 });
    const obl = await readbackDiff({ x: t0.x, z: t0.z, range: 1200, pitch: -45, heading: 30 });
    if (top.unsupported || obl.unsupported) out.pixel = { method: 'unsupported-page-hook', note: 'page lacks __mission37dQA.readbackCanvas' };
    else out.pixel = { method: 'webgl-readback-on-off', topDown: top, oblique: obl };
    out.clicks = [];
    for (const t of qaClicks) {
      let rec = { id: t.id, height: t.h, realMouseClick: false, selected: false, idInOutput: out.__idSet.has(t.id) };
      outer: for (const range of [250, 400]) {
        await ev(`window.__mission37dQA.lookAtLocal(${t.x}, ${t.z}, ${t.h / 2}, ${range}, -50, 0)`); await sleep(1500); await waitReady();
        for (const f of [0.5, 1, 0.1]) {
          const p = await J(`window.__mission37dQA.project(${t.x}, ${t.z}, ${t.h * f})`);
          if (!p || !p.inCanvas) continue;
          for (const [dx, dy] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [10, 5], [-10, 5], [10, -5], [-10, -5], [18, 0], [-18, 0]]) {
            if ((await ev(`window.__mission37dQA.pickId(${p.x + dx}, ${p.y + dy})`)) !== t.id) continue;   // pick で目標が当たる画面点だけを実クリックする（選択イベントは直接発火しない）
            await click(p.x + dx, p.y + dy);
            for (let i = 0; i < 40; i++) { if ((await ev('window.__mission37g.selectedCanonicalId')) === t.id) break; await sleep(250); }
            rec = { ...rec, realMouseClick: true, selected: (await ev('window.__mission37g.selectedCanonicalId')) === t.id, selectedId: await ev('window.__mission37g.selectedCanonicalId') };
            break outer;
          }
        }
      }
      out.clicks.push(rec);
    }
    out.renderErrors = await ev('window.__qaRenderErrors || []').catch(() => []);
    out.browser = b.version;
  } finally { out.http = { ...stats }; try { await b.close?.(); } catch { /* noop */ } srv.close(); }
}

export async function collect({ ward, root, evidenceDir, port, flags, env = process.env, argv = process.argv }) {
  const rd = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const exists = (p) => fs.existsSync(p);
  const lockP = 'data/reports/mission79/source-lock.json', manP = 'data/reports/mission80/batch-manifest.json', polyP = 'data/processed/osaka-city/boundaries/ward-classification-polygons.json';
  const lock = exists(lockP) ? rd(lockP) : null, man = exists(manP) ? rd(manP) : null, polys = exists(polyP) ? rd(polyP) : null;
  const chk = checkInputs({ ward, lock, man, polys, root });
  const o = detectOrigin(env, flags);
  const executedAt = new Date().toISOString();
  const base = { kind: 'real-browser-e2e', ward, vintage: VINTAGE, origin: o.origin, originReason: o.reason, fixture: o.fixture, executedAt,
    collector: { name: 'mission88-collect-evidence', version: COLLECTOR_VERSION, command: ['node', path.relative(process.cwd(), argv[1] || ''), ...argv.slice(2)].join(' '),
      scriptSha256: sha256File(fileURLToPath(import.meta.url)), node: process.version, platform: os.platform() + '-' + os.arch(), headless: true,
      note: 'headless software rendering; not a device performance value' },
    inputs: { sourceLockSha256: exists(lockP) ? sha256File(lockP) : null, batchManifestSha256: exists(manP) ? sha256File(manP) : null, n03PolygonsSha256: exists(polyP) ? sha256File(polyP) : null },
    googleRequests: [], jsErrors: [] };
  if (!chk.ok) {
    const ev = { ...base, collection: { status: chk.missing ? 'missing' : 'failed', failedItems: chk.failed } };
    ev.integrity = { alg: 'sha256-canonical-json', digest: bodyDigest(ev) };
    return { ev, exit: chk.missing ? 2 : 1, dest: evidenceDestination({ evidenceDir, ward, origin: o.origin, failed: true }) };
  }
  const { byId, idSet, idCount } = readOutput(chk.outDir);
  const clicks = pickClickTargets(byId, 3);
  const pts = Object.values(byId).map((a) => [a[2], a[3]]);
  const ins = insidePolygonStats(pts, chk.w);
  const ev = { ...base, url: null, lockEtag: lock.http.etag, tilesetSha256: sha256File(path.join(chk.outDir, 'tileset.json')), buildings: Object.keys(byId).length,
    outputIds: { count: idCount, unique: idSet.size, matchesManifest: idCount === chk.mw.buildings && idSet.size === chk.mw.buildings },
    meshAccounting: null, coverage: { method: 'n03-polygon', ...ins }, roadWater: { status: 'unverified', reason: 'independent road/water verification not implemented in Mission88 collector' }, __idSet: idSet };
  // meshAccounting: manifest の取り込み数と lock の計画数が違う場合の説明は、source.json に記録がある場合のみ転記する（推測しない）。
  try { const sj = rd(path.join(chk.outDir, 'source.json')); if (sj.meshAccounting) ev.meshAccounting = sj.meshAccounting; } catch { /* source.json absent: stays null */ }
  const failedItems = [];
  if (clicks.length < 3) failedItems.push({ item: 'realClick', status: 'failed', why: 'fewer than 3 click targets with height 30-120m in output attrs' });
  if (!flags.checkOnly && clicks.length >= 3) {
    try { await collectInBrowser({ ward, outDir: chk.outDir, mw: chk.mw, w: chk.w, out: ev, port, qaClicks: clicks }); } catch (e) { failedItems.push({ item: 'browser', status: 'failed', why: String(e && e.message || e).slice(0, 300) }); }
  } else if (flags.checkOnly) failedItems.push({ item: 'browser', status: 'missing', why: '--check-only: browser steps not run' });
  // Mission89: 独立検査器の報告(--roadwater)は、local-pc・年版・tileset sha256・lock etag・閾値根拠・ダイジェストが全て揃う場合だけ roadWater に採用する。
  if (flags.roadwater) {
    try {
      const rw = await import('./mission89-roadwater-verify.mjs');
      ev.roadWater = rw.toEvidence(JSON.parse(fs.readFileSync(flags.roadwater, 'utf8')), { ward, tilesetSha256: ev.tilesetSha256, lockEtag: lock.http.etag });
    } catch (e) { ev.roadWater = { status: 'unverified', reason: 'road/water report unreadable: ' + String(e && e.message || e).slice(0, 200) }; }
  }
  delete ev.__idSet;
  for (const why of selfCheck(ev)) failedItems.push({ item: 'self-check', status: 'failed', why });
  ev.collection = { status: failedItems.length ? 'failed' : 'ok', failedItems, unverifiedItems: ev.roadWater && ev.roadWater.status === 'verified' ? [] : ['roadWater'] };
  ev.integrity = { alg: 'sha256-canonical-json', digest: bodyDigest(ev), note: 'tamper-evidence only; not a signature' };
  return { ev, exit: failedItems.length === 0 ? 0 : 1, dest: evidenceDestination({ evidenceDir, ward, origin: o.origin, failed: failedItems.length > 0 }) };
}

async function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : d; };
  const ward = opt('ward');
  if (!ward) { console.error('usage: node tools/mission88-collect-evidence.mjs --ward <wardId> [--root temp/mission80] [--evidence dir] [--port 8188] [--check-only] [--fixture] [--roadwater <mission89 report>]'); process.exit(64); }
  const flags = { checkOnly: a.includes('--check-only'), fixture: a.includes('--fixture'), roadwater: opt('roadwater') ? path.resolve(opt('roadwater')) : null };
  const r = await collect({ ward, root: path.resolve(opt('root', 'temp/mission80')), evidenceDir: path.resolve(opt('evidence', 'data/reports/mission86/evidence')), port: Number(opt('port', 8188)), flags });
  fs.mkdirSync(path.dirname(r.dest), { recursive: true });
  if (fs.existsSync(r.dest)) { const old = r.dest; r.dest = old.replace(/\.json$/, '.' + Date.now() + '.json'); }   // 既存の証拠は上書きしない
  fs.writeFileSync(r.dest, JSON.stringify(r.ev, null, 1), { flag: 'wx' });
  console.log(JSON.stringify({ ward, origin: r.ev.origin, collection: r.ev.collection, evidenceFile: r.dest, exit: r.exit }, null, 1));
  if (r.ev.origin !== 'local-pc') console.log('NOTE: origin=' + r.ev.origin + ' -> written outside the acceptance directory; this is never acceptance evidence.');
  console.log('Next: node tools/mission86-acceptance.mjs   (acceptance is decided there, not here; roadWater stays unverified)');
  process.exitCode = r.exit;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error('FAILED', e && e.message); process.exit(1); });
}
