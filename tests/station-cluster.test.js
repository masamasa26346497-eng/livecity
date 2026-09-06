// tests/station-cluster.test.js
// [見た目改善 Mission14] tools/lib/station-cluster.js の純粋ロジック。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATION_MAJOR_GROUPS, normalizeStationName, stationGroupOf, clusterStations,
  classifyStationImportance, countByStationImportance,
  STATION_LABEL_BANDS, stationLabelBand, stationLabelVisible, STATION_LABEL_FAR_MAX,
} from '../tools/lib/station-cluster.js';

test('normalizeStationName: NFKC + 空白除去', () => {
  assert.equal(normalizeStationName('  大阪　梅田 '), '大阪梅田');
  assert.equal(normalizeStationName(null), '');
  assert.equal(normalizeStationName('ﾅﾝﾊﾞ'), 'ナンバ');
});

test('stationGroupOf: 主要ターミナル別名 → グループ', () => {
  assert.equal(stationGroupOf('梅田').canonical, '大阪・梅田');
  assert.equal(stationGroupOf('大阪').canonical, '大阪・梅田');
  assert.equal(stationGroupOf('東梅田').canonical, '大阪・梅田');
  assert.equal(stationGroupOf('大阪難波').canonical, 'なんば');
  assert.equal(stationGroupOf('大阪阿部野橋').canonical, '天王寺');
  assert.equal(stationGroupOf('動物園前').canonical, '新今宮');
  assert.equal(stationGroupOf('存在しない駅'), null);
});

test('clusterStations: 近接ノードを1クラスタへ、離れたら別', () => {
  const stations = [
    { id: 'a', name: '駅A', x: 0, z: 0 },
    { id: 'b', name: '駅A', x: 50, z: 0 },   // a と 50m → 同クラスタ
    { id: 'c', name: '駅C', x: 5000, z: 0 }, // 遠い → 別
  ];
  const cl = clusterStations(stations, { radiusM: 130 });
  assert.equal(cl.length, 2);
  const big = cl.find((c) => c.memberIds.length === 2);
  assert.ok(big, '近接2ノードが統合されていない');
  assert.deepEqual(big.memberIds.sort(), ['a', 'b']);
});

test('clusterStations: 主要グループの別名クラスタを groupMergeM 以内で統合', () => {
  const stations = [
    { id: 'osaka', name: '大阪', x: 0, z: 0 },
    { id: 'umeda', name: '梅田', x: 300, z: 0 },     // 大阪 と 300m、別クラスタだが同グループ
    { id: 'nishi', name: '西梅田', x: 500, z: 100 },
  ];
  const cl = clusterStations(stations, { radiusM: 120, groupMergeM: 900 });
  assert.equal(cl.length, 1, '大阪・梅田エリアが1ラベルに統合されていない');
  assert.equal(cl[0].label, '大阪・梅田');
  assert.equal(cl[0].group, '大阪・梅田');
  assert.equal(cl[0].memberIds.length, 3);
});

test('clusterStations: 同一 canonical label のクラスタを sameNameMergeM 以内で統合', () => {
  const stations = [
    { id: 'p1', name: '今里', x: 0, z: 0 },
    { id: 'p2', name: '今里', x: 300, z: 0 },   // 130m を超えるが同名・420m 以内 → 統合
  ];
  const cl = clusterStations(stations, { radiusM: 130, sameNameMergeM: 420 });
  assert.equal(cl.length, 1);
  assert.equal(cl[0].memberIds.length, 2);
});

test('clusterStations: 別名でも遠ければ統合しない（別駅を勝手に統合しない）', () => {
  const stations = [
    { id: 'a', name: '中津', x: 0, z: 0 },
    { id: 'b', name: '中津', x: 700, z: 0 }, // 同名だが 420m 超 → 別クラスタのまま
  ];
  const cl = clusterStations(stations, { radiusM: 130, sameNameMergeM: 420 });
  assert.equal(cl.length, 2);
});

test('classifyStationImportance: group=major / 乗換=medium / 孤立小駅=local', () => {
  assert.equal(classifyStationImportance({ group: '大阪・梅田', memberIds: ['a'] }, {}), 'major');
  // 地上+地下の乗換
  assert.equal(classifyStationImportance({ group: null, memberIds: ['a'] }, { railWays: 2, subwayWays: 3 }), 'medium');
  // 地上のみ多数
  assert.equal(classifyStationImportance({ group: null, memberIds: ['a'] }, { railWays: 10, subwayWays: 0 }), 'medium');
  // 3 プラットフォーム
  assert.equal(classifyStationImportance({ group: null, memberIds: ['a', 'b', 'c'] }, { railWays: 1 }), 'medium');
  // 孤立
  assert.equal(classifyStationImportance({ group: null, memberIds: ['a'] }, { railWays: 2, subwayWays: 0 }), 'local');
  assert.equal(classifyStationImportance({ group: null, memberIds: ['a'] }, { subwayWays: 2 }), 'local');
});

test('stationLabelBand / stationLabelVisible: FAR=major / MID=major+medium / NEAR=all（道路と同じ 9000/3500）', () => {
  assert.deepEqual(STATION_LABEL_BANDS, { farM: 9000, midM: 3500 });
  assert.equal(stationLabelBand(12000), 'far');
  assert.equal(stationLabelBand(9000), 'mid');
  assert.equal(stationLabelBand(3500), 'near');
  assert.deepEqual(['major', 'medium', 'local'].map((i) => stationLabelVisible(i, 12000)), [true, false, false]);
  assert.deepEqual(['major', 'medium', 'local'].map((i) => stationLabelVisible(i, 6000)), [true, true, false]);
  assert.deepEqual(['major', 'medium', 'local'].map((i) => stationLabelVisible(i, 1000)), [true, true, true]);
});

test('STATION_MAJOR_GROUPS: 主要駅 override が揃っている / FAR 上限が妥当', () => {
  const canon = STATION_MAJOR_GROUPS.map((g) => g.canonical);
  for (const n of ['大阪・梅田', 'なんば', '天王寺', '新大阪', '京橋', '鶴橋', '淀屋橋', '本町', '心斎橋', '西九条']) {
    assert.ok(canon.includes(n), `${n} グループが無い`);
  }
  assert.ok(STATION_LABEL_FAR_MAX >= 15 && STATION_LABEL_FAR_MAX <= 30, `FAR 上限=${STATION_LABEL_FAR_MAX}`);
});

test('countByStationImportance: 合計 = total', () => {
  const clusters = [
    { group: '大阪・梅田', memberIds: ['a'] },
    { group: null, memberIds: ['b'] },
    { group: null, memberIds: ['c'] },
  ];
  const c = countByStationImportance(clusters, () => ({ railWays: 0, subwayWays: 0 }));
  assert.equal(c.total, 3);
  assert.equal(c.major, 1);
  assert.equal(c.major + c.medium + c.local, c.total);
});
