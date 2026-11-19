// Mission 161: LOD2 プレビュー経路(fixture ベース。実データ検証は tools/lod2/lod2-verify-chrome.cjs)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildLod2Mesh, convexHull } from '../tools/lod2/lod2-to-glb.js';
import { auditGml } from '../tools/lod2/lod2-audit.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const poly = (id, pts) => `<gml:Polygon gml:id="${id}"><gml:exterior><gml:LinearRing><gml:posList>${pts.map((p) => p.join(' ')).join(' ')}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>`;
const surf = (kind, id, pts) => `<bldg:boundedBy><bldg:${kind}Surface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember>${poly(id, pts)}</gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:${kind}Surface></bldg:boundedBy>`;
const bld = (id, h0) => `<bldg:Building gml:id="${id}">${surf('Ground', id + '-g', [[34.65, 135.4, h0], [34.65, 135.4001, h0], [34.6501, 135.4001, h0], [34.6501, 135.4, h0], [34.65, 135.4, h0]])}` +
  surf('Roof', id + '-r', [[34.65, 135.4, h0 + 8], [34.6501, 135.4, h0 + 8], [34.6501, 135.4001, h0 + 8], [34.65, 135.4001, h0 + 8], [34.65, 135.4, h0 + 8]]) + '</bldg:Building>';

test('groundToZero: 建物ごとに最低点を z=0 へ(垂直のみ)。既定は従来どおり一律標高', () => {
  const org = { lat: 34.65, lon: 135.4, h: 0 };
  const m = new Map([['b1', bld('b1', 40)]]);
  const raw = buildLod2Mesh(m, org), grounded = buildLod2Mesh(m, org, { groundToZero: true });
  assert.ok(raw.extentEnu.z[0] > 35, 'default keeps source height');
  assert.ok(Math.abs(grounded.extentEnu.z[0]) < 0.01 && Math.abs(grounded.extentEnu.z[1] - 8) < 0.1);
  assert.deepEqual(raw.extentEnu.x, grounded.extentEnu.x, 'horizontal untouched');
  assert.equal(grounded.ok[0].groundH, 40);
});

test('footprints は成功建物のみ(失敗建物の LOD1 はクリップされない)', () => {
  const org = { lat: 34.65, lon: 135.4, h: 0 };
  const bad = `<bldg:Building gml:id="bad">${surf('Roof', 'bad-r', [[34.65, 135.4, 10], [34.65, 135.4, 10], [34.65, 135.4, 10]])}</bldg:Building>`;
  const m = buildLod2Mesh(new Map([['ok', bld('ok', 5)], ['bad', bad]]), org);
  assert.deepEqual(m.footprints.map((f) => f.id), ['ok']);
  assert.deepEqual(m.failed, ['bad']);
  assert.ok(m.footprints[0].hull.length >= 4);
});

test('convexHull', () => {
  const h = convexHull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]);
  assert.equal(h.length, 4);
});

test('texture audit: appearanceMember は建物の外。target の polygon id との交差で数える', () => {
  const xml = `<core:CityModel><app:appearanceMember><app:Appearance><app:surfaceDataMember><app:ParameterizedTexture><app:imageURI>a.jpg</app:imageURI>` +
    `<app:target uri="#b1-r"><app:TexCoordList/></app:target></app:ParameterizedTexture></app:surfaceDataMember></app:Appearance></app:appearanceMember>` +
    `<core:cityObjectMember>${bld('b1', 1)}</core:cityObjectMember><core:cityObjectMember>${bld('b2', 1)}</core:cityObjectMember></core:CityModel>`;
  const r = auditGml(xml);
  assert.equal(r.lod2Any, 2);
  assert.equal(r.textured, 0, '建物内には無い(旧集計の textured:0 の原因)');
  assert.equal(r.texturedLod2, 1);
});

test('37G HTML の opt-in フックは localhost + ?lod2=1 のときだけ overlay を読む', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  const i = html.indexOf("q.get('lod2') === '1'");
  assert.ok(i > 0);
  const block = html.slice(i - 120, i + 300);
  assert.ok(block.includes('location.hostname'), 'localhost 限定');
  assert.ok(block.includes("s152.src = '/lod2-preview/overlay.js'"));
  assert.equal((html.match(/s152\.src/g) || []).length, 1, 'ただ1箇所');
});

test('overlay: ClippingPolygon が無ければ LOD2 を追加しない(二重描画を許容しない)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/lod2/lod2-overlay.js'), 'utf8');
  assert.match(src, /!Cesium\.ClippingPolygonCollection[\s\S]*?status = 'refused'/);
});

test('preview サーバ: 127.0.0.1 のみ・トラバーサル拒否・overlay.js 解決', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/lod2/lod2-preview-serve.cjs'), 'utf8');
  assert.match(src, /listen\(port, '127\.0\.0\.1'/);
  // require すると listen するため、resolve 相当のロジックのみ静的確認
  assert.match(src, /full\.startsWith\(dir \+ path\.sep\)/);
});

test('build スクリプトは public/ 出力を拒否', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/lod2/lod2-preview-build.mjs'), 'utf8');
  assert.match(src, /refusing to write under public/);
});
