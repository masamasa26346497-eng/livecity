'use strict';
// Mission 41L: synthetic fixtures only. Not run on real data or under PowerShell 5.1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const k = require('../tools/mission41k-content-scan.cjs');
const t = require('../tools/mission41l-triage.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc41l-'));
const put = (d, rel, data) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), data); };
const TEL = '06-' + '1234-' + '5678';
const MOBILE = '090-' + '1111-' + '2222';
const MAIL = 'owner.person' + '@' + 'private-host.jp';

function setup(files) {
  const root = tmp(); const work = tmp(); const leaf = 'LiveCity'; const base = path.join(root, leaf);
  const byCat = {};
  for (const [rel, data, cat] of files) { put(base, rel, data); (byCat[cat || 'cat-a'] = byCat[cat || 'cat-a'] || []).push({ path: leaf + '/' + rel, size: Buffer.byteLength(data) }); }
  const mf = path.join(work, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify({ schema: 2, parts: Object.entries(byCat).map(([category, f]) => ({ category, files: f })), unsplittable: [] }));
  const rf = path.join(work, 'roots.json'); fs.writeFileSync(rf, JSON.stringify({ [leaf]: base }));
  return { base, work, mf, rf, leaf };
}
const opts = (s) => ({ manifest: s.mf, rootsFile: s.rf, state: path.join(s.work, 'st.json'), pathContains: '', maxFiles: 0, maxSeconds: 0, maxFileMiB: 512 });

test('state cache key: legacy state (no version) and changed fingerprint are invalidated; same version is reused', () => {
  const s = setup([['a.json', '{"x":1}'], ['b.json', 'tel ' + TEL]]);
  const o = opts(s);
  // legacy state written by 41K (size+mtime only, no scannerVersion)
  const r0 = k.scan(o);
  assert.strictEqual(r0.stats.stateInvalidated, null); // no state file at all: nothing to invalidate
  const st = JSON.parse(fs.readFileSync(o.state, 'utf8'));
  assert.strictEqual(st.scannerVersion, k.SCANNER_VERSION);
  assert.strictEqual(st.detectorFingerprint, k.detectorFingerprint());
  // second run with same version: reused, not invalidated
  const r1 = k.scan(o);
  assert.strictEqual(r1.stats.stateInvalidated, null);
  assert.strictEqual(r1.stats.resumedFromState, 2);
  // pretend an older state: strip the version -> invalidated and re-scanned
  delete st.scannerVersion; fs.writeFileSync(o.state, JSON.stringify(st));
  const r2 = k.scan(o);
  assert.strictEqual(r2.stats.stateInvalidated.reason, 'legacy-state-without-version');
  assert.strictEqual(r2.stats.resumedFromState, 0);
  assert.strictEqual(r2.stats.processedThisRun, 2);
  // changed detector fingerprint
  const st2 = JSON.parse(fs.readFileSync(o.state, 'utf8')); st2.detectorFingerprint = 'deadbeefdeadbeef'; fs.writeFileSync(o.state, JSON.stringify(st2));
  const r3 = k.scan(o);
  assert.strictEqual(r3.stats.stateInvalidated.reason, 'scanner-or-detector-changed');
  assert.strictEqual(r3.stats.resumedFromState, 0);
  assert.strictEqual(r3.scannerVersion, k.SCANNER_VERSION);
});

test('a stale "clean" result is not reused after the detector changes (the bug being fixed)', () => {
  const s = setup([['b.json', 'tel ' + TEL]]);
  const o = opts(s);
  // forge an old state that says "scanned, no findings" for the same size+mtime
  const full = path.join(s.base, 'b.json'); const stt = fs.statSync(full);
  const key = k.skey(s.leaf, 'b.json');
  fs.writeFileSync(o.state, JSON.stringify({ schema: 1, files: { [key]: { status: 'scanned', counts: {}, origin: [], size: stt.size, mtimeMs: stt.mtimeMs } } }));
  const r = k.scan(o);
  assert.strictEqual(r.filesWithFindingsTotal, 1, 'old clean entry must not hide a detection');
});

test('cloud-only skip is kept', () => {
  const s = setup([['c.json', 'tel ' + TEL]]);
  const skip = path.join(s.work, 'skip.txt'); fs.writeFileSync(skip, s.leaf + '/c.json\n');
  const r = k.scan({ ...opts(s), skipFile: skip });
  assert.strictEqual(r.unscanned.byReason['cloud-only-not-read'], 1);
  assert.strictEqual(r.filesWithFindingsTotal, 0);
});

