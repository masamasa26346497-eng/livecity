// tests/ward-building-datasets.test.js
// P1-4: 24区 建物 dataset / tile 生成（tools/build-ward-building-datasets.js）と
// その検証（tools/lib/ward-building-dataset-validator.js）のテスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { generateWardBuildingDatasets } from '../tools/build-ward-building-datasets.js';
import { validateWardBuildingDatasets } from '../tools/lib/ward-building-dataset-validator.js';

// 生成ツールは出力先を data/processed/ または temp/ 配下に限定する安全ガードを持つため、
// テストの一時ディレクトリはプロジェクトの temp/ 配下（.gitignore 済み）に作る。
const TEST_TMP_ROOT = path.join(PROJECT_ROOT, 'temp', 'p14-tests');
mkdirSync(TEST_TMP_ROOT, { recursive: true });

const REGISTRY_FULL = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'wards', 'registry.json'), 'utf-8').replace(/^﻿/, ''));
const REGISTRY_2 = { city: REGISTRY_FULL.city, wards: REGISTRY_FULL.wards.filter((w) => ['sumiyoshi', 'higashisumiyoshi'].includes(w.id)) };
const ring = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];

function syntheticWardPolygons() {
  const pick = (id) => REGISTRY_FULL.wards.find((w) => w.id === id);
  return {
    coordinateConvention: 'znorth-neg-v1',
    wards: [
      { wardId: 'sumiyoshi', wardCode: pick('sumiyoshi').code, wardName: pick('sumiyoshi').name,
        polygonCount: 1, exclaveCount: 0, holeCount: 0, bbox: { minX: 0, maxX: 1000, minZ: -1000, maxZ: 0 },
        polygons: [{ outer: ring(0, -1000, 1000, 0), holes: [] }] },
      { wardId: 'higashisumiyoshi', wardCode: pick('higashisumiyoshi').code, wardName: pick('higashisumiyoshi').name,
        polygonCount: 1, exclaveCount: 0, holeCount: 0, bbox: { minX: 1000, maxX: 2000, minZ: -1000, maxZ: 0 },
        polygons: [{ outer: ring(1000, -1000, 2000, 0), holes: [] }] },
    ],
  };
}

function bldg(id, cx, cz, extra = {}) {
  return { id, fp: [[cx - 5, cz - 5], [cx + 5, cz - 5], [cx + 5, cz + 5], [cx - 5, cz + 5]], z0: 0, dz: 6, h: 6, usage: '431', ulabel: '専用住宅', ...extra };
}

async function gen(buildings) {
  const dir = mkdtempSync(path.join(TEST_TMP_ROOT, 'run-'));
  const jsonl = path.join(dir, 'b.jsonl');
  fs.writeFileSync(jsonl, buildings.map((b) => JSON.stringify(b)).join('\n') + '\n');
  const wp = path.join(dir, 'wp.json');
  fs.writeFileSync(wp, JSON.stringify(syntheticWardPolygons()));
  const out = path.join(dir, 'out');
  const result = await generateWardBuildingDatasets({ buildings: jsonl, wardPolygons: wp, out, tileSize: 500, force: true, writeReport: false });
  return { dir, out, result };
}
const readJ = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

