#!/usr/bin/env node
// Issue #52: 既存の building-photo-index.json を読むだけの監査（ネットワーク不使用）。
// 使い方: node tools/photos/audit-photo-index.mjs [--write]   --write で data/photos/audit-before.json を更新
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLicense } from './lib/photo-license.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function audit(idx, dates) {
  const recs = idx.records || [];
  const byConf = {};
  const lic = {};
  const licNg = {};
  const files = new Map();
  let photoCount = 0, noAuthor = 0, noSource = 0, noLicenseUrl = 0;
  for (const r of recs) {
    const k = (r.matchConfidence || 'unknown') + (r.photos && r.photos.length ? '/photo' : '/nophoto');
    byConf[k] = (byConf[k] || 0) + 1;
    for (const p of r.photos || []) {
      photoCount++;
      lic[p.license] = (lic[p.license] || 0) + 1;
      if (!classifyLicense(p.license).ok) licNg[p.license] = (licNg[p.license] || 0) + 1;
      if (!p.author) noAuthor++;
      if (!p.sourcePageUrl) noSource++;
      if (!p.licenseUrl) noLicenseUrl++;
      files.set(p.title, (files.get(p.title) || 0) + 1);
    }
  }
  const ids = Object.entries(idx.byCanonicalId || {});
  const click = (idx.policy && idx.policy.clickShows) || [];
  const shownIds = ids.filter(([, e]) => click.includes(e.matchConfidence) && (e.photos || []).length);
  const strict = ids.filter(([, e]) => ['VERY_HIGH', 'HIGH'].includes(e.matchConfidence) && (e.photos || []).length);
  const dd = dates && dates.dates ? Object.values(dates.dates) : [];
  const verified = dd.filter((d) => d.verified === true).length;
  return {
    generatedFrom: 'public/map-data/osaka-city/derived/building-photo-index.json',
    indexVersion: idx.version,
    indexGeneratedAt: idx.generatedAt,
    denominators: {
      namedBuildingsTotal: idx.coverage && idx.coverage.namedBuildingsTotal,
      note: '分母は名前付き建物。索引のレコード(施設/ランドマーク候補)数とは別物で、施設数を棟数として数えない。'
    },
    records: { facilityRecords: recs.length, withPhoto: recs.filter((r) => r.photos && r.photos.length).length, byConfidenceAndPhoto: byConf },
    uniqueBuildingIds: {
      byCanonicalId: ids.length,
      byLandmarkId: Object.keys(idx.byLandmarkId || {}).length,
      withPhotoShownOnClick: shownIds.length,
      withPhotoHighConfidence: strict.length
    },
    hold: {
      unresolved: recs.filter((r) => r.matchConfidence === 'UNRESOLVED').length,
      ambiguous: recs.filter((r) => r.matchConfidence === 'AMBIGUOUS').length
    },
    photos: {
      total: photoCount,
      uniqueCommonsFiles: files.size,
      filesUsedByMultipleRecords: [...files].filter(([, n]) => n > 1).length,
      missingAuthor: noAuthor,
      missingSourcePage: noSource,
      missingLicenseUrl: noLicenseUrl,
      licenses: lic,
      licensesNotAdopted: licNg
    },
    dates: dates ? { files: dd.length, verified, verifiedRate: dd.length ? +(verified / dd.length).toFixed(3) : null } : null,
    netNewFromThisPR: 0,
    netNewNote: '本PRは外部取得を行っていないため、写真付き建物の純増は 0。上記はすべて既存データの実測。'
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const d = path.join(root, 'public/map-data/osaka-city/derived');
  const idx = JSON.parse(fs.readFileSync(path.join(d, 'building-photo-index.json'), 'utf8'));
  let dates = null;
  try { dates = JSON.parse(fs.readFileSync(path.join(d, 'photo-dates.json'), 'utf8')); } catch (e) { dates = null; }
  const out = audit(idx, dates);
  console.log(JSON.stringify(out, null, 2));
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.join(root, 'data/photos'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/photos/audit-before.json'), JSON.stringify(out, null, 2) + '\n');
  }
}
