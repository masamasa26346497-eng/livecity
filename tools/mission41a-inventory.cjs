'use strict';
// Mission 41A: read-only inventory of local Live City data + private-repo upload plan.
// Never modifies, deletes, copies or uploads anything under --roots. No network.
// Writes only NEW files into --out (refuses if --out is non-empty or inside a root).
// Secret hits record file/line/type only; matched values are never stored or printed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const LIMITS = { hardFile: 100 * MB, warnFile: 50 * MB, partTarget: 900 * MB, lfsFree: 1 * GB };
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '__pycache__', '.vercel', '.next']);
const TEXT_EXT = new Set(['.json', '.js', '.cjs', '.mjs', '.ts', '.html', '.md', '.txt', '.ps1', '.env', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.csv', '.geojson', '.jsonl']);
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.heic']);
const SECRET_NAME = [/(^|[\\/])\.env(\.|$)/i, /\.(pem|key|pfx|p12|keystore)$/i, /(^|[\\/])id_(rsa|ed25519|ecdsa)$/i, /credentials?(\.|$)/i, /secrets?(\.|$)/i, /(^|[\\/])\.npmrc$/i];
const SECRET_CONTENT = [
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['anthropic-or-openai-key', /sk-[A-Za-z0-9_-]{32,}/],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer-token', /[Bb]earer\s+[A-Za-z0-9._-]{30,}/],
  ['email-address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];

// Category rules, first match wins. "publish" = may later be served publicly; "private" = private data repo only.
const CATS = [
  ['node-modules-cache', /(^|\/)(node_modules|\.cache|_cache|cache)(\/|$)/i, 'exclude'],
  ['secrets-candidate', null, 'exclude'],
  ['photos-unverified-rights', null, 'exclude-until-license-ledger'],
  ['3dtiles-output', /(^|\/)(3dtiles|mission\d+\w*-3dtiles|livecity-3dtiles-out[^/]*)(\/|$)|\.glb$|tileset\.json$/i, 'private-data-repo'],
  ['plateau-raw', /(plateau|citygml|\.gml$|\.zip$)/i, 'private-data-repo'],
  ['building-tiles', /(^|\/)buildings(\/|$)/i, 'private-data-repo'],
  ['osm-layers', /(^|\/)(roads|waterways|parks|railways|osm)(\/|$)/i, 'private-data-repo'],
  ['boundaries', /(boundar|n03|admin|ward|shp$|\.shp|\.dbf$)/i, 'private-data-repo'],
  ['demographics', /(demograph|census|estat|e-stat|population|town-stats)/i, 'private-data-repo'],
  ['facilities', /(facilit|poi|places)/i, 'private-data-repo'],
  ['photo-index', /(photo-index|photo-dates|photo-review|verified-place)/i, 'private-data-repo'],
  ['code-and-docs', /\.(js|cjs|mjs|ps1|md|html)$/i, 'already-in-git-or-skip'],
];

function norm(p) { return p.split(path.sep).join('/'); }
function fmt(n) { return n >= GB ? (n / GB).toFixed(2) + ' GB' : (n / MB).toFixed(1) + ' MB'; }

function classify(rel, ext, secretByName) {
  if (secretByName) return CATS[1];
  if (IMG_EXT.has(ext)) return CATS[2];
  for (const c of CATS) if (c[1] && c[1].test(rel)) return c;
  return ['other', null, 'review'];
}

function scanSecrets(file) {
  const hits = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return hits; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.length > 20000) continue;
    for (const [type, re] of SECRET_CONTENT) if (re.test(ln)) hits.push({ line: i + 1, type });
    if (hits.length >= 20) break;
  }
  return hits;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4 * MB);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function inventory(roots, opts) {
  const files = [];
  const skipped = { symlinks: 0, unreadable: 0, excludedDirs: [] };
  const cats = {};
  const walk = (dir, root, excluded) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { skipped.unreadable++; return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) { skipped.symlinks++; continue; }
      if (e.isDirectory()) {
        const ex = excluded || SKIP_DIRS.has(e.name);
        if (ex && !excluded) skipped.excludedDirs.push(norm(path.relative(root, full)));
        walk(full, root, ex);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(full); } catch (x) { skipped.unreadable++; continue; }
      const rel = norm(path.relative(root, full));
      const ext = path.extname(e.name).toLowerCase();
      if (excluded) {
        const c = (cats['node-modules-cache'] = cats['node-modules-cache'] || { files: 0, bytes: 0 });
        c.files++; c.bytes += st.size;
        continue;
      }
      const secretByName = SECRET_NAME.some((re) => re.test(rel));
      const cat = classify(rel, ext, secretByName);
      let secrets = [];
      if (!secretByName && TEXT_EXT.has(ext) && st.size <= 2 * MB) secrets = scanSecrets(full);
      const finalCat = secrets.some((s) => s.type !== 'email-address') ? CATS[1] : cat;
      files.push({ root: path.basename(root), rel, size: st.size, ext, category: finalCat[0], decision: finalCat[2], full, secrets, secretByName });
      const c = (cats[finalCat[0]] = cats[finalCat[0]] || { files: 0, bytes: 0 });
      c.files++; c.bytes += st.size;
    }
  };
  for (const r of roots) walk(r, r, false);

  // duplicates: size groups (>=1MB) always; sha256 only when opts.hash
  const bySize = new Map();
  for (const f of files) if (f.size >= MB) { const a = bySize.get(f.size) || []; a.push(f); bySize.set(f.size, a); }
  const dupCandidates = [];
  for (const [size, arr] of bySize) {
    if (arr.length < 2) continue;
    if (opts.hash) {
      const byHash = new Map();
      for (const f of arr) { const h = sha256(f.full); const a = byHash.get(h) || []; a.push(f); byHash.set(h, a); }
      for (const [h, g] of byHash) if (g.length > 1) dupCandidates.push({ size, sha256: h, confirmed: true, files: g.map((x) => x.root + ':' + x.rel) });
    } else {
      dupCandidates.push({ size, confirmed: false, files: arr.map((x) => x.root + ':' + x.rel) });
    }
  }
  return { files, cats, skipped, dupCandidates };
}

