#!/usr/bin/env node
// Mission 182A: set-level audit of a LOD2-complement build against the untouched LOD1-only build (same ward, same source).
//   node tools/mission182/audit-complement.mjs --full <lod1 dir> --complement <dir> --lod2-ids <ids.json> --out <audit.json>
// Proves: complement ∪ excluded == full (zero loss), complement ∩ lod2 == ∅ (no double draw), excluded ⊆ lod2 ids,
// and splits the LOD2 id set into matched-in-ward / not-in-ward-LOD1 (other ward or no LOD1 counterpart).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function idsOfBuild(dir) {
  const ids = new Set();
  const ad = path.join(dir, 'attrs');
  for (const f of fs.readdirSync(ad)) for (const id of Object.keys(JSON.parse(fs.readFileSync(path.join(ad, f), 'utf8')).byId)) ids.add(id);
  return ids;
}

export function auditSets(full, comp, lod2, excluded) {
  const lostFromFull = [...full].filter((id) => !comp.has(id) && !excluded.has(id));
  const fullButNotLod2Dropped = [...full].filter((id) => !lod2.has(id) && !comp.has(id));
  const lod2StillInComplement = [...comp].filter((id) => lod2.has(id));
  const complementNotInFull = [...comp].filter((id) => !full.has(id));
  const excludedNotLod2 = [...excluded].filter((id) => !lod2.has(id));
  const lod2InFull = [...lod2].filter((id) => full.has(id));
  return {
    lod1Full: full.size, lod1Complement: comp.size, excludedMatched: excluded.size, lod2IdsGiven: lod2.size,
    lod2IdsFoundInWardLod1: lod2InFull.length, lod2IdsNotInWardLod1: lod2.size - lod2InFull.length,
    lostFromFull: lostFromFull.length, nonLod2BuildingsDropped: fullButNotLod2Dropped.length,
    lod2StillDrawnAsLod1: lod2StillInComplement.length, complementNotInFull: complementNotInFull.length, excludedNotInLod2Set: excludedNotLod2.length,
    pass: lostFromFull.length === 0 && fullButNotLod2Dropped.length === 0 && lod2StillInComplement.length === 0 && complementNotInFull.length === 0 && excludedNotLod2.length === 0 && comp.size + excluded.size === full.size,
  };
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : null; };
  const full = idsOfBuild(opt('full'));
  const comp = idsOfBuild(opt('complement'));
  const meta = JSON.parse(fs.readFileSync(opt('lod2-ids'), 'utf8'));
  const excluded = new Set(JSON.parse(fs.readFileSync(path.join(opt('complement'), 'lod2-excluded-ids.json'), 'utf8')));
  const r = { mission: '182A', idSetVintage: meta.vintage, idScheme: meta.idScheme, ...auditSets(full, comp, new Set(meta.ids), excluded) };
  if (opt('out')) { fs.mkdirSync(path.dirname(path.resolve(opt('out'))), { recursive: true }); fs.writeFileSync(opt('out'), JSON.stringify(r, null, 1)); }
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.pass ? 0 : 1);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
