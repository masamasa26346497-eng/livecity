'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../tools/mission119/readiness.cjs');
const w = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
const MARK = JSON.stringify({ schema: 'livecity.mission45i.layers/1' });
function lay(root, ward, cv, extra) {
  w(path.join(root, ward, 'layers', 'layers-report.json'), JSON.stringify(cv >= 2 ? { clipVersion: 2 } : {}));
  w(path.join(root, ward, 'layers', 'roads.json'), JSON.stringify({ features: [{ p: [[0, 0], [1, 1]] }] }));
  w(path.join(root, ward, 'layers', 'waterways.json'), JSON.stringify({ features: [{ p: [[0, 0], [1, 1]] }, { kind: 'area', p: [[0, 0], [1, 0], [1, 1]] }].concat(extra || []) }));
}
function fixture(chuoExtra) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm119-'));
  const b = path.join(tmp, 'bld'), l1 = path.join(tmp, 'v1'), l2 = path.join(tmp, 'v2');
  for (const ward of ['nishi', 'chuo', 'kita']) {
    w(path.join(b, ward + '25', 'tileset.json'), '{}');
    w(path.join(b, ward + '25', 'tiles', 'a.glb'), 'x');
    w(path.join(b, ward + '25', 'ids', 'a.json'), '[]');
  }
  w(path.join(l1, '.livecity-45i-layers.json'), MARK);
  w(path.join(l2, '.livecity-45i-layers.json'), MARK);
  lay(l1, 'nishi', 1); lay(l1, 'chuo', 1); lay(l1, 'abeno', 1);
  lay(l2, 'chuo', 2, chuoExtra);
  return { b, l1, l2 };
}
test('readiness: both / buildings-only / layers-only, water line vs area, supplemental v2 wins, browserAccepted false', async () => {
  const f = fixture();
  const r = await R.readiness({ buildingsRoot: f.b, layersRoot: f.l1, supplementalLayersRoot: f.l2, http: true });
  const by = Object.fromEntries(r.rows.map((x) => [x.ward, x]));
  assert.strictEqual(r.wards, 24);
  assert.strictEqual(by.nishi.verdict, 'both-servable');
  assert.strictEqual(by.chuo.layers.source, 'supplemental');
  assert.strictEqual(by.kita.verdict, 'buildings-only');
  assert.match(by.abeno.verdict, /^layers-only/);
  assert.strictEqual(by.nishi.layers.stats.waterways.lines, 1);
  assert.strictEqual(by.nishi.layers.stats.waterways.areas, 1);
  assert.strictEqual(by.nishi.buildings.tiles, 1);
  assert.strictEqual(by.nishi.http['layers/waterways.json'].status, 200);
  assert.strictEqual(by.nishi.http['tileset.json'].status, 200);
  assert.strictEqual(r.browserAcceptedWards, 0);
  assert.ok(r.rows.every((x) => x.browserAccepted === false));
  assert.strictEqual(r.rows.filter((x) => x.verdict === 'neither').length, 20);
});
test('readiness: clipVersion 2 vertices outside the ward bbox are flagged; nothing is shifted', async () => {
  const f = fixture([{ p: [[1e6, 1e6], [1e6 + 1, 1e6]] }]);
  const r = await R.readiness({ buildingsRoot: f.b, layersRoot: f.l1, supplementalLayersRoot: f.l2, http: false });
  const c = r.rows.find((x) => x.ward === 'chuo');
  assert.match(c.verdict, /CLIP-V2-VIOLATION/);
  assert.ok(r.problems.length >= 1);
});
test('readiness tool is read-only (no delete/copy/rename APIs, no external network)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../tools/mission119/readiness.cjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/unlinkSync|rmSync|copyFile|renameSync|require\('https'\)/.test(src));
});
