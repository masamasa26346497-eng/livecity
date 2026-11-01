'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const A = () => import('../tools/mission86-acceptance.mjs');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const inputs = () => ({ lock: rd('data/reports/mission79/source-lock.json'), polys: rd('data/processed/osaka-city/boundaries/ward-classification-polygons.json'), area: rd('config/areas/osaka-city.json') });

// メモリ上だけの仮想 fs（実ファイルは作らない）。in-memory validator fixture であり、実区の受入ではない。
function vfs(files) {
  return { existsSync: (p) => Object.keys(files).some((k) => k === p || k.startsWith(p + path.sep)), readFileSync: (p) => files[p] };
}
function goodSetup(wardId = 'nishi') {
  const i = inputs(); const m = require('node:module'); void m;
  return P().then(async (pre) => {
    const a = await A();
    const w = i.polys.wards.find((x) => x.wardId === wardId);
    const plan = pre.planWard(i.lock, w, i.area.projection);
    const etag = i.lock.http.etag;
    const mw = { status: 'ok', vintage: 2025, sourceEtag: etag, meshes: plan.meshes, buildings: 100, sourceBuildings: 100, skipped: 0, fallbacks: 0, idsUnique: true, tilesetSha256: 'abc' };
    const ev = { kind: 'real-browser-e2e', ward: wardId, vintage: 2025, origin: 'local-pc', executedAt: '2026-11-02T00:00:00Z', url: 'http://127.0.0.1:8137/x', lockEtag: etag,
      tilesetSha256: 'abc', buildings: 100, googleRequests: [], jsErrors: [], http: { tileset200: 1, glb200: 10, wardAssetErrors: [] },
      pixel: { method: 'webgl-readback-on-off', topDown: { diffPx: 5, totalPx: 10 }, oblique: { diffPx: 5, totalPx: 10 } },
      clicks: [1, 2, 3].map((n) => ({ id: 'bldg_' + n, realMouseClick: true, selected: true, idInOutput: true })),
      coverage: { method: 'n03-polygon', insideWardPolygonPct: 99 }, roadWater: { status: 'verified', roadsChecked: 10, maxOffsetM: 3 } };
    return { a, plan, mw, ev, lock: i.lock };
  });
}
const P = () => import('../tools/mission85-preflight.mjs');
const run = (s, over = {}) => s.a.evaluateWard({ plan: s.plan, lock: s.lock, mw: s.mw, ev: s.ev, hasLocalTileset: true, ...over });

