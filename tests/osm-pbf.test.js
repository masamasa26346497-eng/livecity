// tests/osm-pbf.test.js
// P1-6B: OSM PBF ローカル import（tools/import/osm-pbf-city.js）のテスト。
//
// PBF バイナリのデコードは osm-pbf-parser（外部・pure JS）へ委譲しているため、ここでは
// 合成 OSM primitive ストリームを注入し、抽出 / relation 組み立て / 幾何解決 / bbox 除外 /
// 重複防止 / station point / 既存 convert・validator との接続を検証する（依存パッケージ不要）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import {
  importOsmPbfCity, matchWayLayer, expandBbox, resolveGeometry,
  geometryIntersectsBbox, pickTags, ALL_LAYERS,
} from '../tools/import/osm-pbf-city.js';
import { normalizePrimitive, objectStreamToPrimitives, pbfPrimitiveStream } from '../tools/lib/osm-pbf-stream.js';
import { PassThrough } from 'node:stream';
import { buildOsmPbf, hasOsmPbfParser } from './helpers/osm-pbf-fixture.js';
import { createCityTileGrid } from '../tools/lib/city-tile-grid.js';
import { convertLayer, buildOne } from '../tools/build-city-layer-tiles.js';
import { validateCityLayer } from '../tools/lib/city-layer-validator.js';

const AREA = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'areas', 'osaka-city.json'), 'utf-8').replace(/^﻿/, ''));
const TMP_ROOT = path.join(PROJECT_ROOT, 'temp', 'p16b-tests');
mkdirSync(TMP_ROOT, { recursive: true });

// ── 合成 primitive fixture（すべて大阪市 bbox 内 = 34.585..34.77 / 135.342..135.601、東京の1件を除く）──
const N = (id, lat, lon, tags = {}) => ({ type: 'node', id, lat, lon, tags });
const W = (id, refs, tags = {}) => ({ type: 'way', id, refs, tags });
const R = (id, tags, members) => ({ type: 'relation', id, tags, members });

// riverbank relation 用の閉じた外周（3 way に分割）＋ 中州（inner 1 way）。
// 巨大セグメント誤検出を避けるため辺を密に分割する（1 セグメント ≈ 90m）。
let _rid = 1100;
function edgeNodes(from, to, n) {
  const nodes = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    nodes.push(N(++_rid, from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t));
  }
  return nodes;
}
// 外周 A(34.6250,135.5150) B(34.6250,135.5250) C(34.6200,135.5250) D(34.6200,135.5150)
const A = [34.6250, 135.5150], B = [34.6250, 135.5250], C = [34.6200, 135.5250], D = [34.6200, 135.5150];
const wayAB = edgeNodes(A, B, 10);
const wayBC = edgeNodes(B, C, 6);
const wayCDA = [...edgeNodes(C, D, 10), ...edgeNodes(D, A, 6).slice(1)];
// 中州 34.6215..34.6235 / 135.519..135.521
const island = [
  ...edgeNodes([34.6235, 135.5190], [34.6235, 135.5210], 3),
  ...edgeNodes([34.6235, 135.5210], [34.6215, 135.5210], 3).slice(1),
  ...edgeNodes([34.6215, 135.5210], [34.6215, 135.5190], 3).slice(1),
  ...edgeNodes([34.6215, 135.5190], [34.6235, 135.5190], 3).slice(1),
];
const RIVER_NODES = [...wayAB, ...wayBC, ...wayCDA, ...island];
const RIVER_WAYS = [
  W(111, wayAB.map((n) => n.id)),   // 上辺 A→B
  W(112, wayBC.map((n) => n.id)),   // 右辺 B→C
  W(113, wayCDA.map((n) => n.id)),  // 下+左 C→D→A（閉じる）
  W(120, island.map((n) => n.id)),  // inner（それ自体で閉じる）
];
const RIVER_REL = R(5000, { type: 'multipolygon', waterway: 'riverbank', name: 'テスト川' }, [
  { type: 'way', ref: 111, role: 'outer' },
  { type: 'way', ref: 112, role: 'outer' },
  { type: 'way', ref: 113, role: 'outer' },
  { type: 'way', ref: 120, role: 'inner' },
]);

