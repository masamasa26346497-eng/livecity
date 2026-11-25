'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sandbox = { AbortController, setTimeout, clearTimeout, console }; sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/mission219b-wardgroups.js'), 'utf8'), sandbox);
const G = sandbox.LC219B;
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/mission37g-data/osaka-24-wards.json'), 'utf8'));
const html = fs.readFileSync(path.join(__dirname, '../public/mission37g-osaka-24ward-mvp.html'), 'utf8');

test('24区が欠落・重複なく連結な5グループに属する', () => {
  const r = G.validate(data.wards);
  assert.strictEqual(JSON.stringify(r.errors), '[]');
  assert.strictEqual(r.groups, 5);
  assert.strictEqual(r.sizes.reduce((a, b) => a + b, 0), 24);
  assert.ok(r.sizes.every((n) => n >= 3 && n <= 6));
});

test('validate は欠落・重複・非連結を検出する', () => {
  const bad = G.GROUPS.map((g) => ({ ...g, wardIds: g.wardIds.slice() }));
  bad[0].wardIds.push('kita'); bad[1].wardIds = bad[1].wardIds.filter((x) => x !== 'chuo'); bad[3].wardIds.push('tsurumi');
  const r = G.validate(data.wards, bad);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /duplicate kita/.test(e)));
  assert.ok(r.errors.some((e) => /missing chuo/.test(e)));
});

function ctl(maxWards) { return G.createController({ wards: data.wards, maxWards }); }

test('起動時は未選択で詳細ロード候補0区', () => {
  const c = ctl();
  assert.strictEqual(c.filterCandidates(data.wards).length, 0);
  assert.strictEqual(c.snapshot().state, 'idle');
});

test('選択後は所属区だけが候補・許可対象', () => {
  const c = ctl(); const t = c.select('bay');
  assert.strictEqual(c.filterCandidates(data.wards).map((w) => w.wardId).sort().join(','), 'konohana,minato,suminoe,taisho');
  assert.strictEqual(t.codes.length, 4);
  assert.ok(!c.allowed('27127'));
});

test('急速な連続選択: 旧世代の完了通知は無視され旧グループが残らない', () => {
  const c = ctl(); const a = c.select('north'); const b = c.select('bay');
  assert.ok(a.isStale()); assert.ok(!b.isStale());
  assert.strictEqual(c.markLoaded('27114', a.gen), false);   // 旧世代(north)
  assert.strictEqual(c.snapshot().loaded.length, 0);
  assert.strictEqual(c.snapshot().cancelled, 1);
  for (const code of b.codes) assert.ok(c.markLoaded(code, b.gen, 1000));
  assert.strictEqual(c.snapshot().state, 'ready');
});

test('切替時: 旧グループの区は破棄対象になり、破棄後に件数が反映される', () => {
  const c = ctl(); const a = c.select('bay'); a.codes.forEach((x) => c.markLoaded(x, a.gen));
  const b = c.select('south');
  const d = c.toDispose(); assert.strictEqual(d.length, 4);
  d.forEach((x) => c.markDisposed(x));
  assert.strictEqual(c.snapshot().loaded.length, 0); assert.strictEqual(c.snapshot().disposedTotal, 4);
  b.codes.forEach((x) => c.markLoaded(x, b.gen));
  assert.strictEqual(c.toDispose().length, 0);
});

test('上限超過は保険として破棄対象に入る', () => {
  const c = ctl(3); const a = c.select('center'); a.codes.forEach((x) => c.markLoaded(x, a.gen));
  assert.strictEqual(c.toDispose().length, 3);
});

test('失敗は明示され、retry で新世代になる。旧世代の失敗は無視される', () => {
  const c = ctl(); const a = c.select('east');
  assert.ok(c.markFailed(a.gen, new Error('boom'))); assert.strictEqual(c.snapshot().state, 'error');
  const r = c.retry(); assert.ok(r.gen > a.gen); assert.strictEqual(c.snapshot().state, 'loading');
  assert.strictEqual(c.markFailed(a.gen, 'late'), false); assert.strictEqual(c.snapshot().state, 'loading');
});

test('clear で候補0区に戻る', () => {
  const c = ctl(); c.select('east'); c.clear();
  assert.strictEqual(c.filterCandidates(data.wards).length, 0);
});

test('idle scheduler: 操作中は保留し停止後に1回だけ実行', async () => {
  let n = 0; const s = G.createIdleScheduler(() => { n++; }, 20);
  s.moveStart(); assert.strictEqual(s.request(), false); s.request(); assert.strictEqual(n, 0);
  s.moveEnd(); await new Promise((r) => setTimeout(r, 60)); assert.strictEqual(n, 1); assert.strictEqual(s.deferred, 2);
});

test('HTML: wardgroups は独立入口で、既定(フラグなし)の経路は変えない', () => {
  assert.ok(/mission219b-wardgroups\.js/.test(html));
  assert.ok(/q\.get\('wardgroups'\) === '1'/.test(html));
  assert.ok(/id="lc-wg-panel"/.test(html));
});
