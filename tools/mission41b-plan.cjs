'use strict';
// Mission 41B: offline planner for moving local Live City data into a PRIVATE data repo
// (light Git: provenance ledger + manifests; heavy data: private GitHub Release assets).
// Reads only a 41A inventory.json. No network, no upload, never touches source data.
// Output never contains absolute paths or secret values (41A records neither).
//   node tools/mission41b-plan.cjs summary --inventory <inventory.json> [--top 15]
//   node tools/mission41b-plan.cjs plan --inventory <inventory.json> --out <new dir> [--max-part-gib 1.5] [--approved cat1,cat2]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const GIB_RELEASE_ASSET_LIMIT = 2 * GB; // GitHub: release asset must be < 2 GiB
const DEFAULT_PART_GIB = 1.5;
const MAX_ASSETS_PER_RELEASE = 1000; // GitHub limit per release; we stay far below
const ASSETS_PER_RELEASE_TARGET = 50;

// Categories never planned for upload until a human clears them (41A decisions + rights-unknown raw data).
const HOLD = {
  'secrets-candidate': 'possible secret/personal data; review each file, never upload as-is',
  'photos-unverified-rights': 'photo rights unknown; needs per-file licence ledger',
  'plateau-raw': 'raw PLATEAU/CityGML/zip: terms not yet confirmed and re-downloadable from the source',
  'node-modules-cache': 'regenerable cache',
  other: 'unclassified; review before inclusion',
};
const NEEDS_LICENCE_NOTE = {
  'osm-layers': 'OSM (ODbL): attribution + share-alike on derived DB',
  'building-tiles': 'derived from PLATEAU: confirm terms before any public serving',
  '3dtiles-output': 'derived from PLATEAU: confirm terms before any public serving',
  boundaries: 'N03 / e-Stat boundaries: record source + licence',
  demographics: 'e-Stat: record source + licence',
  facilities: 'OSM (ODbL)',
  'photo-index': 'Wikimedia Commons metadata: keep author/licence fields',
};

function fmt(n) { return n >= GB ? (n / GB).toFixed(2) + ' GB' : (n / MB).toFixed(1) + ' MB'; }
function short(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8); }

function loadInventory(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!j || !Array.isArray(j.files)) throw new Error('not a 41A inventory.json');
  return j;
}

// ---- (2) anonymous aggregate: no paths, no secret values ----
function summarize(inv, top) {
  const byCat = {};
  const bySecretType = {};
  const decisions = {};
  for (const f of inv.files) {
    const c = (byCat[f.category] = byCat[f.category] || { files: 0, bytes: 0, over100MB: 0 });
    c.files++; c.bytes += f.size; if (f.size > 100 * MB) c.over100MB++;
    const d = (decisions[f.decision] = decisions[f.decision] || { files: 0, bytes: 0 });
    d.files++; d.bytes += f.size;
    if (f.secretByName) bySecretType['filename-pattern'] = (bySecretType['filename-pattern'] || 0) + 1;
    for (const t of new Set((f.secrets || []).map((s) => s.type))) bySecretType[t] = (bySecretType[t] || 0) + 1;
  }
  const largest = [...inv.files].sort((a, b) => b.size - a.size).slice(0, top).map((f) => ({
    id: short(f.root + ':' + f.rel), category: f.category, ext: f.ext || '(none)', bytes: f.size, size: fmt(f.size),
  }));
  const secretFiles = inv.files.filter((f) => f.secretByName || (f.secrets || []).length);
  return {
    totalFiles: inv.files.length,
    totalBytes: inv.files.reduce((a, f) => a + f.size, 0),
    categories: Object.fromEntries(Object.entries(byCat).sort((a, b) => b[1].bytes - a[1].bytes).map(([k, v]) => [k, { ...v, size: fmt(v.bytes) }])),
    decisions,
    exclusionCandidates: {
      secretFiles: secretFiles.length,
      byType: bySecretType,
      secretFilesByCategoryAndExt: Object.entries(secretFiles.reduce((m, f) => { const k = f.category + ' ' + (f.ext || '(none)'); m[k] = (m[k] || 0) + 1; return m; }, {})).map(([k, n]) => ({ kind: k, files: n })),
    },
    duplicatesGroups: (inv.duplicates || []).length,
    confirmedDuplicateGroups: (inv.duplicates || []).filter((d) => d.confirmed).length,
    largest,
    note: 'Anonymous: ids are short hashes of path, no names or absolute paths.',
  };
}

