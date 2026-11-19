'use strict';
// Mission 41E: root-name preflight, zero-match handling, subset labelling, Windows path rules, ps1 static checks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const p = require('../tools/mission41d-pack.cjs');

const ps1 = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41d-pack.ps1'), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc41e-'));

function single(name) {
  const base = tmp();
  const parent = path.join(base, name);
  fs.mkdirSync(path.join(parent, 'livecity-3dtiles-out-fukushima'), { recursive: true });
  fs.mkdirSync(path.join(parent, 'other'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'livecity-3dtiles-out-fukushima', 't.glb'), 'xxxx');
  fs.writeFileSync(path.join(parent, 'other', 'o.bin'), 'yy');
  const m = { schema: 1, parts: [
    { asset: 'a.tar', category: 'c1', files: [{ path: name + '/livecity-3dtiles-out-fukushima/t.glb', size: 4 }] },
    { asset: 'b.tar', category: 'c2', files: [{ path: name + '/other/o.bin', size: 2 }] }] };
  const mf = path.join(base, 'm.json'); fs.writeFileSync(mf, JSON.stringify(m));
  const rf = path.join(base, 'r.json'); fs.writeFileSync(rf, JSON.stringify({ [name]: parent }));
  return { base, parent, mf, rf };
}

function capture(fn) {
  const lines = []; const orig = console.log; console.log = (x) => lines.push(String(x));
  try { return { code: fn(), text: lines.join('\n') }; } finally { console.log = orig; }
}

test('single-root manifest maps via the parent folder; subset is labelled, not conflated with full', () => {
  const f = single('LiveCity'); const out = path.join(f.base, 'o1');
  const r = capture(() => p.run(['pack', '--manifest', f.mf, '--roots-file', f.rf, '--out', out, '--dry-run', '--path-contains', 'fukushima']));
  assert.strictEqual(r.code, 0);
  const rep = JSON.parse(fs.readFileSync(path.join(out, 'pack-dry-run.json'), 'utf8'));
  assert.deepStrictEqual([rep.selection.matchedFiles, rep.selection.manifestFiles, rep.selection.subset], [1, 2, true]);
  assert.match(r.text, /SUBSET dry-run: checked 1 of 2/);
});

test('full manifest run is labelled FULL', () => {
  const f = single('LiveCity'); const out = path.join(f.base, 'o0');
  const r = capture(() => p.run(['pack', '--manifest', f.mf, '--roots-file', f.rf, '--out', out, '--dry-run']));
  assert.match(r.text, /FULL manifest dry-run: checked 2 of 2/);
});

test('wrong root name gives an informative preflight error and creates nothing', () => {
  const f = single('LiveCity');
  fs.writeFileSync(f.rf, JSON.stringify({ 'livecity-3dtiles-out-fukushima': path.join(f.parent, 'livecity-3dtiles-out-fukushima') }));
  const out = path.join(f.base, 'o2');
  assert.throws(() => p.run(['pack', '--manifest', f.mf, '--roots-file', f.rf, '--out', out, '--dry-run']), /not mapped: LiveCity.*-Roots \.\./);
  assert.ok(!fs.existsSync(out));
});

test('zero-match filter exits 3, lists categories, creates nothing', () => {
  const f = single('LiveCity'); const out = path.join(f.base, 'o3');
  const r = capture(() => p.run(['pack', '--manifest', f.mf, '--roots-file', f.rf, '--out', out, '--dry-run', '--path-contains', 'nomatch']));
  assert.strictEqual(r.code, 3);
  assert.match(r.text, /NOTHING MATCHED[\s\S]*c1: 1 files[\s\S]*NOT a pass/);
  assert.ok(!fs.existsSync(out));
});

test('category-only dry-run works as the fallback; categories command lists root names', () => {
  const f = single('LiveCity'); const out = path.join(f.base, 'o4');
  assert.strictEqual(capture(() => p.run(['pack', '--manifest', f.mf, '--roots-file', f.rf, '--out', out, '--dry-run', '--only-category', 'c2'])).code, 0);
  const r = capture(() => p.run(['categories', '--manifest', f.mf]));
  assert.strictEqual(r.code, 0);
  assert.match(r.text, /c1: 1 parts[\s\S]*root names: LiveCity/);
});

test('Windows-style --out inside a root is caught case-insensitively', () => {
  assert.ok(p.isUnder('C:\\Users\\User\\LiveCity\\out', 'c:\\users\\user\\livecity', 'win32'));
  assert.ok(!p.isUnder('C:\\Users\\User\\AppData\\Local\\Temp\\livecity-pack-1', 'C:\\Users\\User\\OneDrive\\Documents\\LiveCity', 'win32'));
  assert.ok(!p.isUnder('C:\\data\\LiveCity2', 'C:\\data\\LiveCity', 'win32'));
});

test('ps1: ASCII, IsPathRooted handling, plan auto-discovery, roots default, no write commands, balanced braces', () => {
  assert.ok(!/[^\x00-\x7F]/.test(ps1));
  assert.ok(/IsPathRooted/.test(ps1));
  assert.ok(!/GetFullPath\(\(Join-Path \$cwd \$(Manifest|OutDir|PartsDir|t)\)\)/.test(ps1), 'unguarded Join-Path on a user path');
  assert.ok(/livecity-plan-\*/.test(ps1));
  assert.ok(/\$Roots = '\.\.'/.test(ps1));
  assert.ok(!/Write-Host '[^']*' \+/.test(ps1), 'Write-Host with bare + concatenation');
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest/i.test(ps1));
  let depth = 0;
  for (const c of ps1.replace(/<#[\s\S]*?#>/, '')) { if (c === '{') depth++; if (c === '}') depth--; assert.ok(depth >= 0); }
  assert.strictEqual(depth, 0);
});

test('ps1 parses under pwsh when available (syntax only, not Windows PowerShell 5.1)', (t) => {
  const r = cp.spawnSync('pwsh', ['-NoProfile', '-Command', '$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:PS1_FILE,[ref]$null,[ref]$e); if($e){$e|%{$_.Message}; exit 1}'],
  { encoding: 'utf8', env: { ...process.env, PS1_FILE: path.join(__dirname, '..', 'tools', 'mission41d-pack.ps1') } });
  if (r.error) return t.skip('pwsh not installed');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});
