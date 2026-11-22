#!/usr/bin/env node
// Mission 195: ID-set audit of the opt-in "complement LOD1" (LOD1 minus buildings that have a real LOD2), any ward.
// Usage: node lod2-exclusion-audit.mjs --orig <ward-2025 dir> --ex <ward-2025-ex dir> --manifest temp/lod2-all/manifest.json --ward kita --out report.json
import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const idsOf = (dir) => {
  const s = new Set();
  const d = path.join(dir, 'ids');
  for (const f of fs.readdirSync(d)) for (const id of JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) s.add(id);
  return s;
};
const orig = idsOf(opt('orig'));
const ex = idsOf(opt('ex'));
const man = JSON.parse(fs.readFileSync(opt('manifest', 'temp/lod2-all/manifest.json'), 'utf8'));
const lod2 = new Set();
let dupInManifest = 0;
for (const as of man.assets) for (const id of as.ids || []) { if (lod2.has(id)) dupInManifest++; lod2.add(id); }
const inter = [...lod2].filter((i) => orig.has(i));
const removed = [...orig].filter((i) => !ex.has(i));
const removedSet = new Set(removed);
const r = {
  source: man.source || 'plateau-27100-osaka-shi-2025',
  ward: opt('ward'),
  orig: orig.size,
  lod2Total: lod2.size,
  lod2DupInManifest: dupInManifest,
  lod2InOrig: inter.length,
  exRemaining: ex.size,
  removed: removed.length,
  removedEqualsLod2Intersect: removed.length === inter.length && inter.every((i) => removedSet.has(i)),
  remainingContainsLod2: [...ex].filter((i) => lod2.has(i)).length,
  nonLod2LostFromOrig: removed.filter((i) => !lod2.has(i)).length,
  extraInEx: [...ex].filter((i) => !orig.has(i)).length,
  lod2NotInWardLod1: lod2.size - inter.length,
};
const near = opt('near');
if (near) {
  // lon,lat,radiusM : LOD2 buildings (by footprint centroid) within radius that are in ward LOD1 / excluded
  const [lon, lat, rad] = near.split(',').map(Number);
  const fp = JSON.parse(fs.readFileSync(opt('footprints', 'temp/lod2-all/footprints.json'), 'utf8')).footprints;
  const kx = 111320 * Math.cos(lat * Math.PI / 180);
  let n = 0, inWard = 0, removedN = 0;
  for (const f of fp) {
    const c = f.hull.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((v) => v / f.hull.length);
    if (Math.hypot((c[0] - lon) * kx, (c[1] - lat) * 111320) > rad) continue;
    n++;
    if (orig.has(f.id)) { inWard++; if (!ex.has(f.id)) removedN++; }
  }
  r.nearCheck = { lon, lat, radiusM: rad, lod2Within: n, inWardLod1: inWard, removedFromComplement: removedN };
}
const s = JSON.stringify(r, null, 1);
if (opt('out')) fs.writeFileSync(opt('out'), s);
console.log(s);