// ---- (1)/(3) packing with a hard per-part limit ----
// Group key depth grows until each group fits, then groups are bin-packed (first-fit decreasing).
// A single file larger than the limit cannot be packed in one asset: it is reported as `unsplittable`
// (needs byte-level chunking, flagged, never silently placed).
function pack(files, limitBytes) {
  const unsplittable = [];
  const fitting = [];
  for (const f of files) (f.size > limitBytes ? unsplittable : fitting).push(f);

  const units = [];
  const split = (items, depth, prefix) => {
    const total = items.reduce((a, f) => a + f.size, 0);
    if (total <= limitBytes) { units.push({ key: prefix, bytes: total, files: items }); return; }
    const groups = new Map();
    for (const f of items) {
      const segs = f.rel.split('/');
      const k = segs.length > depth ? segs.slice(0, depth).join('/') : f.rel;
      const g = groups.get(k) || []; g.push(f); groups.set(k, g);
    }
    if (groups.size === 1 && items.some((f) => f.rel.split('/').length > depth)) { split(items, depth + 1, prefix); return; }
    if (groups.size === 1) {
      // path depth exhausted: chunk by file order
      let cur = { key: prefix + '#chunk', bytes: 0, files: [] };
      for (const f of items.sort((a, b) => a.rel < b.rel ? -1 : 1)) {
        if (cur.bytes + f.size > limitBytes && cur.files.length) { units.push(cur); cur = { key: prefix + '#chunk', bytes: 0, files: [] }; }
        cur.bytes += f.size; cur.files.push(f);
      }
      if (cur.files.length) units.push(cur);
      return;
    }
    for (const [k, g] of groups) split(g, depth + 1, k);
  };
  const byLayer = new Map();
  for (const f of fitting) { const k = f.category + '/' + f.root; const a = byLayer.get(k) || []; a.push(f); byLayer.set(k, a); }
  for (const [k, items] of byLayer) split(items, 1, k);

  const parts = [];
  for (const u of units.sort((a, b) => b.bytes - a.bytes)) {
    // never mix categories in one part (keeps licence handling per-asset)
    const cat = u.files[0].category;
    let p = parts.find((x) => x.category === cat && x.bytes + u.bytes <= limitBytes);
    if (!p) { p = { category: cat, bytes: 0, files: [], groups: [] }; parts.push(p); }
    p.bytes += u.bytes; p.files.push(...u.files); p.groups.push(u.key);
  }
  parts.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : b.bytes - a.bytes));
  parts.forEach((p, i) => { p.name = 'lcdata-' + p.category + '-' + String(i + 1).padStart(3, '0'); });
  return { parts, unsplittable };
}

