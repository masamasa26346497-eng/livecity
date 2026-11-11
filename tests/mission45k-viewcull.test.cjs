'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sb = {}; sb.window = sb;
// public/*.js は ESM パッケージ配下なので vm で評価（ブラウザと同じく window.LC45x に載る）。同一 realm のオブジェクトを返すため sb 自体を context にする
vm.createContext(sb);
for (const f of ['mission45i-vec.js', 'mission45k-viewcull.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', f), 'utf8'), sb);
const K = sb.LC45K, I = sb.LC45I;

// 合成道路: 12km x 12km に n 本（50 本に 1 本は複数セルを跨ぐ長い幹線）
function synth(n, seed) {
  let s = seed || 7; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const out = [];
  for (let i = 0; i < n; i++) {
    const long = i % 50 === 0;
    let x = rnd() * 12000 - 6000, z = rnd() * 12000 - 6000; const p = [[x, z]];
    const len = long ? 60 : 8; const ang = rnd() * 6.28;
    for (let k = 0; k < len; k++) { x += Math.cos(ang + rnd() * 0.3) * (long ? 250 : 30); z += Math.sin(ang + rnd() * 0.3) * (long ? 250 : 30); p.push([x, z]); }
    out.push({ id: 'r' + i, tier: long ? 'major' : 'local', p });
  }
  return out;
}
const style = (f) => ({ width: 2, height: 1, maxDist: f.tier === 'local' ? 3000 : 0 });
const segs = (f) => f.p.length - 1;

test('索引: 全線分がちょうど 1 回だけ割り当てられる（重複描画なし）', () => {
  const feats = synth(600);
  const idx = K.buildIndex(feats, style, 400);
  const total = feats.reduce((s, f) => s + segs(f), 0);
  assert.equal(idx.stats.segments, total);
  let inRuns = 0; for (const c of idx.cells.values()) for (const r of c.runs) inRuns += r.pts.length - 1;
  assert.equal(inRuns, total);
});

test('カリング: 視野に触れる線分は欠けず、視野外は大量に除外される', () => {
  const feats = synth(3000);
  const idx = K.buildIndex(feats, style, 400);
  const rect = K.viewRect(0, 0, 1500);
  const sel = K.selectCells(idx, rect);
  const selKeys = new Set(sel.map((s) => s.key));
  assert.ok(sel.length > 0, '視野内 features != 0');
  let need = 0, got = 0, all = 0;
  const inside = (p) => p[0] >= rect.minX && p[0] <= rect.maxX && p[1] >= rect.minZ && p[1] <= rect.maxZ;
  for (const [k, c] of idx.cells) for (const r of c.runs) {
    all += r.pts.length - 1;
    for (let i = 0; i < r.pts.length - 1; i++) if (inside(r.pts[i])) { need++; if (selKeys.has(k)) got++; }
  }
  assert.equal(got, need, '始点が視野内の線分は全て選択セルにある');
  let selSeg = 0; for (const s of sel) for (const r of s.cell.runs) selSeg += r.pts.length - 1;
  assert.ok(selSeg < all * 0.6, '視野外が除外される: ' + selSeg + '/' + all);
});

test('境界またぎ: 線を run に分けても元の線分列を完全に復元できる', () => {
  const f = { id: 'x', tier: 'major', p: [[10, 10], [390, 10], [810, 10], [1210, 10], [1210, 900]] };
  const idx = K.buildIndex([f], style, 400);
  const segSet = new Set();
  for (const c of idx.cells.values()) for (const r of c.runs) for (let i = 0; i < r.pts.length - 1; i++) segSet.add(r[i] + '>' + r[i + 1]);
  for (const c of idx.cells.values()) for (const r of c.runs) for (let i = 0; i < r.pts.length - 1; i++) segSet.add(r.pts[i] + '>' + r.pts[i + 1]);
  for (let i = 0; i < f.p.length - 1; i++) assert.ok(segSet.has(f.p[i] + '>' + f.p[i + 1]));
});

test('既定の最小半径・余白: 矩形外に始点がある長い線分が欠けないための前提を固定', () => {
  const f = { id: 'x', tier: 'major', p: [[-900, 0], [900, 0]] };
  const idx = K.buildIndex([f], style, 400);
  assert.equal(K.selectCells(idx, K.viewRect(0, 0, 100)).length, 1);   // minRadius 1200 * 1.5 = 1800m
  assert.equal(K.viewRect(0, 0, 100).r, 1800);
  assert.equal(K.viewRect(0, 0, 10000).r, 27000);
});

