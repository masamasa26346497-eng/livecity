'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../tools/mission159/ward-audit.cjs');

test('git-only: 24 wards, N03 integrity ok, nothing claimed as browser-accepted', () => {
  const r = A.build({});
  assert.strictEqual(r.summary.wards, 24);
  assert.strictEqual(r.summary.n03Ok, 24, r.summary.n03Issues.join(','));
  assert.strictEqual(r.summary.browserAcceptedByThisTool, 0);
  assert.strictEqual(new Set(r.rows.map((x) => x.wardCode)).size, 24);
  assert.strictEqual(new Set(r.rows.map((x) => x.wardId)).size, 24);
  assert.ok(r.rows.every((x) => /^unverified/.test(x.local.state)));
  assert.deepStrictEqual(r.summary.localNotChecked.length, 24);
});

test('git-only: konohana/nishinari stay unclassified (M140 log has no sub-reason); yodogawa has no Git evidence', () => {
  const r = A.build({});
  const by = Object.fromEntries(r.rows.map((x) => [x.wardId, x]));
  assert.strictEqual(by.konohana.clickClass.cls, 'unclassified');
  assert.strictEqual(by.nishinari.clickClass.cls, 'unclassified');
  assert.strictEqual(by.yodogawa.evidence.m140CiLog, null);
  assert.strictEqual(by.yodogawa.evidence.m80Runner, null);
  assert.ok(r.summary.noEvidenceInGit.includes('yodogawa'));
});

test('classifyClick maps only recorded reasons', () => {
  const mk = (reason, selected) => ({ click: { target: 'a', selected, reason } });
  assert.strictEqual(A.classifyClick(mk('no-screen-point-picks-target', null)).cls, 'pick-geometry');
  assert.strictEqual(A.classifyClick(mk('selected-other-id', 'b')).cls, 'overlap-or-duplicate-id');
  assert.strictEqual(A.classifyClick(mk('click-did-not-select', null)).cls, 'input-or-render');
  assert.strictEqual(A.classifyClick({ click: { target: 'a', selected: 'a' } }).cls, 'none');
  assert.strictEqual(A.classifyClick(null).cls, 'unclassified');
});

test('--local fixture: in-ward ok, out-of-ward + dup id + sentinel flagged; sources untouched', () => {
  const polys = require('../data/processed/osaka-city/boundaries/ward-classification-polygons.json').wards;
  const kita = polys.find((w) => w.wardId === 'kita'), chuo = polys.find((w) => w.wardId === 'chuo');
  const inside = (w) => { const b = w.bbox; for (let i = 0; i < 4000; i++) { const x = b.minX + Math.random() * (b.maxX - b.minX), z = b.minZ + Math.random() * (b.maxZ - b.minZ); if (require('../tools/mission130/accept-lib.cjs').insideWard(w, x, z)) return [x, z]; } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm159-'));
  const mk = (ward, byId, ids, code) => {
    const d = path.join(root, ward + '25'); fs.mkdirSync(path.join(d, 'attrs'), { recursive: true }); fs.mkdirSync(path.join(d, 'ids'));
    fs.writeFileSync(path.join(d, 'tileset.json'), '{}'); fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify({ wardCode: code }));
    fs.writeFileSync(path.join(d, 'attrs', 't.json'), JSON.stringify({ byId })); fs.writeFileSync(path.join(d, 'ids', 't.json'), JSON.stringify(ids));
  };
  const [kx, kz] = inside(kita), [cx, cz] = inside(chuo);
  mk('kita', { bldg_a: [30, 0, kx, kz], bldg_dup: [10, 0, kx, kz], bldg_s: [29997, 0, kx, kz] }, ['bldg_a', 'bldg_dup', 'bldg_s'], String(kita.wardCode));
  mk('chuo', { bldg_dup: [10, 0, cx, cz], bldg_x: [12, 0, kx, kz] }, ['bldg_dup', 'bldg_x'], String(chuo.wardCode)); // bldg_x lies in kita
  const before = fs.readFileSync(path.join(root, 'kita25', 'attrs', 't.json'), 'utf8');
  const r = A.build({ local: root });
  const by = Object.fromEntries(r.rows.map((x) => [x.wardId, x]));
  assert.strictEqual(by.kita.local.repInsideOwnN03Pct, 100);
  assert.strictEqual(by.kita.local.sentinelHeights, 1);
  assert.strictEqual(by.chuo.local.repInsideOtherWardN03, 1);
  assert.strictEqual(by.chuo.local.otherWards.kita, 1);
  assert.ok(by.chuo.local.flags.some((f) => /rep-points-mostly-outside-own-N03/.test(f)));
  assert.deepStrictEqual(r.summary.crossWardDupPairs, { 'kita|chuo': 1 });
  assert.strictEqual(r.summary.localChecked, 2);
  assert.ok(by.abeno.local.state);
  assert.strictEqual(fs.readFileSync(path.join(root, 'kita25', 'attrs', 't.json'), 'utf8'), before);
});

test('tool is read-only: no network, delete, copy or git-write calls; refuses overwrite', () => {
  const s = fs.readFileSync(path.join(__dirname, '../tools/mission159/ward-audit.cjs'), 'utf8');
  assert.ok(!/require\(['"](https?|net|child_process)['"]\)|fetch\(|unlinkSync|rmSync|rmdirSync|copyFile|renameSync/.test(s));
  assert.ok(/refusing to overwrite/.test(s) && /flag: 'wx'/.test(s));
});
