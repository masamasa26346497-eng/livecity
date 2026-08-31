// tests/n03-boundaries.test.js
// [AutoDev P1-1 continuation] N03(国土数値情報 行政区域データ)取り込み・スキーマ検証のテスト。
//
// AUTODEV_REPORT.md 2026-08-26 USER_DECISION:
// - 実N03データの取得を待たず、synthetic fixtureでschema検証・取り込みロジックを検証する。
// - N03_001, N03_004, N03_005, N03_007 + Polygon/MultiPolygon geometryを検証対象にする。
// - schema不一致・大阪府/大阪市24区以外の誤採用はfail-fastで例外にする(推測補正しない)。
// - productionデータ・既存3区・config/areas/osaka-sumiyoshi.jsonはこの段階では変更しない。
//
// AUTODEV_REPORT.md 2026-08-27 REAL_N03_VALIDATION(実N03 2026大阪府GeoJSONで確認済みのスキーマ):
// - N03_004 = 市区町村名("大阪市"。区名は含まない)
// - N03_005 = 行政区名(例: "都島区")、N03_007 = 5桁全国地方公共団体コード
// - 同一区が複数Featureに分かれて出現するのは正常(大阪市24区が39 Featureで出現することを確認済み)。
//   重複エラーにはせず、1 ward recordへ統合する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { readFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { ingestN03FeatureCollection, validateN03Properties, validateN03ScopeProperties, resolveWardScope } from '../tools/lib/n03-boundaries.js';

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const REGISTRY = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'config', 'wards', 'registry.json'), 'utf-8'));
const FIXTURE_PATH = path.join(PROJECT_ROOT, 'tools', 'lib', '__fixtures__', 'boundaries', 'n03-osaka-sample.geojson');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));

const SUMIYOSHI_AREA_PROJECTION = { type: 'local-equirectangular', centerLat: 34.604208, centerLon: 135.52502, metersPerDegree: 111320 };

test('N03取り込み: fixtureの大阪市3区(住吉区/東住吉区/平野区)のみ抽出し、他府県・堺市・大阪府内の通常市町村は対象外になる', () => {
  const result = ingestN03FeatureCollection(FIXTURE, REGISTRY);
  assert.equal(result.recordCount, 3);
  assert.equal(result.outOfScopeCount, 3); // 京都市中京区、堺市堺区、豊中市(N03_005=null)
  const wardIds = result.records.map((r) => r.wardId).sort();
  assert.deepEqual(wardIds, ['higashisumiyoshi', 'hirano', 'sumiyoshi']);
});

test('N03取り込み: 大阪市外の通常市町村はN03_005=nullでも例外にならず正常にscope外として除外される', () => {
  const result = ingestN03FeatureCollection(FIXTURE, REGISTRY);
  assert.equal(result.recordCount, 3);
  assert.ok(!result.records.some((r) => r.sourceProperties.N03_004 === '豊中市'));
});

test('N03スキーマ検証: scope判定にはN03_001/N03_004のみ必須で、N03_005/N03_007が無くても例外にならない', () => {
  const props = validateN03ScopeProperties({ properties: { N03_001: '大阪府', N03_004: '豊中市', N03_005: null, N03_007: '27203' } }, 0);
  assert.equal(props.N03_004, '豊中市');
});

test('N03スキーマ検証: scope判定用のN03_001が欠落しているとfail-fastで例外を投げる', () => {
  assert.throws(() => validateN03ScopeProperties({ properties: { N03_004: '大阪市' } }, 0), /N03_001/);
});

test('N03取り込み: 同一区が複数Featureに分かれて出現する場合(平野区)、エラーにせず1 ward recordへ統合する', () => {
  const result = ingestN03FeatureCollection(FIXTURE, REGISTRY);
  const hirano = result.records.find((r) => r.wardId === 'hirano');
  assert.equal(hirano.sourceFeatureCount, 2);
  assert.equal(hirano.geometryType, 'MultiPolygon');
  assert.equal(hirano.geometry.raw.type, 'MultiPolygon');
  assert.equal(hirano.geometry.raw.coordinates.length, 2);

  const sumiyoshi = result.records.find((r) => r.wardId === 'sumiyoshi');
  assert.equal(sumiyoshi.sourceFeatureCount, 1);
  assert.equal(sumiyoshi.geometryType, 'Polygon');
});

test('N03取り込み: 未取得の21区がmissingWardsとして報告される', () => {
  const result = ingestN03FeatureCollection(FIXTURE, REGISTRY);
  assert.equal(result.missingWards.length, 21);
  assert.ok(!result.missingWards.some((w) => w.id === 'sumiyoshi'));
  assert.ok(result.missingWards.some((w) => w.id === 'kita'));
});

