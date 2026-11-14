// tests/building-supplement-diff.test.js [Issue #65] 一般化した合成入力（実測ではない）で判定ロジックを検証。
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCandidates, classifyCandidate, buildIndex, resolveHeight, DECISION, boundaryDistance } from '../tools/lib/building-supplement-diff.js';

const sq = (x, z, w, h = w) => [[x, z], [x + w, z], [x + w, z + h], [x, z + h]];
const ctx = { source: 'synthetic', sourceVersion: 't1', license: 'unknown' };
const ex = (id, ring) => ({ id, ring });
const cls = (c, e) => classifyCandidate(c, buildIndex(e));

test('完全一致・包含・位置ずれ重なりは既存一致（新規採用しない）', () => {
  const e = [ex('P1', sq(0, 0, 20))];
  assert.equal(cls({ id: 'a', ring: sq(0, 0, 20) }, e).decision, DECISION.MATCH_EXISTING);
  assert.equal(cls({ id: 'b', ring: sq(5, 5, 8) }, e).decision, DECISION.MATCH_EXISTING);   // 既存に包含
  assert.equal(cls({ id: 'c', ring: sq(4, 3, 20) }, e).decision, DECISION.MATCH_EXISTING);  // 位置ずれ
  assert.equal(cls({ id: 'd', ring: sq(-5, -5, 40) }, e).reason, 'existing-contains-existing');
});
test('分棟/合棟: 複数の既存と重なる候補は split-or-merged', () => {
  const e = [ex('P1', sq(0, 0, 10)), ex('P2', sq(10, 0, 10))];
  const v = cls({ id: 'm', ring: sq(0, 0, 20, 10) }, e);
  assert.equal(v.decision, DECISION.MATCH_EXISTING); assert.equal(v.reason, 'existing-split-or-merged'); assert.equal(v.partners.length, 2);
});
test('境界: 辺共有の同規模は位置ずれ疑いで保留、離れていれば新規、近接でも面積比が小さければ新規', () => {
  const e = [ex('P1', sq(0, 0, 20))];
  assert.equal(cls({ id: 'n', ring: sq(20, 0, 20) }, e).decision, DECISION.HOLD);        // 辺共有・同規模 → offset疑い
  assert.equal(cls({ id: 'n2', ring: sq(60, 0, 20) }, e).decision, DECISION.NEW_CANDIDATE);
  assert.equal(cls({ id: 'n3', ring: sq(22, 0, 6) }, e).decision, DECISION.NEW_CANDIDATE); // 近接だが面積比が小さい
});
test('保留: 極小・細長・不正形状・親不明の building_part', () => {
  const e = [ex('P1', sq(0, 0, 10))];
  assert.equal(cls({ id: 's', ring: sq(100, 0, 2) }, e).reason, 'too-small');
  assert.equal(cls({ id: 'l', ring: sq(100, 0, 200, 4) }, e).reason, 'too-elongated');
  assert.equal(cls({ id: 'i', ring: [[0, 0], [1, 1]] }, e).reason, 'invalid-geometry');
  assert.equal(cls({ id: 'bp', ring: sq(100, 0, 10), buildingPartOf: 'X' }, e).decision, DECISION.HOLD);
});
test('候補は既存ジオメトリを変更しない（切り抜きなし）', () => {
  const e = [ex('P1', sq(0, 0, 20))]; const snap = JSON.stringify(e);
  const c = { id: 'c', ring: sq(10, 0, 20) }; const cs = JSON.stringify(c);
  cls(c, e); assert.equal(JSON.stringify(e), snap); assert.equal(JSON.stringify(c), cs);
});
test('高さ: height属性だけでは実測扱いしない / 明示実測のみ estimated:false / 階数は推定 / 根拠なしは unknown', () => {
  const a = resolveHeight({ height: 12 });
  assert.equal(a.heightM, 12); assert.equal(a.estimated, null); assert.equal(a.heightSource, 'source-height-attribute-unverified');
  const m = resolveHeight({ height: 12, heightSource: 'plateau-measuredHeight', heightEstimated: false, heightAccuracy: 'LOD1' });
  assert.equal(m.estimated, false); assert.equal(m.heightSource, 'plateau-measuredHeight'); assert.equal(m.heightAccuracy, 'LOD1');
  assert.equal(resolveHeight({ height: 9, heightEstimated: true }).estimated, true);
  assert.equal(resolveHeight({ height: 12, heightEstimated: false }).estimated, null); // 出所なしの false は信用しない
  const r = resolveHeight({ levels: 4 }); assert.equal(r.heightM, 12); assert.equal(r.estimated, true);
  assert.deepEqual(resolveHeight({}), { heightM: null, heightSource: 'unknown', estimated: false, heightAccuracy: null });
  assert.equal(resolveHeight({ groundElevation: 30 }).heightM, null);
});
test('冪等性: 入力順に依存せず同一出力・必須フィールドあり・権利不明はhold-license', () => {
  const e = [ex('P1', sq(0, 0, 20))];
  const cands = [{ id: 'z', ring: sq(100, 0, 10), levels: 3 }, { id: 'a', ring: sq(0, 0, 20) }, { id: 'm', ring: sq(200, 0, 10) }];
  const r1 = auditCandidates(cands, e, ctx), r2 = auditCandidates([...cands].reverse(), e, ctx);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
  for (const k of ['canonicalId', 'source', 'sourceId', 'sourceVersion', 'surveyDate', 'acquiredAt', 'license', 'geometryConfidence', 'heightSource', 'estimated', 'status']) assert.ok(k in r1.records[0], k);
  assert.equal(r1.summary.byDecision.NEW_CANDIDATE, 2);
  assert.equal(r1.summary.heightEstimated, 1); assert.equal(r1.summary.heightUnknown, 1); assert.equal(r1.summary.surveyDateUnknown, 2);
  assert.ok(r1.records.filter((r) => r.decision !== 'x').every((r) => r.representation === 'supplement-extrusion-not-plateau-lod'));
  assert.equal(r1.records.find((r) => r.sourceId === 'z').status, 'candidate-hold-license');
});
test('boundaryDistance', () => { assert.equal(boundaryDistance(sq(0, 0, 10), sq(15, 0, 10)), 5); });

