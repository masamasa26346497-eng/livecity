// tests/boundary-master.test.js
// 境界データの優先順位(正式 > 暫定)、マニフェストの絶対パス非保存、joinMethod等の
// 永続化、正式GeoJSON取り込み(Polygon/MultiPolygon、不正geometry検出、複合キーの
// 桁数保持、読み込み失敗時のフォールバック)に関するテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm, mkdtemp } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { loadBoundaryMaster, officialBoundariesPath, legacyBoundariesPath, BOUNDARY_STATUS } from '../tools/lib/boundary-master.js';
import { toProjectRelativePath, PROJECT_ROOT } from '../tools/lib/paths.js';
import { rawDir, processedDir, readJsonIfExists, writeJson } from '../tools/lib/area.js';

const TEST_AREA_ID = '__test-boundary-priority-area__';
const TEST_AREA_CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'areas', `${TEST_AREA_ID}.json`);

// テスト用のarea設定。本物のosaka-sumiyoshiと同一のprojection(既存のgeoToThree()と同一式)を使う。
const TEST_AREA_CONFIG = {
  id: TEST_AREA_ID,
  name: 'テスト用エリア',
  projection: { type: 'local-equirectangular', centerLat: 34.604208, centerLon: 135.52502, metersPerDegree: 111320 },
};

async function setupTestArea() {
  await mkdir(rawDir(TEST_AREA_ID), { recursive: true });
  await writeJson(TEST_AREA_CONFIG_PATH, TEST_AREA_CONFIG);
}

async function cleanupTestArea() {
  if (existsSync(rawDir(TEST_AREA_ID))) await rm(rawDir(TEST_AREA_ID), { recursive: true, force: true });
  if (existsSync(processedDir(TEST_AREA_ID))) await rm(processedDir(TEST_AREA_ID), { recursive: true, force: true });
  if (existsSync(TEST_AREA_CONFIG_PATH)) await rm(TEST_AREA_CONFIG_PATH, { force: true });
}

function runIngest(geojson, extraArgs = '') {
  const tmpDirPromise = mkdtemp(path.join(tmpdir(), 'estat-ingest-test-'));
  return tmpDirPromise.then(async (tmpDir) => {
    const geojsonPath = path.join(tmpDir, 'sample.geojson');
    await writeFile(geojsonPath, JSON.stringify(geojson), 'utf-8');
    execSync(
      `node tools/ingest/official-boundaries-from-geojson.js --area ${TEST_AREA_ID} --input ${geojsonPath} --reference-date 2020-10-01 ${extraArgs}`,
      { cwd: PROJECT_ROOT, stdio: 'pipe' }
    );
    await rm(tmpDir, { recursive: true, force: true });
  });
}

test('境界マスタ: 正式データも暫定データも無い場合は空配列・legacy-unverified・officialBoundary:falseを返す', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const result = await loadBoundaryMaster(TEST_AREA_ID);
  assert.deepEqual(result.master, []);
  assert.equal(result.boundaryDataStatus, BOUNDARY_STATUS.LEGACY_UNVERIFIED);
  assert.equal(result.officialBoundary, false);
  await cleanupTestArea();
});

test('境界マスタ: 暫定データのみ存在する場合、boundaryDataStatusがlegacy-unverifiedになる', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const legacyData = [{ municipalityCode: null, chochoCode: null, chochoName: '我孫子1丁目', originalFullName: '住吉区我孫子1丁目', ward: '住吉区', boundaryId: '住吉区我孫子1丁目', boundaryDataStatus: 'legacy-unverified', officialBoundary: false }];
  await writeFile(legacyBoundariesPath(TEST_AREA_ID), JSON.stringify(legacyData), 'utf-8');

  const result = await loadBoundaryMaster(TEST_AREA_ID);
  assert.equal(result.master.length, 1);
  assert.equal(result.boundaryDataStatus, BOUNDARY_STATUS.LEGACY_UNVERIFIED);
  assert.equal(result.officialBoundary, false);
  assert.equal(result.boundarySourceType, 'embedded-html-town-polygons');
  await cleanupTestArea();
});

