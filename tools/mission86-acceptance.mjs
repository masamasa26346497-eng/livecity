#!/usr/bin/env node
// Mission 86: 24 区の厳格な「実ブラウザ受入」判定（read-only・無通信）。
//   node tools/mission86-acceptance.mjs [--root temp/mission80] [--evidence data/reports/mission86/evidence] [--json] [--out file] [--template <ward>]
// 判定は「証拠ファイルの検証」だけを行う。証拠は PC ローカルの実ブラウザ E2E が <evidence>/<ward>.json に書く想定。
// 証拠が無い項目は "missing"、あっても条件を満たさなければ "fail"。全 7 項目が "pass" の区だけ accepted=true。
// manifest / tileset の存在（Mission85 の artifactReady）、fixture、画像のみ、2022 年データ、6 区部分表示は受入にならない。
// ネットワーク・子プロセス・削除・コピーは行わない。書き込みは --out の JSON 1 ファイルのみ。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planWard } from './mission85-preflight.mjs';
import { bodyDigest } from './mission88-collect-evidence.mjs';

export const WARD_COUNT = 24;
export const VINTAGE = 2025;
export const MIN_INSIDE_POLYGON_PCT = 95; // 建物代表点が N03 区ポリゴン内にある割合の下限（仮の基準。緩めるなら根拠を残す）
export const ITEMS = ['sourceLock2025', 'coverage', 'http200', 'pixelDiff', 'realClick', 'n03Inside', 'roadWater'];
const EVIDENCE_KIND = 'real-browser-e2e';

const R = (status, why, extra = {}) => ({ status, why, ...extra });
const pass = (why, e) => R('pass', why, e);
const fail = (why, e) => R('fail', why, e);
const missing = (why) => R('missing', why);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// 証拠そのものの信頼性（これを満たさない証拠は全項目 fail 扱い）
export function checkEvidenceEnvelope(ev, wardId) {
  const bad = [];
  if (!ev || typeof ev !== 'object') return ['evidence is not an object'];
  if (ev.kind !== EVIDENCE_KIND) bad.push('kind must be ' + EVIDENCE_KIND + ' (got ' + ev.kind + ')');
  if (ev.ward !== wardId) bad.push('ward mismatch: ' + ev.ward);
  if (ev.vintage !== VINTAGE) bad.push('vintage must be ' + VINTAGE + ' (got ' + ev.vintage + ')');
  if (ev.fixture === true || ev.synthetic === true) bad.push('fixture/synthetic evidence is never acceptance');
  if (ev.screenshotsOnly === true) bad.push('image-only evidence is never acceptance');
  if (ev.origin && ev.origin !== 'local-pc') bad.push('evidence origin must be local-pc (runner temp / CI is not acceptance)');
  try { if (new URL(ev.url).hostname !== '127.0.0.1') bad.push('url host must be 127.0.0.1'); } catch { bad.push('url missing/invalid'); }
  if (!ev.executedAt || Number.isNaN(Date.parse(ev.executedAt))) bad.push('executedAt missing');
  if (!(ev.googleRequests && Array.isArray(ev.googleRequests) && ev.googleRequests.length === 0)) bad.push('googleRequests must be an empty array');
  if (Array.isArray(ev.jsErrors) ? ev.jsErrors.length > 0 : true) bad.push('jsErrors must be an empty array');
  // Mission88 収集器の証拠（collector/integrity を持つもの）は、ダイジェスト一致と collection.status=ok を要求する（改ざん・取り違えの検出。署名ではない）。
  if (ev.integrity || ev.collector) {
    if (!ev.integrity || ev.integrity.digest !== bodyDigest(ev)) bad.push('integrity digest mismatch (evidence edited after collection)');
    if (!ev.collection || ev.collection.status !== 'ok') bad.push('collection.status must be ok (got ' + (ev.collection && ev.collection.status) + ')');
  }
  return bad;
}

