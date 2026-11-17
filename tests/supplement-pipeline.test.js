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

// ---- 2546694 レビュー指摘の回帰テスト（合成入力。実データ結果ではない・未実行） ----
import { loadWorldCandidates } from '../tools/lib/supplement-pipeline.js';
const writeOut = (root, result, ex, exDir, c = ctx) => writeSupplement({ outDir: path.join(root, 'o'), result, meta: { ctx: c, tileSize: ex.tileSize, existingDir: exDir, existingRef: {}, missingTiles: ex.missingTiles, degradedTiles: ex.degradedTiles, existingStats: ex.stats, inputs: {} } });

test('同一ID・異なる形状: 判定した形状Aが出力され、後続Bが上書きしない', () => {
  const root = tmp(), exDir = path.join(root, 'e'); mkExisting(exDir);
  const ex = loadExistingTiles(exDir);
  const A = sq(100, 100, 15), B = sq(300, 300, 20);
  const r = buildSupplement({ existing: ex, candidates: [{ id: 'dup', polys: [[A]] }, { id: 'dup', polys: [[B]] }], ctx });
  const first = r.records.find((x) => x._inputIndex === 0), second = r.records.find((x) => x._inputIndex === 1);
  assert.equal(first.decisionReason, 'no-existing-overlap');
  assert.equal(second.decisionReason, 'duplicate-candidate-id');
  assert.deepEqual(first._cand.polys[0][0], A);
  assert.deepEqual(second._cand.polys[0][0], B);
  const m = writeOut(root, r, ex, exDir);
  const t = JSON.parse(fs.readFileSync(path.join(root, 'o', 'tile_0_0.json'), 'utf-8'));
  assert.deepEqual(t.buildings[0].fp, A);          // Bではない
  assert.equal(m.counts.newBuildings, 1);
});

test('不正形状(空/NaN/3点未満/壊れた構造)は診断レコードで出力され、クラッシュせず正常候補は継続', () => {
  const root = tmp(), exDir = path.join(root, 'e'); mkExisting(exDir);
  const ex = loadExistingTiles(exDir);
  const cands = [
    { id: 'empty', polys: [] }, { id: 'nan', polys: [[[[0, 0], [NaN, 0], [5, 5]]]] }, { id: 'two', polys: [[[[0, 0], [1, 1]]]] },
    { id: 'broken', polys: 'x' }, { id: 'noring' }, { id: 'good', polys: [[sq(100, 100, 15)]] },
    { id: 'empty', polys: [] }, // 不正かつID重複
  ];
  const r = buildSupplement({ existing: ex, candidates: cands, ctx });
  const m = writeOut(root, r, ex, exDir);
  const hold = JSON.parse(fs.readFileSync(path.join(root, 'o', 'hold.json'), 'utf-8'));
  assert.equal(m.counts.newBuildings, 1);
  assert.equal(hold.count, 6);
  assert.ok(hold.buildings.every((h) => h.geometry === null && h.diagnostic === true));
  assert.deepEqual(new Set(hold.buildings.map((h) => h.decisionReason)), new Set(['invalid-geometry', 'duplicate-candidate-id']));
});

test('既存の不正fpは件数/範囲を記録し、そのタイル周辺の候補は保留（新規にしない）', () => {
  const root = tmp(), exDir = path.join(root, 'e'); mkExisting(exDir);
  const tp = path.join(exDir, 'tile_0_0.json');
  const j = JSON.parse(fs.readFileSync(tp, 'utf-8'));
  j.buildings.push({ id: 'bad1', fp: [[0, 0], [1, NaN], [2, 2]] }, { id: 'bad2', fp: null }, { id: 'bad3', fp: [[0, 0], [1, 1]] });
  fs.writeFileSync(tp, JSON.stringify(j));
  const ex = loadExistingTiles(exDir);
  assert.equal(ex.stats.invalidFootprints, 3);
  assert.equal(ex.degradedTiles.length, 1); assert.equal(ex.degradedTiles[0].key, '0,0'); assert.deepEqual(ex.degradedTiles[0].ids, ['bad1', 'bad2', 'bad3']);
  assert.ok(!ex.coveredTiles.has('0,0'));
  assert.equal(ex.items.length, 1); // 正常な bldg_A は比較対象に残る
  const r = buildSupplement({ existing: ex, candidates: [{ id: 'x', polys: [[sq(100, 100, 15)]] }], ctx });
  assert.equal(r.records[0].decisionReason, 'no-existing-coverage');
  const m = writeOut(root, r, ex, exDir);
  assert.equal(m.existingDegradedTiles.length, 1); assert.equal(m.existingStats.invalidFootprints, 3);
});

