'use strict';
// Mission 41K: OFFLINE, READ-ONLY content scan of the files listed in a 41B manifest.json (schema 2).
// Looks INSIDE files for key/credential/personal-contact patterns. Independent of the 41J leak-check
// (which only compares ids and names). Never modifies/moves/deletes a source file, no network.
// Output (report + console) contains ONLY: anonymous file id (sha256(root:rel) first 8 hex, same as 41C/41J),
// category, extension, detector name and counts. Never a path, a snippet, a matched value or a value fingerprint.
//   node tools/mission41k-content-scan.cjs scan --manifest m.json --roots-file roots.json [--state s.json] [--out dir]
//        [--path-contains fukushima] [--max-files N] [--max-seconds N] [--max-file-mib 512] [--skip-file list.txt]
//   node tools/mission41k-content-scan.cjs lookup --manifest m.json --id <8hex>   (prints that one path; owner-local use)
// Gates noSecretsReviewed / noPersonalDataReviewed / readyToUpload are ALWAYS false here: a clean scan is not approval.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIB = 1024 * 1024;
const CHUNK = 1 * MIB;
const OVERLAP = 4096;
const fid = (root, rel) => crypto.createHash('sha256').update(root + ':' + rel).digest('hex').slice(0, 8);
const skey = (root, rel) => crypto.createHash('sha256').update(root + ':' + rel).digest('hex').slice(0, 20); // state key (collision-safe)

// Bounded quantifiers on purpose: no catastrophic backtracking on long base64 / minified lines.
const DETECTORS = [
  { type: 'google-api-key', kind: 'secret', re: /AIza[0-9A-Za-z_-]{35}/g },
  { type: 'github-token', kind: 'secret', re: /\bgh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{40,255}/g },
  { type: 'aws-access-key', kind: 'secret', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'openai-anthropic-style-key', kind: 'secret', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,200}/g },
  { type: 'slack-token', kind: 'secret', re: /\bxox[abprs]-[A-Za-z0-9-]{10,100}/g },
  { type: 'bearer-token', kind: 'secret', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{30,500}/g },
  { type: 'jwt', kind: 'secret', re: /\beyJ[A-Za-z0-9_-]{10,1000}\.eyJ[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10,1000}/g },
  { type: 'pem-private-key', kind: 'secret', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/g },
  { type: 'credential-assignment', kind: 'secret', re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["'][^"'\s]{8,200}["']/gi },
  { type: 'email-address', kind: 'personal', re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,5}/g },
  { type: 'jp-phone-number', kind: 'personal', re: /(?<![\d.-])(?:\+81[- ]?)?0\d{1,4}-\d{1,4}-\d{4}(?![\d-])/g },
];
// Cache key part (41L): any change to a detector, the binary-extension sets or the chunking invalidates old state.
const SCANNER_VERSION = '41L-1';
function detectorFingerprint() {
  const h = crypto.createHash('sha256');
  h.update(SCANNER_VERSION + '|' + CHUNK + '|' + OVERLAP);
  for (const d of DETECTORS) h.update('|' + d.type + ':' + d.kind + ':' + d.re.source + ':' + d.re.flags);
  h.update('|' + [...BINARY_EXT].sort().join(',') + '|' + [...ARCHIVE_EXT].sort().join(','));
  return h.digest('hex').slice(0, 16);
}
const EXAMPLE_EMAIL = /@(?:example\.(?:com|org|net)|[^@]*noreply\.github\.com|localhost)$/i;
const SECRET_NAME = /(^|\/)\.env(\.|$)|\.(pem|key|pfx|p12|kdbx|ppk)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)|credential|secret|token|service[-_]?account|\.npmrc$|\.netrc$|local-config\.js$/i;

