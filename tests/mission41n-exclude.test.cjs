'use strict';
// Mission 41N: synthetic fixtures only (no real data). Phone-like values below are fake test strings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const n = require('../tools/mission41n-exclude.cjs');
const f41 = require('../tools/mission41f-pack-local.cjs');
const k = require('../tools/mission41k-content-scan.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc41n-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function geo() {
  return { type: 'FeatureCollection', license: 'CC-BY-4.0', source: 'fixture-source', features: [
    { type: 'Feature', id: 'a-1', geometry: { type: 'Polygon', coordinates: [[[135.5, 34.6], [135.6, 34.6], [135.6, 34.7], [135.5, 34.6]]] }, properties: { name: 'X', phone: '06-1234-5678', fax: '06-1111-2222' } },
    { type: 'Feature', id: 'b-2', geometry: { type: 'Point', coordinates: [135.55, 34.65] }, properties: { name: 'Y', phone: '090-1234-5678', note: 'x' } },
  ] };
}

function fixture() {
  const base = tmp(); const root = path.join(base, 'LiveCity');
  const files = { 'boundaries/wards.json': Buffer.from(JSON.stringify(geo())), 'boundaries/other.json': Buffer.from('{"a":1}'), 'misc/m.txt': Buffer.from('hello') };
  for (const [rel, buf] of Object.entries(files)) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
  const e = (rel) => ({ path: 'LiveCity/' + rel, size: files[rel].length });
  const m = { schema: 2, sizing: 'tar-estimate', parts: [
    { asset: 'lcdata-boundaries-001.tar', category: 'boundaries', files: [e('boundaries/wards.json'), e('boundaries/other.json')] },
    { asset: 'lcdata-misc-002.tar', category: 'other', files: [e('misc/m.txt')] }] };
  const id = k.fid('LiveCity', 'boundaries/wards.json');
  return { base, root, files, m, id, roots: { LiveCity: root } };
}

test('dry-run finds the id anonymously, shows impact, and writes nothing', () => {
  const x = fixture();
  const r = n.dryRun(x.m, [x.id]);
  assert.strictEqual(r.found.length, 1);
  assert.strictEqual(r.found[0].category, 'boundaries');
  assert.strictEqual(r.totalsAfter.files, r.totalsBefore.files - 1);
  assert.ok(r.totalsAfter.bytes < r.totalsBefore.bytes);
  assert.strictEqual(r.affectedParts.length, 1);
  assert.strictEqual(r.affectedParts[0].subsetNameTar, true);
  assert.strictEqual(r.affectedParts[0].fullPartTarNameStillProduced, false);
  assert.strictEqual(r.wrote, false); assert.strictEqual(r.autoExcluded, false);
  for (const v of Object.values(r.gates)) assert.strictEqual(v, false);
  const text = JSON.stringify(r);
  assert.ok(!/wards\.json|boundaries\/|LiveCity/.test(text), 'no path may appear');
  assert.deepStrictEqual(r.notInManifest, []);
  assert.deepStrictEqual(n.dryRun(x.m, ['00000000']).notInManifest, ['00000000']);
});

test('dry-run flags an existing 41F tar that contains the held id; tar untouched', () => {
  const x = fixture(); const out = path.join(x.base, 'out');
  const c = f41.create(x.m, x.roots, { outDir: out });
  assert.strictEqual(c.code, 0, JSON.stringify(c.report.problems));
  const tars = fs.readdirSync(out).filter((s) => s.endsWith('.tar'));
  const before = tars.map((t) => sha(fs.readFileSync(path.join(out, t))));
  const r = n.dryRun(x.m, [x.id], { tarDir: out });
  assert.strictEqual(r.existingTars.checked, tars.length);
  assert.strictEqual(r.existingTars.mustRepackCount, 1);
  assert.ok(!JSON.stringify(r).includes('lcdata-'), 'tar names are not printed');
  assert.deepStrictEqual(tars.map((t) => sha(fs.readFileSync(path.join(out, t)))), before);
});

