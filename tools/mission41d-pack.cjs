'use strict';
// Mission 41D: fully OFFLINE pack checker for the 41B manifest.json (private GitHub Release parts).
// It reads local files only to lstat/hash them. It never writes inside a data root, never copies,
// moves, deletes or uploads, and has no network code. Output paths in reports are anonymous ids.
//   node tools/mission41d-pack.cjs pack   --manifest m.json --roots-file roots.json --out <new dir> [--dry-run]
//        [--part-limit-gib 1.5] [--only-category c1,c2] [--path-contains fukushima] [--min-free-gib 2]
//   node tools/mission41d-pack.cjs verify --manifest m.json --parts-dir <dir with .tar> [--state state.json]
//   node tools/mission41d-pack.cjs upload ...   (disabled; needs two explicit confirmations; still prints a plan only)
// roots.json: { "<root name used in manifest>": "<absolute dir>" }  (read as UTF-8, so Japanese paths are safe)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GIB = 1024 * 1024 * 1024;
const RELEASE_ASSET_LIMIT = 2 * GIB; // GitHub: asset must be < 2 GiB
const DEFAULT_PART_GIB = 1.5;
const TAR_BLOCK = 512;
const TAR_NAME_MAX = 255; // ustar-with-prefix practical limit; longer needs pax headers

function hexShort(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8); }

// Manifest paths are "<root>/<rel>" with forward slashes. Reject anything that is not a plain relative path.
function checkRel(p) {
  if (typeof p !== 'string' || !p) return 'empty-path';
  if (p.includes('\0')) return 'nul-byte';
  if (p.includes('\\')) return 'backslash';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute-path';
  const segs = p.split('/');
  if (segs.some((s) => s === '..')) return 'path-traversal';
  if (segs.some((s) => s === '.' || s === '')) return 'non-normalized';
  if (p.normalize('NFC') !== p) return 'not-nfc-normalized';
  if (Buffer.byteLength(p) > TAR_NAME_MAX) return 'name-too-long-for-ustar';
  return null;
}

function tarEstimate(files) {
  // per member: 512 header + data rounded up to 512; archive ends with two zero blocks
  return files.reduce((a, f) => a + TAR_BLOCK + Math.ceil(f.size / TAR_BLOCK) * TAR_BLOCK, 0) + 2 * TAR_BLOCK;
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

function insideRoot(real, rootReal) {
  const r = path.relative(rootReal, real);
  return r && !r.startsWith('..') && !path.isAbsolute(r);
}

function loadManifest(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!m || !Array.isArray(m.parts)) throw new Error('not a 41B manifest.json');
  return m;
}

function selectParts(m, opts) {
  let parts = m.parts;
  if (opts.onlyCategory && opts.onlyCategory.length) parts = parts.filter((p) => opts.onlyCategory.includes(p.category));
  if (opts.pathContains) {
    // keep only matching files; the part is then a sub-selection (reported as such)
    parts = parts.map((p) => ({ ...p, files: p.files.filter((f) => f.path.toLowerCase().includes(opts.pathContains.toLowerCase())) }))
      .filter((p) => p.files.length).map((p) => ({ ...p, bytes: p.files.reduce((a, f) => a + f.size, 0), fileCount: p.files.length, subselection: true }));
  }
  return parts;
}

// Core read-only check of one part. Never follows symlinks (lstat), never leaves the root.
function checkPart(part, roots, limitBytes, rootRealCache) {
  const problems = [];
  const seen = new Set();
  const seenLower = new Set();
  let bytes = 0, missing = 0, sizeChanged = 0;
  for (const f of part.files) {
    const bad = checkRel(f.path);
    if (bad) { problems.push({ id: hexShort(f.path), kind: bad }); continue; }
    if (seen.has(f.path)) { problems.push({ id: hexShort(f.path), kind: 'duplicate-path' }); continue; }
    seen.add(f.path);
    const lower = f.path.toLowerCase();
    if (seenLower.has(lower)) problems.push({ id: hexShort(f.path), kind: 'case-collision' });
    seenLower.add(lower);
    const i = f.path.indexOf('/');
    const rootName = f.path.slice(0, i), rel = f.path.slice(i + 1);
    const rootDir = roots[rootName];
    if (!rootDir) { problems.push({ id: hexShort(rootName), kind: 'root-not-mapped' }); continue; }
    if (!rootRealCache.has(rootName)) rootRealCache.set(rootName, fs.realpathSync(rootDir));
    const rootReal = rootRealCache.get(rootName);
    const full = path.join(rootDir, ...rel.split('/'));
    let st;
    try { st = fs.lstatSync(full); } catch { missing++; problems.push({ id: hexShort(f.path), kind: 'missing' }); continue; }
    if (st.isSymbolicLink()) { problems.push({ id: hexShort(f.path), kind: 'symlink-refused' }); continue; }
    if (!st.isFile()) { problems.push({ id: hexShort(f.path), kind: 'not-a-regular-file' }); continue; }
    if (st.nlink > 1) problems.push({ id: hexShort(f.path), kind: 'hardlink-warning' });
    let real; try { real = fs.realpathSync(full); } catch { problems.push({ id: hexShort(f.path), kind: 'missing' }); continue; }
    if (!insideRoot(real, rootReal)) { problems.push({ id: hexShort(f.path), kind: 'escapes-root' }); continue; }
    if (st.size !== f.size) { sizeChanged++; problems.push({ id: hexShort(f.path), kind: 'size-changed', manifest: f.size, now: st.size }); }
    bytes += st.size;
  }
  const est = tarEstimate(part.files);
  if (est >= limitBytes) problems.push({ id: part.asset, kind: 'tar-estimate-over-limit', estimate: est });
  if (est >= RELEASE_ASSET_LIMIT) problems.push({ id: part.asset, kind: 'tar-estimate-over-2GiB' });
  const fatal = problems.filter((p) => p.kind !== 'hardlink-warning');
  return { asset: part.asset, category: part.category, files: part.files.length, bytes, tarEstimate: est, missing, sizeChanged, approved: !!part.approved, problems, ok: fatal.length === 0 };
}

