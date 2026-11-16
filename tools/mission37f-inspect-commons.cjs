#!/usr/bin/env node
'use strict';
// Mission 37F-3: Commons ファイルの説明・カテゴリ・撮影位置を読み取り専用 API で取得し、建物との一致の証拠として表示する。
//   node tools/mission37f-inspect-commons.cjs "File1.jpg" "File2.png" [--out path.json]
// 公開 GET のみ（トークン不要）。少数ファイル向け（1 リクエスト）。
const fs = require('node:fs');
const UA = 'LiveCityPhotoDateBot/0.1 (https://github.com/masamasa26346497-eng/livecity; read-only inspect, build-time)';
const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const out = oi >= 0 ? args.splice(oi, 2)[1] : null;
const strip = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function main() {
  if (!args.length || args.length > 50) throw new Error('1〜50 ファイル名を指定');
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', maxlag: '5',
    prop: 'imageinfo|coordinates|categories', iiprop: 'extmetadata|timestamp|size', cllimit: 'max',
    iiextmetadatafilter: 'ImageDescription|DateTimeOriginal|Artist|LicenseShortName|Categories', titles: args.map((n) => 'File:' + n).join('|') }).toString();
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const res = {};
  for (const pg of j.query.pages) {
    const ii = (pg.imageinfo || [])[0] || {}, em = ii.extmetadata || {};
    res[pg.title.replace(/^File:/, '')] = { missing: !!pg.missing, size: ii.width ? ii.width + 'x' + ii.height : null, uploadedAt: ii.timestamp || null,
      description: strip(em.ImageDescription && em.ImageDescription.value).slice(0, 400),
      dateTimeOriginal: strip(em.DateTimeOriginal && em.DateTimeOriginal.value) || null,
      artist: strip(em.Artist && em.Artist.value).slice(0, 80), license: strip(em.LicenseShortName && em.LicenseShortName.value),
      coordinates: (pg.coordinates || []).map((c) => ({ lat: c.lat, lon: c.lon, primary: !!c.primary })),
      categories: (pg.categories || []).map((c) => c.title.replace(/^Category:/, '')).filter((c) => !/^(Self-published|CC-|Files |Media |Pages |Uploaded|Quality|Valued|Featured|Images)/i.test(c)) };
  }
  const txt = JSON.stringify(res, null, 1);
  if (out) fs.writeFileSync(out, txt + '\n');
  console.log(txt);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