test('境界マスタ: 正式データ(有効なポリゴン形状あり)が存在する場合、暫定データより必ず優先され、boundaryDataStatusがofficialになる', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const legacyData = [{ chochoName: '我孫子1丁目(暫定)', ward: '住吉区', boundaryId: 'legacy-id' }];
  const officialData = [{
    municipalityCode: '27120', chochoCode: '0010', compositeCode: '27120:0010', prefectureName: '大阪府', municipalityName: '大阪市住吉区',
    ward: '住吉区', chochoName: '我孫子一丁目(正式)', normalizedChochoName: '我孫子1丁目',
    boundaryId: 'official-id', source: 'e-Stat', referenceDate: '2020-10-01', license: 'CC BY 4.0',
    geometry: [[[0, 0], [1, 0], [1, 1], [0, 0]]], hasFullPolygon: true,
    officialAttributes: true, officialBoundary: true,
  }];
  await writeFile(legacyBoundariesPath(TEST_AREA_ID), JSON.stringify(legacyData), 'utf-8');
  await writeJson(officialBoundariesPath(TEST_AREA_ID), officialData);

  const result = await loadBoundaryMaster(TEST_AREA_ID);
  assert.equal(result.master.length, 1);
  assert.equal(result.master[0].boundaryId, 'official-id'); // 暫定データ(legacy-id)ではなく正式データが使われる
  assert.equal(result.boundaryDataStatus, BOUNDARY_STATUS.OFFICIAL);
  assert.equal(result.officialBoundary, true);
  assert.equal(result.boundarySourceType, 'official-estat-boundaries');
  await cleanupTestArea();
});

test('境界マスタ: 正式境界データの読み込みに失敗した場合(ファイル破損)、暫定境界へフォールバックする', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const legacyData = [{ chochoName: '我孫子1丁目(暫定)', ward: '住吉区', boundaryId: 'legacy-id' }];
  await writeFile(legacyBoundariesPath(TEST_AREA_ID), JSON.stringify(legacyData), 'utf-8');
  // 正式データのファイルを意図的に壊れたJSONとして書き込む
  await mkdir(path.dirname(officialBoundariesPath(TEST_AREA_ID)), { recursive: true });
  await writeFile(officialBoundariesPath(TEST_AREA_ID), '{ this is not valid JSON', 'utf-8');

  const result = await loadBoundaryMaster(TEST_AREA_ID);
  assert.equal(result.boundaryDataStatus, BOUNDARY_STATUS.LEGACY_UNVERIFIED);
  assert.equal(result.officialBoundary, false);
  assert.equal(result.master.length, 1);
  assert.equal(result.master[0].boundaryId, 'legacy-id');
  await cleanupTestArea();
});

test('正式境界データ取り込み: KEY_CODE(11桁)が市区町村コード(5桁)+町丁字コード(6桁)に正しく分割され、複合キーの先頭ゼロが失われない', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { KEY_CODE: '27120030010', PREF_NAME: '大阪府', CITY_NAME: '大阪市住吉区', S_NAME: '杉本三丁目' },
        geometry: { type: 'Polygon', coordinates: [[[135.52, 34.58], [135.521, 34.58], [135.521, 34.581], [135.52, 34.58]]] },
      },
      { type: 'Feature', properties: { KEY_CODE: '', PREF_NAME: '大阪府', CITY_NAME: '大阪市住吉区', S_NAME: '' }, geometry: null }, // KEY_CODEなし(山林等)はスキップされるべき
    ],
  };
  await runIngest(geojson);

  const result = await readJsonIfExists(officialBoundariesPath(TEST_AREA_ID));
  assert.equal(result.length, 1); // KEY_CODEなしの1件はスキップされている
  assert.equal(result[0].municipalityCode, '27120');
  assert.equal(result[0].chochoCode, '030010'); // 先頭ゼロが保持されている(数値化されていない)
  assert.equal(result[0].compositeCode, '27120:030010');
  assert.equal(typeof result[0].chochoCode, 'string');
  assert.equal(result[0].ward, '住吉区');
  assert.equal(result[0].chochoName, '杉本三丁目');
  assert.equal(result[0].officialBoundary, true);
  assert.equal(result[0].boundaryDataStatus, 'official');
  await cleanupTestArea();
});