function dryRun(m, roots, opts) {
  const limitBytes = Math.floor((opts.partLimitGiB || DEFAULT_PART_GIB) * GIB);
  if (limitBytes >= RELEASE_ASSET_LIMIT) throw new Error('part limit must be < 2 GiB');
  const parts = selectParts(m, opts);
  const cache = new Map();
  const results = parts.map((p) => checkPart(p, roots, limitBytes, cache));
  const total = results.reduce((a, r) => a + r.tarEstimate, 0);
  const largest = results.reduce((a, r) => Math.max(a, r.tarEstimate), 0);
  const free = opts.outDir ? freeBytes(opts.outDir) : null;
  // staging needs one part at a time (build -> hash -> upload -> delete), not the whole set
  const needOne = largest + (opts.minFreeGiB || 2) * GIB;
  const diskOk = free === null ? null : free >= needOne;
  // gates: nothing is ready until a human cleared each one (see 41D README)
  const gates = {
    licenceApproved: results.every((r) => r.approved),
    noSecretsReviewed: opts.secretsReviewed === true,
    noPersonalDataReviewed: opts.personalReviewed === true,
  };
  const blocked = Object.entries(gates).filter(([, v]) => !v).map(([k]) => k);
  return {
    schema: 1, mode: 'dry-run', network: false, wroteInsideRoots: false,
    partLimitBytes: limitBytes, parts: results.length, totalTarEstimate: total, largestPartEstimate: largest,
    freeBytesAtOut: free, diskOk, problems: results.reduce((a, r) => a + r.problems.filter((p) => p.kind !== 'hardlink-warning').length, 0),
    gates, blockedBy: blocked, readyToUpload: false, // never true in 41D
    results,
  };
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// verify: detect missing / extra / truncated / corrupt parts. Resumable: hashes of unchanged (size+mtime) parts are reused.
function verify(m, partsDir, state) {
  const cache = (state && state.verified) || {};
  const have = new Set(fs.readdirSync(partsDir).filter((n) => n.endsWith('.tar')));
  const wanted = new Set(m.parts.map((p) => p.asset));
  const out = { schema: 1, mode: 'verify', parts: [], extra: [...have].filter((n) => !wanted.has(n)), missing: [], corrupt: [], duplicatesBySha: [] };
  const bySha = new Map();
  for (const p of m.parts) {
    if (!have.has(p.asset)) { out.missing.push(p.asset); out.parts.push({ asset: p.asset, status: 'missing' }); continue; }
    const full = path.join(partsDir, p.asset);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink() || !st.isFile()) { out.corrupt.push(p.asset); out.parts.push({ asset: p.asset, status: 'not-a-regular-file' }); continue; }
    if (st.size >= RELEASE_ASSET_LIMIT) { out.corrupt.push(p.asset); out.parts.push({ asset: p.asset, status: 'over-2GiB' }); continue; }
    if (st.size % TAR_BLOCK !== 0) { out.corrupt.push(p.asset); out.parts.push({ asset: p.asset, status: 'truncated-not-512-multiple', size: st.size }); continue; }
    const key = st.size + ':' + Math.floor(st.mtimeMs);
    const c = cache[p.asset];
    const sha = c && c.key === key ? c.sha256 : sha256File(full);
    cache[p.asset] = { key, sha256: sha };
    const dup = bySha.get(sha); if (dup) out.duplicatesBySha.push([dup, p.asset]); else bySha.set(sha, p.asset);
    let status = 'ok-unrecorded-sha';
    if (p.sha256) status = p.sha256 === sha ? 'ok' : 'checksum-mismatch';
    if (status === 'checksum-mismatch') out.corrupt.push(p.asset);
    out.parts.push({ asset: p.asset, status, size: st.size, sha256: sha });
  }
  out.ok = !out.missing.length && !out.corrupt.length && !out.extra.length && !out.duplicatesBySha.length;
  out.state = { schema: 1, verified: cache };
  return out;
}