// ---- 第2段階: 厳密幾何（内周・MultiPolygon・凹形状・交差辺・閾値・候補同士重複） ----
const near0 = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const courtyard = [sq(0, 0, 40), sq(10, 10, 20)];                          // 40x40 中庭(穴20x20) 面積1200
const Lshape = [[[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]]];  // L字 面積500
const U = [[[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]]]; // U字 面積 900-...
const cp = (id, polys, extra = {}) => ({ id, polys, ...extra });
const ep = (id, polys) => ({ id, polys });

test('厳密交差面積: 解析解と一致（格子近似ではない）', () => {
  near0(polyIntersection([sq(0, 0, 20)], [sq(10, 10, 20)]).area, 100);
  near0(polyIntersection([sq(0, 0, 20)], [sq(0.3, 0.7, 20)]).area, 19.7 * 19.3);
  near0(polyIntersection(courtyard, [sq(0, 0, 40)]).area, 1200);
  near0(polyIntersection(courtyard, [sq(5, 5, 30)]).area, 500);              // 900 − 穴400
  near0(polyIntersection([sq(0, 0, 10)], [sq(10, 0, 10)]).area, 0);          // 辺共有
  near0(polyIntersection([sq(0, 0, 10)], [sq(0, 0, 10)]).area, 100);         // 同一(共線全面)
  near0(polyIntersection(Lshape, [sq(5, 5, 20)]).area, 175);                 // 凹形状
  near0(polyIntersection(Lshape, [sq(12, 12, 15)]).area, 0);                 // L の凹み内（交差なし）
  near0(polyIntersection(U, [sq(8, 12, 24, 10)]).area, 120);                // U 字: 腕 2+10 幅 × 高さ10
  near0(intersectionArea([sq(0, 0, 10), sq(100, 0, 10)], [sq(5, 0, 100, 10)]).area, 100); // MultiPolygon 50+50
});
test('中庭: 内周内の別建物は既存に誤除外されず新規候補、中庭に跨がれば保留/一致', () => {
  const e = [ep('K', [courtyard])];
  const inHole = classifyCandidate(cp('c1', [[sq(15, 15, 10)]]), buildIndex(e));
  assert.equal(inHole.decision, DECISION.NEW_CANDIDATE);
  assert.equal(inHole.metrics.maxOverlapSmaller, 0);
  const onRing = classifyCandidate(cp('c2', [[sq(2, 2, 6)]]), buildIndex(e));   // 環の中に完全包含
  assert.equal(onRing.decision, DECISION.MATCH_EXISTING); assert.equal(onRing.reason, 'existing-contained-by-existing');
  const straddle = classifyCandidate(cp('c3', [[sq(8, 8, 10)]]), buildIndex(e)); // 環に36 / 穴に64 → 重なり0.36
  assert.equal(straddle.decision, DECISION.HOLD); assert.equal(straddle.reason, 'partial-overlap-unclear');
});
test('既存側の穴に候補 MultiPolygon: パート個別でなく全体面積で判定・内周保持', () => {
  const e = [ep('P', [[sq(0, 0, 20)]])];
  const multi = cp('mp', [[sq(0, 0, 8)], [sq(100, 100, 8)]]); // 片方のみ既存と重なる: 64/128=0.5 → 閾値境界 → 保留
  assert.equal(classifyCandidate(multi, buildIndex(e)).decision, DECISION.HOLD);
  const multi2 = cp('mp2', [[sq(0, 0, 10)], [sq(100, 100, 10)]]); // 100/200=0.5 同上。0.5 ちょうどは保留
  assert.equal(classifyCandidate(multi2, buildIndex(e)).reason, 'threshold-borderline');
  const multi3 = cp('mp3', [[sq(0, 0, 10)], [sq(100, 100, 5)]]); // 100/125=0.8 → 一致
  assert.equal(classifyCandidate(multi3, buildIndex(e)).decision, DECISION.MATCH_EXISTING);
});
test('凹形状: 重心が既存内でも実際は凹みで重ならなければ既存一致にしない', () => {
  // 既存=U字。候補=U の凹み内に置いた小建物。候補の重心は U の bbox 内だが U の外。
  const e = [ep('U', [U])];
  const v = classifyCandidate(cp('in-notch', [[sq(12, 14, 6)]]), buildIndex(e));
  assert.equal(v.decision, DECISION.NEW_CANDIDATE);
  // 逆に、重心が既存の外にある L 字候補が既存を覆えば包含で一致（重心包含に依存しない）
  const big = classifyCandidate(cp('Lcand', [Lshape]), buildIndex([ep('small', [[sq(1, 1, 8)]])]));
  assert.equal(big.decision, DECISION.MATCH_EXISTING); assert.equal(big.reason, 'existing-contains-existing');
});
test('交差する辺（蝶ネクタイ）は不正形状で保留（既存側が不正なら近傍候補も保留）', () => {
  const bow = [[0, 0], [10, 10], [10, 0], [0, 10]];
  assert.equal(classifyCandidate(cp('bow', [[bow]]), buildIndex([ep('P', [[sq(100, 0, 10)]])])).reason, 'invalid-geometry');
  assert.equal(classifyCandidate(cp('n', [[sq(2, 2, 4)]]), buildIndex([ep('bowE', [[bow]])])).reason, 'neighbor-invalid-geometry');
});
test('閾値近傍: 0.5±0.001 は保留、離れていれば決定', () => {
  const e = [ep('P', [[sq(0, 0, 10)]])];
  // 候補 10x10 を x 方向にずらし 重なり比 = (10-dx)/10
  const at = (dx) => classifyCandidate(cp('c', [[sq(dx, 0, 10)]]), buildIndex(e));
  assert.equal(at(5).reason, 'threshold-borderline');          // 0.5 ちょうど
  assert.equal(at(4.995).reason, 'threshold-borderline');      // 0.5005
  assert.equal(at(4).decision, DECISION.MATCH_EXISTING);       // 0.6
  assert.equal(at(6).reason, 'partial-overlap-unclear');       // 0.4
  assert.equal(at(8.5).reason, 'threshold-borderline');        // 0.15
  assert.equal(at(9.5).reason, 'threshold-borderline');        // 0.05
  assert.equal(at(9.7).reason, 'possible-offset-of-existing');  // 0.03: 重なり僅少・面積比1 → 位置ずれ疑い
});
test('候補同士の重複: id 順で先勝ち、後続は candidate-duplicate で保留。順序非依存', () => {
  const e = [ep('P', [[sq(0, 0, 10)]])];
  const c = [cp('b', [[sq(100, 0, 10)]]), cp('a', [[sq(101, 1, 10)]]), cp('z', [[sq(300, 0, 10)]])];
  const r1 = auditCandidates(c, e, ctx), r2 = auditCandidates([...c].reverse(), e, ctx);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
  const by = Object.fromEntries(r1.records.map((r) => [r.sourceId, r]));
  assert.equal(by.a.status, 'candidate-hold-license');
  assert.equal(by.b.decisionReason, 'candidate-duplicate'); assert.equal(by.b.status, 'hold');
  assert.deepEqual(by.b.matchedExistingIds, ['a']);
  assert.equal(r1.summary.byDecision.NEW_CANDIDATE, 2);
});
test('高さ集計: height属性のみは unverified、実測明示のみ measured', () => {
  const e = [ep('P', [[sq(0, 0, 10)]])];
  const c = [cp('h1', [[sq(100, 0, 10)]], { height: 10 }), cp('h2', [[sq(200, 0, 10)]], { height: 10, heightSource: 'src', heightEstimated: false }), cp('h3', [[sq(300, 0, 10)]], { levels: 2 })];
  const s = auditCandidates(c, e, ctx).summary;
  assert.deepEqual([s.heightUnverified, s.heightMeasured, s.heightEstimated, s.heightUnknown], [1, 1, 1, 0]);
});
