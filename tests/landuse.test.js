// tests/landuse.test.js
// 土地利用(landuse)の分類・変換ロジックのテスト。
// ネットワークには一切接続せず、fixture(Overpassの応答を模したJSON)のみで検証する。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import path from 'path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import {
  classifyLanduse,
  classifyParking,
  isDuplicateWithExistingParkLayer,
  LANDUSE_QUERY_GROUPS,
  PARKING_SUBTYPES,
} from '../tools/lib/landuse.js';
import { convertElement } from '../tools/convert/landuse.js';

const FIXTURE_PATH = path.join(PROJECT_ROOT, 'tools/lib/__fixtures__/landuse-osm-sample.json');
const AREA_CONFIG_PATH = path.join(PROJECT_ROOT, 'config/areas/osaka-sumiyoshi.json');

async function loadFixture() {
  return JSON.parse(await readFile(FIXTURE_PATH, 'utf-8'));
}
async function loadProjection() {
  const cfg = JSON.parse(await readFile(AREA_CONFIG_PATH, 'utf-8'));
  return cfg.projection;
}
/** fixture内の全要素をフラットに取り出す */
function allElements(raw) {
  return Object.values(raw.groups).flat();
}
function findElement(raw, type, id) {
  return allElements(raw).find((el) => el.type === type && el.id === id);
}

describe('landuse: 駐車場の分類', () => {
  test('parking=* の値を5種のサブタイプへ正規化する', () => {
    assert.equal(classifyParking({ parking: 'surface' }), 'parking_surface');
    assert.equal(classifyParking({ parking: 'multi-storey' }), 'parking_multi_storey');
    assert.equal(classifyParking({ parking: 'multi_storey' }), 'parking_multi_storey');
    assert.equal(classifyParking({ parking: 'garage' }), 'parking_multi_storey');
    assert.equal(classifyParking({ parking: 'underground' }), 'parking_underground');
    assert.equal(classifyParking({ parking: 'rooftop' }), 'parking_rooftop');
  });

  test('parking タグが無い場合は parking_unspecified になる', () => {
    assert.equal(classifyParking({}), 'parking_unspecified');
    assert.equal(classifyParking({ parking: 'unknown_value' }), 'parking_unspecified');
  });

  test('5種のサブタイプがすべて定義されている', () => {
    assert.deepEqual(PARKING_SUBTYPES, [
      'parking_surface',
      'parking_multi_storey',
      'parking_underground',
      'parking_rooftop',
      'parking_unspecified',
    ]);
  });
});

describe('landuse: カテゴリ分類', () => {
  test('第1優先: amenity=parking', () => {
    const r = classifyLanduse({ amenity: 'parking', parking: 'surface' });
    assert.equal(r.category, 'parking');
    assert.equal(r.subtype, 'parking_surface');
    assert.equal(r.priority, 1);
  });

  test('第2優先: 公園・レクリエーション・芝生', () => {
    assert.equal(classifyLanduse({ leisure: 'park' }).category, 'park');
    assert.equal(classifyLanduse({ landuse: 'recreation_ground' }).category, 'park');
    assert.equal(classifyLanduse({ landuse: 'grass' }).category, 'grass');
    assert.equal(classifyLanduse({ leisure: 'park' }).priority, 2);
  });

  test('第3優先: 墓地・工業・商業・小売・工事中・鉄道用地', () => {
    assert.equal(classifyLanduse({ landuse: 'cemetery' }).category, 'cemetery');
    assert.equal(classifyLanduse({ landuse: 'industrial' }).category, 'industrial');
    assert.equal(classifyLanduse({ landuse: 'commercial' }).category, 'commercial');
    assert.equal(classifyLanduse({ landuse: 'retail' }).category, 'commercial');
    assert.equal(classifyLanduse({ landuse: 'construction' }).category, 'construction');
    assert.equal(classifyLanduse({ landuse: 'railway' }).category, 'railway');
  });

  test('第4優先: 自然・水域', () => {
    assert.equal(classifyLanduse({ natural: 'wood' }).category, 'wood');
    assert.equal(classifyLanduse({ natural: 'scrub' }).category, 'wood');
    assert.equal(classifyLanduse({ natural: 'grassland' }).category, 'grass');
    assert.equal(classifyLanduse({ natural: 'water' }).category, 'water');
    assert.equal(classifyLanduse({ waterway: 'riverbank' }).category, 'water');
  });

  test('複数タグを持つ場合は優先度の高いものを採用する', () => {
    // leisure=park かつ landuse=grass → park(第2優先の中でもparkを先に判定)
    const r = classifyLanduse({ leisure: 'park', landuse: 'grass' });
    assert.equal(r.category, 'park');
    // amenity=parking かつ landuse=commercial → parking(第1優先)
    const r2 = classifyLanduse({ amenity: 'parking', landuse: 'commercial' });
    assert.equal(r2.category, 'parking');
  });

  test('対象外のタグは null を返す', () => {
    assert.equal(classifyLanduse({ building: 'house' }), null);
    assert.equal(classifyLanduse({ highway: 'residential' }), null);
    assert.equal(classifyLanduse({}), null);
  });
});

