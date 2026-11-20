'use strict';
// Mission 45T: 追跡済み住吉区データでの道路×footprint 重なり計測、投影定数の独立照合、45S-2 スナップ実クリック E2E の保存結果。
// 住吉区限定。福島区（private）には一般化できない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..');

test('45T: 住吉区の追跡済み道路×footprint は、道路を動かさない位置(0,0)が重なり最小で、重なりも小さい', () => {
  const o = JSON.parse(cp.execFileSync('node', [path.join(ROOT, 'tools/mission45t-overlap-public.cjs')], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  assert.ok(o.footprints > 10000 && o.roadLines > 500);
  assert.deepStrictEqual([o.whole.best.dx, o.whole.best.dz], [0, 0]);
  assert.ok(o.whole.zeroOffsetFraction < 0.01, 'zero overlap ' + o.whole.zeroOffsetFraction);
  o.halves.forEach((h) => assert.deepStrictEqual([h.best.dx, h.best.dz], [0, 0]));
  assert.match(o.verdict, /^no-consistent-translation/);
  assert.match(o.scope, /NOT generalizable to fukushima/);
});

test('45T: 本番 HTML / 37G ビューア / 45O 診断 / 45M 検証の投影定数が同一（CLAT, CLON, MPD）', () => {
  const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const prod = rd('public/osaka_3d_buildings.html');
  const g = (re, s) => +(re.exec(s) || [])[1];
  assert.strictEqual(g(/SEARCH_CLAT\s*=\s*([\d.]+)/, prod), 34.604208);
  assert.strictEqual(g(/SEARCH_CLON\s*=\s*([\d.]+)/, prod), 135.52502);
  assert.strictEqual(g(/SEARCH_MPD\s*=\s*(\d+)/, prod), 111320);
  const v = rd('public/mission37g-osaka-24ward-mvp.html');
  assert.ok(/PROJ = \{ clat: 34\.604208, clon: 135\.525020, mpd: 111320 \}/.test(v));
  const d = rd('tools/mission45o-footprint-vs-road.cjs');
  assert.ok(/CLAT = 34\.604208, CLON = 135\.525020, MPD = 111320/.test(d));
});

test('45T: 独立実装の local↔lonlat 往復（東+/南+）は厳密、北が z 負・東が x 正', () => {
  const CLAT = 34.604208, CLON = 135.52502, MPD = 111320, c = Math.cos(CLAT * Math.PI / 180);
  const toLL = (x, z) => [CLON + x / (c * MPD), CLAT - z / MPD];
  const toLocal = (lon, lat) => [(lon - CLON) * c * MPD, -(lat - CLAT) * MPD];
  for (const [x, z] of [[-3000, 1500], [0, 0], [12000, -9000]]) {
    const [lon, lat] = toLL(x, z), [x2, z2] = toLocal(lon, lat);
    assert.ok(Math.hypot(x - x2, z - z2) < 1e-6);
  }
  assert.ok(toLL(0, -100)[1] > CLAT);   // 北(z 負)は緯度が増える
  assert.ok(toLL(100, 0)[0] > CLON);    // 東(x 正)は経度が増える
});

test('45T: 45S-2 スナップの実クリック E2E（headless Chrome・合成 fixture）の保存結果が全項目 pass', () => {
  const f = path.join(ROOT, 'data/reports/mission45t-snap-e2e.json');
  assert.ok(fs.existsSync(f));
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(r.pass, true);
  for (const k of ['intersectionLabel', 'snappedToTrueIntersection', 'c1OnlyNoApply', 'greenLineDrawn', 'segmentKindLabel', 'rejectedStaysMode1', 'rejectNoNewPair', 'noOffsetsEver', 'noExternalRequests', 'noJsErrors']) assert.strictEqual(r.checks[k], true, k);
  assert.deepStrictEqual(r.externalRequests, []);
  assert.ok(!/lat|lon|bldg_/.test(JSON.stringify(r.checks)), 'no coordinates or ids in report');
});
