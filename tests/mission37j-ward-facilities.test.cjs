'use strict';
// Mission 37J: 区別の施設データ（OSM/ODbL, 24 区）を 37G ページへ接続する処理の静的検証。ネットワーク不要。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FAC = path.join(ROOT, 'public/map-data/osaka-city/facilities');
const rd = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
const wards = rd(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json')).wards;
const manifest = rd(path.join(FAC, 'ward-manifest.json'));

test('24 区の wardId が施設 manifest と 1:1 で、全ファイルが存在する', () => {
  assert.strictEqual(wards.length, 24);
  assert.deepStrictEqual(wards.map((w) => w.wardId).sort(), manifest.wards.map((w) => w.wardId).sort());
  for (const w of manifest.wards) {
    const j = rd(path.join(FAC, w.url));
    assert.strictEqual(j.records.length, w.recordCount);
    assert.strictEqual(j.wardId, w.wardId);
  }
});

test('区別ファイル: sourceId 一意・局所座標が geoToThree と一致・ODbL 表記あり', () => {
  const CLAT = 34.604208, CLON = 135.525020, MPD = 111320, cos = Math.cos(CLAT * Math.PI / 180);
  const seen = new Set();
  let n = 0;
  for (const w of manifest.wards) {
    for (const r of rd(path.join(FAC, w.url)).records) {
      assert.ok(!seen.has(r.sourceId), 'duplicate ' + r.sourceId);
      seen.add(r.sourceId);
      assert.ok(Math.abs(r.localX - (r.longitude - CLON) * cos * MPD) < 1, r.id);
      assert.ok(Math.abs(r.localZ + (r.latitude - CLAT) * MPD) < 1, r.id);
      assert.strictEqual(r.license, 'ODbL 1.0');
      n++;
    }
  }
  assert.strictEqual(n, manifest.sourceRecordCount);
});

test('37D の住吉施設束 149 件は区別ファイルに全て含まれる（重複除去の前提）', () => {
  const all = new Set();
  for (const w of manifest.wards) for (const r of rd(path.join(FAC, w.url)).records) all.add(r.sourceId);
  const base = rd(path.join(ROOT, 'public/mission37d-data/sumiyoshi-facilities.json')).records;
  assert.ok(base.every((r) => all.has(r.sourceId)));
});

test('37G ページ: 区別ロード・sourceId 重複除去・飲食/宿泊カテゴリ・検索/周辺への接続', () => {
  assert.match(html, /FAC_WARD_BASE = 'map-data\/osaka-city\/facilities\/wards\//);
  assert.match(html, /facSeen\.has\(r\.sourceId\)/);
  assert.match(html, /FAC_CAT\.dining/);
  assert.match(html, /FAC_CAT\.lodging/);
  assert.match(html, /for \(const f of await allFacilities\(\)\)/);
  assert.match(html, /await ensureWardFacilities\(w0\)/);
  assert.match(html, /updateFacilitiesNear/);
});

test('38F 統合: LRU ローダー経由で区別施設を取得し、LRU 外の区は POI から解放する', () => {
  assert.match(html, /<script src="mission38f-facility-fastload\.js"><\/script>/);
  assert.match(html, /maxCachedWards: 3/);
  assert.match(html, /function dropWardFacilities/);
  assert.match(html, /facLoader\.isWardCached\(id\)/);
  assert.doesNotMatch(html, /maps\.googleapis\.com|places\.googleapis\.com/);
});

test('課金ロック・本番 HTML は無変更', () => {
  assert.doesNotMatch(html, /maps\.googleapis\.com|places\.googleapis\.com/);
  const ui = fs.readFileSync(path.join(ROOT, 'public/mission37e-places-ui-kit.js'), 'utf8');
  assert.match(ui, /ENABLED\s*=\s*false/);
  for (const f of ['osaka_3d_buildings.html', 'osaka_3d_buildings.fullward-v3.html']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), /mission37j/i);
  }
});
