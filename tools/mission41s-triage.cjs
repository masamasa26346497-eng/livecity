'use strict';
// Mission 41S: anonymous, READ-ONLY, OFFLINE triage helpers for the 41R findings.
//   node tools/mission41s-triage.cjs credential   --manifest m.json --roots-file r.json [--state s.json] [--ids a,b,c]
//   node tools/mission41s-triage.cjs phone-groups --manifest m.json --roots-file r.json [--state s.json] [--max 500] [--progress-file p.json]
// Output holds ONLY: anonymous ids (sha256(root:rel) first 8 hex), detector category, manifest category, extension, coarse value-shape class
// and count buckets. Never a value, a part of a value, a hash/fingerprint, a key name, a path, a file name, an environment variable or a context.
// A label NEVER approves anything: autoApproved is always false, every file stays HOLD, uploadAllowed is false.
// --progress-file (phone-groups) is our own resume file holding only {anonymous id: class}; source files, manifest and scan state are never written.
const fs = require('node:fs');
const path = require('node:path');
const k = require('./mission41k-content-scan.cjs');
const l = require('./mission41l-triage.cjs');
const o = require('./mission41o-holdplan.cjs');

const MIB = 1024 * 1024;
const MAX_FILE = 128 * MIB;
const CRED = k.DETECTORS.find((d) => d.type === 'credential-assignment');
const bucket = (n) => (n <= 0 ? '0' : n <= 1 ? '1' : n <= 5 ? '2-5' : n <= 50 ? '6-50' : '>50');
const sortObj = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
const browserServed = new Set(['js', 'mjs', 'cjs', 'html', 'htm', 'json', 'css', 'map']);

function locate(m) {
  const loc = new Map();
  for (const f of k.manifestFiles(m)) { const { root, rel } = k.splitPath(f.path); loc.set(k.fid(root, rel), { root, rel, category: f.category }); }
  return loc;
}
function readLocal(p, roots, ext) {
  const dir = p && roots[p.root];
  if (!dir) return { err: 'root-not-given' };
  try {
    const full = path.join(dir, ...p.rel.split('/'));
    if (fs.statSync(full).size > MAX_FILE) return { err: 'over-128MiB-not-classified' };
    if (k.BINARY_EXT.has(ext)) return { err: 'binary-not-classified' };
    return { text: fs.readFileSync(full).toString('latin1') };
  } catch (e) { return { err: 'unreadable-or-cloud-only' }; }
}

// ---- value shape (coarse; the value itself is dropped immediately) ----
const REF = /^(?:\$\{[^}]*\}|\{\{[^}]*\}\}|<[^>]*>|%[^%]+%|\$[A-Za-z_][A-Za-z0-9_]*|process\.env\..*|os\.environ.*)$/;
const PLACE = /(?:your|example|placeholder|change[-_]?me|replace|dummy|sample|fake|todo|insert|redacted|none|null|undefined|password|secret|xxxx|\*{4}|test)/i;
function entropy(s) {
  const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1;
  let h = 0; for (const c of Object.keys(f)) { const p = f[c] / s.length; h -= p * Math.log2(p); }
  return h;
}
function valueShape(v) {
  if (REF.test(v)) return 'reference-shaped';
  if (/^(.)\1*$/.test(v) || PLACE.test(v)) return 'placeholder-shaped';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  if (v.length >= 20 && classes >= 3 && entropy(v) >= 3.5) return 'random-shaped-candidate';
  return 'unknown';
}
function credShapes(text) {
  const re = new RegExp(CRED.re.source, CRED.re.flags); const out = {}; let m;
  while ((m = re.exec(text))) {
    const q = /[:=]\s*["']([^"'\s]+)["']$/.exec(m[0]);
    const cls = q ? valueShape(q[1]) : 'unknown';
    out[cls] = (out[cls] || 0) + 1;
  }
  return out;
}
const OWNER_GUIDANCE = [
  'This tool changed nothing and approved nothing. These steps are for the owner to read; none was performed.',
  'First decide locally, by opening the file yourself, whether each flagged value is a real credential. No label here decides that.',
  'If it is NOT real (placeholder/test): the file stays HOLD until the separate manual gates; the label is not an approval.',
  'If it IS a real credential: (1) keep the file out of any pack/upload/commit; (2) in the issuing provider console, restrict the key (allowed referrers/IPs/APIs) or revoke it and issue a new one (rotate);',
  '(3) check the provider usage/audit log for use you do not recognise; (4) search your own local history/backups/other repos for the same file and clean them; (5) keep the new key out of source files (environment/secret store).',
  'Nothing leaves this PC through this tool.'];

