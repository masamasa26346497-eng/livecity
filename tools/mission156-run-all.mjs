#!/usr/bin/env node
// Mission 156: fresh PLATEAU (official, free) -> 24 ward LOD1 3D Tiles, from an EMPTY runner. No Windows/PC data.
//   node tools/mission156-run-all.mjs --plan                       # offline: meshes/MB per ward from source-lock
//   node tools/mission156-run-all.mjs --wards nishi,kita --max-mb 900
//   node tools/mission156-run-all.mjs --all --budget-mb 3000       # resumable; skips converted wards (same ETag)
// Output: temp/mission156/<ward>/ (gitignored, NEVER committed/public). Progress: data/reports/mission156/progress.json (small).
// Reuses tools/mission79-run.mjs (Range ZIP reader, sha256, resume) unchanged. A failing ward is recorded, the next continues, exit 1 at end.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { selectMeshes } from './mission79-run.mjs';
import { rightsGate, findDuplicateIds, summarize, shouldSkip, withRetry, buildDeliveryManifest } from './mission156/lib.mjs';

const ROOT = process.cwd();
const a = process.argv.slice(2);
const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const REP = path.join(ROOT, 'data/reports/mission156');
const PROG = path.join(REP, 'progress.json');

const lock = readJson('data/reports/mission79/source-lock.json');
const gate = rightsGate(lock);
if (!gate.ok) { console.error('RIGHTS GATE FAILED:\n - ' + gate.reasons.join('\n - ')); process.exit(2); }
const area = readJson('config/areas/osaka-city.json');
const polys = readJson('data/processed/osaka-city/boundaries/ward-classification-polygons.json');

const plan = {};
for (const w of polys.wards) {
  const { meshes } = selectMeshes(lock, w, area.projection);
  const ents = lock.entries.filter((e) => meshes.includes(e.mesh));
  plan[w.wardId] = {
    wardCode: w.wardCode, meshes,
    compressedMB: +(ents.reduce((n, e) => n + e.compressedBytes, 0) / 1048576).toFixed(1),
    inflatedMB: +(ents.reduce((n, e) => n + e.uncompressedBytes, 0) / 1048576).toFixed(1),
  };
}
const progress = fs.existsSync(PROG) ? (readJson(PROG).wards || {}) : {};
fs.mkdirSync(REP, { recursive: true });
const save = () => fs.writeFileSync(PROG, JSON.stringify({
  mission: '156', source: lock.package.name, sourceEtag: lock.http.etag, license: lock.license.id,
  generatedAt: new Date().toISOString(), wards: progress, summary: summarize(progress, plan),
}, null, 1));

