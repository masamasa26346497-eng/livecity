#!/usr/bin/env node
'use strict';
// Mission 37F-5: 人手の被写体確認用に、Commons の 640px サムネイルを gitignore 済みのキャッシュへ一時保存する（commit しない・配信しない）。
//   node tools/mission37f-preview-images.cjs <listfile.json: ["File.jpg", ...]>
// 取得先は Commons API が返す thumburl のみ。低頻度(1.5s 間隔)の公開 GET。
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'data/cache/mission37f-commons/preview');
const UA = 'LiveCityPhotoDateBot/0.1 (https://github.com/masamasa26346497-eng/livecity; read-only preview for manual review, build-time)';
(async () => {
  const files = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', maxlag: '5', prop: 'imageinfo', iiprop: 'url', iiurlwidth: '640', titles: files.map((f) => 'File:' + f).join('|') }).toString();
  const j = await (await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })).json();
  for (const p of j.query.pages) {
    const ii = (p.imageinfo || [])[0];
    if (!ii) { console.log('missing', p.title); continue; }
    const b = Buffer.from(await (await fetch(ii.thumburl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })).arrayBuffer());
    const fn = path.join(OUT, p.title.replace(/^File:/, '').replace(/[^\w.-]+/g, '_') + '.jpg');
    fs.writeFileSync(fn, b);
    console.log(fn, b.length);
    await new Promise((r) => setTimeout(r, 1500));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
