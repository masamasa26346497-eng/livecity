'use strict';
// Mission 41U: anonymous review QUEUE + owner decision LEDGER (design) for the 41T-sub-classified phone candidates. OFFLINE, READ-ONLY by default.
//   node tools/mission41u-review-ledger.cjs --manifest m.json --roots-file r.json --progress-file p.json [--state s.json] [--ids-max 12] [--max-seconds 600]
//        [--decisions-file d.json]      read owner decisions (counts only are printed)
//        [--init-decisions d.json]      OWNER-REQUESTED ONLY: create a new template (all `undecided`) outside the repo; never overwrites
// Output holds ONLY: anonymous ids (max 12 per cohort), manifest category, extension, coarse class, count buckets, decision counts.
// Never: a phone value, key name, context, file name/path, e-mail/secret, hash or fingerprint of content.
// Nothing here decides anything. A public business number and a personal number cannot be told apart from the phone format or the key.
// Owner decisions are notes for the owner. They never change a gate: uploadAllowed stays false, eligibleForPackOrUpload stays 0.
const fs = require('node:fs');
const path = require('node:path');
const k = require('./mission41k-content-scan.cjs');
const o = require('./mission41o-holdplan.cjs');
const s = require('./mission41s-triage.cjs');
const t = require('./mission41t-contact-subclass.cjs');

const REPO = path.resolve(__dirname, '..');
const bucket = (n) => (n <= 0 ? '0' : n <= 1 ? '1' : n <= 5 ? '2-5' : n <= 50 ? '6-50' : '>50');
const sortObj = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
const count = (arr, fn) => sortObj(arr.reduce((a, x) => { const y = fn(x); a[y] = (a[y] || 0) + 1; return a; }, {}));

// Default is always `undecided`. These words are owner notes only; none of them approves, excludes or uploads anything.
const DECISIONS = ['undecided', 'keep-hold', 'needs-recheck', 'owner-note-public-business-number', 'owner-note-personal-or-unsure', 'owner-note-not-a-phone'];

const COHORTS = [
  { key: 'A-embedded-text-high-priority', match: (c) => /:contact-key-embedded-text$/.test(c), why: 'phone-format text inside longer text under a contact-like key; may carry names or context, so look first' },
  { key: 'B-whole-value-source-license-pending', match: (c) => /:contact-key-whole-value$/.test(c), why: 'one phone-format value under a contact-like key; whether it is public depends on the data source and its licence, which is unconfirmed' },
  { key: 'C-id-shaped-recheck', match: (c) => /:idish-only$/.test(c), why: 'every match looked id/number shaped; likely false positive, but a candidate label only. Recheck, do not dismiss' },
  { key: 'D-other-review', match: () => true, why: 'other structural classes, parse errors or unreadable files' },
];
const cohortOf = (cls) => COHORTS.find((c) => c.match(cls)).key;

