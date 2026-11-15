// tests/supplement-pipeline.test.js [Issue #65] パイプラインのコード検証（合成入力。実データの結果ではない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadExistingTiles, buildSupplement, writeSupplement, SupplementInputError } from '../tools/lib/supplement-pipeline.js';

const sq = (x, z, w) => [[x, z], [x + w, z], [x + w, z + w], [x, z + w]];
function mkExisting(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tiles = [];
  for (let tx = -1; tx <= 1; tx++) for (let tz = -1; tz <= 1; tz++) {
    const file = `tile_${tx}_${tz}.json`; tiles.push({ tx, tz, file, count: 0 });
    const buildings = tx === 0 && tz === 0 ? [{ id: 'bldg_A', fp: sq(10, 10, 20), h: 9 }] : [];
    fs.writeFileSync(path.join(dir, file), JSON.stringify({ tx, tz, buildings }));
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 't', tileSize: 500, totalBuildings: 1, tiles }));
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'supp-'));
const ctx = { source: 'synthetic', sourceVersion: 't', license: 'unknown' };

test('入力欠落は SupplementInputError（fixtureで代替しない）', () => {
  assert.throws(() => loadExistingTiles(path.join(tmp(), 'nope')), (e) => e instanceof SupplementInputError && e.code === 'existing-manifest');
});

test('新規/既存一致/保留/ID重複/カバレッジ外 を分け、既存を変更せず出力', () => {
  const root = tmp(), exDir = path.join(root, 'existing'), out = path.join(root, 'out');
  mkExisting(exDir);
  const before = fs.readFileSync(path.join(exDir, 'tile_0_0.json'), 'utf-8');
  const ex = loadExistingTiles(exDir);
  const cands = [
    { id: 'n1', polys: [[sq(100, 100, 15)]], height: 12 },               // 新規・高さ未検証
    { id: 'm1', polys: [[sq(12, 12, 10)]], height: 5 },                  // 既存Aに包含
    { id: 'n1', polys: [[sq(200, 200, 15)]] },                           // ID重複
    { id: 'far', polys: [[sq(5000, 5000, 15)]] },                        // 既存タイル無し
    { id: 'n2', polys: [[sq(300, 300, 15)]], height: 8, heightEstimated: false, heightSource: 'survey' },
  ];
  const result = buildSupplement({ existing: ex, candidates: cands, ctx });
  const by = Object.fromEntries(result.records.map((r) => [r.sourceId + ':' + r.decisionReason, r]));
  assert.equal(by['n1:no-existing-overlap'].status, 'candidate-hold-license');
  assert.equal(by['n1:no-existing-overlap'].estimated, null);
  assert.deepEqual(by['m1:existing-contained-by-existing'].matchedExistingIds, ['bldg_A']);
  assert.ok(by['n1:duplicate-candidate-id']);
  assert.ok(by['far:no-existing-coverage']);
  assert.equal(by['n2:no-existing-overlap'].estimated, false);
  const m = writeSupplement({ outDir: out, result, meta: { ctx, tileSize: ex.tileSize, existingDir: exDir, existingRef: ex.manifestRef, missingTiles: ex.missingTiles, inputs: {} } });
  assert.equal(m.defaultEnabled, false); assert.equal(m.lazyLoad, true); assert.equal(m.publishable, false);
  assert.equal(m.counts.newBuildings, 2); assert.equal(m.counts.matchedExisting, 1); assert.equal(m.counts.hold, 2);
  assert.equal(fs.readFileSync(path.join(exDir, 'tile_0_0.json'), 'utf-8'), before);
  const t = JSON.parse(fs.readFileSync(path.join(out, 'tile_0_0.json'), 'utf-8'));
  assert.ok(t.buildings.every((b) => b.id.startsWith('supp:synthetic:') && b.fp.length >= 3 && 'heightSource' in b));
});

test('欠落タイルは記録され、隣接候補は保留（比較不能を新規にしない）', () => {
  const root = tmp(), exDir = path.join(root, 'e');
  mkExisting(exDir); fs.rmSync(path.join(exDir, 'tile_1_1.json'));
  const ex = loadExistingTiles(exDir);
  assert.equal(ex.missingTiles.length, 1);
  const r = buildSupplement({ existing: ex, candidates: [{ id: 'x', polys: [[sq(100, 100, 15)]] }], ctx });
  assert.equal(r.records[0].decisionReason, 'no-existing-coverage');
});

test('出力先が既存dirと重なる/非空なら書かない', () => {
  const root = tmp(), exDir = path.join(root, 'e'); mkExisting(exDir);
  const ex = loadExistingTiles(exDir), result = buildSupplement({ existing: ex, candidates: [], ctx });
  const meta = { ctx, tileSize: 500, existingDir: exDir, existingRef: {}, missingTiles: [], inputs: {} };
  assert.throws(() => writeSupplement({ outDir: path.join(exDir, 'sub'), result, meta }), (e) => e.code === 'out-overlaps-existing');
  const full = path.join(root, 'full'); fs.mkdirSync(full); fs.writeFileSync(path.join(full, 'f'), '1');
  assert.throws(() => writeSupplement({ outDir: full, result, meta }), (e) => e.code === 'out-not-empty');
});
