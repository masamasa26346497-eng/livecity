#!/usr/bin/env node
'use strict';
// Read-only 監査: 36L 写真索引の全件について、写真候補数・日付の根拠・複数候補・ライセンス・作者・解像度・移転疑義を集計する。
// アップロード日は索引に無く、撮影日とみなさない（日付不明は unknown）。出力: data/reports/mission37f-photo-audit/audit.json
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const idx = JSON.parse(fs.readFileSync(path.join(root, 'public/map-data/osaka-city/derived/building-photo-index.json'), 'utf8'));
const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/mission37f-photo-select.js'), 'utf8'), sandbox);
const PS = sandbox.module.exports;

const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
const A = {
  generatedFrom: 'public/map-data/osaka-city/derived/building-photo-index.json', indexGeneratedAt: idx.generatedAt,
  entries: 0, entriesByConfidence: {}, entriesWithPhotos: 0, photoCandidates: 0, multiPhotoEntries: 0, entriesByPhotoCount: {},
  dateBasis: {}, licenses: {}, genericAuthor: 0, missingAuthor: 0, httpsThumbnail: 0, noHttps: 0, noLicense: 0,
  resolution: { under320x200: 0, mid: 0, large: 0 }, eligibleEntries: 0, eligiblePhotos: 0, rejectedReasons: {},
  reorderedByDate: [], relocationSuspects: [], sharedFileAcrossBuildings: 0
};
const GENERIC = /^(own work|self[- ]?photographed|i, .+|photo taken by .+|taken by .+)$/i;
// 移転の疑義は名称・年だけでは断定できない。「病院/移転/旧」を含む名称で 2020 年以降の年がファイル名にあるものを候補として列挙する（確定ではない）
const RELOC = /(移転|旧|病院)/;
const fileUse = {};
for (const [cid, e] of Object.entries(idx.byCanonicalId)) {
  A.entries++; inc(A.entriesByConfidence, e.matchConfidence);
  const photos = e.photos || [];
  if (photos.length) A.entriesWithPhotos++;
  if (photos.length > 1) A.multiPhotoEntries++;
  inc(A.entriesByPhotoCount, String(photos.length));
  for (const p of photos) {
    A.photoCandidates++;
    inc(A.dateBasis, PS.dateInfo(p, {}).basis);
    inc(A.licenses, p.license || '(none)');
    if (!p.license) A.noLicense++;
    if (/^https:\/\//.test(p.thumbnailUrl || '')) A.httpsThumbnail++; else A.noHttps++;
    if (!p.author) A.missingAuthor++; else if (GENERIC.test(String(p.author).trim())) A.genericAuthor++;
    const px = (p.width || 0) * (p.height || 0);
    if (px < 320 * 200) A.resolution.under320x200++; else if (px < 320 * 300) A.resolution.mid++; else A.resolution.large++;
    const f = PS.fileName(p); (fileUse[f] = fileUse[f] || new Set()).add(cid);
  }
  const r = PS.rankPhotos(e, { okConfidence: idx.policy.clickShows });
  if (r.eligibleEntry && r.photos.length) {
    A.eligibleEntries++; A.eligiblePhotos += r.photos.length;
    const first = PS.fileName(photos[0]), now = PS.fileName(r.photos[0].photo);
    if (first && now && first !== now) A.reorderedByDate.push({ canonicalId: cid, name: e.buildingName, before: first, after: now, afterDateBasis: r.photos[0].date.basis, afterYear: r.photos[0].date.year });
  }
  for (const x of r.rejected) inc(A.rejectedReasons, x.reason);
  if (RELOC.test(String(e.buildingName || '')) && photos.some((p) => { const h = PS.yearHint(PS.fileName(p)); return h && h.year >= 2020; }))
    A.relocationSuspects.push({ canonicalId: cid, name: e.buildingName, files: photos.map(PS.fileName) });
}
A.sharedFileAcrossBuildings = Object.values(fileUse).filter((s) => s.size > 1).length;
A.note = '索引に撮影日・アップロード日は無い。dateBasis=filename はファイル名中の年（非検証の目安）、unknown は日付不明。verified は検証済み日付表(未整備)が必要。';
const out = path.join(root, 'data/reports/mission37f-photo-audit'); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'audit.json'), JSON.stringify(A, null, 2) + '\n');
const s = Object.assign({}, A, { reorderedByDate: A.reorderedByDate.length, relocationSuspects: A.relocationSuspects.length });
console.log(JSON.stringify(s, null, 1));
