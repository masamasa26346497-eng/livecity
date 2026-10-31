'use strict';
// Mission 37F-4: 承認済み追加写真 (photo-review.json の adds) の静的テスト。ネットワーク不要。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const sb = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/mission37f-photo-select.js'), 'utf8'), sb);
const PS = sb.module.exports;
const D = path.join(root, 'public/map-data/osaka-city/derived');
const REVIEW = JSON.parse(fs.readFileSync(path.join(D, 'photo-review.json'), 'utf8'));
const INDEX = JSON.parse(fs.readFileSync(path.join(D, 'building-photo-index.json'), 'utf8')).byCanonicalId;
const DATES = JSON.parse(fs.readFileSync(path.join(D, 'photo-dates.json'), 'utf8')).dates;

const ph = (file, extra) => Object.assign({
  thumbnailUrl: 'https://thumb.wikimedia.org/x/' + file, license: 'CC BY-SA 4.0', width: 320, height: 240,
  sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:' + file
}, extra || {});
const entry = (photos, conf) => ({ canonicalId: 'X', matchConfidence: conf || 'VERY_HIGH', photos });
const mkAdd = (over) => Object.assign({ canonicalId: 'X', status: 'approved-manual', takenAt: '2025-03-26', evidenceUrl: 'https://commons.wikimedia.org/wiki/File:New.jpg',
  photo: ph('New.jpg', { imageUrl: 'https://upload.wikimedia.org/x/New.jpg', author: 'A' }) }, over || {});

test('[37F-4] adds: 承認済みの新しい写真が先頭になり、検証済み日付が付く', () => {
  const r = PS.rankPhotos(entry([ph('Old_2010.jpg')]), { adds: [mkAdd()] });
  assert.equal(PS.fileName(r.photos[0].photo), 'New.jpg');
  assert.equal(r.photos[0].date.basis, 'verified');
  assert.equal(r.photos[0].date.takenAt, '2025-03-26');
});

test('[37F-4] adds: 未承認・別建物・https/作者/日付/ライセンス欠落・除外ファイル・低信頼は採用しない', () => {
  const e = entry([ph('Old_2010.jpg')]);
  const bad = [mkAdd({ status: 'candidate' }), mkAdd({ canonicalId: 'Y' }), mkAdd({ takenAt: 'unknown' }), mkAdd({ evidenceUrl: 'http://x' }),
    mkAdd({ photo: ph('New.jpg', { imageUrl: 'http://x', author: 'A' }) }), mkAdd({ photo: ph('New.jpg', { imageUrl: 'https://x/y.jpg' }) }),
    mkAdd({ photo: ph('New.jpg', { imageUrl: 'https://x/y.jpg', author: 'A', license: '' }) })];
  bad.forEach((a) => assert.equal(PS.fileName(PS.rankPhotos(e, { adds: [a] }).photos[0].photo), 'Old_2010.jpg'));
  assert.equal(PS.fileName(PS.rankPhotos(e, { adds: [mkAdd()], exclude: ['New.jpg'] }).photos[0].photo), 'Old_2010.jpg');
  assert.equal(PS.rankPhotos(entry([ph('Old.jpg')], 'LOW'), { adds: [mkAdd()] }).eligibleEntry, false);
});

