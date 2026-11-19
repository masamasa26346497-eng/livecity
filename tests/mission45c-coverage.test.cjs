'use strict';
// Mission 45C: source-vs-converted coverage (synthetic fixture via the real 43F converter + Git-tracked Sumiyoshi) and wrapper safety.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const K = require('../tools/mission45c-coverage.cjs');
const C = require('../tools/mission43f-pc-convert.cjs');
const wards = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm45c-'));
  const src = path.join(tmp, 'src'); const ds = [];
  wards.forEach((w, wi) => {
    const dir = path.join(src, 'osaka-' + w.id); const tiles = [];
    for (let t = 0; t < 2; t++) {
      const bs = [0, 1, 2].map((k) => { const x0 = t * 500 + k * 100 + 20; return { id: 'bldg_' + String(wi).padStart(2, '0') + t + k + '-fixture', fp: [[x0, 0], [x0 + 60, 0], [x0 + 60, 60], [x0, 60]], h: 40, repX: x0 + 30, repZ: 30 }; });
      wj(path.join(dir, 'tile_' + t + '_0.json'), { buildings: bs });
      tiles.push({ tx: t, tz: 0, count: 3, file: 'tile_' + t + '_0.json' });
    }
    wj(path.join(dir, 'manifest.json'), { wardCode: w.code, coordinateConvention: 'znorth-neg-v1', tiles });
    ds.push({ id: 'osaka-' + w.id, wardId: w.id, buildings: 6, tiles: 2 });
  });
  wj(path.join(src, 'manifest.json'), { datasets: ds });
  return { tmp, src };
}

test('synthetic unprepared ward: 43F output has full coverage vs source; anonymous; kind defaults to synthetic', () => {
  const { tmp, src } = fixture();
  try {
    const out = path.join(tmp, 'out');
    const conv = C.runConvert({ src, outRoot: out, execute: true, wards: 'fukushima' });
    assert.ok(conv.ok);
    const r = K.compute({ src, converted: out, ward: 'fukushima' });
    assert.strictEqual(r.source.buildings, 6);
    assert.strictEqual(r.converted.buildings, 6);
    assert.strictEqual(r.converted.missingVsSource, 0);
    assert.strictEqual(r.convertedCoverage, 'full');
    assert.strictEqual(r.renderedCoverage, 'not-measured');
    assert.strictEqual(r.kind, 'synthetic');
    assert.strictEqual(r.evidence.realSourceVerified, false);   // synthetic is never "real" evidence
    assert.strictEqual(r.uploaded, 0); assert.strictEqual(r.gates.uploadAllowed, 0); assert.strictEqual(r.published, false);
    assert.ok(!/bldg_|[A-Za-z]:\\|\/tmp\//.test(JSON.stringify(r)));
    // rendered side is only what the browser reports
    const ok = K.compute({ src, converted: out, ward: 'fukushima', rendered: { tilesets: 1, mountedBuildings: 6, http200: true, pixelsChanged: true, clickedIdVerified: true, peakResidentWards: 1 } });
    assert.strictEqual(ok.renderedCoverage, 'full'); assert.ok(ok.ok);
    const part = K.compute({ src, converted: out, ward: 'fukushima', rendered: { tilesets: 1, mountedBuildings: 3 } });
    assert.strictEqual(part.renderedCoverage, 'partial'); assert.strictEqual(part.ok, false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a dropped id is detected as partial coverage (missing count), source stays untouched', () => {
  const { tmp, src } = fixture();
  try {
    const out = path.join(tmp, 'out');
    assert.ok(C.runConvert({ src, outRoot: out, execute: true, wards: 'fukushima' }).ok);
    const dir = K.resolveConvertedDir(out, 'fukushima');
    const f = path.join(dir, 'ids', fs.readdirSync(path.join(dir, 'ids')).find((n) => /^t_/.test(n)));
    const a = JSON.parse(fs.readFileSync(f, 'utf8')); a.pop(); fs.writeFileSync(f, JSON.stringify(a));
    const before = fs.readFileSync(path.join(src, 'osaka-fukushima', 'tile_0_0.json'), 'utf8');
    const r = K.compute({ src, converted: out, ward: 'fukushima' });
    assert.strictEqual(r.convertedCoverage, 'partial');
    assert.strictEqual(r.converted.missingVsSource, 1);
    assert.strictEqual(fs.readFileSync(path.join(src, 'osaka-fukushima', 'tile_0_0.json'), 'utf8'), before);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Git-tracked Sumiyoshi: the 9-tile 3D Tiles are measured as partial (10,546 of 35,031), never full', () => {
  const src = path.join(ROOT, 'public/map-data/osaka-city/buildings');
  const r = K.compute({ src, converted: path.join(ROOT, 'public/mission37b-3dtiles/osaka-sumiyoshi-9tile'), ward: 'sumiyoshi', kind: 'git-tracked-partial' });
  assert.strictEqual(r.source.buildings, 35031);
  assert.strictEqual(r.source.tiles, 52);
  assert.strictEqual(r.converted.buildings, 10546);
  assert.strictEqual(r.converted.tiles, 9);
  assert.strictEqual(r.converted.extraVsSource, 0);      // every converted id exists in the source
  assert.strictEqual(r.convertedCoverage, 'partial');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.evidence.realSourceVerified, false);
});

test('unknown ward / missing dirs fail closed with coded errors', () => {
  assert.throws(() => K.compute({ src: ROOT, converted: ROOT, ward: 'nowhere' }), /unknown-ward/);
  assert.throws(() => K.compute({ src: path.join(ROOT, 'public/map-data/osaka-city/buildings'), converted: os.tmpdir(), ward: 'sumiyoshi' }), /converted-ward-dir-not-found/);
});

test('ward flow wrapper: ASCII, default plan, convert needs -Execute and -Approved, no delete/copy/network commands', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/mission45c-ward-flow.ps1'), 'utf8');
  assert.ok(!/[^\x00-\x7F]/.test(s), 'non-ASCII bytes');
  assert.ok(/\[string\]\$Step = 'plan'/.test(s) && /\$Wards = 'fukushima'/.test(s));
  assert.ok(/-not \(\$Execute -and \$Approved\)/.test(s));
  assert.ok(!/Remove-Item|Copy-Item|Move-Item|robocopy|Invoke-WebRequest|Invoke-RestMethod|\bgit\b|\bcurl\b/i.test(s));
  // --execute is passed only from the convert branch
  const idx = s.indexOf("'--execute'");
  assert.ok(idx > s.indexOf("elseif ($Step -eq 'convert')") && idx < s.indexOf("elseif ($Step -eq 'verify')"));
  assert.strictEqual((s.match(/--execute/g) || []).length, 1);
  // braces/parens balance (code only; the leading comment block has list markers like '1)')
  const code = s.replace(/<#[\s\S]*?#>/, '');
  assert.strictEqual((code.match(/\{/g) || []).length, (code.match(/\}/g) || []).length);
  assert.strictEqual((code.match(/\(/g) || []).length, (code.match(/\)/g) || []).length);
});

test('coverage tool never uploads or calls the network', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/mission45c-coverage.cjs'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/require\('(https?|net|child_process)'\)|fetch\(|googleapis/.test(s));
});
