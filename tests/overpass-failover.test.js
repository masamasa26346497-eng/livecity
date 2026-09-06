// tests/overpass-failover.test.js
// P1-6: Overpass 複数 endpoint failover クライアント（tools/lib/overpass-failover.js）と
// city-tiles.js の cache/resume/--help のテスト。実ネットワークには一切アクセスしない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { createOverpassClient } from '../tools/lib/overpass-failover.js';
import { downloadLayer, buildTileQuery, tileQueryInfo } from '../tools/download/city-tiles.js';
import { createCityTileGrid } from '../tools/lib/city-tile-grid.js';

const AREA = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'areas', 'osaka-city.json'), 'utf-8').replace(/^﻿/, ''));
const GRID = createCityTileGrid({ bbox: AREA.bbox, projection: AREA.projection, tileSizeMeters: 2000, bufferMeters: 150 });

const A = 'https://a.example/api/interpreter';
const B = 'https://b.example/api/interpreter';
const noSleep = async () => {};
const okJson = (elements = []) => ({ ok: true, status: 200, text: async () => JSON.stringify({ elements }), headers: { get: () => null } });
const errStatus = (status, headers = {}, body = '<html>Overpass error</html>') => ({ ok: false, status, text: async () => body, headers: { get: (k) => headers[k.toLowerCase()] || null } });

function fakeFetch(script) {
  // script: url -> array of responses/throwers（呼ばれるたび先頭を消費。尽きたら最後を繰り返す）
  const calls = [];
  const state = {};
  for (const k of Object.keys(script)) state[k] = script[k].slice();
  const fn = async (url) => {
    calls.push(url);
    const q = state[url] || [okJson()];
    const item = q.length > 1 ? q.shift() : q[0];
    if (typeof item === 'function') return item();
    if (item instanceof Error) throw item;
    return item;
  };
  fn.calls = calls;
  return fn;
}

test('endpoint A が 502 → endpoint B で成功する', async () => {
  const ff = fakeFetch({ [A]: [errStatus(502)], [B]: [okJson([{ type: 'way', id: 1 }])] });
  const events = [];
  const c = createOverpassClient({ endpoints: [A, B], fetchImpl: ff, sleepImpl: noSleep, onEvent: (e) => events.push(e.type) });
  const data = await c.run('q', 't1');
  assert.equal(data.elements.length, 1);
  assert.deepEqual(ff.calls, [A, B]);
  assert.ok(events.includes('failover'));
});

test('endpoint A timeout（AbortError相当）→ endpoint B で成功する', async () => {
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const ff = fakeFetch({ [A]: [abortErr], [B]: [okJson()] });
  const c = createOverpassClient({ endpoints: [A, B], fetchImpl: ff, sleepImpl: noSleep });
  await c.run('q', 't2');
  assert.deepEqual(ff.calls, [A, B]);
  const h = c.healthSnapshot();
  assert.equal(h[A].totalFailures, 1);
  assert.equal(h[B].totalOk, 1);
});

test('429 + Retry-After: endpoint が1つだけなら Retry-After ぶん待ってから再試行', async () => {
  let slept = 0;
  const ff = fakeFetch({ [A]: [errStatus(429, { 'retry-after': '2' }), okJson()] });
  const c = createOverpassClient({ endpoints: [A], fetchImpl: ff, sleepImpl: async (ms) => { slept += ms; }, minRequestIntervalMs: 0, minEndpointIntervalMs: 0, baseBackoffMs: 1 });
  await c.run('q', 't3');
  assert.ok(slept >= 2000, `Retry-After(2s) を尊重していない: slept=${slept}`);
  assert.equal(ff.calls.length, 2);
});

test('全 endpoint 失敗 → maxRounds 後にエラーを投げる', async () => {
  const ff = fakeFetch({ [A]: [errStatus(500)], [B]: [errStatus(503)] });
  const c = createOverpassClient({ endpoints: [A, B], fetchImpl: ff, sleepImpl: noSleep, maxRounds: 2, baseBackoffMs: 1 });
  await assert.rejects(() => c.run('q', 't4'), /全 2 endpoint × 2 周/);
  // A,B を2周 = 4回
  assert.equal(ff.calls.length, 4);
});

