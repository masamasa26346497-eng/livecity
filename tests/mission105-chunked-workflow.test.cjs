'use strict';
// Mission 105: offline validation of the 3-ward chunked persist workflow candidate. Nothing is executed, no network, no secrets.
// The strict block-YAML parser is reused verbatim (by extraction) from the Mission103 test; it is NOT GitHub's schema validator.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const F = path.join(ROOT, 'tools/mission105/three-wards.pinned.workflow.yml');
const text = fs.readFileSync(F, 'utf8');
const t103 = fs.readFileSync(path.join(ROOT, 'tests/mission103-all-wards-workflow.test.cjs'), 'utf8');
const a = t103.indexOf('function parseYaml'), b = t103.indexOf('const wf = parseYaml');
assert.ok(a > 0 && b > a, 'could not extract the Mission103 strict YAML parser');
const parseYaml = new Function(t103.slice(a, b) + '\nreturn parseYaml;')();
const wf = parseYaml(text);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PIN = wf.env.PIN_SHA;
const STORED_21 = ['fukushima', 'miyakojima', 'konohana', 'nishi', 'minato', 'taisho', 'tennoji', 'naniwa', 'nishiyodogawa', 'higashiyodogawa', 'higashinari', 'asahi', 'joto', 'sumiyoshi', 'higashisumiyoshi', 'nishinari', 'tsurumi', 'suminoe', 'hirano', 'kita', 'chuo'];

