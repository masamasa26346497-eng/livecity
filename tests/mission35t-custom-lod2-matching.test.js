// tests/mission35t-custom-lod2-matching.test.js
// [Mission 35T §11] Custom LOD2 の照合精度。
//   いちばん大事なのは「無理にマッチさせない」こと。基準を満たさないものは
//   現行の canonicalId であっても採用せず、LOD1 も消さない。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ringArea, ringBbox, ringCentroid, pointInRing, overlapMetrics, hausdorffApprox,
  evaluateCandidate, decideMatch, rankCandidates, MATCH_RULES,
} from '../tools/lib/footprint-match.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const PATCH = path.join(ROOT, 'tools', 'experiments', 'mission35s_patch_dev.py');
const REPORT_DIR = path.join(ROOT, 'data', 'reports', 'mission35t-custom-lod2-matching');
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);

/** 正方形。(x,z) が左下、一辺 s。 */
const sq = (x, z, s) => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];
const srcOf = (ring) => ({ ring, area: ringArea(ring), centroid: ringCentroid(ring) });
const candOf = (id, ring, h = null) => ({ id, ring, heightM: h });
const evalPair = (a, b, id = 'c1', h = null) => evaluateCandidate(srcOf(a), candOf(id, b, h));

// ── 幾何 ──────────────────────────────────────────────────────────
test('[35T] 面積・重心・内外判定', () => {
  const r = sq(0, 0, 10);
  assert.equal(ringArea(r), 100);
  const c = ringCentroid(r);
  assert.ok(Math.abs(c[0] - 5) < 1e-6 && Math.abs(c[1] - 5) < 1e-6);
  assert.equal(pointInRing(5, 5, r), true);
  assert.equal(pointInRing(15, 5, r), false);
  const b = ringBbox(r);
  assert.deepEqual([b.minX, b.maxX, b.minZ, b.maxZ], [0, 10, 0, 10]);
});

test('[35T] IoU: 同じ形は 1、離れていれば 0', () => {
  const a = sq(0, 0, 20);
  const same = overlapMetrics(a, sq(0, 0, 20));
  assert.ok(same.iou > 0.97, '同じ形の IoU が ' + same.iou);
  assert.ok(same.aCoveredRatio > 0.97 && same.bCoveredRatio > 0.97);
  const far = overlapMetrics(a, sq(200, 200, 20));
  assert.equal(far.iou, 0);
});

test('[35T] IoU: 内包（source が候補の一部）は被覆率で見分けられる', () => {
  // source(20x20) が候補(40x40) の中に完全に入る
  const src = sq(10, 10, 20), cand = sq(0, 0, 40);
  const o = overlapMetrics(src, cand);
  assert.ok(o.aCoveredRatio > 0.97, 'source がほぼ全部入っているのに ' + o.aCoveredRatio);
  assert.ok(o.bCoveredRatio < 0.35, '候補側の被覆率が高すぎる: ' + o.bCoveredRatio);
  assert.ok(o.iou < 0.3, '内包を IoU が高いと誤判定している: ' + o.iou);
});

test('[35T] Hausdorff 近似: ずれるほど大きくなる', () => {
  const a = sq(0, 0, 10);
  assert.ok(hausdorffApprox(a, sq(0, 0, 10)).max < 0.01);
  assert.ok(hausdorffApprox(a, sq(0, 0, 30)).max > 10);
});

// ── §3 判定 ───────────────────────────────────────────────────────
test('[35T §3] ほぼ同じ形なら HIGH（suppression 許可）', () => {
  const src = sq(0, 0, 30);
  const c = evalPair(src, sq(0.5, 0.5, 30));
  const d = decideMatch(c, null);
  assert.equal(d.matchConfidence, 'HIGH', JSON.stringify(c));
  assert.equal(d.lod1SuppressionAllowed, true);
});

test('[35T §3] 重心が近くても IoU が低ければ採用しない', () => {
  // 同じ重心だが、候補がずっと大きい（= 大きな建物の一部を掴んでいる）
  const src = sq(10, 10, 10);
  const c = evalPair(src, sq(0, 0, 30));
  assert.ok(c.centroidDistanceM < 1, '重心は近いはず: ' + c.centroidDistanceM);
  assert.ok(c.iou < MATCH_RULES.MEDIUM.iou, 'IoU が低いはず: ' + c.iou);
  const d = decideMatch(c, null);
  assert.equal(d.matchConfidence, 'UNMATCHED');
  assert.equal(d.lod1SuppressionAllowed, false);
});

test('[35T §3] 面積比が大きすぎれば採用しない', () => {
  const src = sq(0, 0, 10);
  const c = evalPair(src, sq(-5, -5, 20));
  assert.ok(c.areaRatio > MATCH_RULES.MEDIUM.areaRatio[1], '面積比: ' + c.areaRatio);
  assert.notEqual(decideMatch(c, null).matchConfidence, 'HIGH');
  assert.equal(decideMatch(c, null).lod1SuppressionAllowed, false);
});

