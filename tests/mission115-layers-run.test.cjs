'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../tools/mission115/layers-run.cjs');

test('projection constants match viewer and legacy page (no building shift)', () => {
  const c = R.constantsReport();
  for (const k of Object.keys(c)) assert.ok(c[k].matches, k + ' ' + JSON.stringify(c[k]));
});
test('ward centres land in Osaka via shared constants', () => {
  for (const w of R.wardList()) {
    const b = w.bbox, ll = R.localToLonLat((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2);
    assert.ok(ll.lon > 135.3 && ll.lon < 135.7 && ll.lat > 34.4 && ll.lat < 34.9, w.wardId);
  }
  assert.deepStrictEqual(R.wardList().map((w) => w.wardId).sort(), ['fukushima', 'nishi', 'yodogawa']);
});
test('verify: missing ward is reported missing, not faked', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm115-'));
  const r = R.verify(tmp, R.wardList());
  assert.strictEqual(r.summary.missing, 3);
  assert.strictEqual(r.acceptance.browserRendered, false);
});
test('verify: synthetic layers inside a ward pass static checks; shifted data fails', () => {
  const w = R.wardList().find((x) => x.wardId === 'nishi'), b = w.bbox;
  const mk = (dx) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm115-'));
    const d = path.join(tmp, 'nishi', 'layers');
    fs.mkdirSync(d, { recursive: true });
    const cx = (b.minX + b.maxX) / 2 + dx, cz = (b.minZ + b.maxZ) / 2;
    const f = [{ id: 'a', p: [[cx - 200, cz], [cx + 200, cz]] }];
    for (const l of ['roads', 'waterways', 'parks', 'railways']) {
      fs.writeFileSync(path.join(d, l + '.json'), JSON.stringify({ coordinateConvention: R.CONVENTION, count: 1, features: l === 'roads' ? f : [] }));
    }
    return R.verifyWard(w, tmp, 100);
  };
  assert.strictEqual(mk(0).state, 'generated-unverified-visually');
  assert.strictEqual(mk(50000).state, 'check-failed');
});
test('tools are offline, ASCII ps1, no delete/copy', () => {
  const js = fs.readFileSync(path.join(__dirname, '../tools/mission115/layers-run.cjs'), 'utf8');
  const ps = fs.readFileSync(path.join(__dirname, '../tools/mission115/layers-run.ps1'), 'utf8');
  assert.ok(!/Remove-Item|rmSync|unlinkSync|Copy-Item|robocopy|fetch\(|https\.request/.test(js + ps));
  assert.ok(!/[^\x00-\x7F]/.test(ps));
});