function build(res, rows, stateInfo, decisions, idsMax) {
  const by = {};
  for (const c of COHORTS) by[c.key] = [];
  for (const x of res) by[cohortOf(x.c.cls)].push(x);
  const cohorts = COHORTS.map((c) => {
    const list = by[c.key].sort((a, b) => a.r.id.localeCompare(b.r.id));
    // duplicate POSSIBILITY only: identical byte size inside the cohort. A weak hint, not a duplicate verdict, and no content hash is computed.
    const sizes = {}; for (const x of list) sizes[x.r.bytes] = (sizes[x.r.bytes] || 0) + 1;
    const sameSize = list.filter((x) => sizes[x.r.bytes] > 1).length;
    return { cohort: c.key, why: c.why, files: list.length,
      byCategory: count(list, (x) => x.r.category), byExtension: count(list, (x) => x.r.ext || '(none)'),
      rawPhoneMatchesZeroFiles: list.filter((x) => (x.c.rawPhoneMatches || 0) === 0).length,
      filesSharingAnIdenticalSizeWithAnotherFileBucket: bucket(sameSize),
      decisionCounts: decisions ? count(list, (x) => decisions.map.get(x.r.id) || 'undecided') : 'no decisions file given (all treated as undecided)',
      ids: list.slice(0, idsMax).map((x) => ({ id: x.r.id, category: x.r.category, extension: x.r.ext || '(none)', class: x.c.cls,
        nonIdPhoneCandidateBucket: bucket(x.c.nonIdPhoneCandidates || 0), idShapedStringBucket: bucket(x.c.idShapedStrings || 0), rawPhoneMatchesBucket: bucket(x.c.rawPhoneMatches || 0) })),
      idsOmitted: Math.max(0, list.length - idsMax) };
  });
  const inSel = new Set(res.map((x) => x.r.id));
  // everything outside the selected files stays open: recomputed from the scan state, never from typed-in numbers
  const findings = rows.filter((r) => r.status === 'findings');
  const detTypes = {}; for (const r of findings) for (const d of Object.keys(r.detections)) detTypes[d] = (detTypes[d] || 0) + 1;
  const outside = findings.filter((r) => !inSel.has(r.id));
  const outTypes = {}; for (const r of outside) for (const d of Object.keys(r.detections)) outTypes[d] = (outTypes[d] || 0) + 1;
  return { cohorts,
    openItems: { stateValid: stateInfo.valid, filesWithFindings: findings.length, filesWithFindingsByDetector: sortObj(detTypes),
      findingFilesOutsideThisQueue: outside.length, outsideByDetector: sortObj(outTypes),
      unscannedFiles: rows.filter((r) => r.status === 'unscanned').length, unscannedByReason: count(rows.filter((r) => r.status === 'unscanned'), (r) => r.reason),
      scannedNoPatternFiles: rows.filter((r) => r.status === 'scanned-no-pattern').length,
      note: 'a file can have several detectors, so per-detector counts do not sum to the file count. scanned-no-pattern is not approval and unscanned is not safe. All stay HOLD.' } };
}

function loadDecisions(file, knownIds) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (!j || j.schema !== 1 || !j.decisions || typeof j.decisions !== 'object') throw new Error('decisions file: schema 1 with a decisions object is required');
  const map = new Map(); let invalid = 0; let unknown = 0;
  for (const [id, d] of Object.entries(j.decisions)) {
    if (!knownIds.has(id)) { unknown++; continue; }
    if (!DECISIONS.includes(d)) { invalid++; continue; }
    map.set(id, d);
  }
  return { map, invalidDecisionValues: invalid, idsNotInThisQueue: unknown };
}

// Owner-requested only. Refuses: existing file, a path inside this repository, or any path under a git work tree. Writes only anonymous ids + `undecided`.
function initDecisions(file, res) {
  const full = path.resolve(file);
  if (full === REPO || full.startsWith(REPO + path.sep)) throw new Error('refusing: the decisions file must be outside the repository');
  for (let d = path.dirname(full); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) throw new Error('refusing: the decisions file must not be inside a git work tree');
    if (path.dirname(d) === d) break;
  }
  const decisions = {}; for (const x of res) decisions[x.r.id] = 'undecided';
  const body = { schema: 1, kind: 'mission41u-owner-decisions', readme: 'Local owner notes. Never commit, push or paste this file. Allowed values: ' + DECISIONS.join(', ') + '. No value approves, excludes or uploads anything.', decisions };
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(body, null, 1), { flag: 'wx' }); // wx: fails if it exists, never overwrites
  return { created: true, entries: res.length, allUndecided: true };
}