test('常駐管理: 予算内で段階構築・hysteresis 内で破棄しない・往復で全再構築しない・移動中は構築しない', () => {
  const feats = synth(3000);
  const idx = K.buildIndex(feats, style, 400);
  let built = 0, destroyed = 0;
  const m = K.makeResidency(idx, (k) => { built++; return k; }, () => { destroyed++; }, { maxBuildVertices: 800, maxResidentVertices: 1e9 });
  const r1 = K.viewRect(0, 0, 1500);
  let guard = 0; while (m.sync(r1, true).pending && guard++ < 500);
  assert.ok(guard > 0, '予算で複数回に分割して構築される');
  m.sync(K.viewRect(300, 300, 1500), true);
  assert.equal(destroyed, 0, 'hysteresis 内の移動で破棄しない');
  guard = 0; while (m.sync(K.viewRect(300, 300, 1500), true).pending && guard++ < 500);
  const b2 = built;
  guard = 0; while (m.sync(r1, true).pending && guard++ < 500);
  assert.ok(built - b2 <= 5, '戻っても全再構築しない: +' + (built - b2));
  const before = built; m.sync(K.viewRect(5000, 5000, 1500), false);
  assert.equal(built, before, '移動中は構築しない');
  guard = 0; while (m.sync(K.viewRect(5000, 5000, 1500), true).pending && guard++ < 500);
  assert.ok(destroyed > 0, '遠くへ移動したら旧セルを破棄');
  const m2 = K.makeResidency(idx, () => 1, () => {}, { maxResidentVertices: 3000, maxBuildVertices: 1e9 });
  m2.sync(K.viewRect(0, 0, 1500), true);
  const resident1 = m2.stats.residentVertices;
  m2.sync(K.viewRect(4000, 4000, 1500), true);
  assert.ok(m2.stats.residentVertices < resident1 + 1e9);
});

test('45J fastclip との等価: 両端が区内の線分は、セル分割 + run 単位 clip でも全て描かれる', () => {
  const poly = [{ outer: [[-3000, -3000], [3000, -3000], [3000, 3000], [-3000, 3000]], holes: [] }];
  const inside = I.makeInsideTester(poly, 64);
  const feats = synth(1500).map((f) => ({ ...f, p: f.p.map((q) => [q[0] / 2, q[1] / 2]) }));
  const idx = K.buildIndex(feats, style, 400);
  const full = new Set();
  for (const f of feats) for (const r of I.clipRuns(f.p, inside)) for (let i = 0; i < r.length - 1; i++) full.add(r[i] + '>' + r[i + 1]);
  const got = new Set();
  for (const c of idx.cells.values()) for (const run of c.runs) for (const r of I.clipRuns(run.pts, inside)) for (let i = 0; i < r.length - 1; i++) got.add(r[i] + '>' + r[i + 1]);
  const bothIn = (s) => { const [a, b] = s.split('>').map((t) => t.split(',').map(Number)); return inside(a[0], a[1]) && inside(b[0], b[1]); };
  let checked = 0;
  for (const s of full) if (bothIn(s)) { checked++; assert.ok(got.has(s), '欠け: ' + s); }
  assert.ok(checked > 1000);
});

test('マイクロベンチ: 近景では常駐頂点が全体の半分未満（旧方式は全 feature）', () => {
  const feats = synth(3000);
  const idx = K.buildIndex(feats, style, 400);
  const all = feats.reduce((s, f) => s + f.p.length, 0);
  const t0 = process.hrtime.bigint();
  const m = K.makeResidency(idx, (k, c) => c.vertices, () => {}, { maxBuildVertices: 1e9, maxResidentVertices: 1e9 });
  m.sync(K.viewRect(0, 0, 1000), true);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('45K bench: features=3000 allVertices=' + all + ' residentVertices=' + m.stats.residentVertices + ' cells=' + m.size() + '/' + idx.cells.size + ' syncMs=' + ms.toFixed(2));
  assert.ok(m.stats.residentVertices < all * 0.5, m.stats.residentVertices + '/' + all);
});

test('ページ配線: 既定で viewCull、?vcull=0 で従来、Google/通信参照なし', () => {
  const h = fs.readFileSync(path.join(__dirname, '../public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(/mission45k-viewcull\.js/.test(h));
  assert.ok(/opt\.viewCull = true/.test(h));
  assert.ok(/q\.get\('vcull'\) !== '0'/.test(h));
  assert.ok(/vecViewSync\(c, pos\.h\)/.test(h));
  assert.ok(/__mission45k/.test(h));
  const js = fs.readFileSync(path.join(__dirname, '../public/mission45k-viewcull.js'), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|googleapis/.test(js));
});
