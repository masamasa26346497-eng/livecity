// tests/map-completeness.test.js
// [Mission24] tools/lib/map-completeness.js / rail-lod.js（reclassifyRailNetwork）の純粋ロジック。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditMapCompleteness, clusterCells, classifyAnomalySeverity, layerScore, BASE_LAYERS, SEVERITY,
} from '../tools/lib/map-completeness.js';
import { reclassifyRailNetwork, classifyRail } from '../tools/lib/rail-lod.js';

const WARDS = [{ wardId: 'a', polygons: [{ outer: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] }] }];

test('[Mission24] BASE_LAYERS / SEVERITY', () => {
  assert.deepEqual([...BASE_LAYERS], ['land', 'buildings', 'roads', 'rivers', 'sea', 'parks', 'railways']);
  assert.deepEqual([...SEVERITY], ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
});

test('[Mission24] auditMapCompleteness: 陸・道路あり・建物なし → anomaly A / 建物ありは除外', () => {
  // 道路は z<=350 の行のみ。z>=400 は道路も建物も無い → anomaly A。
  // ただし 1 セル(450,650)には建物を置く → そのセルは anomaly でないこと。
  const roads = [];
  for (let z = 50; z < 360; z += 100) roads.push({ p: [[20, z], [980, z]] });
  const plateauBuildings = [{ x: 450, z: 650, fpArea: 50 }];
  const A = auditMapCompleteness({ wards: WARDS, cellM: 100, plateauBuildings, fallbackBuildings: [], roads, rivers: [], rails: [], parkRings: [], seaPositions: [] });
  assert.ok(A.landCells >= 90);
  assert.ok(A.anomalyCells.A.length >= 1, '道路も建物も無い cell が A に入らない');
  assert.ok(!A.anomalyCells.A.some((c) => c.x === 450 && c.z === 650), '建物のあるセルが anomaly');
});

test('[Mission24] auditMapCompleteness: open space（公園）cell は anomaly A から除外', () => {
  const roads = [];
  for (let z = 50; z < 1000; z += 100) roads.push({ p: [[20, z], [980, z]] });
  const parkRings = [[[50, 250], [950, 250], [950, 550], [50, 550]]];
  const A = auditMapCompleteness({ wards: WARDS, cellM: 100, plateauBuildings: [], fallbackBuildings: [], roads, rivers: [], rails: [], parkRings, seaPositions: [] });
  // 公園に覆われた行(z 300..500)の中央 cell は anomaly でない
  assert.ok(!A.anomalyCells.A.some((c) => c.z >= 300 && c.z <= 500 && c.x >= 300 && c.x <= 700), '公園 cell が anomaly A に残っている');
});

test('[Mission24] auditMapCompleteness: land ∩ sea 三角形内は anomaly F', () => {
  // land 全域を覆う sea 三角形
  const sea = [-100, -100, 2000, -100, 1000, 2000];
  const A = auditMapCompleteness({ wards: WARDS, cellM: 100, plateauBuildings: [], fallbackBuildings: [], roads: [], rivers: [], rails: [], parkRings: [], seaPositions: sea });
  assert.ok(A.anomalyCells.F.length > 10, 'land ∩ sea が F に入らない');
});

test('[Mission24] clusterCells: 連結クラスタ化 + cellKeys', () => {
  const cells = [];
  for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) cells.push({ cx, cz, x: cx * 100, z: cz * 100, ward: 'a' });
  const cl = clusterCells(cells, 100, 4);
  assert.equal(cl.length, 1);
  assert.equal(cl[0].cells, 16);
  assert.equal(cl[0].cellKeys.length, 16);
});

test('[Mission24] classifyAnomalySeverity: 面積で段階 / explained は LOW/INFO', () => {
  assert.equal(classifyAnomalySeverity({ type: 'A', areaKm2: 1.5 }), 'CRITICAL');
  assert.equal(classifyAnomalySeverity({ type: 'A', areaKm2: 0.4 }), 'HIGH');
  assert.equal(classifyAnomalySeverity({ type: 'A', areaKm2: 0.1 }), 'MEDIUM');
  assert.equal(classifyAnomalySeverity({ type: 'A', areaKm2: 1.5, explained: true }), 'LOW');
  assert.equal(classifyAnomalySeverity({ type: 'A', areaKm2: 0.02, explained: true }), 'INFO');
  assert.equal(classifyAnomalySeverity({ type: 'F', cells: 1 }), 'LOW', '1 cell の sea overlap は raster edge');
  assert.equal(classifyAnomalySeverity({ type: 'F', cells: 30 }), 'CRITICAL');
});

test('[Mission24] layerScore', () => {
  assert.equal(layerScore(1, 0, 0, 0), 100);
  assert.equal(layerScore(1, 1, 0, 0), 0, 'CRITICAL 1 で 0');
  assert.equal(layerScore(1, 0, 2, 0), 50, 'HIGH 2 で -50');
});

test('[Mission24] reclassifyRailNetwork: 名前付き rail 断片 / 本線接続断片は major へ救済', () => {
  const feats = [
    { railway: 'rail', name: 'JR大阪環状線', p: [[0, 0], [500, 0]] },    // 長い major（名前あり）
    { railway: 'rail', name: '', p: [[500, 0], [530, 0]] },              // 30m 断片、両端が major に接続 → major
    { railway: 'rail', name: '', p: [[530, 0], [1030, 0]] },             // 長い major（名無し・長さ>60m）
    { railway: 'rail', name: 'JR阪和線', p: [[0, 100], [20, 100]] },     // 短いが名前あり → major
    { railway: 'rail', name: '', p: [[5000, 5000], [5020, 5000]] },      // 孤立した 20m 断片 → local
    { railway: 'subway', name: 'Osaka Metro御堂筋線', p: [[0, 200], [400, 200]] }, // urban
  ];
  const m = reclassifyRailNetwork(feats, { tolM: 20 });
  assert.equal(m.get(0), 'major');
  assert.equal(m.get(1), 'major', '本線に接続する短い断片が major に救済されない');
  assert.equal(m.get(2), 'major');
  assert.equal(m.get(3), 'major', '名前付き短断片が major に救済されない');
  assert.equal(m.get(4), 'local', '孤立断片が誤って major になった');
  assert.equal(m.get(5), 'urban');
});

test('[Mission24] classifyRail は従来の長さ分類を維持（Mission13 互換）', () => {
  assert.equal(classifyRail('rail', 200), 'major');
  assert.equal(classifyRail('rail', 40), 'local');
  assert.equal(classifyRail('subway', 40), 'urban');
});