function plan(files) {
  const eligible = files.filter((f) => f.decision === 'private-data-repo' || f.decision === 'review');
  const oversize = eligible.filter((f) => f.size > LIMITS.hardFile);
  const warn = eligible.filter((f) => f.size > LIMITS.warnFile && f.size <= LIMITS.hardFile);
  const oversizeBytes = oversize.reduce((a, f) => a + f.size, 0);
  const total = eligible.reduce((a, f) => a + f.size, 0);
  let bigFileStrategy = 'none-needed';
  if (oversize.length) bigFileStrategy = oversizeBytes <= LIMITS.lfsFree ? 'git-lfs (fits 1 GiB free quota; verify quota first)' : 'split-archive (parts < 95 MB) or release assets; LFS quota would be exceeded';
  // greedy pack by top-level group so related files stay together
  const groups = new Map();
  for (const f of eligible) {
    const key = f.category + '/' + f.root + '/' + f.rel.split('/').slice(0, 2).join('/');
    const g = groups.get(key) || { key, bytes: 0, files: 0 };
    g.bytes += f.size; g.files++; groups.set(key, g);
  }
  const parts = [];
  let cur = null;
  for (const g of [...groups.values()].sort((a, b) => b.bytes - a.bytes)) {
    if (!cur || cur.bytes + g.bytes > LIMITS.partTarget) { cur = { name: 'livecity-data-part-' + String(parts.length + 1).padStart(2, '0'), bytes: 0, files: 0, groups: [] }; parts.push(cur); }
    cur.bytes += g.bytes; cur.files += g.files; cur.groups.push(g.key);
  }
  return {
    visibility: 'PRIVATE repositories only. Keep separate from the public Vercel repo; never put these under public/.',
    thresholds: { hardFileBytes: LIMITS.hardFile, warnFileBytes: LIMITS.warnFile, partTargetBytes: LIMITS.partTarget },
    eligibleBytes: total, eligibleFiles: eligible.length,
    filesOver100MB: oversize.map((f) => ({ path: f.root + ':' + f.rel, size: f.size })),
    filesOver50MB: warn.map((f) => ({ path: f.root + ':' + f.rel, size: f.size })),
    bigFileStrategy,
    singleRepoOk: total <= 1 * GB && !oversize.length,
    parts,
    notes: [
      'Recommended repo size is under 1 GB (hard cap 5 GB soft); parts above target 900 MB each.',
      'Exclusions (not uploaded): secrets-candidate, photos-unverified-rights, node-modules-cache. Resolve each before inclusion.',
      'Source attribution and licence must be recorded per dataset before any public serving (PLATEAU, OSM ODbL, N03, e-Stat, Wikimedia).',
      'This is a plan only. No upload is performed by this tool.',
    ],
  };
}

