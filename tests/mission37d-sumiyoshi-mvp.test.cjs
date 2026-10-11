'use strict';
/**
 * Mission 37D — 住吉区 MVP ページの静的ガード（実行未確認。 node --test tests/mission37d-sumiyoshi-mvp.test.cjs）
 *   1. 本番 HTML / 37B / 37C ページに 37D のコードが混ざっていない
 *   2. 配信する施設データが元データと同一件数で、座標が数値
 *   3. 写真索引のキー規則 'cg_' + 建物 id が実データで成立する（ID 体系を変えない）
 *   4. 未接続レイヤーに「何も起きない行」を出していない / 検索 0 件・通信エラーの文言がある
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const page = read('public/mission37d-sumiyoshi-mvp.html');

test('[37D] 本番 HTML / 37B / 37C に 37D の記述が無い', () => {
  for (const f of ['public/osaka_3d_buildings.html', 'public/osaka_3d_buildings.fullward-v3.html',
    'public/mission37b-3dtiles-poc.html', 'public/mission37b-livecity-cesium-tiles.html', 'public/mission37c-livecity-theme.html']) {
    assert.ok(!/mission37d|Mission 37D/.test(read(f)), f);
  }
});

test('[37D] 施設データは元データの複製で、件数と座標が揃っている', () => {
  const a = JSON.parse(read('public/mission37d-data/sumiyoshi-facilities.json'));
  const b = JSON.parse(read('public/map-data/osaka-sumiyoshi/facilities/facilities.json'));
  assert.equal(a.records.length, b.records.length);
  assert.equal(a.recordCount, a.records.length);
  for (const r of a.records) {
    assert.ok(Number.isFinite(r.localX) && Number.isFinite(r.localZ), r.id);
    assert.ok(r.license && r.attribution, 'ライセンス/帰属が無い: ' + r.id);
  }
});

test('[37D] 写真索引のキーは cg_ + 建物 id（実データで 1 件以上、住吉区の建物 tile に存在）', () => {
  const idx = JSON.parse(read('public/map-data/osaka-city/derived/building-photo-index.json'));
  const dir = path.join(ROOT, 'public/map-data/osaka-city/buildings/osaka-sumiyoshi');
  const ids = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    for (const m of fs.readFileSync(path.join(dir, f), 'utf-8').matchAll(/"id"\s*:\s*"(bldg_[0-9a-f-]+)"/g)) ids.add(m[1]);
  }
  const hits = Object.keys(idx.byCanonicalId).filter((k) => k.startsWith('cg_') && ids.has(k.slice(3)));
  assert.ok(hits.length >= 1, '住吉区の建物 id と一致する索引キーが無い');
  assert.ok(idx.policy.clickShows.includes('HIGH'));
});

test('[37D] 未接続レイヤーの行を出さず、空状態・エラーの文言がある', () => {
  assert.ok(!/makeDummyLayer\(id, label, sw, hint\)\)\)/.test(page), 'ダミーレイヤーを登録している');
  assert.match(page, /準備中（未接続）/);
  assert.match(page, /に一致する町丁目・駅・地名・施設はありません/);
  assert.match(page, /建物データ（3D Tiles）を読み込めませんでした/);
  assert.match(page, /写真データなし/);
  assert.match(page, /データなし/);
  assert.match(page, /window\.__mission37d = stats/);
});

test('[37D] 外部リンクは https のみ・DOM は textContent 経由', () => {
  assert.match(page, /\/\^https:\\\/\\\//);
  assert.ok(!/photo[^\n]*innerHTML/.test(page));
});
