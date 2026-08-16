// tests/demographics-pipeline-isolation.test.js
// 各統計データセットの変換処理が、互いに影響を与えないことを検証するテスト。
// 【背景】実際に報告された不具合: 世帯構成CSVの列検出失敗が、依存関係のない人口増減処理や
// town-stats統合まで停止させていた。本テストはこの分離が正しく機能することを保証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { mergeTownStats } from '../tools/merge/town-stats.js';
import { processedDir, publicMapDataDir, writeJson } from '../tools/lib/area.js';

const TEST_AREA_ID = '__test-pipeline-isolation-area__';

async function cleanupTestArea() {
  const dirs = [processedDir(TEST_AREA_ID), publicMapDataDir(TEST_AREA_ID)];
  for (const dir of dirs) {
    if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
  }
}

async function setupBasicPopulationData() {
  const summary = {
    matchStats: {},
    records: [
      {
        boundaryId: '住吉区南住吉一丁目', chochoCode: '001001', municipalityCode: '27120',
        chochoName: '南住吉一丁目', ward: '住吉区', fullChochoName: '住吉区南住吉一丁目',
        compositeCode: '27120:001001',
        joinMethod: 'municipality-and-chocho-code', boundaryDataStatus: 'official-attributes-only', joinConfidence: 'high',
        population: 2986, populationSuppressed: false,
        households: 1373, householdsSuppressed: false,
      },
    ],
  };
  await writeJson(path.join(processedDir(TEST_AREA_ID), 'demographics', 'summary.json'), summary);
  await writeJson(path.join(publicMapDataDir(TEST_AREA_ID), 'demographics', 'metadata.json'), {
    provider: '総務省統計局', sourceTitle: '令和2年国勢調査', referenceDate: '2020-10-01',
  });
}

test('town-stats統合: 世帯構成・人口増減データが両方とも未生成でも、既存の人口データから正常にtown-stats.jsonを生成できる', async () => {
  await cleanupTestArea();
  await setupBasicPopulationData();

  const output = await mergeTownStats(TEST_AREA_ID);
  assert.equal(output.recordCount, 1);
  const r = output.records[0];
  assert.equal(r.population, 2986);
  assert.equal(r.householdComposition, null); // データなし、0や架空の値ではない
  assert.equal(r.householdCompositionAvailable, false);
  assert.equal(r.populationChange, null);
  assert.equal(r.populationChangeAvailable, false);

  await cleanupTestArea();
});

test('town-stats統合: 世帯構成データのみ存在する場合(人口増減は未生成)でも、人口データ+世帯構成が正しく統合される', async () => {
  await cleanupTestArea();
  await setupBasicPopulationData();

  const householdComposition = {
    matchStats: {},
    records: [{
      compositeCode: '27120:001001', boundaryId: '住吉区南住吉一丁目', chochoName: '南住吉一丁目', ward: '住吉区',
      generalHouseholds: 1373, onePersonHouseholds: 650, twoPersonHouseholds: 400,
      threePersonHouseholds: 180, fourOrMorePersonHouseholds: 143,
      singlePersonHouseholdRate: 47.3, twoPersonHouseholdRate: 29.1, threePersonHouseholdRate: 13.1, fourOrMorePersonHouseholdRate: 10.4,
      generalHouseholdsSuppressed: false,
    }],
  };
  await writeJson(path.join(processedDir(TEST_AREA_ID), 'demographics', 'household-composition.json'), householdComposition);
  await writeJson(path.join(publicMapDataDir(TEST_AREA_ID), 'demographics', 'household-composition-metadata.json'), {
    provider: '総務省統計局', sourceTitle: '令和2年国勢調査 小地域集計 第5-2表',
  });

  const output = await mergeTownStats(TEST_AREA_ID);
  const r = output.records[0];
  assert.ok(r.householdComposition);
  assert.equal(r.householdComposition.singlePersonHouseholdRate, 47.3);
  assert.equal(r.householdCompositionAvailable, true);
  // 人口増減は依然未生成のまま(世帯構成があるからといって架空のデータを作らない)
  assert.equal(r.populationChange, null);
  assert.equal(r.populationChangeAvailable, false);

  await cleanupTestArea();
});

test('town-stats統合: 既存のtown-stats.json(人口+年齢構成のみ)が、世帯構成データの追加後も人口・年齢構成の値を壊さずに保持する', async () => {
  await cleanupTestArea();
  await setupBasicPopulationData();

  // 1回目: 世帯構成データなしで生成
  const firstOutput = await mergeTownStats(TEST_AREA_ID);
  assert.equal(firstOutput.records[0].population, 2986);

  // 世帯構成データを追加
  const householdComposition = {
    matchStats: {},
    records: [{
      compositeCode: '27120:001001', generalHouseholds: 1373, singlePersonHouseholdRate: 47.3,
      generalHouseholdsSuppressed: false,
    }],
  };
  await writeJson(path.join(processedDir(TEST_AREA_ID), 'demographics', 'household-composition.json'), householdComposition);

  // 2回目: 再生成
  const secondOutput = await mergeTownStats(TEST_AREA_ID);
  const r = secondOutput.records[0];
  assert.equal(r.population, 2986); // 既存の人口データが壊れていない
  assert.equal(r.households, 1373);
  assert.ok(r.householdComposition); // 世帯構成が追加されている

  await cleanupTestArea();
});
