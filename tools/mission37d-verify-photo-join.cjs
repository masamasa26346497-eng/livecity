#!/usr/bin/env node
'use strict';
// Read-only: 37D の renderPhoto と同じキー 'cg_bldg_' + id で、52 tile の建物と 36L 写真索引が実データで結合するか検証する。
const fs = require('node:fs'), path = require('node:path');
const B = path.resolve(__dirname, '..', 'public') + '/';
const R = B + 'map-data/osaka-city/';
const idx = JSON.parse(fs.readFileSync(R + 'derived/building-photo-index.json', 'utf8'));
const dir = R + 'buildings/osaka-sumiyoshi';
const ids = new Set();
for (const f of fs.readdirSync(dir).filter((f) => /^tile_.*\.json$/.test(f))) {
  for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/"id"\s*:\s*"(bldg_[0-9a-f-]+)"/g)) ids.add(m[1]);
}
const ok = (idx.policy && idx.policy.clickShows) || ['VERY_HIGH', 'HIGH'];
const hits = [];
for (const id of ids) { const e = idx.byCanonicalId['cg_bldg_' + id]; if (e) hits.push([id, e]); }
const shown = [];
for (const [id, e] of hits) {
  const ph = (e.photos || []).filter((p) => /^https:/.test(p.thumbnailUrl || '') && p.license);
  const row = { id, conf: e.matchConfidence, name: e.buildingName, photos: ph.length };
  if (ph[0]) Object.assign(row, { author: ph[0].author, license: ph[0].license, thumb: ph[0].thumbnailUrl });
  console.log(JSON.stringify(row));
  if (ok.includes(e.matchConfidence) && ph.length) shown.push(id);
}
const d9 = B + 'mission37c-layers/osaka-sumiyoshi-9tile/attrs/';
const s9 = new Set();
for (const f of fs.readdirSync(d9)) for (const x of fs.readFileSync(d9 + f, 'utf8').matchAll(/bldg_[0-9a-f-]{36}/g)) s9.add(x[0]);
console.log(JSON.stringify({ clickShows: ok, tileIds: ids.size, joined: hits.length, displayable: shown.length, tileIds9: s9.size, displayableIn9tile: shown.filter((i) => s9.has(i)) }));
