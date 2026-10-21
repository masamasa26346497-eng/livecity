'use strict';
// Mission 41T: anonymous, READ-ONLY, OFFLINE sub-classification of the 41S phone-groups `free-text/contact` files
// (and the single over-128MiB JSONL, streamed). Reads the 41S --progress-file (anonymous id -> class) and the local target files only to count.
//   node tools/mission41t-contact-subclass.cjs --manifest m.json --roots-file r.json --progress-file p.json [--state s.json] [--ids-max 12] [--max-seconds 600]
// Output holds ONLY: anonymous ids (max 12), manifest category, extension, coarse structural class, count buckets, phone-prefix-type buckets.
// Never: a value, a part of a value, a hash/fingerprint, a JSON key name, context, file name or path. Nothing is written (no progress write either).
// A class is a candidate label, NOT a verdict. A public business number and a personal number are never assumed safe. Everything stays HOLD.
const fs = require('node:fs');
const path = require('node:path');
const k = require('./mission41k-content-scan.cjs');
const l = require('./mission41l-triage.cjs');
const o = require('./mission41o-holdplan.cjs');
const s = require('./mission41s-triage.cjs');

const MIB = 1024 * 1024;
const MAX_WHOLE = 128 * MIB;     // never readFileSync above this
const MAX_JSON_PARSE = 64 * MIB; // never JSON.parse above this
const MAX_LINE = 4 * MIB;        // streamed JSONL: longer lines are skipped, not buffered
const CHUNK = 1 * MIB;
const PHONE = k.DETECTORS.find((d) => d.type === 'jp-phone-number').re;
const WHOLE = /^\s*(?:\+81[- ]?)?0\d{1,4}-\d{1,4}-\d{4}\s*$/;
const bucket = (n) => (n <= 0 ? '0' : n <= 1 ? '1' : n <= 5 ? '2-5' : n <= 50 ? '6-50' : '>50');
const sortObj = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
// most human-attention-needing first
const PRIORITY = ['noncontact-key-text', 'memo-key-text', 'noncontact-key-whole-value', 'contact-key-embedded-text', 'contact-key-whole-value', 'idish-only'];
const mk = () => new RegExp(PHONE.source, PHONE.flags);

function phoneType(raw) {
  const d = raw.replace(/^\+81[- ]?/, '0').replace(/-/g, '');
  if (/^0(?:120|800)/.test(d)) return 'freephone-format';
  if (/^0(?:70|80|90)/.test(d)) return 'mobile-format';
  if (/^050/.test(d)) return 'ip-phone-format';
  if (/^0[1-9]/.test(d)) return 'landline-or-other-format';
  return 'other-format';
}
function newAcc() { return { cls: {}, types: {}, hits: 0, parseErrLines: 0, skippedLines: 0, lines: 0 }; }

// Walk one parsed JSON value iteratively; counts only (keys give a coarse class and are dropped).
function walk(root, acc) {
  const stack = [[root, null]]; let steps = 0;
  const push = (x, key) => { if (typeof x === 'string' || (x && typeof x === 'object')) stack.push([x, key]); };
  while (stack.length) {
    const [v, key] = stack.pop();
    if (++steps > 5e6) break;
    if (typeof v === 'string') {
      if (v.length < 8 || !mk().test(v)) continue;
      const ctx = l.classifyMatches(v, 'jp-phone-number');
      const real = Object.keys(ctx).filter((c) => !/inside-uuid-like-id|inside-numeric-list|adjacent-to-letters/.test(c));
      if (!real.length) { acc.cls['idish-only'] = (acc.cls['idish-only'] || 0) + 1; continue; }
      const kc = l.keyClass(key); const whole = WHOLE.test(v);
      let c;
      if (kc === 'contact-key') c = whole ? 'contact-key-whole-value' : 'contact-key-embedded-text';
      else if (kc === 'free-text-key') c = 'memo-key-text';
      else c = whole ? 'noncontact-key-whole-value' : 'noncontact-key-text';
      acc.cls[c] = (acc.cls[c] || 0) + 1;
      const re = mk(); let m;
      while ((m = re.exec(v))) { acc.hits++; const t = phoneType(m[0]); acc.types[t] = (acc.types[t] || 0) + 1; }
    } else if (Array.isArray(v)) { for (const x of v) push(x, null); }
    else if (v && typeof v === 'object') { for (const kk of Object.keys(v)) push(v[kk], kk); }
  }
}
const parse = (t) => JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);

