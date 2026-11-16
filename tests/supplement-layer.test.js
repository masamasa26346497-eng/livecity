// tests/supplement-layer.test.js [Issue #65] 独立レイヤーのライフサイクル/座標/重複/異常系（合成入力。実データ/実ビューアの結果ではない）。
// 注: 未実行（restrict_untrusted_prs により node 実行が拒否される環境で作成）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupplementLayer, prepareTile, heightClass, SCHEMA, DEFAULT_PLACEHOLDER_HEIGHT_M } from '../public/supplement-layer/supplement-layer.js';

const sq = (x, z, w) => [[x, z], [x + w, z], [x + w, z + w], [x, z + w]];
const tileJson = (tx, tz, buildings) => ({ tx, tz, tileSize: 500, layer: 'supplement', count: buildings.length, buildings });
const bld = (id, o = {}) => ({ id, polys: [[sq(10, 10, 5)]], z0: 0, h: 9, heightEstimated: false, heightSource: 'plateau-measured', status: 'candidate', ...o });

function mkEnv({ manifest, tiles = {}, publishable = true, delayMs = 0, failFiles = [] } = {}) {
  const calls = [];
  const m = manifest ?? { schema: SCHEMA, publishable, defaultEnabled: false, tileSize: 500, tiles: Object.keys(tiles).map((k) => { const [tx, tz] = k.split('_').map(Number); return { tx, tz, file: `tile_${k}.json`, count: 1 }; }) };
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    calls.push(url);
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort);
    setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      const file = url.split('/').pop();
      if (failFiles.includes(file)) return resolve({ ok: false, status: 404 });
      if (file === 'manifest.json') return manifest === null ? resolve({ ok: false, status: 404 }) : resolve({ ok: true, json: async () => m });
      const k = file.replace(/^tile_|\.json$/g, '');
      resolve(tiles[k] ? { ok: true, json: async () => tiles[k] } : { ok: false, status: 404 });
    }, delayMs);
  });
  const added = [], removed = [], disposed = [];
  const group = { add: (o) => added.push(o), remove: (o) => removed.push(o) };
  const buildMesh = (prepared, { tx, tz }) => { const object = { name: `t${tx}_${tz}` }; return { object, pickMap: new Map(), dispose: () => disposed.push(object.name) }; };
  return { calls, added, removed, disposed, mk: (extra = {}) => createSupplementLayer({ baseUrl: '/x/', fetchImpl, buildMesh, group, ...extra }) };
}

test('既定OFF: 生成だけでは一切 fetch しない', () => {
  const e = mkEnv({ tiles: { '0_0': tileJson(0, 0, [bld('a')]) } });
  const l = e.mk(); l.update(0, 0, 1000);
  assert.equal(l.state, 'off'); assert.equal(e.calls.length, 0);
});

test('enable 後、半径内のタイルだけ取得し、範囲外は取得しない', async () => {
  const e = mkEnv({ tiles: { '0_0': tileJson(0, 0, [bld('a')]), '5_5': tileJson(5, 5, [bld('b')]) } });
  const l = e.mk(); await l.enable(); assert.equal(l.state, 'ready');
  l.update(250, 250, 100); await l.idle();
  assert.deepEqual(l.loadedKeys(), ['0,0']);
  assert.ok(!e.calls.some((u) => u.includes('tile_5_5')));
});

test('同一タイルの重複リクエストは合流する', async () => {
  const e = mkEnv({ tiles: { '0_0': tileJson(0, 0, [bld('a')]) }, delayMs: 5 });
  const l = e.mk(); await l.enable();
  l.update(250, 250, 100); l.update(250, 250, 100); l.update(260, 250, 100); await l.idle();
  assert.equal(e.calls.filter((u) => u.includes('tile_0_0')).length, 1);
  l.update(250, 250, 100); await l.idle();
  assert.equal(e.calls.filter((u) => u.includes('tile_0_0')).length, 1, '読込済みは再取得しない');
});

test('範囲外へ移動するとヒステリシス後に dispose/remove される', async () => {
  const e = mkEnv({ tiles: { '0_0': tileJson(0, 0, [bld('a')]) } });
  const l = e.mk({ margin: 100 }); await l.enable();
  l.update(250, 250, 100); await l.idle(); assert.equal(l.loadedKeys().length, 1);
  l.update(250, 650, 100); // タイル縁から150m: radius+margin=200 以内 → 保持
  assert.equal(l.loadedKeys().length, 1);
  l.update(250, 1500, 100);
  assert.equal(l.loadedKeys().length, 0); assert.deepEqual(e.disposed, ['t0_0']); assert.equal(e.removed.length, 1);
});

test('取得中の disable は中止され、遅れて届いた応答でメッシュが追加されない', async () => {
  const e = mkEnv({ tiles: { '0_0': tileJson(0, 0, [bld('a')]) }, delayMs: 20 });
  const l = e.mk(); await l.enable(); l.update(250, 250, 100);
  l.disable(); await new Promise((r) => setTimeout(r, 50));
  assert.equal(l.state, 'off'); assert.equal(e.added.length, 0); assert.equal(l.stats.loadedTiles, 0);
});

test('enable 中の disable で古い manifest 応答が状態を ready にしない', async () => {
  const e = mkEnv({ tiles: { '0_0': tileJson(0, 0, [bld('a')]) }, delayMs: 20 });
  const l = e.mk(); const p = l.enable(); l.disable(); await p; await new Promise((r) => setTimeout(r, 40));
  assert.equal(l.state, 'off');
});

