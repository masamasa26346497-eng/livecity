import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// package.json is "type": "module", so evaluate the UMD browser file in a vm with a CommonJS shim.
const sandbox = { module: { exports: {} }, console, setTimeout, Promise };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'mission38f-facility-fastload.js'), 'utf8'), sandbox);
const F = sandbox.module.exports;

const DIR = path.join(__dirname, '..', 'public', 'map-data', 'osaka-city', 'facilities');
const fsFetch = (log, opts = {}) => async (url) => {
  const rel = url.slice(url.indexOf('facilities/') + 'facilities/'.length);
  log.push(rel);
  if (opts.delay && opts.delay[rel]) await new Promise((r) => setTimeout(r, opts.delay[rel]));
  if (opts.fail && opts.fail(rel)) return { ok: false, status: 503, text: async () => '' };
  return { ok: true, status: 200, text: async () => fs.readFileSync(path.join(DIR, rel), 'utf8') };
};
const mk = (log, opts) => F.createLoader({ baseUrl: 'x/facilities/', fetchImpl: fsFetch(log, opts) });

test('startup sample is 1120 and distinct from full 40585', async () => {
  const log = [];
  const l = mk(log);
  const s = await l.loadStartup();
  assert.strictEqual(s.sampleCount, 1120);
  assert.strictEqual(s.sourceRecordCount, 40585);
  const m = await l.loadManifest();
  assert.strictEqual(m.wards.reduce((a, w) => a + w.recordCount, 0), 40585);
  assert.ok(!log.some((x) => x.startsWith('wards/')), 'startup must not fetch ward files');
});

test('all 24 wards: counts match manifest, no duplicate sourceId, total 40585', async () => {
  const l = mk([]);
  const m = await l.loadManifest();
  let total = 0;
  for (const w of m.wards) {
    const r = await l.loadWard(w.wardId);
    assert.strictEqual(r.length, w.recordCount, w.wardId);
    assert.strictEqual(new Set(r.map((x) => x.sourceId)).size, r.length);
    total += r.length;
  }
  assert.strictEqual(total, 40585);
});

test('ward cache and in-flight sharing: one request per ward', async () => {
  const log = [];
  const l = mk(log, { delay: { 'wards/abeno.json': 20 } });
  const [a, b] = await Promise.all([l.loadWard('abeno'), l.loadWard('abeno')]);
  await l.loadWard('abeno');
  assert.strictEqual(a, b);
  assert.strictEqual(log.filter((x) => x === 'wards/abeno.json').length, 1);
});

test('stale ward result is discarded', async () => {
  const l = mk([], { delay: { 'wards/chuo.json': 60 } });
  const slow = l.selectWard('chuo');
  const fast = l.selectWard('abeno');
  const [s, f] = await Promise.all([slow, fast]);
  assert.strictEqual(s.stale, true);
  assert.strictEqual(f.stale, false);
  assert.strictEqual(f.wardId, 'abeno');
});

test('failure is not cached and recovers on retry; stale failure is silent', async () => {
  let failing = true;
  const log = [];
  const l = mk(log, { fail: (rel) => failing && rel === 'wards/abeno.json' });
  await assert.rejects(l.selectWard('abeno'), /HTTP 503/);
  assert.strictEqual(l.isWardCached('abeno'), false);
  failing = false;
  const r = await l.selectWard('abeno');
  assert.strictEqual(r.records.length, 851);
  assert.ok(l.getStats().failures >= 1);

  failing = true;
  const l2 = mk([], { fail: (rel) => rel === 'wards/abeno.json' });
  const p1 = l2.selectWard('abeno');
  const p2 = l2.selectWard('asahi');
  assert.strictEqual((await p1).stale, true);
  assert.strictEqual((await p2).stale, false);
});

