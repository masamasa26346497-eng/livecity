'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../tools/mission43-ward-rebuild.cjs');
const A = require('../tools/mission43b-audit.cjs');

test('normalizeWardCode tolerates notation variants but never guesses', () => {
  for (const v of ['27111', ' 27111 ', 27111, '27111.0', '２７１１１', '27111\n']) assert.strictEqual(T.normalizeWardCode(v), '27111', JSON.stringify(v));
  for (const v of [null, undefined, '', '2711', '271111', '27999', 'naniwa', '浪速区', '27-111']) assert.strictEqual(T.normalizeWardCode(v), null, JSON.stringify(v));
});

test('resolveSetWard: variants resolve, conflicts and unknowns are not counted', () => {
  const ok = T.resolveSetWard({ wardCode: '27111', wardId: 'naniwa', ward: '浪速区' }, { dataset: 'osaka-naniwa' });
  assert.strictEqual(ok.wardId, 'naniwa'); assert.strictEqual(ok.state, 'consistent');
  const ws = T.resolveSetWard({ wardCode: ' 27111.0 ', ward: '浪速区' }, null);
  assert.strictEqual(ws.wardId, 'naniwa'); assert.strictEqual(ws.state, 'consistent');
  assert.ok(ws.problems.some((p) => /non-canonically/.test(p)));
  const noSrc = T.resolveSetWard(null, { dataset: 'osaka-sumiyoshi' });
  assert.strictEqual(noSrc.wardId, 'sumiyoshi'); assert.strictEqual(noSrc.state, 'inferred');
  const bad = T.resolveSetWard({ wardCode: '27111', wardId: 'kita' }, null);
  assert.strictEqual(bad.state, 'inconsistent'); assert.strictEqual(bad.wardId, null);
  const junk = T.resolveSetWard({ wardCode: 'xx' }, null);
  assert.strictEqual(junk.state, 'unknown'); assert.ok(junk.problems.length);
});

test('tracked sets: 6 wards incl. Sumiyoshi (no source.json) and Naniwa (2 sets); counts match', () => {
  const m = T.buildManifest();
  assert.strictEqual(m.summary.wardsWith3dInGit, 6);
  const by = (id) => m.wards.find((w) => w.ward === id).groups.buildings3dInGit;
  assert.strictEqual(by('naniwa').buildings, 4267); assert.strictEqual(by('naniwa').sets.length, 2);
  assert.strictEqual(by('sumiyoshi').buildings, 10546);
  for (const id of ['sumiyoshi', 'naniwa', 'kita', 'chuo', 'tennoji', 'nishi']) assert.strictEqual(by(id).partial, true, id + ' must be marked partial');
});

test('viewer audit: every EXTRA_SET_DEFS tileset resolves, refs/sidecars/ward codes agree', () => {
  const r = A.viewerAudit();
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.summary.extraDefs, 6);
  assert.strictEqual(r.summary.wardsWithTrackedViewable3d, 6);
  assert.strictEqual(r.summary.wardsUnavailable, 18);
  assert.strictEqual(r.summary.publishedApprovedWards, 0);
  assert.strictEqual(r.licence.licenceApproved, false);
  assert.ok(r.sets.every((s) => s.kind === 'base' || (s.idsTotal === s.buildings && s.attrsTotal === s.buildings)));
  assert.ok(r.missingConditionsFor24WardDynamicLoading.length >= 4);
});

test('plan: dry-run, gates closed, categories distinguish i-iv, no assumption about PC contents', () => {
  const p = A.plan(null, null);
  assert.strictEqual(p.dryRun, true); assert.strictEqual(p.gates.uploadAllowed, 0);
  assert.strictEqual(p.consistentWithSourceRegistry, true);
  assert.strictEqual(p.licence.licenceApproved, false);
  const w = (id) => p.wards.find((x) => x.ward === id);
  assert.ok(w('sumiyoshi').categories.includes('i-viewable-in-git-partial'));
  assert.ok(w('sumiyoshi').categories.includes('ii-rebuildable-from-git-legacy-tiles'));
  assert.ok(w('fukushima').categories.includes('iv-public-refetch-candidate-licence-unverified'));
  assert.ok(!w('fukushima').categories.some((c) => c.startsWith('iii-')));
});

test('plan with anonymous inspect/preflight marks PC-only wards (synthetic input)', () => {
  const inspect = { schema: 'livecity.mission43.inspect/1', wards: { fukushima: { manifestTiles: 25, tilesListed: 25, tilesFound: 25, manifestBuildings: 11159, buildings: 11159 } } };
  const preflight = { schema: 'livecity.mission43.preflight/1', perWard: { fukushima: { files: 26, bytes: 1000 } }, otherFolders: { dirs: 2, files: 5, bytes: 9 } };
  const p = A.plan(inspect, preflight);
  const f = p.wards.find((x) => x.ward === 'fukushima');
  assert.ok(f.categories.includes('iii-pc-only-first-transfer-unavoidable'));
  assert.strictEqual(f.sourceTiles.foundOnPc, 25); assert.strictEqual(f.anonymousBytes, 1000);
  assert.strictEqual(p.transferredNow.files, 0);
  assert.throws(() => A.plan({ schema: 'x' }, null), /schema/);
});

test('tool is read-only: no network, delete, copy or upload calls', () => {
  const src = fs.readFileSync(path.join(__dirname, '../tools/mission43b-audit.cjs'), 'utf8');
  assert.ok(!/require\('(https?|net|child_process)'\)|fetch\(|unlinkSync|rmSync|copyFile|rename/.test(src));
});

test('committed reports are anonymous', () => {
  for (const f of ['viewer-audit.json', 'ward-input-plan.json']) {
    const p = path.join(__dirname, '../data/reports/mission43b', f);
    if (!fs.existsSync(p)) continue;
    assert.ok(!/[A-Za-z]:\\|\/home\/|OneDrive/.test(fs.readFileSync(p, 'utf8')), f);
  }
});
