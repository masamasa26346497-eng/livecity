'use strict';
// Mission 37F: 共通の写真選定ロジック（適格性 > 日付の根拠 > 画質）の静的テスト。ネットワーク不要。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const sb = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/mission37f-photo-select.js'), 'utf8'), sb);
const PS = sb.module.exports;
const J = (v) => JSON.parse(JSON.stringify(v)); // vm 由来オブジェクトを同一 realm に直して比較

const ph = (file, extra) => Object.assign({
  thumbnailUrl: 'https://thumb.wikimedia.org/x/' + file, license: 'CC BY-SA 4.0', width: 320, height: 240,
  sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:' + file
}, extra || {});
const entry = (photos, conf) => ({ matchConfidence: conf || 'VERY_HIGH', photos });

test('[37F] yearHint: ファイル名の年だけ拾い、寸法・連番は年と誤読しない', () => {
  assert.deepEqual(J(PS.yearHint('Hanwa_memorial_hospital_2023-12_1.jpg')), { year: 2023, month: 12 });
  assert.deepEqual(J(PS.yearHint('Nanba_CITY_2019,02.jpg')), { year: 2019, month: 2 });
  assert.deepEqual(J(PS.yearHint('HEP-FIVE_in_201409_001.JPG')), { year: 2014, month: 9 });
  assert.equal(PS.yearHint('IMG_12345.jpg'), null);
  assert.equal(PS.yearHint('photo_2020x1080.jpg'), null);
  assert.equal(PS.yearHint('Namba1.jpg'), null);
});

test('[37F] 新しい日付の根拠がある適格写真を先頭にする', () => {
  const r = PS.rankPhotos(entry([ph('A_2010.jpg'), ph('B_2020-09.jpg')]));
  assert.equal(PS.fileName(r.photos[0].photo), 'B_2020-09.jpg');
  assert.equal(r.photos[0].date.basis, 'filename');
});

test('[37F] 日付が不明どうし・同じ日付なら元の順序(36L score 順)を保つ。不明を「最新」とみなさない', () => {
  const r = PS.rankPhotos(entry([ph('first.jpg', { width: 100, height: 100 }), ph('second.jpg', { width: 4000, height: 3000 })]));
  assert.equal(PS.fileName(r.photos[0].photo), 'first.jpg');
  const r2 = PS.rankPhotos(entry([ph('unknown.jpg'), ph('dated_2015.jpg')]));
  assert.equal(PS.fileName(r2.photos[0].photo), 'dated_2015.jpg');
});

test('[37F] 同じ年月なら解像度の高い方', () => {
  const r = PS.rankPhotos(entry([ph('a_2020.jpg', { width: 200, height: 100 }), ph('b_2020.jpg', { width: 400, height: 300 })]));
  assert.equal(PS.fileName(r.photos[0].photo), 'b_2020.jpg');
});

test('[37F] 新しくても不適格な写真は採用しない（移転除外・ライセンスなし・http・低信頼度）', () => {
  const e = entry([ph('new_2024.jpg'), ph('old_2010.jpg')]);
  const r = PS.rankPhotos(e, { exclude: ['new_2024.jpg'] });
  assert.deepEqual(J(r.photos.map((x) => PS.fileName(x.photo))), ['old_2010.jpg']);
  assert.deepEqual(J(r.rejected),[{ file: 'new_2024.jpg', reason: 'relocation-excluded' }]);
  const nolic = PS.rankPhotos(entry([ph('x_2024.jpg', { license: '' })]));
  assert.equal(nolic.photos.length, 0); assert.equal(nolic.reason, 'no-eligible-photo');
  const http = PS.rankPhotos(entry([ph('x_2024.jpg', { thumbnailUrl: 'http://example.com/x.jpg' })]));
  assert.equal(http.photos.length, 0);
  const low = PS.rankPhotos(entry([ph('x_2024.jpg')], 'AMBIGUOUS'));
  assert.equal(low.eligibleEntry, false); assert.equal(low.photos.length, 0);
  assert.equal(PS.rankPhotos(null).reason, 'no-entry');
});

test('[37F] verified の日付は、https の根拠 URL と正しい形式があるときだけ採用', () => {
  const p = ph('v.jpg');
  const ok = PS.dateInfo(p, { 'v.jpg': { verified: true, takenAt: '2024-05-03', evidenceUrl: 'https://commons.wikimedia.org/wiki/File:v.jpg' } });
  assert.equal(ok.basis, 'verified'); assert.equal(ok.year, 2024);
  assert.equal(PS.dateInfo(p, { 'v.jpg': { verified: true, takenAt: '2024-05-03' } }).basis, 'unknown');
  assert.equal(PS.dateInfo(p, { 'v.jpg': { verified: false, takenAt: '2024-05-03', evidenceUrl: 'https://x' } }).basis, 'unknown');
  assert.equal(PS.dateInfo(p, { 'v.jpg': { verified: true, takenAt: 'last week', evidenceUrl: 'https://x' } }).basis, 'unknown');
});

test('[37F] 阪和病院: 2023年の新病棟写真は移転除外の指定で旧 ID の先頭にならない（実データ）', () => {
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/building-photo-index.json'), 'utf8'));
  const e = idx.byCanonicalId['cg_bldg_bldg_ec74351a-f344-4b61-b2e6-04b660b05aa0'];
  const noLock = PS.rankPhotos(e, { okConfidence: idx.policy.clickShows });
  assert.equal(PS.fileName(noLock.photos[0].photo), 'Hanwa_memorial_hospital_2023-12_2.jpg', '除外なしだと日付ロジックは2023年写真を選んでしまう＝除外指定が必須');
  const locked = PS.rankPhotos(e, { okConfidence: idx.policy.clickShows, exclude: ['Hanwa_memorial_hospital_2023-12_2.jpg'] });
  assert.equal(PS.fileName(locked.photos[0].photo), 'Hanwa_hospital-01.jpg');
});

test('[37F] 37D ページは共通モジュールを読み込み、移転除外(RELOCATED)を rankPhotos へ渡す。Google は無効のまま', () => {
  const html = fs.readFileSync(path.join(root, 'public/mission37d-sumiyoshi-mvp.html'), 'utf8');
  assert.match(html, /<script src="mission37f-photo-select\.js"><\/script>/);
  assert.match(html, /LiveCityPhotoSelect\.rankPhotos\(entry, \{/);
  assert.match(html, /exclude: reloc \? reloc\.exclude : \[\]/);
  assert.match(html, /const RELOCATED = /);
  const kit = fs.readFileSync(path.join(root, 'public/mission37e-places-ui-kit.js'), 'utf8');
  assert.match(kit, /ENABLED\s*=\s*false/);
});

test('[37F] 実データ索引の監査: 全候補が https・ライセンス付きで、不適格理由は 0 件', () => {
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/building-photo-index.json'), 'utf8'));
  let eligible = 0, photos = 0;
  for (const e of Object.values(idx.byCanonicalId)) {
    const r = PS.rankPhotos(e, { okConfidence: idx.policy.clickShows });
    if (r.eligibleEntry && r.photos.length) eligible++;
    photos += r.photos.length;
    assert.equal(r.rejected.length, 0);
    // 並べ替えで候補が増減しない
    assert.equal(r.photos.length, (e.photos || []).length);
  }
  assert.equal(eligible, 574); assert.equal(photos, 588);
});
