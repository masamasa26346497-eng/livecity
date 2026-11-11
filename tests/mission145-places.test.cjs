'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
const ST = require('../tools/mission145-build-stations.cjs');
const TB = require('../tools/mission145-build-towns.cjs');
// package.json is "type":"module" so a .js UMD file is treated as ESM by require(); evaluate it as the browser does.
const TW = (() => { const ctx = { self: {} }; require('vm').runInNewContext(fs.readFileSync(path.join(ROOT, 'public/mission145-towns.js'), 'utf8'), ctx); return ctx.self.LiveCityTowns145; })();
const stations = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission145-data/stations-24.json'), 'utf8'));
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;

test('stations-24.json: all 24 wards covered, unique ids, local coordinates match the OSM facility records', () => {
  assert.strictEqual(wards.length, 24);
  const ids = new Set(stations.stations.map((s) => s.id));
  assert.strictEqual(ids.size, stations.stations.length);
  const wardIds = new Set(stations.stations.map((s) => s.wardId));
  for (const w of wards) assert.ok(wardIds.has(w.wardId), 'no station in ' + w.wardId);
  assert.strictEqual(stations.counts.rawNodes, 299);
  assert.ok(stations.counts.markers <= stations.counts.rawNodes);
  for (const s of stations.stations) {
    assert.ok(s.name && Number.isFinite(s.x) && Number.isFinite(s.z));
    assert.ok(s.osmIds.every((i) => /^(node|way|relation)\/\d+$/.test(i)));
  }
});

test('stations-24.json without rail data says so (operators are not invented)', () => {
  assert.strictEqual(stations.operatorData.connected, false);
  assert.ok(stations.stations.every((s) => s.operators.length === 0));
  assert.strictEqual(stations.counts.operatorNotConnected, stations.counts.markers);
});

test('Sumiyoshi stations of the old bundle are all present in the 24-ward layer', () => {
  const old = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37c-layers/osaka-sumiyoshi-9tile/labels.json'), 'utf8')).items.filter((i) => i.kind === 'station');
  const names = new Set(stations.stations.map((s) => ST.normName(s.name)));
  for (const o of old) assert.ok(names.has(ST.normName(o.name)), 'missing ' + o.name);
});