const OWNER_STEPS = [
  'Work only on this PC. Nothing below needs the network, and nothing should be pasted back except counts.',
  'Cohort A first (embedded text), then B, then C. The ids are anonymous 8-hex ids; your own plan folder maps an id back to a file locally.',
  'For each id decide by looking at the real file in a local editor: is the number a published organisation number, a personal number, or not a phone at all?',
  'Record the result only in your own decisions file (created on request with --init-decisions). Do not edit or delete the source files from this tool.',
  'Removing or masking anything in the source data is a separate step that needs its own explicit approval. A recorded decision never triggers it.'];

function summary(m, stateInfo, roots, progress, opts) {
  const idsMax = Math.min(12, Math.max(0, opts.idsMax == null ? 12 : opts.idsMax));
  const res = t.collect(m, stateInfo, roots, progress, opts);
  const rows = o.classifyAll(m, stateInfo);
  const decisions = opts.decisionsFile ? loadDecisions(opts.decisionsFile, new Set(res.map((x) => x.r.id))) : null;
  const b = build(res, rows, stateInfo, decisions, idsMax);
  return { schema: 1, tool: 'mission41u-review-ledger', mode: 'review-queue', readOnly: true, stateValid: stateInfo.valid,
    uploadAllowed: false, eligibleForPackOrUpload: 0, autoApproved: false, autoExcluded: false, decisionsAffectGate: false,
    sanitizePlanApproved: false, sanitizePlanNote: 'a bulk clean-up of contact-key values (for example the non-phone-format ones) is NOT treated as safe or approved',
    dataLicenceFamiliesApproved: false, transferGate: 'closed (unchanged by this tool)',
    selectedFiles: res.length, decisionVocabulary: DECISIONS, defaultDecision: 'undecided',
    decisionsFile: decisions ? { entriesUsed: decisions.map.size, invalidDecisionValues: decisions.invalidDecisionValues, idsNotInThisQueue: decisions.idsNotInThisQueue } : 'none given',
    cohorts: b.cohorts, openItems: b.openItems, ownerSteps: OWNER_STEPS,
    verdict: 'none. The queue only orders the owner review. Neither the phone format nor the key says whether a number is a company number or a personal number.' };
}

function arg(argv, key) { const i = argv.indexOf(key); return i >= 0 ? argv[i + 1] : undefined; }
function run(argv) {
  const manifestF = arg(argv, '--manifest'); const rootsF = arg(argv, '--roots-file'); const pf = arg(argv, '--progress-file');
  if (!manifestF || !rootsF || !pf) throw new Error('--manifest, --roots-file and --progress-file are required');
  if (!fs.existsSync(pf)) throw new Error('progress file not found (run 41S phone-groups first)');
  const m = k.loadJson(manifestF);
  if (!m || m.schema !== 2 || !Array.isArray(m.parts)) throw new Error('manifest schema must be 2');
  const stateF = arg(argv, '--state') || path.join(path.dirname(path.resolve(manifestF)), 'content-scan-state.json');
  const opts = { idsMax: arg(argv, '--ids-max') == null ? 12 : Number(arg(argv, '--ids-max')), maxSeconds: Number(arg(argv, '--max-seconds')) || 600, decisionsFile: arg(argv, '--decisions-file') };
  const stateInfo = o.loadState(stateF); const roots = k.loadJson(rootsF); const progress = s.loadProgress(pf);
  const initF = arg(argv, '--init-decisions');
  if (initF) {
    const res = t.collect(m, stateInfo, roots, progress, opts);
    console.log(JSON.stringify({ tool: 'mission41u-review-ledger', mode: 'init-decisions', ...initDecisions(initF, res), uploadAllowed: false }, null, 1));
    return 0;
  }
  console.log(JSON.stringify(summary(m, stateInfo, roots, progress, opts), null, 1)); return 0;
}
module.exports = { DECISIONS, COHORTS, cohortOf, build, loadDecisions, initDecisions, summary, run };
if (require.main === module) {
  try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(String(e.message).replace(/[A-Za-z]:\\[^\s'"]*|\/[^\s'"]+\/[^\s'"]*/g, '<path>')); process.exit(1); }
}