// Streaming JSONL: bounded memory (one chunk + one line <= MAX_LINE); no whole-file read, no whole-file parse.
function streamJsonl(full, acc, maxSeconds) {
  const fd = fs.openSync(full, 'r'); const buf = Buffer.allocUnsafe(CHUNK); const t0 = Date.now();
  let carry = ''; let overflow = false; let partial = false;
  const handle = (line) => {
    if (!line.trim()) return; acc.lines++;
    let j; try { j = parse(line); } catch (e) { acc.parseErrLines++; return; }
    walk(j, acc);
  };
  try {
    for (;;) {
      if (maxSeconds && (Date.now() - t0) / 1000 > maxSeconds) { partial = true; break; }
      const n = fs.readSync(fd, buf, 0, CHUNK, null); if (n <= 0) break;
      const parts = (carry + buf.toString('latin1', 0, n)).split('\n'); carry = parts.pop();
      for (const p of parts) { if (overflow) { overflow = false; acc.skippedLines++; continue; } handle(p); }
      if (carry.length > MAX_LINE) { carry = ''; overflow = true; }
    }
    if (!partial) { if (overflow) acc.skippedLines++; else handle(carry); }
  } finally { fs.closeSync(fd); }
  return partial;
}

function finish(acc, kind, note) {
  const present = PRIORITY.filter((c) => acc.cls[c]);
  const out = { cls: present.length ? kind + ':' + present[0] : kind + ':no-phone-match-in-string-values', hits: acc.hits, types: Object.keys(acc.types).sort(), distinct: present.length, note };
  if (kind === 'jsonl') { out.lines = acc.lines; out.parseErrLines = acc.parseErrLines; out.skippedLines = acc.skippedLines; }
  return out;
}
function classifyOne(rec, roots, ext, opts) {
  const dir = rec && roots[rec.root];
  if (!dir) return { cls: 'root-not-given' };
  const full = path.join(dir, ...rec.rel.split('/'));
  const acc = newAcc();
  try {
    const size = fs.statSync(full).size;
    if (k.BINARY_EXT.has(ext)) return { cls: 'binary-not-classified' };
    if (ext === 'jsonl' || ext === 'ndjson') return finish(acc, 'jsonl', streamJsonl(full, acc, opts.maxSeconds) ? 'stream-time-cap-partial' : null);
    if (size > MAX_WHOLE) return { cls: 'over-128MiB-not-classified' };
    if (ext === 'json') {
      if (size > MAX_JSON_PARSE) return { cls: 'json-over-64MiB-not-parsed' };
      let j; try { j = parse(fs.readFileSync(full, 'utf8')); } catch (e) { return { cls: 'json-parse-error' }; }
      walk(j, acc); return finish(acc, 'json');
    }
    if (!mk().test(fs.readFileSync(full).toString('latin1'))) return { cls: 'no-match-now' };
    return { cls: ext === 'html' || ext === 'htm' ? 'html-text' : 'other-text' };
  } catch (e) { return { cls: 'unreadable' }; }
}

