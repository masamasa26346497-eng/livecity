'use strict';
// Mission 40D: 区間重複 ID の診断ポリシー・タイル数スコープ・段階変換オプションの検証（合成 fixture、元データ非変更）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tool = require('../tools/mission40b-legacy-tiles-batch.cjs');

const sq = (x, z, s = 10) => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];
function bld(id, x, z, h) { return { id, fp: sq(x, z), z0: 0, h, repX: x + 5, repZ: z + 5, usage: null }; }

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm40d-'));
  const wards = [
    { wardId: 'a', id: 'osaka-a', ward: 'A', wardCode: '1', tiles: [{ tx: 0, tz: 0, bs: [bld('bldg_same', 10, 10, 12), bld('bldg_conf', 20, 20, 8), bld('bldg_badh', 30, 30, 0)] }] },
    // 同一形状（頂点順を回転）= identical、同一 ID で形状違い = conflict
    { wardId: 'b', id: 'osaka-b', ward: 'B', wardCode: '2', tiles: [{ tx: 0, tz: 0, bs: [{ ...bld('bldg_same', 10, 10, 12), fp: sq(10, 10).slice(2).concat(sq(10, 10).slice(0, 2)) }, bld('bldg_conf', 25, 25, 8), bld('bldg_ok', 40, 40, 5)] }] },
  ];
  const datasets = [];
  for (const w of wards) {
    const wd = path.join(dir, w.id);
    fs.mkdirSync(wd);
    const tiles = w.tiles.map((t) => {
      fs.writeFileSync(path.join(wd, `tile_${t.tx}_${t.tz}.json`), JSON.stringify({ buildings: t.bs }));
      return { tx: t.tx, tz: t.tz, count: t.bs.length };
    });
    fs.writeFileSync(path.join(wd, 'manifest.json'), JSON.stringify({ wardCode: w.wardCode, tileSize: 500, bounds: { minX: 0, maxX: 500, minZ: 0, maxZ: 500 }, tiles }));
    datasets.push({ id: w.id, wardId: w.wardId, ward: w.ward, wardCode: w.wardCode, buildings: w.tiles[0].bs.length, tiles: 1 });
  }
  // 24 区ディレクトリ以外（fallback / unclassified）は別集計
  for (const n of ['osaka-osm-fallback', 'osaka-unclassified']) {
    fs.mkdirSync(path.join(dir, n));
    fs.writeFileSync(path.join(dir, n, 'tile_0_0.json'), JSON.stringify({ buildings: [] }));
    fs.writeFileSync(path.join(dir, n, 'tile_1_0.json'), JSON.stringify({ buildings: [] }));
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ buildingCount: 6, tileCount: 2, wardCount: 2, datasets }));
  return dir;
}

test('fpHash は頂点の開始位置に依存せず、高さ・形状の違いは区別する', () => {
  assert.strictEqual(tool.fpHash(sq(0, 0), 10), tool.fpHash(sq(0, 0).slice(2).concat(sq(0, 0).slice(0, 2)), 10));
  assert.notStrictEqual(tool.fpHash(sq(0, 0), 10), tool.fpHash(sq(0, 0), 11));
  assert.notStrictEqual(tool.fpHash(sq(0, 0), 10), tool.fpHash(sq(5, 5), 10));
  assert.strictEqual(tool.classifyDup({ hash: 'x' }, { hash: 'x' }), 'identical');
  assert.strictEqual(tool.classifyDup({ hash: 'x' }, { hash: 'y' }), 'conflict');
});

test('validate: identical 重複は無害(notes)、conflict と badHeight は issue。サンプルに ID・値・ファイルが入る。建物は削除されない', () => {
  const dir = makeFixture();
  const before = fs.readFileSync(path.join(dir, 'osaka-b/tile_0_0.json'), 'utf8');
  try {
    tool.setSource(dir);
    const r = tool.validate();
    const a = r.wards.find((w) => w.wardId === 'a');
    const b = r.wards.find((w) => w.wardId === 'b');
    assert.strictEqual(b.dupIdAcrossWards, 2);
    assert.strictEqual(b.dupIdAcrossWardsIdentical, 1);
    assert.strictEqual(b.dupIdAcrossWardsConflict, 1);
    assert.ok(b.issues.some((s) => s.startsWith('dupIdAcrossWardsConflict=1')));
    assert.ok(!b.issues.some((s) => s.startsWith('dupIdAcrossWards=')));
    assert.ok(b.notes && b.notes[0].includes('benign'));
    assert.deepStrictEqual(r.dupPairs['a|b'], { identical: 1, conflict: 1 });
    assert.strictEqual(r.badHeightSamples.length, 1);
    assert.strictEqual(r.badHeightSamples[0].id, 'bldg_badh');
    assert.strictEqual(r.badHeightSamples[0].h, 0);
    assert.ok(r.badHeightSamples[0].file.endsWith('tile_0_0.json'));
    assert.strictEqual(a.badHeight, 1);
    assert.strictEqual(r.totals.buildings, 6);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'osaka-b/tile_0_0.json'), 'utf8'), before);
  } finally { tool.setSource(path.join(__dirname, '../public/map-data/osaka-city/buildings')); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tileScope: 24区ディレクトリと fallback/unclassified を別集計する', () => {
  const dir = makeFixture();
  try {
    tool.setSource(dir);
    const root = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const sc = tool.tileScope(root);
    assert.strictEqual(sc.wardDirTiles, 2);
    assert.strictEqual(sc.otherDirTiles, 4);
    assert.deepStrictEqual(sc.otherDirs, { 'osaka-osm-fallback': 2, 'osaka-unclassified': 2 });
    assert.strictEqual(sc.totalRecursive, 6);
  } finally { tool.setSource(path.join(__dirname, '../public/map-data/osaka-city/buildings')); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI/PS1: --wards / --only-ok が配線され、ps1 は ASCII で元データを削除・コピーしない', () => {
  const js = fs.readFileSync(path.join(__dirname, '../tools/mission40b-legacy-tiles-batch.cjs'), 'utf8');
  assert.ok(js.includes("opt('wards')") && js.includes("has('only-ok')"));
  const ps = fs.readFileSync(path.join(__dirname, '../tools/mission40c-run-local.ps1'));
  assert.ok(ps.every((b) => b < 128), 'ps1 must be ASCII');
  const t = ps.toString();
  assert.ok(t.includes('$OnlyOk') && t.includes('--only-ok') && t.includes('--wards'));
  assert.ok(!/Remove-Item|Copy-Item|robocopy|Move-Item/i.test(t));
  assert.ok(!t.includes('-Recurse -Filter'), 'tile count must not recurse over the whole root');
});