function buildPlan(inv, opts) {
  const limitBytes = Math.floor((opts.maxPartGiB || DEFAULT_PART_GIB) * GB);
  if (limitBytes >= GIB_RELEASE_ASSET_LIMIT) throw new Error('part limit must be < 2 GiB (release asset limit)');
  const approved = new Set(opts.approved || []);
  const held = {};
  const candidates = [];
  const droppedDup = { files: 0, bytes: 0 };

  // dedup: only sha256-confirmed groups (41A --hash); keep first, drop the rest
  const dropKeys = new Set();
  for (const d of inv.duplicates || []) if (d.confirmed) for (const k of d.files.slice(1)) dropKeys.add(k);

  for (const f of inv.files) {
    if (HOLD[f.category] || f.decision === 'exclude' || f.decision === 'exclude-until-license-ledger' || (f.secretByName || (f.secrets || []).some((s) => s.type !== 'email-address'))) {
      const h = (held[f.category] = held[f.category] || { files: 0, bytes: 0, reason: HOLD[f.category] || f.decision });
      h.files++; h.bytes += f.size; continue;
    }
    if (f.decision === 'already-in-git-or-skip') { const h = (held['code-and-docs'] = held['code-and-docs'] || { files: 0, bytes: 0, reason: 'already in Git; not data' }); h.files++; h.bytes += f.size; continue; }
    if (dropKeys.has(f.root + ':' + f.rel)) { droppedDup.files++; droppedDup.bytes += f.size; continue; }
    candidates.push(f);
  }
  const { parts, unsplittable } = pack(candidates, limitBytes);
  parts.forEach((p, i) => {
    p.release = 'data-r' + String(Math.floor(i / ASSETS_PER_RELEASE_TARGET) + 1).padStart(2, '0');
    p.asset = p.name + '.tar';
    p.approved = approved.has(p.category);
    p.licenceNote = NEEDS_LICENCE_NOTE[p.category] || 'record source + licence';
  });
  const totalBytes = candidates.reduce((a, f) => a + f.size, 0);
  const overLimit = parts.filter((p) => p.bytes > limitBytes);
  const releases = [...new Set(parts.map((p) => p.release))];
  const validation = {
    limitBytes, maxPartBytes: parts.reduce((m, p) => Math.max(m, p.bytes), 0),
    partsOverLimit: overLimit.length, unsplittableFiles: unsplittable.length,
    allFilesPlacedOnce: new Set(parts.flatMap((p) => p.files.map((f) => f.root + ':' + f.rel))).size + unsplittable.length === candidates.length,
    bytesMatch: parts.reduce((a, p) => a + p.bytes, 0) + unsplittable.reduce((a, f) => a + f.size, 0) === totalBytes,
    maxAssetsPerRelease: Math.max(0, ...releases.map((r) => parts.filter((p) => p.release === r).length)),
    releaseAssetCapOk: true,
  };
  validation.releaseAssetCapOk = validation.maxAssetsPerRelease < MAX_ASSETS_PER_RELEASE;
  validation.ok = validation.partsOverLimit === 0 && validation.allFilesPlacedOnce && validation.bytesMatch && validation.releaseAssetCapOk;
  return { limitBytes, totalBytes, candidates: candidates.length, parts, unsplittable, held, droppedDup, releases, validation };
}

function emit(plan, outDir) {
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error('--out is not empty (will not overwrite)');
  fs.mkdirSync(outDir, { recursive: true });
  const wx = { flag: 'wx' };
  const manifest = plan.parts.map((p) => ({
    asset: p.asset, release: p.release, category: p.category, bytes: p.bytes, fileCount: p.files.length,
    approved: p.approved, licenceNote: p.licenceNote, sha256: null,
    files: p.files.map((f) => ({ path: f.root + '/' + f.rel, size: f.size })),
  }));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ schema: 1, partLimitBytes: plan.limitBytes, parts: manifest, unsplittable: plan.unsplittable.map((f) => ({ path: f.root + '/' + f.rel, size: f.size })) }, null, 1), wx);
  // resumable state: a future uploader marks parts done; nothing here uploads
  const state = { schema: 1, parts: Object.fromEntries(plan.parts.map((p) => [p.asset, { status: 'pending', attempts: 0, sha256: null, uploadedBytes: 0 }])) };
  fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(state, null, 1), wx);
  const ledger = {
    schema: 1, note: 'Fill before any upload or public serving. status: unverified | approved | rejected',
    datasets: Object.fromEntries([...new Set(plan.parts.map((p) => p.category))].map((c) => [c, { status: 'unverified', source: '', licence: '', attribution: '', note: NEEDS_LICENCE_NOTE[c] || '' }])),
  };
  fs.writeFileSync(path.join(outDir, 'provenance-ledger.json'), JSON.stringify(ledger, null, 1), wx);
  fs.writeFileSync(path.join(outDir, 'plan.md'), planMd(plan), wx);
}