test('正式境界データ取り込み: Polygon geometryが既存座標系へ正しく変換される', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const geojson = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { KEY_CODE: '27120030010', PREF_NAME: '大阪府', CITY_NAME: '大阪市住吉区', S_NAME: '杉本三丁目' },
      geometry: { type: 'Polygon', coordinates: [[[135.52, 34.58], [135.521, 34.58], [135.521, 34.581], [135.52, 34.58]]] },
    }],
  };
  await runIngest(geojson);

  const result = await readJsonIfExists(officialBoundariesPath(TEST_AREA_ID));
  assert.equal(result[0].geometry.length, 1); // Polygonは1リング(穴なし)
  assert.equal(result[0].geometry[0].length, 4); // 4点の閉じた多角形
  for (const [x, z] of result[0].geometry[0]) {
    assert.ok(Number.isFinite(x), `x座標が有限値ではない: ${x}`);
    assert.ok(Number.isFinite(z), `z座標が有限値ではない: ${z}`);
  }
  await cleanupTestArea();
});

test('正式境界データ取り込み: MultiPolygon geometryを処理できる(飛び地等)', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const geojson = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { KEY_CODE: '27120030010', PREF_NAME: '大阪府', CITY_NAME: '大阪市住吉区', S_NAME: '杉本三丁目' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[135.52, 34.58], [135.521, 34.58], [135.521, 34.581], [135.52, 34.58]]],
          [[[135.53, 34.59], [135.531, 34.59], [135.531, 34.591], [135.53, 34.59]]],
        ],
      },
    }],
  };
  await runIngest(geojson);

  const result = await readJsonIfExists(officialBoundariesPath(TEST_AREA_ID));
  assert.equal(result[0].geometry.length, 2); // 2つの独立したポリゴン(飛び地)
  await cleanupTestArea();
});

test('正式境界データ取り込み: 不正なgeometry(座標が数値でない)を黙って取り込まず、スキップして記録する', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { KEY_CODE: '27120030010', PREF_NAME: '大阪府', CITY_NAME: '大阪市住吉区', S_NAME: '杉本三丁目' },
        geometry: { type: 'Polygon', coordinates: [[['不正', '不正'], [135.521, 34.58]]] },
      },
      {
        type: 'Feature',
        properties: { KEY_CODE: '27121020010', PREF_NAME: '大阪府', CITY_NAME: '大阪市東住吉区', S_NAME: '今林一丁目' },
        geometry: { type: 'Polygon', coordinates: [[[135.55, 34.63], [135.56, 34.63], [135.56, 34.64], [135.55, 34.63]]] },
      },
    ],
  };
  await runIngest(geojson);

  const result = await readJsonIfExists(officialBoundariesPath(TEST_AREA_ID));
  assert.equal(result.length, 1); // 不正geometryの1件は取り込まれず、正常な1件のみ残る
  assert.equal(result[0].chochoName, '今林一丁目');
  await cleanupTestArea();
});

