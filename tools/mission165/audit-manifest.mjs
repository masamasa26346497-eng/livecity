#!/usr/bin/env node
// Mission 165: small, committable per-ward audit manifest (NO tile data): counts, bytes, sha256 of every output file rolled
// into one tree hash, plus the source lock ETag. Lets a later runner prove a rebuilt/restored ward is identical.
//   node tools/mission165/audit-manifest.mjs [--root temp/mission156]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const i = process.argv.indexOf('--root');
const root = i > 0 ? process.argv[i + 1] : 'temp/mission156';
const prog = JSON.parse(fs.readFileSync('data/reports/mission156/progress.json', 'utf8'));
const out = { mission: '165', source: prog.source, sourceEtag: prog.sourceEtag, license: prog.license, published: false, storage: 'not-persisted (no LIVECITY_3D_DATA_TOKEN)', wards: {} };
for (const [w, p] of Object.entries(prog.wards)) {
  const dir = path.join(root, w, 'tiles');
  if (!fs.existsSync(dir)) { out.wards[w] = { present: false }; continue; }
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath || e.path, e.name)).split(path.sep).join('/')).sort();
  const tree = crypto.createHash('sha256'); let bytes = 0;
  for (const f of files) { const b = fs.readFileSync(path.join(dir, f)); bytes += b.length; tree.update(f + '\0' + crypto.createHash('sha256').update(b).digest('hex') + '\n'); }
  out.wards[w] = {
    present: true, files: files.length, bytes, treeSha256: tree.digest('hex'),
    buildings: p.convertedBuildings, sourceBuildings: p.sourceBuildings, duplicateIds: p.duplicateIds, tiles: p.tiles,
    meshesPlanned: p.meshesPlanned, meshesFetched: p.meshesFetched, missingMeshes: p.meshesPlanned - p.meshesFetched,
    http200Verified: p.http200Verified, browserVerified: p.browserVerified,
  };
}
const t = Object.values(out.wards).filter((x) => x.present);
out.totals = { wards: t.length, buildings: t.reduce((n, x) => n + x.buildings, 0), bytes: t.reduce((n, x) => n + x.bytes, 0), browserVerified: t.filter((x) => x.browserVerified).length };
fs.writeFileSync('data/reports/mission156/audit-manifest.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.totals));
