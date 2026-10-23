'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const T = require('../tools/mission40g-build-ward-layers.cjs');
const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools/mission40g-build-ward-layers.cjs');
const page = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
const fuk = wards.find((w) => w.wardId === 'fukushima');

function mkdirs(...ps) { for (const p of ps) fs.mkdirSync(p, { recursive: true }); }
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm40g-'));
  const src = path.join(tmp, 'src'), ext = path.join(tmp, 'ext');
  const cx = (fuk.bbox.minX + fuk.bbox.maxX) / 2, cz = (fuk.bbox.minZ + fuk.bbox.maxZ) / 2;
  for (const l of ['roads', 'waterways', 'parks', 'railways']) {
    mkdirs(path.join(src, l));
    fs.writeFileSync(path.join(src, l, 'manifest.json'), JSON.stringify({ tileSize: 2000, generatedAt: 'x' }));
  }
  const tile = (l, feats) => {
    const tx = Math.floor(cx / 2000), tz = Math.floor(cz / 2000);
    fs.writeFileSync(path.join(src, l, `tile_${tx}_${tz}.json`), JSON.stringify({ features: feats }));
    // same feature id duplicated in a neighbouring tile must be deduped
    fs.writeFileSync(path.join(src, l, `tile_${tx + 1}_${tz}.json`), JSON.stringify({ features: feats }));
  };
  tile('roads', [{ id: 'r1', kind: 'line', tier: 'major', p: [[cx - 300, cz], [cx, cz], [cx + 300, cz]] },
                 { id: 'far', kind: 'line', tier: 'local', p: [[cx + 90000, cz], [cx + 90100, cz]] }]);
  tile('waterways', [{ id: 'w1', kind: 'area', p: [[cx, cz + 50], [cx + 50, cz + 50], [cx + 50, cz + 90]] }]);
  const w = path.join(ext, 'fukushima');
  mkdirs(path.join(w, 'attrs'));
  fs.writeFileSync(path.join(w, 'tileset.json'), '{"asset":{"version":"1.0"}}');
  fs.writeFileSync(path.join(w, 'attrs', 't_0_0.json'), JSON.stringify({ byId: { b1: [10, null, cx, cz + 10, 0], b2: [10, null, cx + 120, cz - 5, 0], b3: [10, null, 1e7, 1e7, 0] } }));
  return { tmp, src, ext, w, cx, cz };
}
const run = (args) => cp.spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });

test('clipLine keeps inside runs and one neighbour vertex, drops outside', () => {
  const box = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  assert.equal(T.clipLine([[20, 0], [30, 0]], box).length, 0);
  const r = T.clipLine([[-5, 5], [5, 5], [15, 5]], box);
  assert.equal(r.length, 1); assert.equal(r[0].length, 3);
});

test('inWard uses N03 polygon of the same local frame', () => {
  const cxz = fuk.polygons[0].outer[0];
  assert.ok(Number.isFinite(cxz[0]));
  assert.equal(T.inWard(fuk, 1e7, 1e7), false);
  assert.ok(fuk.bbox.minZ < -8000, 'north is negative z (znorth-neg-v1)');
});

test('tool writes new layers only, dedupes, clips, reports alignment; sources untouched', () => {
  const f = fixture();
  const before = fs.readdirSync(path.join(f.src, 'roads')).map((n) => fs.readFileSync(path.join(f.src, 'roads', n), 'utf8'));
  const r = run(['--src', f.src, '--ward', 'fukushima', '--ext', f.ext]);
  assert.equal(r.status, 0, r.stderr);
  const roads = JSON.parse(fs.readFileSync(path.join(f.w, 'layers', 'roads.json'), 'utf8'));
  assert.equal(roads.count, 1); assert.equal(roads.features[0].id, 'r1');
  assert.ok(fs.existsSync(path.join(f.w, 'layers', 'waterways.json')));
  assert.ok(!fs.existsSync(path.join(f.w, 'layers', 'railways.json')) || JSON.parse(fs.readFileSync(path.join(f.w, 'layers', 'railways.json'), 'utf8')).count === 0);
  const rep = JSON.parse(fs.readFileSync(path.join(f.w, 'layers', 'layers-report.json'), 'utf8'));
  assert.equal(rep.alignment.buildingRepPoints, 3);
  assert.ok(rep.alignment.buildingPointsInsideWardPolygonPct < 100, 'outlier b3 is outside the ward polygon');
  assert.ok(typeof rep.alignment.cellsWithNoDataAtAllPct === 'number');
  assert.equal(fs.readFileSync(path.join(f.w, 'tileset.json'), 'utf8'), '{"asset":{"version":"1.0"}}');
  const after = fs.readdirSync(path.join(f.src, 'roads')).map((n) => fs.readFileSync(path.join(f.src, 'roads', n), 'utf8'));
  assert.deepEqual(after, before);
  // second run must refuse to overwrite
  const r2 = run(['--src', f.src, '--ward', 'fukushima', '--ext', f.ext]);
  assert.notEqual(r2.status, 0); assert.match(r2.stderr, /refusing to overwrite/);
});

test('--check-only writes nothing; missing tileset is rejected; bad ward rejected', () => {
  const f = fixture();
  const r = run(['--src', f.src, '--ward', 'fukushima', '--ext', f.ext, '--check-only']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(f.w, 'layers')));
  assert.notEqual(run(['--src', f.src, '--ward', 'nowhere', '--ext', f.ext]).status, 0);
  assert.notEqual(run(['--src', f.src, '--ward', '../x', '--ext', f.ext]).status, 0);
});

test('tool has no delete/network and only writes under <ext>/<ward>/layers', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.ok(!/rmSync|unlinkSync|rmdirSync|require\('https?'\)|fetch\(/.test(src));
  assert.equal((src.match(/writeFileSync/g) || []).length, 2);   // layer file + report
});

test('viewer: ward vector layers are scoped to the selected ward and released', () => {
  assert.match(page, /function mountWardVec\(metas, gen\)/);
  assert.match(page, /mountWardVec\(metas, gen\)/);
  const i = page.indexOf('function unmountBuildings()');
  assert.match(page.slice(i, i + 200), /unmountWardVec\(\)/);
  assert.match(page, /gen !== bldgGen\) \{ layer\.destroy\(\)/);   // stale async result is destroyed
  assert.match(page, /layers-report\.json/);                       // absent layers => nothing drawn, no invention
  assert.match(page, /wardVecApply\(id, rec\.visible\)/);          // layer toggles reach ward layers
  assert.match(page, /fetchLayerJson\(file, base\)/);
});

test('viewer: sumiyoshi bundle styling and Google lock unchanged', () => {
  assert.match(page, /makeLineLayer\('roads\.json', roadStyle\)/);
  assert.match(page, /const LAYER_BASE = 'mission37c-layers\/'/);
  assert.match(page, /width: 7\.5, casing: 3\.5/);
  assert.ok(!/maps\.googleapis|places\.googleapis/.test(page));
});
