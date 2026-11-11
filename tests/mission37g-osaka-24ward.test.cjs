'use strict';
/**
 * Mission 37G — 大阪市24区ページの静的ガード（node --test tests/mission37g-osaka-24ward.test.cjs）
 *   1. 区データ: 24 件・区コード/区名/ID が一意・境界が閉じている・座標が大阪市の範囲
 *   2. 区境界は元データ（N03 由来）と同じ形状で、新規に作っていない
 *   3. 3D 建物のカバレッジは住吉区だけと明記され、「24区の3D完成」と誤称していない
 *   4. 全域に戻る / 区一覧 / 検索 / flyTo の配線がある
 *   5. 住吉区の既存機能（canonicalId pick、写真、holds、移転ロック、Google 課金ロック）が残っている
 *   6. 本番 HTML 2 ファイル・37B・37C・37D に 37G の記述が混ざっていない
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const page = read('public/mission37g-osaka-24ward-mvp.html');
const wards = JSON.parse(read('public/mission37g-data/osaka-24-wards.json'));
const src = JSON.parse(read('public/map-data/osaka-city/boundaries/ward-classification-polygons.json'));

const PROJ = { clat: 34.604208, clon: 135.525020, mpd: 111320 };
const toLon = (x) => PROJ.clon + x / (Math.cos(PROJ.clat * Math.PI / 180) * PROJ.mpd);
const toLat = (z) => PROJ.clat - z / PROJ.mpd;

test('[37G] 区は 24 件で、区コード・区名・ID が一意', () => {
  assert.equal(wards.wardCount, 24);
  assert.equal(wards.wards.length, 24);
  for (const k of ['wardCode', 'wardName', 'wardId']) assert.equal(new Set(wards.wards.map((w) => w[k])).size, 24, k);
  for (const w of wards.wards) assert.match(w.wardCode, /^271\d\d$/);
  // 大阪市の行政区コードは 27102〜27128（27101/27105/27110/27112 は欠番）
  assert.equal(wards.wards.filter((w) => /区$/.test(w.wardName)).length, 24);
});

test('[37G] 境界は N03 由来の元データと同一形状（頂点数が一致）で、環が閉じている/座標が大阪市内', () => {
  for (const w of wards.wards) {
    const s = src.wards.find((x) => x.wardCode === w.wardCode);
    assert.ok(s, w.wardCode);
    assert.equal(w.polygons.length, s.polygons.length, w.wardName);
    w.polygons.forEach((p, i) => {
      assert.equal(p.outer.length, s.polygons[i].outer.length, w.wardName + ' outer');
      assert.ok(p.outer.length >= 4);
      for (const [x, z] of p.outer) {
        const lat = toLat(z), lon = toLon(x);
        assert.ok(lat > 34.5 && lat < 34.8 && lon > 135.3 && lon < 135.7, `${w.wardName} ${lat},${lon}`);
      }
    });
    assert.ok(w.bbox.minX < w.bbox.maxX && w.bbox.minZ < w.bbox.maxZ);
  }
  assert.ok(wards.source && /国土数値情報/.test(wards.source.source));
});

test('[37G] 住吉区の区コードは 27120 で、元データの件数が建物 manifest と一致', () => {
  const sumi = wards.wards.find((w) => w.wardName === '住吉区');
  assert.equal(sumi.wardCode, '27120');
  assert.equal(sumi.sourceBuildings, 35031);
  const man = JSON.parse(read('public/map-data/osaka-city/buildings/manifest.json'));
  assert.equal(wards.sourceBuildingsTotal, man.buildingCount);
  assert.equal(wards.wards.reduce((a, w) => a + w.sourceBuildings, 0), man.buildingCount);
});

test('[37G] 3D 建物の配信は住吉区だけで、COVERAGE は build-report の実測から算出する（誤称しない）', () => {
  assert.match(page, /COVERAGE\['27120'\] = \{ state: full \? 'full' : 'partial'/);
  assert.match(page, /TILES_BASE \+ 'build-report.json'/);
  assert.match(page, /3D建物データ未配信/);
  assert.match(page, /住吉区の元データ/);
  assert.ok(!/24区の3D建物が(完成|見え)/.test(page));
  const tiles = JSON.parse(read('public/mission37b-3dtiles/osaka-sumiyoshi-9tile/build-report.json'));
  assert.ok(JSON.stringify(tiles).includes('10546') || JSON.stringify(tiles).includes('10,546'));
});

test('[37G] 区一覧・検索・全域に戻る・flyTo・ラベルの配線', () => {
  assert.match(page, /id="btn-home">全域に戻る</);
  assert.match(page, /id="lc-ward-list"/);
  assert.match(page, /flyToBoundingSphere\(new Cesium\.BoundingSphere\(toCart\(w\.cx, w\.cz, 0\)/);
  assert.match(page, /kind: '区'/);
  assert.match(page, /id: 'wards'/);
  assert.match(page, /id: 'wardlabels'/);
  assert.match(page, /cityHome = \{ center:/);
  assert.match(page, /FALLBACK|if \(!cityHome && wardsSettled\) resetCamera\(\)|if \(!cityHome\) \{ await setBuildingWard\(BASE_WARD\)/);
  // 境界を矩形などで作っていない
  assert.ok(!/Rectangle\.fromDegrees|new Cesium\.RectangleGeometry/.test(page));
});

test('[37G] 投影定数と canonicalId の pick が 37D と同じ', () => {
  assert.match(page, /const PROJ = \{ clat: 34\.604208, clon: 135\.525020, mpd: 111320 \}/);
  assert.match(page, /\/\^bldg_\/\.test\(id\)/);
  assert.match(page, /picked\.getProperty\('canonicalId'\)/);
  assert.match(page, /'cg_bldg_'/);
});

test('[37G] 37D/37F の写真・holds・移転ロックと Google 課金ロックが残っている', () => {
  assert.match(page, /RELOCATED/);
  assert.match(page, /bldg_ec74351a-f344-4b61-b2e6-04b660b05aa0/);
  assert.match(page, /photo-review\.json/);
  assert.match(page, /mission37f-photo-select\.js/);
  assert.ok(!/maps\.googleapis\.com|places\.googleapis\.com|AIza/.test(page));
  assert.match(read('public/mission37e-places-ui-kit.js'), /ENABLED\s*=\s*false/);
});

test('[37G] 本番 HTML / 37B / 37C / 37D に 37G の記述が無い', () => {
  for (const f of ['public/osaka_3d_buildings.html', 'public/osaka_3d_buildings.fullward-v3.html',
    'public/mission37b-3dtiles-poc.html', 'public/mission37b-livecity-cesium-tiles.html',
    'public/mission37c-livecity-theme.html', 'public/mission37d-sumiyoshi-mvp.html']) {
    assert.ok(!/mission37g|Mission 37G/.test(read(f)), f);
  }
});