test('unknown ward and malformed JSON reject', async () => {
  const l = mk([]);
  await assert.rejects(l.loadWard('nowhere'), /unknown ward/);
  const bad = F.createLoader({ baseUrl: 'x/facilities/', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{oops' }) });
  await assert.rejects(bad.loadManifest());
});

test('dedupeBySourceId drops repeats and keyless rows', () => {
  const out = F.dedupeBySourceId([{ sourceId: 'a' }, { sourceId: 'a' }, { sourceId: 'b' }, {}]);
  assert.deepStrictEqual([...out.map((x) => x.sourceId)], ['a', 'b']); // spread: array comes from the vm realm
});

test('describe: missing fields -> 情報なし, OSM/ODbL kept, values are strings', () => {
  const d = F.describe({ name: 'X', phone: null, website: '', wheelchair: 'unknown', source: 'OpenStreetMap (Overpass API)', license: 'ODbL 1.0', attribution: '© OpenStreetMap contributors' });
  assert.strictEqual(d.phone, '情報なし');
  assert.strictEqual(d.website, '情報なし');
  assert.strictEqual(d.wheelchair, '情報なし');
  assert.strictEqual(d.address, '情報なし');
  assert.strictEqual(d.license, 'ODbL 1.0');
  assert.match(d.attribution, /OpenStreetMap/);
  assert.match(F.describe({}).attribution, /OpenStreetMap/);
  Object.values(d).forEach((v) => assert.strictEqual(typeof v, 'string'));
});

test('search: name, category filter, limit, total', async () => {
  const l = mk([]);
  const { records } = await l.selectWard('chuo');
  const all = F.search(records, '', { limit: 10 });
  assert.strictEqual(all.total, 5084);
  assert.strictEqual(all.results.length, 10);
  const dining = F.search(records, '', { category: 'dining', limit: 5000 });
  assert.ok(dining.results.every((r) => r.category === 'dining'));
  const name = records.find((r) => r.name).name;
  const hit = F.search(records, name);
  assert.ok(hit.results.some((r) => r.name === name));
  assert.strictEqual(F.search(records, '存在しない名称zzzqqq').total, 0);
});

test('preview HTML: no Google/external scripts, uses textContent not innerHTML, shows attribution', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'mission38f-facility-preview.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'mission38f-facility-fastload.js'), 'utf8');
  for (const src of [html, js]) {
    assert.ok(!/googleapis|google\.com|maps\.google|gstatic/i.test(src));
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(src));
  }
  assert.ok(!/<script[^>]+src="https?:/i.test(html));
  assert.match(html, /ATTRIBUTION/);
});

test('cancelSelection: slow ward finishing after cancel (back to sample) is stale', async () => {
  const l = mk([], { delay: { 'wards/chuo.json': 60 } });
  const slow = l.selectWard('chuo');
  l.cancelSelection(); // user went back to the sample view
  assert.strictEqual((await slow).stale, true);
});

test('cancelSelection: failure of a cancelled ward request is silent', async () => {
  const l = mk([], { fail: (rel) => rel === 'wards/chuo.json', delay: { 'wards/chuo.json': 30 } });
  const slow = l.selectWard('chuo');
  l.cancelSelection();
  assert.strictEqual((await slow).stale, true);
});

test('selectSample: slow sample finishing after a ward selection is stale; ward wins', async () => {
  const l = mk([], { delay: { 'facilities-startup.json': 60 } });
  const sample = l.selectSample();
  const ward = l.selectWard('abeno');
  const [s, w] = await Promise.all([sample, ward]);
  assert.strictEqual(s.stale, true);
  assert.strictEqual(w.stale, false);
  assert.strictEqual(w.records.length, 851);
});

test('selectSample: returns the 1120 sample when it is the latest selection', async () => {
  const l = mk([]);
  const s = await l.selectSample();
  assert.strictEqual(s.stale, false);
  assert.strictEqual(s.records.length, 1120);
});

test('preview: showSample goes through the token-protected selectSample; catches ignore stale', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'mission38f-facility-preview.html'), 'utf8');
  assert.match(html, /loader\.selectSample\(\)/);
  assert.ok(!/loader\.loadStartup\(\)\.then/.test(html), 'showSample must not bypass the token');
  assert.match(html, /loader\.isCurrent\(/);
});