function planMd(plan) {
  const v = plan.validation;
  const L = ['# Mission 41B dry-run plan (no upload performed)', '', 'Part limit: ' + fmt(plan.limitBytes) + ' (GitHub release asset must be < 2 GiB)', '',
    '## Validation', '', '- ok: ' + v.ok, '- candidate files: ' + plan.candidates + ', ' + fmt(plan.totalBytes),
    '- parts: ' + plan.parts.length + ', largest part: ' + fmt(v.maxPartBytes), '- parts over limit: ' + v.partsOverLimit,
    '- files larger than the limit (unsplittable, need chunking): ' + v.unsplittableFiles, '- every file placed exactly once: ' + v.allFilesPlacedOnce,
    '- releases: ' + plan.releases.length + ', max assets per release: ' + v.maxAssetsPerRelease + ' (cap 1000)', '', '## Held back (not planned)', ''];
  for (const [k, h] of Object.entries(plan.held)) L.push('- ' + k + ': ' + h.files + ' files, ' + fmt(h.bytes) + ' - ' + h.reason);
  L.push('- confirmed duplicates dropped: ' + plan.droppedDup.files + ' files, ' + fmt(plan.droppedDup.bytes), '', '## Parts', '', '| asset | release | files | size | approved |', '|---|---|---|---|---|');
  for (const p of plan.parts) L.push('| ' + p.asset + ' | ' + p.release + ' | ' + p.files.length + ' | ' + fmt(p.bytes) + ' | ' + p.approved + ' |');
  return L.join('\n') + '\n';
}

// ---- (5) resume helpers for a future uploader (pure, testable) ----
function nextPending(state, maxAttempts) {
  return Object.entries(state.parts).find(([, s]) => s.status !== 'done' && s.attempts < (maxAttempts || 5));
}
function markResult(state, asset, ok, sha256, bytes) {
  const s = state.parts[asset];
  s.attempts++;
  if (ok) { s.status = 'done'; s.sha256 = sha256; s.uploadedBytes = bytes; } else s.status = 'failed';
  return state;
}
// Done only if the remote size equals the manifest size AND checksum matches.
function verifyPart(manifestPart, remote) {
  return remote.size === manifestPart.bytes && !!manifestPart.sha256 && remote.sha256 === manifestPart.sha256;
}

function run(argv) {
  const cmd = argv[0];
  const a = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--inventory') a.inventory = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--top') a.top = Number(argv[++i]);
    else if (argv[i] === '--max-part-gib') a.gib = Number(argv[++i]);
    else if (argv[i] === '--approved') a.approved = argv[++i].split(',').filter(Boolean);
  }
  if (!a.inventory) throw new Error('usage: summary|plan --inventory <inventory.json> [--out <new dir>] [--top N] [--max-part-gib G] [--approved cats]');
  const inv = loadInventory(a.inventory);
  if (cmd === 'summary') { console.log(JSON.stringify(summarize(inv, a.top || 15), null, 1)); return; }
  if (cmd === 'plan') {
    if (!a.out) throw new Error('--out <new dir> required');
    const pl = buildPlan(inv, { maxPartGiB: a.gib, approved: a.approved });
    emit(pl, path.resolve(a.out));
    console.log(JSON.stringify({ parts: pl.parts.length, candidates: pl.candidates, candidateSize: fmt(pl.totalBytes), largestPart: fmt(pl.validation.maxPartBytes), partsOverLimit: pl.validation.partsOverLimit, unsplittableFiles: pl.validation.unsplittableFiles, releases: pl.releases.length, ok: pl.validation.ok, uploaded: false }));
    if (!pl.validation.ok) process.exitCode = 2;
    return;
  }
  throw new Error('unknown command: ' + cmd);
}

module.exports = { summarize, buildPlan, pack, emit, nextPending, markResult, verifyPart, loadInventory, run, GIB_RELEASE_ASSET_LIMIT };
if (require.main === module) {
  try { run(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}