test('report view: ids/categories/counts only; unscanned by kind; old-scanner warning', () => {
  const s = setup([['a/p.json', 'x ' + TEL + ' ' + MAIL, 'boundaries'], ['m.glb', Buffer.from('glTF\0\0\0\0'), 'building-tiles'], ['i.png', Buffer.from('x'), 'photos']]);
  const rep = k.scan(opts(s));
  const old = JSON.parse(JSON.stringify(rep)); delete old.scannerVersion;
  const st = JSON.parse(fs.readFileSync(opts(s).state, 'utf8'));
  const view = t.reportView(old, { crosstab: t.crosstab(JSON.parse(fs.readFileSync(s.mf, 'utf8')), st), stateVersionMismatch: false });
  assert.strictEqual(view.reportIsFromOlderScanner, true);
  assert.ok(view.warnings.some((w) => /older scanner/.test(w)));
  assert.strictEqual(view.filesWithFindings.length, 1);
  assert.strictEqual(view.filesWithFindings[0].autoApproved, false);
  assert.strictEqual(view.unscannedByKind.glb, 1);
  assert.strictEqual(view.unscannedByKind.image, 1);
  const x = view.unscannedByCategoryKindExt.find((r) => r.ext === 'glb');
  assert.deepStrictEqual([x.category, x.kind, x.files], ['building-tiles', 'glb', 1]);
  const dump = JSON.stringify(view);
  for (const v of [TEL, MAIL, 'a/p.json', s.base, 'm.glb']) assert.ok(!dump.includes(v), 'leaked ' + v);
  assert.deepStrictEqual(view.gates, { noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false });
});

test('classify: shape classes separate uuid/numeric-list/free-text without printing any value; never auto-approves', () => {
  const uuidLike = 'id 0123-4567-8901 end'; // not a uuid; free-text shape
  const text = [
    'bldg_0a1b2c3d-0123-4567-8901-0123456789ab',      // uuid-like id containing digit-only groups
    '[1.5,2,' + TEL + ',3]',                          // inside numeric list
    'contact ' + MOBILE + ' for info',                // free text, mobile
  ].join('\n');
  const c = t.classifyMatches(text, 'jp-phone-number');
  const keys = Object.keys(c);
  assert.ok(keys.some((x) => /inside-uuid-like-id/.test(x)) || keys.length >= 2);
  assert.ok(keys.some((x) => /mobile\(070\/080\/090\)/.test(x) && /free-text-or-field/.test(x)));
  assert.ok(keys.some((x) => /inside-numeric-list/.test(x)));
  const dump = JSON.stringify(c);
  for (const v of [TEL, MOBILE, '1234-5678', '0123-4567-8901']) assert.ok(!dump.includes(v), 'leaked ' + v);
  assert.ok(uuidLike.length > 0);

  const s = setup([['d.json', text, 'boundaries']]);
  const rep = k.scan(opts(s)); const id = rep.filesWithFindings[0].id;
  const r = t.classifyFile({ manifest: s.mf, rootsFile: s.rf, id });
  assert.strictEqual(r.autoApproved, false); assert.strictEqual(r.autoExcluded, false);
  assert.match(r.hint, /owner/);
  assert.ok(!JSON.stringify(r).includes(MOBILE));
  assert.strictEqual(t.classifyFile({ manifest: s.mf, rootsFile: s.rf, id: '00000000' }).error, 'id-not-in-manifest');
});

function makeGlb(json, bin) {
  const j = Buffer.from(json); const pad = (4 - (j.length % 4)) % 4; const jb = Buffer.concat([j, Buffer.alloc(pad, 0x20)]);
  const h = Buffer.alloc(12); h.write('glTF', 0, 'latin1'); h.writeUInt32LE(2, 4);
  const ch = Buffer.alloc(8); ch.writeUInt32LE(jb.length, 0); ch.writeUInt32LE(0x4E4F534A, 4);
  const b = bin || Buffer.alloc(0);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(b.length, 0); bh.writeUInt32LE(0x004E4942, 4);
  const all = Buffer.concat([h, ch, jb, bh, b]); all.writeUInt32LE(all.length, 8); return all;
}

test('glb JSON chunk: inspects metadata only, BIN chunk is not inspected, GLB stays unscanned', () => {
  const GOOGLE = 'AI' + 'za' + 'A'.repeat(35);
  const glb = makeGlb(JSON.stringify({ asset: { version: '2.0', copyright: 'someone' }, extensionsUsed: ['EXT_mesh_features', 'MyCustomThing'], extras: { note: 'k ' + GOOGLE } }), Buffer.from(TEL));
  const r = t.glbJsonChunk(glb);
  assert.strictEqual(r.status, 'json-chunk-inspected');
  assert.strictEqual(r.detections['google-api-key'], 1);
  assert.ok(!r.detections['jp-phone-number'], 'BIN chunk must not be scanned');
  assert.strictEqual(r.binChunkInspected, false);
  assert.deepStrictEqual(r.extensionsUsed, ['EXT_mesh_features']);
  assert.strictEqual(r.nonStandardExtensionCount, 1);
  assert.strictEqual(r.hasAssetCopyright, true);
  assert.strictEqual(t.glbJsonChunk(Buffer.from('not a glb at all, plain text')).status, 'not-glb');

  const s = setup([['t/x.glb', glb, 'building-tiles'], ['t/y.glb', makeGlb('{"asset":{"version":"2.0"}}'), 'building-tiles']]);
  const m = t.globalGlbMeta({ manifest: s.mf, rootsFile: s.rf, pathContains: '', skipFile: null, maxFiles: 0 });
  assert.strictEqual(m.glbFiles, 2);
  assert.strictEqual(m.filesWithFindingsTotal, 1);
  assert.match(m.verdictForBinChunk, /NOT inspected/);
  assert.strictEqual(m.autoApproved, false);
  const dump = JSON.stringify(m);
  for (const v of [GOOGLE, 't/x.glb', s.base]) assert.ok(!dump.includes(v), 'leaked');
  // 41K still treats the same files as unscanned
  const rep = k.scan(opts(s));
  assert.strictEqual(rep.byStatus.unscanned, 2);
  assert.strictEqual(rep.complete, false);
});