test('[35T §3/§5] nearest だけでは採用しない', () => {
  // 重心はぴったり同じでも、形がまるで違えば採用しない
  const src = sq(0, 0, 40);
  const tiny = evalPair(src, sq(19, 19, 2));
  assert.ok(tiny.centroidDistanceM < 1, '重心は一致しているはず');
  assert.equal(decideMatch(tiny, null).matchConfidence, 'UNMATCHED');
  // 並び順も IoU が主（最寄りが先頭に来ない）
  const far = evalPair(src, sq(2, 2, 36), 'good');
  const ranked = rankCandidates([tiny, far]);
  assert.equal(ranked[0].canonicalId, 'good', 'IoU の高い方が先頭でない');
});

// ── §4 競合 ───────────────────────────────────────────────────────
test('[35T §4] best と second が僅差なら AMBIGUOUS', () => {
  const src = sq(0, 0, 30);
  const a = evalPair(src, sq(0.5, 0.5, 30), 'a');
  const b = { ...a, canonicalId: 'b', iou: a.iou - 0.02, centroidDistanceM: a.centroidDistanceM + 0.5 };
  const d = decideMatch(a, b);
  assert.equal(d.matchConfidence, 'AMBIGUOUS');
  assert.equal(d.lod1SuppressionAllowed, false);
  assert.ok(d.ambiguousReason, '理由が無い');
});

test('[35T §4] source が複数の建物にまたがるなら AMBIGUOUS', () => {
  const best = { canonicalId: 'a', iou: 0.62, centroidDistanceM: 8, areaRatio: 1.0,
    sourceCoveredRatio: 0.55, candidateCoveredRatio: 0.9 };
  const second = { canonicalId: 'b', iou: 0.30, centroidDistanceM: 14, areaRatio: 0.9,
    sourceCoveredRatio: 0.40, candidateCoveredRatio: 0.8 };
  const d = decideMatch(best, second);
  assert.equal(d.matchConfidence, 'AMBIGUOUS');
  assert.equal(d.lod1SuppressionAllowed, false);
});

test('[35T §7] MEDIUM / AMBIGUOUS / UNMATCHED では LOD1 を消さない', () => {
  const med = { canonicalId: 'm', iou: 0.65, centroidDistanceM: 12, areaRatio: 1.3,
    sourceCoveredRatio: 0.95, candidateCoveredRatio: 0.8 };
  const dm = decideMatch(med, null);
  assert.equal(dm.matchConfidence, 'MEDIUM');
  assert.equal(dm.lod1SuppressionAllowed, false, 'MEDIUM で suppression を許している');
  const un = { canonicalId: 'u', iou: 0.2, centroidDistanceM: 30, areaRatio: 3,
    sourceCoveredRatio: 0.2, candidateCoveredRatio: 0.1 };
  assert.equal(decideMatch(un, null).lod1SuppressionAllowed, false);
  assert.equal(decideMatch(null, null).lod1SuppressionAllowed, false);
  // HIGH だけ許可
  const hi = evalPair(sq(0, 0, 30), sq(0.5, 0.5, 30));
  assert.equal(decideMatch(hi, null).lod1SuppressionAllowed, true);
});

