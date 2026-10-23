'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const p = require('../tools/mission41d-pack.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc41d-'));
const ROOT = '福島 データ';
function fixture() {
  const base = tmp();
  const root = path.join(base, ROOT);
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'a.json'), 'aaaa');
  fs.writeFileSync(path.join(root, 'b.bin'), Buffer.alloc(1000, 1));
  const m = { schema: 1, parts: [{ asset: 'p1.tar', category: 'x', approved: false, bytes: 1004, fileCount: 2, sha256: null,
    files: [{ path: ROOT + '/sub/a.json', size: 4 }, { path: ROOT + '/b.bin', size: 1000 }] }] };
  const mf = path.join(base, 'm.json'); fs.writeFileSync(mf, JSON.stringify(m));
  const rf = path.join(base, 'roots.json'); fs.writeFileSync(rf, JSON.stringify({ [ROOT]: root }));
  return { base, root, m, mf, rf };
}
const snap = (d) => fs.readdirSync(d, { recursive: true }).sort().map((n) => n + ':' + fs.statSync(path.join(d, n)).size).join('|');

test('checkRel rejects traversal, absolute, backslash, nul, non-normalized, overlong', () => {
  for (const [x, k] of [['r/../etc', 'path-traversal'], ['/abs/x', 'absolute-path'], ['C:/x', 'absolute-path'], ['r\\x', 'backslash'], ['r/a\0b', 'nul-byte'], ['r//x', 'non-normalized'], ['r/./x', 'non-normalized'], ['r/' + 'a'.repeat(300), 'name-too-long-for-ustar']]) assert.strictEqual(p.checkRel(x), k, x);
  assert.strictEqual(p.checkRel(ROOT + '/sub/a.json'), null);
});

test('dry-run on Japanese paths: ok, source untouched, gates closed, never ready, report anonymous', () => {
  const f = fixture(); const before = snap(f.root);
  const out = path.join(f.base, 'out');
  assert.strictEqual(p.run(['pack', '--manifest', f.mf, '--roots-file', f.rf, '--out', out, '--dry-run']), 0);
  const rep = JSON.parse(fs.readFileSync(path.join(out, 'pack-dry-run.json'), 'utf8'));
  assert.strictEqual(rep.network, false); assert.strictEqual(rep.readyToUpload, false);
  assert.ok(rep.blockedBy.includes('licenceApproved'));
  assert.ok(!JSON.stringify(rep).includes('福島'));
  assert.strictEqual(snap(f.root), before);
});

test('symlink, traversal, missing, size change, duplicate caught; out inside root refused', () => {
  const f = fixture();
  try { fs.symlinkSync(os.tmpdir(), path.join(f.root, 'link')); } catch { return; }
  const part = { asset: 'x.tar', category: 'x', files: [
    { path: ROOT + '/link', size: 1 }, { path: ROOT + '/nope', size: 1 },
    { path: ROOT + '/b.bin', size: 5 }, { path: ROOT + '/b.bin', size: 1000 }, { path: ROOT + '/../x', size: 1 }] };
  const r = p.checkPart(part, { [ROOT]: f.root }, 1.5 * p.GIB, new Map());
  const kinds = r.problems.map((x) => x.kind);
  for (const k of ['symlink-refused', 'missing', 'size-changed', 'duplicate-path', 'path-traversal']) assert.ok(kinds.includes(k), k);
  assert.strictEqual(r.ok, false);
  assert.throws(() => p.run(['pack', '--manifest', f.mf, '--roots-file', f.rf, '--out', path.join(f.root, 'o'), '--dry-run']), /outside every data root/);
});

test('tar estimate counts headers; part limit must stay under 2 GiB', () => {
  assert.ok(p.tarEstimate([{ size: Math.floor(1.5 * p.GIB) }]) > 1.5 * p.GIB);
  assert.throws(() => p.dryRun({ parts: [] }, {}, { partLimitGiB: 2 }), /< 2 GiB/);
});

