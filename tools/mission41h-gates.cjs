'use strict';
// Mission 41H: pre-transfer gates. Offline, read-only, prints NO paths and NO secret values.
//   secrets-summary --review <secret-review.json>
//   licence-ledger  --manifest <manifest.json> --out <new ledger.json>      (template; approved:false)
//   licence-check   --manifest <manifest.json> --ledger <ledger.json>
//   zip-keys        --zip <archive.zip>                                      (central directory only, names only)
//   gates-status    --manifest <manifest.json> [--ledger <f>] [--review <f>]
// Nothing here opens a gate by itself: readyToUpload stays false; the owner edits the ledger by hand.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SECRET_NAME_HINT } = require('./mission41f-pack-local.cjs');

const sha8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

// ---- 1. anonymous secret summary --------------------------------------------------------------
function secretsSummary(rev) {
  const files = rev.files || [];
  const byVerdict = {}; const fpGroups = new Map(); const rows = [];
  for (const f of files) {
    for (const h of f.hits || []) {
      const k = h.type + ':' + h.verdict; byVerdict[k] = (byVerdict[k] || 0) + 1;
      if (h.fp && h.verdict === 'looks-real') fpGroups.set(h.fp, (fpGroups.get(h.fp) || 0) + 1);
    }
    const bad = (f.hits || []).filter((h) => h.verdict === 'looks-real' || h.verdict === 'personal-or-unknown-domain');
    if (bad.length) rows.push({ id: f.id, ext: f.ext, category: f.category, servedFolder: !!f.served, findings: [...new Set(bad.map((h) => h.type + ':' + h.verdict))] });
  }
  const actions = [];
  if (rows.some((r) => r.findings.some((x) => x.startsWith('google-api-key:looks-real')))) actions.push('real-looking Google key: keep out of every archive; check referrer+API restrictions in Cloud Console; rotate if the folder/zip/screenshot was ever shared');
  if (rows.some((r) => r.findings.some((x) => x.startsWith('email-address:')))) actions.push('personal-looking e-mail: decide per file whether it may go to the private data repo; never publish');
  if (rows.some((r) => r.servedFolder)) actions.push('some hits sit under a served public/ folder: confirm they are git-ignored and were never deployed by hand');
  return { candidateFiles: files.length, needsAction: rows.length, counts: byVerdict,
    sameValueGroups: [...fpGroups.values()].filter((n) => n > 1).length, rows, actions,
    note: 'ids only; map id->path stays in LOCAL-ONLY-id-to-path.json (never paste). Gate noSecretsReviewed is NOT opened by this report.' };
}

// ---- 2. licence / provenance ledger ------------------------------------------------------------
const LEDGER_FIELDS = ['source', 'licence', 'redistributionAllowed', 'attribution', 'approvedBy', 'approvedOn'];
function manifestGroups(m) {
  const g = new Map();
  for (const p of m.parts || []) {
    const e = g.get(p.category) || { category: p.category, parts: 0, files: 0, bytes: 0 };
    e.parts++; e.files += p.files.length; e.bytes += p.files.reduce((a, f) => a + f.size, 0); g.set(p.category, e);
  }
  return [...g.values()].sort((a, b) => a.category.localeCompare(b.category));
}
function ledgerTemplate(m) {
  return { schema: 1, note: 'Fill by hand from the primary source. approved:true only when source+licence+redistributionAllowed(true)+attribution are all filled. Do not guess.',
    entries: manifestGroups(m).map((g) => ({ ...g, source: '', licence: '', redistributionAllowed: null, attribution: '', approvedBy: '', approvedOn: '', approved: false })) };
}
function ledgerCheck(m, led) {
  const entries = new Map((led.entries || []).map((e) => [e.category, e]));
  const out = []; let allOk = true;
  for (const g of manifestGroups(m)) {
    const e = entries.get(g.category); const missing = [];
    if (!e) missing.push('no-entry');
    else {
      for (const k of LEDGER_FIELDS) {
        const bad = k === 'redistributionAllowed' ? e[k] !== true : !String(e[k] || '').trim();
        if (bad) missing.push(k);
      }
      if (e.approved !== true) missing.push('approved');
    }
    if (missing.length) allOk = false;
    out.push({ category: g.category, files: g.files, bytes: g.bytes, ok: !missing.length, missing });
  }
  const extra = [...entries.keys()].filter((k) => !out.some((o) => o.category === k));
  return { licenceApproved: allOk, categories: out, extraEntries: extra };
}

