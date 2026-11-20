'use strict';
// Mission 213: sweep の経路計画・再開・判定(純関数)の単体テスト。ブラウザ/ネットワーク不要。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REG = path.join(__dirname, '..', 'config', 'wards', 'registry.json');

function fakeExt() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  const wards = JSON.parse(fs.readFileSync(REG, 'utf8')).wards;
  wards.forEach((w, i) => {
    const d = path.join(root, w.id, 'attrs'); fs.mkdirSync(d, { recursive: true });
    const x = (i % 6) * 2500, z = Math.floor(i / 6) * 2500;
    fs.writeFileSync(path.join(d, 't_0_0.json'), JSON.stringify({ fields: ['h', 'usage', 'repX', 'repZ', 'z0'], byId: { ['b' + i]: [10, null, x, z, 0] } }));
  });
  return root;
}

test('経路: 24区の中心が全て含まれ、区境は重複せず、index が 0..n-1 で決定的', async () => {
  const { planRoute } = await import('../tools/cloud/sweep-plan.mjs');
  const a = planRoute(fakeExt(), REG), b = planRoute(fakeExt(), REG);
  assert.strictEqual(a.wardsFound, 24);
  assert.strictEqual(a.route.filter((p) => p.kind === 'ward-center').length, 24);
  const borders = a.route.filter((p) => p.kind === 'ward-border').map((p) => p.ward);
  assert.strictEqual(new Set(borders).size, borders.length);
  assert.deepStrictEqual(a.route.map((p) => p.index), a.route.map((_, i) => i));
  assert.deepStrictEqual(a.route.map((p) => p.ward), b.route.map((p) => p.ward), '再開のため経路は決定的');
});

test('再開: ok/hole は撮り直さず not-loaded/camera-not-held は撮り直す。start-point で前半を飛ばす', async () => {
  const { planRoute, pendingWork } = await import('../tools/cloud/sweep-plan.mjs');
  const { route } = planRoute(fakeExt(), REG), alts = [3000, 10000];
  const p0 = route[0], p1 = route[1];
  const prev = [
    { kind: p0.kind, ward: p0.ward, alt: 3000, status: 'ok' },
    { kind: p0.kind, ward: p0.ward, alt: 10000, status: 'not-loaded' },
    { kind: p1.kind, ward: p1.ward, alt: 3000, status: 'hole' },
  ];
  const w = pendingWork(route, alts, { prevRows: prev });
  assert.deepStrictEqual(w[0].alts, [10000]);
  assert.deepStrictEqual(w[1].alts, [10000]);
  assert.strictEqual(w[2].alts.length, 2);
  const w2 = pendingWork(route, alts, { startPoint: 10 });
  assert.strictEqual(w2[0].point.index, 10);
  assert.strictEqual(w2.length, route.length - 10);
  // 全確定なら残りなし
  const all = route.flatMap((p) => alts.map((h) => ({ kind: p.kind, ward: p.ward, alt: h, status: 'ok' })));
  assert.strictEqual(pendingWork(route, alts, { prevRows: all }).length, 0);
});

test('判定: 未ロードは hole にしない / LOD0=0 かつ実建物も 0 の時だけ hole / 実建物が覆う場合は別集計', async () => {
  const { classify, summarize } = await import('../tools/cloud/sweep-plan.mjs');
  const m = 0.02;
  assert.strictEqual(classify({ held: false, loaded: true, lod0Share: 0, realShare: 0, minShare: m }), 'camera-not-held');
  assert.strictEqual(classify({ held: true, loaded: false, lod0Share: 0, realShare: 0, minShare: m }), 'not-loaded');
  assert.strictEqual(classify({ held: true, loaded: true, lod0Share: 0.4, realShare: 0, minShare: m }), 'ok');
  assert.strictEqual(classify({ held: true, loaded: true, lod0Share: 0, realShare: 0, minShare: m }), 'hole');
  assert.strictEqual(classify({ held: true, loaded: true, lod0Share: 0, realShare: 0.3, minShare: m }), 'covered-by-real');
  assert.strictEqual(summarize([{ status: 'hole', kind: 'ward-center', ward: 'a' }, { status: 'covered-by-real', kind: 'ward-border', ward: 'a|b' }]).coveredByReal, 1);
});

test('統合: 同一キーは今回の行が優先', async () => {
  const { mergeRows } = await import('../tools/cloud/sweep-plan.mjs');
  const m = mergeRows([{ kind: 'k', ward: 'w', alt: 1, status: 'not-loaded' }], [{ kind: 'k', ward: 'w', alt: 1, status: 'ok' }]);
  assert.strictEqual(m.length, 1); assert.strictEqual(m[0].status, 'ok');
});

