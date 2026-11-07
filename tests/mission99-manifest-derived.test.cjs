const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const cp = require('child_process'); const os = require('os'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const w = fs.readFileSync(ROOT + '/tools/mission96/persist-ward.pinned.workflow.yml', 'utf8');
const seg = w.split('- name: Re-verify code hashes')[1].split('\n      - name:')[0];
const code = seg.split("node -e '")[1].split("\n          '")[0];
const lock = JSON.parse(fs.readFileSync(ROOT + '/data/reports/mission79/source-lock.json', 'utf8'));

const run = (base, next, ward) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm99-'));
  fs.writeFileSync(d + '/a.json', JSON.stringify(base)); fs.writeFileSync(d + '/b.json', JSON.stringify(next));
  return cp.spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: { ...process.env, WARD: ward, MANIFEST_BASE: d + '/a.json', MANIFEST_NEW: d + '/b.json' }, encoding: 'utf8' });
};
const k = { status: 'ok', buildings: 1, outBytes: 10 }, n = { status: 'ok', buildings: 5, outBytes: 50 };
const base = { mission: '80', vintage: 2025, wards: { kita: k }, updatedAt: 'a' };
const src = { url: lock.resource && lock.resource.url, etag: lock.http && lock.http.etag, bytes: lock.http && lock.http.contentLength, lastModified: lock.http && lock.http.lastModified };
const good = { ...base, updatedAt: 'b', wards: { kita: k, nishi: n }, source: src, crossWardDuplicateIds: {},
  totals: { wardsOk: 2, wardsFailed: 0, buildings: 6, outBytes: 60 }, lastRun: { processed: 1, failedNow: 0, stoppedBy: null, at: 'x' } };

test('Mission99: totals/lastRun/source/crossWardDuplicateIds written by mission80-batch are accepted when valid', () => {
  const r = run(base, good, 'nishi'); assert.equal(r.status, 0, r.stderr);
});
test('Mission99: invalid derived values are still rejected', () => {
  assert.notEqual(run(base, { ...good, totals: { ...good.totals, buildings: 7 } }, 'nishi').status, 0);
  assert.notEqual(run(base, { ...good, lastRun: { ...good.lastRun, failedNow: 1 } }, 'nishi').status, 0);
  assert.notEqual(run(base, { ...good, source: { ...src, url: 'https://evil.example/x' } }, 'nishi').status, 0);
  assert.notEqual(run(base, { ...good, crossWardDuplicateIds: [1] }, 'nishi').status, 0);
  assert.notEqual(run(base, { ...good, surprise: 1 }, 'nishi').status, 0);
});
test('Mission99: pinned SHA and nishi-only guard unchanged, no token in re-verify', () => {
  assert.match(w, /PIN_SHA: "c4b79150067bba5acd37fbbf05c1e5af8b0af5b0"/);
  assert.match(w, /only nishi is allowed/);
  assert.doesNotMatch(seg, /TOKEN/);
});
