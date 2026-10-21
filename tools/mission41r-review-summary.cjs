'use strict';
// Mission 41R: anonymous, READ-ONLY review summary of the final 41K state (findings cohorts + unscanned cohorts).
// OFFLINE. No network, no upload. Writes only with --write-dir <NEW dir>.
// Output holds ONLY counts, byte sums, detector types, categories, extensions and capped anonymous ids (sha256(root:rel) first 8 hex).
// Never: a value, a JSON key name, a path, a file name, a surrounding context.
//   node tools/mission41r-review-summary.cjs --manifest m.json [--state s.json] [--max-ids 12] [--write-dir <NEW dir>]
//        [--shape --roots-file r.json [--shape-max 500]]   (shape: reads files locally to label phone-like hits; labels are candidates only)
const fs = require('node:fs');
const path = require('node:path');
const k = require('./mission41k-content-scan.cjs');
const l = require('./mission41l-triage.cjs');
const o = require('./mission41o-holdplan.cjs');

const OWNER_HOLD_ID = 'e6b68bd7';
const UUID_CANDIDATE_ID = 'a0d64b19';
const MAX_IDS_LIMIT = 50;
const MIB = 1024 * 1024;
const GATES = { licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false };
const KIND = Object.fromEntries(k.DETECTORS.map((d) => [d.type, d.kind]));

const tally = (rows, fn) => { const r = {}; for (const x of rows) { const v = fn(x); r[v] = (r[v] || 0) + 1; } return r; };
const sortObj = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
const bytes = (rows) => rows.reduce((a, r) => a + (r.bytes || 0), 0);

const FILE_CLASS = [
  ['glb', ['glb']], ['archive', ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz']], ['office-zip', ['xlsx', 'xls', 'docx', 'pptx']],
  ['image', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'ico']], ['pdf', ['pdf']],
  ['geodata', ['pbf', 'shp', 'dbf', 'gpkg', 'osm', 'sqlite', 'db']], ['3dtiles-binary', ['b3dm', 'i3dm', 'pnts', 'cmpt', 'bin']],
  ['media-font-exe', ['mp4', 'mov', 'woff', 'woff2', 'ttf', 'otf', 'exe', 'dll']],
];
function fileClass(ext) { for (const [c, exts] of FILE_CLASS) if (exts.includes(ext)) return c; return 'other-or-no-extension'; }
const sizeBucket = (b) => (b < MIB ? '<1MiB' : b < 10 * MIB ? '1-10MiB' : b < 100 * MIB ? '10-100MiB' : '>=100MiB');
const countBucket = (n) => (n <= 1 ? '1' : n <= 5 ? '2-5' : n <= 50 ? '6-50' : '>50');
const sigOf = (r) => Object.keys(r.detections || {}).sort().join('+') || '(none)';
const kindOfRow = (r) => {
  const ks = new Set(Object.keys(r.detections || {}).map((t) => KIND[t] || 'unknown'));
  return ks.size > 1 ? 'mixed' : ks.has('secret') ? 'secret' : ks.has('personal') ? 'personal' : 'unknown';
};
const hasSecret = (r) => Object.keys(r.detections || {}).some((t) => KIND[t] === 'secret');
const totalHits = (r) => Object.values(r.detections || {}).reduce((a, b) => a + b, 0);

// Optional local shape labels for phone-like hits. Candidate labels only: a hit inside an id-like string is NOT thereby a false positive.
function shapeClasses(m, rows, roots, max) {
  const loc = new Map();
  for (const f of k.manifestFiles(m)) { const { root, rel } = k.splitPath(f.path); loc.set(k.fid(root, rel), { root, rel }); }
  const targets = rows.filter((r) => r.status === 'findings' && r.detections && r.detections['jp-phone-number']).sort((a, b) => a.id.localeCompare(b.id));
  const byClass = {}; const classOf = new Map(); let done = 0;
  for (const r of targets) {
    if (done >= max) break;
    done++;
    const p = loc.get(r.id); const dir = p && roots[p.root]; let cls;
    if (!dir) cls = 'root-not-given';
    else {
      try {
        const full = path.join(dir, ...p.rel.split('/'));
        if (fs.statSync(full).size > 128 * MIB) cls = 'over-128MiB-not-classified';
        else if (k.BINARY_EXT.has(r.ext)) cls = 'binary-not-classified';
        else {
          const keys = Object.keys(l.classifyMatches(fs.readFileSync(full).toString('latin1'), 'jp-phone-number'));
          if (!keys.length) cls = 'no-match-now';
          else if (keys.every((x) => /inside-uuid-like-id/.test(x))) cls = 'inside-uuid-like-id-only';
          else if (keys.every((x) => /inside-uuid-like-id|inside-numeric-list|adjacent-to-letters/.test(x))) cls = 'id-or-numeric-shape-only';
          else cls = 'contact-key-or-free-text-present';
        }
      } catch (e) { cls = 'unreadable-or-cloud-only'; }
    }
    byClass[cls] = (byClass[cls] || 0) + 1; classOf.set(r.id, cls);
  }
  return { requested: true, phoneFindingFiles: targets.length, processed: done, truncated: done < targets.length, byClass: sortObj(byClass), classOf,
    note: 'candidate labels only. A label never clears a file; a human decides.' };
}

