'use strict';
// Mission 45G: 高速化ロジック(純粋関数) / 遠景 LOD0 ビルド(合成 fixture) / 45E サーバーの LOD0 配信 / ページ配線の静的確認。
// ブラウザ実描画・実 PC の 24 区の計測ではない。FPS 改善の証拠ではなく、仕組みが仕様どおりに動くことの確認。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const sb = {}; sb.window = sb;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/mission45g-perf.js'), 'utf8'), sb);
const P = sb.LC45G;
const F = {}; F.window = F;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/mission45f-streaming.js'), 'utf8'), F);
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
const L = require('../tools/mission45g-build-lod0.cjs');
const E = require('../tools/mission45e-preview.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm45g-'));
// vm 内で作られたオブジェクトは realm が違うので deepStrictEqual が構造一致でも失敗する。JSON で比較する。
const same = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);

test('requestRenderMode: 45M 以降は ?rr=1 のときだけ ON（ext45 でも既定 OFF）', () => {
  assert.strictEqual(P.useRequestRender(true, null), false);
  assert.strictEqual(P.useRequestRender(true, '0'), false);
  assert.strictEqual(P.useRequestRender(true, '1'), true);
  assert.strictEqual(P.useRequestRender(false, null), false);
  assert.strictEqual(P.useRequestRender(false, '1'), true);
});

test('resolution controller: 動作中に遅ければ下げ、下限を守り、止まれば戻す。fixed は不変', () => {
  const c = P.createResolutionController({});
  let changes = 0, last = 1;
  for (let i = 0; i < 400; i++) { const s = c.frame(80, true); if (s !== null) { changes++; last = s; assert.ok(s >= P.DEFAULTS.minScale - 1e-9); } }
  assert.ok(changes >= 1 && last === P.DEFAULTS.minScale, 'floor reached: ' + last);
  assert.ok(changes <= 6, 'cooldown prevents thrash: ' + changes);
  let back = null; for (let i = 0; i < 30 && back === null; i++) back = c.frame(16, false);
  assert.strictEqual(back, P.DEFAULTS.maxScale);
  const f = P.createResolutionController({ fixed: true });
  for (let i = 0; i < 200; i++) assert.strictEqual(f.frame(200, true), null);
  const fast = P.createResolutionController({});
  for (let i = 0; i < 200; i++) assert.strictEqual(fast.frame(12, true), null, 'fast frames never lower quality');
});

test('inView: 真下は常に true、斜めで真後ろの遠い区だけ false、近い区は残す', () => {
  const bb = { minX: 10000, maxX: 12000, minZ: -1000, maxZ: 1000 };
  const base = { x: 0, z: 0, headingRad: 0, fovRad: 1, aspect: 1.6 };   // heading 0 = 北 = -z を向く
  assert.strictEqual(P.inView(Object.assign({ pitchRad: -Math.PI / 2 }, base), bb), true);
  const tilted = Object.assign({ pitchRad: -0.5 }, base);
  assert.strictEqual(P.inView(tilted, bb), false, 'east, 90deg off the view direction');
  assert.strictEqual(P.inView(Object.assign({}, tilted, { headingRad: Math.PI / 2 }), bb), true, 'facing east');
  assert.strictEqual(P.inView(tilted, { minX: -500, maxX: 500, minZ: 800, maxZ: 1600 }), true, 'behind but within nearKeep');
  assert.strictEqual(P.inView(tilted, { minX: -500, maxX: 500, minZ: -9000, maxZ: -7000 }), true, 'straight ahead');
});

test('cullPlan: coarse だけ外す。detail は残す。mounted の外れた coarse は drop に入る', () => {
  const wards = [{ wardCode: 'A', bbox: { minX: 10000, maxX: 12000, minZ: -1000, maxZ: 1000 } }, { wardCode: 'B', bbox: { minX: 10000, maxX: 12000, minZ: -1000, maxZ: 1000 } }];
  const cam = { x: 0, z: 0, headingRad: 0, pitchRad: -0.5, fovRad: 1, aspect: 1.6 };
  const r = P.cullPlan({ want: { A: 'coarse', B: 'detail' }, drop: [] }, cam, wards, { A: 'coarse' });
  same(r.want, { B: 'detail' });
  same(r.drop, ['A']);
  same(r.culled, ['A']);
  const r2 = P.cullPlan({ want: { A: 'coarse' }, drop: [] }, cam, wards, {});
  same(r2.drop, [],'never mounted -> nothing to drop');
});