describe('landuse: 既存ParkLayerとの重複判定', () => {
  test('parks.json が収録するサブタイプは重複フラグが立つ', () => {
    assert.equal(isDuplicateWithExistingParkLayer('leisure_park'), true);
    assert.equal(isDuplicateWithExistingParkLayer('landuse_recreation_ground'), true);
    assert.equal(isDuplicateWithExistingParkLayer('landuse_grass'), true);
  });

  test('parks.json に含まれないサブタイプは重複フラグが立たない', () => {
    assert.equal(isDuplicateWithExistingParkLayer('landuse_industrial'), false);
    assert.equal(isDuplicateWithExistingParkLayer('parking_surface'), false);
    assert.equal(isDuplicateWithExistingParkLayer('natural_water'), false);
  });
});

describe('landuse: Overpassクエリ群', () => {
  test('3群(parking/landuse/natural_and_water)が定義されている', () => {
    assert.deepEqual(Object.keys(LANDUSE_QUERY_GROUPS), ['parking', 'landuse', 'natural_and_water']);
  });

  test('各群がway/relationを対象に含む', () => {
    for (const [group, filters] of Object.entries(LANDUSE_QUERY_GROUPS)) {
      assert.ok(filters.some((f) => f.startsWith('way')), `${group} に way が含まれる`);
      assert.ok(filters.some((f) => f.startsWith('relation')), `${group} に relation が含まれる`);
    }
  });
});

describe('landuse: Polygon(way)の変換', () => {
  test('単純なway → 1つのpolygon(outerのみ、holesは空)', async () => {
    const raw = await loadFixture();
    const projection = await loadProjection();
    const el = findElement(raw, 'way', 1001); // 駐車場(surface)
    const rec = convertElement(el, projection);

    assert.ok(rec, 'レコードが生成される');
    assert.equal(rec.id, 'way/1001');
    assert.equal(rec.osmType, 'way');
    assert.equal(rec.category, 'parking');
    assert.equal(rec.subtype, 'parking_surface');
    assert.equal(rec.polygons.length, 1);
    assert.equal(rec.polygons[0].holes.length, 0);
    // 座標がローカル座標(x,z: メートル)へ変換されている
    assert.ok(Array.isArray(rec.polygons[0].outer));
    assert.ok(rec.polygons[0].outer.length >= 4);
    for (const pt of rec.polygons[0].outer) {
      assert.equal(pt.length, 2);
      assert.equal(typeof pt[0], 'number');
      assert.equal(typeof pt[1], 'number');
    }
  });

  test('閉じていないリングは自動的に閉じられる', async () => {
    const raw = await loadFixture();
    const projection = await loadProjection();
    const el = findElement(raw, 'way', 1002); // 始点と終点が一致しないway
    const rec = convertElement(el, projection);

    assert.ok(rec);
    const outer = rec.polygons[0].outer;
    assert.deepEqual(outer[0], outer[outer.length - 1], '始点と終点が一致する(閉じている)');
  });

  test('元のOSMタグが保持される', async () => {
    const raw = await loadFixture();
    const projection = await loadProjection();
    const el = findElement(raw, 'way', 2001); // 公園(name付き)
    const rec = convertElement(el, projection);

    assert.equal(rec.tags.leisure, 'park');
    assert.equal(rec.tags.name, 'テスト公園');
    assert.equal(rec.duplicateWithExistingParkLayer, true, '既存ParkLayerと重複するフラグ');
  });
});

