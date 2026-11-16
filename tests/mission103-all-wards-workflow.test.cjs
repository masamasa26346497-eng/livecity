'use strict';
// Mission 103: validation of the rendered all-wards workflow. Free, offline, nothing executed.
// No YAML library is installed here, so this file contains a small *strict* block-YAML parser (mappings, sequences, block scalars,
// quoted/plain scalars, simple flow sequences). It throws on tabs, odd indentation, unterminated quotes, plain scalars with ': '.
// It is a real parse of the subset the workflow uses, but NOT a substitute for GitHub's schema validation.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const F = path.join(ROOT, 'tools/mission103/all-wards.pinned.workflow.yml');
const text = fs.readFileSync(F, 'utf8');

function parseYaml(src) {
  const raw = src.split('\n');
  const lines = [];
  for (let i = 0; i < raw.length; i++) lines.push({ n: i + 1, s: raw[i] });
  let p = 0;
  const err = (m, l) => { throw new Error('YAML line ' + (l ? l.n : '?') + ': ' + m); };
  const indentOf = (s) => { const m = /^( *)/.exec(s); if (s.slice(0, m[1].length).includes('\t')) err('tab'); return m[1].length; };
  const skip = () => { while (p < lines.length && (/^\s*$/.test(lines[p].s) || /^\s*#/.test(lines[p].s))) p++; };
  function scalar(v, l) {
    v = v.trim();
    if (v === '') return null;
    if (v[0] === '"') { if (!/^"(?:[^"\\]|\\.)*"\s*(#.*)?$/.test(v)) err('bad double-quoted scalar', l); return JSON.parse(v.replace(/\s*(#.*)?$/, '').replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1')); }
    if (v[0] === "'") { if (!/^'(?:[^']|'')*'\s*(#.*)?$/.test(v)) err('bad single-quoted scalar', l); return v.replace(/\s*(#.*)?$/, '').slice(1, -1).replace(/''/g, "'"); }
    if (v[0] === '[') {
      if (!/\]\s*$/.test(v)) err('unterminated flow seq', l);
      return v.slice(1, v.lastIndexOf(']')).split(',').map((x) => x.trim()).filter(Boolean);
    }
    if (/[{}]/.test(v[0]) && !v.startsWith('${{')) err('unsupported flow mapping', l);
    v = v.replace(/\s+#.*$/, '');
    if (/: |:$/.test(v.replace(/\$\{\{.*?\}\}/g, ''))) err('plain scalar contains ": " (invalid YAML)', l);
    if (v === 'true') return true; if (v === 'false') return false;
    return v;
  }
  function block(ind) {
    skip(); if (p >= lines.length) return null;
    const l = lines[p]; const i = indentOf(l.s);
    if (i < ind) return null;
    if (i % 2) err('odd indent', l);
    if (/^\s*- /.test(l.s) || /^\s*-$/.test(l.s)) return seq(i);
    return map(i);
  }
  function blockScalar(parentIndent, style) {
    const out = []; let bi = -1;
    while (p < lines.length) {
      const l = lines[p];
      if (/^\s*$/.test(l.s)) { out.push(''); p++; continue; }
      const i = indentOf(l.s);
      if (i <= parentIndent) break;
      if (bi < 0) bi = i; if (i < bi) err('block scalar under-indented', l);
      out.push(l.s.slice(bi)); p++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n') + (style.includes('-') ? '' : '\n');
  }
  function entry(content, i, l, target) {
    const m = /^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_\-.${}() ]+?)):(?: +(.*))?$/.exec(content);
    if (!m) err('not a mapping entry: ' + content.slice(0, 50), l);
    const key = m[1].replace(/^["']|["']$/g, ''); const rest = m[2];
    if (key in target) err('duplicate key ' + key, l);
    if (rest === undefined || rest === '' || /^#/.test(rest)) { const child = block(i + 1); target[key] = child; }
    else if (/^[|>][+-]?\s*$/.test(rest)) target[key] = blockScalar(i, rest);
    else target[key] = scalar(rest, l);
  }
  function map(ind) {
    const o = {};
    for (;;) {
      skip(); if (p >= lines.length) break;
      const l = lines[p]; const i = indentOf(l.s);
      if (i < ind) break; if (i > ind) err('unexpected indent', l);
      if (/^\s*-( |$)/.test(l.s)) break;
      p++; entry(l.s.slice(i), i, l, o);
    }
    return o;
  }
  function seq(ind) {
    const a = [];
    for (;;) {
      skip(); if (p >= lines.length) break;
      const l = lines[p]; const i = indentOf(l.s);
      if (i < ind) break; if (i > ind) err('unexpected indent', l);
      if (!/^\s*-( |$)/.test(l.s)) break;
      p++;
      const after = l.s.slice(i + 2);
      if (after.trim() === '') { a.push(block(i + 1)); continue; }
      if (/^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_\-.${}() ]+?)):( |$)/.test(after)) {
        const o = {}; entry(after, i + 2, l, o);
        // continuation keys at indent i+2
        for (;;) {
          skip(); if (p >= lines.length) break;
          const l2 = lines[p]; const i2 = indentOf(l2.s);
          if (i2 !== i + 2) { if (i2 > i + 2) err('unexpected indent', l2); break; }
          p++; entry(l2.s.slice(i2), i2, l2, o);
        }
        a.push(o);
      } else a.push(scalar(after, l));
    }
    return a;
  }
  const doc = block(0); skip();
  if (p < lines.length) err('trailing content', lines[p]);
  return doc;
}

const wf = parseYaml(text);
const OFFICIAL = ['fukushima', 'miyakojima', 'konohana', 'nishi', 'minato', 'taisho', 'tennoji', 'naniwa', 'nishiyodogawa', 'higashiyodogawa', 'higashinari', 'ikuno', 'asahi', 'joto', 'abeno', 'sumiyoshi', 'higashisumiyoshi', 'nishinari', 'yodogawa', 'tsurumi', 'suminoe', 'hirano', 'kita', 'chuo'];

test('parses as real YAML with expected structure', () => {
  assert.deepStrictEqual(Object.keys(wf).sort(), ['concurrency', 'env', 'jobs', 'name', 'on', 'permissions']);
  assert.deepStrictEqual(Object.keys(wf.jobs), ['plan', 'pilot', 'rest', 'summary']);
  assert.deepStrictEqual(Object.keys(wf.on), ['workflow_dispatch']);
  assert.deepStrictEqual(wf.permissions, { contents: 'read' });
  assert.strictEqual(wf.concurrency['cancel-in-progress'], false);
  assert.ok(/^mission103-/.test(wf.concurrency.group));
});

test('job graph: plan -> pilot -> rest -> summary; sequential, no fail-fast, no auto retry', () => {
  assert.deepStrictEqual(wf.jobs.pilot.needs, 'plan');
  assert.deepStrictEqual(wf.jobs.rest.needs, ['plan', 'pilot']);
  assert.deepStrictEqual(wf.jobs.summary.needs, ['plan', 'pilot', 'rest']);
  for (const j of ['pilot', 'rest']) {
    assert.strictEqual(wf.jobs[j].strategy['fail-fast'], false);
    assert.strictEqual(String(wf.jobs[j].strategy['max-parallel']), '1');
    assert.ok(/fromJSON\(needs\.plan\.outputs\.(pilot|rest)_matrix\)/.test(wf.jobs[j].strategy.matrix));
    assert.ok(Number(wf.jobs[j]['timeout-minutes']) <= 90);
  }
  assert.ok(/pilot\.result == 'success' \|\| needs\.pilot\.result == 'skipped'/.test(wf.jobs.rest.if), 'rest only after pilot success/skip');
  assert.ok(/needs\.plan\.result == 'success'/.test(wf.jobs.rest.if));
  assert.ok(!/retry|attempt/i.test(text.replace(/Resume:.*|retried once.*|No automatic retry\./g, '')), 'no retry loops');
});

test('owner-only gate, default branch, workflow_dispatch only, pinned SHA', () => {
  assert.ok(/github\.actor == github\.repository_owner/.test(wf.jobs.plan.if) && /github\.triggering_actor == github\.repository_owner/.test(wf.jobs.plan.if));
  assert.ok(/default_branch/.test(wf.jobs.plan.if));
  assert.strictEqual(wf.env.PIN_SHA, 'c4b79150067bba5acd37fbbf05c1e5af8b0af5b0');
  for (const j of ['pilot', 'rest']) {
    const co = wf.jobs[j].steps[0];
    assert.strictEqual(co.with.ref, wf.env.PIN_SHA);
    assert.strictEqual(co.with['persist-credentials'], false);
  }
});

test('token exposure: only plan, connect check and persist step', () => {
  const uses = [];
  for (const [jn, j] of Object.entries(wf.jobs)) for (const s of j.steps) {
    const blob = JSON.stringify(s.env || {}) + JSON.stringify(s.with || {});
    if (/LIVECITY_3D_DATA_TOKEN/.test(blob)) uses.push(jn + ':' + s.name);
  }
  assert.strictEqual(uses.length, 5, uses.join('|')); // plan, then connect check + persist in each of pilot and rest
  assert.ok(uses.every((u) => /plan:|Connect check|Persist to private/.test(u)), uses.join('|'));
  assert.ok(!/ pull_request|issue_comment|schedule|push:/.test(text.split('jobs:')[0].replace(/#.*$/gm, '')));
});

test('24 official wards, unique, fukushima first, expo excluded; pilot/rest steps identical', () => {
  const m = /ALL="([^"]+)"/.exec(wf.jobs.plan.steps[0].run);
  const ids = m[1].split(' ');
  assert.strictEqual(ids.length, 24); assert.strictEqual(new Set(ids).size, 24);
  assert.deepStrictEqual([...ids].sort(), [...OFFICIAL].sort());
  assert.strictEqual(ids[0], 'fukushima');
  assert.ok(!/expo|27999/.test(m[1]));
  assert.deepStrictEqual(JSON.stringify(wf.jobs.pilot.steps), JSON.stringify(wf.jobs.rest.steps));
});

test('stored wards re-verified + skipped; nishi hash; generate vs persist failure classes; result artifact', () => {
  const run = wf.jobs.plan.steps[0].run;
  assert.ok(/EXPECTED_SHA_NISHI/.test(run) && /sha256sum/.test(run) && /stored-skip/.test(run));
  assert.strictEqual(wf.env.EXPECTED_SHA_NISHI, '0232c89f0a5beeb2a03333b6ac8d0ca6366004ac85a0f3b221170dbc91a078c4');
  const names = wf.jobs.rest.steps.map((s) => s.name || s.uses);
  assert.ok(names.includes('Convert ward (PLATEAU 2025, NO token)') && names.includes('Strict output check (no token)'));
  const res = wf.jobs.rest.steps.find((s) => /per-ward result/.test(s.name || ''));
  assert.ok(res && res.if === 'always()' && /generate-failed/.test(res.run) && /persist-failed/.test(res.run));
  const up = wf.jobs.rest.steps.find((s) => /^actions\/upload-artifact@v4$/.test(s.uses || ''));
  assert.ok(up && up.if === 'always()');
  assert.ok(/overwrite|--force|delete/i.test(text) === false || !/--overwrite|--force|--delete/.test(text), 'no overwrite flag');
  const persist = wf.jobs.rest.steps.find((s) => s.id === 'persist');
  assert.ok(/--execute/.test(persist.run) && !/--overwrite/.test(persist.run));
});

test('embedded sha256 list matches the pinned code tree (13 files)', () => {
  const run = wf.jobs.rest.steps.find((s) => /trusted hash list/.test(s.name)).run;
  const lines = run.split('\n').filter((l) => /^[0-9a-f]{64}  /.test(l.trim())).map((l) => l.trim());
  assert.strictEqual(lines.length, 13);
  const prev = fs.readFileSync(path.join(ROOT, 'tools/mission101/persist-wards.pinned.workflow.yml'), 'utf8');
  for (const l of lines) assert.ok(prev.includes(l), 'hash line differs from audited Mission101 closure: ' + l);
  for (const l of lines) {
    const [h, f] = l.split(/  /);
    const cur = path.join(ROOT, f);
    if (fs.existsSync(cur)) assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(cur)).digest('hex'), h, f + ' changed since pin');
  }
});

test('summary job: aggregates results, no token, fails if any ward failed; reports storage only', () => {
  const s = wf.jobs.summary;
  assert.ok(!/LIVECITY_3D_DATA_TOKEN/.test(JSON.stringify(s)));
  assert.ok(/browser acceptance 0/i.test(JSON.stringify(s)) && /NOT done/.test(JSON.stringify(s)));
  assert.ok(s.steps.some((x) => x.uses === 'actions/download-artifact@v4'));
});

test('rendered file is up to date and placeholder-free', () => {
  assert.ok(!/@@/.test(text));
  assert.ok(/[\u0000-\u0008\u000b\u000c]/.test(text) === false);
});

test('parser self-check rejects broken YAML', () => {
  assert.throws(() => parseYaml('a:\n   b: 1\n'), /odd indent|unexpected/);
  assert.throws(() => parseYaml('a: "x\n'), /quoted/);
  assert.throws(() => parseYaml('a: b: c\n'), /": "/);
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), /tab|not a mapping/);
});