export function meshesAccounted(ev, plan, mw) {
  const a = ev && ev.meshAccounting;
  if (!a || a.planned !== plan.meshes || a.withBuildings !== mw.meshes || !Array.isArray(a.emptyMeshes)) return false;
  const empty = a.emptyMeshes;
  return empty.length === plan.meshes - mw.meshes && new Set(empty).size === empty.length && empty.every((m) => plan.meshList.includes(m));
}

export function evaluateWard({ plan, lock, mw, ev, hasLocalTileset }) {
  const it = {};
  const lockEtag = lock.http && lock.http.etag;
  const env = ev ? checkEvidenceEnvelope(ev, plan.wardId) : null;
  const envBad = env && env.length ? env : null;
  const gate = (fn) => (!ev ? missing('no browser evidence file') : envBad ? fail('evidence rejected: ' + envBad.join('; ')) : fn());

  // 1. source-lock / 2025 年版（manifest 側 ＋ 証拠側がどちらも同じ lock etag）
  it.sourceLock2025 = !mw ? missing('no batch-manifest entry') : mw.status !== 'ok' ? fail('manifest status=' + mw.status)
    : mw.vintage !== VINTAGE ? fail('manifest vintage=' + mw.vintage) : mw.sourceEtag !== lockEtag ? fail('manifest etag != source-lock etag')
    : gate(() => ev.lockEtag === lockEtag ? pass('2025 etag matches source-lock (manifest + evidence)') : fail('evidence lockEtag != source-lock'));

  // 2. 全域建物 / ID / メッシュ coverage（lock が示す区メッシュ数と一致、欠落・スキップ・ID 重複なし）
  it.coverage = !mw ? missing('no batch-manifest entry') : mw.status !== 'ok' ? fail('manifest status=' + mw.status)
    : !(mw.meshes > 0 && mw.meshes <= plan.meshes) ? fail('manifest meshes ' + mw.meshes + ' out of range (lock plans ' + plan.meshes + ')')
    // manifest の meshes は source.json の実取り込み数。lock の計画数（bbox 交差）と違う場合は、証拠側の meshAccounting で全計画メッシュの行方を説明させる。
    : mw.meshes !== plan.meshes && !meshesAccounted(ev, plan, mw) ? fail('manifest meshes ' + mw.meshes + ' != lock ' + plan.meshes + ' and no valid evidence.meshAccounting {planned,withBuildings,emptyMeshes[]}')
    : !(mw.buildings > 0) || mw.buildings !== mw.sourceBuildings || mw.skipped !== 0 || mw.fallbacks !== 0 || mw.idsUnique !== true ? fail('buildings/skipped/fallbacks/ids not clean')
    : gate(() => ev.tilesetSha256 !== mw.tilesetSha256 ? fail('evidence tilesetSha256 != manifest (evidence is not bound to this output)')
      : ev.buildings !== mw.buildings ? fail('evidence buildings ' + ev.buildings + ' != manifest ' + mw.buildings)
      : pass(mw.buildings + ' buildings, ' + plan.meshes + ' meshes, ids unique, evidence bound by tilesetSha256'));

  // 3. localhost 3DTiles / GLB が HTTP 200（このウォードの assets で 404/5xx なし）
  it.http200 = !hasLocalTileset ? missing('local tileset.json not on this PC') : gate(() => {
    const h = ev.http || {};
    if (!(h.tileset200 >= 1)) return fail('tileset200 < 1');
    if (!(h.glb200 >= 1)) return fail('glb200 < 1');
    const errs = (h.wardAssetErrors || []);
    return errs.length ? fail('ward asset errors: ' + errs.slice(0, 3).join(', ')) : pass('tileset200=' + h.tileset200 + ' glb200=' + h.glb200 + ' no ward asset errors');
  });

  // 4. Cesium WebGL の建物 ON/OFF 画素差分（真上・斜めの両方 > 0、かつ非 headless ソフト描画のみで無い旨は note で保持）
  it.pixelDiff = gate(() => {
    const p = ev.pixel || {};
    if (p.method !== 'webgl-readback-on-off') return fail('pixel.method must be webgl-readback-on-off (images alone are not evidence)');
    const ok = (x) => x && isNum(x.diffPx) && isNum(x.totalPx) && x.totalPx > 0 && x.diffPx > 0;
    return ok(p.topDown) && ok(p.oblique) ? pass('on/off diff top=' + p.topDown.diffPx + ' oblique=' + p.oblique.diffPx) : fail('on/off diffPx must be >0 for topDown and oblique');
  });

  // 5. 実マウスクリックで canonicalId 取得（出力 ids に存在すると証拠側が確認していること）
  it.realClick = gate(() => {
    const c = Array.isArray(ev.clicks) ? ev.clicks : [];
    const good = c.filter((x) => x.realMouseClick === true && x.selected === true && /^bldg_/.test(x.id || '') && x.idInOutput === true);
    return good.length >= 3 ? pass(good.length + ' real clicks selected canonicalId present in output ids') : fail('need >=3 real clicks with idInOutput=true (got ' + good.length + ')');
  });

  // 6. 選択区の N03 ポリゴン内座標（bbox だけの判定は不可）
  it.n03Inside = gate(() => {
    const c = ev.coverage || {};
    if (c.method !== 'n03-polygon') return fail('coverage.method must be n03-polygon (bbox-only is not enough)');
    if (!isNum(c.insideWardPolygonPct)) return fail('insideWardPolygonPct missing');
    return c.insideWardPolygonPct >= MIN_INSIDE_POLYGON_PCT ? pass('inside N03 polygon ' + c.insideWardPolygonPct + '%') : fail('inside N03 polygon ' + c.insideWardPolygonPct + '% < ' + MIN_INSIDE_POLYGON_PCT);
  });

  // 7. 道路/水域との整合。証拠が "unverified" のままなら未検証であり pass にしない。
  it.roadWater = gate(() => {
    const r = ev.roadWater;
    if (!r || r.status === 'unverified' || r.status === undefined) return missing('road/water alignment not verified (stays unverified)');
    if (r.status !== 'verified') return fail('roadWater.status=' + r.status);
    // Mission89: 方法・年版・独立報告ダイジェスト・閾値根拠・水平のみの明示が揃わない "verified" は受け付けない。
    const miss = [];
    if (r.method !== 'roadwater-independent-v1') miss.push('method');
    if (r.vintage !== VINTAGE) miss.push('vintage');
    if (r.scope !== 'horizontal-only' || r.verticalChecked !== false) miss.push('scope/verticalChecked');
    if (!r.thresholds || !r.thresholds.basis || !r.thresholds.approvedBy) miss.push('thresholds.basis/approvedBy');
    if (typeof r.reportDigest !== 'string' || r.reportDigest.length !== 64) miss.push('reportDigest');
    if (!isNum(r.samples) || r.samples <= 0) miss.push('samples');
    if (!isNum(r.waterChecked) || r.waterChecked <= 0) miss.push('waterChecked');
    if (miss.length) return fail('roadWater verified lacks independent-verification fields: ' + miss.join(','));
    return isNum(r.roadsChecked) && r.roadsChecked > 0 && isNum(r.maxOffsetM) ? pass('roads=' + r.roadsChecked + ' water=' + r.waterChecked + ' maxOffsetM=' + r.maxOffsetM + ' (horizontal-only)') : fail('roadWater verified without roadsChecked/maxOffsetM');
  });

  const unmet = ITEMS.filter((k) => it[k].status !== 'pass');
  return { wardId: plan.wardId, wardCode: plan.wardCode, accepted: unmet.length === 0, unmet, items: it };
}