test('[37F-4] 実データ: adds は索引の canonicalId・Commons 公式 URL・オープンライセンス・検証済み日付・根拠を保持し、現先頭より新しい', () => {
  assert.ok(REVIEW.adds.length >= 1 && REVIEW.adds.length <= 8);
  const exclude = REVIEW.holds.map((h) => h.file);
  for (const a of REVIEW.adds) {
    const e = INDEX[a.canonicalId];
    assert.ok(e, 'index entry: ' + a.canonicalId);
    assert.equal(e.canonicalId, a.canonicalId);
    assert.ok(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/.test(a.photo.sourcePageUrl));
    assert.ok(/^https:\/\/thumb\.wikimedia\.org\//.test(a.photo.thumbnailUrl) && /^https:\/\/upload\.wikimedia\.org\//.test(a.photo.imageUrl));
    assert.match(a.photo.license, /^(CC0|CC BY)/);
    assert.ok(a.photo.author && a.approvedBasis && a.takenAt);
    const before = PS.rankPhotos(e, { dates: DATES, exclude }).photos[0];
    const after = PS.rankPhotos(e, { dates: DATES, exclude, adds: REVIEW.adds }).photos[0];
    assert.equal(PS.fileName(after.photo), PS.fileName(a.photo), 'new photo first: ' + a.canonicalId);
    assert.equal(after.date.basis, 'verified');
    assert.ok(before.date.basis !== 'verified' || before.date.takenAt < a.takenAt);
  }
});

test('[37F-4] adds: 阪和病院・阪和記念病院・holds の写真は追加対象に含まれない', () => {
  assert.ok(!REVIEW.adds.some((a) => /ec74351a|fae25b63/.test(a.canonicalId)));
  const held = REVIEW.holds.map((h) => h.file);
  assert.ok(!REVIEW.adds.some((a) => held.includes(PS.fileName(a.photo))));
});

test('[37F-4] 37D ページは adds を読み込んで rankPhotos に渡し、Google は ENABLED=false のまま', () => {
  const html = fs.readFileSync(path.join(root, 'public/mission37d-sumiyoshi-mvp.html'), 'utf8');
  assert.match(html, /adds: \(idx && idx\.__adds\) \|\| \[\]/);
  assert.match(fs.readFileSync(path.join(root, 'public/mission37e-places-ui-kit.js'), 'utf8'), /ENABLED\s*=\s*false/);
});

// ---- 37F-5: 増分更新 ledger ----
const LEDGER = JSON.parse(fs.readFileSync(path.join(root, 'data/reports/mission37f-candidates/ledger.json'), 'utf8'));

test('[37F-5] ledger: 調査済み建物は再調査日時と候補ごとの自動判定・理由を持ち、索引の canonicalId と一致する', () => {
  const ids = Object.keys(LEDGER.buildings);
  assert.ok(ids.length >= 30);
  for (const cid of ids) {
    const b = LEDGER.buildings[cid];
    assert.ok(INDEX[cid], 'in index: ' + cid);
    assert.ok(!Number.isNaN(Date.parse(b.lastSurveyedAt)));
    for (const c of Object.values(b.candidates)) {
      assert.ok(['auto-adoptable', 'rejected', undefined].includes(c.autoVerdict));
      if (c.decision) assert.ok(['adopted', 'rejected-by-review'].includes(c.decision) && c.decisionBasis && c.decidedAt);
    }
  }
});

test('[37F-5] ledger: adds の各写真は decision=adopted と根拠が記録され、人手不採用の写真は adds に入らない', () => {
  const addedFiles = REVIEW.adds.map((a) => a.photo.title.replace(/^File:/, ''));
  for (const a of REVIEW.adds) {
    const c = LEDGER.buildings[a.canonicalId].candidates[a.photo.title.replace(/^File:/, '')];
    assert.equal(c && c.decision, 'adopted', a.photo.title);
    assert.ok(c.decisionBasis);
  }
  for (const b of Object.values(LEDGER.buildings)) for (const [f, c] of Object.entries(b.candidates)) if (c.decision === 'rejected-by-review') assert.ok(!addedFiles.includes(f), f);
});

test('[37F-5] 松竹座(2021-03-18)・海遊館(2019-02-01)の新写真が先頭になり、holds と阪和の移転ロックは維持される', () => {
  const exclude = REVIEW.holds.map((h) => h.file);
  const want = { 'cg_bldg_bldg_20a34d49-7e67-48bc-a3f4-12e5d8d8c5e1': '2021-03-18', 'cg_bldg_osm_143328734': '2019-02-01' };
  for (const [cid, takenAt] of Object.entries(want)) {
    const r = PS.rankPhotos(INDEX[cid], { dates: DATES, exclude, adds: REVIEW.adds }).photos[0];
    assert.equal(r.date.takenAt, takenAt, cid);
    assert.equal(r.date.basis, 'verified');
  }
  assert.ok(REVIEW.holds.some((h) => /Hankyu_Osaka-Umeda/.test(h.file)) && REVIEW.holds.some((h) => /Tenjimbashi6/.test(h.file)));
  assert.ok(!REVIEW.adds.some((a) => /ec74351a|fae25b63/.test(a.canonicalId)));
});
