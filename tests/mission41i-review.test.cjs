'use strict';
// Mission 41I: synthetic fixtures only (fake key shape, temp git repos). Not run on real data.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const r = require('../tools/mission41i-review.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc41i-'));
const FAKE = 'AIza' + 'x'.repeat(35);
const git = (d, ...a) => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: d, stdio: 'ignore' });
function repo(files, ignore) {
  const d = tmp(); git(d, 'init', '-q');
  if (ignore) fs.writeFileSync(path.join(d, '.gitignore'), ignore);
  fs.mkdirSync(path.join(d, 'public'));
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(d, k), v);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'x'); return d;
}

test('ignored local config holding a key: no exposure, value never printed', () => {
  const d = repo({ 'public/index.html': '<script src="local-config.js"></script>' }, '/public/local-config.js\n');
  fs.writeFileSync(path.join(d, 'public/local-config.js'), 'window.K="' + FAKE + '"');
  const x = r.exposureCheck(d);
  assert.equal(x.configTracked, false); assert.equal(x.configGitIgnored, true);
  assert.equal(x.configPresentLocally, true); assert.equal(x.configEverCommitted, false);
  assert.equal(x.trackedFilesWithKeyShape, 0); assert.deepEqual(x.problems, []);
  assert.ok(x.pagesReferencingConfig.includes('index.html'));
  assert.ok(!JSON.stringify(x).includes(FAKE)); assert.ok(!JSON.stringify(x).includes(d));
});

test('tracked config with key shape is flagged', () => {
  const d = repo({ 'public/local-config.js': 'window.K="' + FAKE + '"' });
  const x = r.exposureCheck(d);
  assert.equal(x.configTracked, true); assert.equal(x.configEverCommitted, true);
  assert.ok(x.problems.length >= 2); assert.ok(x.trackedFilesWithKeyShape >= 1);
  assert.ok(!JSON.stringify(x).includes(FAKE));
  assert.equal(r.run(['exposure-check', '--repo', d]), 2);
});

test('this repo: local-config.js is not tracked and is ignored', () => {
  const x = r.exposureCheck(path.join(__dirname, '..'));
  assert.equal(x.configTracked, false); assert.equal(x.configGitIgnored, true);
});

const rev = { files: [
  { id: 'f1', ext: '.js', category: 'public', served: true, hits: [{ type: 'google-api-key', verdict: 'looks-real', fp: 'ab' }] },
  { id: 'f2', ext: '.json', category: 'data', served: false, hits: [{ type: 'email-address', verdict: 'personal-or-unknown-domain' }] },
  { id: 'f3', ext: '.env', category: 'x', served: false, hits: [] } ] };

test('review ledger: ids only, only the 2 action files, all gates closed', () => {
  const l = r.reviewLedger(rev);
  assert.deepEqual(l.entries.map((e) => e.id), ['f1', 'f2']);
  assert.deepEqual(l.gates, { noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false });
  assert.ok(!/path|fp/.test(Object.keys(l.entries[0]).join()));
  const c = r.reviewCheck(l); assert.equal(c.entriesResolved, false);
  const out = path.join(tmp(), 'l.json'); const rv = path.join(tmp(), 'r.json'); fs.writeFileSync(rv, JSON.stringify(rev));
  assert.equal(r.run(['review-ledger', '--review', rv, '--out', out]), 0);
  assert.throws(() => r.run(['review-ledger', '--review', rv, '--out', out]), /will not overwrite/);
});

test('review-check: complete entries resolve but never open a gate; bad combos rejected', () => {
  const l = r.reviewLedger(rev);
  const g = l.entries[0]; g.decision = 'intentional-public-restricted-key';
  for (const k of Object.keys(g.checks)) g.checks[k] = true;
  g.checks.wasEverSharedOutsideOwner = false; g.approvedBy = 'o'; g.approvedOn = '2026-10-18'; g.resolved = true;
  const m = l.entries[1]; m.classification = 'personal'; m.decision = 'approved-public-source-contact'; m.approvedBy = 'o'; m.approvedOn = 'd'; m.resolved = true;
  let c = r.reviewCheck(l);
  assert.ok(c.entries[1].missing.includes('approval-needs-public-source-classification'));
  m.decision = 'redact-then-rescan';
  c = r.reviewCheck(l);
  assert.equal(c.entriesResolved, true); assert.equal(c.gates.noSecretsReviewed, false); assert.equal(c.gates.readyToUpload, false);
  g.checks.apiRestrictionSet = false;
  assert.ok(r.reviewCheck(l).entries[0].missing.includes('public-key-needs-both-restrictions'));
});

test('tool source has no network, delete or upload calls', () => {
  const s = fs.readFileSync(path.join(__dirname, '../tools/mission41i-review.cjs'), 'utf8');
  assert.ok(!/require\('(node:)?(https?|net|dgram)'\)|fetch\(|unlinkSync|rmSync|rmdirSync|git['"],\s*\[?['"](push|remote)/.test(s));
});