test('write-plan creates a new ids-only file, refuses a non-empty folder; 41F honours it and never touches sources', () => {
  const x = fixture(); const planDir = path.join(x.base, 'plan');
  const file = n.writePlan([x.id], planDir, {});
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(plan.excludeIds, [x.id]);
  assert.ok(!/LiveCity|wards/.test(fs.readFileSync(file, 'utf8')));
  assert.throws(() => n.writePlan([x.id], planDir, {}), /not empty/);
  const before = sha(fs.readFileSync(path.join(x.root, 'boundaries', 'wards.json')));
  const mf = path.join(x.base, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify(x.m));
  const rf = path.join(x.base, 'roots.json'); fs.writeFileSync(rf, JSON.stringify(x.roots));
  const out = path.join(x.base, 'out2');
  const res = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'mission41f-pack-local.cjs'), 'create', '--manifest', mf, '--roots-file', rf, '--out', out, '--exclude-plan', file], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /by exclusion plan: 1 files/);
  const names = fs.readdirSync(out).filter((s) => s.endsWith('.tar'));
  let members = [];
  for (const t of names) members = members.concat(f41.readTar(path.join(out, t)).map((mb) => mb.name));
  assert.ok(!members.includes('LiveCity/boundaries/wards.json'));
  assert.ok(members.includes('LiveCity/boundaries/other.json'));
  assert.strictEqual(sha(fs.readFileSync(path.join(x.root, 'boundaries', 'wards.json'))), before);
  const bad = path.join(x.base, 'bad.json'); fs.writeFileSync(bad, '{"tool":"x","excludeIds":["zz"]}');
  const r2 = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'mission41f-pack-local.cjs'), 'create', '--manifest', mf, '--roots-file', rf, '--out', path.join(x.base, 'out3'), '--exclude-plan', bad], { encoding: 'utf8' });
  assert.notStrictEqual(r2.status, 0);
});

test('sanitize: blanks only contact-key strings; geometry, ids, feature count, source metadata stay identical; verified', () => {
  const src = geo();
  const r = n.sanitizeAndVerifyInMemory(src);
  assert.strictEqual(r.ok, true, JSON.stringify(r.verify));
  assert.strictEqual(r.stats.blanked, 3);
  assert.strictEqual(r.matchesBefore, 3); // fax and 090 and 06 phone-shaped values
  assert.strictEqual(r.matchesAfter, 0);
  assert.deepStrictEqual(r.value.features.map((f) => f.geometry), src.features.map((f) => f.geometry));
  assert.deepStrictEqual(r.value.features.map((f) => f.id), ['a-1', 'b-2']);
  assert.strictEqual(r.value.license, 'CC-BY-4.0');
  assert.strictEqual(r.value.features[1].properties.note, 'x');
  assert.strictEqual(r.value.features[0].properties.phone, '');
  assert.ok(JSON.stringify(src).includes('06-1234-5678'), 'input object is not mutated');
});

test('sanitize refuses (ok=false) when a phone-like value sits under a NON-contact key, or the contact value is structured', () => {
  const a = geo(); a.features[0].properties.memo = 'call 06-9999-0000 now';
  const ra = n.sanitizeAndVerifyInMemory(a);
  assert.strictEqual(ra.ok, false); assert.ok(ra.nonContactMatchesRemaining > 0);
  const b = geo(); b.features[0].properties.phone = { x: '06-1234-5678' };
  assert.strictEqual(n.sanitizeAndVerifyInMemory(b).ok, false);
});

test('verifier detects tampering with geometry, ids, length and source metadata', () => {
  const src = geo(); const s = n.sanitizeValue(src).value;
  assert.strictEqual(n.verifySanitized(src, s).problem, null);
  const g = JSON.parse(JSON.stringify(s)); g.features[0].geometry.coordinates[0][0][0] = 1;
  const rg = n.verifySanitized(src, g); assert.ok(rg.problem); assert.strictEqual(rg.geometryUnchanged, false);
  const i = JSON.parse(JSON.stringify(s)); i.features[0].id = 'zzz';
  assert.strictEqual(n.verifySanitized(src, i).idsUnchanged, false);
  const t = JSON.parse(JSON.stringify(s)); t.features.pop();
  assert.strictEqual(n.verifySanitized(src, t).featureCountEqual, false);
  const m = JSON.parse(JSON.stringify(s)); m.license = 'other';
  assert.strictEqual(n.verifySanitized(src, m).sourceMetadataEqual, false);
  const c = JSON.parse(JSON.stringify(s)); c.features[0].properties.phone = '06-1234-5678';
  assert.strictEqual(n.verifySanitized(src, c).contactValuesAllBlank, false);
});