// Cannot be inspected as text. These are reported as UNSCANNED, never as safe.
const BINARY_EXT = new Set(['glb', 'pbf', 'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'ico', 'pdf', 'xlsx', 'xls', 'docx', 'pptx', 'bin', 'b3dm', 'i3dm', 'pnts', 'cmpt', 'mp4', 'mov', 'sqlite', 'db', 'gpkg', 'shp', 'dbf', 'exe', 'dll', 'woff', 'woff2', 'ttf', 'otf', 'osm']);
const ARCHIVE_EXT = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'xlsx', 'xls', 'docx', 'pptx']);

// Origin markers (candidates only; never an approval). Path-based and first-chunk content-based.
const ORIGIN_PATH = [
  ['plateau', /plateau|citygml|mission38e|mission37h|mission40|mesh\d{6}/i],
  ['osm', /osm|openstreetmap|fallback|facilit|roads|waterways|parks|railways/i],
  ['n03-or-boundary', /n03|boundar|wards?\b|osaka-24/i],
  ['e-stat', /e-?stat|census|demograph|town-stats/i],
  ['wikimedia', /wikimedia|commons|photo-index|building-photo/i],
  ['gsi', /gsi|cyberjapan/i],
];
const ORIGIN_CONTENT = [
  ['plateau', /plateau|citygml/i], ['osm', /openstreetmap|odbl/i], ['wikimedia', /wikimedia|commons\.wikimedia/i],
  ['e-stat', /e-stat|estat/i], ['gsi', /gsi\.go\.jp|cyberjapandata/i],
];

function extOf(rel) { const m = /\.([A-Za-z0-9]+)$/.exec(rel); return m ? m[1].toLowerCase() : ''; }

function* manifestFiles(m) {
  for (const p of m.parts || []) for (const f of p.files || []) yield { path: f.path, size: f.size, category: p.category };
  for (const f of m.unsplittable || []) yield { path: f.path, size: f.size, category: 'unsplittable' };
}
function splitPath(p) { const i = p.indexOf('/'); return i > 0 ? { root: p.slice(0, i), rel: p.slice(i + 1) } : { root: '', rel: p }; }

// Streaming scan of one file. Returns { status, reason?, counts?, origin? }. Content is never retained.
function scanFile(full, opts) {
  let fd;
  try { fd = fs.openSync(full, 'r'); } catch (e) { return { status: 'unscanned', reason: 'unreadable-or-cloud-only' }; }
  try {
    let st; try { st = fs.fstatSync(fd); } catch (e) { return { status: 'unscanned', reason: 'unreadable-or-cloud-only' }; }
    if (st.size > opts.maxFileBytes) return { status: 'unscanned', reason: 'over-size-limit', size: st.size, mtimeMs: st.mtimeMs };
    const buf = Buffer.alloc(CHUNK);
    const counts = {}; const origin = new Set();
    let carry = ''; let pos = 0; let first = true;
    while (true) {
      let n;
      try { n = fs.readSync(fd, buf, 0, CHUNK, pos); } catch (e) { return { status: 'unscanned', reason: 'read-error' }; }
      if (n <= 0) break;
      pos += n;
      if (first) {
        first = false;
        if (n >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3 && buf[3] === 4) return { status: 'unscanned', reason: 'archive-not-opened', size: st.size, mtimeMs: st.mtimeMs };
        if (n >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return { status: 'unscanned', reason: 'archive-not-opened', size: st.size, mtimeMs: st.mtimeMs };
        if (buf.subarray(0, Math.min(n, 8192)).includes(0)) return { status: 'unscanned', reason: 'binary-content', size: st.size, mtimeMs: st.mtimeMs };
        const head = buf.toString('latin1', 0, Math.min(n, 4096));
        for (const [o, re] of ORIGIN_CONTENT) if (re.test(head)) origin.add(o);
      }
      const text = carry + buf.toString('latin1', 0, n);
      for (const d of DETECTORS) {
        d.re.lastIndex = 0; let m;
        while ((m = d.re.exec(text))) {
          if (m[0].length === 0) { d.re.lastIndex++; continue; }
          if (m.index + m[0].length <= carry.length) continue; // already counted in the previous chunk
          if (d.type === 'email-address' && EXAMPLE_EMAIL.test(m[0])) { counts['email-example-domain-ignored'] = (counts['email-example-domain-ignored'] || 0) + 1; continue; }
          counts[d.type] = (counts[d.type] || 0) + 1;
        }
      }
      carry = text.slice(Math.max(0, text.length - OVERLAP));
    }
    return { status: 'scanned', counts, origin: [...origin], size: st.size, mtimeMs: st.mtimeMs };
  } finally { fs.closeSync(fd); }
}

function loadJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); }
function saveState(file, state) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, file); // our own state file only
}

