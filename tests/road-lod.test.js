// tests/road-lod.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRoadLod, roadLodBand, roadClassVisible, countByRoadLodClass, ROAD_LOD_BANDS } from '../tools/lib/road-lod.js';

test('classifyRoadLod: MAJOR分類', () => {
  for (const hw of ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link']) {
    assert.equal(classifyRoadLod(hw), 'major', hw);
  }
});

test('classifyRoadLod: MID分類', () => {
  for (const hw of ['secondary', 'secondary_link', 'tertiary', 'tertiary_link']) {
    assert.equal(classifyRoadLod(hw), 'mid', hw);
  }
});

test('classifyRoadLod: LOCAL分類（residential/unclassified/service・不明タグ）', () => {
  for (const hw of ['residential', 'unclassified', 'service', 'living_street', '', undefined, 'footway']) {
    assert.equal(classifyRoadLod(hw), 'local', String(hw));
  }
});

test('roadLodBand: 距離しきい値（FAR>9000 / 3500<MID<=9000 / NEAR<=3500）', () => {
  assert.equal(roadLodBand(9001), 'far');
  assert.equal(roadLodBand(9000), 'mid');
  assert.equal(roadLodBand(3501), 'mid');
  assert.equal(roadLodBand(3500), 'near');
  assert.equal(roadLodBand(0), 'near');
});

test('FARではMAJORのみ表示', () => {
  const d = ROAD_LOD_BANDS.farM + 1;
  assert.equal(roadClassVisible('major', d), true);
  assert.equal(roadClassVisible('mid', d), false);
  assert.equal(roadClassVisible('local', d), false);
});

test('MIDではMAJOR+MID表示（LOCALはまだ非表示）', () => {
  const d = (ROAD_LOD_BANDS.farM + ROAD_LOD_BANDS.midM) / 2; // 6250m、mid帯の中間
  assert.equal(roadLodBand(d), 'mid');
  assert.equal(roadClassVisible('major', d), true);
  assert.equal(roadClassVisible('mid', d), true);
  assert.equal(roadClassVisible('local', d), false);
});

test('NEARでは全道路（MAJOR+MID+LOCAL）表示', () => {
  const d = ROAD_LOD_BANDS.midM - 1;
  assert.equal(roadClassVisible('major', d), true);
  assert.equal(roadClassVisible('mid', d), true);
  assert.equal(roadClassVisible('local', d), true);
});

test('band境界: ちょうど9000mはMID扱い（FARではない）、ちょうど3500mはNEAR扱い', () => {
  assert.equal(roadClassVisible('mid', ROAD_LOD_BANDS.farM), true, '9000ちょうどでmidが表示されない');
  assert.equal(roadClassVisible('local', ROAD_LOD_BANDS.midM), true, '3500ちょうどでlocalが表示されない');
});

test('countByRoadLodClass: 混在featureを正しく集計する', () => {
  const feats = [
    { highway: 'motorway' }, { highway: 'primary' },
    { highway: 'secondary' }, { highway: 'tertiary' }, { highway: 'tertiary' },
    { highway: 'residential' }, { highway: 'residential' }, { highway: 'residential' },
    {}, // 不明タグ → local
  ];
  const counts = countByRoadLodClass(feats);
  assert.deepEqual(counts, { major: 2, mid: 3, local: 4, total: 9 });
});
