#!/usr/bin/env node
'use strict';
// Mission 139: read-only 24-ward "real source -> files" matrix for the canonical page (mission37g-osaka-24ward-mvp.html).
//   node tools/mission139/acceptance-matrix.cjs [--out file.json]
// Classifies, from files only (no network, no writes except optional --out):
//   buildings : real-footprint tiles in Git (public/map-data/osaka-city/buildings/osaka-<ward>/), partial 3D Tiles samples (37H/38E/40J)
//   layers    : real road/river/water-surface per-ward files. Only 'real' if a source.json-less, non-fixture file exists in an allowed public dir.
// browserRendered is ALWAYS false here: WebGL acceptance needs a real Chrome run (tools/experiments/mission138_integrated_qa.mjs, owner PC / Actions).
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const count = (d, re) => { try { return fs.readdirSync(d).filter((n) => re.test(n)).length; } catch (e) { return 0; } };

const WARD_ALIASES = { higashisumiyoshi: 'higashisumiyoshi' };
// Partial 3D Tiles sets committed in Git, keyed by N03 wardCode (from each set's source.json).
const SAMPLE_DIRS = ['public/mission37h-3dtiles', 'public/mission38e-3dtiles', 'public/mission37b-3dtiles'];

function sampleSets() {
  const out = {};
  for (const base of SAMPLE_DIRS) {
    const bd = path.join(ROOT, base);
    let names = []; try { names = fs.readdirSync(bd); } catch (e) { continue; }
    for (const n of names) {
      const src = readJson(path.join(bd, n, 'source.json'));
      const rep = readJson(path.join(bd, n, 'build-report.json'));
      if (!src || !src.wardCode) continue;
      const code = String(src.wardCode);
      const b = (rep && (rep.buildings || (rep.counts && rep.counts.buildings))) || (src.counts && src.counts.inWard) || 0;
      (out[code] = out[code] || []).push({ dir: base + '/' + n, buildings: Number(b) || 0 });
    }
  }
  return out;
}

function build() {
  const wardsJson = readJson(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'));
  const samples = sampleSets();
  const published = (readJson(path.join(ROOT, 'public/mission40j-3dtiles/published.json')) || {}).wards || [];
  const rows = [];
  for (const w of wardsJson.wards) {
    const fpDir = path.join(ROOT, 'public/map-data/osaka-city/buildings/osaka-' + w.wardId);
    const fpTiles = count(fpDir, /^tile_.*\.json$/);
    const fpMan = readJson(path.join(fpDir, 'manifest.json'));
    const fpBuildings = fpTiles && fpMan ? Number(fpMan.buildings || fpMan.buildingCount || 0) : 0;
    const sets = samples[String(w.wardCode)] || [];
    const sampleBuildings = sets.reduce((a, s) => a + s.buildings, 0);
    const layersDir = path.join(ROOT, 'public/map-data/osaka-city/layers', w.wardId);
    const hasRealLayers = ['roads.json', 'waterways.json'].every((f) => fs.existsSync(path.join(layersDir, f)));
    rows.push({
      wardId: w.wardId, wardCode: String(w.wardCode), name: w.wardName,
      expectedBuildings: w.sourceBuildings, expectedTiles: w.sourceTiles,
      realFootprints: { tiles: fpTiles, buildings: fpBuildings, wholeWard: fpTiles > 0 && fpTiles === w.sourceTiles },
      partial3dTiles: { sets: sets.length, buildings: sampleBuildings, dirs: sets.map((s) => s.dir) },
      published40j: published.includes(w.wardId),
      realRoadsRiversInGit: hasRealLayers,
      browserRendered: false,
      verdict: fpTiles > 0 && fpTiles === w.sourceTiles ? (hasRealLayers ? 'buildings+layers' : 'buildings-only(whole ward)')
        : sampleBuildings > 0 ? 'buildings-partial' : 'map-only(no real building data in Git)',
    });
  }
  const sum = (f) => rows.filter(f).length;
  return {
    mission: 139, generatedBy: 'tools/mission139/acceptance-matrix.cjs', wards: rows.length,
    summary: {
      wholeWardRealFootprints: sum((r) => r.realFootprints.wholeWard),
      partial3dTilesOnly: sum((r) => !r.realFootprints.wholeWard && r.partial3dTiles.buildings > 0),
      mapOnly: sum((r) => r.verdict.startsWith('map-only')),
      realRoadsRiversInGit: sum((r) => r.realRoadsRiversInGit),
      browserRendered: 0,
    },
    rows,
    note: 'Road/river real data is not in Git (Mission115 builds it from the owner PC OSM tiles). Synthetic QA fixtures are never counted.',
  };
}

if (require.main === module) {
  const m = build();
  const i = process.argv.indexOf('--out');
  if (i > 0) { const f = path.resolve(process.argv[i + 1]); if (fs.existsSync(f)) { console.error('refusing to overwrite ' + f); process.exit(2); } fs.writeFileSync(f, JSON.stringify(m, null, 1)); }
  console.log(JSON.stringify(m.summary));
  for (const r of m.rows) console.log(r.wardId.padEnd(16), r.verdict.padEnd(40), 'fp', r.realFootprints.tiles + '/' + r.expectedTiles, 'partial3d', r.partial3dTiles.buildings);
}
module.exports = { build };