test('manifest 不在/不正でも throw せず error 状態。update は何もしない', async () => {
  const e1 = mkEnv({ manifest: null }); const l1 = e1.mk(); await l1.enable(); assert.equal(l1.state, 'error'); l1.update(0, 0, 1e6); assert.equal(e1.added.length, 0);
  const e2 = mkEnv({ manifest: { schema: 'other', tiles: [], tileSize: 500 } }); const l2 = e2.mk(); await l2.enable(); assert.equal(l2.state, 'error');
  const e3 = mkEnv({ manifest: { schema: SCHEMA, tiles: [], tileSize: 0 } }); const l3 = e3.mk(); await l3.enable(); assert.equal(l3.state, 'error');
});

test('publishable:false は allowUnpublishable なしでは読み込まない', async () => {
  const t = { '0_0': tileJson(0, 0, [bld('a')]) };
  const e = mkEnv({ tiles: t, publishable: false }); const l = e.mk(); await l.enable();
  assert.equal(l.state, 'blocked-unpublishable'); l.update(250, 250, 100); assert.equal(e.calls.length, 1, 'manifest のみ');
  const e2 = mkEnv({ tiles: t, publishable: false }); const l2 = e2.mk({ allowUnpublishable: true }); await l2.enable(); assert.equal(l2.state, 'ready');
});

test('タイル404は失敗として記録し、バックオフ中は再要求しない。他タイルは継続', async () => {
  let t = 0;
  const e = mkEnv({ tiles: { '0_0': tileJson(0, 0, [bld('a')]), '1_0': tileJson(1, 0, [bld('b')]) }, failFiles: ['tile_0_0.json'] });
  const l = e.mk({ now: () => t, retryAfterMs: 1000 }); await l.enable();
  l.update(500, 250, 400); await l.idle();
  assert.deepEqual(l.loadedKeys(), ['1,0']); assert.equal(l.stats.failed, 1);
  const n = e.calls.filter((u) => u.includes('tile_0_0')).length;
  l.update(500, 250, 400); await l.idle(); assert.equal(e.calls.filter((u) => u.includes('tile_0_0')).length, n);
  t = 2000; l.update(500, 250, 400); await l.idle(); assert.equal(e.calls.filter((u) => u.includes('tile_0_0')).length, n + 1);
});

test('並列上限を超えず、完了後に残りの近傍タイルを続けて取得', async () => {
  const tiles = {}; for (let i = 0; i < 4; i++) tiles[`${i}_0`] = tileJson(i, 0, [bld(`b${i}`)]);
  const e = mkEnv({ tiles, delayMs: 3 }); const l = e.mk({ maxConcurrent: 2 }); await l.enable();
  l.update(1000, 250, 1200);
  assert.ok(l.stats.inflight <= 2);
  while (l.stats.inflight) await l.idle();
  assert.equal(l.loadedKeys().length, 4);
});

test('manifest の不正な file 名（パス区切り/..）は無視する', async () => {
  const m = { schema: SCHEMA, publishable: true, tileSize: 500, tiles: [{ tx: 0, tz: 0, file: '../secret.json' }, { tx: 1, tz: 0, file: 'a/b.json' }] };
  const e = mkEnv({ manifest: m }); const l = e.mk(); await l.enable(); l.update(250, 250, 5000);
  assert.equal(e.calls.length, 1);
});

test('prepareTile: 診断/不正形状/NaN を除外し数える。内周と複数パートを保持', () => {
  const holed = [[sq(0, 0, 20), sq(5, 5, 5)]];
  const p = prepareTile(tileJson(0, 0, [
    bld('ok', { polys: holed }), bld('multi', { polys: [[sq(0, 0, 5)], [sq(20, 0, 5)]] }),
    { id: 'diag', geometry: null, diagnostic: true }, bld('nan', { polys: [[[[0, 0], [1, NaN], [1, 1]]]] }), bld('few', { polys: [[[[0, 0], [1, 1]]]] }), null,
  ]));
  assert.equal(p.ok, true); assert.equal(p.skipped, 4);
  assert.deepEqual(p.buildings.map((b) => b.id), ['ok', 'multi']);
  assert.equal(p.buildings[0].polys[0].length, 2, '内周保持'); assert.equal(p.buildings[1].polys.length, 2);
  assert.equal(prepareTile({ layer: 'x', buildings: [] }).ok, false);
  assert.equal(prepareTile(null).ok, false);
});

test('高さ区分: 実測/推定/未検証/不明を識別し、不明は仮高さ（実測扱いしない）', () => {
  assert.equal(heightClass({ h: 9, heightEstimated: false, heightSource: 'osm:height' }), 'measured');
  assert.equal(heightClass({ h: 9, heightEstimated: false }), 'unverified', 'source なしは実測にしない');
  assert.equal(heightClass({ h: 9, heightEstimated: null, heightSource: 'source-height-attribute-unverified' }), 'unverified');
  assert.equal(heightClass({ h: 9, heightEstimated: true, heightSource: 'levels*3' }), 'estimated');
  assert.equal(heightClass({ h: null }), 'unknown');
  const p = prepareTile(tileJson(0, 0, [bld('u', { h: null, heightEstimated: null, heightSource: null })]));
  assert.equal(p.buildings[0].height, DEFAULT_PLACEHOLDER_HEIGHT_M); assert.equal(p.buildings[0].heightClass, 'unknown');
});

test('座標は world 座標のまま保持（変換・丸め直しをしない）', () => {
  const p = prepareTile(tileJson(0, 0, [bld('c', { polys: [[[[-1207.67, 153.89], [-1207.26, 149.05], [-1199.3, 149.74]]]] })]));
  assert.deepEqual(p.buildings[0].polys[0][0][0], [-1207.67, 153.89]);
});
