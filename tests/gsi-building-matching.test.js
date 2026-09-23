// tests/gsi-building-matching.test.js
// [Mission 31G-FIX20] matching / statistics / regression / classification ロジックの単体テスト。
// 実 GSI データが無いため、合成 fixture で「正しい既知の答え」を復元できることを検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  precomputeMetrics, matchBuildings, summarizeTranslation, spatialRegression, classifyShift,
  approximateIoU, ringArea, ringCentroid,
} from '../tools/lib/gsi-building-matching.js';

function sq(cx, cz, w = 10, h = 8) {
  return [[cx - w / 2, cz - h / 2], [cx + w / 2, cz - h / 2], [cx + w / 2, cz + h / 2], [cx - w / 2, cz + h / 2], [cx - w / 2, cz - h / 2]];
}

test('ringArea / ringCentroid: 単純矩形で正しい値', () => {
  const ring = sq(10, 20, 10, 8);
  assert.equal(ringArea(ring), 80);
  const [cx, cz] = ringCentroid(ring);
  assert.ok(Math.abs(cx - 10) < 1e-9 && Math.abs(cz - 20) < 1e-9);
});

test('approximateIoU: 完全一致は1・完全に離れていれば0', () => {
  const a = sq(0, 0);
  assert.ok(approximateIoU(a, a) > 0.99);
  const far = sq(1000, 1000);
  assert.equal(approximateIoU(a, far), 0);
});

test('matchBuildings: §7 単純nearest centroidだけでなく形状も見る（近いが全く違う形状は弾く）', () => {
  const a = precomputeMetrics({ id: 'a', ring: sq(0, 0, 10, 8) });
  // b: 中心はaに近いが面積が10倍・形状も違う → area類似度が低くHIGHにならないはず
  const b = precomputeMetrics({ id: 'b', ring: sq(1, 1, 40, 30) });
  const matches = matchBuildings([a], [b]);
  assert.notEqual(matches[0].confidence, 'MATCH_HIGH', '面積が大きく異なるのにHIGH matchになった: ' + JSON.stringify(matches[0]));
});

test('matchBuildings + summarizeTranslation: 既知の一定オフセットを正しく復元する（CONSTANT_TRANSLATION）', () => {
  const A = [], B = [];
  const DX = 1.2, DZ = -0.8;
  for (let i = 0; i < 200; i++) {
    const x = (Math.random() - 0.5) * 4000, z = (Math.random() - 0.5) * 4000;
    A.push(precomputeMetrics({ id: 'a' + i, ring: sq(x, z) }));
    B.push(precomputeMetrics({ id: 'b' + i, ring: sq(x + DX, z + DZ) }));
  }
  const matches = matchBuildings(A, B);
  const high = matches.filter((m) => m.confidence === 'MATCH_HIGH');
  assert.ok(high.length >= 190, 'HIGH match が少なすぎる: ' + high.length);
  const summary = summarizeTranslation(high);
  assert.ok(Math.abs(summary.medianDx - DX) < 0.01, 'medianDx が既知オフセットと一致しない: ' + summary.medianDx);
  assert.ok(Math.abs(summary.medianDz - DZ) < 0.01, 'medianDz が既知オフセットと一致しない: ' + summary.medianDz);
  const reg = spatialRegression(high);
  const cls = classifyShift(summary, reg);
  assert.equal(cls.classification, 'CONSTANT_TRANSLATION');
});

test('classifyShift: median dx/dz が実質ゼロなら NO_SYSTEMATIC_SHIFT', () => {
  const A = [], B = [];
  for (let i = 0; i < 150; i++) {
    const x = (Math.random() - 0.5) * 3000, z = (Math.random() - 0.5) * 3000;
    A.push(precomputeMetrics({ id: 'a' + i, ring: sq(x, z) }));
    B.push(precomputeMetrics({ id: 'b' + i, ring: sq(x, z) }));
  }
  const matches = matchBuildings(A, B);
  const high = matches.filter((m) => m.confidence === 'MATCH_HIGH');
  const summary = summarizeTranslation(high);
  const cls = classifyShift(summary, spatialRegression(high));
  assert.equal(cls.classification, 'NO_SYSTEMATIC_SHIFT');
});

test('classifyShift: 位置依存の回転はROTATIONとして検出する（medianが0近くでも見逃さない）', () => {
  const A = [], B = [];
  const theta = 0.002;
  for (let i = 0; i < 400; i++) {
    const x = (Math.random() - 0.5) * 8000, z = (Math.random() - 0.5) * 8000;
    const bx = x * Math.cos(theta) - z * Math.sin(theta);
    const bz = x * Math.sin(theta) + z * Math.cos(theta);
    A.push(precomputeMetrics({ id: 'a' + i, ring: sq(x, z) }));
    B.push(precomputeMetrics({ id: 'b' + i, ring: sq(bx, bz) }));
  }
  const matches = matchBuildings(A, B);
  const high = matches.filter((m) => m.confidence === 'MATCH_HIGH' || m.confidence === 'MATCH_MEDIUM');
  assert.ok(high.length >= 100, 'match数が少なすぎてテストにならない: ' + high.length);
  const summary = summarizeTranslation(high);
  const reg = spatialRegression(high);
  const cls = classifyShift(summary, reg);
  assert.equal(cls.classification, 'ROTATION', JSON.stringify({ cls, summary }));
});

test('matchBuildings: 候補が検索半径内に無ければ UNMATCHED', () => {
  const a = precomputeMetrics({ id: 'a', ring: sq(0, 0) });
  const b = precomputeMetrics({ id: 'b', ring: sq(500, 500) });
  const matches = matchBuildings([a], [b]);
  assert.equal(matches[0].confidence, 'UNMATCHED');
  assert.equal(matches[0].bId, null);
});

test('matchBuildings: mutual best match でない場合はHIGHにならない（§7 曖昧な複数対1を弾く）', () => {
  // a1とa2の両方がbに近いが、bにとってmutual bestになれるのは1つだけ
  const a1 = precomputeMetrics({ id: 'a1', ring: sq(0, 0) });
  const a2 = precomputeMetrics({ id: 'a2', ring: sq(3, 0) });
  const b = precomputeMetrics({ id: 'b', ring: sq(0.2, 0) });   // a1に非常に近い
  const matches = matchBuildings([a1, a2], [b]);
  const m1 = matches.find((m) => m.aId === 'a1'), m2 = matches.find((m) => m.aId === 'a2');
  // a1-b は mutual のはず。a2-b は a1 の方がbのbestなので mutual にならない。
  assert.equal(m1.bId, 'b');
  assert.equal(m1.mutual, true);
  if (m2.bId === 'b') assert.equal(m2.mutual, false, 'a2-bがmutualと誤判定された');
});
