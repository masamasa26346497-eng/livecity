'use strict';
// Mission 45N: --out-root/--ward/--src-root で 45D の実レイアウト (pc23/<ward>-aN, sumiyoshi-aN/sumiyoshi) を解決して GLB 検証できること（合成 fixture の E2E）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../tools/mission45d-convert-all.cjs');
const L = require('../tools/mission40b-legacy-tiles-batch.cjs');
const V = require('../tools/mission45m-verify-glb-geometry.cjs');
const ROOT = path.join(__dirname, '..');
const REPO_BLD = path.join(ROOT, 'public/map-data/osaka-city/buildings');
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm45n-'));
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
test.afterEach(() => L.setSource(REPO_BLD));

function fixture() {
  const src = tmp(); const ds = [];
  wards.forEach((w, wi) => {
    const dir = path.join(src, 'osaka-' + w.id); const tiles = [];
    for (let t = 0; t < 2; t++) {
      const bs = [0, 1, 2].map((k) => ({ id: 'bldg_' + String(wi).padStart(2, '0') + t + k + '-fixture', fp: [[t * 600, 0], [t * 600 + 10, 0], [t * 600 + 10, 10], [t * 600, 10]], h: 10, repX: 5 + t * 600, repZ: 5 }));
      wj(path.join(dir, 'tile_' + t + '_0.json'), { buildings: bs });
      tiles.push({ tx: t, tz: 0, count: 3, file: 'tile_' + t + '_0.json' });
    }
    wj(path.join(dir, 'manifest.json'), { wardCode: w.code, coordinateConvention: 'znorth-neg-v1', tiles });
    ds.push({ id: 'osaka-' + w.id, wardId: w.id, buildings: 6, tiles: 2 });
  });
  wj(path.join(src, 'manifest.json'), { datasets: ds });
  return src;
}
const synth = (src) => (dir) => { L.setSource(src); return L.convertWard('sumiyoshi', { out: dir, force: true }); };
function built() {
  const src = fixture(); const out = path.join(tmp(), 'out');
  const r = A.run({ src, outRoot: out, execute: true, approved: true, sumiyoshiRun: synth(src) });
  assert.strictEqual(r.complete, true, JSON.stringify(r.problems));
  return { src, out, base: { srcRoot: src, outRoot: out, allowSynthetic: true, sumiyoshiRun: synth(src) } };
}
const snap = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).map((e) => { const f = path.join(e.parentPath || e.path, e.name); return f + ':' + (e.isFile() ? fs.statSync(f).size + ':' + fs.statSync(f).mtimeMs : 'd'); }).sort().join('\n');

test('45N: pc23 ward (fukushima-aN) is resolved from the 45D root and GLB geometry verifies', () => {
  const { src, out, base } = built();
  const before = snap(out) + snap(src);
  const r = V.resolveOutRoot(Object.assign({ ward: 'fukushima' }, base));
  assert.ok(r.tileset.includes(path.join('pc23', 'fukushima-a')));
  assert.strictEqual(r.src, path.join(src, 'osaka-fukushima'));
  const v = V.verify(Object.assign({ maxTiles: 0, tol: 1, sample: 0, requireAttrs: true }, r));
  assert.strictEqual(v.buildingsChecked, 6, JSON.stringify(v));
  assert.strictEqual(v.idsNotCanonical, 0);
  assert.strictEqual(v.pass, true, JSON.stringify(v));
  assert.strictEqual(snap(out) + snap(src), before, 'no data mutation');
});

test('45N: sumiyoshi nested dir (sumiyoshi-aN/sumiyoshi) is resolved', () => {
  const { base } = built();
  const r = V.resolveOutRoot(Object.assign({ ward: 'sumiyoshi' }, base));
  assert.ok(r.tileset.includes('sumiyoshi-a') && fs.existsSync(path.join(r.tileset, 'tileset.json')));
  const v = V.verify(Object.assign({ maxTiles: 0, tol: 1, sample: 0 }, r));
  assert.ok(v.buildingsChecked > 0);
  assert.strictEqual(v.pass, true, JSON.stringify(v));
});

