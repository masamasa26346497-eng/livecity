// tests/river-network.test.js
// [Mission22] tools/lib/river-network.js の純粋ロジック（名前正規化 / 3階級分類 / 連続性監査）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRiverName, classifyRiverTier, groupByRiver, auditContinuity, classifyGapCause,
  polylineLengthXZ, MAJOR_RIVERS, MEDIUM_ANCHOR_RIVERS, TIER_ORDER,
} from '../tools/lib/river-network.js';

test('[Mission22] normalizeRiverName: 括弧注記除去・全角半角統一・誤結合しない', () => {
  assert.equal(normalizeRiverName('大川（旧淀川）'), '大川');
  assert.equal(normalizeRiverName('  堂島川　'), '堂島川');
  assert.equal(normalizeRiverName('第１今井戸川'), '第1今井戸川');
  // 「川/河/運河」語尾は変えない（別河川衝突防止）
  assert.equal(normalizeRiverName('木津川運河'), '木津川運河');
  assert.notEqual(normalizeRiverName('木津川運河'), normalizeRiverName('木津川'));
  assert.equal(normalizeRiverName(''), '');
});

test('[Mission22] classifyRiverTier: 主要7河川は major', () => {
  for (const nm of MAJOR_RIVERS) {
    assert.equal(classifyRiverTier({ name: nm, waterwayTag: 'river' }), 'major');
  }
});

test('[Mission22] classifyRiverTier: medium アンカー河川 / 幅 / 長さ', () => {
  assert.equal(classifyRiverTier({ name: '大川', waterwayTag: 'river', groupLengthM: 500 }), 'medium', 'アンカー河川は短くても medium');
  assert.equal(classifyRiverTier({ name: '名無し用水', waterwayTag: 'river', widthHint: 50 }), 'medium', '幅広なら medium');
  assert.equal(classifyRiverTier({ name: 'そこそこ川', waterwayTag: 'river', groupLengthM: 2000 }), 'medium', '長い名前付き river は medium');
});

test('[Mission22/28] classifyRiverTier: 無名の小 stream は micro / 名前付き細水路は minor', () => {
  assert.equal(classifyRiverTier({ name: '', waterwayTag: 'stream', groupLengthM: 200 }), 'micro', '無名の短い stream は micro');
  assert.equal(classifyRiverTier({ name: '', waterwayTag: 'stream', groupLengthM: 2000 }), 'minor', '長い無名 stream は minor（近景表示）');
  assert.equal(classifyRiverTier({ name: 'ちび川', waterwayTag: 'river', groupLengthM: 300, widthHint: 5 }), 'minor', '短くて細い名前付き river は minor');
});

test('[Mission28] classifyRiverTier: drain / ditch は micro（超近景のみ）。名前付き用水路は minor', () => {
  assert.equal(classifyRiverTier({ name: '', waterwayTag: 'drain' }), 'micro');
  assert.equal(classifyRiverTier({ name: '', waterwayTag: 'ditch' }), 'micro');
  assert.equal(classifyRiverTier({ name: '五箇中水路', waterwayTag: 'drain' }), 'minor', '名前付きの用水路は都市構造として minor へ残す');
  assert.equal(classifyRiverTier({ name: '', waterwayTag: 'canal' }), 'minor', 'canal は最低でも minor（micro にしない）');
});

test('[Mission22/28] TIER_ORDER は major→medium→minor→micro', () => {
  assert.deepEqual([...TIER_ORDER], ['major', 'medium', 'minor', 'micro']);
  assert.ok(MEDIUM_ANCHOR_RIVERS.includes('大川') && MEDIUM_ANCHOR_RIVERS.includes('東横堀川'));
});

test('[Mission22] groupByRiver: 正規化名でまとめ、無名は個別', () => {
  const segs = [
    { name: '平野川' }, { name: '平野川（分派）' }, { name: '' }, { name: '' }, { name: '大川' },
  ];
  const g = groupByRiver(segs);
  assert.equal(g.get('平野川').indices.length, 2, '平野川 2 セグメントが 1 グループ');
  assert.equal([...g.keys()].filter((k) => k.startsWith('__unnamed_')).length, 2, '無名は個別');
});

test('[Mission22] auditContinuity: 連続チェーンは 1 component / gap 0', () => {
  const a = [[0, 0], [100, 0], [200, 0]];
  const b = [[200, 0], [300, 0], [400, 0]];        // a の終点と一致
  const r = auditContinuity([a, b], 60);
  assert.equal(r.components, 1);
  assert.equal(r.gapCount, 0);
  assert.equal(r.maxGapM, 0);
  assert.ok(Math.abs(r.totalLengthM - 400) < 1);
});

test('[Mission22] auditContinuity: 離れた 2 チェーンは 2 component / gap 距離を測る', () => {
  const a = [[0, 0], [100, 0]];
  const b = [[600, 0], [700, 0]];   // 500m 離れている
  const r = auditContinuity([a, b], 60);
  assert.equal(r.components, 2);
  assert.equal(r.gapCount, 1);
  assert.ok(Math.abs(r.maxGapM - 500) < 1, `maxGapM=${r.maxGapM}`);
});

test('[Mission22] auditContinuity: 直線補間しない（gap は gap のまま報告）', () => {
  const a = [[0, 0], [100, 0]];
  const b = [[300, 0], [400, 0]];
  const r = auditContinuity([a, b], 60);
  // totalLength は各セグメントの実長のみ（gap 分を足さない）
  assert.ok(Math.abs(r.totalLengthM - 200) < 1, 'gap を長さに含めている');
});

test('[Mission22] classifyGapCause: 端点許容内 / 市境 / OSM欠落', () => {
  assert.match(classifyGapCause({ distM: 40 }), /^A:/);
  assert.match(classifyGapCause({ distM: 500, nearCityEdge: true }), /^D:/);
  assert.match(classifyGapCause({ distM: 900 }), /^B:/);
});

test('[Mission22] polylineLengthXZ', () => {
  assert.equal(polylineLengthXZ([[0, 0], [3, 4], [3, 4]]), 5);
});
