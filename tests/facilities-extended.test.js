// tests/facilities-extended.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import path from 'path';
import {
  convertFacilitiesExtended, classifyTags, normalizeFacilityName, detectDuplicateCandidates,
} from '../tools/convert/facilities-extended.js';
import { haversineDistanceMeters } from '../tools/lib/distance.js';

const PROJECTION = { centerLat: 34.604208, centerLon: 135.525020, metersPerDegree: 111320 };
const BBOX = { south: 34.599824, west: 135.499929, north: 34.608592, east: 135.550111 };
const SOURCE_META = { provider: 'OpenStreetMap', license: 'ODbL 1.0', attribution: '© OpenStreetMap contributors', downloadedAt: '2026-06-29T00:00:00Z' };

let facilityConfig;
test.before(async () => {
  const configPath = path.join(import.meta.dirname, '..', 'config', 'facilities', 'categories.json');
  facilityConfig = JSON.parse(await readFile(configPath, 'utf-8'));
});

test('施設分類: shop=supermarketがshopping/supermarketに分類される', () => {
  const result = classifyTags({ shop: 'supermarket' }, 'テストスーパー', facilityConfig);
  assert.equal(result.category, 'shopping');
  assert.equal(result.subcategory, 'supermarket');
});

test('施設分類: amenity=hospitalがmedical/hospitalに分類される', () => {
  const result = classifyTags({ amenity: 'hospital' }, 'テスト病院', facilityConfig);
  assert.equal(result.category, 'medical');
  assert.equal(result.subcategory, 'hospital');
});

test('施設分類: 複数タグを持つ施設は、ルール順で先に一致したものが優先される', () => {
  // shopとamenityの両方を持つ場合、rules配列内でshop=supermarketが先に定義されているため
  // そちらが優先されることを確認する(分類優先順位のテスト)。
  const result = classifyTags({ shop: 'supermarket', amenity: 'pharmacy' }, '複合施設', facilityConfig);
  assert.equal(result.category, 'shopping');
});

test('施設分類: amenity=place_of_worship + religion=shintoは神社(tourism/shrine)に分類される', () => {
  const result = classifyTags({ amenity: 'place_of_worship', religion: 'shinto' }, '某神社', facilityConfig);
  assert.equal(result.category, 'tourism');
  assert.equal(result.subcategory, 'shrine');
});

test('施設分類: religionタグが無い場合、名称パターン("寺"で終わる)から寺院と判定される', () => {
  const result = classifyTags({ amenity: 'place_of_worship' }, '一心寺', facilityConfig);
  assert.equal(result.subcategory, 'temple');
  assert.equal(result.classifiedBy, 'name-pattern');
});

test('施設分類: historic=*は値そのものがsubcategoryに反映される', () => {
  const result = classifyTags({ historic: 'monument' }, '記念碑', facilityConfig);
  assert.equal(result.category, 'tourism');
  assert.equal(result.subcategory, 'historic_monument');
});

test('施設分類: 分類できないタグはunknownになる(削除されない)', () => {
  const result = classifyTags({ foo: 'bar' }, '不明な施設', facilityConfig);
  assert.equal(result.category, 'unknown');
});

test('変換: 名称なし施設は結果に含まれず、スキップ理由が記録される', () => {
  const elements = [{ type: 'node', id: 1, lat: 34.604, lon: 135.52, tags: { shop: 'convenience' } }];
  const { records, skipped } = convertFacilitiesExtended(elements, PROJECTION, BBOX, facilityConfig, SOURCE_META);
  assert.equal(records.length, 0);
  assert.equal(skipped[0].reason, 'no-name');
});

test('変換: 緯度経度が不正(範囲外)な施設は除外される', () => {
  const elements = [{ type: 'node', id: 1, lat: 999, lon: 999, tags: { shop: 'convenience', name: 'テスト' } }];
  const { records, skipped } = convertFacilitiesExtended(elements, PROJECTION, BBOX, facilityConfig, SOURCE_META);
  assert.equal(records.length, 0);
  assert.equal(skipped[0].reason, 'invalid-or-out-of-bbox-coordinates');
});

