#!/usr/bin/env node
// Mission 182A: extract the exact gml:id set of buildings that carry LOD2 geometry in PLATEAU CityGML (same-vintage source).
//   node tools/mission182/extract-lod2-ids.mjs --input <dir with *_bldg_*.gml> --out <ids.json> [--vintage 2025]
// A top-level <bldg:Building> counts as LOD2 if it contains <bldg:lod2Solid> or <bldg:lod2MultiSurface>.
// Buildings with no gml:id are reported (noId) and never listed. Reads local GML only; nothing is fetched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function lod2IdsFromXml(xml) {
  const ids = [];
  const stat = { buildings: 0, lod2Solid: 0, lod2SurfaceOnly: 0, noId: 0, lod1Only: 0 };
  const re = /<bldg:Building(?=[\s>])([^>]*)>([\s\S]*?)<\/bldg:Building>/g;
  let m;
  while ((m = re.exec(xml))) {
    stat.buildings++;
    const body = m[2];
    const solid = body.includes('<bldg:lod2Solid');
    const surf = body.includes('<bldg:lod2MultiSurface');
    if (!solid && !surf) { stat.lod1Only++; continue; }
    const id = (m[1].match(/gml:id="([^"]+)"/) || [])[1];
    if (!id) { stat.noId++; continue; }
    if (solid) stat.lod2Solid++; else stat.lod2SurfaceOnly++;
    ids.push(id);
  }
  return { ids, stat };
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const input = opt('input');
  const out = opt('out');
  if (!input || !out) throw new Error('usage: --input <dir> --out <ids.json> [--vintage 2025]');
  const files = fs.readdirSync(input).filter((f) => /_bldg_.*\.gml$/i.test(f)).sort();
  const all = new Set();
  let dup = 0;
  const perMesh = {};
  const tot = { buildings: 0, lod2Solid: 0, lod2SurfaceOnly: 0, noId: 0, lod1Only: 0 };
  for (const f of files) {
    const { ids, stat } = lod2IdsFromXml(fs.readFileSync(path.join(input, f), 'utf8'));
    for (const k of Object.keys(tot)) tot[k] += stat[k];
    perMesh[f.split('_')[0]] = ids.length;
    for (const id of ids) { if (all.has(id)) dup++; all.add(id); }
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    mission: '182A', vintage: Number(opt('vintage', 2025)), idScheme: 'gml:id verbatim',
    rule: 'top-level bldg:Building containing bldg:lod2Solid or bldg:lod2MultiSurface',
    files: files.length, totals: tot, uniqueLod2Ids: all.size, duplicateAcrossFiles: dup, perMesh, ids: [...all].sort(),
  }));
  console.log(JSON.stringify({ files: files.length, ...tot, uniqueLod2Ids: all.size, duplicateAcrossFiles: dup }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
