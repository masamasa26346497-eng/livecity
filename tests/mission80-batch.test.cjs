'use strict';
// Mission 80: PLATEAU 2025 バッチランナーと出力の検証。実出力（temp/mission80/out, temp/mission79）が無い環境では実データ項目を skip する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let B;
test.before(async () => { B = await import(path.join(ROOT, 'tools/mission80-batch.mjs')); });

test('crossWardDuplicates: counts IDs shared by two wards, ignores within-ward repeats', () => {
  const d = B.crossWardDuplicates({ a: ['x', 'y', 'y'], b: ['y', 'z'], c: ['z'] });
  assert.deepEqual(d, { 'a|b': 1, 'b|c': 1 });
});

test('wardIdsFromPolys: 24 wards, unique codes 27102..27128 as strings', () => {
  const polys = JSON.parse(read('data/processed/osaka-city/boundaries/ward-classification-polygons.json'));
  const w = B.wardIdsFromPolys(polys);
  assert.equal(w.length, 24);
  assert.equal(new Set(w.map((x) => x.wardCode)).size, 24);
  assert.equal(new Set(w.map((x) => x.wardId)).size, 24);
  assert.ok(w.every((x) => /^271\d\d$/.test(x.wardCode)));
});

test('batch runner is non-destructive: only temp out/work are removed, no network/paid/public writes', () => {
  const s = read('tools/mission80-batch.mjs');
  assert.ok(!/googleapis|vercel|r2\.cloudflare|amazonaws|fetch\(/i.test(s));
  const rms = s.match(/rmSync\([^)]*\)/g) || [];
  assert.ok(rms.length > 0 && rms.every((r) => /\b(out|work)\b/.test(r)), rms.join('|'));
  assert.ok(!/public\/mission|writeFileSync\([^)]*public/.test(s));
  assert.ok(/status === 'ok'/.test(s), 'resume skips ok wards');
});

test('far-LOD small-building regression: the build tool keeps coarseMinArea 0 (no 100 m2 cut)', () => {
  const s = read('tools/mission79-build-ward-2025.cjs');
  assert.ok(/coarseMinArea:\s*0/.test(s));
  assert.ok(!/coarseMinArea:\s*100/.test(s));
});

test('axis: converter infers lat/lon from EPSG:6697 posList order (lat first, lon > 90) and rejects ambiguous pairs', () => {
  const s = read('tools/mission36k-convert-citygml-runtime.mjs');
  assert.ok(/Math\.abs\(v1\) <= 90 && Math\.abs\(v2\) > 90/.test(s));
  assert.ok(/Cannot infer geographic axis order/.test(s));
});

test('no blanket coordinate shift/rotation was added to the 2025 pipeline', () => {
  for (const f of ['tools/mission79-build-ward-2025.cjs', 'tools/mission79-run.mjs', 'tools/mission80-batch.mjs']) {
    const s = read(f);
    assert.ok(!/(shiftX|shiftZ|offsetX\s*=|rotateDeg|applyShift)/.test(s), f);
  }
});

// ---- 実出力（このrunnerで生成した場合のみ）----
const OUTS = ['temp/mission80/out', 'temp/mission79'].map((d) => path.join(ROOT, d)).filter(fs.existsSync);
function outDirs() {
  const o = [];
  for (const d of OUTS) for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (/-2025$/.test(n) && fs.existsSync(path.join(p, 'tileset.json'))) o.push(p); }
  return o;
}

test('real 2025 outputs: vintage 2025, unique gml:id, bldg_ prefix, tileset has coarse LOD, attribution kept', (t) => {
  const dirs = outDirs();
  if (!dirs.length) return t.skip('no generated 2025 output on this machine');
  for (const d of dirs) {
    const src = JSON.parse(fs.readFileSync(path.join(d, 'source.json'), 'utf8'));
    const rep = JSON.parse(fs.readFileSync(path.join(d, 'build-report.json'), 'utf8'));
    assert.equal(src.vintage, 2025, d);
    assert.ok(/Project PLATEAU/.test(src.attribution), d);
    assert.equal(rep.totals.skipped, 0, d);
    const ids = B.readIds(d);
    assert.equal(ids.length, rep.totals.buildings, d);
    assert.equal(new Set(ids).size, ids.length, d);
    assert.ok(ids.every((i) => /^bldg_[0-9a-f-]{36}$/.test(i)), d);
    const ts = JSON.parse(fs.readFileSync(path.join(d, 'tileset.json'), 'utf8'));
    assert.ok(ts.root.children && ts.root.children.length > 0, d);
    assert.equal(src.coarseMinArea, 0, d);
  }
});

test('real 2025 outputs: no ID shared between two wards (no boundary double counting)', (t) => {
  const dirs = outDirs().filter((d) => /out[\\/]/.test(d) || true);
  if (dirs.length < 2) return t.skip('need >= 2 generated wards');
  const sets = {};
  for (const d of dirs) sets[path.basename(d)] = B.readIds(d);
  assert.deepEqual(B.crossWardDuplicates(sets), {});
});

test('real 2025 outputs: building representative points lie in the ward lat/lon box (axis order not swapped)', (t) => {
  const dirs = outDirs();
  if (!dirs.length) return t.skip('no generated 2025 output on this machine');
  const area = JSON.parse(read('config/areas/osaka-city.json')).projection;
  for (const d of dirs) {
    const fdir = path.join(d, 'attrs');
    let n = 0;
    for (const f of fs.readdirSync(fdir)) {
      for (const a of Object.values(JSON.parse(fs.readFileSync(path.join(fdir, f), 'utf8')).byId)) {
        const lat = area.centerLat - a[3] / area.metersPerDegree;
        const lon = a[2] / (Math.cos(area.centerLat * Math.PI / 180) * area.metersPerDegree) + area.centerLon;
        assert.ok(lat > 34.5 && lat < 34.8 && lon > 135.3 && lon < 135.7, d + ' ' + lat + ',' + lon);
        n++;
      }
    }
    assert.ok(n > 0);
  }
});

// Mission 82B: synchronous per-ward execution and guards (static)
test('mission80-batch: sync execution with guards', () => {
  const s = read('tools/mission80-batch.mjs');
  assert.match(s, /execFileSync\(process\.execPath/);
  assert.doesNotMatch(s, /detached|\.unref\(|spawn\(/);
  assert.match(s, /max-wards/); assert.match(s, /deadline-min/); assert.match(s, /timeout: wardTimeout/);
  assert.match(s, /renameSync\(tmp, MANIFEST\)/);
  assert.match(s, /process\.exitCode = 1/);
});
