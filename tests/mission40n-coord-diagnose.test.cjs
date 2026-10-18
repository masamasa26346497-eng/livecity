'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path');
const D = require('../tools/mission40n-coord-diagnose.cjs');
const ROOT = path.resolve(__dirname, '..');

test('3D Tiles ENU frame agrees with flat local metres within 1.5 m over a tile', () => {
  const e = D.frameRoundTrip(-2250, -750);
  assert.ok(e !== null && e < 1.5, 'roundtrip error ' + e);
  assert.ok(D.frameRoundTrip(-14000, 3000) < 1.5);
});

function rowBuildings() {
  const bs = [];
  for (let i = 0; i < 10; i++) {
    const x = i * 40, fp = [[x, 0], [x + 20, 0], [x + 20, 20], [x, 20]];
    bs.push({ id: 'b' + i, fp, minX: x, maxX: x + 20, minZ: 0, maxZ: 20 });
  }
  return bs;
}

test('offset search clears a registered road and detects a synthetic systematic shift', () => {
  const bs = rowBuildings();
  const ok = D.offsetSearch(bs, D.sampleLines([{ kind: 'line', p: [[-10, 30], [400, 30]] }]), 40, 5);
  assert.strictEqual(ok.zero.insideRatio, 0);
  assert.match(D.verdict(ok), /^registered/);
  // road drawn through the building row (z=10): looks "shifted"; best offset moves it out of the footprints
  const bad = D.offsetSearch(bs, D.sampleLines([{ kind: 'line', p: [[-10, 10], [400, 10]] }]), 40, 5);
  assert.ok(bad.zero.insideRatio > 0.4);
  assert.notStrictEqual(bad.best.dz, 0);
  assert.match(D.verdict(bad), /possible-systematic-shift/);
});

test('real in-repo Sumiyoshi buildings and roads are registered (control)', () => {
  const bdir = path.join(ROOT, 'public/map-data/osaka-city/buildings/osaka-sumiyoshi');
  const rj = path.join(ROOT, 'public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json');
  if (!fs.existsSync(bdir) || !fs.existsSync(rj)) return;
  const bs = D.readBuildings(bdir);
  const pts = D.sampleLines(JSON.parse(fs.readFileSync(rj, 'utf8')).features).filter((q) => q[0] > -3300 && q[0] < -1200 && q[1] > -1800 && q[1] < 300);
  const r = D.offsetSearch(bs, pts, 20, 5);
  assert.ok(r.zero.insideRatio < 0.02, 'overlap ' + r.zero.insideRatio);
  assert.strictEqual(Math.hypot(r.best.dx, r.best.dz), 0);
});

test('tool is read-only (no writes, deletes or network)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'tools/mission40n-coord-diagnose.cjs'), 'utf8');
  assert.ok(!/writeFileSync|unlinkSync|rmSync|renameSync|copyFileSync|https?\.request|fetch\(/.test(s));
});

test('N03 polygon shape {outer} is read; real Sumiyoshi building points fall inside the ward (was a 0% false reading)', () => {
  assert.strictEqual(D.ringOf({ outer: [[0, 0], [1, 0], [1, 1]] }).length, 3);
  const bdir = path.join(ROOT, 'public/map-data/osaka-city/buildings/osaka-sumiyoshi');
  if (!fs.existsSync(bdir)) return;
  const w = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards.find((x) => x.wardId === 'sumiyoshi');
  const bs = D.readBuildings(bdir).filter((b) => Number.isFinite(b.repX));
  const inside = bs.filter((b) => w.polygons.some((p) => D.pip(D.ringOf(p), b.repX, b.repZ))).length;
  assert.ok(inside / bs.length > 0.99, 'inside ' + inside + '/' + bs.length);
});