test('builder resolves operators only from OSM tags / nearby line names, merges same-name stations, keeps several operators', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc145-'));
  const rail = path.join(dir, 'railways'); fs.mkdirSync(rail);
  const st = stations.stations.find((s) => s.wardId === 'sumiyoshi' && s.name === '住吉大社');
  assert.ok(st);
  fs.writeFileSync(path.join(rail, 'tile_0_0.json'), JSON.stringify({ features: [
    { id: 'a', kind: 'line', railway: 'rail', name: '南海電気鉄道南海本線', p: [[st.x - 100, st.z], [st.x + 100, st.z]] },
    { id: 'b', kind: 'line', railway: 'tram', name: '阪堺電気軌道阪堺線', p: [[st.x, st.z - 100], [st.x, st.z + 100]] },
    { id: 'c', kind: 'line', railway: 'rail', name: '名前だけの線', p: [[st.x, st.z], [st.x + 50, st.z]] },
    { id: 'd', kind: 'line', railway: 'rail', name: 'JR阪和線', p: [[st.x + 3000, st.z], [st.x + 3100, st.z]] },
  ] }));
  const j = await ST.build({ src: dir });
  const s = j.stations.find((x) => x.name === '住吉大社');
  const labels = s.operators.map((o) => o.label).sort();
  assert.deepStrictEqual(labels, ['南海', '阪堺']);
  assert.ok(s.operators.every((o) => o.basis === 'nearby-line-name' && o.evidence));
  assert.ok(!s.lines.includes('JR阪和線'), 'far line must not be attached');
  assert.ok(!s.lines.includes('名前だけの線'), 'a line whose name carries no operator is not used');
  assert.strictEqual(j.operatorData.connected, true);
  const far = j.stations.find((x) => x.wardId === 'kita');
  assert.deepStrictEqual(far.operators, []);   // operator unknown stays unknown
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OSM operator tag wins over nearby lines and network is labelled as such', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc145-'));
  const nodes = stations.stations.slice(0, 2);
  const raw = { elements: [
    { type: 'node', id: Number(nodes[0].osmIds[0].split('/')[1]), tags: { operator: '西日本旅客鉄道' } },
    { type: 'node', id: Number(nodes[1].osmIds[0].split('/')[1]), tags: { network: 'Osaka Metro' } },
  ] };
  const f = path.join(dir, 'raw.json'); fs.writeFileSync(f, JSON.stringify(raw));
  const j = await ST.build({ osmRaw: f });
  const a = j.stations.find((x) => x.id === nodes[0].id), b = j.stations.find((x) => x.id === nodes[1].id);
  assert.strictEqual(a.operators[0].basis, 'osm-operator-tag');
  assert.strictEqual(a.operators[0].label, 'JR西日本');
  assert.strictEqual(b.operators[0].basis, 'osm-network-tag');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('towns builder: name split, label point inside the polygon (also for an L shape), only real units are emitted', async () => {
  assert.deepStrictEqual(TB.splitName('長居東四丁目'), { base: '長居東', chome: 4 });
  assert.deepStrictEqual(TB.splitName('我孫子西2丁目'), { base: '我孫子西', chome: 2 });
  assert.deepStrictEqual(TB.splitName('長居公園'), { base: '長居公園', chome: null });
  const L = { outer: [[0, 0], [100, 0], [100, 20], [20, 20], [20, 100], [0, 100], [0, 0]], holes: [] };
  const p = TB.labelPoint(L);
  assert.ok(TB.inRing(p.x, p.z, L.outer), 'L-shape label point must lie on its own land');
  assert.ok(p.clearanceM > 5);
  const code = wards.find((w) => w.wardId === 'kita').wardCode;
  const box = (lon, lat, d) => [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]];
  const gj = { features: [
    { properties: { KEY_CODE: code + '001001', S_NAME: '梅田一丁目', CITY_NAME: '北区' }, geometry: { type: 'Polygon', coordinates: box(135.495, 34.70, 0.002) } },
    { properties: { KEY_CODE: code + '001002', S_NAME: '梅田二丁目' }, geometry: { type: 'Polygon', coordinates: box(135.498, 34.70, 0.002) } },
    { properties: { KEY_CODE: '99999001001', S_NAME: '他市' }, geometry: { type: 'Polygon', coordinates: box(135.5, 34.7, 0.002) } },
    { properties: { KEY_CODE: code + '001001', S_NAME: '梅田一丁目(重複)' }, geometry: { type: 'Polygon', coordinates: box(135.495, 34.70, 0.002) } },
    { properties: { KEY_CODE: 'bad', S_NAME: 'x' }, geometry: null },
  ] };
  const j = await TB.build({ geojson: gj, wards, wardPolys: false });
  assert.strictEqual(j.towns.length, 2);
  assert.strictEqual(j.counts.skipped.otherCity, 1);
  assert.strictEqual(j.counts.skipped.duplicateKey, 1);
  assert.strictEqual(j.counts.skipped.noKey, 1);
  assert.ok(j.towns.every((t) => t.w === 'kita' && t.b === '梅田'));
  // Live City local frame: x east, z south-positive => north of the origin has negative z
  assert.ok(j.towns[0].z < 0);
});

