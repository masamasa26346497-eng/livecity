// tests/building-density.test.js
// [Mission29] tools/lib/osm-building-fallback.js の純粋ロジック（§2/§9/§10/§11）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBuildingUsage, isFallbackEligibleBuilding, resolveOsmHeight,
  ringSelfIntersects, isValidFootprint, ringArea,
  BUILDING_EXCLUDE_TAGS, BUILDING_CLASS_DEFAULT_HEIGHT, LEVEL_HEIGHT_M, MAX_FALLBACK_HEIGHT_M,
} from '../tools/lib/osm-building-fallback.js';

test('[Mission29] §2 isFallbackEligibleBuilding: roof/construction/ruins/proposed/demolished を除外', () => {
  for (const bad of ['no', 'roof', 'construction', 'ruins', 'proposed', 'demolished']) {
    assert.equal(isFallbackEligibleBuilding(bad), false, bad + ' が eligible');
    assert.ok(BUILDING_EXCLUDE_TAGS.has(bad));
  }
  for (const ok of ['yes', 'house', 'apartments', 'commercial', 'industrial', 'warehouse', 'office', 'school', 'garage', 'shed']) {
    assert.equal(isFallbackEligibleBuilding(ok), true, ok + ' が除外された');
  }
  assert.equal(isFallbackEligibleBuilding(''), false);
  assert.equal(isFallbackEligibleBuilding(undefined), false);
});

test('[Mission29] normalizeBuildingUsage: generic は yes', () => {
  assert.equal(normalizeBuildingUsage('yes'), 'yes');
  assert.equal(normalizeBuildingUsage('true'), 'yes');
  assert.equal(normalizeBuildingUsage(''), 'yes');
  assert.equal(normalizeBuildingUsage('House'), 'house');
  assert.equal(normalizeBuildingUsage(' apartments '), 'apartments');
});

test('[Mission29] §10 resolveOsmHeight: height > levels > class-default > generic', () => {
  // height 優先
  const h = resolveOsmHeight({ height: '15.5', building: 'house' });
  assert.equal(h.dz, 15.5); assert.equal(h.heightSource, 'osm-height'); assert.equal(h.heightUnknown, false);
  // levels 優先（class より）
  const lv = resolveOsmHeight({ 'building:levels': '5', building: 'house' });
  assert.equal(lv.dz, 5 * LEVEL_HEIGHT_M); assert.equal(lv.heightSource, 'osm-levels');
  // class default
  const cd = resolveOsmHeight({ building: 'warehouse' });
  assert.equal(cd.heightSource, 'class-default');
  assert.equal(cd.dz, BUILDING_CLASS_DEFAULT_HEIGHT.warehouse);
  assert.equal(cd.heightUnknown, true, 'class-default は実測でない → heightUnknown true');
  assert.equal(cd.usage, 'warehouse');
  // generic
  const g = resolveOsmHeight({ building: 'yes' });
  assert.equal(g.heightSource, 'generic-default');
  assert.equal(g.usage, 'yes');
  // 未知タグ（class map に無い）→ generic
  const u = resolveOsmHeight({ building: 'nonsense_xyz' });
  assert.equal(u.heightSource, 'generic-default');
  assert.equal(u.usage, 'nonsense_xyz');
  // clamp
  assert.equal(resolveOsmHeight({ height: '999', building: 'yes' }).dz, MAX_FALLBACK_HEIGHT_M);
});

test('[Mission29] §10 class default 高さの範囲チェック', () => {
  const rng = {
    house: [6, 10], detached: [6, 10], apartments: [10, 15], commercial: [8, 15],
    industrial: [6, 12], warehouse: [6, 10], office: [10, 18], school: [8, 14],
  };
  for (const [k, [lo, hi]] of Object.entries(rng)) {
    const v = BUILDING_CLASS_DEFAULT_HEIGHT[k];
    assert.ok(v >= lo && v <= hi, `${k} default ${v} が [${lo},${hi}] 外`);
  }
  assert.equal(BUILDING_CLASS_DEFAULT_HEIGHT.yes, null, 'generic yes は class default なし');
});

test('[Mission29] §11 confidence: heightSource で単調', () => {
  const c = (t) => resolveOsmHeight(t).confidence;
  assert.ok(c({ height: '10', building: 'yes' }) > c({ 'building:levels': '3', building: 'yes' }));
  assert.ok(c({ 'building:levels': '3', building: 'yes' }) > c({ building: 'house' }));
  assert.ok(c({ building: 'house' }) > c({ building: 'yes' }));
  for (const t of [{ height: '10' }, { 'building:levels': '2' }, { building: 'house' }, { building: 'yes' }]) {
    const v = resolveOsmHeight(t).confidence;
    assert.ok(v >= 0 && v <= 1, 'confidence out of range: ' + v);
  }
});

test('[Mission29] §9 ringSelfIntersects / isValidFootprint', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const bowtie = [[0, 0], [10, 10], [10, 0], [0, 10]]; // 自己交差（bowtie）
  // 面積は非退化だが1辺が別の辺を横切る五角形
  const crossing = [[0, 0], [40, 0], [40, 40], [10, -20], [0, 40]];
  assert.equal(ringSelfIntersects(square), false);
  assert.equal(ringSelfIntersects(bowtie), true);
  assert.equal(ringSelfIntersects(crossing), true);
  assert.equal(isValidFootprint(square).ok, true);
  assert.equal(isValidFootprint(bowtie).ok, false); // area 0 → too-small でも自己交差でも reject でよい
  assert.equal(isValidFootprint(crossing).reason, 'self-intersect');
  assert.equal(isValidFootprint([[0, 0], [1, 0], [1, 1], [0, 1]], { minArea: 8 }).reason, 'too-small');
  assert.equal(isValidFootprint([[0, 0], [1000, 0], [1000, 1000], [0, 1000]], { maxArea: 60000 }).reason, 'too-big');
  assert.equal(isValidFootprint([[0, 0], [Infinity, 0], [1, 1]]).reason, 'non-finite');
  assert.equal(isValidFootprint([[0, 0], [1, 1]]).reason, 'too-few-points');
  assert.equal(ringArea(square), 100);
});
