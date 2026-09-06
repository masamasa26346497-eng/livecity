// tests/ward-tile-coverage.test.js
// P1-6E: Ward bbox → tile 列挙（tools/lib/ward-tile-coverage.js）。
//   建物レイヤーと都市レイヤーが「選択した区の全域」を同じ footprint で段階ロードするための基盤。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { tilesCoveringBboxXZ, bboxFullyCovered } from '../tools/lib/ward-tile-coverage.js';

test('bbox を覆う tile を過不足なく列挙する', () => {
  const bbox = { minX: -100, maxX: 4100, minZ: -6100, maxZ: -100 }; // ≈ 4.2km × 6km
  const tiles = tilesCoveringBboxXZ(bbox, 2000);
  // x: floor(-100/2000)=-1 .. floor(4100/2000)=2  → 4列
  // z: floor(-6100/2000)=-4 .. floor(-100/2000)=-1 → 4行
  assert.equal(tiles.length, 16);
  assert.equal(bboxFullyCovered(bbox, 2000, tiles), true);
});

test('中心 → 外 の順（progressive load 用）', () => {
  const bbox = { minX: 0, maxX: 6000, minZ: 0, maxZ: 6000 };
  const tiles = tilesCoveringBboxXZ(bbox, 2000);
  const cx = (Math.floor(0 / 2000) + Math.floor(6000 / 2000)) / 2;
  const cz = cx;
  let prev = -1;
  for (const t of tiles) {
    const d = Math.hypot(t.tx - cx, t.tz - cz);
    assert.ok(d >= prev - 1e-9, '中心距離が単調非減少になっていない');
    prev = d;
  }
});

test('cap: 中心に近い順に切り詰める', () => {
  const bbox = { minX: 0, maxX: 8000, minZ: 0, maxZ: 8000 }; // 5×5 = 25 tile
  const all = tilesCoveringBboxXZ(bbox, 2000);
  assert.equal(all.length, 25);
  const capped = tilesCoveringBboxXZ(bbox, 2000, { cap: 9 });
  assert.equal(capped.length, 9);
  assert.deepEqual(capped, all.slice(0, 9));
});

test('bufferMeters: 余白ぶん外側の tile も含む', () => {
  const bbox = { minX: 10, maxX: 1990, minZ: 10, maxZ: 1990 }; // 1 tile ぶん
  assert.equal(tilesCoveringBboxXZ(bbox, 2000).length, 1);
  assert.ok(tilesCoveringBboxXZ(bbox, 2000, { bufferMeters: 300 }).length >= 4);
});

test('不正入力は空配列', () => {
  assert.deepEqual(tilesCoveringBboxXZ(null, 2000), []);
  assert.deepEqual(tilesCoveringBboxXZ({ minX: NaN, maxX: 1, minZ: 0, maxZ: 1 }, 2000), []);
  assert.deepEqual(tilesCoveringBboxXZ({ minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, 0), []);
});

test('実データ: 各区の building 500m tile 集合が bbox から算出したものと概ね一致する', () => {
  const root = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'buildings');
  if (!fs.existsSync(path.join(root, 'manifest.json'))) return; // 生成物が無い環境では skip 相当
  const room = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf-8'));
  const entries = room.datasets || room.entries || [];
  let checked = 0;
  for (const e of entries.slice(0, 4)) {
    const mp = path.join(root, e.id, 'manifest.json');
    if (!fs.existsSync(mp)) continue;
    const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
    const tileSet = new Set((m.tiles || []).map((t) => `${t.tx}_${t.tz}`));
    if (!tileSet.size) continue;
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (const t of m.tiles) { mnx = Math.min(mnx, t.tx); mxx = Math.max(mxx, t.tx); mnz = Math.min(mnz, t.tz); mxz = Math.max(mxz, t.tz); }
    const bbox = { minX: mnx * 500, maxX: (mxx + 1) * 500, minZ: mnz * 500, maxZ: (mxz + 1) * 500 };
    const want = tilesCoveringBboxXZ(bbox, 500);
    const wantSet = new Set(want.map((t) => `${t.tx}_${t.tz}`));
    // 実際に建物がある tile はすべて「bbox を覆う tile 集合」に含まれる
    for (const k of tileSet) assert.ok(wantSet.has(k), `${e.id}: tile ${k} が bbox カバー集合に無い`);
    checked++;
  }
  assert.ok(checked >= 1, '検証対象の区が1つも無かった');
});
