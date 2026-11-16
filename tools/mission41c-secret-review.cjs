'use strict';
// Mission 41C: safe review of 41A "secret candidates" WITHOUT ever printing or storing a secret value.
// Reads (read-only) only the files 41A flagged. For each hit it records: file id, line, type and a verdict:
//   placeholder | looks-real | example-domain | personal-or-unknown-domain | file-pattern-only
// plus a short fingerprint (first 8 hex of sha256 of the value) so the same key in several files can be
// matched without exposing it, and whether the file sits under a served "public/" folder.
// Output: ONE new report folder (outside every root). Console shows counts only.
//   node tools/mission41c-secret-review.cjs --inventory <inventory.json> --roots "dirA;dirB" --out <new dir>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PATTERNS = {
  'google-api-key': /AIza[0-9A-Za-z_-]{35}/g,
  'github-token': /gh[pousr]_[A-Za-z0-9]{30,}/g,
  'aws-access-key': /AKIA[0-9A-Z]{16}/g,
  'anthropic-or-openai-key': /sk-[A-Za-z0-9_-]{32,}/g,
  'bearer-token': /[Bb]earer\s+[A-Za-z0-9._-]{30,}/g,
  'email-address': /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
};
const PLACEHOLDER = /(x{4,}|your[-_ ]?(api|key)|example|placeholder|dummy|sample|changeme|0{6,}|1234567|<[^>]+>|\.\.\.)/i;
const EXAMPLE_DOMAIN = /(^|\.)(example\.(com|org|net)|users\.noreply\.github\.com|noreply\.github\.com|localhost|test|invalid)$/i;
const PRIVATE_CTX = /(^|\/)(public|www|dist|static)\//i;

function fp(v) { return crypto.createHash('sha256').update(v).digest('hex').slice(0, 8); }
function fid(root, rel) { return crypto.createHash('sha256').update(root + ':' + rel).digest('hex').slice(0, 8); }

// Never returns the matched value; only a verdict and a fingerprint.
function reviewLine(type, line) {
  const out = [];
  const re = new RegExp(PATTERNS[type].source, 'g');
  let m;
  while ((m = re.exec(line))) {
    const v = m[0];
    if (type === 'email-address') {
      const dom = m[1];
      out.push({ type, verdict: EXAMPLE_DOMAIN.test(dom) ? 'example-domain' : 'personal-or-unknown-domain', fp: fp(v) });
    } else {
      // placeholder = obvious dummy text around the value, or a value made of repeated filler
      const ph = PLACEHOLDER.test(line.replace(v, '')) || /(x{6,}|X{6,}|0{8,}|1234567890)/.test(v);
      out.push({ type, verdict: ph ? 'placeholder' : 'looks-real', fp: fp(v), length: v.length });
    }
  }
  return out;
}

function reviewFile(full, opts) {
  const res = [];
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch (e) { return [{ type: 'unreadable', verdict: 'unreadable' }]; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && res.length < 50; i++) {
    if (lines[i].length > 20000) continue;
    for (const t of Object.keys(PATTERNS)) {
      for (const r of reviewLine(t, lines[i])) res.push({ line: i + 1, ...r });
    }
  }
  return res;
}

function review(inv, roots, opts) {
  const byName = new Map(roots.map((r) => [path.basename(r), r]));
  const files = [];
  for (const f of inv.files) {
    if (!(f.secretByName || (f.secrets || []).length)) continue;
    const rootDir = byName.get(f.root);
    const rec = { id: fid(f.root, f.rel), ext: f.ext || '(none)', category: f.category, served: PRIVATE_CTX.test(f.rel), nameOnly: !!f.secretByName && !(f.secrets || []).length, hits: [] };
    if (rootDir) rec.hits = reviewFile(path.join(rootDir, ...f.rel.split('/')), opts);
    else rec.hits = [{ type: 'root-not-given', verdict: 'unreviewed' }];
    if (!rec.hits.length && rec.nameOnly) rec.hits = [{ type: 'filename-pattern', verdict: 'file-pattern-only' }];
    // local-only mapping id -> path, written to a separate file the owner keeps private
    rec._path = f.root + '/' + f.rel;
    files.push(rec);
  }
  const counts = {};
  for (const r of files) for (const h of r.hits) { const k = h.type + ':' + h.verdict; counts[k] = (counts[k] || 0) + 1; }
  const needsAction = files.filter((r) => r.hits.some((h) => h.verdict === 'looks-real' || h.verdict === 'personal-or-unknown-domain'));
  return { files, counts, needsAction };
}

function emit(res, out) {
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('--out is not empty (will not overwrite)');
  fs.mkdirSync(out, { recursive: true });
  const safe = res.files.map(({ _path, ...r }) => r);
  fs.writeFileSync(path.join(out, 'secret-review.json'), JSON.stringify({ counts: res.counts, files: safe }, null, 1), { flag: 'wx' });
  // contains personal paths: LOCAL ONLY, do not paste or commit
  fs.writeFileSync(path.join(out, 'LOCAL-ONLY-id-to-path.json'), JSON.stringify(Object.fromEntries(res.files.map((r) => [r.id, r._path])), null, 1), { flag: 'wx' });
}

function run(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--inventory') a.inventory = argv[++i];
    else if (argv[i] === '--roots') a.roots = argv[++i].split(';').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--out') a.out = argv[++i];
  }
  if (!a.inventory || !a.roots || !a.out) throw new Error('usage: --inventory <inventory.json> --roots "dirA;dirB" --out <new dir>');
  const roots = a.roots.map((r) => path.resolve(r));
  const out = path.resolve(a.out);
  for (const r of roots) { const rel = path.relative(r, out); if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('--out must be outside every root'); }
  const res = review(JSON.parse(fs.readFileSync(a.inventory, 'utf8')), roots, {});
  emit(res, out);
  console.log(JSON.stringify({ candidateFiles: res.files.length, counts: res.counts, needsAction: res.needsAction.length, servedFiles: res.files.filter((r) => r.served).length, note: 'no values printed; ids map to paths only in LOCAL-ONLY-id-to-path.json' }, null, 1));
}

module.exports = { reviewLine, reviewFile, review, emit, run };
if (require.main === module) {
  try { run(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}
