'use strict';
// Mission 40E: 高さ欠損値(sentinel)の表示用 fallback 分離、overlapping レポート、複合キー（合成 fixture、元データ非変更）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tool = require('../tools/mission40b-legacy-tiles-batch.cjs');

const REPO_BLD = path.join(__dirname, '../public/map-data/osaka-city/buildings');
const sq = (x, z, s = 10) => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];
function bld(id, x, z, h) { return { id, fp: sq(x, z), z0: 0, h, repX: x + 5, repZ: z + 5, usage: null }; }

function makeFixture(extraA) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm40e-'));
  const wards = [
    { wardId: 'a', id: 'osaka-a', wardCode: '1', bs: [bld('bldg_conf', 20, 20, 8), bld('bldg_nb', 70, 70, 9)].concat(extraA || []) },
    { wardId: 'b', id: 'osaka-b', wardCode: '2', bs: [bld('bldg_conf', 25, 25, 8), bld('bldg_ok', 40, 40, 5)] },
  ];
  const datasets = [];
  for (const w of wards) {
    const wd = path.join(dir, w.id);
    fs.mkdirSync(wd);
    fs.writeFileSync(path.join(wd, 'tile_0_0.json'), JSON.stringify({ buildings: w.bs }));
    fs.writeFileSync(path.join(wd, 'manifest.json'), JSON.stringify({ wardCode: w.wardCode, tileSize: 500, bounds: { minX: 0, maxX: 500, minZ: 0, maxZ: 500 }, tiles: [{ tx: 0, tz: 0, count: w.bs.length }] }));
    datasets.push({ id: w.id, wardId: w.wardId, ward: w.wardId, wardCode: w.wardCode, buildings: w.bs.length, tiles: 1 });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ buildingCount: 4, tileCount: 2, wardCount: 2, datasets }));
  return dir;
}

test('height policy: sentinel(29997) の建物だけ一時ソースで仮高さ、元ファイル不変、他の異常値は触らない', () => {
  const sent = Object.assign(bld('bldg_sent', 60, 60, 29997), { usage: '461' });
  const dir = makeFixture([sent, bld('bldg_big', 80, 80, 450)]);
  const aFile = path.join(dir, 'osaka-a/tile_0_0.json');
  const before = fs.readFileSync(aFile, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'osaka-a/manifest.json'), 'utf8'));
  let hp;
  try {
    hp = tool.planHeightPolicy(path.join(dir, 'osaka-a'), manifest);
    assert.deepStrictEqual(Object.keys(hp.flagged['0_0']), ['bldg_sent']);
    assert.strictEqual(hp.flagged['0_0'].bldg_sent.raw, 29997);
    assert.strictEqual(hp.flagged['0_0'].bldg_sent.display, tool.DISPLAY_FALLBACK_H);
    const patched = JSON.parse(fs.readFileSync(path.join(hp.tmp, 'tile_0_0.json'), 'utf8')).buildings;
    assert.strictEqual(patched.find((b) => b.id === 'bldg_sent').h, tool.DISPLAY_FALLBACK_H);
    assert.strictEqual(patched.find((b) => b.id === 'bldg_big').h, 450);
    assert.strictEqual(patched.length, 4);
    assert.strictEqual(fs.readFileSync(aFile, 'utf8'), before);
    const mb = JSON.parse(fs.readFileSync(path.join(dir, 'osaka-b/manifest.json'), 'utf8'));
    assert.strictEqual(tool.planHeightPolicy(path.join(dir, 'osaka-b'), mb).tmp, null);
  } finally {
    if (hp && hp.tmp) fs.rmSync(hp.tmp, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnose: overlapping ケースを形状つきで全件出力する（ユーザーPC用の追加レポート）', () => {
  const dir = makeFixture();
  try {
    tool.setSource(dir);
    const r = tool.diagnose({ wardsFile: path.join(dir, 'none.json') });
    assert.strictEqual(r.conflictsByCause['overlapping-version-or-shifted'], 1);
    assert.strictEqual(r.overlappingCases.length, 1);
    const o = r.overlappingCases[0];
    assert.strictEqual(o.id, 'bldg_conf');
    assert.deepStrictEqual(o.offsetXZ, [5, 5]);
    assert.ok(Array.isArray(o.first.fp) && Array.isArray(o.second.fp));
  } finally {
    tool.setSource(REPO_BLD);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('viewer: 区コード+元IDの複合キーと高さ不明表示。canonicalId の経路と課金ロックは不変', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(html.includes("stats.selectedKey = (extraSrc ? extraSrc.source.wardCode : BASE_WARD) + ':' + id"));
  assert.ok(html.includes('stats.selectedCanonicalId = id;'));
  assert.ok(html.includes('heightFallback'));
  assert.ok(html.includes('detail: { canonicalId: id }'));
  assert.ok(!/places\.googleapis|maps\.googleapis/.test(html));
});