test('tile原点規則: floor(bbox中心/tileSize) が manifest の tx,tz と合わない棟を originMismatch に数える', () => {
  const root = tmp(), exDir = path.join(root, 'e'); mkExisting(exDir);
  const tp = path.join(exDir, 'tile_0_0.json'), j = JSON.parse(fs.readFileSync(tp, 'utf-8'));
  j.buildings.push({ id: 'off', fp: sq(700, 10, 10), h: 3 }); fs.writeFileSync(tp, JSON.stringify(j));
  assert.equal(loadExistingTiles(exDir).stats.originMismatch, 1);
});

test('実V3/V4 recovered-index の生成コード schema をアダプタが読み、canonicalId/ring/levels/由来を保持', () => {
  // build-osm-fallback-v3.js:221 / build-final-buildings-v4.js:233 のキー構成を写した合成 fixture（実データではない）。
  const index = { version: 1, generatedAt: '2000-01-01T00:00:00Z', missionId: '35D', generationVersion: 'v4', count: 2, note: 'synthetic',
    buildings: [
      { canonicalId: 'osm-fallback:way/1', wardId: 'sumiyoshi', areaM2: 225, name: null, levels: '5', cls: 'NEW', ring: sq(100, 100, 15) },
      { canonicalId: 'osm-fallback:way/2', wardId: 'sumiyoshi', areaM2: 225, name: 'N', levels: null, cls: 'NEW', ring: sq(300, 300, 15) },
    ] };
  const root = tmp(), f = path.join(root, 'recovered-index.json'); fs.writeFileSync(f, JSON.stringify(index));
  const w = loadWorldCandidates(f);
  assert.equal(w.format, 'recovered-index'); assert.equal(w.declaredCount, 2); assert.equal(w.countMismatch, false);
  assert.equal(w.candidates[0].id, 'osm-fallback:way/1'); assert.equal(w.candidates[0].levels, 5);
  assert.equal(w.candidates[0].legacy.missionId, '35D');
  const exDir = path.join(root, 'e'); mkExisting(exDir);
  const ex = loadExistingTiles(exDir), r = buildSupplement({ existing: ex, candidates: w.candidates, ctx });
  writeOut(root, r, ex, exDir);
  const t = JSON.parse(fs.readFileSync(path.join(root, 'o', 'tile_0_0.json'), 'utf-8')).buildings.find((b) => b.sourceId === 'osm-fallback:way/1');
  assert.equal(t.legacy.canonicalId, 'osm-fallback:way/1'); assert.equal(t.heightEstimated, true); assert.equal(t.h, 15); // 5階*3m・推定
  // count 不一致・要素欠落でも throw せず保留に回る
  fs.writeFileSync(f, JSON.stringify({ ...index, count: 9, buildings: [null, { canonicalId: 'z' }] }));
  const w2 = loadWorldCandidates(f); assert.equal(w2.countMismatch, true);
  const r2 = buildSupplement({ existing: ex, candidates: w2.candidates, ctx });
  assert.ok(r2.records.every((x) => x.decisionReason === 'invalid-geometry'));
});

test('publishable: license文字列だけでは true にならない。確認済み+帰属が揃って初めて true', () => {
  const root = tmp(), exDir = path.join(root, 'e'); mkExisting(exDir);
  const ex = loadExistingTiles(exDir);
  const run = (c, tag) => { const r = buildSupplement({ existing: ex, candidates: [{ id: 'n', polys: [[sq(100, 100, 15)]] }], ctx: c }); return [r, writeSupplement({ outDir: path.join(root, tag), result: r, meta: { ctx: c, tileSize: 500, existingDir: exDir, existingRef: {}, missingTiles: [], inputs: {} } })]; };
  const [r1, m1] = run({ ...ctx, license: 'ODbL-1.0' }, 'a');
  assert.equal(m1.publishable, false); assert.equal(r1.records[0].status, 'candidate-hold-license');
  assert.equal(run({ ...ctx, license: 'ODbL-1.0', licenseVerified: true }, 'b')[1].publishable, false); // 帰属なし
  assert.equal(run({ ...ctx, license: 'unknown', licenseVerified: true, attribution: 'x' }, 'c')[1].publishable, false);
  const [r4, m4] = run({ ...ctx, license: 'ODbL-1.0', licenseVerified: true, attribution: '© OpenStreetMap contributors' }, 'd');
  assert.equal(m4.publishable, true); assert.equal(r4.records[0].status, 'candidate');
});