function subclass(m, stateInfo, roots, progress, opts) {
  const idsMax = Math.min(12, Math.max(0, opts.idsMax == null ? 12 : opts.idsMax));
  const rows = o.classifyAll(m, stateInfo); const loc = new Map();
  for (const f of k.manifestFiles(m)) { const { root, rel } = k.splitPath(f.path); loc.set(k.fid(root, rel), { root, rel }); }
  const targets = rows.filter((r) => r.status === 'findings' && r.detections && r.detections['jp-phone-number']
    && ['free-text/contact', 'over-128MiB-not-classified'].includes(progress[r.id])).sort((a, b) => a.id.localeCompare(b.id));
  const res = targets.map((r) => ({ r, c: classifyOne(loc.get(r.id), roots, r.ext, opts) }));
  const tally = (fn) => sortObj(res.reduce((a, x) => { const y = fn(x); a[y] = (a[y] || 0) + 1; return a; }, {}));
  const rank = (c) => { const i = PRIORITY.findIndex((p) => c.endsWith(':' + p)); return i < 0 ? 99 : i; };
  const attention = res.filter((x) => x.c.cls !== 'no-match-now').sort((a, b) => rank(a.c.cls) - rank(b.c.cls) || a.r.id.localeCompare(b.r.id));
  const typeCount = {}; for (const x of res) for (const t of x.c.types || []) typeCount[t] = (typeCount[t] || 0) + 1;
  return { schema: 1, tool: 'mission41t-contact-subclass', mode: 'contact-subclass', readOnly: true, wroteNothing: true, stateValid: stateInfo.valid,
    uploadAllowed: false, eligibleForPackOrUpload: 0, autoApproved: false, autoExcluded: false,
    selectedFiles: targets.length, progressClassesUsed: ['free-text/contact', 'over-128MiB-not-classified'],
    byClass: tally((x) => x.c.cls), byCategoryExtensionClass: tally((x) => x.r.category + ' | ' + (x.r.ext || '(none)') + ' | ' + x.c.cls),
    filesWithPhonePrefixType: sortObj(typeCount), fileHitBuckets: tally((x) => 'hits ' + bucket(x.c.hits || 0)),
    streamedJsonl: res.filter((x) => x.c.lines !== undefined).map((x) => ({ id: x.r.id, linesBucket: bucket(x.c.lines), parseErrorLinesBucket: bucket(x.c.parseErrLines),
      skippedOverlongLinesBucket: bucket(x.c.skippedLines), partial: x.c.note === 'stream-time-cap-partial' })).slice(0, idsMax),
    ids: attention.slice(0, idsMax).map((x) => ({ id: x.r.id, category: x.r.category, extension: x.r.ext || '(none)', class: x.c.cls, hitsBucket: bucket(x.c.hits || 0),
      phonePrefixTypes: x.c.types || [], distinctClasses: x.c.distinct || 0 })),
    idsOmitted: Math.max(0, attention.length - idsMax),
    classMeaning: {
      'contact-key-whole-value': 'whole string is one phone-format value under a contact-like key (structure only; not judged public or personal)',
      'contact-key-embedded-text': 'phone-format text inside longer text under a contact-like key',
      'memo-key-text': 'phone-format text inside a memo-like (free-text) field',
      'noncontact-key-whole-value': 'whole string is phone-format under a key that does not look like a contact key',
      'noncontact-key-text': 'phone-format text embedded in free text under a non-contact key',
      'idish-only': 'after parsing, every hit is id/numeric shaped',
      'html-text': 'HTML/other text, structure not parsed', 'json-parse-error': 'JSON did not parse; left unclassified',
      phonePrefixTypes: 'prefix-format bucket only (mobile / IP / freephone / landline-or-other); nothing is concluded from it' },
    verdict: 'none. Sub-classes only order the human review. A business-public number is NOT assumed safe and a personal number is NOT assumed. Every file stays HOLD; uuid-shape-only, other findings and unscanned files are untouched.' };
}

function arg(argv, key) { const i = argv.indexOf(key); return i >= 0 ? argv[i + 1] : undefined; }
function run(argv) {
  const manifestF = arg(argv, '--manifest'); const rootsF = arg(argv, '--roots-file'); const pf = arg(argv, '--progress-file');
  if (!manifestF || !rootsF || !pf) throw new Error('--manifest, --roots-file and --progress-file are required');
  if (!fs.existsSync(pf)) throw new Error('progress file not found (run 41S phone-groups first)');
  const m = k.loadJson(manifestF);
  if (!m || m.schema !== 2 || !Array.isArray(m.parts)) throw new Error('manifest schema must be 2');
  const stateF = arg(argv, '--state') || path.join(path.dirname(path.resolve(manifestF)), 'content-scan-state.json');
  const out = subclass(m, o.loadState(stateF), k.loadJson(rootsF), s.loadProgress(pf),
    { idsMax: arg(argv, '--ids-max') == null ? 12 : Number(arg(argv, '--ids-max')), maxSeconds: Number(arg(argv, '--max-seconds')) || 600 });
  console.log(JSON.stringify(out, null, 1)); return 0;
}
module.exports = { phoneType, walk, streamJsonl, classifyOne, subclass, run, PRIORITY };
if (require.main === module) {
  try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(String(e.message).replace(/[A-Za-z]:\\[^\s'"]*|\/[^\s'"]+\/[^\s'"]*/g, '<path>')); process.exit(1); }
}
