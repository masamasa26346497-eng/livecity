'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const M = () => import('../tools/mission90-pc-verify.mjs');
const rep = { disk: { recommendedFreeMB: 5000 }, wards: [
  { wardId: 'nishi', wardCode: '27106', meshes: 4, artifactReady: false, compressedMB: 50, inflatedMB: 900, noBldgMeshes: [] },
  { wardId: 'kita', wardCode: '27127', meshes: 5, artifactReady: true, compressedMB: 60, inflatedMB: 1500, noBldgMeshes: [] }] };

test('args: execute requires explicit caps; validated', async () => {
  const m = await M();
  assert.strictEqual(m.parseArgs([]).execute, false);
  assert.throws(() => m.parseArgs(['--execute']));
  assert.throws(() => m.parseArgs(['--execute', '--max-download-mb', '10']));
  assert.throws(() => m.parseArgs(['--wards', 'a;b']));
  assert.throws(() => m.parseArgs(['--port', '80']));
  assert.strictEqual(m.parseArgs(['--execute', '--max-download-mb', '100', '--deadline-min', '30']).execute, true);
});
test('plan: only unready wards are converted; ready ward costs nothing', async () => {
  const m = await M(); const o = m.parseArgs([]);
  const p = m.buildPlan(rep, o, (w) => w === 'kita');
  assert.deepStrictEqual(p.rows.map((r) => [r.ward, r.needConvert, r.needCollect]), [['nishi', true, true], ['kita', false, false]]);
  assert.strictEqual(p.downloadMBEstimate, 50);
});
test('gate: refuses CI, low disk, over cap, unknown disk', async () => {
  const m = await M(); const o = m.parseArgs(['--execute', '--max-download-mb', '10', '--deadline-min', '5']);
  const p = m.buildPlan(rep, o, () => false);
  const why = m.gate(p, o, null, { CI: 'true' }).join('|');
  assert.ok(/CI/.test(why) && /取得見込み/.test(why) && /空き容量を取得できない/.test(why));
  const o2 = m.parseArgs(['--execute', '--max-download-mb', '999999', '--deadline-min', '5', '--max-mb', '2000']);
  assert.deepStrictEqual(m.gate(m.buildPlan(rep, o2, () => false), o2, 100, {}), []);
  assert.ok(m.gate(m.buildPlan(rep, o2, () => false), o2, 1, {}).length > 0);
  const o3 = m.parseArgs(['--execute', '--max-download-mb', '999999', '--deadline-min', '5']);
  assert.ok(/--max-mb/.test(m.gate(m.buildPlan(rep, o3, () => false), o3, 100, {}).join('|')) === false); // 1500 > 1400 only matters for wards to convert
});
test('steps reuse existing tools; no reimplementation, no delete/copy/network/detach', async () => {
  const m = await M(); const o = m.parseArgs([]);
  assert.strictEqual(m.stepArgs('convert', 'nishi', o)[0], 'tools/mission80-batch.mjs');
  assert.strictEqual(m.stepArgs('collect', 'nishi', o)[0], 'tools/mission88-collect-evidence.mjs');
  assert.strictEqual(m.stepArgs('accept', null, o)[0], 'tools/mission86-acceptance.mjs');
  const src = fs.readFileSync(path.join(ROOT, 'tools/mission90-pc-verify.mjs'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/detached|\.unref\(|\bspawn\(|exec\(|rmSync|unlink|copyFile|cpSync|fetch\(|--fixture|git /.test(src));
});
