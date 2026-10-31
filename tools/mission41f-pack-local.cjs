'use strict';
// Mission 41F: OFFLINE local tar packaging for the 41B manifest.json (selected subset only).
// Reuses the 41D checks (checkRel / checkPart / selectParts / tarEstimate). No network code, no upload,
// never modifies, moves or deletes a source file, never overwrites an output file, never deletes anything:
// a failed partial archive is MOVED to <out>/quarantine/ for the owner to inspect.
//   node tools/mission41f-pack-local.cjs create --manifest m.json --roots-file roots.json --out <dir>
//        [--path-contains fukushima] [--only-category c1,c2] [--part-limit-gib 1.5] [--min-free-gib 2]
// The per-file name check below is a HINT only. It is NOT a secret scan and NOT permission to transfer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const d = require('./mission41d-pack.cjs');

const GIB = d.GIB;
const BLOCK = 512;
// Never packed by 41F, whatever the filter says (they stay on the deferred ledger).
const EXCLUDED_CATEGORIES = ['secrets-candidate', 'backup-archive'];
const SECRET_NAME_HINT = /(^|\/)\.env(\.|$)|\.(pem|key|pfx|p12|kdbx|ppk)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)|credential|secret|token|service[-_]?account|\.npmrc$|\.netrc$/i;

const sha8x = (root, rel) => crypto.createHash('sha256').update(root + ':' + rel).digest('hex').slice(0, 8); // same id as 41C/41J/41K
const sha8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

function octal(n, len) { return n.toString(8).padStart(len - 1, '0') + '\0'; }

// ustar name: whole name in 100 bytes, or split at '/' into prefix(<=155) + name(<=100).
function splitName(name) {
  const b = Buffer.from(name, 'utf8');
  if (b.length <= 100) return { name: b, prefix: Buffer.alloc(0) };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const pre = Buffer.from(name.slice(0, i), 'utf8'), nm = Buffer.from(name.slice(i + 1), 'utf8');
    if (pre.length <= 155 && nm.length <= 100 && nm.length > 0) return { name: nm, prefix: pre };
  }
  throw new Error('name cannot be represented in ustar');
}