const FIXTURE = [
  // roads
  N(1, 34.6087, 135.492), N(2, 34.6085, 135.514), N(3, 34.6087, 135.536),
  W(10, [1, 2, 3], { highway: 'primary', name: '長居公園通' }),
  // 大阪市外（東京）の道路 → bbox 除外されるべき
  N(901, 35.681, 139.767), N(902, 35.690, 139.700),
  W(11, [901, 902], { highway: 'residential' }),
  // railway line + station node
  N(20, 34.613, 135.503), N(21, 34.614, 135.547),
  W(30, [20, 21], { railway: 'rail' }),
  N(700, 34.6127, 135.532, { railway: 'station', 'name:ja': 'テスト駅' }),
  N(701, 35.170, 136.881, { railway: 'station', name: 'Nagoya' }), // bbox 外の駅
  // park（閉じた way）
  N(40, 34.640, 135.500), N(41, 34.641, 135.503), N(42, 34.639, 135.503), N(43, 34.640, 135.500),
  W(50, [40, 41, 42, 43], { leisure: 'park', name: 'テスト公園' }),
  // ノイズ way（対象外タグ）
  W(60, [1, 2], { highway: 'footway' }),
  ...RIVER_NODES,
  ...RIVER_WAYS,
  RIVER_REL,
];

async function* streamOf(arr) { for (const p of arr) yield p; }
const openStream = (arr = FIXTURE) => () => streamOf(arr);

async function runImport(arr = FIXTURE, layers = ALL_LAYERS) {
  return importOsmPbfCity({ openPrimitiveStream: openStream(arr), area: AREA, layers, bufferMeters: 1000 });
}

test('roads: highway 一致 way が Overpass out geom 互換で抽出される', async () => {
  const { layers } = await runImport();
  const roads = layers.roads;
  const primary = roads.find((e) => e.id === 10);
  assert.ok(primary, 'primary way が抽出されていない');
  assert.equal(primary.type, 'way');
  assert.equal(primary.tags.highway, 'primary');
  assert.equal(primary.geometry.length, 3);
  assert.ok(primary.geometry.every((g) => typeof g.lat === 'number' && typeof g.lon === 'number'));
  assert.ok(!roads.some((e) => e.id === 60), 'footway を拾ってしまっている');
});

test('bbox 除外: 大阪市外の道路 way と駅 node は出力されない', async () => {
  const { layers, stats } = await runImport();
  assert.ok(!layers.roads.some((e) => e.id === 11), '東京の道路が残っている');
  assert.ok(!layers.railways.some((e) => e.type === 'node' && e.id === 701), '名古屋駅が残っている');
  assert.equal(stats.ways.droppedOutside >= 1, true);
  assert.equal(stats.stations.droppedOutside, 1);
});

test('waterways relation: outer 連結 + 中州 holes、build 後に area+hole になる', async () => {
  const { layers } = await runImport();
  const rel = layers.waterways.find((e) => e.type === 'relation' && e.id === 5000);
  assert.ok(rel, 'riverbank relation が抽出されていない');
  assert.equal(rel.members.filter((m) => m.role === 'outer').length, 3);
  assert.equal(rel.members.filter((m) => m.role === 'inner').length, 1);
  assert.ok(rel.members.every((m) => m.geometry.length >= 2), 'member way の geometry が解決されていない');

  // 既存 convert を通す → outer 3本が1リングに連結し、inner が holes になる
  const { features } = convertLayer('waterways', layers.waterways, AREA.projection);
  const areaFeat = features.find((f) => f.kind === 'area');
  assert.ok(areaFeat, 'area feature が生成されていない');
  assert.ok(Array.isArray(areaFeat.holes) && areaFeat.holes.length === 1, '中州が holes に無い');
});

test('parks / railways: 閉じた way・line・station を正しく分離', async () => {
  const { layers } = await runImport();
  assert.ok(layers.parks.some((e) => e.id === 50 && e.tags.leisure === 'park'));
  assert.ok(layers.railways.some((e) => e.type === 'way' && e.id === 30 && e.tags.railway === 'rail'));
  const station = layers.railways.find((e) => e.type === 'node' && e.id === 700);
  assert.ok(station, '駅 node が無い');
  assert.equal(station.tags.railway, 'station');
  assert.equal(station.tags['name:ja'], 'テスト駅');
  assert.equal(typeof station.lat, 'number');
});

test('重複防止: 出力 element の (type,id) は各レイヤー内で一意', async () => {
  const { layers } = await runImport();
  for (const l of ALL_LAYERS) {
    const keys = layers[l].map((e) => `${e.type}/${e.id}`);
    assert.equal(new Set(keys).size, keys.length, `${l} に重複 element`);
  }
});