test('正式境界データ取り込み: 杉本三丁目・今林一丁目が正式GeoJSONに存在する場合、正しく取り込まれる', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { KEY_CODE: '27120024003', PREF_NAME: '大阪府', CITY_NAME: '大阪市住吉区', S_NAME: '杉本三丁目' },
        geometry: { type: 'Polygon', coordinates: [[[135.52, 34.58], [135.521, 34.58], [135.521, 34.581], [135.52, 34.58]]] },
      },
      {
        type: 'Feature',
        properties: { KEY_CODE: '27121020010', PREF_NAME: '大阪府', CITY_NAME: '大阪市東住吉区', S_NAME: '今林一丁目' },
        geometry: { type: 'Polygon', coordinates: [[[135.55, 34.63], [135.56, 34.63], [135.56, 34.64], [135.55, 34.63]]] },
      },
    ],
  };
  await runIngest(geojson);

  const result = await readJsonIfExists(officialBoundariesPath(TEST_AREA_ID));
  const sugimoto = result.find((r) => r.chochoName === '杉本三丁目');
  const imabayashi = result.find((r) => r.chochoName === '今林一丁目');
  assert.ok(sugimoto, '杉本三丁目が取り込まれている');
  assert.equal(sugimoto.compositeCode, '27120:024003');
  assert.ok(imabayashi, '今林一丁目が取り込まれている');
  assert.equal(imabayashi.compositeCode, '27121:020010');
  await cleanupTestArea();
});

test('境界マスタ: 正式境界使用時、複合キーで人口データと結合できる', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const geojson = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { KEY_CODE: '27120030010', PREF_NAME: '大阪府', CITY_NAME: '大阪市住吉区', S_NAME: '杉本三丁目' },
      geometry: { type: 'Polygon', coordinates: [[[135.52, 34.58], [135.521, 34.58], [135.521, 34.581], [135.52, 34.58]]] },
    }],
  };
  await runIngest(geojson);

  const { joinByChochoCode } = await import('../tools/join/chocho-crosswalk.js');
  const { master } = await loadBoundaryMaster(TEST_AREA_ID);
  const records = [{ municipalityCode: '27120', chochoCode: '030010', chochoName: '杉本三丁目', population: 3 }];
  const result = joinByChochoCode(records, master);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].matchMethod, 'municipality-and-chocho-code');
  assert.equal(result.matched[0].joinConfidence, 'high');
  await cleanupTestArea();
});

test('境界比較レポート: 正式境界と暫定境界(TOWN_POLYGONS)の差異が正しく検出される', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { KEY_CODE: '27120024003', PREF_NAME: '大阪府', CITY_NAME: '大阪市住吉区', S_NAME: '杉本三丁目' },
        geometry: { type: 'Polygon', coordinates: [[[135.52, 34.58], [135.521, 34.58], [135.521, 34.581], [135.52, 34.58]]] },
      },
      {
        type: 'Feature',
        properties: { KEY_CODE: '27120010010', PREF_NAME: '大阪府', CITY_NAME: '大阪市住吉区', S_NAME: '我孫子一丁目' },
        geometry: { type: 'Polygon', coordinates: [[[135.5, 34.6], [135.501, 34.6], [135.501, 34.601], [135.5, 34.6]]] },
      },
    ],
  };
  await runIngest(geojson);
  // 暫定データには「我孫子一丁目」のみ存在し、「杉本三丁目」は存在しない(実際の状況を再現)
  const legacyData = [{ originalFullName: '住吉区我孫子一丁目', boundaryId: '住吉区我孫子一丁目', chochoName: '我孫子一丁目', ward: '住吉区' }];
  await writeFile(legacyBoundariesPath(TEST_AREA_ID), JSON.stringify(legacyData), 'utf-8');

  execSync(`node tools/compare/boundary-comparison.js --area ${TEST_AREA_ID}`, { cwd: PROJECT_ROOT, stdio: 'pipe' });

  const reportPath = path.join(processedDir(TEST_AREA_ID), 'boundaries', 'town-polygons-comparison-report.json');
  const report = await readJsonIfExists(reportPath);
  assert.equal(report.officialCount, 2);
  assert.equal(report.legacyCount, 1);
  assert.equal(report.officialOnlyCount, 1); // 杉本三丁目が正式境界にのみ存在
  assert.equal(report.officialOnly[0].chochoName, '杉本三丁目');
  await cleanupTestArea();
});

