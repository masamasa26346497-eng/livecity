// Mission 210: PLATEAU tran:Road → layers/roads.json(面)。合成 GML のみ(ネットワーク不要)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTranRoads, buildRoadLayer, simplifyRing, makeWardTester } from '../tools/cloud/tran-to-layers.mjs';

const PROJ = { centerLat: 34.604208, centerLon: 135.52502, metersPerDegree: 111320 };
const sq = (lat, lon, d) => [[lat, lon], [lat, lon + d], [lat + d, lon + d], [lat + d, lon], [lat, lon]].map((p) => p.join(' ') + ' 0').join(' ');
const road = (id, pos, extra = '') => `<core:cityObjectMember><tran:Road gml:id="${id}">${extra}<tran:lod1MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>${pos}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></tran:lod1MultiSurface></tran:Road></core:cityObjectMember>`;
const WARD = [{ outer: [[-5000, -5000], [5000, -5000], [5000, 5000], [-5000, 5000]], holes: [] }];

test('parse: 建物と同じ projection(補正なし)で z は北が負', () => {
  const [r] = parseTranRoads(road('r1', sq(34.604208 + 0.001, 135.52502, 0.0005)), PROJ);
  assert.ok(r.rings[0][0][1] < 0, 'north → negative z');
  assert.ok(Math.abs(r.rings[0][0][0]) < 1e-6);
  assert.ok(Math.abs(r.rings[0][0][1] + 111.32) < 1e-6);
});
test('parse: lat,lon 順でない座標は例外', () => {
  assert.throws(() => parseTranRoads(road('r2', '135.5 34.6 0 135.6 34.6 0 135.6 34.7 0 135.5 34.7 0 135.5 34.6 0'), PROJ), /axis order/);
});
test('build: トンネル除外・区外除外・重複除外・極小除外、空は失敗', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm210-'));
  const tran = path.join(dir, 'tran'); fs.mkdirSync(tran);
  const xml = [
    road('ok1', sq(34.604, 135.525, 0.001)),
    road('ok1', sq(34.604, 135.525, 0.001)),                       // 重複
    road('tun', sq(34.605, 135.525, 0.001), '<uro:sectionType>6</uro:sectionType>'),
    road('far', sq(35.2, 136.5, 0.001)),                             // 区外
    road('tiny', sq(34.604, 135.526, 0.00001)),                      // 極小
  ].join('');
  fs.writeFileSync(path.join(tran, 'a_tran_6697_op.gml'), xml);
  const out = path.join(dir, 'layers');
  const rep = buildRoadLayer({ tranDir: tran, projection: PROJ, ward: 'x', wardCode: '27999', wardPolygons: WARD, outDir: out });
  const j = JSON.parse(fs.readFileSync(path.join(out, 'roads.json'), 'utf8'));
  assert.equal(j.count, 1); assert.equal(j.features[0].kind, 'area'); assert.equal(j.coordinateConvention, 'znorth-neg-v1');
  assert.deepEqual([rep.layers.roads.tunnelSkipped, rep.layers.roads.duplicate, rep.layers.roads.outsideWard, rep.layers.roads.tinySkipped], [1, 1, 1, 1]);
  assert.equal(rep.layers.waterways.status, 'not-delivered');
  assert.ok(fs.existsSync(path.join(out, 'layers-report.json')));
  fs.writeFileSync(path.join(tran, 'a_tran_6697_op.gml'), road('far', sq(35.2, 136.5, 0.001)));
  assert.throws(() => buildRoadLayer({ tranDir: tran, projection: PROJ, ward: 'x', wardCode: '1', wardPolygons: WARD, outDir: path.join(dir, 'l2') }), /0 件/);
});
test('simplify/ward tester', () => {
  assert.equal(simplifyRing([[0, 0], [0.1, 0], [0.2, 0]]), null);
  assert.ok(makeWardTester(WARD)(0, 0)); assert.ok(!makeWardTester(WARD)(9999, 0));
});
test('viewer/build 配線: 道路面レイヤー・面を線で描かない・layersWards', () => {
  const h = fs.readFileSync(new URL('../public/mission37g-osaka-24ward-mvp.html', import.meta.url), 'utf8');
  assert.match(h, /withRoadArea\(/); assert.match(h, /roadArea: '#8d9298'/);
  assert.equal((h.match(/if \(f\.kind === 'area'\) return null;/g) || []).length, 2);
  const b = fs.readFileSync(new URL('../tools/cloud/build-cloud-preview.mjs', import.meta.url), 'utf8');
  assert.match(b, /buildRoadLayer\(/); assert.match(b, /layersWards: SINGLE \? layersWards/);
});
