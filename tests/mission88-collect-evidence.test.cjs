'use strict';
// Mission 88: 無通信・ブラウザ無し。収集器の純粋ロジックと、受入バリデータとの接続を検証する。
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..');
const C = () => import('../tools/mission88-collect-evidence.mjs');
const A = () => import('../tools/mission86-acceptance.mjs');
const src = fs.readFileSync(path.join(ROOT, 'tools/mission88-collect-evidence.mjs'), 'utf8');
const code = src.replace(/\/\/.*$/gm, '');

test('origin is derived from environment: CI/runner and --fixture are never local-pc', async () => {
  const c = await C();
  assert.strictEqual(c.detectOrigin({}, {}).origin, 'local-pc');
  assert.strictEqual(c.detectOrigin({ GITHUB_ACTIONS: 'true' }, {}).origin, 'ci-runner');
  assert.strictEqual(c.detectOrigin({ CI: '1' }, {}).origin, 'ci-runner');
  assert.strictEqual(c.detectOrigin({ RUNNER_TEMP: '/tmp' }, {}).origin, 'ci-runner');
  const f = c.detectOrigin({}, { fixture: true });
  assert.strictEqual(f.origin, 'fixture'); assert.strictEqual(f.fixture, true);
  assert.ok(!/opt\('origin'/.test(code), 'no CLI flag may set origin');
});

test('non-local or failed evidence is written outside the acceptance directory', async () => {
  const c = await C(); const d = path.join('x', 'ev');
  assert.strictEqual(c.evidenceDestination({ evidenceDir: d, ward: 'nishi', origin: 'local-pc', failed: false }), path.join(d, 'nishi.json'));
  assert.ok(c.evidenceDestination({ evidenceDir: d, ward: 'nishi', origin: 'ci-runner', failed: false }).includes('non-acceptance'));
  assert.ok(c.evidenceDestination({ evidenceDir: d, ward: 'nishi', origin: 'local-pc', failed: true }).includes('failed'));
});

test('point-in-polygon with holes; inside pct', async () => {
  const c = await C();
  const ward = { polygons: [{ outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [[[4, 4], [6, 4], [6, 6], [4, 6]]] }] };
  assert.ok(c.pointInWard(1, 1, ward)); assert.ok(!c.pointInWard(5, 5, ward)); assert.ok(!c.pointInWard(11, 1, ward));
  const s = c.insidePolygonStats([[1, 1], [2, 2], [5, 5], [20, 20]], ward);
  assert.deepStrictEqual([s.total, s.inside, s.insideWardPolygonPct], [4, 2, 50]);
});

test('missing data -> missing; hash/etag mismatch -> failed; consistent -> ok', async () => {
  const c = await C();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm88-'));
  const lock = { http: { etag: '"e"' } }; const polys = { wards: [{ wardId: 'w', polygons: [] }] };
  const man = { wards: { w: { status: 'ok', vintage: 2025, sourceEtag: '"e"', tilesetSha256: 'zzz' } } };
  let r = c.checkInputs({ ward: 'w', lock, man, polys, root: tmp });
  assert.ok(!r.ok && r.missing && r.failed.some((f) => f.item === 'tileset' && f.status === 'missing'));
  const out = path.join(tmp, 'out', 'w-2025');
  fs.mkdirSync(path.join(out, 'attrs'), { recursive: true }); fs.mkdirSync(path.join(out, 'ids'));
  fs.writeFileSync(path.join(out, 'tileset.json'), '{}');
  r = c.checkInputs({ ward: 'w', lock, man, polys, root: tmp });
  assert.ok(!r.ok && r.failed.some((f) => f.item === 'tileset' && f.status === 'failed' && /sha256/.test(f.why)));
  man.wards.w.tilesetSha256 = c.sha256Buf(Buffer.from('{}'));
  assert.ok(c.checkInputs({ ward: 'w', lock, man, polys, root: tmp }).ok);
  man.wards.w.sourceEtag = '"other"';
  assert.ok(c.checkInputs({ ward: 'w', lock, man, polys, root: tmp }).failed.some((f) => f.item === 'manifest'));
});

test('integrity digest detects edits; Mission86 rejects edited, failed, or non-local collector evidence', async () => {
  const c = await C(), a = await A();
  const ev = { kind: 'real-browser-e2e', ward: 'nishi', vintage: 2025, origin: 'local-pc', fixture: false, executedAt: '2026-11-02T00:00:00Z', url: 'http://127.0.0.1:8188/x',
    googleRequests: [], jsErrors: [], collector: { name: 'mission88-collect-evidence' }, collection: { status: 'ok', failedItems: [] } };
  ev.integrity = { digest: c.bodyDigest(ev) };
  assert.deepStrictEqual(a.checkEvidenceEnvelope(ev, 'nishi'), []);
  const edited = JSON.parse(JSON.stringify(ev)); edited.buildings = 999;
  assert.ok(a.checkEvidenceEnvelope(edited, 'nishi').some((x) => /integrity/.test(x)));
  const failed = JSON.parse(JSON.stringify(ev)); failed.collection.status = 'failed'; failed.integrity.digest = c.bodyDigest(failed);
  assert.ok(a.checkEvidenceEnvelope(failed, 'nishi').some((x) => /collection\.status/.test(x)));
  const ci = JSON.parse(JSON.stringify(ev)); ci.origin = 'ci-runner'; ci.integrity.digest = c.bodyDigest(ci);
  assert.ok(a.checkEvidenceEnvelope(ci, 'nishi').some((x) => /local-pc/.test(x)));
});

test('selfCheck flags missing pixel hook, few clicks, bbox-only coverage; roadWater stays unverified', async () => {
  const c = await C();
  const f = c.selfCheck({ pixel: { method: 'unsupported-page-hook' }, clicks: [{ realMouseClick: true, selected: true, idInOutput: true }], coverage: { method: 'bbox' }, http: { tileset200: 0, glb200: 0 }, jsErrors: [], googleRequests: [] });
  assert.ok(f.length >= 4);
  assert.ok(/status: 'unverified'/.test(code) && !/status: 'verified'/.test(code));
});

test('click targets are deterministic; real pick precedes real mouse click; no direct event dispatch', async () => {
  const c = await C();
  const t = c.pickClickTargets({ b: [80, 0, 1, 1], a: [80, 0, 2, 2], c: [10, 0, 3, 3], d: [100, 0, 4, 4] }, 3);
  assert.deepStrictEqual(t.map((x) => x.id), ['d', 'a', 'b']);
  assert.ok(/pickId\(/.test(code) && /Input\.dispatchMouseEvent/.test(code));
  assert.ok(!/dispatchEvent|building-selected/.test(code));
});

test('no network / delete / copy / child process; evidence never overwritten; page hook exists; nishi launcher untouched', () => {
  assert.ok(!/\b(unlinkSync|rmSync|rmdirSync|copyFileSync|renameSync|spawn|execSync|fetch)\(/.test(code));
  assert.ok(!/https?\.request|child_process/.test(code));
  assert.ok(/flag: 'wx'/.test(code));
  assert.ok(/readbackCanvas\(\)/.test(fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8')));
  assert.ok(fs.existsSync(path.join(ROOT, 'tools/mission81-local-preview.mjs')));
});
