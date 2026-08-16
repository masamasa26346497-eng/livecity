// tests/population-change.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePopulationChange, COMPARISON_STATUS } from '../tools/calculate/population-change.js';

function make2015(overrides) {
  return {
    municipalityCode: '27120', chochoCode: '001001', compositeCode: '27120:001001',
    ward: '住吉区', chochoName: '南住吉一丁目', fullChochoName: '住吉区南住吉一丁目',
    population2015: 2800, population2015Suppressed: false,
    households2015: 1300, households2015Suppressed: false,
    ...overrides,
  };
}
function make2020(overrides) {
  return {
    municipalityCode: '27120', chochoCode: '001001', compositeCode: '27120:001001',
    ward: '住吉区', chochoName: '南住吉一丁目', fullChochoName: '住吉区南住吉一丁目',
    population: 2986, populationSuppressed: false,
    households: 1373, householdsSuppressed: false,
    ...overrides,
  };
}

test('人口増減: 複合コードで正しく結合され、増減数・増減率が計算される', () => {
  const { records } = calculatePopulationChange([make2015()], [make2020()]);
  const r = records[0];
  assert.equal(r.comparisonStatus, COMPARISON_STATUS.COMPARABLE);
  assert.equal(r.joinMethod, 'composite-code');
  assert.equal(r.basePopulation, 2800);
  assert.equal(r.comparisonPopulation, 2986);
  assert.equal(r.changeCount, 186);
  assert.equal(r.changeRate, 6.6); // 186/2800*100 = 6.642...% -> 小数第1位で6.6
});

test('人口増減: 異なる区の同名町丁目を複合コードで正しく区別する(誤結合しない)', () => {
  const records2015 = [
    make2015({ municipalityCode: '27120', compositeCode: '27120:001001', ward: '住吉区', population2015: 2800 }),
    make2015({ municipalityCode: '27121', compositeCode: '27121:001001', ward: '東住吉区', chochoName: '今林一丁目', fullChochoName: '東住吉区今林一丁目', population2015: 0 }),
  ];
  const records2020 = [
    make2020({ municipalityCode: '27121', compositeCode: '27121:001001', ward: '東住吉区', chochoName: '今林一丁目', fullChochoName: '東住吉区今林一丁目', population: 0 }),
  ];
  const { records } = calculatePopulationChange(records2015, records2020);
  assert.equal(records.length, 2); // 今林一丁目の比較1件 + 南住吉一丁目(2015のみ)1件
  const imabayashi = records.find((r) => r.chochoName === '今林一丁目');
  assert.equal(imabayashi.basePopulation, 0);
  assert.equal(imabayashi.comparisonPopulation, 0);
  assert.equal(imabayashi.changeCount, 0);
});

test('人口増減: 基準年度(2015年)人口が0の場合、増減率を計算しない(0除算を回避)', () => {
  const records2015 = [make2015({ population2015: 0 })];
  const records2020 = [make2020({ population: 50 })];
  const { records } = calculatePopulationChange(records2015, records2020);
  const r = records[0];
  assert.equal(r.changeCount, 50); // 増減数自体は計算できる
  assert.equal(r.changeRate, null); // 増減率は計算しない
});

test('人口増減: 2015年または2020年いずれかが秘匿の場合、増減数・増減率を計算しない', () => {
  const records2015 = [make2015({ population2015: null, population2015Suppressed: true })];
  const records2020 = [make2020()];
  const { records } = calculatePopulationChange(records2015, records2020);
  const r = records[0];
  assert.equal(r.comparisonStatus, COMPARISON_STATUS.SUPPRESSED);
  assert.equal(r.changeCount, null);
  assert.equal(r.changeRate, null);
});

test('人口増減: 2020年にのみ存在する町丁目(新設または境界変更)を、基準人口0として増加率を計算しない', () => {
  const records2015 = [];
  const records2020 = [make2020({ chochoName: '新設町', fullChochoName: '住吉区新設町' })];
  const { records } = calculatePopulationChange(records2015, records2020);
  const r = records[0];
  assert.equal(r.comparisonStatus, COMPARISON_STATUS.UNMATCHED_2020_ONLY);
  assert.equal(r.basePopulation, null); // 0ではなくnull(比較不能を明示)
  assert.equal(r.changeCount, null);
  assert.equal(r.changeRate, null);
});

test('人口増減: 2015年にのみ存在する町丁目(廃止または境界変更)を、単純に人口0になったと表示しない', () => {
  const records2015 = [make2015({ chochoName: '廃止町', fullChochoName: '住吉区廃止町', compositeCode: '27120:999999' })];
  const records2020 = [];
  const { records } = calculatePopulationChange(records2015, records2020);
  const r = records[0];
  assert.equal(r.comparisonStatus, COMPARISON_STATUS.UNMATCHED_2015_ONLY);
  assert.equal(r.comparisonPopulation, null); // 0ではなくnull
  assert.equal(r.changeCount, null);
});

test('人口増減: 増加・減少・横ばいが正しく分類される', () => {
  const records2015 = [
    make2015({ compositeCode: 'A:1', fullChochoName: '増加町', population2015: 1000 }),
    make2015({ compositeCode: 'A:2', fullChochoName: '減少町', population2015: 1000 }),
    make2015({ compositeCode: 'A:3', fullChochoName: '横ばい町', population2015: 1000 }),
  ];
  const records2020 = [
    make2020({ compositeCode: 'A:1', fullChochoName: '増加町', population: 1200 }),
    make2020({ compositeCode: 'A:2', fullChochoName: '減少町', population: 800 }),
    make2020({ compositeCode: 'A:3', fullChochoName: '横ばい町', population: 1000 }),
  ];
  const { stats } = calculatePopulationChange(records2015, records2020);
  assert.equal(stats.increasing, 1);
  assert.equal(stats.decreasing, 1);
  assert.equal(stats.flat, 1);
});

test('人口増減: 複合コードで結合できない場合、正規化名称でのフォールバック結合が機能し、joinMethodへ記録される', () => {
  const records2015 = [make2015({ compositeCode: null })]; // 複合コード自体が無い(コード不明のケース)
  const records2020 = [make2020()];
  const { records } = calculatePopulationChange(records2015, records2020);
  const r = records[0];
  assert.equal(r.joinMethod, 'normalized-name');
  assert.equal(r.comparisonStatus, COMPARISON_STATUS.COMPARABLE);
});