function credential(m, stateInfo, roots, idsFilter) {
  const rows = o.classifyAll(m, stateInfo); const loc = locate(m);
  const isCred = (r) => r && r.status === 'findings' && r.detections && r.detections['credential-assignment'];
  const targets = rows.filter(isCred);
  const want = idsFilter && idsFilter.length ? idsFilter : targets.map((r) => r.id);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = want.slice().sort().map((id) => {
    const r = byId.get(id); const base = { id, status: 'HOLD-needs-human-review', autoApproved: false, autoExcluded: false };
    if (!r) return { ...base, result: 'id-not-in-manifest' };
    if (!isCred(r)) return { ...base, result: 'not-a-credential-assignment-finding' };
    const rd = readLocal(loc.get(id), roots, r.ext);
    const info = { ...base, detector: 'credential-assignment', manifestCategory: r.category, extension: r.ext || '(none)',
      categoryEvidence: 'manifest category only (path is neither inspected for this label nor printed)',
      ifPublished: browserServed.has(r.ext) ? 'text file type: any visitor could read it if served' : 'not a typical browser-served type',
      otherDetectorsInSameFile: Object.keys(r.detections).filter((t) => t !== 'credential-assignment').sort(),
      scanHitsBucket: bucket(r.detections['credential-assignment']) };
    if (rd.err) return { ...info, valueShape: 'unknown', result: rd.err };
    const shapes = credShapes(rd.text); const total = Object.values(shapes).reduce((a, b) => a + b, 0);
    const kinds = Object.keys(shapes);
    let overall = 'unknown';
    if (!total) overall = 'no-match-now';
    else if (kinds.includes('random-shaped-candidate')) overall = 'random-shaped-candidate-present';
    else if (kinds.every((x) => x === 'placeholder-shaped' || x === 'reference-shaped')) overall = 'all-placeholder-or-reference-shaped';
    return { ...info, matchesNowBucket: bucket(total), valueShapeCounts: Object.fromEntries(Object.entries(shapes).map(([a, b]) => [a, bucket(b)])), valueShape: overall,
      note: 'shape label only. unknown is the default when there is no basis. Not a verdict.' };
  });
  return { schema: 1, tool: 'mission41s-triage', mode: 'credential', readOnly: true, stateValid: stateInfo.valid, uploadAllowed: false, eligibleForPackOrUpload: 0,
    targets: targets.length, shown: items.length, items, ownerGuidance: OWNER_GUIDANCE };
}

