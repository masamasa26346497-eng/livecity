'use strict';
// Mission 45J follow-up: --out-root (45D layout) resolution via 45E plan(). 合成 fixture のみ。実データ・実機 Windows では未確認。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../tools/mission45d-convert-all.cjs');
const L = require('../tools/mission40b-legacy-tiles-batch.cjs');
const L40 = require('../tools/mission40g-build-ward-layers.cjs');
const K = require('../tools/mission45j-align-check.cjs');
const ROOT = path.join(__dirname, '..');
const REPO_BLD = path.join(ROOT, 'public/map-data/osaka-city/buildings');
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm45jo-'));
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
test.afterEach(() => L.setSource(REPO_BLD));

// city = <osaka-city root> that contains buildings/ (the CLI's --src); same fixture shape as the 45E tests
function fixture() {
  const city = tmp(), src = path.join(city, 'buildings'); const ds = [];
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
  return { city, src };
}
const synth = (src) => (dir) => { L.setSource(src); return L.convertWard('sumiyoshi', { out: dir, force: true }); };
function built() {
  const { city, src } = fixture(); const out = path.join(tmp(), 'out');
  const r = A.run({ src, outRoot: out, execute: true, approved: true, sumiyoshiRun: synth(src) });
  assert.strictEqual(r.complete, true, JSON.stringify(r.problems));
  return { out, base: { src: city, outRoot: out, allowSynthetic: true, sumiyoshiRun: synth(src) } };
}
const snap = (d) => fs.readdirSync(d, { recursive: true, withFileTypes: true }).map((e) => path.join(e.parentPath || e.path, e.name) + ':' + (e.isFile() ? fs.statSync(path.join(e.parentPath || e.path, e.name)).size : 'd')).sort().join('\n');

test('resolves pc23/<ward>-aN and nested sumiyoshi dirs that hold attrs, without writing', () => {
  const { out, base } = built(); const before = snap(out);
  const f = K.resolveVerifiedWardDir(Object.assign({ ward: 'fukushima' }, base));
  assert.ok(f.dir.includes(path.join('pc23', 'fukushima-a')) && f.verified === true);
  assert.ok(fs.existsSync(path.join(f.dir, 'attrs')));
  const s = K.resolveVerifiedWardDir(Object.assign({ ward: 'sumiyoshi' }, base));
  assert.ok(s.dir.includes('sumiyoshi-a') && fs.existsSync(path.join(s.dir, 'attrs')));
  assert.strictEqual(snap(out), before, 'source/output untouched');
});

test('the naive <root>/<ward> join finds no points, the resolved dir is the one with attrs', () => {
  const { out, base } = built();
  assert.strictEqual(L40.buildingPoints(path.join(out, 'fukushima')).length, 0);
  const f = K.resolveVerifiedWardDir(Object.assign({ ward: 'fukushima' }, base));
  assert.notStrictEqual(path.resolve(f.dir), path.resolve(path.join(out, 'fukushima')));
  assert.ok(fs.statSync(path.join(f.dir, 'attrs')).isDirectory());
});

test('unknown ward, missing root and fake/unmarked root are refused', () => {
  const { base } = built();
  assert.throws(() => K.resolveVerifiedWardDir(Object.assign({}, base, { ward: 'nowhere' })));
  assert.throws(() => K.resolveVerifiedWardDir(Object.assign({}, base, { ward: 'fukushima', outRoot: path.join(tmp(), 'missing') })));
  const fake = tmp();
  wj(path.join(fake, 'pc23', 'fukushima-a1', 'attrs', 't_0_0.json'), { byId: { a: [0, 0, 1, 1] } });
  assert.throws(() => K.resolveVerifiedWardDir(Object.assign({}, base, { ward: 'fukushima', outRoot: fake })));
});

test('tampered output (attrs removed) is no longer verified', () => {
  const { base } = built();
  const d = K.resolveVerifiedWardDir(Object.assign({ ward: 'fukushima' }, base)).dir;
  fs.rmSync(path.join(d, 'attrs'), { recursive: true, force: true });
  assert.throws(() => K.resolveVerifiedWardDir(Object.assign({ ward: 'fukushima' }, base)));
});

test('CLI wiring: --out-root added, --ext kept, repPoints=0 exits non-zero, tool never writes', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/mission45j-align-check.cjs'), 'utf8');
  assert.match(s, /opt\('out-root'\)/);
  assert.match(s, /opt\('ext'\)/);
  assert.match(s, /process\.exit\(4\)/);
  assert.doesNotMatch(s, /writeFile|mkdirSync|rmSync|unlink|copyFile|rename/);
});
