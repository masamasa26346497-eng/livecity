'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('../tools/mission45e-preview.cjs');
const D = require('../tools/mission45d-convert-all.cjs');
const TOOL = path.join(__dirname, '..', 'tools', 'mission45e-preview.cjs');
const PC = path.join(__dirname, '..', 'tools', 'mission43f-pc-convert.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm45u-'));
const FAKE = 'C:\\Users\\someone\\OneDrive\\secret\\bldg_0123abcd';

test('diagnose(): stage + fixed-vocabulary class/errno only; never message, stack or path', () => {
  const e = Object.assign(new Error('ENOENT: open ' + FAKE), { code: 'ENOENT' });
  const d = E.diagnose(e, 'plan:pc23-verify');
  assert.strictEqual(d.stage, 'plan:pc23-verify');
  assert.strictEqual(d.errno, 'ENOENT');
  const js = JSON.stringify(d);
  assert.ok(!js.includes('someone') && !js.includes('bldg_') && !js.includes('OneDrive'));
  const t = E.diagnose(new TypeError('x ' + FAKE), '45d:proof');
  assert.strictEqual(t.errorClass, 'TypeError');
  assert.match(t.repairable, /code defect/);
  const odd = E.diagnose(Object.assign(new Error('m'), { code: FAKE }), 'start');
  assert.strictEqual(odd.errno, null);
  assert.ok(!JSON.stringify(odd).includes('someone'));
  const g = E.diagnose(new Error('refusing: output would contain a path or an id'), '45d:proof');
  assert.strictEqual(g.anonymityGuardTripped, true);
  assert.strictEqual(E.diagnose(null, 'x').errorClass, 'Error');
});

test('CLI: a non-coded exception reports its stage, not "details suppressed", and leaks no path', () => {
  const root = tmp();
  const out = path.join(root, 'out');
  const src = path.join(root, 'src');
  fs.mkdirSync(out);
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(out, D.MARKER), JSON.stringify({ schema: D.SCHEMA }));
  const pre = path.join(root, 'pre.cjs');
  fs.writeFileSync(pre, 'const C=require(' + JSON.stringify(PC) + ');C.checkSource=function(){throw new TypeError(' + JSON.stringify(FAKE) + ');};');
  const r = spawnSync(process.execPath, ['-r', pre, TOOL, '--src', src, '--out-root', out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.ok(!/details suppressed/.test(r.stderr), r.stderr);
  const line = r.stderr.split('\n').find((l) => l.startsWith('diagnostic: '));
  const d = JSON.parse(line.slice('diagnostic: '.length));
  assert.strictEqual(d.stage, '45d:source-check');
  assert.strictEqual(d.errorClass, 'TypeError');
  for (const bad of ['someone', 'OneDrive', 'bldg_', 'secret', root]) assert.ok(!r.stderr.includes(bad), 'leak: ' + bad);
});

test('CLI: coded refusals keep their own message and also name the stage', () => {
  const root = tmp();
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  const r = spawnSync(process.execPath, [TOOL, '--src', src, '--out-root', path.join(root, 'missing')], { encoding: 'utf8' });
  assert.ok(r.status !== 0 && r.status !== null);
  assert.match(r.stderr, /diagnostic: .*"coded":true/);
});

test('static: ps1 stays ASCII and never writes / deletes / copies', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mission45e-preview.ps1'), 'utf8');
  assert.ok(!/[^\x00-\x7f]/.test(ps));
  assert.ok(!/Remove-Item|Copy-Item|robocopy|Move-Item|Set-Content|Out-File/i.test(ps));
});
