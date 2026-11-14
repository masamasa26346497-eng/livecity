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
test('高さ: 根拠値優先 / 階数は estimated / 根拠なしは unknown（DEM不使用）', () => {
  assert.deepEqual(resolveHeight({ height: 12 }), { heightM: 12, heightSource: 'source-height-attribute', estimated: false });
  const r = resolveHeight({ levels: 4 }); assert.equal(r.heightM, 12); assert.equal(r.estimated, true);
  assert.deepEqual(resolveHeight({}), { heightM: null, heightSource: 'unknown', estimated: false });
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