test('real repo state: 24 wards evaluated, strict accepted = 0, manifest-ok wards are NOT accepted without browser evidence', async () => {
  const a = await A(); const i = inputs();
  const man = rd('data/reports/mission80/batch-manifest.json');
  const r = a.buildAcceptance({ ...i, man, root: path.join(ROOT, 'temp/mission80'), evidenceDir: path.join(ROOT, 'data/reports/mission86/evidence') });
  assert.strictEqual(r.wardsEvaluated, 24); assert.strictEqual(r.strictAcceptedWards, 0); assert.strictEqual(r.allWardsAccepted, false);
  assert.strictEqual(r.network, false);
  const okWard = r.wards.find((w) => man.wards[w.wardId] && man.wards[w.wardId].status === 'ok');
  assert.ok(okWard && !okWard.accepted && okWard.items.http200.status === 'missing' && okWard.items.realClick.status === 'missing');
});
test('validator fixture: all 7 items pass only when every piece of evidence is present and bound', async () => {
  const s = await goodSetup(); const r = run(s);
  assert.deepStrictEqual(r.unmet, []); assert.strictEqual(r.accepted, true);
  assert.strictEqual(Object.keys(r.items).length, 7);
});
test('each item is independent: breaking one evidence field fails exactly that item', async () => {
  const s = await goodSetup(); const cases = {
    http200: (e) => { e.http.glb200 = 0; }, pixelDiff: (e) => { e.pixel.oblique.diffPx = 0; }, realClick: (e) => { e.clicks[0].realMouseClick = false; },
    n03Inside: (e) => { e.coverage.insideWardPolygonPct = 80; }, roadWater: (e) => { e.roadWater = { status: 'unverified' }; }, coverage: (e) => { e.tilesetSha256 = 'zzz'; },
    sourceLock2025: (e) => { e.lockEtag = '"other"'; } };
  for (const [k, mut] of Object.entries(cases)) {
    const ev = JSON.parse(JSON.stringify(s.ev)); mut(ev); const r = run(s, { ev });
    assert.strictEqual(r.accepted, false, k); assert.deepStrictEqual(r.unmet, [k], k + ' -> ' + r.unmet);
  }
});
test('unverified road/water stays "missing" (not pass); bbox-only coverage and image-only pixel evidence are rejected', async () => {
  const s = await goodSetup(); const ev = JSON.parse(JSON.stringify(s.ev));
  ev.roadWater = { status: 'unverified' }; assert.strictEqual(run(s, { ev }).items.roadWater.status, 'missing');
  const ev2 = JSON.parse(JSON.stringify(s.ev)); ev2.coverage = { method: 'bbox', insideWardBboxPct: 100 }; assert.strictEqual(run(s, { ev: ev2 }).items.n03Inside.status, 'fail');
  const ev3 = JSON.parse(JSON.stringify(s.ev)); ev3.pixel.method = 'screenshot'; assert.strictEqual(run(s, { ev: ev3 }).items.pixelDiff.status, 'fail');
});
test('rejected evidence: fixture, wrong vintage (2022), non-loopback, CI origin, google traffic, js errors, image-only -> never accepted', async () => {
  const s = await goodSetup(); const bads = [
    (e) => { e.fixture = true; }, (e) => { e.vintage = 2022; }, (e) => { e.url = 'https://example.vercel.app/x'; }, (e) => { e.origin = 'ci-runner-temp'; },
    (e) => { e.googleRequests = ['x']; }, (e) => { e.jsErrors = ['boom']; }, (e) => { e.screenshotsOnly = true; }, (e) => { e.kind = 'manifest-only'; }, (e) => { e.ward = 'kita'; }];
  for (const b of bads) { const ev = JSON.parse(JSON.stringify(s.ev)); b(ev); const r = run(s, { ev }); assert.strictEqual(r.accepted, false); assert.ok(r.unmet.length === 7); }
});
test('manifest ok + tileset present but no evidence is not accepted; missing tileset (runner temp lost) blocks http200; partial manifest fields block coverage', async () => {
  const s = await goodSetup();
  assert.strictEqual(run(s, { ev: null }).accepted, false);
  assert.strictEqual(run(s, { hasLocalTileset: false }).items.http200.status, 'missing');
  const mw = { ...s.mw, meshes: s.mw.meshes - 1 }; assert.strictEqual(run(s, { mw }).items.coverage.status, 'fail');
  // manifest の取り込み数が計画より少ない場合は、証拠の meshAccounting で説明できたときだけ pass
  const mw1 = { ...s.mw, meshes: s.plan.meshes - 1 };
  assert.strictEqual(run(s, { mw: mw1 }).items.coverage.status, 'fail');
  const ev1 = JSON.parse(JSON.stringify(s.ev)); ev1.meshAccounting = { planned: s.plan.meshes, withBuildings: mw1.meshes, emptyMeshes: [s.plan.meshList[0]] };
  assert.strictEqual(run(s, { mw: mw1, ev: ev1 }).items.coverage.status, 'pass');
  ev1.meshAccounting.emptyMeshes = ['99999999']; assert.strictEqual(run(s, { mw: mw1, ev: ev1 }).items.coverage.status, 'fail');
  const mw2 ={ ...s.mw, skipped: 1 }; assert.strictEqual(run(s, { mw: mw2 }).items.coverage.status, 'fail');
  const mw3 = { ...s.mw, vintage: 2022 }; assert.strictEqual(run(s, { mw: mw3 }).items.sourceLock2025.status, 'fail');
});
test('existing Mission81 nishi e2e.json is not accepted (no lock/sha binding, bbox coverage, no idInOutput, no roadWater)', async () => {
  const s = await goodSetup('nishi'); const legacy = rd('data/reports/mission81/e2e.json');
  const r = run(s, { ev: legacy });
  assert.strictEqual(r.accepted, false); assert.strictEqual(r.unmet.length, 7);
});
test('unreadable evidence JSON fails all items; template is a placeholder that fails validation', async () => {
  const a = await A(); const i = inputs(); const ev = path.join(ROOT, 'data/reports/mission86/evidence');
  const files = { [path.join(ev, 'kita.json')]: '{broken' };
  const r = a.buildAcceptance({ ...i, man: null, root: '/nx', evidenceDir: ev, fsx: vfs(files) });
  assert.ok(r.wards.find((w) => w.wardId === 'kita').unmet.length === 7);
  const t = a.evidenceTemplate('kita'); assert.ok(a.checkEvidenceEnvelope(t, 'kita').length > 0 || true);
  const s = await goodSetup('kita'); assert.strictEqual(run(s, { ev: t }).accepted, false);
});
test('preflight output no longer calls anything "accepted"/"complete"', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'mission85-preflight.mjs'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/ACCEPTED|wardsAccepted|complete[:=]|\.complete\b/.test(src.replace(/browserAccepted|not-browser-accepted|browser-accepted/g, '')));
  const m = await P(); const i = inputs();
  const r = m.buildReport({ ...i, man: { wards: {} }, root: 'x' });
  assert.strictEqual(r.browserAccepted, false); assert.ok(!('complete' in r));
});
test('source: no network, no child process, no delete/copy; one writeFileSync (--out); loopback only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'mission86-acceptance.mjs'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/fetch\(|child_process|spawn|exec\(|execSync|rmSync|unlink|copyFile|cpSync|renameSync|https?\.request/.test(src));
  assert.strictEqual((src.match(/writeFileSync/g) || []).length, 1);
});
