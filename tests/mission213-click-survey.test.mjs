import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { classify404, summarize404, survey } from '../tools/lod2/lod2-merged-survey.mjs';
const require = createRequire(import.meta.url);
const { classifyClick, gridPoints } = require('../tools/lod2/lod2-click-qa.cjs');

test('click verdicts: PASS only when the real click selects the same canonicalId and opens the panel', () => {
  const base = { found: true, clicked: true, id: 'bldg_a', selectedCanonicalId: 'bldg_a', panelOn: true, sidecarText: '照合中…' };
  assert.equal(classifyClick(base).verdict, 'PASS');
  assert.deepEqual(classifyClick({ ...base, sidecarText: 'サイドカー未配信' }).diag, ['sidecar-unconnected']);
  assert.equal(classifyClick({ ...base, selectedCanonicalId: null }).verdict, 'FAIL');
  assert.equal(classifyClick({ ...base, selectedCanonicalId: 'bldg_b' }).verdict, 'FAIL');
  assert.equal(classifyClick({ ...base, panelOn: false }).verdict, 'FAIL');
  assert.equal(classifyClick({ found: false }).verdict, 'NO-TARGET');   // 未検証であって成功ではない
});
test('grid scan avoids side panels and starts at the screen centre', () => {
  const pts = gridPoints(1280, 800);
  assert.ok(pts.every(([x, y]) => x >= 330 && x <= 1280 - 340 && y >= 90 && y <= 750));
  assert.ok(Math.hypot(pts[0][0] - 640, pts[0][1] - 400) < Math.hypot(pts.at(-1)[0] - 640, pts.at(-1)[1] - 400));
});
test('404 classification: unconfirmed-rights data is never marked restorable', () => {
  for (const p of ['/mission145-data/stations-24.json', '/mission37c-layers/x/roads.json', '/map-data/osaka-city/facilities/ward-manifest.json', '/mission37d-data/verified-google-place-ids.json'])
    assert.equal(classify404(p).category, 'blocked-rights', p);
  assert.equal(classify404('/ext-3dtiles/kita/attrs/t_1_2.json').category, 'plateau-derived-needs-approval');
  assert.equal(classify404('/__lod2/diag.json').category, 'expected-static');
  assert.equal(classify404('/something-new.json').category, 'unclassified');
  const s = summarize404(['/mission145-data/a.json', '/mission145-data/a.json', '/__lod2/diag.json']);
  assert.equal(s['blocked-rights'].count, 1);
});
test('survey: counts size/files per category, follows symlinked wards, flags missing content, prints no ids', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'm213-'));
  const mk = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  const baseW = path.join(t, 'base', 'sumiyoshi'); const ts = { root: { content: { uri: 'tiles/a.glb' }, children: [{ content: { uri: 'lod/b.glb' } }] } };
  mk(path.join(baseW, 'tileset.json'), JSON.stringify(ts)); mk(path.join(baseW, 'tiles/a.glb'), Buffer.alloc(1000)); mk(path.join(baseW, 'lod/b.glb'), Buffer.alloc(100));
  const m = path.join(t, 'm'); mk(path.join(m, 'ext-3dtiles/index.json'), JSON.stringify({ wards: [{ ward: 'sumiyoshi', source: 'base' }, { ward: 'kita', source: 'overlay' }] }));
  fs.symlinkSync(baseW, path.join(m, 'ext-3dtiles/sumiyoshi'), 'dir');
  mk(path.join(m, 'ext-3dtiles/kita/tileset.json'), JSON.stringify({ root: { content: { uri: 'tiles/missing.glb' } } }));
  mk(path.join(m, 'lod2-preview/x.glb'), Buffer.alloc(500)); mk(path.join(m, 'index.html'), 'x');
  const r = survey(m, { limitMB: 1 });
  assert.equal(r.totals.wards, 2); assert.equal(r.totals.missingContent, 1);
  assert.equal(r.categories['lod2-preview'].bytes, 500);
  assert.ok(r.categories['lod1-wards'].bytes >= 1100);
  assert.equal(r.fit.fullFitsLimit, true);
  assert.doesNotMatch(JSON.stringify(r), /bldg_/);
  fs.rmSync(t, { recursive: true, force: true });
});

test('Mission 215: API errors and id-format mismatch are FAIL, never silently NO-TARGET', () => {
  assert.equal(classifyClick({ found: false, apiError: 'x is not a function' }).verdict, 'FAIL');
  assert.equal(classifyClick({ found: false, idFormatMismatch: '{"BLD_1":3}' }).verdict, 'FAIL');
  assert.equal(classifyClick({ found: false }).verdict, 'NO-TARGET');
});
