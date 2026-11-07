'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.resolve(__dirname, '../public/mission37g-osaka-24ward-mvp.html'), 'utf8');

function scaleFor() {
  const a = html.indexOf('const ROAD_BANDS'), b = html.indexOf('function roadW');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(a, b) + '\nthis.f = roadScaleFor;', ctx);
  return ctx.f;
}

// 46B の解析器で、追跡済み住吉区データの「線幅だけで建物に触れる割合」を前後比較する
test('46C: tracked Sumiyoshi data - far-range width contact drops, near range unchanged', () => {
  const A = require('../tools/mission46b-visual-offset-qa.cjs');
  const src = path.resolve(__dirname, '../public/map-data/osaka-city');
  if (!fs.existsSync(path.join(src, 'buildings/osaka-sumiyoshi'))) return;
  const blds = A.loadFootprints(src, 'sumiyoshi');
  if (!blds) return;
  const r = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json'), 'utf8'));
  const lines = r.features.filter((f) => f.kind !== 'area' && !f.bridge && !f.tunnel && !(f.layer < 0)).map((f) => ({ tier: f.tier || 'local', p: f.p }));
  const sf = scaleFor();
  const a = A.analyze(blds, lines, 8, { scaleAtRange: (rg) => sf(rg) });
  const before = a.widthArtefact, after = a.widthArtefactScaled;
  const at = (arr, rg) => arr.find((x) => x.rangeM === rg).pctOutsideSamplesTouchedByDrawnWidthAlone;
  console.log('46C contact% [range,before,after]', JSON.stringify(before.map((x, i) => [x.rangeM, x.pctOutsideSamplesTouchedByDrawnWidthAlone, after[i].pctOutsideSamplesTouchedByDrawnWidthAlone])));
  assert.ok(at(after, 3000) < at(before, 3000));
  assert.strictEqual(at(after, 300), at(before, 300));
});