export function buildAcceptance({ lock, polys, area, man, root, evidenceDir, fsx = fs }) {
  const rows = polys.wards.map((w) => {
    const plan = planWard(lock, w, area.projection);
    const mw = (man && man.wards && man.wards[plan.wardId]) || null;
    const hasLocalTileset = fsx.existsSync(path.join(root, 'out', plan.wardId + '-2025', 'tileset.json'));
    let ev = null, evErr = null;
    const f = path.join(evidenceDir, plan.wardId + '.json');
    if (fsx.existsSync(f)) { try { ev = JSON.parse(fsx.readFileSync(f, 'utf8')); } catch (e) { evErr = 'evidence JSON unreadable: ' + e.message; } }
    const r = evaluateWard({ plan, lock, mw, ev, hasLocalTileset });
    if (evErr) for (const k of ITEMS) r.items[k] = fail(evErr);
    if (evErr) { r.unmet = [...ITEMS]; r.accepted = false; }
    return r;
  }).sort((a, b) => a.wardCode.localeCompare(b.wardCode));
  const accepted = rows.filter((r) => r.accepted).length;
  return {
    mission: '86-acceptance', network: false, vintage: VINTAGE, lockEtag: lock.http && lock.http.etag, minInsidePolygonPct: MIN_INSIDE_POLYGON_PCT,
    wardsEvaluated: rows.length, strictAcceptedWards: accepted, allWardsAccepted: rows.length === WARD_COUNT && accepted === WARD_COUNT,
    note: 'accepted requires ALL 7 items pass from local real-browser evidence. manifest/tileset presence, fixtures, images only, 2022 data, partial 6-ward display, runner temp are not acceptance.',
    itemStatusTotals: Object.fromEntries(ITEMS.map((k) => [k, rows.reduce((o, r) => { o[r.items[k].status] = (o[r.items[k].status] || 0) + 1; return o; }, {})])),
    wards: rows,
  };
}