test('生成: 2区へ分類し、区外建物は unclassified へ隔離する（最近傍区へ割り当てない）', async () => {
  const { dir, out } = await gen([
    bldg('a1', 200, -500), bldg('a2', 300, -400), bldg('a3', 800, -700),
    bldg('b1', 1200, -500), bldg('b2', 1800, -200),
    bldg('o1', 200, 500), bldg('o2', 5000, -500),
  ]);
  try {
    const root = readJ(path.join(out, 'manifest.json'));
    assert.equal(root.totals.input, 7);
    assert.equal(root.totals.classified, 5);
    assert.equal(root.totals.unclassified, 2);
    assert.equal(root.totals.invariant, true);
    assert.equal(readJ(path.join(out, 'sumiyoshi', 'manifest.json')).totalBuildings, 3);
    assert.equal(readJ(path.join(out, 'higashisumiyoshi', 'manifest.json')).totalBuildings, 2);

    const uncl = readJ(path.join(out, 'unclassified', 'manifest.json'));
    assert.equal(uncl.totalBuildings, 2);
    assert.equal(uncl.reasons['outside-all-wards'], 2);
    const allUncl = fs.readdirSync(path.join(out, 'unclassified', 'tiles'))
      .flatMap((f) => readJ(path.join(out, 'unclassified', 'tiles', f)).buildings);
    assert.deepEqual(allUncl.map((b) => b.id).sort(), ['o1', 'o2']);
    for (const b of allUncl) {
      assert.equal(b.unclassifiedReason, 'outside-all-wards');
      assert.ok(!b.wardId, '区外建物に wardId を付けない');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('生成: unclassified の距離内訳（境界すぐ外 vs 遠方）を出す', async () => {
  const { dir, out } = await gen([bldg('a1', 200, -500), bldg('near', 500, 10), bldg('far', 500, 600)]);
  try {
    const uncl = readJ(path.join(out, 'unclassified', 'manifest.json'));
    assert.equal(uncl.outsideByDistanceToNearestWard['<=25m'], 1);
    assert.equal(uncl.outsideByDistanceToNearestWard['>500m'], 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('生成: 重複 building id はスキップし、恒等式に含める', async () => {
  const { dir, out } = await gen([bldg('dup', 200, -500), bldg('dup', 300, -400), bldg('c', 1200, -500)]);
  try {
    const root = readJ(path.join(out, 'manifest.json'));
    assert.equal(root.totals.input, 3);
    assert.equal(root.totals.duplicateIdsSkipped, 1);
    assert.equal(root.totals.classified + root.totals.unclassified + root.totals.duplicateIdsSkipped, 3);
    assert.equal(root.totals.invariant, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('生成: 不正フットプリント（頂点<3）は unclassified/invalid.json へ', async () => {
  const { dir, out } = await gen([bldg('ok', 200, -500), { id: 'bad', fp: [[0, 0], [1, 1]], z0: 0, dz: 3, h: 3 }]);
  try {
    const invalid = readJ(path.join(out, 'unclassified', 'invalid.json'));
    assert.equal(invalid.count, 1);
    assert.equal(invalid.samples[0].id, 'bad');
    assert.equal(readJ(path.join(out, 'manifest.json')).unclassified.invalidFootprints, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('生成: --dry-run は書き込まない', async () => {
  const dir = mkdtempSync(path.join(TEST_TMP_ROOT, 'run-'));
  try {
    const jsonl = path.join(dir, 'b.jsonl');
    fs.writeFileSync(jsonl, [bldg('a1', 200, -500)].map((b) => JSON.stringify(b)).join('\n'));
    const wp = path.join(dir, 'wp.json');
    fs.writeFileSync(wp, JSON.stringify(syntheticWardPolygons()));
    const out = path.join(dir, 'out');
    await generateWardBuildingDatasets({ buildings: jsonl, wardPolygons: wp, out, dryRun: true, writeReport: false });
    assert.equal(fs.existsSync(out), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validator: 正常な生成物は error なしで PASS する', async () => {
  const { dir, out } = await gen([bldg('a1', 200, -500), bldg('a2', 300, -400), bldg('b1', 1200, -500), bldg('o1', 200, 900)]);
  try {
    const r = validateWardBuildingDatasets(out, { registry: REGISTRY_2, inputTotal: 4 });
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.pass), null, 2));
    assert.equal(r.checks.find((c) => c.name === 'building-id-unique').pass, true);
    assert.equal(r.checks.find((c) => c.name === 'tile-bbox-consistent').pass, true);
    assert.equal(r.checks.find((c) => c.name === 'classified-plus-unclassified-equals-input').pass, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validator: tile を改ざんして重複IDを作ると building-id-unique が FAIL', async () => {
  const { dir, out } = await gen([bldg('a1', 200, -500), bldg('b1', 1200, -500)]);
  try {
    const hsTiles = path.join(out, 'higashisumiyoshi', 'tiles');
    const f = fs.readdirSync(hsTiles)[0];
    const t = readJ(path.join(hsTiles, f));
    t.buildings.push({ id: 'a1', fp: [[1200, -500], [1210, -500], [1210, -490], [1200, -490]], repX: 1205, repZ: -495 });
    t.count = t.buildings.length;
    fs.writeFileSync(path.join(hsTiles, f), JSON.stringify(t));
    const r = validateWardBuildingDatasets(out, { registry: REGISTRY_2 });
    assert.equal(r.checks.find((c) => c.name === 'building-id-unique').pass, false);
    assert.equal(r.checks.find((c) => c.name === 'no-building-in-two-wards').pass, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validator: 代表点が tile 座標と合わないと tile-bbox-consistent が FAIL', async () => {
  const { dir, out } = await gen([bldg('a1', 200, -500)]);
  try {
    const suTiles = path.join(out, 'sumiyoshi', 'tiles');
    const f = fs.readdirSync(suTiles)[0];
    const t = readJ(path.join(suTiles, f));
    t.buildings[0].repX = 99999;
    fs.writeFileSync(path.join(suTiles, f), JSON.stringify(t));
    const r = validateWardBuildingDatasets(out, { registry: REGISTRY_2 });
    assert.equal(r.checks.find((c) => c.name === 'tile-bbox-consistent').pass, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