// upload is intentionally a stub: two independent confirmations, and even then it only prints the plan.
function upload(opts, env) {
  const a = opts.confirmUpload === 'I-APPROVE-PRIVATE-UPLOAD';
  const b = env.LIVECITY_UPLOAD_APPROVED === 'yes-i-approved-this-exact-manifest-' + (opts.manifestSha || '');
  if (!a || !b) return { enabled: false, reason: 'upload is disabled: needs --confirm-upload I-APPROVE-PRIVATE-UPLOAD AND env LIVECITY_UPLOAD_APPROVED (second approval). Nothing was sent.' };
  return { enabled: false, reason: 'confirmations accepted, but the uploader is not implemented in 41D (no network code). Nothing was sent.' };
}

function writeNew(dir, name, obj) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 1), { flag: 'wx' });
}

function run(argv, env) {
  const cmd = argv[0];
  const a = {};
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--manifest') a.manifest = argv[++i];
    else if (k === '--roots-file') a.rootsFile = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--parts-dir') a.partsDir = argv[++i];
    else if (k === '--state') a.state = argv[++i];
    else if (k === '--dry-run') a.dry = true;
    else if (k === '--part-limit-gib') a.partLimitGiB = Number(argv[++i]);
    else if (k === '--min-free-gib') a.minFreeGiB = Number(argv[++i]);
    else if (k === '--only-category') a.onlyCategory = argv[++i].split(',').filter(Boolean);
    else if (k === '--path-contains') a.pathContains = argv[++i];
    else if (k === '--secrets-reviewed') a.secretsReviewed = true;
    else if (k === '--personal-reviewed') a.personalReviewed = true;
    else if (k === '--confirm-upload') a.confirmUpload = argv[++i];
    else throw new Error('unknown option: ' + k);
  }
  if (cmd === 'pack') {
    if (!a.manifest || !a.rootsFile || !a.out) throw new Error('usage: pack --manifest <manifest.json> --roots-file <roots.json> --out <new dir> [--dry-run]');
    if (a.dry === false) throw new Error('only --dry-run is supported in 41D');
    const m = loadManifest(a.manifest);
    let roots = JSON.parse(fs.readFileSync(a.rootsFile, 'utf8').replace(/^﻿/, ''));
    const outAbs = path.resolve(a.out);
    for (const [name, dir] of Object.entries(roots)) {
      const rd = path.resolve(dir);
      if (!fs.existsSync(rd) || !fs.statSync(rd).isDirectory()) throw new Error('root not found: ' + name);
      if ((outAbs + path.sep).startsWith(rd + path.sep)) throw new Error('--out must be outside every data root (' + name + ')');
      roots[name] = rd;
    }
    if (fs.existsSync(outAbs) && fs.readdirSync(outAbs).length) throw new Error('--out is not empty (will not overwrite)');
    fs.mkdirSync(outAbs, { recursive: true });
    const rep = dryRun(m, roots, { ...a, outDir: outAbs });
    writeNew(outAbs, 'pack-dry-run.json', rep);
    console.log(['pack --dry-run (offline, read-only)', 'parts: ' + rep.parts, 'tar estimate total: ' + (rep.totalTarEstimate / GIB).toFixed(2) + ' GiB, largest part: ' + (rep.largestPartEstimate / GIB).toFixed(2) + ' GiB (limit ' + (rep.partLimitBytes / GIB).toFixed(2) + ')',
      'free disk at out: ' + (rep.freeBytesAtOut === null ? 'unknown' : (rep.freeBytesAtOut / GIB).toFixed(1) + ' GiB') + ', staging ok: ' + rep.diskOk,
      'problems: ' + rep.problems, 'gates still closed: ' + (rep.blockedBy.join(',') || 'none'), 'readyToUpload: false'].join('\n'));
    return rep.problems === 0 ? 0 : 1;
  }
  if (cmd === 'verify') {
    if (!a.manifest || !a.partsDir) throw new Error('usage: verify --manifest <manifest.json> --parts-dir <dir> [--state state.json]');
    const m = loadManifest(a.manifest);
    const st = a.state && fs.existsSync(a.state) ? JSON.parse(fs.readFileSync(a.state, 'utf8')) : null;
    const rep = verify(m, path.resolve(a.partsDir), st);
    if (a.out) writeNew(path.resolve(a.out), 'verify.json', rep);
    console.log('verify: ok=' + rep.ok + ' missing=' + rep.missing.length + ' corrupt=' + rep.corrupt.length + ' extra=' + rep.extra.length);
    return rep.ok ? 0 : 1;
  }
  if (cmd === 'upload') {
    const sha = a.manifest && fs.existsSync(a.manifest) ? crypto.createHash('sha256').update(fs.readFileSync(a.manifest)).digest('hex') : '';
    const r = upload({ ...a, manifestSha: sha }, env || process.env);
    console.log(r.reason);
    return 2;
  }
  throw new Error('commands: pack | verify | upload(disabled)');
}

module.exports = { checkRel, tarEstimate, checkPart, dryRun, verify, upload, selectParts, run, GIB, RELEASE_ASSET_LIMIT };
if (require.main === module) { try { process.exit(run(process.argv.slice(2), process.env)); } catch (e) { console.error(e.message); process.exit(1); } }
