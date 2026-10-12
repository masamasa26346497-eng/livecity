'use strict';
// Mission 37F 第2段階: Commons 撮影日の厳密な解釈と photo-dates.json の整合
const test = require('node:test'), assert = require('node:assert');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { parseTakenAt, categoryDateConflict, stripTags, fileNameOf } = require('../tools/mission37f-fetch-photo-dates.cjs');
const sb = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/mission37f-photo-select.js'), 'utf8'), sb);
const PS = sb.module.exports;
const NOW = new Date('2026-10-11T00:00:00Z');

test('ISO の撮影日だけ verified（時刻は落として精度を保持）', () => {
  assert.deepStrictEqual(parseTakenAt('2020-07-19 16:07:57', '2020-07-19T10:52:34Z', NOW), { verified: true, takenAt: '2020-07-19', precision: 'day' });
  assert.strictEqual(parseTakenAt('2013-05', null, NOW).precision, 'month');
  assert.strictEqual(parseTakenAt('<time datetime="x">2019-08-30</time>', null, NOW).takenAt, '2019-08-30');
});
test('非 ISO・範囲・曖昧・異常値は verified にしない', () => {
  for (const raw of ['2010-2012', 'circa 1990', '2020-07-19 / 2020-07-20', '', null])
    assert.strictEqual(parseTakenAt(raw, null, NOW).verified, false, String(raw));
  assert.strictEqual(parseTakenAt('1850-01-01', null, NOW).reason, 'year-out-of-range');
  assert.strictEqual(parseTakenAt('2020-13-01', null, NOW).reason, 'invalid-month');
  assert.strictEqual(parseTakenAt('2021-02-30', null, NOW).reason, 'invalid-day');
  assert.strictEqual(parseTakenAt('2020-07-19 25:00:00', null, NOW).reason, 'invalid-time');
});
test('未来日、およびアップロードより後の撮影日は拒否', () => {
  assert.strictEqual(parseTakenAt('2027-01-01', null, NOW).reason, 'future-date');
  assert.strictEqual(parseTakenAt('2022-05-01', '2020-01-01T00:00:00Z', NOW).reason, 'taken-after-upload');
});
test('アップロード日・ファイル名の年だけでは verified にならない（取得スクリプトの入力は DateTimeOriginal のみ）', () => {
  const src = fs.readFileSync(path.join(root, 'tools/mission37f-fetch-photo-dates.cjs'), 'utf8');
  assert.ok(!/takenAt\s*[:=]\s*[^;]*uploadedAt/.test(src.replace(/uploadedAt: c\.uploadedAt/g, '')));
  assert.ok(/iiextmetadatafilter/.test(src) && /maxlag/.test(src) && /User-Agent/.test(src) && /429/.test(src) && /AbortController/.test(src));
  assert.strictEqual(fileNameOf({ sourcePageUrl: 'http://commons.wikimedia.org/wiki/File:a.jpg' }), null);
  assert.strictEqual(stripTags('<a href="x">A&nbsp;B</a>'), 'A B');
});
test('photo-dates.json: 全 588 ファイル、verified は根拠 URL 付きで型が厳密', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/photo-dates.json'), 'utf8'));
  assert.strictEqual(doc.stats.total, 588);
  assert.strictEqual(doc.stats.verified + doc.stats.unknown, 588);
  const now = Date.now();
  let v = 0;
  for (const [f, r] of Object.entries(doc.dates)) {
    assert.ok(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/.test(r.evidenceUrl), f);
    if (!r.verified) { assert.ok(r.reason, f); assert.ok(!r.takenAt, f); continue; }
    v++;
    assert.ok(/^\d{4}(-\d{2}(-\d{2})?)?$/.test(r.takenAt), f);
    assert.strictEqual(r.field, 'extmetadata.DateTimeOriginal');
    assert.ok(Date.parse(r.takenAt.length === 4 ? r.takenAt + '-01-01' : r.takenAt.length === 7 ? r.takenAt + '-01' : r.takenAt) <= now, f);
  }
  assert.strictEqual(v, doc.stats.verified);
});
test('dateInfo は日付表の verified だけを verified とし、検証済みはファイル名の年より優先される', () => {
  const p = (f) => ({ sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:' + f });
  const dates = { 'Old_2010.jpg': { verified: true, takenAt: '2010-05-01', evidenceUrl: 'https://commons.wikimedia.org/wiki/File:Old_2010.jpg' },
    'Bad.jpg': { verified: false, takenAt: '2024-01-01', evidenceUrl: 'https://commons.wikimedia.org/wiki/File:Bad.jpg' } };
  assert.strictEqual(PS.dateInfo(p('Old_2010.jpg'), dates).basis, 'verified');
  assert.strictEqual(PS.dateInfo(p('Bad.jpg'), dates).basis, 'unknown');
  const entry = { matchConfidence: 'HIGH', photos: [Object.assign(p('Named_2024.jpg'), { thumbnailUrl: 'https://x/y.jpg', license: 'CC0' }), Object.assign(p('Old_2010.jpg'), { thumbnailUrl: 'https://x/z.jpg', license: 'CC0' })] };
  assert.strictEqual(PS.fileName(PS.rankPhotos(entry, { dates }).photos[0].photo), 'Old_2010.jpg');
});
test('阪和病院・阪和記念病院の旧 footprint には 2023 年新病棟写真を付けない（除外が効き、日付があっても先頭にならない）', () => {
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/building-photo-index.json'), 'utf8'));
  const dates = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/photo-dates.json'), 'utf8')).dates;
  const cases = { 'cg_bldg_bldg_ec74351a-f344-4b61-b2e6-04b660b05aa0': 'Hanwa_memorial_hospital_2023-12_2.jpg', 'cg_bldg_bldg_fae25b63-cddc-4545-8004-c41620676308': 'Hanwa_memorial_hospital_2023-12_1.jpg' };
  for (const [id, ex] of Object.entries(cases)) {
    const e = idx.byCanonicalId[id];
    const files = (r) => r.photos.map((x) => PS.fileName(x.photo));
    assert.ok(files(PS.rankPhotos(e, { dates })).includes(ex), '除外なしでは含まれる（除外が必須）');
    assert.ok(!files(PS.rankPhotos(e, { dates, exclude: [ex] })).includes(ex));
  }
});
test('37D ページは photo-dates.json を任意で読み、検証済みの日付だけ表示する', () => {
  const h = fs.readFileSync(path.join(root, 'public/mission37d-sumiyoshi-mvp.html'), 'utf8');
  assert.ok(h.includes('photo-dates.json') && h.includes('idx.__dates') && h.includes("dinfo.basis === 'verified'") && h.includes('data-photo-taken'));
  assert.ok(/ENABLED\s*=\s*false/.test(fs.readFileSync(path.join(root, 'public/mission37e-places-ui-kit.js'), 'utf8')));
});

test('英文の一義的な日付だけ変換して verified、範囲・upload date 注記・自由文・和文・月名の誤りは拒否', () => {
  const ok = (raw, want) => { const r = parseTakenAt(raw, null, NOW); assert.strictEqual(r.verified, true, raw); assert.strictEqual(r.takenAt, want, raw); assert.strictEqual(r.parse, 'english-dmy'); };
  ok('Taken on 26 December 2014', '2014-12-26');
  ok('1 December 2023, 16:48:09', '2023-12-01');
  ok('Taken on 21 March 2009, 09:47 (according to Exif data)', '2009-03-21');
  ok('10 May 2026 13:29:00', '2026-05-10');
  for (const raw of ['15 July 2009 (original upload date)', '30 December 2007 (original upload date)2007.02', '2024年1月19日', 'Unknown date (before 1941)',
    'Photo: Taken on 24 June 2006 Statue: It survived a fire in 1945', '3 Sept 2010', '31 Febuary 2010', '31 February 2010', '5 May 2010 (Mon to Wed)', '1 January 2999'])
    assert.strictEqual(parseTakenAt(raw, null, NOW).verified, false, raw);
  assert.strictEqual(parseTakenAt('26 December 2014', '2014-01-01T00:00:00Z', NOW).reason, 'taken-after-upload');
});
test('古写真スキャン／カテゴリの撮影年と食い違う日付は不採用', () => {
  assert.strictEqual(categoryDateConflict(['Buildings photographed in 1929', 'PD-Japan-oldphoto'], '2025-01-19'), 'historic-scan-category');
  assert.strictEqual(categoryDateConflict(['Japan photographs taken on 2022-01-03'], '2022-01-03'), null);
  assert.strictEqual(categoryDateConflict(['Japan photographs taken on 2019-01-03'], '2022-01-03'), 'category-year-mismatch');
  assert.strictEqual(categoryDateConflict([], '2022-01-03'), null);
});
test('photo-review.json の保留写真は 37D ページで除外され、画像は索引に残る（監査対象）', () => {
  const rev = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/photo-review.json'), 'utf8'));
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/building-photo-index.json'), 'utf8'));
  const dates = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/photo-dates.json'), 'utf8')).dates;
  assert.ok(rev.holds.length >= 1);
  for (const h of rev.holds) {
    assert.ok(/^https:\/\//.test(h.evidenceUrl) && h.reason);
    const e = idx.byCanonicalId['cg_bldg_' + h.canonicalId];
    const files = (r) => r.photos.map((x) => PS.fileName(x.photo));
    assert.ok(files(PS.rankPhotos(e, { dates })).includes(h.file), '索引には残る');
    assert.ok(!files(PS.rankPhotos(e, { dates, exclude: [h.file] })).includes(h.file));
  }
  const umeda = idx.byCanonicalId['cg_bldg_bldg_8e4695fb-0c30-41d2-bd5e-37f2b10c467e'];
  assert.notStrictEqual(PS.fileName(PS.rankPhotos(umeda, { dates, exclude: rev.holds.map((h) => h.file) }).photos[0].photo), 'Hankyu_Osaka-Umeda-STA_Premises.jpg');
  const dob = idx.byCanonicalId['cg_bldg_bldg_30319fab-0161-41f2-8505-dcf6d5740994'];
  assert.strictEqual(PS.fileName(PS.rankPhotos(dob, { dates }).photos[0].photo), 'Dobuike_Hall.jpg');
  const h = fs.readFileSync(path.join(root, 'public/mission37d-sumiyoshi-mvp.html'), 'utf8');
  assert.ok(h.includes('photo-review.json') && h.includes('idx.__holds'));
});