// ---- 3. zip central directory names (handles zip64) ---------------------------------------------
function zipNames(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 70000); const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('not a zip (no end-of-central-directory)');
    let count = tail.readUInt16LE(e + 10); let cdSize = tail.readUInt32LE(e + 12); let cdOff = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      const l = e - 20;
      if (l < 0 || tail.readUInt32LE(l) !== 0x07064b50) throw new Error('zip64 locator missing');
      const z64 = Number(tail.readBigUInt64LE(l + 8)); const h = Buffer.alloc(56); fs.readSync(fd, h, 0, 56, z64);
      if (h.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 record missing');
      count = Number(h.readBigUInt64LE(32)); cdSize = Number(h.readBigUInt64LE(40)); cdOff = Number(h.readBigUInt64LE(48));
    }
    if (cdSize > 512 * 1024 * 1024) throw new Error('central directory too large');
    const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
    const names = []; let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
      const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
      const utf8 = (cd.readUInt16LE(p + 8) & 0x800) !== 0;
      names.push(cd.toString(utf8 ? 'utf8' : 'latin1', p + 46, p + 46 + nl)); p += 46 + nl + xl + cl;
    }
    return names;
  } finally { fs.closeSync(fd); }
}
function zipKeyReport(names) {
  const hits = names.filter((n) => SECRET_NAME_HINT.test(n) || /(^|\/)local-config\.js$/i.test(n));
  const kinds = {};
  for (const n of hits) {
    const k = /local-config\.js$/i.test(n) ? 'local-config.js' : /\.env/i.test(n) ? '.env*' : (path.extname(n).toLowerCase() || 'name-hint');
    kinds[k] = (kinds[k] || 0) + 1;
  }
  return { entries: names.length, keyLikeNames: hits.length, kinds, ids: hits.slice(0, 50).map(sha8),
    note: 'name check only; contents not read; no names printed. Treat the zip as secret-bearing until opened by the owner.' };
}

function gatesStatus(m, led, rev) {
  const lic = led ? ledgerCheck(m, led).licenceApproved : false;
  const sec = rev ? secretsSummary(rev) : null;
  return { gates: { licenceApproved: lic, noSecretsReviewed: false, noPersonalDataReviewed: false },
    secretsReport: sec ? { needsAction: sec.needsAction, note: 'owner must confirm each action, then decide; this tool never opens a gate' } : 'not provided',
    readyToUpload: false };
}

function arg(argv, k) { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; }
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
function run(argv) {
  const cmd = argv[0]; const pr = (o) => console.log(JSON.stringify(o, null, 1));
  if (cmd === 'secrets-summary') {
    if (!arg(argv, '--review')) throw new Error('--review required');
    pr(secretsSummary(readJson(arg(argv, '--review')))); return 0;
  }
  if (cmd === 'licence-ledger') {
    const out = arg(argv, '--out');
    if (!arg(argv, '--manifest') || !out) throw new Error('--manifest and --out required');
    if (fs.existsSync(out)) throw new Error('--out exists (will not overwrite)');
    fs.writeFileSync(out, JSON.stringify(ledgerTemplate(readJson(arg(argv, '--manifest'))), null, 1), { flag: 'wx' });
    console.log('ledger template written (all approved:false). Fill it by hand.'); return 0;
  }
  if (cmd === 'licence-check') {
    const r = ledgerCheck(readJson(arg(argv, '--manifest')), readJson(arg(argv, '--ledger')));
    pr(r); return r.licenceApproved ? 0 : 2;
  }
  if (cmd === 'zip-keys') {
    if (!arg(argv, '--zip')) throw new Error('--zip required');
    pr(zipKeyReport(zipNames(arg(argv, '--zip')))); return 0;
  }
  if (cmd === 'gates-status') {
    const l = arg(argv, '--ledger'), v = arg(argv, '--review');
    pr(gatesStatus(readJson(arg(argv, '--manifest')), l ? readJson(l) : null, v ? readJson(v) : null)); return 0;
  }
  throw new Error('usage: secrets-summary | licence-ledger | licence-check | zip-keys | gates-status');
}
module.exports = { secretsSummary, ledgerTemplate, ledgerCheck, zipNames, zipKeyReport, gatesStatus, run };
if (require.main === module) { try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); } }