test('N03取り込み: --areaのprojectionを渡さない場合、WGS84の生geometryのまま構造検証のみ行う', () => {
  const result = ingestN03FeatureCollection(FIXTURE, REGISTRY);
  for (const record of result.records) {
    assert.equal(record.geometry.coordinatesConverted, false);
    assert.equal(record.geometry.coordinateConvention, null);
    assert.ok(record.geometry.raw);
    assert.equal(record.geometry.raw.type, record.geometryType);
  }
});

test('N03取り込み: projectionを渡した場合、既存projection.jsの式でThree.js座標(znorth-neg-v1)へ変換する', () => {
  const result = ingestN03FeatureCollection(FIXTURE, REGISTRY, { projection: SUMIYOSHI_AREA_PROJECTION });
  const sumiyoshi = result.records.find((r) => r.wardId === 'sumiyoshi');
  assert.equal(sumiyoshi.geometry.coordinatesConverted, true);
  assert.equal(sumiyoshi.geometry.coordinateConvention, 'znorth-neg-v1');
  assert.ok(Array.isArray(sumiyoshi.geometry.rings));
  assert.ok(sumiyoshi.geometry.rings.length > 0);
  for (const ring of sumiyoshi.geometry.rings) {
    for (const [x, z] of ring) {
      assert.equal(typeof x, 'number');
      assert.equal(typeof z, 'number');
      assert.ok(Number.isFinite(x));
      assert.ok(Number.isFinite(z));
    }
  }
});

test('N03取り込み: znorth-neg-v1 = 北ほど z が小さい（geoToLocal の +z 北から z を反転している）', () => {
  // fixture の住吉区リング: 緯度 34.60（南）と 34.62（北）の頂点を含む。
  // USER_DECISION 2026-08-31 (a): 変換後の z は「北 = 負」でなければならない。
  const north = 34.62, south = 34.60, lon = 135.50;
  const proj = SUMIYOSHI_AREA_PROJECTION;
  const zOf = (lat) => -(lat - proj.centerLat) * proj.metersPerDegree; // 期待式（negate 済み）
  assert.ok(zOf(north) < zOf(south), '北の頂点の方が z が小さい');

  const fc = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { N03_001: '大阪府', N03_004: '大阪市', N03_005: '住吉区', N03_007: '27120' },
      geometry: { type: 'Polygon', coordinates: [[[lon, south], [lon + 0.01, south], [lon + 0.01, north], [lon, north], [lon, south]]] },
    }],
  };
  const result = ingestN03FeatureCollection(fc, REGISTRY, { projection: proj });
  const ring = result.records[0].geometry.rings[0];
  const zs = ring.map((p) => p[1]);
  const zNorth = Math.min(...zs);
  const zSouth = Math.max(...zs);
  assert.ok(Math.abs(zNorth - zOf(north)) < 1, `北頂点 z=${zNorth} が期待 ${zOf(north).toFixed(1)} と一致`);
  assert.ok(Math.abs(zSouth - zOf(south)) < 1, `南頂点 z=${zSouth} が期待 ${zOf(south).toFixed(1)} と一致`);
});

test('N03取り込み: 出典データ(sourceProperties)にN03_001/004/005/007が原文のまま保持される', () => {
  const result = ingestN03FeatureCollection(FIXTURE, REGISTRY);
  const sumiyoshi = result.records.find((r) => r.wardId === 'sumiyoshi');
  assert.deepEqual(sumiyoshi.sourceProperties, { N03_001: '大阪府', N03_004: '大阪市', N03_005: '住吉区', N03_007: '27120' });
});

test('N03スキーマ検証: 必須フィールド(N03_007)が欠落しているとfail-fastで例外を投げる', () => {
  const bad = clone(FIXTURE);
  delete bad.features[0].properties.N03_007;
  assert.throws(() => ingestN03FeatureCollection(bad, REGISTRY), /N03_007/);
});

test('N03スキーマ検証: 必須フィールドが空文字列でもfail-fastで例外を投げる', () => {
  const bad = clone(FIXTURE);
  bad.features[0].properties.N03_005 = '';
  assert.throws(() => ingestN03FeatureCollection(bad, REGISTRY), /N03_005/);
});

test('N03スキーマ検証: propertiesが存在しないfeatureはfail-fastで例外を投げる', () => {
  const bad = clone(FIXTURE);
  delete bad.features[0].properties;
  assert.throws(() => validateN03Properties(bad.features[0], 0), /propertiesが存在しません/);
});

test('N03スキーマ検証: geometryがPoint型の場合は許可されずfail-fastで例外を投げる', () => {
  const bad = clone(FIXTURE);
  bad.features[0].geometry = { type: 'Point', coordinates: [135.5, 34.6] };
  assert.throws(() => ingestN03FeatureCollection(bad, REGISTRY), /Point/);
});

test('N03スキーマ検証: geometry座標にNaN相当(数値でない値)が含まれる場合はfail-fastで例外を投げる', () => {
  const bad = clone(FIXTURE);
  bad.features[0].geometry.coordinates[0][0] = ['not', 'a', 'point'];
  assert.throws(() => ingestN03FeatureCollection(bad, REGISTRY));
});