if (a.includes('--plan')) {
  const t = Object.values(plan);
  const out = {
    mission: '156', rights: gate, wards: plan,
    totals: {
      wards: t.length, meshes: new Set(t.flatMap((x) => x.meshes)).size,
      compressedMB: +t.reduce((n, x) => n + x.compressedMB, 0).toFixed(1), inflatedMB: +t.reduce((n, x) => n + x.inflatedMB, 0).toFixed(1),
    },
  };
  fs.writeFileSync(path.join(REP, 'plan.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out.totals), 'wards without meshes:', Object.entries(plan).filter(([, v]) => !v.meshes.length).map(([k]) => k));
  process.exit(0);
}

const outRoot = path.resolve(opt('out-root', 'temp/mission156'));
const wards = a.includes('--all') ? Object.keys(plan) : (opt('wards') || '').split(',').filter(Boolean);
if (!wards.length) { console.error('need --plan, --all or --wards a,b'); process.exit(2); }
const maxMb = Number(opt('max-mb', 900));
let budget = Number(opt('budget-mb', 3000));
let failed = 0;

for (const w of wards) {
  const pl = plan[w];
  if (!pl) { console.error('unknown ward', w); failed++; continue; }
  const final = path.join(outRoot, w, 'tiles'), work = path.join(outRoot, w, 'work');
  if (shouldSkip(progress[w], lock.http.etag, fs.existsSync(final))) { console.log('[156] skip (converted, same ETag)', w); continue; }
  if (pl.inflatedMB > budget) { console.log('[156] budget exhausted before', w, '- resume in next run'); continue; }
  fs.rmSync(final, { recursive: true, force: true });
  const t0 = Date.now();
  const rec = { wardCode: pl.wardCode, meshesPlanned: pl.meshes.length, meshesFetched: 0, sourceEtag: lock.http.etag, compressedMB: pl.compressedMB, inflatedMB: pl.inflatedMB };
  try {
    // transient failure => retry (mission79 fetch resumes via its sha256 manifest); final dir must be empty per attempt
    await withRetry(() => {
      // Mission 160: a size-guard refusal is deterministic, not transient: fail fast, do not retry (Kita 958MB > 900MB default)
      if (pl.inflatedMB > maxMb) { const g = new Error(`size guard: ${w} inflated ${pl.inflatedMB}MB exceeds --max-mb ${maxMb}`); g.noRetry = true; throw g; }
      fs.rmSync(final, { recursive: true, force: true });
      execFileSync(process.execPath, ['tools/mission79-run.mjs', '--ward', w, '--work', work, '--final', final, '--max-mb', String(maxMb)], { stdio: 'inherit', cwd: ROOT, maxBuffer: 1 << 28, timeout: Number(opt('ward-timeout-min', 18)) * 60000 });
    }, { attempts: Number(opt('retries', 3)), onRetry: (i, e) => console.error('[156] retry', w, 'after attempt', i, String(e.message).slice(0, 120)) });
    const src = readJson(path.join(final, 'source.json')), al = readJson(path.join(final, 'alignment.json')), ts = readJson(path.join(final, 'tileset.json'));
    rec.meshesFetched = pl.meshes.length; // run succeeded => every planned mesh was fetched
    rec.meshesContributing = src.sourceMeshes.length; // meshes holding >=1 in-ward building (edge meshes may hold none)
    rec.sourceBuildings = src.counts.read; rec.convertedBuildings = src.counts.inWard; rec.outsideWard = src.counts.outsideWard; rec.duplicateIds = src.counts.duplicate;
    rec.tiles = (ts.extras && ts.extras.tiles) || null; rec.orientationOk = al.orientationOk === undefined ? null : al.orientationOk; rec.bestTransform = al.bestTransform || null;
    rec.outputBytes = fs.readdirSync(final, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).reduce((n, e) => n + fs.statSync(path.join(e.parentPath || e.path, e.name)).size, 0);
    rec.http200Verified = false; rec.browserVerified = false; // set only by the separate serve / Chrome verification steps
    budget -= pl.inflatedMB;
    fs.rmSync(work, { recursive: true, force: true }); // raw GML is not kept
  } catch (e) { rec.error = String(e.message).slice(0, 300); failed++; }
  rec.ms = Date.now() - t0;
  progress[w] = rec;
  save();
  console.log('[156]', w, rec.error ? 'FAILED ' + rec.error : `ok ${rec.convertedBuildings} buildings, ${rec.tiles} tiles, ${(rec.outputBytes / 1048576).toFixed(1)}MB, ${rec.ms}ms`);
}

// cross-ward canonical id duplicate check over everything converted so far
const idsByWard = {};
for (const [w, p] of Object.entries(progress)) {
  const d = path.join(outRoot, w, 'tiles', 'attrs');
  if (p.error || !fs.existsSync(d)) continue;
  idsByWard[w] = fs.readdirSync(d).flatMap((f) => Object.keys(readJson(path.join(d, f)).byId));
}
const dups = findDuplicateIds(idsByWard);
fs.writeFileSync(path.join(REP, 'id-duplicates.json'), JSON.stringify({ checkedWards: Object.keys(idsByWard), duplicateCount: dups.length, sample: dups.slice(0, 50) }, null, 1));
save();
fs.writeFileSync(path.join(REP, 'delivery-manifest.json'), JSON.stringify(buildDeliveryManifest(progress, lock.http.etag), null, 1));
const s = summarize(progress, plan);
console.log('[156] summary', JSON.stringify({ byStatus: s.byStatus, converted: s.convertedBuildingsTotal, vsDeclaredPct: s.measuredVsDeclaredPct, crossWardDuplicateIds: dups.length }));
process.exit(failed || dups.length ? 1 : 0);