describe('landuse: MultiPolygon(relation)の変換', () => {
  test('inner ring(穴)が保持される', async () => {
    const raw = await loadFixture();
    const projection = await loadProjection();
    const el = findElement(raw, 'relation', 3001); // outer 1 + inner 1
    const rec = convertElement(el, projection);

    assert.ok(rec, 'レコードが生成される');
    assert.equal(rec.osmType, 'relation');
    assert.equal(rec.category, 'grass');
    assert.equal(rec.polygons.length, 1, 'outerが1つ');
    assert.equal(rec.polygons[0].holes.length, 1, 'inner ring(穴)が1つ保持されている');

    // 穴のリングも閉じている
    const hole = rec.polygons[0].holes[0];
    assert.ok(hole.length >= 4);
    assert.deepEqual(hole[0], hole[hole.length - 1]);
  });

  test('分割されたouterの断片がつなぎ合わされて1つのリングになる', async () => {
    const raw = await loadFixture();
    const projection = await loadProjection();
    const el = findElement(raw, 'relation', 3002); // outerが2つのwayに分かれている
    const rec = convertElement(el, projection);

    assert.ok(rec, '断片がつながってレコードが生成される');
    assert.equal(rec.polygons.length, 1, '1つの閉じたouterリングになる');
    const outer = rec.polygons[0].outer;
    assert.deepEqual(outer[0], outer[outer.length - 1], 'リングが閉じている');
  });
});

describe('landuse: 不完全なジオメトリの安全なスキップ', () => {
  test('outerが1つも無いrelationはスキップされる(例外を投げない)', async () => {
    const raw = await loadFixture();
    const projection = await loadProjection();
    const el = findElement(raw, 'relation', 3003); // innerのみ
    const rec = convertElement(el, projection);
    assert.equal(rec, null, 'nullを返してスキップ');
  });

  test('欠損ノード(null)を含むwayはスキップされる', async () => {
    const raw = await loadFixture();
    const projection = await loadProjection();
    const el = findElement(raw, 'way', 2005); // geometryにnullを含む
    const rec = convertElement(el, projection);
    assert.equal(rec, null, 'nullを返してスキップ');
  });

  test('対象外タグの要素はスキップされる', async () => {
    const raw = await loadFixture();
    const projection = await loadProjection();
    const el = findElement(raw, 'way', 2006); // building=house
    const rec = convertElement(el, projection);
    assert.equal(rec, null);
  });

  test('点(node)は面レイヤーには使わない', async () => {
    const raw = await loadFixture();
    const projection = await loadProjection();
    const el = findElement(raw, 'node', 1004); // amenity=parking の点
    const rec = convertElement(el, projection);
    assert.equal(rec, null, '点はnullを返す(統計には別途計上する)');
  });
});

describe('landuse: 出力構造', () => {
  test('必須フィールドがすべて揃っている', async () => {
    const raw = await loadFixture();
    const projection = await loadProjection();
    const el = findElement(raw, 'way', 4001); // 水域
    const rec = convertElement(el, projection);

    for (const key of [
      'id', 'osmType', 'category', 'subtype', 'priority',
      'duplicateWithExistingParkLayer', 'tags', 'polygons',
    ]) {
      assert.ok(key in rec, `${key} が存在する`);
    }
    assert.equal(rec.category, 'water');
    assert.equal(rec.subtype, 'natural_water');
    assert.equal(rec.priority, 4);
  });

  test('fixture全体を変換しても例外が発生せず、期待件数が得られる', async () => {
    const raw = await loadFixture();
    const projection = await loadProjection();

    const records = [];
    let skipped = 0;
    for (const el of allElements(raw)) {
      const rec = convertElement(el, projection);
      if (rec) records.push(rec);
      else skipped++;
    }

    // 面として出力される: way 1001,1002,1003(駐車場3), 2001,2002,2003,2004(4),
    //                     relation 3001,3002(2), way 4001,4002,4003(3) = 12件
    assert.equal(records.length, 12, '12件が面として変換される');
    // スキップ: node 1004,1005(2), relation 3003(1), way 2005(1), way 2006(1) = 5件
    assert.equal(skipped, 5, '5件が安全にスキップされる');

    // カテゴリの内訳
    const byCategory = {};
    for (const r of records) byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    assert.equal(byCategory.parking, 3);
    assert.equal(byCategory.park, 1);
    assert.equal(byCategory.industrial, 1);
    assert.equal(byCategory.commercial, 2); // landuse=commercial + landuse=retail
    assert.equal(byCategory.cemetery, 1);
    assert.equal(byCategory.grass, 1);
    assert.equal(byCategory.water, 2);      // natural=water + waterway=riverbank
    assert.equal(byCategory.wood, 1);
  });
});
