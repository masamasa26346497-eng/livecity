'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inv = require('../tools/mission41a-inventory.cjs');

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc41a-'));
  const w = (rel, content) => { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };
  w('buildings/osaka-kita/tile_1.json', '{"a":1}');
  w('buildings/osaka-kita/tile_2.json', '{"a":1}');
  w('node_modules/x/index.js', 'x');
  w('.env', 'K=1');
  w('src/config.js', 'const k="AIza' + 'A'.repeat(35) + '";');
  w('photos/a.jpg', 'jpgdata');
  w('out/fukushima/tileset.json', '{}');
  fs.writeFileSync(path.join(d, 'out', 'big.bin'), Buffer.alloc(1024 * 1024 + 5, 7));
  fs.writeFileSync(path.join(d, 'out', 'big2.bin'), Buffer.alloc(1024 * 1024 + 5, 7));
  return d;
}

test('inventory classifies, flags secrets without storing values, excludes node_modules', () => {
  const d = fixture();
  const r = inv.inventory([d], { hash: false });
  const by = (rel) => r.files.find((f) => f.rel === rel);
  assert.strictEqual(by('.env').category, 'secrets-candidate');
  assert.strictEqual(by('src/config.js').category, 'secrets-candidate');
  assert.ok(by('src/config.js').secrets.some((s) => s.type === 'google-api-key'));
  assert.ok(!JSON.stringify(r.files).includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'secret value must not be stored');
  assert.strictEqual(by('photos/a.jpg').decision, 'exclude-until-license-ledger');
  assert.strictEqual(by('buildings/osaka-kita/tile_1.json').category, 'building-tiles');
  assert.ok(!r.files.some((f) => f.rel.startsWith('node_modules')));
  assert.strictEqual(r.cats['node-modules-cache'].files, 1);
});

test('duplicates: size candidates unconfirmed, sha256 confirms', () => {
  const d = fixture();
  const a = inv.inventory([d], { hash: false });
  assert.ok(a.dupCandidates.length === 1 && a.dupCandidates[0].confirmed === false);
  const b = inv.inventory([d], { hash: true });
  assert.ok(b.dupCandidates[0].confirmed === true && b.dupCandidates[0].sha256);
});

test('plan: 100MB threshold and strategy by size; excluded never planned', () => {
  const files = [
    { root: 'r', rel: 'a/big.glb', size: 150 * 1024 * 1024, category: '3dtiles-output', decision: 'private-data-repo' },
    { root: 'r', rel: 'b/mid.json', size: 60 * 1024 * 1024, category: 'building-tiles', decision: 'private-data-repo' },
    { root: 'r', rel: '.env', size: 10, category: 'secrets-candidate', decision: 'exclude' },
  ];
  const p = inv.plan(files);
  assert.strictEqual(p.filesOver100MB.length, 1);
  assert.strictEqual(p.filesOver50MB.length, 1);
  assert.ok(/git-lfs/.test(p.bigFileStrategy));
  assert.strictEqual(p.singleRepoOk, false);
  assert.ok(!JSON.stringify(p.parts).includes('.env'));
  const huge = [{ root: 'r', rel: 'z/x.glb', size: 1.5 * 1024 ** 3, category: '3dtiles-output', decision: 'private-data-repo' }];
  assert.ok(/split-archive/.test(inv.plan(huge).bigFileStrategy));
});

test('run: writes new files only, refuses non-empty or in-root out, leaves source untouched', () => {
  const d = fixture();
  const before = fs.readdirSync(d, { recursive: true }).sort().join('|');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lc41a-out-'));
  const origLog = console.log; console.log = () => {};
  try { inv.run(['--roots', d, '--out', path.join(out, 'o')]); } finally { console.log = origLog; }
  assert.ok(fs.existsSync(path.join(out, 'o', 'report.md')));
  assert.ok(fs.existsSync(path.join(out, 'o', 'upload-plan.json')));
  assert.strictEqual(fs.readdirSync(d, { recursive: true }).sort().join('|'), before);
  assert.throws(() => inv.run(['--roots', d, '--out', path.join(out, 'o')]), /not empty/);
  assert.throws(() => inv.run(['--roots', d, '--out', path.join(d, 'inside')]), /inside a root/);
});

test('no network, no deletion/copy/upload code in tool; ps1 is ASCII and safe', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41a-inventory.cjs'), 'utf8');
  assert.ok(!/require\(['"]node:(https?|net|child_process)['"]\)|fetch\(|unlinkSync|rmSync|copyFileSync|renameSync/.test(js));
  const buf = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41a-inventory.ps1'));
  for (const b of buf) assert.ok(b < 128);
  const ps = buf.toString('utf8');
  assert.ok(!/Remove-Item|Copy-Item|robocopy|Move-Item|git push|Invoke-WebRequest|Invoke-RestMethod/i.test(ps));
  assert.ok(/\$LASTEXITCODE/.test(ps));
  const code = ps.replace(/<#[\s\S]*?#>/, '');
  assert.strictEqual((code.match(/\{/g) || []).length, (code.match(/\}/g) || []).length);
  for (const line of code.split('\n')) assert.strictEqual((line.match(/'/g) || []).length % 2, 0, line);
});

test('ps1 (PS 5.1 -File semantics): extra roots never become OutDir; commas/semicolons split; default out in TEMP', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41a-inventory.ps1'), 'utf8');
  assert.ok(/PositionalBinding\s*=\s*\$false/.test(ps));
  assert.ok(/ValueFromRemainingArguments\s*=\s*\$true\)\]\[string\[\]\]\$Roots/.test(ps));
  assert.ok(/-split '\[;,\]'/.test(ps));
  assert.ok(/GetTempPath\(\)/.test(ps));
  assert.ok(!/Split-Path -Parent \$repo\) \('livecity-inventory/.test(ps));
  assert.ok(/OutDir must be outside every scanned root/.test(ps));
  assert.ok(!/Position\s*=\s*\d/.test(ps));
});

test('cjs failure cases: non-empty out and out-inside-root refused; multiple roots with semicolon work', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'lc41a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'lc41b-'));
  fs.writeFileSync(path.join(a, 'x.txt'), 'x');
  fs.writeFileSync(path.join(b, 'y.txt'), 'y');
  const full = fs.mkdtempSync(path.join(os.tmpdir(), 'lc41o-'));
  fs.writeFileSync(path.join(full, 'z'), 'z');
  assert.throws(() => inv.run(['--roots', a + ';' + b, '--out', full]), /not empty/);
  assert.throws(() => inv.run(['--roots', a + ';' + b, '--out', path.join(a, 'o')]), /inside a root/);
  const out = path.join(os.tmpdir(), 'lc41new-' + Date.now());
  inv.run(['--roots', a + ';' + b, '--out', out]);
  assert.ok(fs.existsSync(path.join(out, 'report.md')));
});


test('ps1: absolute TEMP OutDir is passed directly to GetFullPath, not joined with cwd', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41a-inventory.ps1'), 'utf8');
  assert.ok(/IsPathRooted\(\$OutDir\)/.test(ps));
  assert.ok(/if \(\[System\.IO\.Path\]::IsPathRooted\(\$OutDir\)\) \{\s*\$OutDir = \[System\.IO\.Path\]::GetFullPath\(\$OutDir\)/.test(ps));
});