function scan(o) {
  const m = loadJson(o.manifest);
  if (!m || !Array.isArray(m.parts)) throw new Error('not a 41B manifest.json');
  if (m.schema !== 2) throw new Error('manifest schema must be 2 (re-run 41B/quick)');
  const roots = loadJson(o.rootsFile);
  const skip = new Set(o.skipFile ? fs.readFileSync(o.skipFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).map((s) => s.replace(/\\/g, '/').toLowerCase()) : []);
  const needle = o.pathContains ? o.pathContains.toLowerCase() : null;
  const state = fs.existsSync(o.state) ? loadJson(o.state) : { schema: 1, note: 'ids/sizes/mtimes/detector counts only; no paths or values', files: {} };
  if (!state.files) state.files = {};
  const fingerprint = detectorFingerprint();
  let stateInvalidated = null;
  if ((state.scannerVersion !== SCANNER_VERSION || state.detectorFingerprint !== fingerprint) && Object.keys(state.files).length) {
    stateInvalidated = { reason: state.scannerVersion ? 'scanner-or-detector-changed' : 'legacy-state-without-version', droppedEntries: Object.keys(state.files).length };
    state.files = {}; // old results came from other detectors: discard, never reuse
  }
  state.scannerVersion = SCANNER_VERSION; state.detectorFingerprint = fingerprint;
  const maxFileBytes = (o.maxFileMiB || 512) * MIB;
  const started = Date.now();
  const sel = []; let manifestTotal = 0;
  for (const f of manifestFiles(m)) { manifestTotal++; if (!needle || f.path.toLowerCase().includes(needle)) sel.push(f); }
  const stats = { selected: sel.length, manifestFiles: manifestTotal, processedThisRun: 0, resumedFromState: 0, stateInvalidated, stoppedEarly: null, rootMissing: 0, sizeChangedSinceManifest: 0 };
  const rows = [];
  let sinceSave = 0;
  for (const f of sel) {
    const { root, rel } = splitPath(f.path);
    const key = skey(root, rel);
    const rootDir = roots[root];
    let res;
    const prev = state.files[key];
    if (!rootDir) { res = { status: 'unscanned', reason: 'root-not-given' }; stats.rootMissing++; }
    else if (skip.has((root + '/' + rel).toLowerCase())) res = { status: 'unscanned', reason: 'cloud-only-not-read' };
    else {
      const full = path.join(rootDir, ...rel.split('/'));
      let cur = null; try { cur = fs.statSync(full); } catch (e) { /* handled by scanFile */ }
      const same = prev && cur && prev.size === cur.size && prev.mtimeMs === cur.mtimeMs;
      if (same && prev.status === 'scanned') { res = prev; stats.resumedFromState++; }
      else if (same && prev.status === 'unscanned' && ['archive-not-opened', 'binary-content', 'binary-format-not-inspected'].includes(prev.reason)) { res = prev; stats.resumedFromState++; }
      else if (same && prev.reason === 'over-size-limit' && (prev.maxFileBytes || 0) === maxFileBytes) { res = prev; stats.resumedFromState++; }
      else {
        if (o.maxFiles && stats.processedThisRun >= o.maxFiles) { stats.stoppedEarly = 'max-files'; break; }
        if (o.maxSeconds && (Date.now() - started) / 1000 > o.maxSeconds) { stats.stoppedEarly = 'max-seconds'; break; }
        const ext = extOf(rel);
        if (BINARY_EXT.has(ext)) {
          res = { status: 'unscanned', reason: ARCHIVE_EXT.has(ext) ? 'archive-not-opened' : 'binary-format-not-inspected', size: cur ? cur.size : undefined, mtimeMs: cur ? cur.mtimeMs : undefined };
        } else res = scanFile(full, { maxFileBytes });
        res.maxFileBytes = maxFileBytes;
        if (res.size !== undefined && f.size !== undefined && res.size !== f.size) stats.sizeChangedSinceManifest++;
        stats.processedThisRun++;
        state.files[key] = res;
        if (++sinceSave >= 500) { saveState(o.state, state); sinceSave = 0; }
      }
    }
    rows.push({ id: fid(root, rel), category: f.category, ext: extOf(rel) || '(none)', nameHint: SECRET_NAME.test(f.path), pathOrigin: ORIGIN_PATH.filter(([, re]) => re.test(f.path)).map(([n]) => n), res });
  }
  saveState(o.state, state);
  return summarize(rows, stats, sel.length, o);
}

