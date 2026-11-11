'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const a = require('../tools/mission41a-inventory.cjs');
const b = require('../tools/mission41b-plan.cjs');
const h = require('../tools/mission41c-hash-candidates.cjs');
const s = require('../tools/mission41c-secret-review.cjs');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const mk = (rel, size, category, extra) => ({ root: 'src', rel, size, ext: path.extname(rel), category, decision: 'private-data-repo', secrets: [], secretByName: false, ...extra });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc41c-'));

test('backup zips are not plateau-raw; PLATEAU / DEM / unknown zips are separated', () => {
  assert.strictEqual(a.classify('LiveCity-full-backup.zip', '.zip', false)[0], 'backup-archive');
  assert.strictEqual(a.classify('livecity-data-pipeline (3).zip', '.zip', false)[0], 'backup-archive');
  assert.strictEqual(a.classify('dl/27100_osaka-shi_2024_citygml_1_op.zip', '.zip', false)[0], 'plateau-raw');
  assert.strictEqual(a.classify('dl/FG-GML-5235-DEM5A.zip', '.zip', false)[0], 'dem-raw');
  assert.strictEqual(a.classify('x/FG-GML-5235-DEM5A-20250101.xml', '.xml', false)[0], 'dem-raw');
  assert.strictEqual(a.classify('misc/data.zip', '.zip', false)[0], 'archive-review');
  assert.strictEqual(a.classify('p/a.jpg', '.jpg', false)[0], 'photos-unverified-rights');
  assert.strictEqual(a.classify('.env', '', true)[0], 'secrets-candidate');
});

test('reclassify fixes an old inventory record without rescan, leaves others alone', () => {
  const old = mk('LiveCity-full-backup.zip', 8 * GB, 'plateau-raw');
  assert.strictEqual(a.reclassify(old).category, 'backup-archive');
  assert.strictEqual(a.reclassify(old).decision, 'review-deferred');
  const keep = mk('roads/t.json', MB, 'osm-layers');
  assert.strictEqual(a.reclassify(keep), keep);
  const photo = mk('p/a.jpg', MB, 'photos-unverified-rights');
  assert.strictEqual(a.reclassify(photo), photo);
});

test('deferred categories are held with a phase, and --include releases them (approved stays false); secrets never', () => {
  const files = [
    mk('LiveCity-full-backup.zip', GB, 'backup-archive', { decision: 'review-deferred' }),
    mk('raw/p.zip', MB, 'plateau-raw'),
    mk('p/a.jpg', MB, 'photos-unverified-rights', { decision: 'exclude-until-license-ledger' }),
    mk('.env', 10, 'secrets-candidate', { decision: 'exclude', secretByName: true }),
    mk('roads/t.json', MB, 'osm-layers'),
  ];
  const base = b.buildPlan({ files }, {});
  assert.deepStrictEqual(base.parts.map((p) => p.category), ['osm-layers']);
  assert.ok(base.held['backup-archive'].phase && base.held['plateau-raw'].phase === 'raw-phase-2');
  const inc = b.buildPlan({ files }, { include: ['plateau-raw', 'photos-unverified-rights', 'secrets-candidate', 'backup-archive'] });
  const cats = inc.parts.map((p) => p.category).sort();
  assert.deepStrictEqual(cats, ['backup-archive', 'osm-layers', 'photos-unverified-rights', 'plateau-raw']);
  assert.ok(inc.parts.every((p) => p.approved === false));
  assert.ok(inc.held['secrets-candidate']);
  assert.ok(inc.validation.ok);
});

test('quick command: anonymous output, one new folder, includes deferred-ledger', () => {
  const dir = tmp();
  const inv = { meta: {}, duplicates: [], files: [mk('secret-name/x.json', MB, 'osm-layers'), mk('LiveCity-full-backup.zip', 2 * GB, 'plateau-raw')] };
  const invFile = path.join(dir, 'inventory.json');
  fs.writeFileSync(invFile, JSON.stringify(inv));
  const out = path.join(dir, 'out');
  const logs = [];
  const orig = console.log; console.log = (m) => logs.push(m);
  try { b.run(['quick', '--inventory', invFile, '--out', out]); } finally { console.log = orig; }
  const text = logs.join('\n');
  assert.ok(/deferred backup-archive/.test(text));
  assert.ok(!text.includes('secret-name') && !text.includes(dir));
  assert.ok(fs.existsSync(path.join(out, 'deferred-ledger.json')) && fs.existsSync(path.join(out, 'anonymous-summary.json')));
});

test('applyHashes confirms equal hashes, removes proven false matches, keeps partially hashed groups', () => {
  const inv = { duplicates: [
    { size: 60 * MB, confirmed: false, files: ['src:a', 'src:b'] },
    { size: 61 * MB, confirmed: false, files: ['src:c', 'src:d'] },
    { size: 62 * MB, confirmed: false, files: ['src:e', 'src:f'] },
  ] };
  const r = b.applyHashes(inv, { files: { 'src:a': 'X', 'src:b': 'X', 'src:c': 'P', 'src:d': 'Q', 'src:e': 'Z' } });
  assert.strictEqual(r.duplicates.filter((d) => d.confirmed).length, 1);
  assert.ok(r.duplicates.some((d) => !d.confirmed && d.files.includes('src:e')));
  assert.ok(!r.duplicates.some((d) => d.files.includes('src:c')));
});

