'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const ROOT = path.join(__dirname, '..');
const M = () => import('../tools/mission141-local-24.mjs');
const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ s: r.statusCode, b })); }).on('error', rej));
const mk = (root, name, ids, wardCode) => { const d = path.join(root, name); fs.mkdirSync(path.join(d, 'ids'), { recursive: true }); fs.writeFileSync(path.join(d, 'tileset.json'), '{"asset":{"version":"1.1"},"root":{}}'); fs.writeFileSync(path.join(d, 'ids', 't_0_0.json'), JSON.stringify(ids)); if (wardCode) fs.writeFileSync(path.join(d, 'source.json'), JSON.stringify({ wardCode })); return d; };

test('142: --local parsing (Windows drive letters ok, bad input rejected)', async () => {
  const { parseLocal } = await M();
  assert.deepStrictEqual(parseLocal('fukushima=C:\\lc\\fuku,yodogawa="D:\\x y\\yodo"'), { fukushima: 'C:\\lc\\fuku', yodogawa: 'D:\\x y\\yodo' });
  assert.deepStrictEqual(parseLocal(null), {});
  assert.throws(() => parseLocal('fukushima'));
  assert.throws(() => parseLocal('Bad Id=x'));
});

test('142: --local reuses an existing output without copying, and still validates it', async () => {
  const { loadWards, resolveWards } = await M();
  const wards = loadWards(), wc = (id) => wards.find((w) => w.wardId === id).wardCode;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'm142l-')), dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm142d-')), emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'm142r-'));
  const good = mk(outside, 'my-fukushima', ['bldg_a', 'bldg_b'], wc('fukushima'));
  const bad = mk(outside, 'my-yodogawa', ['bldg_c'], '99999');
  const { rows, map } = resolveWards({ root: emptyRepo, dataRoot, wards, local: { fukushima: good, yodogawa: bad } });
  const f = rows.find((r) => r.ward === 'fukushima'), y = rows.find((r) => r.ward === 'yodogawa');
  assert.strictEqual(f.status, 'served'); assert.strictEqual(f.origin, 'local-input'); assert.strictEqual(map.fukushima25, good);
  assert.strictEqual(y.status, 'not-delivered');
  assert.ok(!fs.existsSync(path.join(dataRoot, 'fukushima25')), 'nothing copied');
  const miss = resolveWards({ root: emptyRepo, dataRoot, wards, local: { fukushima: path.join(outside, 'nope') } }).rows.find((r) => r.ward === 'fukushima');
  assert.strictEqual(miss.status, 'not-delivered'); assert.ok(/no tileset\.json/.test(miss.note));
});

test('142: layers only for served wards that really have road/river files; no fake data', async () => {
  const { resolveLayers } = await M();
  const lr = fs.mkdtempSync(path.join(os.tmpdir(), 'm142y-'));
  fs.mkdirSync(path.join(lr, 'kita', 'layers'), { recursive: true });
  fs.writeFileSync(path.join(lr, 'kita', 'layers', 'roads.json'), '{}'); fs.writeFileSync(path.join(lr, 'kita', 'layers', 'layers-report.json'), '{}');
  fs.mkdirSync(path.join(lr, 'chuo', 'layers'), { recursive: true });
  fs.writeFileSync(path.join(lr, 'chuo', 'layers', 'layers-report.json'), '{}');   // report without any layer file -> not served
  const r = resolveLayers({ layersRoot: lr, map: { kita25: '/x', chuo25: '/y', nishi25: '/z' } });
  assert.deepStrictEqual(Object.keys(r.layers), ['kita25']);
  assert.deepStrictEqual(r.rows.find((x) => x.ward === 'kita').files, ['roads']);
  assert.strictEqual(r.rows.find((x) => x.ward === 'chuo').status, 'no-layers');
  assert.strictEqual(r.rows.find((x) => x.ward === 'nishi').status, 'no-layers');
  assert.deepStrictEqual(resolveLayers({ layersRoot: null, map: { kita25: '/x' } }).layers, {});
});

test('142: server serves layers only for registered keys + known files; index lists layersWards; missing = real 404', async () => {
  const { makeServer } = await import('../tools/mission81-local-preview.mjs');
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm142s-')), lr = fs.mkdtempSync(path.join(os.tmpdir(), 'm142z-'));
  const k = mk(dataRoot, 'kita25', ['bldg_a'], '27127'), c = mk(dataRoot, 'chuo25', ['bldg_b'], '27128');
  fs.writeFileSync(path.join(lr, 'roads.json'), '{"features":[]}'); fs.writeFileSync(path.join(lr, 'secret.json'), '{}'); fs.writeFileSync(path.join(lr, 'layers-report.json'), '{}');
  const srv = makeServer({ publicDir: path.join(ROOT, 'public'), wards: { kita25: k, chuo25: c }, layers: { kita25: lr, ghost25: lr } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  try {
    const idx = JSON.parse((await get(port, '/ext-3dtiles/index.json')).b);
    assert.deepStrictEqual(idx.layersWards, [{ ward: 'kita25' }]); assert.strictEqual(idx.wards.length, 2);
    assert.strictEqual((await get(port, '/ext-3dtiles/kita25/layers/roads.json')).s, 200);
    assert.strictEqual((await get(port, '/ext-3dtiles/kita25/layers/waterways.json')).s, 404);
    assert.strictEqual((await get(port, '/ext-3dtiles/kita25/layers/secret.json')).s, 404);
    assert.strictEqual((await get(port, '/ext-3dtiles/kita25/layers/..%2fsecret.json')).s, 404);
    assert.strictEqual((await get(port, '/ext-3dtiles/chuo25/layers/roads.json')).s, 404);
    assert.strictEqual((await get(port, '/ext-3dtiles/ghost25/layers/roads.json')).s, 404);
    assert.strictEqual((await get(port, '/ext-3dtiles/kita25/tileset.json')).s, 200);
  } finally { srv.close(); }
});

test('142: launcher source: Windows-safe tar, retry, stale cleanup, still read-only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/mission141-local-24.mjs'), 'utf8');
  assert.ok(/cwd: work/.test(src) && /cwd: ex/.test(src), 'tar runs with cwd + relative names (no drive-letter -f)');
  assert.ok(/function retry/.test(src) && /MAX_PATH/.test(src));
  assert.ok(!/'(upload|create|delete|edit)'/.test(src) && !/GH_TOKEN|0\.0\.0\.0/.test(src));
  assert.ok(/binding is fixed to 127\.0\.0\.1/.test(src));
});

test('142: recorded real-Chrome E2E (fixture) passed every check', () => {
  const p = path.join(ROOT, 'data/reports/mission142/e2e.json');
  assert.ok(fs.existsSync(p), 'run: node tools/experiments/mission142_switch_e2e.mjs');
  const o = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(o.pass, true); assert.ok(Object.values(o.checks).every(Boolean));
  assert.deepStrictEqual(o.googleRequests, []); assert.deepStrictEqual(o.jsErrors, []);
  assert.ok(/not owner data/.test(o.fixture) && /not Windows/.test(o.fixture), 'fixture is labelled as such');
});
