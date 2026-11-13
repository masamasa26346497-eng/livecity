#!/usr/bin/env node
// Mission 159: real CityGML -> LOD2 plan -> GLB -> 3D Tiles (single tile PoC). Output only under temp/ (gitignored).
// usage: node tools/lod2/lod2-build-real.mjs --gml a.gml,b.gml --out temp/lod2-poc
// LOD1 ids are the gml:id of ALL buildings in the same source GML (same canonical id => 1:1 match).
import fs from 'node:fs';
import path from 'node:path';
import { splitBuildings } from '../lib/citygml.js';
import { buildLod2Index, planBuildingSources, assertDisjoint } from './lod2-selector.js';
import { buildLod2Mesh, meshToGlb, buildTileset } from './lod2-to-glb.js';

const a = process.argv.slice(2), g = (k) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : null);
const out = path.resolve(g('--out') || 'temp/lod2-poc');
if (/[\\/]public[\\/]/.test(out)) throw new Error('refusing to write under public/');
fs.mkdirSync(out, { recursive: true });
const xmls = g('--gml').split(',').map((f) => fs.readFileSync(f, 'utf8'));
const lod1Ids = [], xmlById = new Map();
for (const x of xmls) for (const b of splitBuildings(x)) {
  const id = (b.match(/gml:id="([^"]+)"/) || [])[1]; if (!id) continue;
  lod1Ids.push(id); xmlById.set(id, b);
}
const { index } = buildLod2Index(xmls);
const plan = planBuildingSources(lod1Ids, index);
assertDisjoint(plan);
const sel = new Map([...plan.lod2Draw].map((id) => [id, xmlById.get(id)]));
// origin = first LOD2 roof vertex (lat lon h); positions are ENU relative to it (no global shift of buildings).
const first = [...sel.values()][0];
const m0 = first && first.match(/<gml:posList[^>]*>\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/);
const report = { mission: '159-lod2-poc', lod1Total: lod1Ids.length, lod2Candidates: index.size, lod2Planned: plan.lod2Draw.size,
  fallbacks: Object.fromEntries([...plan.fallbacks].map(([k, v]) => [k, v])), withTexture: plan.stats.withTexture, textureRendered: false };
if (m0) {
  const org = { lat: +m0[1], lon: +m0[2], h: +m0[3] };
  const mesh = buildLod2Mesh(sel, org);
  report.meshConverted = mesh.ok.length; report.meshFailed = mesh.failed; report.triangles = mesh.ok.reduce((n, o) => n + o.triangles, 0);
  report.extentEnu = mesh.extentEnu; report.origin = org;
  report.lod1DrawAfterExclusion = plan.lod1Draw.size;
  if (mesh.ok.length) {
    const glb = meshToGlb(mesh);
    fs.writeFileSync(path.join(out, 'lod2.glb'), glb);
    fs.writeFileSync(path.join(out, 'tileset.json'), JSON.stringify(buildTileset(mesh, org)));
    fs.writeFileSync(path.join(out, 'lod2-ids.json'), JSON.stringify(mesh.ok.map((o) => o.id)));
    report.glbBytes = glb.length;
  }
}
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report));