test('staged hashing: fingerprint rejects non-duplicates; real duplicates get a full sha256; cache resumes', () => {
  const root = tmp(); const dup1 = path.join(root, 'a.bin'); const dup2 = path.join(root, 'b.bin'); const diff = path.join(root, 'c.bin');
  const base = Buffer.alloc(3 * MB, 7);
  fs.writeFileSync(dup1, base); fs.writeFileSync(dup2, base);
  const other = Buffer.from(base); other[0] = 9; fs.writeFileSync(diff, other);
  const size = base.length;
  const inv = { duplicates: [{ size, confirmed: false, files: ['r:a.bin', 'r:b.bin', 'r:c.bin'] }] };
  const rootAsR = path.join(tmp(), 'r'); fs.mkdirSync(rootAsR); for (const f of ['a.bin', 'b.bin', 'c.bin']) fs.copyFileSync(path.join(root, f), path.join(rootAsR, f));
  const res = h.hashCandidates(inv, [rootAsR], { minMB: 1 });
  assert.strictEqual(res.stats.fullHashed, 2);
  assert.strictEqual(res.cache.files['r:a.bin'], res.cache.files['r:b.bin']);
  assert.ok(/^fp:/.test(res.cache.files['r:c.bin']));
  const merged = b.applyHashes(inv, res.cache);
  assert.deepStrictEqual(merged.duplicates.map((d) => [d.confirmed, d.files.length]), [[true, 2]]);
  const again = h.hashCandidates(inv, [rootAsR], { minMB: 1, cache: res.cache });
  assert.strictEqual(again.stats.fullHashed, 0);
  const capped = h.hashCandidates(inv, [rootAsR], { minMB: 1, maxGB: 0.000001 });
  assert.ok(capped.stats.skippedByBudget >= 1);
});

test('secret review never outputs values; classifies placeholder / real-looking / email domains', () => {
  const realKey = 'AIza' + 'Sy' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7';
  const out = JSON.stringify([
    ...s.reviewLine('google-api-key', 'window.KEY = "' + realKey + '";'),
    ...s.reviewLine('google-api-key', '// YOUR_API_KEY e.g. AIza' + 'x'.repeat(35)),
    ...s.reviewLine('email-address', 'contact: someone@example.com'),
    ...s.reviewLine('email-address', 'owner: person@gmail.com'),
  ]);
  assert.ok(!out.includes(realKey) && !out.includes('person@') &&!out.includes('someone'));
  const v = (t, l) => s.reviewLine(t, l)[0].verdict;
  assert.strictEqual(v('google-api-key', 'k="' + realKey + '"'), 'looks-real');
  assert.strictEqual(v('google-api-key', '// YOUR_API_KEY AIza' + 'x'.repeat(35)), 'placeholder');
  assert.strictEqual(v('email-address', 'a@example.com'), 'example-domain');
  assert.strictEqual(v('email-address', 'a@gmail.com'), 'personal-or-unknown-domain');
});

test('secret review end to end: report has ids and counts only, path map is separate, refuses out inside root', () => {
  const root = path.join(tmp(), 'proj'); fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  const key = 'AIza' + 'Sy' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3';
  fs.writeFileSync(path.join(root, 'public', 'local-config.js'), 'window.K="' + key + '";\n');
  const inv = { files: [{ root: 'proj', rel: 'public/local-config.js', size: 50, ext: '.js', category: 'secrets-candidate', secrets: [{ line: 1, type: 'google-api-key' }], secretByName: false }] };
  const res = s.review(inv, [root], {});
  assert.strictEqual(res.needsAction.length, 1);
  assert.strictEqual(res.files[0].served, true);
  const out = path.join(tmp(), 'o');
  s.emit(res, out);
  const rep = fs.readFileSync(path.join(out, 'secret-review.json'), 'utf8');
  assert.ok(!rep.includes(key) && !rep.includes('local-config') && !rep.includes('proj'));
  assert.ok(fs.existsSync(path.join(out, 'LOCAL-ONLY-id-to-path.json')));
  assert.ok(fs.readFileSync(path.join(root, 'public', 'local-config.js'), 'utf8').includes(key)); // source untouched
  assert.throws(() => s.run(['--inventory', 'x', '--roots', root, '--out', path.join(root, 'o')]), /outside/);
});

test('41C tools: no network / delete / copy code; ps1 are ASCII-only with balanced quotes and no destructive cmdlets', () => {
  for (const f of ['mission41c-hash-candidates.cjs', 'mission41c-secret-review.cjs']) {
    const src = fs.readFileSync(path.join(__dirname, '../tools', f), 'utf8');
    assert.ok(!/require\(['"]node:(https?|net|child_process)['"]\)|fetch\(|unlinkSync|rmSync|copyFile|renameSync/.test(src), f);
  }
  for (const f of ['mission41c-quick.ps1', 'mission41c-hash.ps1', 'mission41c-secrets.ps1']) {
    const buf = fs.readFileSync(path.join(__dirname, '../tools', f));
    assert.ok(buf.every((x) => x < 128), f + ' must be ASCII');
    const src = buf.toString('utf8');
    assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod/i.test(src), f);
    const code = src.replace(/<#[\s\S]*?#>/, '');
    assert.strictEqual((code.match(/\{/g) || []).length, (code.match(/\}/g) || []).length, f + ' braces');
    assert.strictEqual((code.match(/\(/g) || []).length, (code.match(/\)/g) || []).length, f + ' parens');
    assert.ok(code.split('\n').every((l) => ((l.replace(/#.*$/, '').match(/'/g) || []).length % 2) === 0), f + ' quotes');
  }
});
