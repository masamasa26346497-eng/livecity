'use strict';
// Mission 41C: staged, resumable sha256 of ONLY the duplicate candidates >= --min-mb (default 50).
// Input: 41A inventory.json (size-match duplicate groups) + the same --roots used for 41A (read-only).
// Stage 1: cheap fingerprint (size + first/last 1 MiB) removes most non-duplicates without reading whole files.
// Stage 2: full sha256 only for groups whose fingerprints still match.
// Output: one JSON cache (--cache, created/updated; it is OUR file, never inside a root). Feed it to
//   node tools/mission41b-plan.cjs quick|plan --inventory <inventory.json> --hashes <cache>
// No network. Source files are opened read-only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MB = 1024 * 1024;

function fingerprint(file, size) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const n = Math.min(MB, size);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0); h.update(buf);
    if (size > n) { fs.readSync(fd, buf, 0, n, size - n); h.update(buf); }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function fullSha(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4 * MB);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function candidateGroups(inv, minBytes) {
  return (inv.duplicates || []).filter((d) => !d.confirmed && d.size >= minBytes && d.files.length > 1);
}

// resolve "rootName:rel" to an absolute path using the roots given on the command line
function resolver(roots) {
  const byName = new Map();
  for (const r of roots) byName.set(path.basename(r), r);
  return (key) => {
    const i = key.indexOf(':');
    const root = byName.get(key.slice(0, i));
    return root ? path.join(root, ...key.slice(i + 1).split('/')) : null;
  };
}

function hashCandidates(inv, roots, opts) {
  const minBytes = (opts.minMB || 50) * MB;
  const budget = opts.maxGB ? opts.maxGB * 1024 * MB : Infinity;
  const cache = opts.cache || { schema: 1, fingerprints: {}, files: {} };
  const resolve = resolver(roots);
  let readBytes = 0;
  const stats = { groups: 0, fingerprinted: 0, fullHashed: 0, skippedByBudget: 0, missing: 0 };
  const log = opts.log || (() => {});
  for (const d of candidateGroups(inv, minBytes)) {
    stats.groups++;
    const fp = new Map();
    for (const k of d.files) {
      const p = resolve(k);
      if (!p || !fs.existsSync(p)) { stats.missing++; continue; }
      if (!cache.fingerprints[k]) { cache.fingerprints[k] = fingerprint(p, d.size); stats.fingerprinted++; readBytes += Math.min(2 * MB, d.size); }
      const a = fp.get(cache.fingerprints[k]) || []; a.push(k); fp.set(cache.fingerprints[k], a);
    }
    for (const g of fp.values()) {
      if (g.length < 2) continue; // fingerprint differs from everything else: proven not a duplicate
      for (const k of g) {
        if (cache.files[k]) continue;
        if (readBytes + d.size > budget) { stats.skippedByBudget++; continue; }
        cache.files[k] = fullSha(resolve(k)); stats.fullHashed++; readBytes += d.size;
        log('hashed ' + stats.fullHashed + ' (' + (readBytes / (1024 * MB)).toFixed(1) + ' GiB read)');
        if (opts.save) opts.save(cache); // resumable after every big file
      }
    }
    // fingerprint-unique files cannot be duplicates: mark them with their (unique) fingerprint-based id so
    // applyHashes can treat the whole group as "all hashed" and remove false size-matches.
    for (const g of fp.values()) if (g.length === 1) cache.files[g[0]] = cache.files[g[0]] || 'fp:' + cache.fingerprints[g[0]];
  }
  if (opts.save) opts.save(cache);
  return { cache, stats, readBytes };
}

function run(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--inventory') a.inventory = argv[++i];
    else if (argv[i] === '--roots') a.roots = argv[++i].split(';').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--cache') a.cache = argv[++i];
    else if (argv[i] === '--min-mb') a.minMB = Number(argv[++i]);
    else if (argv[i] === '--max-gb') a.maxGB = Number(argv[++i]);
  }
  if (!a.inventory || !a.roots || !a.cache) throw new Error('usage: --inventory <inventory.json> --roots "dirA;dirB" --cache <new-or-existing hashes.json> [--min-mb 50] [--max-gb N]');
  const roots = a.roots.map((r) => path.resolve(r));
  const cachePath = path.resolve(a.cache);
  for (const r of roots) {
    const rel = path.relative(r, cachePath);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('--cache must be outside every scanned root');
  }
  const inv = JSON.parse(fs.readFileSync(a.inventory, 'utf8'));
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : undefined;
  const save = (c) => fs.writeFileSync(cachePath, JSON.stringify(c));
  const r = hashCandidates(inv, roots, { minMB: a.minMB, maxGB: a.maxGB, cache, save, log: (m) => console.log(m) });
  console.log(JSON.stringify({ ...r.stats, readGiB: +(r.readBytes / (1024 * MB)).toFixed(2), cache: 'saved' }));
}

module.exports = { fingerprint, fullSha, candidateGroups, hashCandidates, run };
if (require.main === module) {
  try { run(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}