test('パス: toProjectRelativePathで生成した文字列は環境固有の絶対パスを含まない', () => {
  const absolutePath = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-sumiyoshi', 'demographics', 'summary.json');
  const relative = toProjectRelativePath(absolutePath);
  assert.equal(relative, 'public/map-data/osaka-sumiyoshi/demographics/summary.json');
  assert.ok(!relative.startsWith('/'), '先頭にスラッシュ(絶対パスの形跡)が残っていない');
  assert.ok(!relative.includes(PROJECT_ROOT), 'プロジェクトルート自体の絶対パス文字列を含まない');
});

// ── 属性データと境界形状の区別に関するテスト ──
// 【背景】以前は公式属性データ(コード・名称・人口等)が存在するだけで officialBoundary:true,
// boundaryDataStatus:"official" としていたが、これは不正確だった。実際にPolygon/MultiPolygon
// 形状を保持している場合のみこれらをtrueにし、属性のみの場合は明確に区別する。

test('境界マスタ統合: geometry:nullの公式レコードはofficialBoundary:falseになるが、officialAttributes:trueは保たれる', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const officialData = [{
    municipalityCode: '27120', chochoCode: '024003', compositeCode: '27120:024003',
    ward: '住吉区', chochoName: '杉本三丁目', boundaryId: '住吉区杉本三丁目',
    geometry: null, hasFullPolygon: false, officialAttributes: true, officialBoundary: false,
  }];
  await writeJson(officialBoundariesPath(TEST_AREA_ID), officialData);

  const result = await loadBoundaryMaster(TEST_AREA_ID);
  assert.equal(result.master[0].officialAttributes, true);
  assert.equal(result.master[0].officialBoundary, false);
  assert.equal(result.master[0].boundaryDataStatus, BOUNDARY_STATUS.OFFICIAL_ATTRIBUTES_ONLY);
  await cleanupTestArea();
});

test('境界マスタ統合: 公式属性のみではTOWN_POLYGONSを描画上置き換えず、暫定形状がある場合は統合して使う', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const legacyGeometry = [[[0, 0], [2, 0], [2, 2], [0, 0]]];
  const legacyData = [{ chochoName: '杉本三丁目', ward: '住吉区', boundaryId: '住吉区杉本三丁目', originalFullName: '住吉区杉本三丁目', geometry: legacyGeometry }];
  const officialData = [{
    municipalityCode: '27120', chochoCode: '024003', compositeCode: '27120:024003',
    ward: '住吉区', chochoName: '杉本三丁目', boundaryId: '住吉区杉本三丁目', originalFullName: '住吉区杉本三丁目',
    geometry: null, hasFullPolygon: false, officialAttributes: true, officialBoundary: false,
  }];
  await writeFile(legacyBoundariesPath(TEST_AREA_ID), JSON.stringify(legacyData), 'utf-8');
  await writeJson(officialBoundariesPath(TEST_AREA_ID), officialData);

  const result = await loadBoundaryMaster(TEST_AREA_ID);
  const merged = result.master[0];
  // 属性は公式データのまま(municipalityCode等)
  assert.equal(merged.municipalityCode, '27120');
  assert.equal(merged.compositeCode, '27120:024003');
  // 形状は暫定TOWN_POLYGONSのものが補完される
  assert.deepEqual(merged.geometry, legacyGeometry);
  assert.equal(merged.hasFullPolygon, true);
  // ただし暫定形状を公式形状であるかのように扱わない
  assert.equal(merged.officialBoundary, false);
  assert.equal(merged.geometrySourceType, 'embedded-html-town-polygons');
  assert.equal(merged.boundaryDataStatus, BOUNDARY_STATUS.OFFICIAL_ATTRIBUTES_WITH_LEGACY_GEOMETRY);
  await cleanupTestArea();
});