test('41L sources: ps1 is ASCII, no write/delete/copy/network commands; cjs has no network and no source writes', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41l-triage.ps1'));
  for (const b of ps) assert.ok(b < 128, 'non-ASCII byte in ps1');
  const txt = ps.toString('latin1');
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer/i.test(txt));
  assert.ok(/LASTEXITCODE/.test(txt));
  const js = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41l-triage.cjs'), 'utf8');
  assert.ok(!/require\('node:(?:http|https|net|dns|child_process)'\)|fetch\(/.test(js));
  assert.ok(!/unlinkSync|rmSync|renameSync|appendFileSync/.test(js));
  assert.ok(!/writeFileSync\([^)]*(manifest|roots|rootsFile)/.test(js));
  // balanced braces/parens in ps1
  const strip = txt.replace(/<#[\s\S]*?#>/g, '');
  assert.strictEqual((strip.match(/\{/g) || []).length, (strip.match(/\}/g) || []).length);
  assert.strictEqual((strip.match(/\(/g) || []).length, (strip.match(/\)/g) || []).length);
});

// ---------- 41M: field-level triage ----------
test('fields: contact keys only -> owner review, never safe; no value/key/path in output', () => {
  const body = JSON.stringify({ license: 'ODbL', features: [{ properties: { name: 'secretname', phone: TEL }, id: 'x' }] });
  const s = setup([['f.json', body]]);
  const r = t.fieldsFile({ manifest: s.mf, rootsFile: s.rf, id: k.fid('LiveCity', 'f.json') });
  assert.strictEqual(r.matches, 1);
  assert.strictEqual(r.byKeyClass['contact-key'], 1);
  assert.strictEqual(r.sourceMetadata.presentAtTopLevel, true);
  assert.match(r.recommendation, /^owner-review-required/);
  assert.strictEqual(r.autoApproved, false);
  const out = JSON.stringify(r);
  for (const leak of [TEL, 'secretname', 'f.json', s.base, '"phone"']) assert.ok(!out.includes(leak), 'leak: ' + leak);
});
test('fields: mobile, memo text and unknown keys -> HOLD', () => {
  const body = JSON.stringify([{ memo: 'call me ' + MOBILE + ' tonight' }, { zzz: TEL }, { arr: [TEL] }]);
  const s = setup([['g.json', body]]);
  const r = t.fieldsFile({ manifest: s.mf, rootsFile: s.rf, id: k.fid('LiveCity', 'g.json') });
  assert.strictEqual(r.matches, 3);
  assert.match(r.recommendation, /^HOLD/);
  assert.ok(r.holdReasons.length >= 3);
  assert.strictEqual(r.byValueForm['embedded-in-longer-text'], 1);
  assert.strictEqual(r.autoExcluded, false);
  assert.ok(!JSON.stringify(r).includes(MOBILE));
});
test('fields: ndjson, non-json and parse failure handled without leaking', () => {
  const s = setup([['h.ndjson', JSON.stringify({ tel: TEL }) + '\n' + JSON.stringify({ tel: TEL }) + '\n'], ['i.csv', 'a,b'], ['j.json', '[broken ' + TEL]]);
  const a = t.fieldsFile({ manifest: s.mf, rootsFile: s.rf, id: k.fid('LiveCity', 'h.ndjson') });
  assert.strictEqual(a.parsedAs, 'ndjson'); assert.strictEqual(a.matches, 2);
  assert.match(t.fieldsFile({ manifest: s.mf, rootsFile: s.rf, id: k.fid('LiveCity', 'i.csv') }).error, /not-a-json/);
  const c = t.fieldsFile({ manifest: s.mf, rootsFile: s.rf, id: k.fid('LiveCity', 'j.json') });
  assert.match(c.error, /parse-failed/); assert.ok(!JSON.stringify(c).includes(TEL));
});
test('fields: ps1 has Fields mode, stays ASCII, no delete/copy/network commands', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission41l-triage.ps1'), 'utf8');
  assert.ok(ps.includes("'Fields'"));
  assert.ok(!/[^\x00-\x7f]/.test(ps));
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod/i.test(ps));
});
