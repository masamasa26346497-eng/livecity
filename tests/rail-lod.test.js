// tests/rail-lod.test.js
// [見た目改善 Mission13] tools/lib/rail-lod.js の純粋ロジック。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RAIL_MAJOR_MIN_LEN_M, classifyRail, railIncluded, RAIL_EXCLUDED_TAGS,
  RAIL_LOD_BANDS, railLodBand, railClassVisible, RAIL_TIER_OPACITY, railTierOpacity, RAIL_COLORS,
  polylineLengthXZ, maxSegmentLengthXZ, countByRailClass,
} from '../tools/lib/rail-lod.js';

test('classifyRail: subway=urban / light_rail=local / rail は長さで major|local', () => {
  assert.equal(classifyRail('subway', 1000), 'urban');
  assert.equal(classifyRail('metro', 1000), 'urban');
  assert.equal(classifyRail('light_rail', 1000), 'local');
  assert.equal(classifyRail('tram', 1000), 'local');
  assert.equal(classifyRail('monorail', 1000), 'local');
  assert.equal(classifyRail('rail', RAIL_MAJOR_MIN_LEN_M), 'major');
  assert.equal(classifyRail('rail', RAIL_MAJOR_MIN_LEN_M - 1), 'local', '短い rail way は側線');
  assert.equal(classifyRail('rail', 5000), 'major');
  assert.equal(classifyRail('narrow_gauge', 5000), 'major');
  assert.equal(classifyRail('', 5000), 'local');
  assert.equal(classifyRail(undefined, NaN), 'local');
});

test('railIncluded: 現役のみ、工事中・廃線は除外', () => {
  assert.equal(railIncluded('rail'), true);
  assert.equal(railIncluded('subway'), true);
  assert.equal(railIncluded('light_rail'), true);
  for (const t of ['construction', 'proposed', 'disused', 'abandoned', 'razed', 'dismantled']) {
    assert.equal(railIncluded(t), false, t);
    assert.ok(RAIL_EXCLUDED_TAGS.has(t));
  }
});

test('railLodBand: 道路・公園LODと同じ 9000 / 3500', () => {
  assert.deepEqual(RAIL_LOD_BANDS, { farM: 9000, midM: 3500 });
  assert.equal(railLodBand(9001), 'far');
  assert.equal(railLodBand(9000), 'mid');
  assert.equal(railLodBand(3501), 'mid');
  assert.equal(railLodBand(3500), 'near');
  assert.equal(railLodBand(0), 'near');
});

test('railClassVisible: FAR=major only / MID=major+urban / NEAR=all', () => {
  assert.deepEqual(
    ['major', 'urban', 'local'].map((c) => railClassVisible(c, 15000)), [true, false, false]);
  assert.deepEqual(
    ['major', 'urban', 'local'].map((c) => railClassVisible(c, 5000)), [true, true, false]);
  assert.deepEqual(
    ['major', 'urban', 'local'].map((c) => railClassVisible(c, 1000)), [true, true, true]);
});

test('railTierOpacity: major は道路より濃く遠景でも残る、urban(地下鉄)は弱め', () => {
  const majNear = railTierOpacity('major', 1000), majFar = railTierOpacity('major', 15000);
  assert.ok(majNear >= 0.7 && majNear <= 0.9, `major near=${majNear}`);
  assert.ok(majFar >= 0.5, `major far=${majFar}（遠景で消える）`);
  assert.ok(majFar <= majNear);
  // 地下鉄は地上鉄道より薄い
  assert.ok(railTierOpacity('urban', 1000) < railTierOpacity('major', 1000), 'subway が地上 rail より濃い');
  assert.ok(RAIL_TIER_OPACITY.urban.near <= 0.5);
});

test('RAIL_COLORS: 道路(light gray)より少し濃い medium neutral gray・黒すぎない・無彩色', () => {
  for (const [k, v] of Object.entries(RAIL_COLORS)) {
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 18, `${k} の色味が強すぎる`); // ごく僅かな寒色寄りは可
    assert.ok(r >= 130 && r <= 190, `${k} が黒すぎ/明るすぎ (r=${r})`);
  }
  // major が最も濃い
  assert.ok((RAIL_COLORS.major & 255) < (RAIL_COLORS.local & 255), 'major が local より濃くない');
  // 道路ライン色 0x9aa1a8 (=161) より major(=157) が少し濃い
  assert.ok((RAIL_COLORS.major & 255) < 0xa8, 'rail major が道路ラインより濃くない');
});

test('polylineLengthXZ / maxSegmentLengthXZ', () => {
  assert.equal(polylineLengthXZ([[0, 0], [3, 4], [3, 4 + 12]]), 5 + 12);
  assert.equal(polylineLengthXZ([[0, 0]]), 0);
  assert.equal(maxSegmentLengthXZ([[0, 0], [3, 4], [3, 100]]), 96);
  assert.equal(maxSegmentLengthXZ([]), 0);
});

test('countByRailClass: 合計 = total、excluded は除外カウント', () => {
  const feats = [
    { railway: 'rail', p: [[0, 0], [1000, 0]] },       // major
    { railway: 'rail', p: [[0, 0], [30, 0]] },          // local (short)
    { railway: 'subway', p: [[0, 0], [500, 0]] },       // urban
    { railway: 'light_rail', p: [[0, 0], [500, 0]] },   // local
    { railway: 'abandoned', p: [[0, 0], [500, 0]] },    // excluded
    { railway: 'rail', p: [[0, 0]] },                    // invalid + local
  ];
  const c = countByRailClass(feats);
  assert.equal(c.major, 1);
  assert.equal(c.urban, 1);
  assert.equal(c.local, 3); // short rail + light_rail + invalid(→local扱い)
  assert.equal(c.excluded, 1);
  assert.equal(c.invalid, 1); // 診断カウンタ（local に含まれる）
  assert.equal(c.total, 6);
  assert.equal(c.major + c.urban + c.local + c.excluded, c.total);
});
