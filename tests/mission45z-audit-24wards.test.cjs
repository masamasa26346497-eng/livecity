'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { run } = require('../tools/mission45z-audit-24wards.cjs');

const R = run();

test('45Z: 24 wards audited, unique ids/codes', () => {
  assert.strictEqual(R.wards.length, 24);
  assert.strictEqual(new Set(R.wards.map((w) => w.wardId)).size, 24);
  assert.strictEqual(new Set(R.wards.map((w) => w.wardCode)).size, 24);
});

test('45Z: wards without tracked data are reported unverified, never verified', () => {
  const tracked = new Set(['kita', 'chuo', 'nishi', 'tennoji', 'naniwa', 'sumiyoshi']);
  for (const w of R.wards) {
    if (!tracked.has(w.wardId)) assert.match(w.buildingPlacement, /^unverified/, w.wardId);
    if (w.wardId !== 'sumiyoshi') assert.match(w.roadWaterVsBuilding, /^unverified/, w.wardId);
  }
  const fuk = R.wards.find((w) => w.wardId === 'fukushima');
  assert.match(fuk.sources.plateauFootprintTiles, /private/);
});

test('45Z: tracked tilesets: rep points inside own N03 polygon, no tile-cell violations, no height sentinels', () => {
  for (const id of ['kita', 'chuo', 'nishi', 'tennoji', 'naniwa']) {
    const w = R.wards.find((x) => x.wardId === id);
    assert.ok(w.attrs && w.attrs.length, id);
    for (const a of w.attrs) {
      assert.ok(a.n > 0);
      assert.ok(a.insideOwnPct >= 99, id + ' ' + a.insideOwnPct);
      assert.strictEqual(a.tileCellMismatch, 0, id);
      assert.strictEqual(a.nonFiniteRep, 0);
      assert.strictEqual(a.heightSentinel, 0);
      assert.strictEqual(a.z0NonZero, 0);
    }
    assert.strictEqual(w.buildingPlacement, 'verified-in-ward');
  }
  assert.deepStrictEqual(R.summary.issues, []);
});

test('45Z: sumiyoshi bundle lies in sumiyoshi; elevated/tunnel roads are separated from ground roads', () => {
  const v = R.sumiyoshiVector;
  assert.ok(v.roadVertexPctByWard.sumiyoshi > 80);
  assert.ok(v.taggedFeatures.bridge > 0 && v.taggedFeatures.tunnel > 0);
  assert.ok(v.surfaceRoadsOnly.samples < v.allRoads.samples);
  assert.ok(v.surfaceRoadsOnly.fraction <= v.allRoads.fraction);
  assert.ok(v.surfaceRoadsOnly.fraction < 0.01); // 地上道路の footprint 貫通は 1% 未満（一様ずれの兆候なし）
});

test('45Z: report holds no building ids; tool is read-only and offline', () => {
  assert.ok(!/bldg_[0-9a-f]{8}-/.test(JSON.stringify(R)));
  const src = fs.readFileSync(path.join(__dirname, '../tools/mission45z-audit-24wards.cjs'), 'utf8');
  assert.ok(!/(https?:\/\/(?!www)|fetch\(|writeFileSync\(\s*path\.join\(ROOT)/.test(src.replace(/\/\/.*$/gm, '')));
  assert.ok(!/unlinkSync|rmSync|renameSync|require\('(https?|net)'\)/.test(src));
});

test('45Z: viewer uses one projection path for buildings, roads and gfp', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.strictEqual((html.match(/const PROJ = \{/g) || []).length, 1);
  assert.match(html, /clat: 34\.604208, clon: 135\.525020, mpd: 111320/);
});
