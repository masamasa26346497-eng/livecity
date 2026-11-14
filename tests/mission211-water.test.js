// Mission 211: GSI WA → layers/waterways.json(面+穴)。合成 MVT のみ(ネットワーク不要)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tilesForBBox, waPolygonsFromTile, makeTileSource, buildWaterLayer } from '../tools/cloud/gsi-water-layers.mjs';
const require = createRequire(import.meta.url);
const M = require('../tools/lib/mission46d-mvt.cjs');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const T = { z: 16, x: 57000, y: 25800 };
const tile = (rings) => M.encodeMvt('WA', 4096, [{ type: 3, props: {}, rings }]);
// 外周(+面積)と穴(逆巻き)
const OUTER = [[1000, 1000], [3000, 1000], [3000, 3000], [1000, 3000], [1000, 1000]];
const HOLE = [[1500, 1500], [1500, 2500], [2500, 2500], [2500, 1500], [1500, 1500]];

test('tilesForBBox: 範囲を覆い、タイル座標が MVT の逆変換と一致', () => {
  const g = M.tilePointToLonLat(16, 57000, 25800, 4096, 2048, 2048), l = M.lonLatToLocal(g.lon, g.lat);
  const ts = tilesForBBox({ minX: l.x - 1, maxX: l.x + 1, minZ: l.z - 1, maxZ: l.z + 1 });
  assert.ok(ts.some((t) => t.x === 57000 && t.y === 25800));
});
test('waPolygonsFromTile: 穴は外周から分離され、座標は補正されない', () => {
  const polys = waPolygonsFromTile(tile([OUTER, HOLE]), T);
  assert.equal(polys.length, 1);
  assert.equal(polys[0].holes.length, 1);
  const g = M.tilePointToLonLat(16, T.x, T.y, 4096, 1000, 1000), l = M.lonLatToLocal(g.lon, g.lat);
  const xs = polys[0].outer.map((p) => p[0]);
  assert.ok(Math.abs(Math.min(...xs) - l.x) < 0.2, '建物と同じ projection');
});
test('buildWaterLayer: 区内のみ出力・穴を保持・失敗タイルは成功扱いにしない', async () => {
  const g = M.tilePointToLonLat(16, T.x, T.y, 4096, 2000, 2000), c = M.lonLatToLocal(g.lon, g.lat);
  const ward = [{ outer: [[c.x - 300, c.z - 300], [c.x + 300, c.z - 300], [c.x + 300, c.z + 300], [c.x - 300, c.z + 300]], holes: [] }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm211-'));
  const buf = tile([OUTER, HOLE]);
  const src = makeTileSource({ fetchTile: async (t) => (t.x === T.x && t.y === T.y ? { status: 200, buf } : { status: 404, buf: Buffer.alloc(0) }), delayMs: 0 });
  const rep = await buildWaterLayer({ source: src, ward: 'w', wardCode: '27999', wardPolygons: ward, outDir: dir });
  assert.equal(rep.status, 'ok');
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'waterways.json'), 'utf8'));
  assert.equal(j.features[0].kind, 'area'); assert.equal(j.features[0].h.length, 1);
  assert.equal(j.coordinateConvention, 'znorth-neg-v1');
  // 区外 → 0 件(ファイル無し・捏造しない)
  const far = [{ outer: [[9e4, 9e4], [9e4 + 10, 9e4], [9e4 + 10, 9e4 + 10]], holes: [] }];
  const none = await buildWaterLayer({ source: makeTileSource({ fetchTile: async () => ({ status: 404, buf: Buffer.alloc(0) }), delayMs: 0 }), ward: 'f', wardCode: 'x', wardPolygons: far, outDir: path.join(dir, 'f') });
  assert.equal(none.status, 'none'); assert.ok(!fs.existsSync(path.join(dir, 'f', 'waterways.json')));
  // 取得失敗 → throw
  const bad = makeTileSource({ fetchTile: async () => { throw new Error('boom'); }, delayMs: 0, retries: 0 });
  await assert.rejects(buildWaterLayer({ source: bad, ward: 'b', wardCode: 'x', wardPolygons: ward, outDir: path.join(dir, 'b') }), /取得に失敗/);
});
test('配線: ビルド・ビューア(穴)・vercel の構文ゲート・PLATEAU に wtr 無し注記', () => {
  const b = rd('tools/cloud/build-cloud-preview.mjs');
  assert.match(b, /buildWaterLayer\(/); assert.match(b, /--no-water/); assert.match(b, /layers\.push\('waterways'\)/);
  assert.ok(!/waterways: 'not-delivered'/.test(b));
  assert.match(rd('public/mission37g-osaka-24ward-mvp.html'), /Array\.isArray\(f\.h\)/);
  const v = JSON.parse(rd('vercel.json'));
  assert.match(v.buildCommand, /^node --test tests\/mission209-37g-html-syntax\.test\.js && node tools\/cloud\/build-cloud-preview\.mjs/);
  assert.equal(JSON.parse(rd('data/reports/mission79/source-lock.json')).zip.gmlByKind.wtr, undefined, 'PLATEAU 2025 大阪市に wtr は無い');
});
