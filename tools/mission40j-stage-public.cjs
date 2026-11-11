#!/usr/bin/env node
// Mission 40J: inspect a locally converted ward output (40B/40G) and stage it under public/mission40j-3dtiles/<ward>/
// so that the same-origin viewer (mission37g page) can serve it on Vercel Preview.
//
//   DRY RUN (default, writes nothing, prints sizes / counts / checks):
//     node tools/mission40j-stage-public.cjs --src ..\livecity-3dtiles-out-fukushima\fukushima --ward fukushima
//   EXECUTE (copies new files only, then registers the ward in published.json):
//     node tools/mission40j-stage-public.cjs --src ... --ward fukushima --execute ^
//          --license-checked --owner-approved-release --approved-by "<name>"
//
//   - The source is read-only. Existing destination files are never overwritten (COPYFILE_EXCL; a non-empty dest aborts).
//   - It does NOT run git. Staged files are git-ignored; adding them to Git/pushing is a separate, explicit step (`git add -f`).
//   - --execute needs BOTH --license-checked and --owner-approved-release, and a size under --max-mb (default 40).
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'mission40j-3dtiles');
const REQUIRED = ['tileset.json', 'source.json', 'build-report.json'];
const REQUIRED_DIRS = ['attrs', 'ids'];
const LAYER_FILES = ['roads.json', 'waterways.json', 'parks.json', 'railways.json', 'layers-report.json'];
const ALLOWED_EXT = new Set(['.json', '.glb']);
const fmtMB = (b) => (b / 1048576).toFixed(2) + ' MB';

function parseArgs(argv) {
  const a = { src: null, ward: null, execute: false, license: false, approved: false, by: null, maxMb: 40, out: OUT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--src') a.src = argv[++i]; else if (k === '--ward') a.ward = argv[++i];
    else if (k === '--execute') a.execute = true; else if (k === '--license-checked') a.license = true;
    else if (k === '--owner-approved-release') a.approved = true; else if (k === '--approved-by') a.by = argv[++i];
    else if (k === '--max-mb') a.maxMb = Number(argv[++i]); else if (k === '--out') a.out = path.resolve(argv[++i]);
    else throw new Error('unknown argument: ' + k);
  }
  if (!a.src || !a.ward) throw new Error('--src and --ward are required');
  if (!/^[a-z0-9-]+$/.test(a.ward)) throw new Error('bad --ward (a-z, 0-9, - only)');
  if (!(a.maxMb > 0 && a.maxMb <= 200)) throw new Error('--max-mb must be 1..200');
  return a;
}

function walk(dir, base, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), rel = path.posix.join(base, e.name);
    if (e.isSymbolicLink()) throw new Error('symlink not allowed: ' + rel);
    if (e.isDirectory()) walk(p, rel, acc);
    else acc.push({ abs: p, rel, bytes: fs.statSync(p).size });
  }
  return acc;
}