test('45F plan と組み合わせた実 24 区: 全域俯瞰では cull されず、斜めで一方向を見たときだけ減る', () => {
  const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
  const cx = wards.map((w) => (w.bbox.minX + w.bbox.maxX) / 2).reduce((a, b) => a + b) / 24, cz = wards.map((w) => (w.bbox.minZ + w.bbox.maxZ) / 2).reduce((a, b) => a + b) / 24;
  const top = F.LC45F.plan({ x: cx, z: cz, height: 40000 }, wards, {});
  const cullTop = P.cullPlan(top, { x: cx, z: cz, headingRad: 0, pitchRad: -Math.PI / 2, fovRad: 1, aspect: 1.6 }, wards, {});
  same(cullTop.culled, []);
  const side = F.LC45F.plan({ x: cx, z: cz + 6000, height: 8000 }, wards, {});
  const cullSide = P.cullPlan(side, { x: cx, z: cz + 6000, headingRad: 0, pitchRad: -0.4, fovRad: 0.9, aspect: 1.6 }, wards, {});
  for (const [c, l] of Object.entries(cullSide.want)) assert.ok(side.want[c] === l);
  assert.ok(Object.values(cullSide.want).filter((v) => v === 'detail').length === Object.values(side.want).filter((v) => v === 'detail').length, 'detail untouched');
});

test('cacheBudget: 合計予算を tileset 数で割り、下限・overflow を持つ（Cesium 既定 512MB×n を超えない）', () => {
  const b1 = P.cacheBudget(1), b10 = P.cacheBudget(10), b100 = P.cacheBudget(100);
  assert.strictEqual(b1.perMB, 768);
  assert.ok(b10.perMB * 10 <= 768 + 10);
  assert.strictEqual(b100.perMB, P.DEFAULTS.cacheMinMB);
  assert.strictEqual(b10.maximumCacheOverflowBytes, 64 * 1048576);
});

test('summarizeFrames / netSummary: 数値を捏造しない・URL を返さない', () => {
  assert.strictEqual(P.summarizeFrames([]), null);
  const s = P.summarizeFrames([10, 10, 10, 10, 50]);
  assert.strictEqual(s.n, 5); assert.strictEqual(s.maxMs, 50); assert.ok(s.avgFps > 0);
  const n = P.netSummary([{ name: 'http://127.0.0.1:8137/ext-3dtiles/kita/tiles/a.glb?x=1', transferSize: 1000 }, { name: 'http://127.0.0.1:8137/ext-3dtiles/kita/tileset.json', transferSize: 10 }, { name: 'https://cdn.example/x.js', transferSize: 99999 }]);
  same(n, { requests: 2, bytes: 1010, glb: 1, json: 1, other: 0 });
  assert.ok(!JSON.stringify(n).includes('kita'));
});