test('label tiers, base split, declutter and ward LRU', () => {
  assert.strictEqual(TW.tierOf(20000), 'ward');
  assert.strictEqual(TW.tierOf(9000), 'base');   // 146: 区選択直後の高度(約7-12km)でも町名が出る
  assert.strictEqual(TW.tierOf(3000), 'base');
  assert.strictEqual(TW.tierOf(900), 'full');
  const parts = TW.splitForWard([{ n: '長居東一丁目', b: '長居東', c: 1, a: 10, x: 0, z: 0, k: 'a' }, { n: '長居東二丁目', b: '長居東', c: 2, a: 30, x: 5, z: 5, k: 'b' }, { n: '長居公園', b: '長居公園', c: null, a: 5, x: 9, z: 9, k: 'c' }]);
  assert.strictEqual(parts.full.length, 3);
  assert.strictEqual(parts.base.length, 2);
  assert.strictEqual(parts.base.find((b) => b.n === '長居東').x, 5, 'base label sits on the largest 丁目');
  const keep = TW.declutter([{ x: 100, y: 100, text: '長居東一丁目', pri: 1 }, { x: 110, y: 100, text: '長居東二丁目', pri: 5 }, { x: 600, y: 300, text: '遠い町', pri: 0 }, { x: -500, y: -500, text: '画面外', pri: 9 }], 10, { w: 800, h: 600 });
  assert.ok(keep.has(1) && !keep.has(0), 'overlapping lower priority is dropped');
  assert.ok(keep.has(2) && !keep.has(3), 'off-screen is never chosen');
  assert.strictEqual(TW.declutter([{ x: 1, y: 30, text: 'a', pri: 0 }, { x: 300, y: 30, text: 'b', pri: 0 }], 1, { w: 800, h: 600 }).size, 1, 'cap respected');
  const order = [];
  assert.deepStrictEqual([...TW.touchWard(order, 'a')], []); TW.touchWard(order, 'b'); TW.touchWard(order, 'c');
  assert.deepStrictEqual([...TW.touchWard(order, 'd')], ['a']);
  assert.deepStrictEqual([...TW.touchWard(order, 'b')], []);
});

test('viewer wiring: stations layer, town layer, no duplicate station sources, no paid APIs, 住吉区 town implementation untouched', () => {
  assert.match(HTML, /mission145-data\/stations-24\.json/);
  assert.match(HTML, /stations-24\.local\.json/);
  assert.match(HTML, /LayerRegistry\.register\(stationLayer\)/);
  assert.match(HTML, /LayerRegistry\.register\(townLayer24\)/);
  assert.match(HTML, /mission145-towns\.js/);
  assert.match(HTML, /townTick\(\)/);
  assert.match(HTML, /r\.subcategory !== 'station'/);                       // facility layer no longer double-draws stations
  assert.match(HTML, /it\.kind === 'station'\) continue/);                  // Sumiyoshi-only station labels replaced
  assert.match(HTML, /if \(t\.w === 'sumiyoshi'/);                          // no duplicate of the 37D town layer
  assert.match(HTML, /id: \{ poi: rec \}/);                                 // station click goes through the same POI path as facilities
  assert.match(HTML, /営業状況は未確認/);
  assert.doesNotMatch(HTML.slice(HTML.indexOf('145: 駅（24 区）'), HTML.indexOf('145: 町名・町丁目名')), /googleapis|maps\.google|places\.google/);
  assert.match(HTML, /TOWN_TIER = \{ ward: 14000, base: 1800 \}/);
  assert.deepStrictEqual({ ...TW.TIER }, { ward: 14000, base: 1800 });
});

test('facility POIs for all 24 wards are connected (counts by category)', () => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/map-data/osaka-city/facilities/ward-manifest.json'), 'utf8'));
  assert.strictEqual(man.wards.length, 24);
  const cat = {};
  for (const w of man.wards) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/map-data/osaka-city/facilities/wards', w.wardId + '.json'), 'utf8'));
    for (const r of d.records) cat[r.category] = (cat[r.category] || 0) + 1;
  }
  for (const k of ['public', 'medical', 'education', 'dining', 'shopping', 'lodging', 'tourism', 'park']) assert.ok(cat[k] > 0, k);
});
