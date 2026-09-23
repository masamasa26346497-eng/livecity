// Mission 35L: 24区町丁目境界完全化の純粋ロジックテスト。
import test from 'node:test';
import assert from 'node:assert/strict';
import { featureToTown, buildTownGroups, buildLabelMap } from '../tools/build-official-town-boundaries.js';
import { ringsToGeoJsonGeometry } from '../tools/lib/shapefile-polygon.js';

const projection = { centerLat: 34.604208, centerLon: 135.52502, metersPerDegree: 111320 };
const wardByCode = new Map([
  ['27127', { id: 'kita', name: '北区', code: '27127' }],
  ['27128', { id: 'chuo', name: '中央区', code: '27128' }],
]);

function square(w, s, e, n) {
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}
function feat(key, city, name, ring) {
  return { type: 'Feature', properties: { KEY_CODE: key, CITY_NAME: city, S_NAME: name }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

test('35L e-Stat featureを公式町丁目へ変換し znorth-neg-v1 を守る', () => {
  const t = featureToTown(feat('27127001001', '大阪市北区', '梅田一丁目', square(135.49, 34.69, 135.50, 34.70)), { wardByCode, projection });
  assert.equal(t.wardId, 'kita');
  assert.equal(t.wardName, '北区');
  assert.equal(t.name, '梅田一丁目');
  assert.equal(t.baseName, '梅田');
  assert.equal(t.boundarySource, 'estat-census-2020-official');
  assert.equal(t.officialBoundary, true);
  // 北緯34.69は原点34.604208より北なので、znorth-neg-v1ではzが負になる。
  assert.ok(t.rings[0].every((p) => p[1] < 0), JSON.stringify(t.rings[0]));
});

test('35L 大阪市24区以外のfeatureは取り込まない', () => {
  const t = featureToTown(feat('27227001001', '東大阪市', '本町', square(135.60, 34.66, 135.61, 34.67)), { wardByCode, projection });
  assert.equal(t, null);
});

test('35L KEY_CODEとCITY_NAMEの区が食い違えばfail-fast', () => {
  assert.throws(() => featureToTown(
    feat('27127001001', '大阪市中央区', '梅田一丁目', square(135.49, 34.69, 135.50, 34.70)),
    { wardByCode, projection },
  ), /ward mismatch/);
});

test('35L 同一基準地名の丁目は町名グループへ束ねるが座標を発明しない', () => {
  const a = featureToTown(feat('27127001001', '大阪市北区', '梅田一丁目', square(135.49, 34.69, 135.495, 34.695)), { wardByCode, projection });
  const b = featureToTown(feat('27127001002', '大阪市北区', '梅田二丁目', square(135.495, 34.69, 135.50, 34.695)), { wardByCode, projection });
  const groups = buildTownGroups([a, b]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, '梅田');
  assert.equal(groups[0].memberCount, 2);
  assert.equal(groups[0].rings.length, a.rings.length + b.rings.length);
  assert.equal(groups[0].boundarySource, 'estat-census-2020-official');
});

test('35L ラベルは公式町丁目を最優先し、無い場合だけ区界fallback', () => {
  const t = featureToTown(feat('27127001001', '大阪市北区', '梅田一丁目', square(135.49, 34.69, 135.50, 34.70)), { wardByCode, projection });
  const groups = buildTownGroups([t]);
  const wards = [
    { id: 'ward:kita', wardId: 'kita', wardName: '北区' },
    { id: 'ward:chuo', wardId: 'chuo', wardName: '中央区' },
  ];
  const places = [
    { id: 'place:umeda', name: '梅田一丁目', ward: '北区' },
    { id: 'place:unknown-chuo', name: '架空でないが境界未一致の地名', ward: '中央区' },
  ];
  const out = buildLabelMap({ places, towns: [t], groups, wards });
  assert.equal(out.labelMap['place:umeda'].areaId, t.id);
  assert.equal(out.labelMap['place:unknown-chuo'].areaId, 'ward:chuo');
  assert.equal(out.labelMap['place:unknown-chuo'].fallback, 'ward');
  assert.deepEqual(out.counts, { labelsToTown: 1, labelsToWard: 1, labelsUnresolved: 0 });
});

test('35L Shapefile ringの包含関係からholeを維持する', () => {
  const outer = square(135.0, 34.0, 136.0, 35.0);
  const hole = square(135.2, 34.2, 135.3, 34.3);
  const geometry = ringsToGeoJsonGeometry([outer, hole]);
  assert.equal(geometry.type, 'Polygon');
  assert.equal(geometry.coordinates.length, 2);
});
