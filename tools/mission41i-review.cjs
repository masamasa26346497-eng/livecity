'use strict';
// Mission 41I: exposure check + secret review ledger. Offline, read-only (except a new ledger file, flag 'wx').
// Prints NO secret values, NO absolute paths, NO file contents.
//   exposure-check --repo <repo root>                       is public/local-config.js tracked / ignored / referenced / in history
//   review-ledger  --review <secret-review.json> --out <new ledger.json>   (ids only; every gate closed)
//   review-check   --ledger <ledger.json>                   exit 2 until the owner has filled every entry
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { secretsSummary } = require('./mission41h-gates.cjs');

const CONFIG = 'public/local-config.js';
// Shapes only (never printed). Google API keys start with "AIza" + 35 chars.
const KEY_SHAPE = /AIza[0-9A-Za-z_-]{35}/;

function git(repo, args) {
  try { return { ok: true, out: execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }) }; }
  catch (e) { return { ok: false, code: e.status, out: '' }; }
}

function exposureCheck(repo) {
  const r = {};
  const tracked = git(repo, ['ls-files', '--', CONFIG]);
  r.gitAvailable = tracked.ok;
  r.configTracked = tracked.ok && tracked.out.trim() === CONFIG;
  const ign = git(repo, ['check-ignore', '-q', '--', CONFIG]);
  r.configGitIgnored = ign.ok; // exit 0 = ignored
  r.configPresentLocally = fs.existsSync(path.join(repo, CONFIG)); // existence only; content never read
  const hist = git(repo, ['log', '--all', '--oneline', '--', CONFIG]);
  r.configEverCommitted = hist.ok && hist.out.trim().length > 0;
  r.vercelIgnoreFilePresent = fs.existsSync(path.join(repo, '.vercelignore'));
  // Tracked files whose text has a Google-key-shaped string (count + hashed ids only, never the value).
  const files = git(repo, ['ls-files', '-z']);
  const hits = [];
  if (files.ok) {
    for (const f of files.out.split('\0').filter(Boolean)) {
      if (/\.(jpg|jpeg|png|glb|gz|zip|tar|b3dm|bin|ico|woff2?)$/i.test(f)) continue;
      let st; try { st = fs.statSync(path.join(repo, f)); } catch { continue; }
      if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
      let t; try { t = fs.readFileSync(path.join(repo, f), 'utf8'); } catch { continue; }
      if (KEY_SHAPE.test(t)) hits.push(f);
    }
  }
  r.trackedFilesWithKeyShape = hits.length;
  r.trackedKeyShapeFiles = hits.slice(0, 20); // repo-relative names of TRACKED files only; no values
  // Which served pages load local-config.js
  const pages = []; const pub = path.join(repo, 'public');
  if (fs.existsSync(pub)) for (const f of fs.readdirSync(pub)) {
    if (!/\.html$/i.test(f)) continue;
    try { if (/local-config\.js/.test(fs.readFileSync(path.join(pub, f), 'utf8'))) pages.push(f); } catch { /* skip */ }
  }
  r.pagesReferencingConfig = pages;
  const problems = []; const notes = [];
  if (r.configTracked) problems.push('local-config.js is tracked by git: anything in it is in the repo and the Vercel build');
  if (!r.configGitIgnored && !r.configTracked) problems.push('local-config.js is not git-ignored');
  if (r.configEverCommitted) problems.push('local-config.js appears in git history: treat any key it held as exposed');
  if (hits.length) problems.push('a Google-key-shaped string is in tracked file(s): treat as exposed unless it is the intentionally public, restricted key');
  if (r.configPresentLocally && !r.vercelIgnoreFilePresent) notes.push('no .vercelignore: a manual "vercel deploy" from this folder falls back to .gitignore; Git-integration deploys only contain committed files. Confirm in Vercel docs; never deploy by hand from a folder holding the real config.');
  if (pages.length && !r.configTracked) notes.push('pages reference local-config.js; on Vercel it will 404 (not committed), which is the intended safe state');
  r.problems = problems; r.notes = notes;
  r.verdict = problems.length ? 'ATTENTION' : 'no-exposure-found-in-git (does not cover zips, screenshots, chats, manual uploads)';
  return r;
}

const GOOGLE_CHECKS = ['applicationRestrictionSet', 'apiRestrictionSet', 'onlyNeededApisEnabled', 'wasEverSharedOutsideOwner', 'rotatedOrJudgedNotNeeded', 'oldKeyDisabledIfRotated'];
const EMAIL_CHECKS = ['classification', 'decision'];

