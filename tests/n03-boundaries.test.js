// tests/n03-boundaries.test.js
// [AutoDev P1-1 continuation] N03(国土数値情報 行政区域データ)取り込み・スキーマ検証のテスト。
//
// AUTODEV_REPORT.md 2026-08-26 USER_DECISION:
// - 実N03データの取得を待たず、synthetic fixtureでschema検証・取り込みロジックを検証する。
// - N03_001, N03_004, N03_005, N03_007 + Polygon/MultiPolygon geometryを検証対象にする。
// - schema不一致・大阪府/大阪市24区以外の誤採用はfail-fastで例外にする(推測補正しない)。
// - productionデータ・既存3区・config/areas/osaka-sumiyoshi.jsonはこの段階では変更しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { readFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { ingestN03FeatureCollection, validateN03Properties, resolveWardScope } from '../tools/lib/n03-boundaries.js';

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const REGISTRY = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'config', 'wards', 'registry.json'), 'utf-8'));
const FIXTURE_PATH = path.join(PROJECT_ROOT, 'tools', 'lib', '__fixtures__', 'boundaries', 'n03-osaka-sample.geojson');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));

const SUMIYOSHI_AREA_PROJECTION = { type: 'local-equirectangular', centerLat: 34.604208, centerLon: 135.52502, metersPerDegree: 111320 };

test('N03取り込み: fixtureの大阪市3区(住吉区/東住吉区/平野区)のみ抽出し、他府県・堺市は対象外になる', () => {
  const result = ingestN03FeatureCollection(FIXTURE, REGISTRY);
  assert.equal(result.recordCount, 3);
  assert.equal(result.outOfScopeCount, 2); // 京都市中京区、堺市堺区
  const wardIds = result.records.map((r) => r.wardId).sort();
  assert.deepEqual(wardIds, ['higashisumiyoshi', 'hirano', 'sumiyoshi']);
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

test('N03取り込み: 出典データ(sourceProperties)にN03_001/004/005/007が原文のまま保持される', () => {
  const result = ingestN03FeatureCollection(FIXTURE, REGISTRY);
  const sumiyoshi = result.records.find((r) => r.wardId === 'sumiyoshi');
  assert.deepEqual(sumiyoshi.sourceProperties, { N03_001: '大阪府', N03_004: '大阪市住吉区', N03_005: '27120', N03_007: '27120' });
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

test('N03スキーマ検証: N03_005が登録区codeと一致するがN03_004に区名が含まれない場合、コード/名称不一致としてfail-fastになる', () => {
  const props = { N03_001: '大阪府', N03_004: '大阪市天王寺区', N03_005: '27120', N03_007: '27120' };
  assert.throws(() => resolveWardScope(props, REGISTRY, { properties: props }, 0), /コードと名称が不一致/);
});

test('N03スキーマ検証: 大阪市を含むがどの区codeとも一致しない場合、未知の区としてfail-fastになる', () => {
  const props = { N03_001: '大阪府', N03_004: '大阪市どこか区', N03_005: '99999', N03_007: '99999' };
  assert.throws(() => resolveWardScope(props, REGISTRY, { properties: props }, 0), /どの区codeとも一致しません/);
});

test('N03スキーマ検証: 大阪市に無関係な大阪府内市町村はスコープ外として正常に除外される(例外にしない)', () => {
  const props = { N03_001: '大阪府', N03_004: '豊中市', N03_005: '27203', N03_007: '27203' };
  const scope = resolveWardScope(props, REGISTRY, { properties: props }, 0);
  assert.equal(scope.inScope, false);
});

test('N03スキーマ検証: 同じ区codeが複数回出現する場合はfail-fastで例外を投げる', () => {
  const bad = clone(FIXTURE);
  bad.features.push(clone(FIXTURE.features[0]));
  assert.throws(() => ingestN03FeatureCollection(bad, REGISTRY), /複数回出現/);
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
    assert.match(stdout, /対象外\(大阪市24区以外\)件数: 2/);

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
