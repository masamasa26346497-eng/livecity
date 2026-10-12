#!/usr/bin/env node
'use strict';
// Mission 37F-4: 人手で被写体を確認・承認した新規写真を photo-review.json の `adds` に取り込む（読み取り専用 Commons API。画像は複製しない）。
//   node tools/mission37f-build-adds.cjs
// 承認リスト(APPROVED)は「人が画像を目視し、説明・カテゴリ・撮影日・建物名が一致」と確認したものだけ。URL・作者・ライセンス・撮影日は API の返値のみ使い、文字列連結で URL を作らない。
const fs = require('node:fs'), path = require('node:path');
const { parseTakenAt, categoryDateConflict, stripTags } = require('./mission37f-fetch-photo-dates.cjs');
const root = path.resolve(__dirname, '..');
const REVIEW = path.join(root, 'public/map-data/osaka-city/derived/photo-review.json');
const UA = 'LiveCityPhotoDateBot/0.1 (https://github.com/masamasa26346497-eng/livecity; read-only adds builder, build-time)';
const OPEN = /^(CC0|CC BY(-SA)?\b|Public domain|PD)/i;

const APPROVED = [
  { canonicalId: 'cg_bldg_bldg_a7f2ebae-8127-4079-99fb-aa3f939f57dd', file: 'ÆON KIREURIWARI SHOPPING CENTER.jpg', category: 'AEON Kireuriwari Shopping Center',
    basis: 'Commons カテゴリが建物名と一致、説明「イオン喜連瓜破ショッピングセンターを撮影」、画像目視で「AEON」ロゴ付き外観を確認。DateTimeOriginal=2024-01-27 とカテゴリ年が一致。現在の先頭 DIAMOND_CITY_Higashisumiyoshi.JPG(1997・別施設名)より新しい。' },
  { canonicalId: 'cg_bldg_osm_161451126', file: 'HEP FIVE on 26th March 2025.jpg', category: 'HEP FIVE',
    basis: 'Commons カテゴリ HEP FIVE、説明「2025年3月26日時点のHEP FIVEを撮影」、画像目視で HEP FIVE/HANKYU 看板と観覧車付きの外観を確認。撮影日とカテゴリ年が一致。' },
  { canonicalId: 'cg_bldg_bldg_3323c394-2a88-4007-9cbf-1a1d7ad34e77', file: 'ABC-MART UMEDA Building.jpg', category: 'ABC-MART Umeda Building',
    basis: 'Commons カテゴリが建物名と一致、説明「ABC-MART梅田ビルを撮影」、画像目視で ABC-MART 看板のある低層部とビル外観を確認。DateTimeOriginal=2020-11-27。' }
];

async function main() {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', maxlag: '5', prop: 'imageinfo|categories', cllimit: 'max',
    iiprop: 'url|size|timestamp|extmetadata', iiurlwidth: '330', iiextmetadatafilter: 'DateTimeOriginal|Artist|LicenseShortName|LicenseUrl|UsageTerms|Attribution',
    titles: APPROVED.map((a) => 'File:' + a.file).join('|') }).toString();
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const pages = (await r.json()).query.pages;
  const adds = [], now = new Date();
  for (const a of APPROVED) {
    const pg = pages.find((p) => p.title === 'File:' + a.file);
    const ii = pg && (pg.imageinfo || [])[0];
    if (!ii) throw new Error('missing: ' + a.file);
    const em = ii.extmetadata || {}, val = (k) => stripTags(em[k] && em[k].value);
    const cats = (pg.categories || []).map((c) => c.title.replace(/^Category:/, ''));
    const pd = parseTakenAt(em.DateTimeOriginal && em.DateTimeOriginal.value, ii.timestamp, now);
    if (!pd.verified) throw new Error('date not verified: ' + a.file + ' ' + pd.reason);
    if (categoryDateConflict(cats, pd.takenAt)) throw new Error('category date conflict: ' + a.file);
    if (!cats.includes(a.category)) throw new Error('category missing: ' + a.file);
    if (!OPEN.test(val('LicenseShortName'))) throw new Error('license not open: ' + a.file);
    for (const k of [ii.thumburl, ii.url, ii.descriptionurl]) if (!/^https:\/\/(upload|thumb)?\.?wikimedia\.org|^https:\/\/commons\.wikimedia\.org/.test(k)) throw new Error('unexpected url: ' + k);
    adds.push({ canonicalId: a.canonicalId, status: 'approved-manual', approvedBasis: a.basis, takenAt: pd.takenAt, evidenceUrl: ii.descriptionurl,
      photo: { thumbnailUrl: ii.thumburl, imageUrl: ii.url, width: ii.thumbwidth, height: ii.thumbheight, source: 'wikimedia-commons', title: pg.title,
        sourcePageUrl: ii.descriptionurl, license: val('LicenseShortName'), licenseUrl: val('LicenseUrl') || null, author: val('Artist'), attribution: val('Attribution') || null, usageTerms: val('UsageTerms') || null } });
    console.log('ok', a.file, pd.takenAt, val('LicenseShortName'), ii.thumburl);
  }
  const doc = JSON.parse(fs.readFileSync(REVIEW, 'utf8'));
  doc.adds = adds;
  doc.schema = 'mission37f-photo-review/2';
  fs.writeFileSync(REVIEW, JSON.stringify(doc, null, 2) + '\n');
}
main().catch((e) => { console.error(e.message); process.exit(1); });