test('verify finds missing, extra, truncated, checksum mismatch, duplicates; reuses cached hashes', () => {
  const d = tmp();
  const good = Buffer.alloc(1024, 7);
  for (const n of ['a.tar', 'c.tar', 'z.tar']) fs.writeFileSync(path.join(d, n), good);
  fs.writeFileSync(path.join(d, 'b.tar'), Buffer.alloc(1000, 1));
  const sha = crypto.createHash('sha256').update(good).digest('hex');
  const m = { parts: [{ asset: 'a.tar', sha256: sha }, { asset: 'b.tar', sha256: sha }, { asset: 'c.tar', sha256: 'bad' }, { asset: 'd.tar', sha256: sha }] };
  const r = p.verify(m, d, null);
  assert.deepStrictEqual(r.missing, ['d.tar']); assert.deepStrictEqual(r.extra, ['z.tar']);
  assert.ok(r.corrupt.includes('b.tar') && r.corrupt.includes('c.tar'));
  assert.ok(r.duplicatesBySha.length >= 1); assert.strictEqual(r.ok, false);
  assert.strictEqual(p.verify(m, d, r.state).state.verified['a.tar'].sha256, sha);
});

test('upload is disabled; with both confirmations it still sends nothing; no network/destructive code', () => {
  assert.strictEqual(p.upload({}, {}).enabled, false);
  assert.match(p.upload({ confirmUpload: 'I-APPROVE-PRIVATE-UPLOAD', manifestSha: 'ab' }, { LIVECITY_UPLOAD_APPROVED: 'yes-i-approved-this-exact-manifest-ab' }).reason, /not implemented/);
  const src = fs.readFileSync(path.join(__dirname, '../tools/mission41d-pack.cjs'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/node:(https?|net|dns|tls)|fetch\(|child_process|unlinkSync|rmSync|copyFile|renameSync|appendFileSync/.test(src));
});

test('41A-style inventory -> 41B manifest -> 41D dry-run, Fukushima subselection', () => {
  const b = require('../tools/mission41b-plan.cjs');
  const f = fixture();
  const mk = (rel, size) => ({ root: ROOT, rel, size, ext: path.extname(rel), category: 'osm-layers', decision: 'private-data-repo', secrets: [], secretByName: false });
  const plan = b.buildPlan({ files: [mk('sub/a.json', 4), mk('b.bin', 1000)], duplicates: [] }, {});
  const pd = path.join(f.base, 'plan'); b.emit(plan, pd);
  const out = path.join(f.base, 'o2');
  assert.strictEqual(p.run(['pack', '--manifest', path.join(pd, 'manifest.json'), '--roots-file', f.rf, '--out', out, '--dry-run', '--path-contains', '福島']), 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'pack-dry-run.json'), 'utf8')).parts, 1);
});

test('41D ps1: ASCII only, no destructive cmdlets, UTF-8 roots file; pwsh parse check when available (not PS 5.1)', () => {
  const f = path.join(__dirname, '../tools/mission41d-pack.ps1');
  const s = fs.readFileSync(f);
  assert.ok(![...s].some((c) => c > 127), 'ASCII only');
  const t = s.toString();
  assert.ok(!/Remove-Item|Copy-Item|robocopy|Move-Item|Invoke-WebRequest|Invoke-RestMethod/i.test(t.replace(/^<#[\s\S]*?#>/, '')));
  assert.ok(/UTF8Encoding\(\$false\)/.test(t) && /--dry-run/.test(t) && /LASTEXITCODE/.test(t));
  const script = '$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:PS_CHECK_FILE,[ref]$t,[ref]$e);if($e.Count){$e|ForEach-Object{$_.Message};exit 1}';
  const pw = cp.spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8', env: { ...process.env, PS_CHECK_FILE: f } });
  if (pw.error) return;
  assert.strictEqual(pw.status, 0, pw.stdout + pw.stderr);
});
