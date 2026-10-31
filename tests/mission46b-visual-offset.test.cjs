'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../tools/mission46b-visual-offset-qa.cjs');
const ROOT = path.resolve(__dirname, '..');

// street running along x (z=0), 12 m wide gap between rows of 20x20 m buildings (facades at z=+-6)
function street(shiftZ) {
  const blds = [];
  for (let i = 0; i < 20; i++) {
    const x0 = i * 25;
    blds.push({ fp: [[x0, 6], [x0 + 20, 6], [x0 + 20, 26], [x0, 26]], h: 20 });
    blds.push({ fp: [[x0, -26], [x0 + 20, -26], [x0 + 20, -6], [x0, -6]], h: 20 });
  }
  return { blds, lines: [{ tier: 'mid', p: [[0, shiftZ], [480, shiftZ]] }] };
}
test('46B: centred road has gap = half street width and is not inside footprints', () => {
  const s = street(0), a = A.analyze(s.blds, s.lines, 4);
  assert.strictEqual(a.pctSamplesInsideFootprint, 0);
  assert.ok(Math.abs(a.edgeGapM.p50 - 6) < 0.6, 'p50 gap ' + a.edgeGapM.p50);
});
test('46B: a real offset is visible in the gap statistic (not hidden by the width model)', () => {
  const s = street(5), a = A.analyze(s.blds, s.lines, 4);
  assert.ok(a.edgeGapM.p5 <= 1.2 && a.edgeGapM.p50 <= 1.2, JSON.stringify(a.edgeGapM));
  const s2 = street(8), b = A.analyze(s2.blds, s2.lines, 4);
  assert.ok(b.pctSamplesInsideFootprint > 60);
});
test('46B: width artefact grows with camera range while geometry stays fixed', () => {
  const s = street(0), a = A.analyze(s.blds, s.lines, 4);
  const v = a.widthArtefact.map((w) => w.pctOutsideSamplesTouchedByDrawnWidthAlone);
  assert.ok(v.every((x, i) => i === 0 || x >= v[i - 1]), v.join(','));
  assert.strictEqual(v[0], 0);
  assert.ok(A.groundPerPx(3000) > A.groundPerPx(300));
});
test('46B: parallax is zero looking straight down and grows as the camera tilts', () => {
  const s = street(0), a = A.analyze(s.blds, s.lines, 4);
  const p = {};
  for (const x of a.parallax) p[x.pitchDeg] = x.roofShiftM.p50;
  assert.strictEqual(p[-90], 0);
  assert.ok(p[-35] > p[-60] && p[-60] > 0);
  assert.ok(Math.abs(p[-35] - 20 / Math.tan(35 * Math.PI / 180)) < 0.1);
});
test('46B: tracked Sumiyoshi footprints + bundled roads run end to end, aggregate only', () => {
  const src = path.join(ROOT, 'public/map-data/osaka-city');
  if (!fs.existsSync(path.join(src, 'buildings/osaka-sumiyoshi'))) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm46b-'));
  try {
    const dst = path.join(tmp, 'src');
    fs.mkdirSync(path.join(dst, 'roads'), { recursive: true });
    fs.symlinkSync(path.join(src, 'buildings'), path.join(dst, 'buildings'));
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json'), 'utf8'));
    fs.writeFileSync(path.join(dst, 'roads/manifest.json'), JSON.stringify({ tileSize: 2000 }));
    for (let tx = -2; tx <= 0; tx++) for (let tz = -2; tz <= 1; tz++) fs.writeFileSync(path.join(dst, 'roads', 'tile_' + tx + '_' + tz + '.json'), JSON.stringify({ features: r.features }));
    const rep = A.run({ src: dst, wards: ['sumiyoshi'], step: 8 });
    const w = rep.wards[0];
    assert.strictEqual(w.status, 'ok');
    assert.ok(w.roadSamples > 1000 && w.edgeGapM.measured > 500);
    const txt = JSON.stringify(rep);
    assert.ok(!/bldg_|road_|\/home\//.test(txt), 'no ids or paths in the report');
    fs.mkdirSync(path.join(ROOT, 'data/reports/mission46b'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'data/reports/mission46b/sumiyoshi-public-visual-offset.json'), JSON.stringify(rep, null, 1));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('46B: tool and ps1 are read-only, offline, ASCII', () => {
  for (const f of ['tools/mission46b-visual-offset-qa.cjs', 'tools/mission46b-visual-offset-qa.ps1']) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/require\(['"](http|https|net|child_process)['"]\)|fetch\(|unlinkSync|rmdirSync|Remove-Item|Copy-Item|robocopy|Move-Item/.test(t), f);
  }
  assert.ok(!/[^\x00-\x7f]/.test(fs.readFileSync(path.join(ROOT, 'tools/mission46b-visual-offset-qa.ps1'), 'utf8')));
});
