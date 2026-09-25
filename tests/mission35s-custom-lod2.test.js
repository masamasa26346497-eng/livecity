import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DEV = 'public/osaka_3d_buildings.ward-ux-v1.html';
const PROD = 'public/osaka_3d_buildings.html';
const PROT = 'public/osaka_3d_buildings.fullward-v3.html';
const GEN = 'tools/experiments/mission35s_build_custom_lod2.py';
const PATCH = 'tools/experiments/mission35s_patch_dev.py';
const DATA = 'public/map-data/osaka-city/experimental/mission35s/custom-lod2-267613423.json';

function dataIfPresent() {
  const p = path.join(ROOT, DATA);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

test('[35S] generator keeps experimental provenance and exact coordinate convention', () => {
  const s = read(GEN);
  assert.match(s, /EXPERIMENTAL_POINT_CLOUD_ROOF/);
  assert.match(s, /['"]officialPlateauLod2['"]\s*:\s*False/);
  assert.match(s, /znorth-neg-v1/);
  assert.match(s, /runtime-footprint-spatial-match/);
  assert.doesNotMatch(s, /simple_gable|heuristic gable|generated-simple-roof/i);
});

test('[35S] patcher is dev-only and fail-closed on anchors', () => {
  const s = read(PATCH);
  assert.match(s, /osaka_3d_buildings\.ward-ux-v1\.html/);
  assert.match(s, /expected exactly 1 anchor/);
  assert.doesNotMatch(s, /PROD\.write_text|PROT\.write_text/);
});

test('[35S] production and protected never contain custom layer marker', () => {
  const mark = '[Mission 35S] CustomLod2Layer';
  assert.equal(read(PROD).includes(mark), false);
  assert.equal(read(PROT).includes(mark), false);
});

test('[35S] generated custom high-LOD data contract when artifact is present', () => {
  const d = dataIfPresent();
  if (!d) return;
  assert.equal(d.coordinateConvention, 'znorth-neg-v1');
  assert.equal(d.officialPlateauLod2, false);
  assert.equal(d.status, 'EXPERIMENTAL_POINT_CLOUD_ROOF');
  assert.equal(d.match.method, 'runtime-footprint-spatial-match');
  assert.equal(d.source.osmWayId, 267613423);
  assert.ok(d.geometry.vertices.length > 10);
  assert.ok(d.geometry.indices.length > 30);
  assert.ok(d.geometry.groups.some(g => g.kind === 'roof'));
  assert.ok(d.geometry.groups.some(g => g.kind === 'wall'));
  assert.ok(d.geometry.groups.some(g => g.kind === 'ground'));
  assert.ok(d.measurement.roofCandidatePoints > 100);
});

test('[35S] dev integration contract when patched', () => {
  const s = read(DEV);
  if (!s.includes('[Mission 35S] CustomLod2Layer')) return;
  assert.match(s, /custom-lod2-267613423\.json/);
  assert.match(s, /__CUSTOM_LOD2_LAYER__/);
  assert.match(s, /__CUSTOM_LOD2_DEBUG__/);
  assert.match(s, /__CUSTOM_LOD2_FOCUS__/);
  assert.match(s, /window\.__CUSTOM_LOD2_LAYER__\s*&&\s*window\.__CUSTOM_LOD2_LAYER__\.isSuppressedBuilding\(f\.canonicalId\)/);
  assert.match(s, /window\.__CUSTOM_LOD2_LAYER__\.update\(\)/);
  assert.match(s, /window\.__CUSTOM_LOD2_LAYER__\.pick\(ray\)/);
  assert.match(s, /35S 点群LOD2へ/);
  assert.match(s, /officialPlateauLod2 !== false/);
  assert.match(s, /EXPERIMENTAL_POINT_CLOUD_ROOF/);
});