test('real YAML structure: plan -> rest -> summary, dispatch only, read-only permissions, own concurrency group', () => {
  assert.deepStrictEqual(Object.keys(wf).sort(), ['concurrency', 'env', 'jobs', 'name', 'on', 'permissions']);
  assert.deepStrictEqual(Object.keys(wf.jobs), ['plan', 'rest', 'summary']);
  assert.deepStrictEqual(Object.keys(wf.on), ['workflow_dispatch']);
  assert.deepStrictEqual(Object.keys(wf.on.workflow_dispatch.inputs), ['wards']);
  assert.deepStrictEqual(wf.permissions, { contents: 'read' });
  assert.strictEqual(wf.concurrency.group, 'mission105-persist-3-wards');
  assert.strictEqual(wf.concurrency['cancel-in-progress'], false);
  assert.deepStrictEqual(wf.jobs.rest.needs, 'plan');
  assert.deepStrictEqual(wf.jobs.summary.needs, ['plan', 'rest']);
  assert.ok(!/ pull_request|issue_comment|schedule|push:/.test(text.split('jobs:')[0].replace(/#.*$/gm, '')));
});

test('owner-only gate on default branch; sequential, no fail-fast, no retry, timeout > ward timeout', () => {
  assert.ok(/github\.actor == github\.repository_owner/.test(wf.jobs.plan.if) && /github\.triggering_actor == github\.repository_owner/.test(wf.jobs.plan.if));
  assert.ok(/default_branch/.test(wf.jobs.plan.if));
  const r = wf.jobs.rest;
  assert.strictEqual(r.strategy['fail-fast'], false);
  assert.strictEqual(String(r.strategy['max-parallel']), '1');
  assert.ok(/fromJSON\(needs\.plan\.outputs\.rest_matrix\)/.test(r.strategy.matrix));
  assert.ok(Number(r['timeout-minutes']) > 80 && Number(r['timeout-minutes']) <= 120);
  assert.ok(!/retry|attempt/i.test(text.replace(/#.*$/gm, '').replace(/Resume:.*|retried once.*|No automatic retry\./g, '')));
});

test('ward scope: exactly ikuno/abeno/yodogawa; none of the 21 stored wards; no overwrite input or flag', () => {
  const run = wf.jobs.plan.steps[0].run;
  assert.ok(/ALL="ikuno abeno yodogawa"/.test(run));
  for (const w of STORED_21) assert.ok(!new RegExp('\\b' + w + '\\b').test(run.replace(/stored-skip|already stored/g, '')), 'stored ward listed: ' + w);
  const pre = wf.jobs.rest.steps.find((s) => /Resource preflight/.test(s.name));
  assert.ok(/case "\$WARD" in ikuno\|abeno\|yodogawa\) ;; \*\) echo "FAIL: ward not allowed/.test(pre.run), pre.run);
  assert.ok(!/EXPECTED_SHA_NISHI/.test(text));
  assert.ok(!/--overwrite|--force|--delete|overwrite:/.test(text));
  assert.strictEqual(STORED_21.length, 21);
});

test('stored target wards: re-download, sha256 recomputed, skipped (not reconverted)', () => {
  const run = wf.jobs.plan.steps[0].run;
  assert.ok(/sha256sum "chk-\$w\.tgz"/.test(run) && /stored-skip/.test(run) && /tileset\.json/.test(run));
  assert.ok(/private" \] && \[ "\$\(jq -r '\.permissions\.push/.test(run));
});

test('pinned SHA: real ancestor commit, checkout uses it, tree clean + sha256 verified before any token use', () => {
  assert.match(PIN, /^[0-9a-f]{40}$/);
  git('cat-file', '-e', PIN + '^{commit}');
  git('merge-base', '--is-ancestor', PIN, 'HEAD');
  const co = wf.jobs.rest.steps[0];
  assert.strictEqual(co.with.ref, PIN); assert.strictEqual(co.with['persist-credentials'], false);
  assert.strictEqual(wf.jobs.rest.env.PIN_SHA, PIN);
  const names = wf.jobs.rest.steps.map((s) => s.name || s.uses);
  const iV = names.findIndex((n) => /Verify pinned SHA/.test(n)), iConn = names.findIndex((n) => /Connect check/.test(n));
  const iPre = names.findIndex((n) => /Resource preflight/.test(n)), iConv = names.findIndex((n) => /Convert ward in bounded chunks/.test(n));
  assert.ok(iV > 0 && iV < iConn && iConn < iPre && iPre < iConv, names.join(' | '));
});

test('embedded sha256 list == git objects at the pin (closure includes chunked-batch, chunked-run, mission80 audited files)', () => {
  const run = wf.jobs.rest.steps.find((s) => /trusted hash list/.test(s.name)).run;
  const lines = run.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{64}  /.test(l));
  const files = lines.map((l) => l.split(/  /)[1]);
  for (const f of ['tools/mission105/chunked-batch.mjs', 'tools/mission104/chunked-run.mjs', 'tools/mission80-batch.mjs', 'tools/mission79-run.mjs', 'tools/mission95-persist-ward.mjs', 'tools/mission87-persist.mjs', 'tools/mission95-check-output.mjs'])
    assert.ok(files.includes(f), 'closure lacks ' + f);
  for (const l of lines) { const [h, f] = l.split(/  /); assert.strictEqual(sha(execFileSync('git', ['show', PIN + ':' + f], { cwd: ROOT, maxBuffer: 1 << 28 })), h, f); }
  // every audited Mission101/103 hash that still applies is byte-identical (the old closure is a subset except the swapped entry file)
  const old = fs.readFileSync(path.join(ROOT, 'tools/mission103/all-wards.pinned.workflow.yml'), 'utf8');
  const oldLines = [...new Set(old.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{64}  /.test(l)))];
  assert.strictEqual(oldLines.length, 13);
  const newSet = new Set(lines);
  const changed = oldLines.filter((l) => !newSet.has(l)).map((l) => l.split(/  /)[1]);
  assert.deepStrictEqual(changed, [], 'audited closure files changed: ' + changed);
  assert.ok(lines.length >= oldLines.length + 2);
  assert.ok(!files.some((f) => /^\.github\//.test(f)));
});

test('rendered file is up to date with render.mjs for this pin, and placeholder-free', async () => {
  const { render } = await import('../tools/mission105/render.mjs');
  assert.strictEqual(render(PIN), text);
  assert.ok(!/@@/.test(text) && !/pilot/i.test(text.replace(/#.*$/gm, '')));
});

test('token exposure limited to plan + connect check + persist; persist only with --execute; summary has no token', () => {
  const uses = [];
  for (const [jn, j] of Object.entries(wf.jobs)) for (const s of j.steps) {
    if (/LIVECITY_3D_DATA_TOKEN/.test(JSON.stringify(s.env || {}) + JSON.stringify(s.with || {}))) uses.push(jn + ':' + s.name);
  }
  assert.strictEqual(uses.length, 3, uses.join('|'));
  assert.ok(uses.every((u) => /^plan:|Connect check|Persist to private/.test(u)));
  const persist = wf.jobs.rest.steps.find((s) => s.id === 'persist');
  assert.ok(/mission95-persist-ward\.mjs --ward "\$WARD" --repo "\$DATA_REPO" --execute/.test(persist.run));
  assert.ok(!/LIVECITY_3D_DATA_TOKEN/.test(JSON.stringify(wf.jobs.summary)));
});

test('convert step: chunked path with unchanged 1200MB gate, 300MB chunks; strict check, re-verify, failure classes kept', () => {
  const steps = wf.jobs.rest.steps;
  const conv = steps.find((s) => s.id === 'convert');
  assert.ok(/mission105\/chunked-batch\.mjs --wards "\$WARD" --chunk-mb 300 --max-mb 1200 --ward-timeout-min 80/.test(conv.run));
  assert.ok(!/mission80-batch\.mjs --wards/.test(JSON.stringify(steps)));
  const pre = steps.find((s) => /Resource preflight/.test(s.name));
  assert.ok(/free_gb.*-ge 6/.test(pre.run) && /mem_mb.*-ge 3000/.test(pre.run) && /chunked-run\.mjs --ward "\$WARD" --chunk-mb 300 --max-mb 1200 --dry-run/.test(pre.run));
  assert.ok(steps.some((s) => s.id === 'strict' && /mission95-check-output\.mjs "\$WARD"/.test(s.run)));
  const rv = steps.find((s) => s.id === 'reverify');
  assert.ok(/sha256sum -c/.test(rv.run) && /other ward entry modified/.test(rv.run));
  const res = steps.find((s) => /per-ward result/.test(s.name || ''));
  assert.ok(res.if === 'always()' && /generate-failed/.test(res.run) && /persist-failed/.test(res.run));
  assert.ok(/exit 1/.test(JSON.stringify(wf.jobs.summary)));
});

test('no audited/old file was modified since Mission104 (604451b); no .github change; no public/ or data publication', () => {
  const changed = git('diff', '--name-only', '604451b', 'HEAD').split('\n').filter(Boolean);
  const bad = changed.filter((f) => /^(\.github\/|public\/|tools\/mission(79|80|87|95|96|101|103|104)|tools\/mission80-batch|tools\/mission79)/.test(f));
  assert.deepStrictEqual(bad, [], 'forbidden paths changed: ' + bad);
});

test('chunked-batch: only the 3 wards; refuses all 21 stored wards; no network/env/token/upload in code', async () => {
  const m = await import('../tools/mission105/chunked-batch.mjs');
  assert.deepStrictEqual(m.ALLOWED_WARDS, ['ikuno', 'abeno', 'yodogawa']);
  for (const w of STORED_21) assert.throws(() => m.assertAllowed(w), /not allowed/);
  let threw = false;
  try { execFileSync(process.execPath, ['tools/mission105/chunked-batch.mjs', '--wards', 'kita'], { cwd: ROOT, stdio: 'pipe' }); } catch (e) { threw = /not allowed/.test(String(e.stderr)); }
  assert.ok(threw);
  const code = fs.readFileSync(path.join(ROOT, 'tools/mission105/chunked-batch.mjs'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /fetch\(|https?:\/\/|process\.env|GITHUB_TOKEN|secrets\.|mission87-persist|mission95-persist|'gh'|curl/);
});

test('applyResult on a synthetic fixture: only the target entry changes and derived keys pass the workflow re-verify rules', async () => {
  const m = await import('../tools/mission105/chunked-batch.mjs');
  const { summarizeWard } = await import('../tools/mission80-batch.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm105-'));
  try {
    fs.mkdirSync(path.join(tmp, 'ids'));
    fs.writeFileSync(path.join(tmp, 'ids', 't_0_0.json'), JSON.stringify(['bldg_a', 'bldg_b', 'bldg_c']));
    fs.writeFileSync(path.join(tmp, 'tileset.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'build-report.json'), JSON.stringify({ totals: { buildings: 3, sourceBuildings: 3, skipped: 0, fallbacks: 0, glbBytes: 10 } }));
    fs.writeFileSync(path.join(tmp, 'source.json'), JSON.stringify({ wardCode: '27109', vintage: 2025, sourceEtag: 'e', sourceBytes: 1, sourceMeshes: ['m1', 'm2'] }));
    const entry = summarizeWard(tmp, { wardId: 'ikuno', ms: 1, finishedAt: 'x', chunked: true });
    assert.strictEqual(entry.status, 'ok'); assert.strictEqual(entry.idsUnique, true); assert.strictEqual(entry.buildings, 3);
    const lock = { resource: { url: 'u' }, http: { etag: 'E', contentLength: 5, lastModified: 'L' } };
    const base = { mission: '80', vintage: 2025, wards: { kita: { status: 'ok', buildings: 5, outBytes: 7, vintage: 2025 }, chuo: { status: 'failed' } }, extraKey: 1 };
    const before = JSON.stringify(base);
    const man = JSON.parse(before);
    m.applyResult(man, 'ikuno', entry, { lock, idSets: { ikuno: ['bldg_a', 'bldg_b', 'bldg_c'] }, at: '2026-11-03T00:00:00.000Z' });
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y), a0 = JSON.parse(before);
    assert.ok(same(man.wards.kita, a0.wards.kita) && same(man.wards.chuo, a0.wards.chuo), 'other wards untouched');
    assert.strictEqual(man.extraKey, 1);
    const ok = Object.values(man.wards).filter((x) => x.status === 'ok'), fl = Object.values(man.wards).filter((x) => x.status === 'failed');
    assert.ok(same(man.totals, { wardsOk: ok.length, wardsFailed: fl.length, buildings: ok.reduce((n, x) => n + x.buildings, 0), outBytes: ok.reduce((n, x) => n + x.outBytes, 0) }));
    assert.ok(man.lastRun.processed <= 1 && man.lastRun.failedNow === 0 && typeof man.lastRun.at === 'string' && Object.keys(man.lastRun).every((k) => ['processed', 'failedNow', 'stoppedBy', 'at'].includes(k)));
    assert.strictEqual(man.source.etag, 'E'); assert.strictEqual(man.source.bytes, 5);
    assert.ok(Object.values(man.crossWardDuplicateIds).every(Number.isInteger));
    assert.throws(() => m.applyResult(man, 'kita', entry, { lock }), /not allowed/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('dry-run plans (real source lock, read-only): all 3 wards fit the bounded peak, total under the hard ceiling', () => {
  for (const w of ['ikuno', 'abeno', 'yodogawa']) {
    const out = execFileSync(process.execPath, ['tools/mission104/chunked-run.mjs', '--ward', w, '--chunk-mb', '300', '--max-mb', '1200', '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
    const plan = JSON.parse(out.split('plan ')[1]);
    assert.ok(plan.gates.peakMb <= 400 && plan.gates.totalMb <= 1500 && plan.chunks >= 3, w + ' ' + JSON.stringify(plan));
  }
});