function unscannedCohorts(un) {
  const reasons = tally(un, (r) => r.reason);
  const perReason = {};
  for (const reason of Object.keys(reasons)) {
    const rs = un.filter((r) => r.reason === reason);
    perReason[reason] = { files: rs.length, bytes: bytes(rs), byFileType: sortObj(tally(rs, (r) => fileClass(r.ext))), byExtension: sortObj(tally(rs, (r) => r.ext)),
      bySize: sortObj(tally(rs, (r) => sizeBucket(r.bytes))), byCategory: sortObj(tally(rs, (r) => r.category)) };
  }
  const glb = un.filter((r) => fileClass(r.ext) === 'glb');
  const arch = un.filter((r) => r.reason === 'archive-not-opened');
  return { files: un.length, bytes: bytes(un), status: 'HOLD / needs review (always)', byReason: sortObj(reasons), byReasonDetail: perReason, byFileType: sortObj(tally(un, (r) => fileClass(r.ext))),
    glb: { files: glb.length, bytes: bytes(glb), note: 'Only the JSON chunk can be inspected (tools/mission41l-triage.ps1 -Mode GlbMeta). The BIN chunk is never inspected and is NOT safe.' },
    archives: { files: arch.length, bytes: bytes(arch), byFileType: sortObj(tally(arch, (r) => fileClass(r.ext))), note: 'Never auto-extracted. Contents unknown; review by hand, extracted into a separate empty folder.' },
    note: 'unscanned means nothing was learned about the contents. It is not safe and not approved.' };
}