// ---- LOD0 ビルド（合成 45D 風 fixture） ----
function fixture(root, wardDir, code, blds) {
  const d = path.join(root, wardDir);
  fs.mkdirSync(path.join(d, 'attrs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify({ wardCode: code }));
  const byId = {};
  blds.forEach((b, i) => { byId['bldg_' + code + '_' + i] = [b[2], '411', b[0], b[1], 0]; });
  fs.writeFileSync(path.join(d, 'attrs', 't_0_0.json'), JSON.stringify({ tx: 0, tz: 0, count: blds.length, fields: ['h', 'usage', 'repX', 'repZ', 'z0'], byId }));
}
function synth(root) {
  const a = [], b = [];
  for (let i = 0; i < 40; i++) a.push([(i % 8) * 25 - 1700, Math.floor(i / 8) * 25 - 3000, 8 + (i % 5)]);
  a.push([-1500, -2000, 29997]);   // sentinel（平均に入れない）
  a.push([-900, -800, 12]);        // 単独セル（min-count 未満 → ブロック化しない）
  for (let i = 0; i < 12; i++) b.push([500 + (i % 4) * 30, 500 + Math.floor(i / 4) * 30, 20]);
  fixture(root, 'pc23/kita-a1', '27127', a); fixture(root, 'sumiyoshi-a1/sumiyoshi', '27120', b);
}

test('LOD0 build: 決定的・概略ブロック(実棟ではない)・単独棟はブロック化しない・sentinel を平均から除く', () => {
  const src = tmp(), o1 = tmp(), o2 = tmp(); synth(src);
  fs.rmSync(o1, { recursive: true }); fs.rmSync(o2, { recursive: true });
  const r1 = L.run({ src, out: o1 }), r2 = L.run({ src, out: o2 });
  assert.strictEqual(r1.totals.wards, 2);
  assert.strictEqual(r1.notRealBuildings, true);
  const k = r1.wards.find((w) => w.wardCode === '27127');
  assert.strictEqual(k.sourceBuildings, 42); assert.strictEqual(k.badHeight, 1);
  assert.ok(k.cellsEmitted >= 1 && k.buildingsInEmittedCells < k.sourceBuildings, 'lone building not blocked');
  assert.ok(r1.totals.glbBytes > 0 && r1.totals.glbBytes < 20000, 'tiny: ' + r1.totals.glbBytes);
  for (const f of ['27127/tileset.json', '27127/tiles/lod0.glb', '27120/tileset.json', 'lod0-report.json', L.MARKER]) assert.ok(fs.existsSync(path.join(o1, f)), f);
  assert.ok(fs.readFileSync(path.join(o1, '27127/tiles/lod0.glb')).equals(fs.readFileSync(path.join(o2, '27127/tiles/lod0.glb'))), 'deterministic bytes');
  assert.strictEqual(fs.readFileSync(path.join(o1, 'lod0-report.json'), 'utf8'), fs.readFileSync(path.join(o2, 'lod0-report.json'), 'utf8'));
  const ts = JSON.parse(fs.readFileSync(path.join(o1, '27127/tileset.json'), 'utf8'));
  assert.strictEqual(ts.extras.notRealBuildings, true);
  const glb = fs.readFileSync(path.join(o1, '27127/tiles/lod0.glb'), 'utf8');
  assert.ok(glb.includes('lod0_27127_') && !glb.includes('bldg_'), 'ids are lod0_*, never canonicalId');
  // 入力は不変
  assert.ok(fs.readdirSync(path.join(src, 'pc23/kita-a1')).sort().join() === 'attrs,source.json');
});

test('LOD0 build: --plan は何も書かない / 出力は入力の内外・リポジトリ内・非空の他人のフォルダを拒否 / マーカー付きは再実行可', () => {
  const src = tmp(); synth(src);
  const o = tmp(); fs.rmSync(o, { recursive: true });
  const r = L.run({ src, out: o, plan: true });
  assert.ok(r.totals.cellsEmitted > 0); assert.ok(!fs.existsSync(o));
  assert.throws(() => L.run({ src, out: path.join(src, 'lod0') }), (e) => e.code === 4);
  assert.throws(() => L.run({ src, out: path.join(ROOT, 'public', 'x-lod0') }), (e) => e.code === 4);
  const foreign = tmp(); fs.writeFileSync(path.join(foreign, 'keep.txt'), 'x');
  assert.throws(() => L.run({ src, out: foreign }), (e) => e.code === 4);
  assert.strictEqual(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8'), 'x');
  L.run({ src, out: o }); L.run({ src, out: o });   // 2 回目はマーカーで許可
  assert.throws(() => L.run({ src, out: tmp(), cell: 50 }), (e) => e.code === 2);
  assert.throws(() => L.run({ src: tmp(), out: tmp() }), (e) => e.code === 3);
});

test('LOD0 build: 45D ルート内に作らない設計（45D の許可名ルールとぶつからない）', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/mission45g-build-lod0.cjs'), 'utf8');
  assert.ok(/inside\(o, src\) \|\| inside\(src, o\)/.test(s));
  for (const bad of ['rmSync', 'unlinkSync', 'rmdirSync', 'renameSync', 'copyFileSync', 'http.', 'https.', 'fetch(', 'child_process']) assert.ok(!s.includes(bad), bad);
});

// ---- 45E サーバーの LOD0 配信 ----
function get(port, p) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p, headers: { Host: '127.0.0.1:' + port } }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c) })); }).on('error', rej));
}
test('45E サーバー: --lod0 はマーカー必須、index.json に lod0Wards、tileset.json と lod0.glb だけ配信、他は 404', async () => {
  const src = tmp(); synth(src); const o = tmp(); fs.rmSync(o, { recursive: true }); L.run({ src, out: o });
  assert.throws(() => E.lod0Plan(tmp()), (e) => e.code === 3);
  const lod0 = E.lod0Plan(o);
  assert.deepStrictEqual(lod0.wards, ['27120', '27127']);
  const srv = E.makeServer([], () => port, false, lod0); let port;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); port = srv.address().port;
  try {
    const idx = JSON.parse((await get(port, '/ext-3dtiles/index.json')).body.toString());
    assert.deepStrictEqual(idx.lod0Wards, ['27120', '27127']);
    assert.strictEqual((await get(port, '/ext-3dtiles/_lod0/27127/tileset.json')).status, 200);
    assert.strictEqual((await get(port, '/ext-3dtiles/_lod0/27127/tiles/lod0.glb')).status, 200);
    for (const bad of ['/ext-3dtiles/_lod0/27127/lod0-report.json', '/ext-3dtiles/_lod0/99999/tileset.json', '/ext-3dtiles/_lod0/27127/../../x', '/ext-3dtiles/_lod0/.livecity-45g-lod0.json']) assert.strictEqual((await get(port, bad)).status, 404, bad);
  } finally { srv.close(); }
  const srv2 = E.makeServer([], () => port2, false, null); let port2;
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r)); port2 = srv2.address().port;
  try { assert.deepStrictEqual(JSON.parse((await get(port2, '/ext-3dtiles/index.json')).body.toString()).lod0Wards, []); assert.strictEqual((await get(port2, '/ext-3dtiles/_lod0/27127/tileset.json')).status, 404); } finally { srv2.close(); }
});