test('境界マスタ統合: Polygonを持つ正式レコードのみboundaryDataStatus:"official"になる(暫定形状があっても公式形状を優先する)', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const officialGeometry = [[[10, 10], [11, 10], [11, 11], [10, 10]]];
  const legacyGeometry = [[[0, 0], [2, 0], [2, 2], [0, 0]]]; // 公式形状と異なる(優先順位の検証用)
  const legacyData = [{ chochoName: '南住吉一丁目', ward: '住吉区', boundaryId: '住吉区南住吉一丁目', originalFullName: '住吉区南住吉一丁目', geometry: legacyGeometry }];
  const officialData = [{
    municipalityCode: '27120', chochoCode: '001001', compositeCode: '27120:001001',
    ward: '住吉区', chochoName: '南住吉一丁目', boundaryId: '住吉区南住吉一丁目', originalFullName: '住吉区南住吉一丁目',
    geometry: officialGeometry, hasFullPolygon: true, officialAttributes: true, officialBoundary: true,
  }];
  await writeFile(legacyBoundariesPath(TEST_AREA_ID), JSON.stringify(legacyData), 'utf-8');
  await writeJson(officialBoundariesPath(TEST_AREA_ID), officialData);

  const result = await loadBoundaryMaster(TEST_AREA_ID);
  const merged = result.master[0];
  assert.deepEqual(merged.geometry, officialGeometry); // 暫定形状(legacyGeometry)ではなく公式形状が使われる
  assert.equal(merged.officialBoundary, true);
  assert.equal(merged.boundaryDataStatus, BOUNDARY_STATUS.OFFICIAL);
  await cleanupTestArea();
});

test('境界マスタ統合: データセット全体の統計(officialAttributeRecords/officialBoundaryRecords/legacyGeometryRecords/recordsWithoutGeometry)が正しく集計される', async () => {
  await cleanupTestArea();
  await setupTestArea();
  const legacyData = [
    { chochoName: '南住吉一丁目', ward: '住吉区', boundaryId: '住吉区南住吉一丁目', geometry: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  ];
  const officialData = [
    { municipalityCode: '27120', chochoCode: '001001', compositeCode: '27120:001001', ward: '住吉区', chochoName: '南住吉一丁目', boundaryId: '住吉区南住吉一丁目', geometry: [[[5, 5], [6, 5], [6, 6], [5, 5]]], hasFullPolygon: true, officialAttributes: true, officialBoundary: true }, // 公式形状あり
    { municipalityCode: '27120', chochoCode: '024003', compositeCode: '27120:024003', ward: '住吉区', chochoName: '杉本三丁目', boundaryId: '住吉区杉本三丁目', geometry: null, hasFullPolygon: false, officialAttributes: true, officialBoundary: false }, // 形状なし(暫定にも無い)
    { municipalityCode: '27121', chochoCode: '001001', compositeCode: '27121:001001', ward: '東住吉区', chochoName: '今林一丁目', boundaryId: '東住吉区今林一丁目', geometry: null, hasFullPolygon: false, officialAttributes: true, officialBoundary: false }, // 形状なし(暫定にも無い)
  ];
  await writeFile(legacyBoundariesPath(TEST_AREA_ID), JSON.stringify(legacyData), 'utf-8');
  await writeJson(officialBoundariesPath(TEST_AREA_ID), officialData);

  const result = await loadBoundaryMaster(TEST_AREA_ID);
  assert.equal(result.officialAttributeRecords, 3);
  assert.equal(result.officialBoundaryRecords, 1); // 南住吉一丁目のみ公式形状あり
  assert.equal(result.legacyGeometryRecords, 0); // 杉本三丁目・今林一丁目は暫定側にも該当エントリが無い
  assert.equal(result.recordsWithoutGeometry, 2); // 杉本三丁目・今林一丁目
  await cleanupTestArea();
});