function report(inv, pl, meta) {
  const L = [];
  L.push('# Live City local data inventory (Mission 41A)', '', 'Generated: ' + meta.at, 'Roots: ' + meta.roots.join(', '), 'Hashing: ' + (meta.hash ? 'sha256 (duplicates confirmed)' : 'off (duplicates are size-match candidates only)'), '');
  L.push('## Totals', '', '| category | files | size | decision |', '|---|---|---|---|');
  const decisionOf = {};
  for (const c of CATS) decisionOf[c[0]] = c[2];
  for (const [k, v] of Object.entries(inv.cats).sort((a, b) => b[1].bytes - a[1].bytes)) L.push('| ' + k + ' | ' + v.files + ' | ' + fmt(v.bytes) + ' | ' + (decisionOf[k] || 'review') + ' |');
  L.push('', '## GitHub limits', '', '- Files over 100 MB (blocked): ' + pl.filesOver100MB.length, '- Files 50-100 MB (warning): ' + pl.filesOver50MB.length, '- Strategy for big files: ' + pl.bigFileStrategy, '- Single repo OK: ' + pl.singleRepoOk, '- Eligible total: ' + fmt(pl.eligibleBytes) + ' in ' + pl.eligibleFiles + ' files', '');
  for (const f of pl.filesOver100MB.slice(0, 50)) L.push('  - ' + f.path + ' (' + fmt(f.size) + ')');
  const sec = inv.files.filter((f) => f.secretByName || f.secrets.length);
  L.push('', '## Secret / personal-data candidates (values are never recorded)', '', 'Files: ' + sec.length, '');
  for (const f of sec.slice(0, 100)) L.push('- ' + f.root + ':' + f.rel + ' -> ' + (f.secretByName ? 'filename pattern' : [...new Set(f.secrets.map((s) => s.type + '@' + s.line))].join(', ')));
  L.push('', '## Duplicates', '', 'Groups: ' + inv.dupCandidates.length + (meta.hash ? '' : ' (size-match only; rerun with -Hash to confirm)'), '');
  L.push('## Skipped', '', '- symlinks: ' + inv.skipped.symlinks, '- unreadable: ' + inv.skipped.unreadable, '- excluded dirs: ' + inv.skipped.excludedDirs.length, '');
  L.push('## Upload plan (private repos, plan only)', '', pl.visibility, '');
  for (const p of pl.parts) L.push('- ' + p.name + ': ' + fmt(p.bytes) + ', ' + p.files + ' files, ' + p.groups.length + ' groups');
  L.push('', ...pl.notes.map((n) => '- ' + n), '');
  return L.join('\n');
}

function isInside(child, parent) {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

function run(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--roots') a.roots = argv[++i].split(';').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--hash') a.hash = true;
  }
  if (!a.roots || !a.roots.length || !a.out) throw new Error('usage: --roots "dirA;dirB" --out <new dir> [--hash]');
  const roots = a.roots.map((r) => path.resolve(r));
  for (const r of roots) if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) throw new Error('root not found: ' + r);
  const out = path.resolve(a.out);
  for (const r of roots) if (isInside(out, r)) throw new Error('--out must not be inside a root (source is read-only): ' + out);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('--out is not empty (will not overwrite): ' + out);
  const inv = inventory(roots, { hash: !!a.hash });
  const pl = plan(inv.files);
  const meta = { at: new Date().toISOString(), roots, hash: !!a.hash };
  fs.mkdirSync(out, { recursive: true });
  const slim = inv.files.map(({ full, ...rest }) => rest);
  fs.writeFileSync(path.join(out, 'inventory.json'), JSON.stringify({ meta, categories: inv.cats, skipped: inv.skipped, duplicates: inv.dupCandidates, files: slim }, null, 1), { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'upload-plan.json'), JSON.stringify(pl, null, 1), { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'report.md'), report(inv, pl, meta), { flag: 'wx' });
  console.log(JSON.stringify({ out, files: inv.files.length, over100MB: pl.filesOver100MB.length, secretCandidates: slim.filter((f) => f.secretByName || f.secrets.length).length, eligible: fmt(pl.eligibleBytes), parts: pl.parts.length, strategy: pl.bigFileStrategy }));
}

module.exports = { inventory, plan, report, classify, scanSecrets, run, LIMITS };
if (require.main === module) {
  try { run(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}