export function evidenceTemplate(wardId) {
  return { kind: EVIDENCE_KIND, ward: wardId, vintage: VINTAGE, origin: 'local-pc', fixture: false, executedAt: '<ISO8601>', url: 'http://127.0.0.1:8137/...', lockEtag: '<from source-lock>',
    tilesetSha256: '<from batch-manifest>', buildings: 0, googleRequests: [], jsErrors: [],
    http: { tileset200: 0, glb200: 0, wardAssetErrors: [] },
    pixel: { method: 'webgl-readback-on-off', topDown: { diffPx: 0, totalPx: 0 }, oblique: { diffPx: 0, totalPx: 0 } },
    clicks: [{ id: 'bldg_...', realMouseClick: true, selected: true, idInOutput: true }],
    coverage: { method: 'n03-polygon', insideWardPolygonPct: 0 },
    roadWater: { status: 'unverified' },
    _note: 'TEMPLATE: values are placeholders and fail validation until a real local browser run fills them.' };
}

export function formatText(r) {
  const L = ['[86] strict acceptance (no network) strictAccepted=' + r.strictAcceptedWards + '/' + WARD_COUNT + ' allWardsAccepted=' + r.allWardsAccepted];
  L.push('ward         ' + ITEMS.map((k) => k.slice(0, 9).padEnd(9)).join(' ') + ' accepted');
  const s = { pass: 'pass', fail: 'FAIL', missing: '-' };
  for (const w of r.wards) L.push(w.wardId.padEnd(13) + ITEMS.map((k) => s[w.items[k].status].padEnd(9)).join(' ') + ' ' + (w.accepted ? 'ACCEPTED' : 'not-accepted'));
  if (!r.allWardsAccepted) L.push('NOT complete: ' + (WARD_COUNT - r.strictAcceptedWards) + ' wards lack full real-browser evidence. "-" = no evidence, FAIL = evidence rejected.');
  return L.join('\n');
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : d; };
  if (opt('template')) { console.log(JSON.stringify(evidenceTemplate(opt('template')), null, 1)); return; }
  const rd = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const man = fs.existsSync('data/reports/mission80/batch-manifest.json') ? rd('data/reports/mission80/batch-manifest.json') : null;
  const r = buildAcceptance({ lock: rd('data/reports/mission79/source-lock.json'), polys: rd('data/processed/osaka-city/boundaries/ward-classification-polygons.json'),
    area: rd('config/areas/osaka-city.json'), man, root: path.resolve(opt('root', 'temp/mission80')), evidenceDir: path.resolve(opt('evidence', 'data/reports/mission86/evidence')) });
  if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify(r, null, 1));
  console.log(a.includes('--json') ? JSON.stringify(r, null, 1) : formatText(r));
  if (!r.allWardsAccepted) process.exitCode = 3;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); }
}