test('連続失敗した endpoint は cooldown に入る（連続3回で 60〜180秒休止）', async () => {
  const ff = fakeFetch({ [A]: [errStatus(500)] }); // A は常に 500
  const events = [];
  const c = createOverpassClient({ endpoints: [A], fetchImpl: ff, sleepImpl: noSleep, maxRounds: 4, baseBackoffMs: 1, onEvent: (e) => { if (e.type === 'cooldown') events.push(e); } });
  await assert.rejects(() => c.run('q', 'x1')); // 1 run 内で A が maxRounds 回失敗 → cf=3 で cooldown
  assert.ok(events.length >= 1, 'cooldown イベントが出ていない');
  const ms = events[0].ms;
  assert.ok(ms >= 60000 && ms <= 180000, `cooldown が 60〜180秒でない: ${ms}`);
  assert.ok(c.healthSnapshot()[A].cooldownRemainingMs > 0);
});

test('健全な endpoint が cooldown 中の endpoint より優先される', async () => {
  // 1回目: A,B とも 500 で cf を積む。2回目: A は復活(ok)、B はまだ 500。A が先に選ばれるべき。
  const ff = fakeFetch({ [A]: [errStatus(500), errStatus(500), errStatus(500), okJson([{ type: 'way', id: 7 }])], [B]: [errStatus(500)] });
  const c = createOverpassClient({ endpoints: [A, B], fetchImpl: ff, sleepImpl: noSleep, maxRounds: 2, baseBackoffMs: 1, cooldownFailThreshold: 2 });
  await assert.rejects(() => c.run('q', 'r1')); // 両方失敗
  ff.calls.length = 0;
  const data = await c.run('q', 'r2');
  assert.equal(data.elements[0].id, 7);
  assert.equal(ff.calls[0], A, `cooldown 明けでない健全 endpoint が先に選ばれていない: ${ff.calls}`);
});

test('4xx（クエリ不正）は failover せず即エラー', async () => {
  const ff = fakeFetch({ [A]: [errStatus(400)], [B]: [okJson()] });
  const c = createOverpassClient({ endpoints: [A, B], fetchImpl: ff, sleepImpl: noSleep });
  await assert.rejects(() => c.run('bad', 't5'), /HTTP 400/);
  assert.deepEqual(ff.calls, [A]); // B は試さない
});

