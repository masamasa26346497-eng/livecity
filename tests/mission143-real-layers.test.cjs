'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const M = () => import('../tools/mission141-local-24.mjs');
const wr = (d, f, o) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, f), typeof o === 'string' ? o : JSON.stringify(o)); };
const feat = (n) => ({ features: Array.from({ length: n }, (_, i) => ({ id: 'f' + i, p: [[0, 0], [1, 1]] })) });

test('143: status/report alone is never "ready"; empty or broken layer files are not ready', async () => {
  const { resolveLayers } = await M();
  const lr = fs.mkdtempSync(path.join(os.tmpdir(), 'm143a-'));
  wr(path.join(lr, 'kita', 'layers'), 'status.json', '{"state":"ready"}');
  wr(path.join(lr, 'chuo', 'layers'), 'roads.json', feat(0));
  wr(path.join(lr, 'nishi', 'layers'), 'roads.json', '{not json');
  const r = resolveLayers({ layersRoot: lr, map: { kita25: 'x', chuo25: 'y', nishi25: 'z' } });
  assert.deepStrictEqual(r.layers, {});
  assert.ok(r.rows.every((x) => x.status === 'no-layers' && x.note));
  assert.ok(/unparseable/.test(r.rows.find((x) => x.ward === 'nishi').note));
});

test('143: roads / waterways / water-surface are counted separately per ward', async () => {
  const { resolveLayers } = await M();
  const lr = fs.mkdtempSync(path.join(os.tmpdir(), 'm143b-'));
  wr(path.join(lr, 'kita', 'layers'), 'roads.json', feat(5)); wr(path.join(lr, 'kita', 'layers'), 'waterways.json', feat(2));
  wr(path.join(lr, 'chuo', 'layers'), 'roads.json', feat(3)); wr(path.join(lr, 'chuo', 'layers'), 'water-surface.json', feat(1));
  const r = resolveLayers({ layersRoot: lr, map: { kita25: 'x', chuo25: 'y', fukushima25: 'z' } });
  const k = r.rows.find((x) => x.ward === 'kita'), c = r.rows.find((x) => x.ward === 'chuo'), f = r.rows.find((x) => x.ward === 'fukushima');
  assert.deepStrictEqual([k.roads, k.waterways, k.waterSurface], [true, true, false]);
  assert.deepStrictEqual([c.roads, c.waterways, c.waterSurface], [true, false, true]);
  assert.strictEqual(k.counts.roads.features, 5);
  assert.strictEqual(f.status, 'no-layers'); assert.ok(/no road\/river data/.test(f.note));
});

test('143: auto-discovery finds only roots/sources that really exist; nothing is created', async () => {
  const { discoverLayersRoot, discoverOldSource } = await M();
  const la = fs.mkdtempSync(path.join(os.tmpdir(), 'm143c-'));
  const env = { LOCALAPPDATA: la };
  assert.strictEqual(discoverLayersRoot({ env, home: la }), null);
  const root = path.join(la, 'LiveCity-MapLayers-Out-24');
  wr(path.join(root, 'kita', 'layers'), 'roads.json', feat(1));
  assert.strictEqual(discoverLayersRoot({ env, home: la }), path.resolve(root));
  const old = path.join(la, 'livecity-data-pipeline', 'public', 'map-data', 'osaka-city');
  assert.strictEqual(discoverOldSource({ env: {}, home: la }), null);
  fs.mkdirSync(path.join(old, 'roads'), { recursive: true });
  assert.strictEqual(discoverOldSource({ env: {}, home: la }), path.resolve(old));
});

test('143: launcher keeps 141 invocation, adds --build-layers/--no-layers, no paid API', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/mission141-local-24.mjs'), 'utf8');
  assert.ok(/--build-layers/.test(s) && /--no-layers/.test(s) && /discoverLayersRoot\(\)/.test(s));
  assert.ok(!/googleapis|maps\.google/.test(s));
});

test('143: viewer has separate roads / waterways / water-surface layers on the shared projection', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.ok(/water-surface\.json/.test(h) && /layersWards/.test(h) && /roads\.json/.test(h) && /waterways\.json/.test(h));
  assert.ok(/34\.604208/.test(h));
});