test('45N: a newer version attempt (fukushima-a2) is chosen from the proof, not guessed', () => {
  const { out, base } = built();
  const a1 = path.join(out, 'pc23', 'fukushima-a1');
  assert.ok(fs.existsSync(a1));
  // a stray unverified a2 dir without tileset must not be picked
  fs.mkdirSync(path.join(out, 'pc23', 'fukushima-a2'));
  const r = V.resolveOutRoot(Object.assign({ ward: 'fukushima' }, base));
  assert.ok(r.tileset.endsWith('fukushima-a1'), r.tileset);
});

test('45N: missing / fake root, bad ward, wrong src-root all fail with a code (no silent success)', () => {
  const { src, out, base } = built();
  assert.throws(() => V.resolveOutRoot(Object.assign({}, base, { ward: 'fukushima', outRoot: path.join(tmp(), 'nope') })), (e) => Number.isInteger(e.code));
  const fake = tmp(); fs.writeFileSync(path.join(fake, 'x.txt'), 'x');
  assert.throws(() => V.resolveOutRoot(Object.assign({}, base, { ward: 'fukushima', outRoot: fake })), (e) => Number.isInteger(e.code));
  assert.throws(() => V.resolveOutRoot(Object.assign({}, base, { ward: '../x' })), (e) => e.code === 2);
  assert.throws(() => V.resolveOutRoot(Object.assign({}, base, { ward: 'atlantis' })), (e) => Number.isInteger(e.code));
  assert.throws(() => V.resolveOutRoot(Object.assign({}, base, { ward: 'fukushima', srcRoot: tmp() })), (e) => e.code === 3);
  // CLI path never allows the synthetic proof: exits non-zero
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/mission45m-verify-glb-geometry.cjs'), '--out-root', out, '--src-root', src, '--ward', 'fukushima'], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.ok(!/\{\s*"pass": true/.test(r.stdout));
});

test('45N: missing attrs and non-canonical ids are reported / fail pass', () => {
  const { base } = built();
  const r = V.resolveOutRoot(Object.assign({ ward: 'fukushima' }, base));
  const attrs = path.join(r.tileset, 'attrs');
  if (fs.existsSync(attrs)) fs.rmSync(attrs, { recursive: true }); // fixture dir under os.tmpdir only
  const v = V.verify(Object.assign({ maxTiles: 0, tol: 1, sample: 0, requireAttrs: true }, r));
  assert.ok(v.attrsMissingTiles > 0);
  assert.strictEqual(v.pass, false);
  const idsDir = path.join(r.tileset, 'ids'); const f = fs.readdirSync(idsDir).find((x) => x.startsWith('t_'));
  const ids = JSON.parse(fs.readFileSync(path.join(idsDir, f), 'utf8')); ids[0] = 'xx_' + ids[0];
  fs.writeFileSync(path.join(idsDir, f), JSON.stringify(ids));
  const v2 = V.verify(Object.assign({ maxTiles: 0, tol: 1, sample: 0 }, r));
  assert.ok(v2.idsNotCanonical > 0);
  assert.strictEqual(v2.pass, false);
});

test('45N: legacy --tileset/--src still works; bad paths throw instead of passing; scope note is explicit', () => {
  const d = tmp();
  assert.throws(() => V.verify({ tileset: d, src: d, tol: 1 }), (e) => Number.isInteger(e.code));
  const r = V.verify({ tileset: path.join(ROOT, 'public/mission37b-3dtiles/osaka-sumiyoshi-9tile'), src: path.join(REPO_BLD, 'osaka-sumiyoshi'), maxTiles: 1, tol: 1, sample: 10 });
  assert.strictEqual(r.pass, true);
  assert.match(r.scope, /SOURCE footprint only/);
  const readme = fs.readFileSync(path.join(ROOT, 'MISSION45M_README.md'), 'utf8');
  assert.ok(!/--tileset "\$env:LOCALAPPDATA/.test(readme));
  assert.ok(!/変換連鎖は健全で、ずれの原因は元データ側。/.test(readme));
});

test('45N: ?perf=1 HUD has A/B buttons and a 10s gesture measurement; logs are aggregates only', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.match(html, /__mission45n/);
  assert.match(html, /10秒測定/);
  assert.match(html, /道路\/面 ON/);
  assert.match(html, /longTasks:/);
});