// ── city-tiles.js: cache / resume ──
test('downloadLayer: 有効な cache がある tile は client.run を呼ばない（絶対に再取得しない）', async () => {
  const dir = mkdtempSync(path.join(PROJECT_ROOT, 'temp', 'p16ovp-'));
  mkdirSync(dir, { recursive: true });
  try {
    const area = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'areas', 'osaka-city.json'), 'utf-8').replace(/^﻿/, ''));
    const grid = createCityTileGrid({ bbox: area.bbox, projection: area.projection, tileSizeMeters: 2000 });
    const cacheDir = path.join(dir, 'roads');
    mkdirSync(cacheDir, { recursive: true });
    // 1タイルだけ cache 済みにする
    fs.writeFileSync(path.join(cacheDir, 'tile_0_-1.json'), JSON.stringify({ elements: [{ type: 'way', id: 99 }] }));
    let runCalls = 0;
    const client = { run: async () => { runCalls++; return { elements: [] }; }, healthSnapshot: () => ({}), endpoints: [A] };
    const r = await downloadLayer('roads', area, grid, { tiles: ['0_-1'], cacheDir: path.relative(PROJECT_ROOT, dir), merge: false, timeout: 90 }, client);
    assert.equal(runCalls, 0, 'cache 済み tile で client.run が呼ばれた');
    assert.equal(r.cached, 1);
    assert.equal(r.downloaded, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('downloadLayer: resume — 失敗 tile のみ再取得し、成功済み cache は温存', async () => {
  const dir = mkdtempSync(path.join(PROJECT_ROOT, 'temp', 'p16ovp-'));
  mkdirSync(dir, { recursive: true });
  try {
    const area = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'areas', 'osaka-city.json'), 'utf-8').replace(/^﻿/, ''));
    const grid = createCityTileGrid({ bbox: area.bbox, projection: area.projection, tileSizeMeters: 2000 });
    const cacheDir = path.join(dir, 'roads');
    mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'tile_0_-1.json'), JSON.stringify({ elements: [{ type: 'way', id: 1 }] })); // 済
    let runCalls = 0;
    const client = { run: async (q, label) => { runCalls++; assert.equal(label, '1_-1'); return { elements: [{ type: 'way', id: 2 }] }; }, healthSnapshot: () => ({}), endpoints: [A] };
    const r = await downloadLayer('roads', area, grid, { tiles: ['0_-1', '1_-1'], cacheDir: path.relative(PROJECT_ROOT, dir), merge: false, timeout: 90 }, client);
    assert.equal(runCalls, 1, '失敗（未取得）tile だけ取得すべき');
    assert.equal(r.cached, 1);
    assert.equal(r.downloaded, 1);
    assert.ok(fs.existsSync(path.join(cacheDir, 'tile_1_-1.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--help はネットワークアクセスせず usage を出して exit 0', () => {
  const out = execFileSync('node', ['tools/download/city-tiles.js', '--help'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  assert.match(out, /使い方:/);
  assert.match(out, /--endpoint/);
  assert.match(out, /ネットワークアクセスなし/);
});

test('buildTileQuery は複数フィルタと bbox を正しく展開する', () => {
  const q = buildTileQuery('way["highway"~"^primary$"];relation["natural"="water"]', '34.5,135.5,34.6,135.6', 60);
  assert.match(q, /\[timeout:60\]/);
  assert.match(q, /way\["highway"~"\^primary\$"\]\(34\.5,135\.5,34\.6,135\.6\)/);
  assert.match(q, /relation\["natural"="water"\]\(34\.5,135\.5,34\.6,135\.6\)/);
});

// ── bbox / query 検証（directive P1-6 取得失敗調査 #2 #3 #8）──
test('local tile → WGS84 bbox: 順序が south,west,north,east で order OK', () => {
  const info = tileQueryInfo('roads', AREA, GRID, -1, -5, 90);
  assert.equal(info.bboxOrder, 'south,west,north,east');
  assert.equal(info.bboxOrderOk, true);
  assert.ok(info.wgs84Bbox.south < info.wgs84Bbox.north);
  assert.ok(info.wgs84Bbox.west < info.wgs84Bbox.east);
  // str は south,west,north,east の順
  const [s, w, n, e] = info.bboxStr.split(',').map(Number);
  assert.ok(s < n && w < e);
});

test('全156タイルの WGS84 bbox が finite・正順・大阪市周辺・巨大でない', () => {
  const tiles = GRID.allTiles();
  assert.ok(tiles.length >= 140 && tiles.length <= 170, `tile 数が想定外: ${tiles.length}`);
  for (const { tx, tz } of tiles) {
    const b = GRID.latLonBboxForTile(tx, tz);
    for (const v of [b.south, b.west, b.north, b.east]) assert.ok(Number.isFinite(v), `非有限 ${tx}_${tz}`);
    assert.ok(b.south < b.north, `south>=north ${tx}_${tz}`);
    assert.ok(b.west < b.east, `west>=east ${tx}_${tz}`);
    assert.ok(b.south > 34.4 && b.north < 34.95, `緯度が大阪外 ${tx}_${tz}: ${b.south}..${b.north}`);
    assert.ok(b.west > 135.2 && b.east < 135.85, `経度が大阪外 ${tx}_${tz}: ${b.west}..${b.east}`);
    // 1 tile 2000m + buffer 300m → 緯度幅 < 0.03deg、経度幅 < 0.04deg 程度
    assert.ok((b.north - b.south) < 0.05, `bbox 緯度幅が巨大 ${tx}_${tz}`);
    assert.ok((b.east - b.west) < 0.06, `bbox 経度幅が巨大 ${tx}_${tz}`);
  }
});

test('znorth-neg-v1 の local 値をそのまま Overpass bbox へ渡していない（値域が緯度経度）', () => {
  // local bounds は数千m オーダー、WGS84 bbox は 34.x/135.x。混同していれば order/範囲チェックで落ちる。
  const info = tileQueryInfo('roads', AREA, GRID, 3, 5, 90);
  assert.ok(Math.abs(info.localBounds.minX) > 100, 'local はメートル');
  assert.ok(info.wgs84Bbox.south > 30 && info.wgs84Bbox.south < 40, 'WGS84 は緯度');
});

test('roads の query snapshot: 最小フィルタ・out geom・recursive expansion なし', () => {
  const info = tileQueryInfo('roads', AREA, GRID, -1, -5, 90);
  assert.equal(info.recursiveExpansion, false, '(._;>;) 等の無条件 recursive expansion が入っている');
  assert.equal(info.outMode.trim(), 'geom');
  assert.deepEqual(info.filters, ['way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential)$"]']);
  assert.ok(info.queryBytes < 400, `query が想定より大きい: ${info.queryBytes} bytes`);
  assert.match(info.query, /^\[out:json\]\[timeout:90\];\n\(\n {2}way\["highway"/);
});

test('HTTP timeout は QL timeout より長い（AbortController が先に切れない）', () => {
  const c = createOverpassClient({ endpoints: [A], fetchImpl: async () => okJson(), qlTimeoutSec: 90 });
  // fetch イベントで両 timeout を確認
  let evt = null;
  const c2 = createOverpassClient({ endpoints: [A], fetchImpl: async () => okJson(), sleepImpl: noSleep, qlTimeoutSec: 60, onEvent: (e) => { if (e.type === 'fetch') evt = e; } });
  return c2.run('q', 't').then(() => {
    assert.ok(evt && evt.httpTimeoutMs > evt.qlTimeoutSec * 1000, `HTTP timeout(${evt && evt.httpTimeoutMs}) <= QL timeout`);
    assert.equal(evt.httpTimeoutMs, 90000); // 60 + 30
  });
});

test('HTTP 500 の response body（先頭〜1000字）が errorBody イベントで通知される', async () => {
  const body = 'Error: ' + 'runtime error '.repeat(120); // 長い body
  const ff = fakeFetch({ [A]: [errStatus(500, {}, body)], [B]: [okJson()] });
  const seen = [];
  const c = createOverpassClient({ endpoints: [A, B], fetchImpl: ff, sleepImpl: noSleep, errorBodyChars: 1000, onEvent: (e) => { if (e.type === 'errorBody') seen.push(e); } });
  await c.run('q', 't');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 500);
  assert.ok(seen[0].body.length <= 1000 && seen[0].body.startsWith('Error: runtime error'));
  assert.ok(typeof seen[0].httpMs === 'number');
});

test('--smoke: 未取得の先頭1タイルだけ取得する', async () => {
  const dir = mkdtempSync(path.join(PROJECT_ROOT, 'temp', 'p16ovp-'));
  mkdirSync(dir, { recursive: true });
  try {
    let runCalls = 0;
    const client = { run: async () => { runCalls++; return { elements: [] }; }, healthSnapshot: () => ({}), endpoints: [A] };
    const r = await downloadLayer('roads', AREA, GRID, { cacheDir: path.relative(PROJECT_ROOT, dir), merge: false, timeout: 90, smoke: true, abortAfter: 5 }, client);
    assert.equal(runCalls, 1, 'smoke なのに複数タイル取得している');
    assert.equal(r.downloaded, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--abort-after: 連続失敗かつ成功0で全取得を中断する', async () => {
  const dir = mkdtempSync(path.join(PROJECT_ROOT, 'temp', 'p16ovp-'));
  mkdirSync(dir, { recursive: true });
  try {
    let runCalls = 0;
    const client = { run: async () => { runCalls++; throw new Error('HTTP 500'); }, healthSnapshot: () => ({}), endpoints: [A] };
    const r = await downloadLayer('roads', AREA, GRID, { cacheDir: path.relative(PROJECT_ROOT, dir), merge: false, timeout: 90, abortAfter: 3 }, client);
    assert.equal(r.aborted, true);
    assert.equal(runCalls, 3, `abort-after=3 なのに ${runCalls} 回試行した（156回 churn は禁止）`);
    assert.equal(r.status, 'aborted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