// ---- phone-regex candidates grouped into owner-sized cohorts ----
function phoneClass(text) {
  const keys = Object.keys(l.classifyMatches(text, 'jp-phone-number'));
  if (!keys.length) return 'no-match-now';
  if (keys.every((x) => /inside-uuid-like-id/.test(x))) return 'uuid-shape-only';
  if (keys.every((x) => /inside-uuid-like-id|inside-numeric-list|adjacent-to-letters/.test(x))) return 'id-or-numeric';
  return 'free-text/contact';
}
function loadProgress(f) {
  if (!f || !fs.existsSync(f)) return {};
  try { const j = k.loadJson(f); return j && j.classes && typeof j.classes === 'object' ? j.classes : {}; } catch (e) { return {}; }
}
function phoneGroups(m, stateInfo, roots, opts) {
  const max = Math.max(1, opts.max || 500);
  const rows = o.classifyAll(m, stateInfo); const loc = locate(m);
  const targets = rows.filter((r) => r.status === 'findings' && r.detections && r.detections['jp-phone-number']).sort((a, b) => a.id.localeCompare(b.id));
  const classes = opts.progress || {}; let done = 0;
  for (const r of targets) {
    if (classes[r.id]) continue;
    if (done >= max) break;
    done++;
    const rd = readLocal(loc.get(r.id), roots, r.ext);
    classes[r.id] = rd.err ? (rd.err === 'unreadable-or-cloud-only' ? 'unreadable' : rd.err) : phoneClass(rd.text);
  }
  const classed = targets.filter((r) => classes[r.id]);
  const tallyBy = (fn) => sortObj(classed.reduce((a, r) => { const x = fn(r); a[x] = (a[x] || 0) + 1; return a; }, {}));
  return { out: { schema: 1, tool: 'mission41s-triage', mode: 'phone-groups', readOnly: true, stateValid: stateInfo.valid, uploadAllowed: false, eligibleForPackOrUpload: 0,
    phoneFindingFiles: targets.length, classifiedTotal: classed.length, processedThisRun: done, remaining: targets.length - classed.length, perRunCap: max,
    resumable: 'run again with the same --progress-file to continue; only anonymous id -> class is stored',
    byClass: tallyBy((r) => classes[r.id]), byCategory: tallyBy((r) => r.category), byExtension: tallyBy((r) => r.ext || '(none)'),
    byCategoryExtensionClass: tallyBy((r) => r.category + ' | ' + (r.ext || '(none)') + ' | ' + classes[r.id]),
    classMeaning: { 'uuid-shape-only': 'every regex hit sits inside a UUID-like id', 'id-or-numeric': 'hits sit in ids / numeric lists / next to letters',
      'free-text/contact': 'at least one hit is in free text or a field: needs a human look', unreadable: 'could not be read now (cloud-only / locked)' },
    verdict: 'none. A class is a candidate label for ordering the work. Nothing is cleared, approved or excluded; every file stays HOLD (a uuid-shape-only class is not a transfer approval).',
    unscannedRule: 'unscanned files are always HOLD. GLB: JSON chunk only (41L GlbMeta). Office/archives: never expanded. Other binaries: never auto-approved.' }, classes };
}

function arg(argv, key) { const i = argv.indexOf(key); return i >= 0 ? argv[i + 1] : undefined; }
function run(argv) {
  const mode = argv[0]; const manifestF = arg(argv, '--manifest'); const rootsF = arg(argv, '--roots-file');
  if (!['credential', 'phone-groups'].includes(mode)) throw new Error('mode must be credential or phone-groups');
  if (!manifestF || !rootsF) throw new Error('--manifest and --roots-file are required');
  const m = k.loadJson(manifestF);
  if (!m || m.schema !== 2 || !Array.isArray(m.parts)) throw new Error('manifest schema must be 2');
  const stateF = arg(argv, '--state') || path.join(path.dirname(path.resolve(manifestF)), 'content-scan-state.json');
  const si = o.loadState(stateF); const roots = k.loadJson(rootsF);
  if (mode === 'credential') {
    const ids = (arg(argv, '--ids') || '').split(',').map((x) => x.trim()).filter(Boolean);
    console.log(JSON.stringify(credential(m, si, roots, ids), null, 1)); return 0;
  }
  const pf = arg(argv, '--progress-file');
  const r = phoneGroups(m, si, roots, { max: Number(arg(argv, '--max')) || 500, progress: loadProgress(pf) });
  if (pf) { const tmp = pf + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ schema: 1, classes: r.classes })); fs.renameSync(tmp, pf); }
  console.log(JSON.stringify(r.out, null, 1)); return 0;
}
module.exports = { valueShape, credShapes, credential, phoneClass, phoneGroups, loadProgress, OWNER_GUIDANCE, run };
if (require.main === module) {
  try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(String(e.message).replace(/[A-Za-z]:\\[^\s'"]*|\/[^\s'"]+\/[^\s'"]*/g, '<path>')); process.exit(1); }
}