function summarize(rows, stats, selected, o) {
  const byStatus = { scanned: 0, unscanned: 0, notReached: selected - rows.length };
  const unscannedByReason = {}, unscannedByExt = {}, unscannedByCategory = {};
  const detectorTotals = {}; const filesWithFindings = []; let nameHints = 0;
  const prov = {};
  for (const r of rows) {
    const p = (prov[r.category] = prov[r.category] || { files: 0, byOrigin: {}, unmarked: 0, multiOriginFiles: 0 });
    p.files++;
    const origins = new Set([...(r.pathOrigin || []), ...((r.res && r.res.origin) || [])]);
    if (!origins.size) p.unmarked++; else { if (origins.size > 1) p.multiOriginFiles++; for (const x of origins) p.byOrigin[x] = (p.byOrigin[x] || 0) + 1; }
    if (r.nameHint) nameHints++;
    if (r.res.status === 'scanned') {
      byStatus.scanned++;
      const real = Object.entries(r.res.counts || {}).filter(([k]) => k !== 'email-example-domain-ignored');
      if (real.length) {
        for (const [k, n] of real) detectorTotals[k] = (detectorTotals[k] || 0) + n;
        filesWithFindings.push({ id: r.id, category: r.category, ext: r.ext, detections: Object.fromEntries(real) });
      }
    } else {
      byStatus.unscanned++;
      const why = r.res.reason || 'unknown';
      unscannedByReason[why] = (unscannedByReason[why] || 0) + 1;
      unscannedByExt[r.ext] = (unscannedByExt[r.ext] || 0) + 1;
      unscannedByCategory[r.category] = (unscannedByCategory[r.category] || 0) + 1;
    }
  }
  const provenance = Object.entries(prov).map(([category, p]) => ({
    category, files: p.files, originCandidates: p.byOrigin, unmarkedFiles: p.unmarked, multiOriginFiles: p.multiOriginFiles,
    mixedOrigin: Object.keys(p.byOrigin).length > 1 || p.multiOriginFiles > 0 || p.unmarked > 0,
    status: 'owner-confirm-required', approved: false, redistributionAllowed: null,
  }));
  return {
    schema: 1, tool: 'mission41k-content-scan', scannerVersion: SCANNER_VERSION, detectorFingerprint: detectorFingerprint(),
    scope: { pathContains: o.pathContains || null },
    stats, byStatus,
    complete: byStatus.notReached === 0 && byStatus.unscanned === 0,
    detectorTotals, filesWithFindings: filesWithFindings.slice(0, 500), filesWithFindingsTotal: filesWithFindings.length,
    secretLikeNameFiles: nameHints,
    unscanned: { byReason: unscannedByReason, byExtension: unscannedByExt, byCategory: unscannedByCategory,
      note: 'UNSCANNED means nothing was learned about the contents. It is NOT safe. Binary/archive files need a separate manual review.' },
    provenance,
    caveats: [
      'email/phone detections are pattern matches and include false positives (e.g. public OSM contact fields, ids shaped like phone numbers); each needs a human decision.',
      'a detection means "look at this file", a clean result means only "none of these patterns were found in scanned files".',
      'binary, archive, cloud-only and over-size files were not inspected (see unscanned).',
      'provenance entries are path/header hints, not licence approval; mixed-origin categories must not be approved as one block.',
      'files held out of the 41B manifest (backups, secrets candidates) are not covered by this scan.',
    ],
    gates: { noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false },
    note: 'Independent of the 41J leak-check. Both gates stay false until a human reviews every detection and every unscanned file.',
    verdict: filesWithFindings.length ? 'DETECTIONS: review the listed ids locally' : (byStatus.unscanned || byStatus.notReached ? 'no detections in scanned files, but some files were NOT scanned' : 'no detections in scanned files (not proof of absence; human approval still required)'),
  };
}