// ---- ページ配線（静的） ----
test('ページ配線: RR / 解像度 / 予算 / cull / LOD0 / 計測が localhost の ext45 に限られ、無効化パラメータがある', () => {
  assert.ok(html.includes('mission45g-perf.js'));
  assert.ok(/requestRenderMode: RR, maximumRenderTimeChange: Infinity/.test(html));
  assert.ok(/const EXT45 = \/\^\(localhost\|127\\\.0\\\.0\\\.1\)\$\/\.test\(location\.hostname\) && q\.get\('ext45'\) === '1'/.test(html));
  for (const p of ["q.get('rr')", "q.get('res')", "q.get('cache')", "q.get('cull')", "q.get('lod0')", "q.get('dpr')", "q.get('perf')"]) assert.ok(html.includes(p), p);
  assert.ok(html.includes('LC45G.cullPlan') && html.includes('LC45G.createResolutionController') && html.includes('LC45G.cacheBudget'));
  assert.ok(html.includes('totalMemoryUsageInBytes') && html.includes('window.__mission45g'));
  assert.ok(/anyLoading\(\)/.test(html) && /scene\.requestRender\(\);\s*\/\/ 読み込み中は 250ms/.test(html), 'loading keeps requesting renders');
  assert.ok(html.includes('ext-3dtiles/_lod0/'), 'lod0 base');
  assert.ok(!/maps\.googleapis|places\.googleapis|PAID_GOOGLE_PHOTOS_ENABLED\s*=\s*true/.test(fs.readFileSync(path.join(ROOT, 'public/mission45g-perf.js'), 'utf8')));
});

test('ページ配線: 45F の detail/coarse 上限・近景詳細・選択1区モードは変わっていない / LOD0 クリックは canonicalId にならない', () => {
  assert.strictEqual(F.LC45F.DEFAULTS.detailMax, 2); assert.strictEqual(F.LC45F.DEFAULTS.coarseMax, 8);
  assert.ok(/!\/\^bldg_\/\.test\(id\)\) \{ clickTown/.test(html), 'non-bldg_ ids fall to town click');
  assert.ok(html.includes("const show = (code) => !allSets.has(code) && allMode"), 'LOD0 hidden where 45F mounts real buildings');
  assert.ok(!/lod0.*bldg_/.test(fs.readFileSync(path.join(ROOT, 'tools/mission45g-build-lod0.cjs'), 'utf8').split('\n').filter((l) => /id: 'lod0_/.test(l)).join('')));
});
