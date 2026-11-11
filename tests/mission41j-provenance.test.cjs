'use strict';
// Mission 41J: synthetic fixtures only. Not run on real data or under PowerShell 5.1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const j = require('../tools/mission41j-provenance.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc41j-'));
const put = (d, rel, t) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), t); };

test('provenance: candidates only, never approved, conflicts flagged, no network/paths', () => {
  const d = tmp();
  put(d, 'config/datasets/a.json', JSON.stringify({ provider: 'MLIT Project PLATEAU', license: 'CC BY 4.0' }));
  put(d, 'config/datasets/b.json', JSON.stringify({ provider: 'PLATEAU mirror', license: 'unknown terms' }));
  put(d, 'README.md', 'OpenStreetMap ODbL facilities');
  const r = j.provenance(d);
  const pl = r.families.find((f) => f.family === 'plateau');
  assert.ok(pl.flags.includes('conflicting-or-multiple-licence-claims'));
  const osm = r.families.find((f) => f.family === 'osm');
  assert.ok(osm.flags.includes('no-explicit-licence-field-in-repo'));
  for (const f of r.families) { assert.strictEqual(f.approved, false); assert.strictEqual(f.redistributionAllowed, null); assert.strictEqual(f.status, 'owner-confirm-required'); }
  assert.ok(r.mixedOriginCategories.some((m) => m.category === '3dtiles-output'));
  assert.ok(!JSON.stringify(r).includes(d), 'no absolute path');
});

test('provenance --out refuses to overwrite', () => {
  const d = tmp(); put(d, 'README.md', 'PLATEAU'); const out = path.join(d, 'o.json');
  j.run(['provenance', '--repo', d, '--out', out]);
  assert.throws(() => j.run(['provenance', '--repo', d, '--out', out]), /will not overwrite/);
});

test('scopes: three scopes, public blocked, informational', () => {
  const s = j.scopes();
  assert.deepStrictEqual(s.rows.map((r) => r.scope), ['private-github-storage', 'claude-code-viewing', 'public-web']);
  assert.match(s.rows[2].status, /blocked/);
});

test('leak-check: flagged review id, secret-like names and local-config.js are caught; ids only', () => {
  const manifest = { parts: [{ category: 'other', files: [
    { path: 'rootA/public/local-config.js', size: 1 },
    { path: 'rootA/data/ok.json', size: 1 },
    { path: 'rootB/notes/memo.txt', size: 1 },
    { path: 'rootB/keys/my.pem', size: 1 },
    { path: 'rootB/data/flagged.json', size: 1 },
  ] }] };
  const review = { files: [{ id: j.fid('rootB', 'data/flagged.json'), hits: [{ type: 'email-address', verdict: 'personal-or-unknown-domain' }] }] };
  const r = j.leakCheck(manifest, [review]);
  assert.strictEqual(r.manifestFiles, 5);
  assert.strictEqual(r.leaks, 4);
  assert.ok(r.ids.every((x) => /^[0-9a-f]{8}$/.test(x.id)));
  assert.ok(!JSON.stringify(r).includes('flagged.json'));
  assert.deepStrictEqual(r.gates, { noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false });
  assert.ok(r.gaps.length >= 2);
});

test('leak-check: clean plan is "not proof of absence"; gates stay closed; two reviews merge', () => {
  const m = { parts: [{ category: 'boundaries', files: [{ path: 'r/a.json', size: 1 }] }] };
  const r = j.leakCheck(m, []);
  assert.strictEqual(r.leaks, 0);
  assert.match(r.verdict, /not proof/);
  assert.strictEqual(r.gates.readyToUpload, false);
  const r2 = j.leakCheck(m, [{ files: [{ id: j.fid('r', 'a.json'), hits: [{ verdict: 'looks-real' }] }] }, { files: [] }]);
  assert.strictEqual(r2.leaks, 1);
});

test('ps1 is ASCII, balanced, read-only', () => {
  const t = fs.readFileSync(path.join(__dirname, '../tools/mission41j-review.ps1'), 'utf8');
  assert.ok(!/[^\x00-\x7f]/.test(t));
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|git push|Compress-Archive/i.test(t));
  assert.strictEqual((t.match(/\{/g) || []).length, (t.match(/\}/g) || []).length);
  assert.strictEqual((t.match(/\(/g) || []).length, (t.match(/\)/g) || []).length);
});