function header(name, size, mtimeSec) {
  const h = Buffer.alloc(BLOCK);
  const { name: nm, prefix } = splitName(name);
  nm.copy(h, 0);
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(octal(size, 12), 124, 'latin1');
  h.write(octal(Math.max(0, mtimeSec), 12), 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write('0', 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  prefix.copy(h, 345);
  let sum = 0; for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}

function readExact(fd, buf, len, pos) {
  let got = 0;
  while (got < len) { const n = fs.readSync(fd, buf, got, len - got, pos + got); if (n <= 0) break; got += n; }
  return got;
}

function sha256Of(file) {
  const h = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); const buf = Buffer.allocUnsafe(4 << 20);
  try { let pos = 0, n; while ((n = readExact(fd, buf, buf.length, pos)) > 0) { h.update(buf.subarray(0, n)); pos += n; } } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function stamp(st) { return st.size + ':' + Math.floor(st.mtimeMs) + ':' + st.ino; }

// Directory components between root and file must be real directories (no symlink/junction), checked with lstat.
function dirSymlinkProblem(rootDir, rel, cache) {
  const segs = rel.split('/').slice(0, -1);
  let cur = rootDir;
  for (const s of segs) {
    cur = path.join(cur, s);
    if (cache.has(cur)) { if (cache.get(cur)) return true; continue; }
    let bad = false;
    try { const st = fs.lstatSync(cur); bad = st.isSymbolicLink() || !st.isDirectory(); } catch { bad = true; }
    cache.set(cur, bad);
    if (bad) return true;
  }
  return false;
}

// Select + filter. Returns { parts, excluded:{categories,nameHints}, problems }.
function selectForPack(m, opts) {
  let sel = d.selectParts(m, opts);
  const excluded = { categoryFiles: 0, nameHintFiles: 0, categories: [], planFiles: 0 };
  // 41N: ids from an owner-made exclusion plan (anonymous sha256(root:rel) first 8 hex). Nothing is deleted; the file is just not packed.
  if (opts.excludeIds && opts.excludeIds.size) {
    sel = sel.map((p) => {
      const keep = p.files.filter((f) => { const i = f.path.indexOf('/'); return !opts.excludeIds.has(sha8x(f.path.slice(0, i), f.path.slice(i + 1))); });
      excluded.planFiles += p.files.length - keep.length;
      return { ...p, files: keep, bytes: keep.reduce((a, f) => a + f.size, 0), fileCount: keep.length, subselection: p.subselection || keep.length !== p.files.length };
    }).filter((p) => p.files.length);
  }
  sel = sel.filter((p) => { if (EXCLUDED_CATEGORIES.includes(p.category)) { excluded.categoryFiles += p.files.length; excluded.categories.push(p.category); return false; } return true; });
  sel = sel.map((p) => {
    const keep = p.files.filter((f) => !SECRET_NAME_HINT.test(f.path));
    excluded.nameHintFiles += p.files.length - keep.length;
    return { ...p, files: keep, bytes: keep.reduce((a, f) => a + f.size, 0), fileCount: keep.length, subselection: p.subselection || keep.length !== p.files.length };
  }).filter((p) => p.files.length);
  return { parts: sel, excluded };
}

function assetName(part, subset) {
  const base = part.asset.replace(/\.tar$/, '');
  if (!subset && !part.subselection) return base + '.tar';
  const sig = sha8(part.files.map((f) => f.path + ':' + f.size).join('\n'));
  return base + '-subset-' + sig + '.tar';
}

// Independent tar reader: validates checksums/names, streams content hashes. Used for re-verification.
function readTar(file) {
  const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; const members = [];
  const hb = Buffer.alloc(BLOCK); const buf = Buffer.allocUnsafe(4 << 20);
  try {
    let pos = 0, zero = 0;
    while (pos + BLOCK <= size) {
      if (readExact(fd, hb, BLOCK, pos) !== BLOCK) throw new Error('short header');
      pos += BLOCK;
      if (hb.every((x) => x === 0)) { zero++; if (zero === 2) break; continue; }
      if (zero) throw new Error('data after first zero block');
      const stored = parseInt(hb.toString('latin1', 148, 154).replace(/\0/g, '').trim() || '0', 8);
      let sum = 0; for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 32 : hb[i];
      if (sum !== stored) throw new Error('header checksum mismatch');
      const cstr = (a, b) => { const s = hb.subarray(a, b); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString('utf8'); };
      const nm = cstr(0, 100), pre = cstr(345, 500);
      const full = pre ? pre + '/' + nm : nm;
      const type = String.fromCharCode(hb[156]);
      if (type !== '0') throw new Error('unexpected member type');
      const sz = parseInt(hb.toString('latin1', 124, 135).trim() || '0', 8);
      const h = crypto.createHash('sha256'); let left = sz, p = pos;
      while (left > 0) { const want = Math.min(left, buf.length); const n = readExact(fd, buf, want, p); if (n !== want) throw new Error('truncated member'); h.update(buf.subarray(0, n)); left -= n; p += n; }
      members.push({ name: full, size: sz, sha256: h.digest('hex') });
      const pad = (BLOCK - (sz % BLOCK)) % BLOCK;
      if (pad) { const pb = Buffer.alloc(pad); if (readExact(fd, pb, pad, p) !== pad || !pb.every((x) => x === 0)) throw new Error('non-zero or missing padding'); }
      pos += Math.ceil(sz / BLOCK) * BLOCK;
    }
    if (zero !== 2) throw new Error('missing end-of-archive blocks');
    const rest = size - pos; // only whole zero padding allowed after the two end blocks
    if (rest > 0) { const tail = Buffer.alloc(rest); readExact(fd, tail, rest, pos); if (!tail.every((x) => x === 0)) throw new Error('trailing data'); }
  } finally { fs.closeSync(fd); }
  return members;
}

function uniqueQuarantineName(dir, base) {
  let n = 0; let name;
  do { name = Date.now() + (n ? '-' + n : '') + '-' + base; n++; } while (fs.existsSync(path.join(dir, name)));
  return name;
}

function quarantine(outDir, file) {
  const qd = path.join(outDir, 'quarantine'); fs.mkdirSync(qd, { recursive: true });
  const to = path.join(qd, uniqueQuarantineName(qd, path.basename(file)));
  fs.renameSync(file, to);
  return path.basename(to);
}

// Error text without any path. fs errors carry the file path in e.message, so only the code is kept.
function explainErr(e) {
  const c = e && e.code;
  if (!c) return String((e && e.message) || e).replace(/[A-Za-z]:\\[^\s'"]*|\/[^\s'"]+\/[^\s'"]*/g, '<path>');
  const cloud = 'read error: a OneDrive cloud-only file is likely not downloaded (set "Always keep on this device")';
  const hint = { EIO: cloud + ' or the disk failed', UNKNOWN: cloud, EINVAL: cloud, EBUSY: 'file is locked by another program', EACCES: 'permission denied', EPERM: 'permission denied', ENOENT: 'file disappeared' }[c] || 'filesystem error';
  return 'source-read-failed (' + c + '): ' + hint + '; nothing was finalised, run stopped';
}

// Build one archive into <out>/.staging/<name>.partial, verify, then rename into place. Never overwrites.
function buildPart(part, name, roots, outDir, hooks) {
  const stage = path.join(outDir, '.staging'); fs.mkdirSync(stage, { recursive: true });
  const partial = path.join(stage, name + '.partial');
  let quarantinedOld = null;
  if (fs.existsSync(partial)) quarantinedOld = quarantine(outDir, partial); // leftover of an earlier failed run
  const srcOf = (f) => { const i = f.path.indexOf('/'); return path.join(roots[f.path.slice(0, i)], ...f.path.slice(i + 1).split('/')); };
  const before = new Map(); const hashes = new Map();
  let fd = null;
  try {
    for (const f of part.files) before.set(f.path, stamp(fs.lstatSync(srcOf(f))));
    fd = fs.openSync(partial, 'wx');
    const buf = Buffer.allocUnsafe(4 << 20);
    for (const f of part.files) {
      const src = srcOf(f); const st = fs.lstatSync(src);
      if (st.isSymbolicLink() || !st.isFile() || st.size !== f.size) throw new Error('source changed before read');
      fs.writeSync(fd, header(f.path, st.size, Math.floor(st.mtimeMs / 1000)));
      const sfd = fs.openSync(src, 'r'); const h = crypto.createHash('sha256'); let pos = 0;
      try { while (pos < st.size) { const want = Math.min(buf.length, st.size - pos); const n = readExact(sfd, buf, want, pos); if (n !== want) throw new Error('short read'); h.update(buf.subarray(0, n)); fs.writeSync(fd, buf, 0, n); pos += n; } } finally { fs.closeSync(sfd); }
      const pad = (BLOCK - (st.size % BLOCK)) % BLOCK; if (pad) fs.writeSync(fd, Buffer.alloc(pad));
      hashes.set(f.path, h.digest('hex'));
      if (hooks && hooks.afterFile) hooks.afterFile(f, src);
    }
    fs.writeSync(fd, Buffer.alloc(BLOCK * 2));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = null;

    // (1) sources unchanged during the run, and bytes still hash the same as what was written
    for (const f of part.files) {
      const src = srcOf(f);
      if (stamp(fs.lstatSync(src)) !== before.get(f.path)) throw new Error('source file changed during packing');
      if (sha256Of(src) !== hashes.get(f.path)) throw new Error('source content changed during packing');
    }
    // (2) tar content, independent reader: names, sizes, hashes, order
    const members = readTar(partial);
    if (members.length !== part.files.length) throw new Error('member count mismatch');
    members.forEach((mb, i) => {
      const f = part.files[i];
      if (d.checkRel(mb.name)) throw new Error('unsafe name in tar');
      if (mb.name !== f.path || mb.size !== f.size || mb.sha256 !== hashes.get(f.path)) throw new Error('tar member mismatch');
    });
    const tarSize = fs.statSync(partial).size;
    if (tarSize !== d.tarEstimate(part.files)) throw new Error('tar size differs from estimate');
    if (tarSize >= d.RELEASE_ASSET_LIMIT) throw new Error('tar over 2 GiB');
    const tarSha = sha256Of(partial);
    const final = path.join(outDir, name);
    if (fs.existsSync(final)) throw new Error('final file appeared meanwhile (not overwritten)');
    fs.renameSync(partial, final);
    return { name, files: part.files.length, bytes: tarSize, sha256: tarSha, quarantinedOld, state: 'created' };
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    let q = null; if (fs.existsSync(partial)) q = quarantine(outDir, partial);
    return { name, state: 'failed', error: explainErr(e), quarantined: q, quarantinedOld };
  }
}

// Re-verify an existing final archive against the current sources (resume / duplicate detection).
function verifyExisting(part, name, roots, outDir) {
  const final = path.join(outDir, name);
  try {
    const members = readTar(final);
    if (members.length !== part.files.length) return null;
    for (let i = 0; i < members.length; i++) {
      const f = part.files[i]; const mb = members[i];
      const k = f.path.indexOf('/'); const src = path.join(roots[f.path.slice(0, k)], ...f.path.slice(k + 1).split('/'));
      if (mb.name !== f.path || mb.size !== f.size || mb.sha256 !== sha256Of(src)) return null;
    }
    return { name, files: part.files.length, bytes: fs.statSync(final).size, sha256: sha256Of(final), state: 'already-packed-verified' };
  } catch { return null; }
}

function create(m, roots, opts, hooks) {
  const limitBytes = Math.floor((opts.partLimitGiB || 1.5) * GIB);
  if (limitBytes >= d.RELEASE_ASSET_LIMIT) throw new Error('part limit must be < 2 GiB');
  const { parts, excluded } = selectForPack(m, opts);
  const report = { schema: 1, mode: 'create', network: false, uploaded: false, selection: { pathContains: opts.pathContains || null, onlyCategory: opts.onlyCategory || null },
    excluded: { ...excluded, note: 'secrets-candidate and backup-archive are never packed; the file-name hint is NOT a secret scan' },
    gates: { licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false }, readyToUpload: false, parts: [], problems: [] };
  if (!parts.length) { report.problems.push({ kind: 'nothing-selected' }); return { code: 3, report }; }
  // 41G: a plan sized by raw bytes (pre-41G) can exceed the limit; refuse before touching anything.
  if (m.legacySizing) { report.problems.push({ kind: 'legacy-manifest-regenerate-plan' }); return { code: 1, report }; }

  // Preflight: 41D checks + intermediate-directory symlinks. Nothing is written when anything is wrong.
  const rootReal = new Map(); const dirCache = new Map();
  for (const p of parts) {
    const r = d.checkPart(p, roots, limitBytes, rootReal);
    r.problems.filter((x) => x.kind !== 'hardlink-warning').forEach((x) => report.problems.push({ part: sha8(p.asset), ...x }));
    for (const f of p.files) {
      const i = f.path.indexOf('/'); const rn = f.path.slice(0, i);
      if (roots[rn] && !d.checkRel(f.path) && dirSymlinkProblem(roots[rn], f.path.slice(i + 1), dirCache)) report.problems.push({ part: sha8(p.asset), id: sha8(f.path), kind: 'intermediate-dir-symlink-or-not-dir' });
    }
  }
  const total = parts.reduce((a, p) => a + d.tarEstimate(p.files), 0);
  let free = null;
  try { const s = fs.statfsSync(fs.existsSync(opts.outDir) ? opts.outDir : path.dirname(opts.outDir)); free = Number(s.bavail) * Number(s.bsize); } catch (e) { free = null; }
  report.totalTarEstimate = total; report.freeBytesAtOut = free;
  if (free !== null && free < total + (opts.minFreeGiB || 2) * GIB) report.problems.push({ kind: 'not-enough-disk', need: total + (opts.minFreeGiB || 2) * GIB, free });
  if (report.problems.length) return { code: 1, report };

  fs.mkdirSync(opts.outDir, { recursive: true });
  const names = new Set();
  for (const p of parts) {
    const name = assetName(p, false);
    if (names.has(name)) { report.problems.push({ kind: 'duplicate-asset-name' }); return { code: 1, report }; }
    names.add(name);
    const final = path.join(opts.outDir, name);
    let res;
    if (fs.existsSync(final)) {
      res = verifyExisting(p, name, roots, opts.outDir);
      if (!res) res = { name, state: 'failed', error: 'output exists but does not match the sources; it was NOT overwritten (choose a new --out)' };
    } else res = buildPart(p, name, roots, opts.outDir, hooks);
    report.parts.push(res);
    if (res.state === 'failed') { report.problems.push({ kind: 'part-failed', name, error: res.error }); break; }
  }
  const ok = !report.problems.length;
  let rn = 'pack-report.json'; let k = 1; while (fs.existsSync(path.join(opts.outDir, rn))) rn = 'pack-report-' + (k++) + '.json';
  fs.writeFileSync(path.join(opts.outDir, rn), JSON.stringify(report, null, 1), { flag: 'wx' });
  return { code: ok ? 0 : 1, report, reportFile: rn };
}

// Re-check finished archives against the newest pack-report: presence, byte count, SHA-256, tar structure.
// Needs only the output folder (no source data). Prints counts and hashes only, no paths.
function verifyOut(outDir) {
  const num = (n) => parseInt((n.match(/-(\d+)\.json$/) || [0, 0])[1], 10);
  const reps = fs.readdirSync(outDir).filter((n) => /^pack-report(-\d+)?\.json$/.test(n)).sort((a, b) => num(a) - num(b));
  if (!reps.length) throw new Error('no pack-report*.json in --out');
  const rep = JSON.parse(fs.readFileSync(path.join(outDir, reps[reps.length - 1]), 'utf8'));
  const rows = []; let ok = true;
  for (const p of rep.parts || []) {
    if (p.state !== 'created' && p.state !== 'already-packed-verified') continue;
    const row = { files: p.files, bytes: p.bytes, sha256: p.sha256 };
    try {
      const file = path.join(outDir, p.name);
      row.bytesOk = fs.statSync(file).size === p.bytes;
      row.shaOk = sha256Of(file) === p.sha256;
      row.membersOk = readTar(file).length === p.files;
    } catch (e) { row.bytesOk = row.shaOk = row.membersOk = false; row.error = explainErr(e); }
    row.ok = !!(row.bytesOk && row.shaOk && row.membersOk); if (!row.ok) ok = false; rows.push(row);
  }
  if (!rows.length) ok = false;
  return { ok, tars: rows };
}
function summaryLines(rep) {
  const done = rep.parts.filter((p) => p.state === 'created' || p.state === 'already-packed-verified');
  return ['SUMMARY (anonymous): tar files=' + done.length + ' source files=' + done.reduce((a, p) => a + (p.files || 0), 0) + ' tar bytes=' + done.reduce((a, p) => a + (p.bytes || 0), 0),
    ...done.map((p, i) => '  tar' + (i + 1) + ' files=' + p.files + ' bytes=' + p.bytes + ' sha256=' + p.sha256)];
}

function run(argv) {
  if (argv[0] === 'verify') {
    const i = argv.indexOf('--out'); if (i < 0 || !argv[i + 1]) throw new Error('usage: verify --out <dir>');
    const r = verifyOut(path.resolve(argv[i + 1]));
    console.log(['SHA256 verification of finished archives (offline, no source data needed)',
      ...r.tars.map((t, k) => '  tar' + (k + 1) + ' files=' + t.files + ' bytes=' + t.bytes + ' sha256=' + t.sha256 + ' -> ' + (t.ok ? 'OK' : 'FAILED ' + (t.error || ''))),
      'result: ' + (r.ok ? 'ALL VERIFIED' : 'PROBLEM'), 'gates still closed: licenceApproved,noSecretsReviewed,noPersonalDataReviewed; readyToUpload: false'].join('\n'));
    return r.ok ? 0 : 1;
  }
  if (argv[0] !== 'create') throw new Error('usage: create --manifest <manifest.json> --roots-file <roots.json> --out <dir> [--path-contains x] [--only-category a,b]');
  const a = {};
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--manifest') a.manifest = argv[++i]; else if (k === '--roots-file') a.rootsFile = argv[++i]; else if (k === '--out') a.out = argv[++i];
    else if (k === '--path-contains') a.pathContains = argv[++i]; else if (k === '--only-category') a.onlyCategory = argv[++i].split(',').filter(Boolean);
    else if (k === '--exclude-plan') a.excludePlan = argv[++i]; else if (k === '--part-limit-gib') a.partLimitGiB = Number(argv[++i]); else if (k === '--min-free-gib') a.minFreeGiB = Number(argv[++i]);
    else throw new Error('unknown option: ' + k);
  }
  if (!a.manifest || !a.rootsFile || !a.out) throw new Error('--manifest, --roots-file and --out are required');
  const m = JSON.parse(fs.readFileSync(a.manifest, 'utf8'));
  if (!m || !Array.isArray(m.parts)) throw new Error('not a 41B manifest.json');
  m.legacySizing = m.schema !== 2 || m.sizing !== 'tar-estimate';
  const roots = JSON.parse(fs.readFileSync(a.rootsFile, 'utf8').replace(/^﻿/, ''));
  const outAbs = path.resolve(a.out);
  for (const [name, dir] of Object.entries(roots)) {
    const rd = path.resolve(dir);
    if (!fs.existsSync(rd) || !fs.statSync(rd).isDirectory()) throw new Error('root not found: ' + name);
    if (d.isUnder(outAbs, rd, process.platform)) throw new Error('--out must be outside every data root (' + name + ')');
    roots[name] = rd;
  }
  if (a.excludePlan) {
    const pl = JSON.parse(fs.readFileSync(a.excludePlan, 'utf8').replace(/^﻿/, ''));
    if (!pl || pl.tool !== 'mission41n-exclude' || !Array.isArray(pl.excludeIds) || !pl.excludeIds.every((x) => /^[0-9a-f]{8}$/.test(x))) throw new Error('not a 41N exclusion plan');
    a.excludeIds = new Set(pl.excludeIds);
  }
  const { parts } = selectForPack(m, a);
  const pre = d.rootPreflight(parts, roots); if (pre) throw new Error(pre);
  // resume is allowed only into a folder that 41F created before (it holds pack-report*.json) or an empty one
  if (fs.existsSync(outAbs)) {
    const ents = fs.readdirSync(outAbs);
    if (ents.length && !ents.some((n) => /^pack-report(-\d+)?\.json$/.test(n))) throw new Error('--out is not empty and is not a 41F output folder (will not overwrite)');
  }
  const r = create(m, roots, { ...a, outDir: outAbs });
  const rep = r.report;
  console.log(['pack create (offline, local tar only; NOTHING uploaded, no network)',
    'selected parts: ' + (rep.parts.length || 0) + ' created/checked; excluded by category: ' + rep.excluded.categoryFiles + ' files, by name hint: ' + rep.excluded.nameHintFiles + ' files (hint only, NOT a secret scan); by exclusion plan: ' + (rep.excluded.planFiles || 0) + ' files',
    ...rep.parts.map((p) => '  ' + p.state + ': files=' + (p.files || '-') + ' bytes=' + (p.bytes || '-') + (p.error ? ' error=' + p.error : '')),
    ...summaryLines(rep),
    'problems: ' + rep.problems.length + (rep.problems.length ? ' ' + JSON.stringify(rep.problems.slice(0, 5)) : ''),
    'gates still closed: licenceApproved,noSecretsReviewed,noPersonalDataReviewed; readyToUpload: false'].join('\n'));
  return r.code;
}

module.exports = { header, readTar, splitName, selectForPack, assetName, create, buildPart, verifyExisting, run, verifyOut, summaryLines, explainErr, SECRET_NAME_HINT, EXCLUDED_CATEGORIES };
if (require.main === module) { try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); } }