function reviewLedger(rev) {
  const s = secretsSummary(rev);
  return {
    schema: 1, status: 'template',
    note: 'Fill by hand. IDs only; the id->path map stays in LOCAL-ONLY-id-to-path.json. Never paste key values or addresses. Gates stay closed until the owner decides outside these tools.',
    gates: { noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false },
    stages: ['name-hint-scan (done by 41C; NOT proof of absence)', 'local content scan of every candidate + backups, run by owner on own PC', 'owner opens each flagged file locally and decides', 'redact or exclude', 're-scan after redaction', 'owner signs gate'],
    entries: s.rows.map((row) => {
      const e = { id: row.id, ext: row.ext, category: row.category, servedFolder: row.servedFolder, findings: row.findings, approvedBy: '', approvedOn: '', resolved: false };
      if (row.findings.some((x) => x.startsWith('google-api-key:'))) {
        e.kind = 'google-api-key'; e.checks = Object.fromEntries(GOOGLE_CHECKS.map((k) => [k, null]));
        e.decisionOptions = ['intentional-public-restricted-key', 'rotated-and-excluded', 'excluded-local-only'];
        e.decision = '';
      } else if (row.findings.some((x) => x.startsWith('email-address:'))) {
        e.kind = 'email-address'; e.classification = ''; // public-source-contact | personal | unknown
        e.decisionOptions = ['keep-local-only', 'redact-then-rescan', 'approved-public-source-contact'];
        e.decision = '';
      } else { e.kind = 'other'; e.decision = ''; }
      return e;
    }),
  };
}

function reviewCheck(led) {
  const out = []; let all = true;
  for (const e of led.entries || []) {
    const missing = [];
    if (!String(e.decision || '').trim()) missing.push('decision');
    if (e.kind === 'google-api-key') {
      for (const k of GOOGLE_CHECKS) if (typeof (e.checks || {})[k] !== 'boolean') missing.push('checks.' + k);
      if (e.decision === 'intentional-public-restricted-key' && !(e.checks && e.checks.applicationRestrictionSet === true && e.checks.apiRestrictionSet === true)) missing.push('public-key-needs-both-restrictions');
      if (e.decision === 'intentional-public-restricted-key' && e.servedFolder !== true) missing.push('public-key-expected-in-served-folder-only');
      if (e.checks && e.checks.wasEverSharedOutsideOwner === true && e.decision !== 'rotated-and-excluded' && e.decision !== 'intentional-public-restricted-key') missing.push('shared-key-needs-rotation-or-restricted-public-decision');
    }
    if (e.kind === 'email-address' && !['public-source-contact', 'personal', 'unknown'].includes(e.classification)) missing.push('classification');
    if (e.kind === 'email-address' && e.decision === 'approved-public-source-contact' && e.classification !== 'public-source-contact') missing.push('approval-needs-public-source-classification');
    if (!String(e.approvedBy || '').trim()) missing.push('approvedBy');
    if (!String(e.approvedOn || '').trim()) missing.push('approvedOn');
    if (e.resolved !== true) missing.push('resolved');
    if (missing.length) all = false;
    out.push({ id: e.id, kind: e.kind, ok: !missing.length, missing });
  }
  return { entriesResolved: all && out.length > 0, entries: out,
    gates: { noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false },
    note: 'This check never opens a gate. Even with every entry resolved the owner still needs a content scan of backups before signing.' };
}

function arg(argv, k) { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; }
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
function run(argv) {
  const cmd = argv[0]; const pr = (o) => console.log(JSON.stringify(o, null, 1));
  if (cmd === 'exposure-check') { const r = exposureCheck(path.resolve(arg(argv, '--repo') || '.')); pr(r); return r.problems.length ? 2 : 0; }
  if (cmd === 'review-ledger') {
    const out = arg(argv, '--out');
    if (!arg(argv, '--review') || !out) throw new Error('--review and --out required');
    if (fs.existsSync(out)) throw new Error('--out exists (will not overwrite)');
    fs.writeFileSync(out, JSON.stringify(reviewLedger(readJson(arg(argv, '--review'))), null, 1), { flag: 'wx' });
    console.log('review ledger template written (ids only, all gates closed). Fill by hand.'); return 0;
  }
  if (cmd === 'review-check') { if (!arg(argv, '--ledger')) throw new Error('--ledger required'); const r = reviewCheck(readJson(arg(argv, '--ledger'))); pr(r); return r.entriesResolved ? 0 : 2; }
  throw new Error('usage: exposure-check | review-ledger | review-check');
}
module.exports = { exposureCheck, reviewLedger, reviewCheck, run };
if (require.main === module) { try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); } }