test('--layer 指定でそのレイヤーだけ抽出（relation pass は waterways のみ）', async () => {
  const { layers } = await runImport(FIXTURE, ['roads']);
  assert.deepEqual(Object.keys(layers), ['roads']);
  assert.ok(layers.roads.length >= 1);
});

test('normalizePrimitive: id が string / refs・latitude の揺れを吸収', () => {
  assert.deepEqual(
    normalizePrimitive({ type: 'way', id: '42', nodes: ['1', '2', '3'], tags: { highway: 'primary' } }),
    { type: 'way', id: 42, refs: [1, 2, 3], tags: { highway: 'primary' } },
  );
  const node = normalizePrimitive({ type: 'node', id: 7, latitude: 34.6, longitude: 135.5, tags: {} });
  assert.equal(node.lat, 34.6);
  assert.equal(node.lon, 135.5);
  // osm-pbf-parser の実際の member は {type, id, role}（ref ではなく id）
  const rel = normalizePrimitive({ type: 'relation', id: 9, members: [{ type: 'way', id: 5, role: 'outer' }], tags: {} });
  assert.deepEqual(rel.members, [{ type: 'way', ref: 5, role: 'outer' }]);
  const rel2 = normalizePrimitive({ type: 'relation', id: 9, members: [{ type: 'way', ref: '7', role: '' }], tags: {} });
  assert.equal(rel2.members[0].ref, 7);
});

test('純粋ヘルパ: matchWayLayer / expandBbox / resolveGeometry / geometryIntersectsBbox', () => {
  assert.equal(matchWayLayer({ highway: 'secondary' }, ALL_LAYERS), 'roads');
  // [Mission23] service / unclassified / *_link / living_street / pedestrian も roads へ取り込む
  assert.equal(matchWayLayer({ highway: 'service' }, ALL_LAYERS), 'roads');
  assert.equal(matchWayLayer({ highway: 'unclassified' }, ALL_LAYERS), 'roads');
  assert.equal(matchWayLayer({ highway: 'motorway_link' }, ALL_LAYERS), 'roads');
  assert.equal(matchWayLayer({ highway: 'footway' }, ALL_LAYERS), null, 'footway は道路対象外');
  assert.equal(matchWayLayer({ waterway: 'river' }, ALL_LAYERS), 'waterways');

  const b = expandBbox({ south: 34.6, north: 34.7, west: 135.4, east: 135.6 }, 1000, 34.65);
  assert.ok(b.south < 34.6 && b.north > 34.7 && b.west < 135.4 && b.east > 135.6);

  const coords = new Map([[1, [135.5, 34.6]], [3, [135.52, 34.61]]]);
  const { geometry, missing } = resolveGeometry([1, 2, 3], coords);
  assert.equal(geometry.length, 2);
  assert.equal(missing, 1);
  assert.deepEqual(geometry[0], { lat: 34.6, lon: 135.5 });

  assert.equal(geometryIntersectsBbox([{ lat: 34.65, lon: 135.5 }], { south: 34.6, north: 34.7, west: 135.4, east: 135.6 }), true);
  assert.equal(geometryIntersectsBbox([{ lat: 35.6, lon: 139.7 }], { south: 34.6, north: 34.7, west: 135.4, east: 135.6 }), false);
});

test('pickTags: convert が使うタグだけ残す', () => {
  assert.deepEqual(
    pickTags({ highway: 'primary', name: 'X', 'name:ja': 'エックス', source: 'survey', foo: 'bar' }),
    { highway: 'primary', name: 'X', 'name:ja': 'エックス' },
  );
});

