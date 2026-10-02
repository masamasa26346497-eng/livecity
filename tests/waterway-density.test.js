// tests/waterway-density.test.js
// [Mission28] tools/lib の水系ロジック（classifyRiverTier micro / conservativeMicroWidth）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRiverTier, TIER_ORDER } from '../tools/lib/river-network.js';
import {
  conservativeMicroWidth, conservativeMinorWidth, MICRO_WIDTH_LIMITS, MICRO_DEFAULT_WIDTH_BY_CLASS,
} from '../tools/lib/river-width.js';

test('[Mission28] TIER_ORDER に micro が入る', () => {
  assert.deepEqual([...TIER_ORDER], ['major', 'medium', 'minor', 'micro']);
});

test('[Mission28] classifyRiverTier: 無名 drain/ditch → micro / 名前付き・canal → minor 以上', () => {
  assert.equal(classifyRiverTier({ name: '', waterwayTag: 'drain' }), 'micro');
  assert.equal(classifyRiverTier({ name: '', waterwayTag: 'ditch' }), 'micro');
  assert.equal(classifyRiverTier({ name: '五箇中水路', waterwayTag: 'drain' }), 'minor', '名前付き用水路は minor（NEAR 表示を維持）');
  assert.equal(classifyRiverTier({ name: '', waterwayTag: 'canal' }), 'minor');
  assert.equal(classifyRiverTier({ name: '大川', waterwayTag: 'river', groupLengthM: 500 }), 'medium');
  assert.equal(classifyRiverTier({ name: '淀川', waterwayTag: 'river' }), 'major');
});

test('[Mission28] classifyRiverTier: 無名の小 stream → micro / 長い or 名前付き stream → minor', () => {
  assert.equal(classifyRiverTier({ name: '', waterwayTag: 'stream', groupLengthM: 150 }), 'micro');
  assert.equal(classifyRiverTier({ name: '', waterwayTag: 'stream', groupLengthM: 2000 }), 'minor', '長い無名 stream は minor');
  assert.equal(classifyRiverTier({ name: '', waterwayTag: 'stream', groupLengthM: 150, widthHint: 10 }), 'minor', '幅がそこそこある stream は minor');
  assert.equal(classifyRiverTier({ name: '細江川', waterwayTag: 'stream', groupLengthM: 150 }), 'minor', '名前付き stream は minor');
});

test('[Mission28] conservativeMicroWidth: drain 2.5 / ditch 1.5 / stream 4、上限 8m', () => {
  assert.equal(MICRO_WIDTH_LIMITS.min, 1);
  assert.equal(MICRO_WIDTH_LIMITS.max, 8);
  assert.equal(conservativeMicroWidth('drain', null).width, 2.5);
  assert.equal(conservativeMicroWidth('ditch', null).width, 1.5);
  assert.equal(conservativeMicroWidth('stream', null).width, 4);
  assert.equal(conservativeMicroWidth('drain', null).method, 'micro-default');
  // measured は micro 上限で clamp
  assert.equal(conservativeMicroWidth('drain', 20).width, 8);
  assert.equal(conservativeMicroWidth('drain', 20).method, 'measured-clamped');
  assert.equal(conservativeMicroWidth('ditch', 2).width, 2);
});

test('[Mission28] micro は minor より細い（drain 比較）', () => {
  assert.ok(conservativeMicroWidth('drain', null).width < conservativeMinorWidth('drain', null).width);
  assert.ok(MICRO_DEFAULT_WIDTH_BY_CLASS.ditch < MICRO_DEFAULT_WIDTH_BY_CLASS.drain);
});
