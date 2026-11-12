#!/usr/bin/env node
'use strict';
// Mission 37F: 日付表を適用する前後で、各建物の先頭写真がどう変わるかを一覧する（読み取り専用）。
//   node tools/mission37f-ranking-diff.cjs
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived', p), 'utf8'));
const sb = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/mission37f-photo-select.js'), 'utf8'), sb);
const PS = sb.module.exports;
const idx = rd('building-photo-index.json'), dates = rd('photo-dates.json').dates, holds = rd('photo-review.json').holds;
const reloc = ['Hanwa_memorial_hospital_2023-12_2.jpg', 'Hanwa_memorial_hospital_2023-12_1.jpg'];
let changed = 0, total = 0, sumiyoshi = 0;
const rows = [];
for (const e of Object.values(idx.byCanonicalId)) {
  const hold = holds.filter((h) => 'cg_bldg_' + h.canonicalId === e.canonicalId).map((h) => h.file);
  const ex = reloc.concat(hold);
  const before = PS.rankPhotos(e, { exclude: ex }).photos, after = PS.rankPhotos(e, { exclude: ex, dates }).photos;
  if (!after.length) continue;
  total++;
  if (PS.fileName(before[0].photo) !== PS.fileName(after[0].photo)) {
    changed++;
    if (e.ward === 'suminoe' || /住吉/.test(e.buildingName || '')) sumiyoshi++;
    rows.push({ name: e.buildingName, ward: e.ward, before: PS.fileName(before[0].photo), after: PS.fileName(after[0].photo), takenAt: after[0].date.takenAt || null });
  }
}
console.log(JSON.stringify({ total, changed, rows }, null, 1));
