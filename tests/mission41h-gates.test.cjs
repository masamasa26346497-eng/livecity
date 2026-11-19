'use strict';
// Mission 41H: gates and 41F summary/verify. Synthetic fixtures only; not run on real data or under PowerShell 5.1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const g = require('../tools/mission41h-gates.cjs');
const f = require('../tools/mission41f-pack-local.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc41h-'));

function buildZip(dir, names, zip64) {
  const cds = names.map((n) => {
    const nb = Buffer.from(n, 'utf8'); const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(0x800, 8); h.writeUInt16LE(nb.length, 28); return Buffer.concat([h, nb]);
  });
  const cd = Buffer.concat(cds); const lead = Buffer.alloc(10); const off = lead.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0);
  let tail = Buffer.alloc(0);
  if (zip64) {
    const r = Buffer.alloc(56); r.writeUInt32LE(0x06064b50, 0); r.writeBigUInt64LE(BigInt(names.length), 32); r.writeBigUInt64LE(BigInt(cd.length), 40); r.writeBigUInt64LE(BigInt(off + cd.length), 48);
    r.writeBigUInt64LE(BigInt(off), 48); // central directory offset
    const loc = Buffer.alloc(20); loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(off + cd.length), 8);
    eocd.writeUInt16LE(0xffff, 10); eocd.writeUInt32LE(0xffffffff, 12); eocd.writeUInt32LE(0xffffffff, 16);
    tail = Buffer.concat([r, loc]);
  } else { eocd.writeUInt16LE(names.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16); }
  const file = path.join(dir, 'a.zip'); fs.writeFileSync(file, Buffer.concat([lead, cd, tail, eocd])); return file;
}

