'use strict';
// Mission 45P: 面ポリゴン空間カリング / 診断表現 / 45N 要約の合成テスト。実データ・実機ブラウザでは未確認。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const sb = {}; vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/mission45p-areacull.js'), 'utf8'), sb);
const A = sb.LC45P;
const sq = (x, z, s) => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];
const area = (id, p) => ({ id, kind: 'area', p });
const rectAt = (cx, cz, r) => ({ minX: cx - r, maxX: cx + r, minZ: cz - r, maxZ: cz + r, cx, cz, r });

test('small areas group per cell; big area is a single separate unit (no double draw)', () => {
  const f = [area('a', sq(10, 10, 50)), area('b', sq(100, 100, 50)), area('c', sq(1000, 1000, 50)), area('big', sq(0, 0, 3000))];
  const idx = A.buildIndex(f);
  assert.strictEqual(idx.stats.features, 4);
  assert.strictEqual(idx.stats.big, 1);
  const all = idx.units.flatMap((u) => u.feats.map((x) => x.id)).sort();
  assert.strictEqual(all.join(), 'a,b,big,c');   // 各面はちょうど 1 ユニット
});
test('an area that overlaps the view is selected even if its center is far away (never vanishes from view)', () => {
  const idx = A.buildIndex([area('lake', sq(-5000, -100, 10000)), area('far', sq(8000, 8000, 50))]);
  const sel = A.selectUnits(idx, rectAt(0, 0, 300)).map((s) => s.unit.feats[0].id);
  assert.strictEqual(sel.join(), 'lake');
});
test('residency: builds only near units, respects vertex budget, defers rest, drops far units, never rebuilds resident', () => {
  const f = []; for (let i = 0; i < 40; i++) f.push(area('p' + i, sq(i * 500, 0, 40)));
  const idx = A.buildIndex(f), built = [], dropped = [];
  const r = A.makeResidency(idx, (u) => { built.push(u.key); return u.key; }, (h) => dropped.push(h), { maxBuildVertices: 8 });
  const s = r.sync(rectAt(0, 0, 1200), true);
  assert.ok(s.built >= 1 && s.built <= 2 && s.pending >= 1, JSON.stringify(s));
  r.sync(rectAt(0, 0, 1200), true); r.sync(rectAt(0, 0, 1200), true);
  assert.strictEqual(new Set(built).size, built.length);   // 同じユニットを再構築しない
  assert.strictEqual(r.sync(rectAt(0, 0, 1200), false).built, 0);   // 操作中は構築しない
  r.sync(rectAt(15000, 0, 600), true);   // 遠くへ → 元の常駐は破棄
  assert.ok(dropped.length >= 1);
  assert.ok(r.size() < 40);
});
test('canBuild=false (moving) never destroys what is within hysteresis', () => {
  const idx = A.buildIndex([area('a', sq(0, 0, 40))]);
  const dropped = [], r = A.makeResidency(idx, () => 'h', (h) => dropped.push(h), {});
  r.sync(rectAt(0, 0, 500), true);
  r.sync(rectAt(600, 0, 500), false);   // 視野から外れかけだが hysteresis 内
  assert.strictEqual(dropped.length, 0);
});
test('input features are not mutated; invalid areas are skipped', () => {
  const f = [area('a', sq(0, 0, 10)), { id: 'x', kind: 'line', p: [[0, 0], [1, 1]] }, area('bad', [[0, 0], [1, 1]])];
  const snap = JSON.stringify(f); const idx = A.buildIndex(f);
  assert.strictEqual(JSON.stringify(f), snap);
  assert.strictEqual(idx.stats.features, 1); assert.strictEqual(idx.stats.skipped, 2);
});
test('37G page wires area cull only for ward vector layers and keeps the legacy path', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(h.includes('mission45p-areacull.js'));
  assert.ok(/mountCulled\(feats\)/.test(h) && /LC45P\.makeResidency/.test(h));
  assert.ok(/LAYER_H\.waterways \}, b, o\)/.test(h));
  assert.ok(/LAYER_H\.parks \}, b, o\)/.test(h));
  assert.ok(/root45kOn\(\)\) return mountCulled/.test(h));   // ?vcull=0 で従来経路
  assert.ok(/summary\(\)/.test(h));
  assert.ok(!/google/i.test(fs.readFileSync(path.join(ROOT, 'public/mission45p-areacull.js'), 'utf8')));
});
test('45O diag page: GSI opt-in, attribution, no network APIs other than Image tiles', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/mission45o-align-diag.html'), 'utf8');
  assert.ok(!/id="lg" checked/.test(h));
  assert.ok(h.includes('国土地理院') && h.includes('id="lgrid"') && h.includes('id="rx"'));
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(h));
});
