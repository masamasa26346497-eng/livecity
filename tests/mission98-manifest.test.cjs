const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const cp = require('child_process'); const os = require('os'); const path = require('path');
const w = fs.readFileSync(__dirname + '/../tools/mission96/persist-ward.pinned.workflow.yml', 'utf8');
const seg = w.split('- name: Re-verify code hashes')[1].split('\n      - name:')[0];

test('Mission98: re-verify step keeps SHA + hash checks, has no token, and checks manifest content', () => {
  assert.match(seg, /rev-parse HEAD/); assert.match(seg, /sha256sum -c/);
  assert.doesNotMatch(seg, /TOKEN/);
  assert.match(seg, /git show "HEAD:\$M"/);
  assert.match(seg, /other ward entry modified/); assert.match(seg, /header changed/);
  assert.match(seg, /unexpected new ward entry/);
});

test('Mission98: embedded manifest verifier accepts target-ward-only change, rejects others', () => {
  const code = seg.split("node -e '")[1].split("\n          '")[0];
  const run = (base, next, ward) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm98-'));
    fs.writeFileSync(d + '/a.json', JSON.stringify(base)); fs.writeFileSync(d + '/b.json', JSON.stringify(next));
    return cp.spawnSync(process.execPath, ['-e', code], { env: { ...process.env, WARD: ward, MANIFEST_BASE: d + '/a.json', MANIFEST_NEW: d + '/b.json' }, encoding: 'utf8' });
  };
  const base = { mission: '80', vintage: 2025, wards: { kita: { status: 'ok', buildings: 1 } }, updatedAt: 'a' };
  assert.equal(run(base, { ...base, updatedAt: 'b', wards: { kita: base.wards.kita, nishi: { status: 'ok' } } }, 'nishi').status, 0);
  assert.notEqual(run(base, { ...base, wards: { kita: { status: 'ok', buildings: 2 }, nishi: { status: 'ok' } } }, 'nishi').status, 0);
  assert.notEqual(run(base, { ...base, wards: { kita: base.wards.kita, abeno: { status: 'ok' }, nishi: { status: 'ok' } } }, 'nishi').status, 0);
  assert.notEqual(run(base, { ...base, vintage: 2024, wards: { kita: base.wards.kita, nishi: {} } }, 'nishi').status, 0);
  assert.notEqual(run(base, base, 'nishi').status, 0);
});