test('N03スキーマ検証: N03_007のコードとN03_005の名称が別々の区を指す場合、コード/名称不一致としてfail-fastになる', () => {
  const props = { N03_001: '大阪府', N03_004: '大阪市', N03_005: '天王寺区', N03_007: '27120' }; // code=住吉区, name=天王寺区
  assert.throws(() => resolveWardScope(props, REGISTRY, { properties: props }, 0), /コードと名称が不一致/);
});

test('N03スキーマ検証: 大阪市所属だがN03_007・N03_005のどちらもどの登録区とも一致しない場合、未知の区としてfail-fastになる', () => {
  const props = { N03_001: '大阪府', N03_004: '大阪市', N03_005: 'どこか区', N03_007: '99999' };
  assert.throws(() => resolveWardScope(props, REGISTRY, { properties: props }, 0), /どの区とも一致しません/);
});

test('N03スキーマ検証: 大阪市に無関係な大阪府内市町村はスコープ外として正常に除外される(例外にしない)', () => {
  const props = { N03_001: '大阪府', N03_004: '豊中市', N03_005: '豊中市', N03_007: '27203' };
  const scope = resolveWardScope(props, REGISTRY, { properties: props }, 0);
  assert.equal(scope.inScope, false);
});

test('N03取り込み: 大阪市24区・39 Feature相当のデータを取り込むと24 ward recordsに統合される(複数Featureは同一区として統合)', () => {
  const features = [];
  REGISTRY.wards.forEach((ward, i) => {
    const splitCount = i < 15 ? 2 : 1; // 24区中15区を2Featureに分割 => 15*2 + 9*1 = 39 features
    for (let j = 0; j < splitCount; j++) {
      features.push({
        type: 'Feature',
        properties: { N03_001: '大阪府', N03_004: '大阪市', N03_005: ward.name, N03_007: ward.code },
        geometry: {
          type: 'Polygon',
          coordinates: [[[135 + i * 0.02, 34 + j * 0.02], [135 + i * 0.02 + 0.01, 34 + j * 0.02], [135 + i * 0.02 + 0.01, 34 + j * 0.02 + 0.01], [135 + i * 0.02, 34 + j * 0.02 + 0.01], [135 + i * 0.02, 34 + j * 0.02]]],
        },
      });
    }
  });
  const fc = { type: 'FeatureCollection', name: 'synthetic-full-city-24ward-39feature', features };
  assert.equal(fc.features.length, 39);

  const result = ingestN03FeatureCollection(fc, REGISTRY);
  assert.equal(result.recordCount, 24);
  assert.equal(result.missingWards.length, 0);
  assert.equal(result.outOfScopeCount, 0);

  const splitRecords = result.records.filter((r) => r.sourceFeatureCount === 2);
  const singleRecords = result.records.filter((r) => r.sourceFeatureCount === 1);
  assert.equal(splitRecords.length, 15);
  assert.equal(singleRecords.length, 9);
  for (const r of splitRecords) {
    assert.equal(r.geometryType, 'MultiPolygon');
    assert.equal(r.geometry.raw.coordinates.length, 2);
  }
});

test('N03スキーマ検証: registryにwards配列が無い場合はfail-fastで例外を投げる', () => {
  assert.throws(() => ingestN03FeatureCollection(FIXTURE, { city: '大阪市' }), /wards配列がありません/);
});

test('N03スキーマ検証: FeatureCollection形式でない入力はfail-fastで例外を投げる', () => {
  assert.throws(() => ingestN03FeatureCollection({ type: 'Feature' }, REGISTRY), /FeatureCollection形式ではありません/);
});

test('N03取り込みCLI: fixtureに対して実行すると3区分を取り込み、--outputで指定した先にmetadata付きで保存される', async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'n03-ingest-test-'));
  try {
    const outputPath = path.join(tmpDir, 'n03-out.json');
    const stdout = execFileSync(
      'node',
      ['tools/ingest/n03-administrative-boundaries.js', '--input', FIXTURE_PATH, '--output', outputPath, '--reference-date', '2026-04-01'],
      { cwd: PROJECT_ROOT, encoding: 'utf-8' }
    );
    assert.match(stdout, /取り込み件数\(大阪市24区分\): 3/);
    assert.match(stdout, /対象外\(大阪市24区以外\)件数: 3/);

    const saved = JSON.parse(await readFile(outputPath, 'utf-8'));
    assert.equal(saved.records.length, 3);
    assert.equal(saved.metadata.referenceDate, '2026-04-01');
    assert.equal(saved.metadata.missingWards.length, 21);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('N03取り込みCLI: --inputを指定しないとusageエラーで終了する(exit code非0)', () => {
  assert.throws(() => {
    execFileSync('node', ['tools/ingest/n03-administrative-boundaries.js'], { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'pipe' });
  });
});
