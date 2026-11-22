// Mission218B: ?lblidle=1 の LabelCollection.prototype monkey patch を fake Cesium 上で軽量検証する(実ブラウザ/実GPUの代替ではない)。
const test = require('node:test'), assert = require('node:assert'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'mission37g-osaka-24ward-mvp.html'), 'utf8');
const a = html.indexOf("if (q.get('lblidle') === '1') {"), b = html.indexOf('// Mission 161 (PR#50)', a);
assert.ok(a > 0 && b > a, 'lblidle ブロックが見つかる');
const block = html.slice(a, b);
function run(search, opts = {}) {
  const timers = []; const intervals = []; const sandbox = { performance: { now: () => sandbox.__t }, __t: 0, window: {}, console };
  sandbox.window = sandbox; sandbox.setInterval = (f) => { intervals.push({ f, on: true }); return intervals.length; }; sandbox.clearInterval = (i) => { intervals[i - 1].on = false; };
  sandbox.setTimeout = (f) => { timers.push(f); return timers.length; };
  const orig = function () { this.__upd = (this.__upd || 0) + 1; return 'orig'; };
  const LC = { prototype: { update: orig } };
  sandbox.Cesium = { LabelCollection: LC };
  const viewer = { destroyed: false, isDestroyed() { return this.destroyed; }, scene: { primitives: { _primitives: opts.prims || [] }, requestRender() {} } };
  sandbox.viewer = viewer; sandbox.scene = viewer.scene; sandbox.q = new URLSearchParams(search);
  vm.createContext(sandbox); vm.runInContext(block, sandbox);
  return { sandbox, LC, orig, viewer, timers, intervals };
}
const mkCol = (n) => { const c = Object.create({}); c.length = n; return c; };
test('既定(lblidle なし)は prototype を一切変えない', () => { const r = run(''); assert.strictEqual(r.LC.prototype.update, r.orig); assert.strictEqual(r.intervals.length, 0); assert.strictEqual(r.sandbox.__lblGate, undefined); });
test('lblidle=1: 多数ラベル collection は gate が開くまで update しない。少数は即時', () => {
  const r = run('lblidle=1'); const heavy = mkCol(100), light = mkCol(5);
  assert.strictEqual(r.LC.prototype.update.call(light), 'orig');
  assert.strictEqual(r.LC.prototype.update.call(heavy), undefined); assert.strictEqual(heavy.__upd, undefined);
  assert.strictEqual(r.sandbox.__lblGate.pending.length, 1);
});
test('20秒の保険: 実タイル未選択でも maxWait 超過で解放が始まり、最後に gate が open になりタイマが残らない', () => {
  const r = run('lblidle=1'); const heavy = mkCol(100); r.LC.prototype.update.call(heavy);
  r.sandbox.__t = 20001; r.intervals[0].f(); assert.strictEqual(r.intervals[0].on, false); assert.strictEqual(r.sandbox.__lblGate.reason, 'timeout');
  while (r.timers.length) r.timers.shift()();
  assert.strictEqual(r.sandbox.__lblGate.open, true); assert.ok(r.sandbox.__lblGate.doneMs >= 20000);
  assert.strictEqual(r.LC.prototype.update.call(heavy), 'orig'); assert.strictEqual(heavy.__upd, 1);
});
test('viewer destroy: poll を止めて gate を開き、以後は素通し', () => {
  const r = run('lblidle=1'); const heavy = mkCol(100); r.LC.prototype.update.call(heavy);
  r.viewer.destroyed = true; r.intervals[0].f(); assert.strictEqual(r.intervals[0].on, false); assert.strictEqual(r.sandbox.__lblGate.open, true); assert.strictEqual(r.sandbox.__lblGate.reason, 'viewer-destroyed');
  assert.strictEqual(r.LC.prototype.update.call(heavy), 'orig');
});
test('既知の制約: prototype パッチは復元されない(複数 viewer の二重ラップは未検証=NOT_TESTED)', () => {
  const r = run('lblidle=1'); assert.notStrictEqual(r.LC.prototype.update, r.orig);   // 復元しない=NOT 復元(制約として記録)
});