test('CI バッチ: ラベルから start-point を厳密に解釈 / 集計に index 範囲と次ラベルを出す', async () => {
  const { parseBatchLabel, renderBatchSummary } = await import('../tools/cloud/sweep-plan.mjs');
  assert.deepStrictEqual(parseBatchLabel('run-mission213-qa'), { startPoint: 0 });
  assert.deepStrictEqual(parseBatchLabel('run-mission213-qa:24'), { startPoint: 24 });
  for (const bad of ['run-mission213-qa:', 'run-mission213-qa:-1', 'run-mission213-qa:1;rm', 'run-mission213-qa:1234', 'x-run-mission213-qa', '', null]) assert.strictEqual(parseBatchLabel(bad), null, String(bad));
  const qa = { sweep: { routePlanned: 62, startPoint: 12, wardsFound: 24, nextStartPoint: 24, truncated: 'max-points', summary: { points: 2 }, rows: [
    { index: 12, kind: 'ward-center', ward: 'a', alt: 3000, lod0Share: 0.4, realShare: 0.1, loaded: true, status: 'ok' },
    { index: 23, kind: 'ward-border', ward: 'a|b', alt: 10000, lod0Share: 0, realShare: 0, loaded: false, status: 'not-loaded' }] } };
  const md = renderBatchSummary(qa, { runId: 1, sha: 'abc' });
  assert.match(md, /12〜23/); assert.match(md, /run-mission213-qa:24/); assert.match(md, /#23 a\|b@10000m=not-loaded/);
  assert.match(renderBatchSummary(null), /sweep なし/);
});

test('classifyCellPure: --cells のセル分類(fixture)', async () => {
  const { classifyCellPure: f } = await import('../tools/cloud/sweep-plan.mjs');
  const base = { W: 1000, H: 800 };
  assert.strictEqual(f({ ...base, hidden: true, w: { x: 500, y: 400 }, d9: true, d3: true }), 'hidden');
  assert.strictEqual(f({ ...base, hidden: false, w: null }), 'offscreen');
  assert.strictEqual(f({ ...base, hidden: false, w: { x: 2, y: 400 } }), 'offscreen');
  assert.strictEqual(f({ ...base, hidden: false, w: { x: 500, y: 797 } }), 'offscreen');
  assert.strictEqual(f({ ...base, hidden: false, w: { x: 500, y: 400 }, d9: true, d3: true }), 'realUnder3');
  assert.strictEqual(f({ ...base, hidden: false, w: { x: 500, y: 400 }, d9: true, d3: false }), 'realUnder9only');
  assert.strictEqual(f({ ...base, hidden: false, w: { x: 500, y: 400 }, d9: false, d3: false }), 'noRealUnder');
  // toString() でブラウザ埋め込み可能(外部参照なし)
  assert.strictEqual(new Function('return (' + f.toString() + ')')()({ ...base, hidden: false, w: { x: 5, y: 5 } }), 'noRealUnder');
});

test('swapStable / comparableDiag: 置換状態の安定判定と比較可否(fixture)', async () => {
  const { swapStable, comparableDiag } = await import('../tools/cloud/sweep-plan.mjs');
  const mk = (o = {}) => ({ swapEnabled: true, hidden: 436, visible: 102, total: 538, tilesLoaded: true, camH: 6000, viewport: { w: 800, h: 600 }, ...o });
  assert.equal(swapStable([mk(), mk(), mk()]), true);
  assert.equal(swapStable([mk(), mk(), mk({ hidden: 0, visible: 538 })]), false, '末尾が変動');
  assert.equal(swapStable([mk(), mk()]), false, 'サンプル不足');
  assert.equal(swapStable([mk(), mk(), mk({ tilesLoaded: false })]), false, '未ロード');
  assert.equal(comparableDiag(mk(), mk()).comparable, true);
  // 天王寺6km の実例: --cells は hidden 436、--compare は hidden 0 → 比較不可
  const r = comparableDiag(mk(), mk({ hidden: 0, visible: 538 }));
  assert.equal(r.comparable, false); assert.ok(r.reasons.some((x) => /hidden=0/.test(x)));
  assert.equal(comparableDiag(mk(), mk({ swapEnabled: false })).comparable, false);
  assert.equal(comparableDiag(mk(), mk({ camH: 30000 })).comparable, false);
  assert.equal(comparableDiag(mk(), mk({ viewport: { w: 1, h: 1 } })).comparable, false);
  assert.equal(comparableDiag(null, mk()).comparable, false);
});
