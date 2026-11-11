// Mission 178 (PR #51 only): build a 37G-compatible /ext-3dtiles/index.json from the 2025 LOD1 audit manifest.
// Honest flags: verified is true ONLY when all 24 wards are present, duplicate-free and browserVerified.
// This does NOT assert road/river alignment or 37G-UI verification (those stay false until measured). No PR #24/#50 file is touched.
import fs from 'node:fs';
import path from 'node:path';

export function buildExtIndex(audit, progress) {
  const codes = Object.fromEntries(Object.entries(progress.wards || {}).map(([k, v]) => [k, v.wardCode]));
  const wards = Object.entries(audit.wards).filter(([, w]) => w.present).map(([ward, w]) => ({
    ward, wardCode: codes[ward] || null, buildings: w.buildings, tiles: w.tiles, bytes: w.bytes, treeSha256: w.treeSha256,
    lod: 'LOD1', idScheme: 'gml:id', sourceVersion: audit.source,
  }));
  const all = wards.length === 24 && Object.values(audit.wards).every((w) => w.present && w.duplicateIds === 0 && w.missingMeshes === 0 && w.browserVerified === true);
  return {
    schema: 'livecity-ext3dtiles-index/1', kind: 'local-only', source: audit.source, sourceEtag: audit.sourceEtag, license: audit.license,
    verified: false, standaloneVerified24: all, standaloneChromeOnly: true, ui37gVerified: false, roadRiverAlignmentVerified: false,
    persisted: false, published: false, lod0Wards: [], layersWards: [], wards,
  };
}

if (process.argv[1] && process.argv[1].endsWith('make-ext-index.mjs')) {
  const r = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const idx = buildExtIndex(r('data/reports/mission156/audit-manifest.json'), r('data/reports/mission156/progress.json'));
  const out = process.argv[2] || 'temp/ext-3dtiles/index.json';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(idx, null, 1));
  console.log(JSON.stringify({ out, wards: idx.wards.length, verified: idx.verified }));
}