test('end-to-end: import → build-city-layer-tiles → validateCityLayer が error なし', async () => {
  const { layers } = await runImport();
  const dir = mkdtempSync(path.join(TMP_ROOT, 'run-'));
  const rawDir = path.join(dir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const g = createCityTileGrid({ bbox: AREA.bbox, projection: AREA.projection, tileSizeMeters: 2000 });
  try {
    for (const layer of ALL_LAYERS) {
      const rawPath = path.join(rawDir, `${layer}-osm.json`);
      fs.writeFileSync(rawPath, JSON.stringify({ elements: layers[layer] }));
      await buildOne(layer, rawPath, AREA, g, dir, null);
      const man = JSON.parse(fs.readFileSync(path.join(dir, layer, 'manifest.json'), 'utf-8'));
      assert.equal(man.coordinateConvention, 'znorth-neg-v1');
      const r = validateCityLayer(path.join(dir, layer), { grid: g });
      const errs = r.checks.filter((c) => !c.pass && c.severity === 'error');
      assert.equal(errs.length, 0, `${layer}: ${JSON.stringify(errs)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── P1-6D: objectMode stream → async generator アダプタ（osm-pbf-parser は for await 不可）──

async function collect(gen) {
  const out = [];
  for await (const p of gen) out.push(p);
  return out;
}

test('adapter: チャンクが要素配列でも展開して正規化 primitive を yield する', async () => {
  const pt = new PassThrough({ objectMode: true });
  pt.write([
    { type: 'node', id: '1', lat: 34.6, lon: 135.5, tags: {} },
    { type: 'way', id: '2', nodes: ['1', '3'], tags: { highway: 'primary' } },
  ]);
  pt.write([{ type: 'relation', id: 3, members: [{ type: 'way', ref: '2', role: 'outer' }], tags: {} }]);
  pt.end();
  const got = await collect(objectStreamToPrimitives(pt));
  assert.equal(got.length, 3);
  assert.deepEqual(got[0], { type: 'node', id: 1, lat: 34.6, lon: 135.5, tags: {} });
  assert.deepEqual(got[1].refs, [1, 3]);
  assert.deepEqual(got[2].members, [{ type: 'way', ref: 2, role: 'outer' }]);
});

test('adapter: チャンクが単一 object でも展開する', async () => {
  const pt = new PassThrough({ objectMode: true });
  pt.write({ type: 'node', id: 9, lat: 0, lon: 0, tags: {} });
  pt.end();
  const got = await collect(objectStreamToPrimitives(pt));
  assert.equal(got.length, 1);
  assert.equal(got[0].id, 9);
});

test('adapter: parser stream の error を generator 側へ throw する', async () => {
  const pt = new PassThrough({ objectMode: true });
  const gen = objectStreamToPrimitives(pt);
  queueMicrotask(() => pt.destroy(new Error('parser boom')));
  await assert.rejects(collect(gen), /parser boom/);
});

test('adapter: source stream の error も generator 側へ throw する', async () => {
  const parsed = new PassThrough({ objectMode: true });
  const source = new PassThrough();
  const gen = objectStreamToPrimitives(parsed, source);
  queueMicrotask(() => source.emit('error', new Error('source boom')));
  await assert.rejects(collect(gen), /source boom/);
});

test('adapter: end で generator が正常終了する（空ストリーム）', async () => {
  const pt = new PassThrough({ objectMode: true });
  pt.end();
  assert.deepEqual(await collect(objectStreamToPrimitives(pt)), []);
});

test('adapter: 大量バッチでも backpressure で hang せず全件 yield する', async () => {
  const pt = new PassThrough({ objectMode: true });
  const total = 400;
  for (let i = 0; i < total; i++) pt.write([{ type: 'node', id: i, lat: 34.6, lon: 135.5, tags: {} }]);
  pt.end();
  const got = await collect(objectStreamToPrimitives(pt));
  assert.equal(got.length, total);
  assert.equal(got[total - 1].id, total - 1);
});

test('--help: 入力・依存パッケージなしで usage を表示して exit 0', () => {
  const out = execFileSync('node', ['tools/import/osm-pbf-city.js', '--help'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  assert.match(out, /OSM PBF から大阪市24区/);
  assert.match(out, /--input/);
  assert.match(out, /build-city-layer-tiles/);
});

// ── P1-6D: 実 osm-pbf-parser を通した end-to-end（合成 .osm.pbf。パッケージ未インストール時は skip）──

test('実 parser: 合成 .osm.pbf を pbfPrimitiveStream で読み、import まで通る', { skip: !hasOsmPbfParser() }, async () => {
  // すべて大阪市 bbox 内。riverbank relation は 2 outer way + 1 inner way。
  // 巨大セグメント誤検出（水域 abs 350m）を避けるため外周は密に分割する。
  let nid = 1000;
  const nodesAcc = [];
  const edge = (from, to, n) => {
    const refs = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      nodesAcc.push({ id: ++nid, lat: from[0] + (to[0] - from[0]) * t, lon: from[1] + (to[1] - from[1]) * t });
      refs.push(nid);
    }
    return refs;
  };
  const P = [34.6210, 135.5180], Q = [34.6240, 135.5180], Rr = [34.6240, 135.5230], S = [34.6210, 135.5230];
  const outer1 = edge(P, Q, 2).concat(edge(Q, Rr, 3).slice(1));            // 左辺 + 上辺
  const outer2 = edge(Rr, S, 2).concat(edge(S, P, 3).slice(1));           // 右辺 + 下辺（P で閉じる）
  const inner = edge([34.6222, 135.5198], [34.6228, 135.5198], 1)
    .concat(edge([34.6228, 135.5198], [34.6228, 135.5212], 1).slice(1))
    .concat(edge([34.6228, 135.5212], [34.6222, 135.5212], 1).slice(1))
    .concat(edge([34.6222, 135.5212], [34.6222, 135.5198], 1).slice(1));

  const pbfNodes = [
    { id: 1, lat: 34.6087, lon: 135.492 }, { id: 2, lat: 34.6085, lon: 135.514 }, { id: 3, lat: 34.6087, lon: 135.536 },
    { id: 20, lat: 34.613, lon: 135.503 }, { id: 21, lat: 34.614, lon: 135.547 },
    { id: 40, lat: 34.640, lon: 135.500 }, { id: 41, lat: 34.641, lon: 135.503 }, { id: 42, lat: 34.639, lon: 135.503 }, { id: 43, lat: 34.640, lon: 135.500 },
    { id: 700, lat: 34.6127, lon: 135.532, tags: { railway: 'station', 'name:ja': 'テスト駅' } },
    ...nodesAcc,
  ];
  const pbfWays = [
    { id: 10, refs: [1, 2, 3], tags: { highway: 'primary', name: '長居公園通' } },
    { id: 30, refs: [20, 21], tags: { railway: 'rail' } },
    { id: 50, refs: [40, 41, 42, 43], tags: { leisure: 'park' } },
    { id: 201, refs: outer1 },
    { id: 202, refs: outer2 },
    { id: 210, refs: inner },
  ];
  const pbfRelations = [
    { id: 5000, tags: { type: 'multipolygon', waterway: 'riverbank', name: 'テスト川' }, members: [
      { type: 'way', ref: 201, role: 'outer' }, { type: 'way', ref: 202, role: 'outer' }, { type: 'way', ref: 210, role: 'inner' },
    ] },
  ];

  const dir = mkdtempSync(path.join(TMP_ROOT, 'pbf-'));
  const pbfPath = path.join(dir, 'mini.osm.pbf');
  fs.writeFileSync(pbfPath, buildOsmPbf({ nodes: pbfNodes, ways: pbfWays, relations: pbfRelations }));
  try {
    // 1) 生 primitive がすべて読める（node/way/relation）
    const prims = [];
    for await (const p of pbfPrimitiveStream(pbfPath)) prims.push(p);
    const byType = (t) => prims.filter((p) => p.type === t);
    assert.ok(byType('node').length === pbfNodes.length, `node 数 ${byType('node').length}`);
    assert.equal(byType('way').length, pbfWays.length);
    assert.equal(byType('relation').length, 1);
    const w10 = byType('way').find((w) => w.id === 10);
    assert.deepEqual(w10.refs, [1, 2, 3], 'way refs が delta 復号されていない');
    assert.equal(w10.tags.highway, 'primary');
    const rel = byType('relation')[0];
    assert.equal(rel.members.length, 3);
    assert.equal(rel.members[0].ref, 201);
    assert.equal(rel.members[0].role, 'outer');
    const st = byType('node').find((n) => n.id === 700);
    assert.equal(st.tags.railway, 'station');
    assert.ok(Math.abs(st.lat - 34.6127) < 1e-6 && Math.abs(st.lon - 135.532) < 1e-6);

    // 2) importOsmPbfCity（3-pass）が実 stream で最後まで通る
    const { layers } = await importOsmPbfCity({
      openPrimitiveStream: () => pbfPrimitiveStream(pbfPath), area: AREA, layers: ALL_LAYERS, bufferMeters: 1000,
    });
    assert.ok(layers.roads.some((e) => e.id === 10 && e.geometry.length === 3));
    assert.ok(layers.parks.some((e) => e.id === 50));
    assert.ok(layers.railways.some((e) => e.type === 'way' && e.id === 30));
    assert.ok(layers.railways.some((e) => e.type === 'node' && e.id === 700));
    const wrel = layers.waterways.find((e) => e.type === 'relation' && e.id === 5000);
    assert.ok(wrel && wrel.members.length === 3);
    const { features } = convertLayer('waterways', layers.waterways, AREA.projection);
    assert.ok(features.some((f) => f.kind === 'area'), 'riverbank relation が area に組み立てられない');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