function inspect(srcDir, ward) {
  const problems = [], notes = [];
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return { problems: ['source directory not found: ' + srcDir], notes, files: [] };
  for (const f of REQUIRED) if (!fs.existsSync(path.join(srcDir, f))) problems.push('missing ' + f);
  for (const d of REQUIRED_DIRS) if (!fs.existsSync(path.join(srcDir, d))) problems.push('missing directory ' + d + '/');
  if (problems.length) return { problems, notes, files: [] };
  const files = walk(srcDir, '', []);
  for (const f of files) {
    if (!ALLOWED_EXT.has(path.extname(f.rel).toLowerCase())) problems.push('unexpected file type: ' + f.rel);
  }
  const rj = (f) => JSON.parse(fs.readFileSync(path.join(srcDir, f), 'utf8'));
  let src, rep;
  try { src = rj('source.json'); rep = rj('build-report.json'); } catch (e) { problems.push('unreadable json: ' + e.message); return { problems, notes, files }; }
  if (!/^\d{5}$/.test(String(src.wardCode || ''))) problems.push('source.json has no valid wardCode');
  if (!src.source || !/PLATEAU/i.test(String(src.source))) problems.push('source.json does not name PLATEAU as the building source (attribution cannot be shown)');
  if (src.idPolicy === undefined) notes.push('source.json has no idPolicy (older converter output)');
  const total = rep && rep.totals ? rep.totals.buildings : null;
  if (!(total > 0)) problems.push('build-report totals.buildings missing or 0');
  // ids/ sidecars must add up to the reported building count
  let idCount = 0;
  for (const f of files.filter((x) => /^ids\/t_[^/]*\.json$/.test(x.rel))) {   // g_*.json は LOD グループ用なので数えない
    const j = JSON.parse(fs.readFileSync(f.abs, 'utf8'));
    idCount += Array.isArray(j) ? j.length : (j.ids ? j.ids.length : 0);
  }
  if (total > 0 && idCount !== total) problems.push('ids/ count ' + idCount + ' != build-report buildings ' + total);
  if (rep && rep.totals && (rep.totals.skipped || 0) > 0) notes.push('skipped buildings: ' + rep.totals.skipped);
  // layers (optional, but if present must be complete and carry the OSM source)
  const hasLayers = files.some((f) => f.rel.startsWith('layers/'));
  if (hasLayers) {
    for (const lf of LAYER_FILES) if (!files.some((f) => f.rel === 'layers/' + lf)) problems.push('layers/' + lf + ' missing');
  } else notes.push('no layers/ directory: roads/rivers will not be shown for this ward');
  return { problems, notes, files, summary: { wardCode: src.wardCode, source: src.source, buildings: total, ids: idCount, hasLayers } };
}

function run(argv) {
  const a = parseArgs(argv);
  const srcDir = path.resolve(a.src);
  const r = inspect(srcDir, a.ward);
  const bytes = r.files.reduce((s, f) => s + f.bytes, 0);
  const out = { mode: a.execute ? 'execute' : 'dry-run', ward: a.ward, src: srcDir, files: r.files.length, bytes, size: fmtMB(bytes), maxMb: a.maxMb, summary: r.summary || null, problems: r.problems, notes: r.notes };
  if (bytes > a.maxMb * 1048576) out.problems.push('size ' + fmtMB(bytes) + ' exceeds --max-mb ' + a.maxMb);
  const dest = path.join(a.out, a.ward);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) out.problems.push('destination is not empty (will not overwrite): ' + dest);
  out.dest = dest;
  if (!a.execute) { out.next = 'Dry run only. Nothing was written.'; return out; }
  if (!a.license) out.problems.push('--license-checked is required (PLATEAU / OSM terms must be confirmed by the owner)');
  if (!a.approved) out.problems.push('--owner-approved-release is required (explicit final approval to publish the data)');
  if (!a.by) out.problems.push('--approved-by "<name>" is required');
  if (out.problems.length) { out.next = 'Aborted. Nothing was written.'; return out; }
  for (const f of r.files) {
    const to = path.join(dest, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f.abs, to, fs.constants.COPYFILE_EXCL);
  }
  const pj = path.join(a.out, 'published.json');
  const cur = fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')) : { schema: 1, wards: [] };
  if (!cur.wards.some((w) => w.ward === a.ward)) cur.wards.push({ ward: a.ward, approved: true, approvedBy: a.by, approvedAt: new Date().toISOString(), licenseChecked: true, bytes, buildings: r.summary.buildings });
  fs.writeFileSync(pj, JSON.stringify(cur, null, 2) + '\n');
  out.next = 'Copied ' + r.files.length + ' files. Files are git-ignored; to publish: git add -f public/mission40j-3dtiles/' + a.ward + ' public/mission40j-3dtiles/published.json (only after final approval).';
  return out;
}

if (require.main === module) {
  try {
    const out = run(process.argv.slice(2));
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.problems.length ? 1 : 0);
  } catch (e) { console.error('ERROR: ' + e.message); process.exit(2); }
}
module.exports = { run, inspect, parseArgs };