function summarize(m, stateInfo, opts) {
  opts = opts || {};
  const maxIds = Math.max(0, Math.min(MAX_IDS_LIMIT, Number.isFinite(opts.maxIds) ? opts.maxIds : 12));
  const rows = o.classifyAll(m, stateInfo);
  const prog = o.progress(m, stateInfo, 5000);
  const findings = rows.filter((r) => r.status === 'findings');
  const unscanned = rows.filter((r) => r.status === 'unscanned');
  const clean = rows.filter((r) => r.status === 'scanned-no-pattern');
  const other = rows.filter((r) => !['findings', 'unscanned', 'scanned-no-pattern'].includes(r.status));
  const shape = opts.shape ? shapeClasses(m, rows, opts.roots || {}, opts.shapeMax || 500) : { requested: false, note: 'not requested (no file content is read by default)' };
  const shapeOf = (id) => (shape.classOf ? shape.classOf.get(id) : undefined);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const rank = (r) => (r.id === OWNER_HOLD_ID ? 0 : hasSecret(r) ? 1 : r.id === UUID_CANDIDATE_ID ? 2 : shapeOf(r.id) === 'contact-key-or-free-text-present' ? 3 : 4);
  const prio = findings.slice().sort((a, b) => rank(a) - rank(b) || totalHits(a) - totalHits(b) || a.id.localeCompare(b.id));
  const priorityIds = prio.slice(0, maxIds).map((r) => ({ id: r.id, category: r.category, ext: r.ext, kind: kindOfRow(r), detectors: sigOf(r), hitBucket: countBucket(totalHits(r)),
    shape: shapeOf(r.id), status: 'HOLD-needs-human-review' }));
  const ownerHold = byId.get(OWNER_HOLD_ID); const uuidCand = byId.get(UUID_CANDIDATE_ID);
  const byDetectorType = {};
  for (const t of Object.keys(KIND)) { const n = findings.filter((r) => r.detections[t]).length; if (n) byDetectorType[t] = n; }

  return { schema: 1, tool: 'mission41r-review-summary', kind: 'anonymous-review-summary', readOnly: true,
    stateValid: stateInfo.valid, stateNote: stateInfo.reason,
    progress: { total: prog.total, reached: prog.reached, notReached: prog.notReached, percent: prog.percent, complete: prog.complete,
      note: 'reached = looked at by a regex scan. It is NOT safety and NOT review completion.' },
    byStatus: tally(rows, (r) => r.status),
    uploadAllowed: false, eligibleForPackOrUpload: 0, gates: { ...GATES },
    notApproved: { scannedNoPattern: clean.length, note: 'scanned-no-pattern files are NOT approved and NOT reviewed: the regexes found nothing, that is all. Approval needs the owner allowlist, three manual gates and a separate transfer phase.' },
    findings: { files: findings.length, bytes: bytes(findings), byKind: sortObj(tally(findings, kindOfRow)), byDetectorType: sortObj(byDetectorType),
      byDetectorCombination: sortObj(tally(findings, sigOf)), byCategory: sortObj(tally(findings, (r) => r.category)), byExtension: sortObj(tally(findings, (r) => r.ext)),
      byCategoryAndDetector: sortObj(tally(findings, (r) => r.category + ' | ' + sigOf(r))), byHitCount: sortObj(tally(findings, (r) => countBucket(totalHits(r)))),
      totalHits: findings.reduce((a, r) => a + totalHits(r), 0),
      shapeClass: shape.requested ? { phoneFindingFiles: shape.phoneFindingFiles, processed: shape.processed, truncated: shape.truncated, byClass: shape.byClass, note: shape.note } : shape,
      verdict: 'none. A detection count says nothing about real vs false positive. Every finding file stays HOLD until a human decides.' },
    holdDistinction: {
      ownerHold: { id: OWNER_HOLD_ID, inState: !!ownerHold, foundAsFinding: !!ownerHold && ownerHold.status === 'findings', status: 'ALWAYS HOLD (owner decision), independent of any label' },
      uuidShapeCandidate: { id: UUID_CANDIDATE_ID, inState: !!uuidCand, foundAsFinding: !!uuidCand && uuidCand.status === 'findings', shape: shapeOf(UUID_CANDIDATE_ID),
        status: 'candidate false-positive label ONLY; still HOLD; not cleared' } },
    priorityReview: { cap: maxIds, shown: priorityIds.length, of: findings.length, ids: priorityIds,
      order: 'owner HOLD, secret-kind detections, the UUID-shape candidate, contact-key/free-text (only with --shape), then fewest hits first',
      note: 'a capped sample of anonymous ids, not the full list. The full hold list is the 41O proposal.' },
    unscanned: unscannedCohorts(unscanned),
    notInPlace: { files: other.length, byStatus: tally(other, (r) => r.status), note: 'not reached / stale state / size changed: unreviewed' },
    sanitizePlan: { autoApply: false, note: 'a blanket plan that blanks all 335 phone-shaped values would also blank 219 non-phone values: never auto-applied; a human reviews per cohort.' },
    licenceLedger: { approved: false, note: 'licence / source-family ledger (PLATEAU, OSM, N03, e-Stat, Commons) is a separate manual gate and stays unapproved.' },
    hold: { allUnscannedAlwaysHold: true, allFindingsHold: true },
    caveats: ['no values, key names, paths, file names or context are printed', 'scan cache validity is size+mtime; regex detectors only; clean is not a review',
      'cloud-only (OneDrive) handling is not inferred here: only the recorded reason is counted'] };
}

function writeNew(dir, name, obj) {
  const abs = path.resolve(dir);
  if (fs.existsSync(abs) && fs.readdirSync(abs).length) throw new Error('output folder is not empty (will not overwrite)');
  fs.mkdirSync(abs, { recursive: true });
  const file = path.join(abs, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 1), { flag: 'wx' });
  return file;
}
function arg(argv, key) { const i = argv.indexOf(key); return i >= 0 ? argv[i + 1] : undefined; }
function run(argv) {
  const manifestF = arg(argv, '--manifest');
  if (!manifestF) throw new Error('--manifest is required');
  const stateF = arg(argv, '--state') || path.join(path.dirname(path.resolve(manifestF)), 'content-scan-state.json');
  const m = k.loadJson(manifestF);
  if (!m || m.schema !== 2 || !Array.isArray(m.parts)) throw new Error('manifest schema must be 2');
  const si = o.loadState(stateF);
  const shape = argv.includes('--shape');
  const roots = shape ? k.loadJson(arg(argv, '--roots-file')) : undefined;
  if (shape && !roots) throw new Error('--shape needs --roots-file');
  const mi = arg(argv, '--max-ids');
  const s = summarize(m, si, { maxIds: mi !== undefined ? Number(mi) : 12, shape, roots, shapeMax: Number(arg(argv, '--shape-max')) || 500 });
  const dir = arg(argv, '--write-dir');
  if (dir) console.log('wrote a NEW summary: ' + path.basename(writeNew(dir, 'review-summary.json', s)));
  console.log(JSON.stringify(s, null, 1));
  return 0;
}
module.exports = { OWNER_HOLD_ID, UUID_CANDIDATE_ID, MAX_IDS_LIMIT, fileClass, summarize, unscannedCohorts, shapeClasses, writeNew, run };
if (require.main === module) {
  try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(String(e.message).replace(/[A-Za-z]:\\[^\s'"]*|\/[^\s'"]+\/[^\s'"]*/g, '<path>')); process.exit(1); }
}