test('secrets-summary prints ids and verdicts only, never values or paths', () => {
  const rev = { files: [
    { id: 'aaaa1111', ext: '.js', category: 'secrets-candidate', served: true, hits: [{ type: 'google-api-key', verdict: 'looks-real', fp: 'deadbeef' }] },
    { id: 'bbbb2222', ext: '.js', category: 'secrets-candidate', served: false, hits: [{ type: 'google-api-key', verdict: 'looks-real', fp: 'deadbeef' }] },
    { id: 'cccc3333', ext: '.example', category: 'secrets-candidate', served: false, hits: [{ type: 'google-api-key', verdict: 'placeholder', fp: '11111111' }] },
    { id: 'dddd4444', ext: '.md', category: 'other', served: false, hits: [{ type: 'email-address', verdict: 'personal-or-unknown-domain', fp: '22222222' }] },
  ] };
  const s = g.secretsSummary(rev);
  assert.strictEqual(s.candidateFiles, 4); assert.strictEqual(s.needsAction, 3); assert.strictEqual(s.sameValueGroups, 1);
  assert.ok(s.actions.length >= 3);
  const text = JSON.stringify(s);
  assert.ok(!text.includes('deadbeef') && !text.includes('11111111') && !/[A-Za-z]:\\|\/(home|Users)\//.test(text), 'no fingerprints or paths in the output');
});

test('licence ledger template is all-closed; check passes only with every field and approved:true', () => {
  const m = { parts: [{ category: 'photos', files: [{ path: 'R/a', size: 5 }] }, { category: 'other', files: [{ path: 'R/b', size: 7 }] }] };
  const t = g.ledgerTemplate(m);
  assert.deepStrictEqual(t.entries.map((e) => e.category), ['other', 'photos']);
  assert.ok(t.entries.every((e) => e.approved === false));
  assert.strictEqual(g.ledgerCheck(m, t).licenceApproved, false);
  for (const e of t.entries) Object.assign(e, { source: 's', licence: 'CC BY 4.0', redistributionAllowed: true, attribution: 'x', approvedBy: 'owner', approvedOn: '2026-10-18', approved: true });
  assert.strictEqual(g.ledgerCheck(m, t).licenceApproved, true);
  t.entries[0].redistributionAllowed = null;
  const r = g.ledgerCheck(m, t); assert.strictEqual(r.licenceApproved, false); assert.deepStrictEqual(r.categories[0].missing, ['redistributionAllowed']);
  assert.strictEqual(g.ledgerCheck(m, { entries: [] }).licenceApproved, false);
});

test('gates-status never opens a gate, even with a complete ledger', () => {
  const m = { parts: [{ category: 'c', files: [{ path: 'R/a', size: 1 }] }] };
  const led = g.ledgerTemplate(m); Object.assign(led.entries[0], { source: 's', licence: 'l', redistributionAllowed: true, attribution: 'a', approvedBy: 'o', approvedOn: 'd', approved: true });
  const st = g.gatesStatus(m, led, { files: [] });
  assert.strictEqual(st.gates.licenceApproved, true); assert.strictEqual(st.gates.noSecretsReviewed, false);
  assert.strictEqual(st.gates.noPersonalDataReviewed, false); assert.strictEqual(st.readyToUpload, false);
});

test('zip-keys reads only the central directory (plain and zip64) and prints no names', () => {
  const names = ['app/index.html', 'public/local-config.js', 'x/.env', 'k/server.pem', 'data/日本語.json'];
  for (const z64 of [false, true]) {
    const d = tmp(); const file = buildZip(d, names, z64);
    const got = g.zipNames(file); assert.deepStrictEqual(got, names);
    const r = g.zipKeyReport(got); assert.strictEqual(r.keyLikeNames, 3); assert.strictEqual(r.entries, 5);
    const text = JSON.stringify(r); assert.ok(!text.includes('local-config.js/') && !text.includes('server.pem'.slice(0, 6) + '/'));
    assert.ok(!text.includes('app/') && !text.includes('index.html'));
  }
  const d = tmp(); fs.writeFileSync(path.join(d, 'n.zip'), 'not a zip');
  assert.throws(() => g.zipNames(path.join(d, 'n.zip')), /not a zip/);
});

test('41F: error text carries the code, not the path; cloud-file failures stop with a clear hint', () => {
  const e = Object.assign(new Error("EIO: i/o error, read 'C:\\Users\\me\\OneDrive\\secret.txt'"), { code: 'EIO' });
  const t = f.explainErr(e);
  assert.ok(t.includes('EIO') && t.includes('OneDrive') && !t.includes('secret.txt') && !t.includes('Users'));
  assert.ok(!f.explainErr(new Error("bad /home/me/data/file.bin here")).includes('/home/me'));
});

test('41F: summary and independent verify detect a modified archive (offline, no sources needed)', () => {
  const base = tmp(); const root = path.join(base, 'R'); fs.mkdirSync(path.join(root, 'fukushima'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fukushima', 'a.bin'), Buffer.from('hello')); fs.writeFileSync(path.join(root, 'fukushima', 'b.bin'), Buffer.from('world!'));
  const m = { schema: 2, sizing: 'tar-estimate', parts: [{ asset: 'x-001.tar', category: '3dtiles-output', files: [{ path: 'R/fukushima/a.bin', size: 5 }, { path: 'R/fukushima/b.bin', size: 6 }] }] };
  const out = path.join(base, 'out');
  const r = f.create(m, { R: root }, { outDir: out, pathContains: 'fukushima' });
  assert.strictEqual(r.code, 0, JSON.stringify(r.report.problems));
  const lines = f.summaryLines(r.report).join('\n');
  assert.match(lines, /tar files=1 source files=2/); assert.match(lines, /sha256=[0-9a-f]{64}/); assert.ok(!lines.includes(base));
  const v = f.verifyOut(out); assert.strictEqual(v.ok, true); assert.strictEqual(v.tars.length, 1);
  const tarFile = path.join(out, r.report.parts[0].name); const buf = fs.readFileSync(tarFile); buf[600] ^= 0xff; fs.writeFileSync(tarFile, buf);
  const v2 = f.verifyOut(out); assert.strictEqual(v2.ok, false); assert.strictEqual(v2.tars[0].shaOk, false);
});

test('41H ps1 files are ASCII-only, balanced, have no delete/copy/network commands; 41F ps1 chains verify', () => {
  for (const n of ['mission41h-gates.ps1', 'mission41f-pack-local.ps1']) {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'tools', n)); const s = buf.toString('latin1');
    assert.ok(buf.every((b) => b < 128), n + ' must be ASCII');
    assert.strictEqual((s.match(/\{/g) || []).length, (s.match(/\}/g) || []).length);
    assert.strictEqual((s.match(/\(/g) || []).length, (s.match(/\)/g) || []).length);
    assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod|\bcurl\b|\bgit push\b/i.test(s), n);
  }
  const p = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41f-pack-local.ps1'), 'utf8');
  assert.match(p, /VerifyOnly/); assert.match(p, /'verify'/);
});
