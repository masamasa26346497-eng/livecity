#!/usr/bin/env node
'use strict';
// Mission 37F-5: 画面に出る先頭写真の「古さ」を集計し、更新優先候補を出す（読み取り専用・ネットワーク不使用）。
//   node tools/mission37f-photo-age-audit.cjs [--asof 2026-10-12]
// 古さは検証済みの撮影日(photo-dates.json / adds)だけから計算する。日付が検証できないものは「未確認」とし、年数を推測しない。
// 外観写真か・建物一致かは日付から判定できないため、この集計は「再調査の優先順位」であって品質判定ではない。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const D = path.join(root, 'public/map-data/osaka-city/derived');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(D, p), 'utf8'));
const args = process.argv.slice(2);
const asof = new Date((args.includes('--asof') ? args[args.indexOf('--asof') + 1] : new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
const sb = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/mission37f-photo-select.js'), 'utf8'), sb);
const PS = sb.module.exports;
const idx = rd('building-photo-index.json'), dates = rd('photo-dates.json').dates, review = rd('photo-review.json');
// 移転ロック（37D ページの RELOCATED と同じ）
const RELOC = { 'cg_bldg_bldg_ec74351a-f344-4b61-b2e6-04b660b05aa0': ['Hanwa_memorial_hospital_2023-12_2.jpg'], 'cg_bldg_bldg_fae25b63-cddc-4545-8004-c41620676308': ['Hanwa_memorial_hospital_2023-12_1.jpg'] };
const ageYears = (t) => { const [y, m, d] = t.split('-').map(Number); return (asof - Date.UTC(y, (m || 1) - 1, d || 1)) / (365.25 * 864e5); };
const B = { total: 0, under5: 0, from5to10: 0, over10: 0, unknown: 0, relocationLocked: Object.keys(RELOC).length, holds: review.holds.length, adds: (review.adds || []).length };
const priority = [];
for (const e of Object.values(idx.byCanonicalId)) {
  const hold = review.holds.filter((h) => 'cg_bldg_' + h.canonicalId === e.canonicalId).map((h) => h.file);
  const r = PS.rankPhotos(e, { dates, adds: review.adds, exclude: hold.concat(RELOC[e.canonicalId] || []) });
  if (!r.eligibleEntry || !r.photos.length) continue;
  B.total++;
  const top = r.photos[0], d = top.date;
  if (d.basis !== 'verified') { B.unknown++; priority.push({ canonicalId: e.canonicalId, name: e.buildingName, ward: e.ward, file: PS.fileName(top.photo), takenAt: null, ageYears: null, why: 'date-unverified' }); continue; }
  const a = ageYears(d.takenAt);
  if (a < 5) B.under5++; else if (a < 10) B.from5to10++; else B.over10++;
  if (a >= 10) priority.push({ canonicalId: e.canonicalId, name: e.buildingName, ward: e.ward, file: PS.fileName(top.photo), takenAt: d.takenAt, ageYears: +a.toFixed(1), why: 'over-10y' });
}
priority.sort((a, b) => (b.ageYears || 99) - (a.ageYears || 99));
const out = { asof: asof.toISOString().slice(0, 10), note: '先頭写真の撮影日（検証済みのみ）からの経過年数。年数は撮影日が検証済みの場合だけ計算し、未確認は推測しない。外観か・建物一致かは判定していない。', buckets: B, priorityOver10y: priority.filter((p) => p.why === 'over-10y').length, priorityUnverified: priority.filter((p) => p.why === 'date-unverified').length, priority: priority.slice(0, 40) };
fs.mkdirSync(path.join(root, 'data/reports/mission37f-photo-audit'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/reports/mission37f-photo-audit/age-audit.json'), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ asof: out.asof, buckets: B, over10: out.priorityOver10y, unverified: out.priorityUnverified, top5: priority.slice(0, 5) }, null, 1));