// ── ランタイム（dev HTML） ─────────────────────────────────────────
test('[35T §3/§7] dev ランタイムが IoU 主体の判定と HIGH 限定 suppression になっている', () => {
  const s = read(DEV);
  if (!s.includes('[Mission 35S] CustomLod2Layer')) return;
  assert.match(s, /const MATCH_RULES = \{/);
  assert.match(s, /HIGH: \{ iou: 0\.75, centroidM: 10, areaRatio: \[0\.80, 1\.25\] \}/);
  assert.match(s, /MEDIUM: \{ iou: 0\.60, centroidM: 15, areaRatio: \[0\.70, 1\.40\] \}/);
  assert.match(s, /function overlapMetrics\(ringA, ringB\)/);
  assert.match(s, /function decideMatch\(best, second\)/);
  // §7 HIGH のときだけ LOD1 を消す
  assert.match(s, /stats\.lod1SuppressionAllowed === true && stats\.matchConfidence === 'HIGH'/);
  // 35S の緩い条件は残っていない
  assert.ok(!/MATCH_MAX_SHIFT_WITH_EVIDENCE_M/.test(s), '35S の緩い距離条件が残っている');
  // 候補は全部見る（最寄り 1 棟だけを選ばない）
  assert.match(s, /const CANDIDATE_RADIUS_M = 100;/);
  assert.match(s, /evaluated\.sort\(\(a, b\) => \(b\.iou - a\.iou\) \|\| \(a\.centroidDistanceM - b\.centroidDistanceM\)\)/);
});

test('[35T §8] debug が照合の根拠を返す', () => {
  const s = read(DEV);
  if (!s.includes('[Mission 35S] CustomLod2Layer')) return;
  for (const k of ['matchConfidence', 'bestCandidate', 'secondCandidate', 'iou',
    'sourceCoveredRatio', 'candidateCoveredRatio', 'centroidDistanceM', 'areaRatio',
    'heightDeltaM', 'candidateCount', 'ambiguousReason', 'lod1SuppressionAllowed']) {
    assert.ok(s.includes(k), 'debug に ' + k + ' が無い');
  }
});

test('[35T §6] footprint 比較 overlay がある', () => {
  const s = read(DEV);
  if (!s.includes('[Mission 35S] CustomLod2Layer')) return;
  assert.match(s, /CR_customLod2_35T_overlay/);
  assert.match(s, /source: 0xff2d2d/);   // 赤 = OSM source
  assert.match(s, /best: 0x2f6bff/);     // 青 = best canonical
  assert.match(s, /second: 0xffc400/);   // 黄 = second candidate
  assert.match(s, /'OSM source'/);
  assert.match(s, /'BEST canonical'/);
  assert.match(s, /'SECOND canonical'/);
  assert.match(s, /__CUSTOM_LOD2_OVERLAY__/);
  // overlay 中は試作メッシュを半透明にできる
  assert.match(s, /mt\.opacity = overlayOn \? 0\.45 : 1;/);
});

test('[35T] 生成元にも入っている（再生成で戻らない）', () => {
  const p = read(PATCH);
  assert.match(p, /const MATCH_RULES = \{/);
  assert.match(p, /function decideMatch\(best, second\)/);
  assert.match(p, /CR_customLod2_35T_overlay/);
  assert.match(p, /stats\.matchConfidence === 'HIGH'/);
});

// ── §0 production / protected ─────────────────────────────────────
test('[35T §0] production / protected は変更していない', () => {
  const base = rj(path.join(ROOT, 'data', 'reports', 'baselines', 'prod-protected-hashes.json'));
  const build = rj(path.join(ROOT, 'data', 'reports', 'production-cutover-build.json'));
  if (build && build.productionSha256) assert.equal(sha(PROD), build.productionSha256, 'production が変わっている');
  if (base && base.prot) assert.equal(sha(PROT), base.prot, 'protected が変わっている');
  // 試作レイヤーは dev だけ
  assert.ok(!read(PROD).includes('[Mission 35S] CustomLod2Layer'), 'production に試作レイヤーが入っている');
  assert.ok(!read(PROT).includes('[Mission 35S] CustomLod2Layer'), 'protected に試作レイヤーが入っている');
});

// ── §9 実データ ───────────────────────────────────────────────────
test('[35T §1/§2/§9] 実データ: source と候補の監査', { skip: !fs.existsSync(path.join(REPORT_DIR, 'candidates.json')) && 'no report' }, () => {
  const r = rj(path.join(REPORT_DIR, 'candidates.json'));
  // §1 source は OSM way のまま置き換えていない
  assert.equal(r.source.osmWayId, 267613423);
  assert.ok(r.source.vertexCount >= 3);
  assert.ok(r.source.areaM2 > 0);
  assert.equal(r.coordinateConvention, 'znorth-neg-v1');
  // §2 候補は全列挙（最寄り 1 棟だけではない）
  assert.ok(r.candidateCount > 1, '候補が ' + r.candidateCount + ' 件しかない');
  assert.ok(r.top10.length > 1);
  for (const c of r.top10) {
    for (const k of ['canonicalId', 'centroidDistanceM', 'areaRatio', 'iou',
      'sourceCoveredRatio', 'candidateCoveredRatio', 'intersectionM2', 'unionM2', 'hausdorffM']) {
      assert.ok(c[k] !== undefined, k + ' が無い');
    }
  }
  // §3 判定と suppression の整合
  assert.ok(['HIGH', 'MEDIUM', 'AMBIGUOUS', 'UNMATCHED'].includes(r.matchConfidence));
  assert.equal(r.lod1SuppressionAllowed, r.matchConfidence === 'HIGH');
  // §9 SUMMARY.md がある
  assert.ok(fs.existsSync(path.join(REPORT_DIR, 'SUMMARY.md')));
});

test('[35T §10] 実データ: 実機 QA', { skip: !fs.existsSync(path.join(REPORT_DIR, 'browser-qa.json')) && 'no report' }, () => {
  const q = rj(path.join(REPORT_DIR, 'browser-qa.json')).summary;
  assert.equal(q.jsErrors, 0);
  // overlay は 3 本（source / best / second）
  assert.ok(q.overlayRings >= 2, 'overlay の輪郭が ' + q.overlayRings + ' 本');
  assert.ok(q.overlayLabels >= 2, 'overlay のラベルが ' + q.overlayLabels + ' 個');
  // §7 HIGH 以外では LOD1 を消していない
  assert.equal(q.lod1SuppressionAllowed, q.matchConfidence === 'HIGH');
  if (q.matchConfidence !== 'HIGH') {
    assert.equal(q.suppressActive, false, 'HIGH でないのに suppression が効いている');
    assert.equal(q.lod1SuppressedCount, 0, 'HIGH でないのに LOD1 を消している');
  }
});