test('createSanitizedCopy (fixture): needs the approval flag, writes only to a new folder, source unchanged, licence not approved', () => {
  const x = fixture(); const src = path.join(x.root, 'boundaries', 'wards.json'); const before = sha(fs.readFileSync(src));
  const dest = path.join(x.base, 'derived');
  assert.throws(() => n.createSanitizedCopy(src, dest, {}), /approval/);
  assert.ok(!fs.existsSync(dest));
  assert.throws(() => n.createSanitizedCopy(src, path.join(x.root, 'boundaries', 'd'), { ownerApproved: true }), /outside/);
  const rec = n.createSanitizedCopy(src, dest, { ownerApproved: true, sourceId: x.id });
  assert.strictEqual(rec.licence.approved, false); assert.strictEqual(rec.verify.problem, null);
  const out = JSON.parse(fs.readFileSync(path.join(dest, 'wards.json'), 'utf8'));
  assert.strictEqual(out.features[0].properties.phone, '');
  assert.strictEqual(sha(fs.readFileSync(src)), before);
  assert.throws(() => n.createSanitizedCopy(src, dest, { ownerApproved: true }), /not empty/);
});

test('sanitize-plan CLI is read-only, prints no value/path, and the CLI cannot create a derived copy', () => {
  const x = fixture();
  const mf = path.join(x.base, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify(x.m));
  const rf = path.join(x.base, 'roots.json'); fs.writeFileSync(rf, JSON.stringify(x.roots));
  const listing = () => fs.readdirSync(x.root, { recursive: true }).sort().join('|');
  const l0 = listing(); const h0 = sha(fs.readFileSync(path.join(x.root, 'boundaries', 'wards.json')));
  const res = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'mission41n-exclude.cjs'), 'sanitize-plan', '--manifest', mf, '--roots-file', rf, '--id', x.id], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  const o = JSON.parse(res.stdout);
  assert.strictEqual(o.wrote, false); assert.strictEqual(o.verification.passed, true); assert.strictEqual(o.wouldBlankValues, 3);
  assert.ok(!/1234|5678|1111|LiveCity|wards|phone|fax/.test(res.stdout), 'no value, key name or path');
  assert.strictEqual(listing(), l0); assert.strictEqual(sha(fs.readFileSync(path.join(x.root, 'boundaries', 'wards.json'))), h0);
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41n-exclude.cjs'), 'utf8');
  const runFn = src.slice(src.indexOf('function run(argv)'), src.indexOf('module.exports'));
  assert.ok(!/createSanitizedCopy|writeFileSync/.test(runFn.replace(/writePlan\(/g, '')), 'run() must not reach createSanitizedCopy');
  assert.ok(!/https?:|require\('node:(?:https?|net|dns)'\)|fetch\(/.test(src), 'no network code');
  assert.ok(!/unlinkSync|rmSync|rmdirSync|renameSync|appendFileSync/.test(src), 'no delete/move code');
});

test('PowerShell wrapper is ASCII-only, balanced, and has no delete/copy/network commands', () => {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41n-exclude.ps1'));
  assert.ok(buf.every((b) => b < 128), 'non-ASCII byte found');
  const s = buf.toString('utf8');
  assert.strictEqual((s.match(/\{/g) || []).length, (s.match(/\}/g) || []).length);
  assert.strictEqual((s.match(/\(/g) || []).length, (s.match(/\)/g) || []).length);
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod|\bcurl\b|Set-Content|Out-File/i.test(s));
  assert.match(s, /\$LASTEXITCODE/);
});