test('変換: 対象bbox外の座標を持つ施設は除外される', () => {
  const elements = [{ type: 'node', id: 1, lat: 35.5, lon: 139.7, tags: { shop: 'convenience', name: '東京の店' } }]; // 東京駅付近
  const { records, skipped } = convertFacilitiesExtended(elements, PROJECTION, BBOX, facilityConfig, SOURCE_META);
  assert.equal(records.length, 0);
  assert.equal(skipped[0].reason, 'invalid-or-out-of-bbox-coordinates');
});

test('変換: 緯度経度の原本(latitude/longitude)とローカル座標(localX/localZ)が両方保持される', () => {
  const elements = [{ type: 'node', id: 1, lat: 34.604, lon: 135.520, tags: { shop: 'supermarket', name: 'テストストア' } }];
  const { records } = convertFacilitiesExtended(elements, PROJECTION, BBOX, facilityConfig, SOURCE_META);
  assert.equal(records[0].latitude, 34.604);
  assert.equal(records[0].longitude, 135.520);
  assert.equal(typeof records[0].localX, 'number');
  assert.equal(typeof records[0].localZ, 'number');
});

test('重複候補判定: 同一カテゴリ・同名・近距離の施設が重複候補として双方に記録される(自動削除されない)', () => {
  const elements = [
    { type: 'node', id: 1, lat: 34.604, lon: 135.520, tags: { shop: 'supermarket', name: 'ライフ住吉店' } },
    { type: 'node', id: 2, lat: 34.6041, lon: 135.5201, tags: { shop: 'supermarket', name: 'ライフ住吉店' } },
  ];
  const { records } = convertFacilitiesExtended(elements, PROJECTION, BBOX, facilityConfig, SOURCE_META);
  detectDuplicateCandidates(records);
  assert.equal(records.length, 2); // 自動削除されず両方残っている
  assert.equal(records[0].duplicateCandidates.length, 1);
  assert.equal(records[1].duplicateCandidates.length, 1);
});

test('重複候補判定: カテゴリが異なる場合は重複候補としない', () => {
  const elements = [
    { type: 'node', id: 1, lat: 34.604, lon: 135.520, tags: { shop: 'supermarket', name: 'テスト' } },
    { type: 'node', id: 2, lat: 34.6041, lon: 135.5201, tags: { amenity: 'hospital', name: 'テスト' } },
  ];
  const { records } = convertFacilitiesExtended(elements, PROJECTION, BBOX, facilityConfig, SOURCE_META);
  detectDuplicateCandidates(records);
  assert.equal(records[0].duplicateCandidates.length, 0);
});

test('重複候補判定: 距離が遠い場合は重複候補としない', () => {
  const elements = [
    { type: 'node', id: 1, lat: 34.604, lon: 135.520, tags: { shop: 'supermarket', name: 'ライフ住吉店' } },
    { type: 'node', id: 2, lat: 34.608, lon: 135.549, tags: { shop: 'supermarket', name: 'ライフ住吉店' } }, // 数km離れている
  ];
  const { records } = convertFacilitiesExtended(elements, PROJECTION, BBOX, facilityConfig, SOURCE_META);
  detectDuplicateCandidates(records);
  assert.equal(records[0].duplicateCandidates.length, 0);
});

test('Haversine距離: 既知の2点間距離(大阪駅-新大阪駅、約3.5km)を妥当な誤差で計算できる', () => {
  const d = haversineDistanceMeters(34.7024, 135.4959, 34.7335, 135.5004);
  assert.ok(d > 3300 && d < 3700, `距離が想定範囲外: ${d}m`);
});

test('Haversine距離: 同一地点の距離は0になる', () => {
  const d = haversineDistanceMeters(34.604, 135.520, 34.604, 135.520);
  assert.equal(d, 0);
});

test('名称正規化: 全角数字と半角数字が同一視される', () => {
  assert.equal(normalizeFacilityName('スーパー１号店'), normalizeFacilityName('スーパー1号店'));
});

test('名称正規化: 全角半角・空白の差を吸収する', () => {
  assert.equal(normalizeFacilityName('テスト 店舗'), normalizeFacilityName('テスト店舗'));
});