function consoleSummary(r) {
  return { selected: r.stats.selected, scanned: r.byStatus.scanned, unscanned: r.byStatus.unscanned, notReached: r.byStatus.notReached, resumedFromState: r.stats.resumedFromState, stateInvalidated: r.stats.stateInvalidated, scannerVersion: r.scannerVersion, processedThisRun: r.stats.processedThisRun, stoppedEarly: r.stats.stoppedEarly,
    filesWithFindings: r.filesWithFindingsTotal, detectorTotals: r.detectorTotals, secretLikeNameFiles: r.secretLikeNameFiles, unscannedByReason: r.unscanned.byReason,
    mixedOriginCategories: r.provenance.filter((p) => p.mixedOrigin).map((p) => p.category), complete: r.complete, gates: r.gates, verdict: r.verdict };
}

function arg(argv, k) { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; }
function run(argv) {
  const cmd = argv[0];
  if (cmd === 'lookup') {
    const m = loadJson(arg(argv, '--manifest')); const id = arg(argv, '--id');
    for (const f of manifestFiles(m)) { const { root, rel } = splitPath(f.path); if (fid(root, rel) === id) { console.log(f.path); return 0; } }
    console.error('id not in manifest'); return 1;
  }
  if (cmd !== 'scan') throw new Error('usage: scan | lookup');
  const manifest = arg(argv, '--manifest'), rootsFile = arg(argv, '--roots-file');
  if (!manifest || !rootsFile) throw new Error('--manifest and --roots-file are required');
  const dir = path.dirname(path.resolve(manifest));
  const o = { manifest, rootsFile, state: arg(argv, '--state') || path.join(dir, 'content-scan-state.json'), pathContains: arg(argv, '--path-contains') || '',
    maxFiles: Number(arg(argv, '--max-files')) || 0, maxSeconds: Number(arg(argv, '--max-seconds')) || 0, maxFileMiB: Number(arg(argv, '--max-file-mib')) || 512, skipFile: arg(argv, '--skip-file') };
  const outDir = path.resolve(arg(argv, '--out') || dir);
  fs.mkdirSync(outDir, { recursive: true });
  const report = scan(o);
  const outFile = path.join(outDir, 'content-scan-report-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 1), { flag: 'wx' });
  console.log(JSON.stringify(consoleSummary(report), null, 1));
  console.log('report: ' + path.basename(outFile) + ' (new file, next to the manifest unless --out)');
  return report.filesWithFindingsTotal ? 2 : (report.byStatus.unscanned || report.byStatus.notReached ? 3 : 0);
}
module.exports = { SCANNER_VERSION, detectorFingerprint, manifestFiles, splitPath, extOf, loadJson, BINARY_EXT, scan, scanFile, DETECTORS, fid, skey, run, summarize };
if (require.main === module) { try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); } }
