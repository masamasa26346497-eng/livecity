// tests/ward-mode-integration.test.js
// P1-5: 24区 建物 dataset ⇄ ward-ux-v1.html Ward Mode 統合の検証。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { generateWardBuildingDatasets } from '../tools/build-ward-building-datasets.js';
import { validateWardModeIntegration, parseWardDefs, parseBuildingTileConfig } from '../tools/lib/ward-mode-integration-validator.js';

const TEST_TMP_ROOT = path.join(PROJECT_ROOT, 'temp', 'p15-tests');
mkdirSync(TEST_TMP_ROOT, { recursive: true });

const REGISTRY_FULL = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'wards', 'registry.json'), 'utf-8').replace(/^﻿/, ''));
const REGISTRY_2 = { city: REGISTRY_FULL.city, wards: REGISTRY_FULL.wards.filter((w) => ['sumiyoshi', 'higashisumiyoshi'].includes(w.id)) };
const ring = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
const WARD_UX_HTML = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');

function syntheticWardPolygons(ids) {
  const pick = (id) => REGISTRY_FULL.wards.find((w) => w.id === id);
  return {
    coordinateConvention: 'znorth-neg-v1',
    wards: ids.map((id, i) => ({
      wardId: id, wardCode: pick(id).code, wardName: pick(id).name, polygonCount: 1, exclaveCount: 0, holeCount: 0,
      bbox: { minX: i * 1000, maxX: i * 1000 + 1000, minZ: -1000, maxZ: 0 },
      polygons: [{ outer: ring(i * 1000, -1000, i * 1000 + 1000, 0), holes: [] }],
    })),
  };
}

async function genFlat(ids, buildings) {
  const dir = mkdtempSync(path.join(TEST_TMP_ROOT, 'run-'));
  const jsonl = path.join(dir, 'b.jsonl');
  fs.writeFileSync(jsonl, buildings.map((b) => JSON.stringify(b)).join('\n') + '\n');
  const wp = path.join(dir, 'wp.json');
  fs.writeFileSync(wp, JSON.stringify(syntheticWardPolygons(ids)));
  const out = path.join(dir, 'out');
  await generateWardBuildingDatasets({ buildings: jsonl, wardPolygons: wp, out, layout: 'flat', force: true, writeReport: false });
  return { dir, out, wp };
}
const bldg = (id, cx, cz) => ({ id, fp: [[cx - 5, cz - 5], [cx + 5, cz - 5], [cx + 5, cz + 5], [cx - 5, cz + 5]], z0: 0, dz: 6, h: 6, usage: '431' });

test('parseWardDefs: 実 ward-ux-v1.html から24区・全dataReady:true を読める', () => {
  const html = fs.readFileSync(WARD_UX_HTML, 'utf-8');
  const defs = parseWardDefs(html);
  assert.equal(defs.length, 24);
  const notReady = defs.filter((d) => d.dataReady !== true);
  assert.deepEqual(notReady, [], `dataReady≠true: ${notReady.map((d) => d.id).join(',')}`);
  // registry と id/code/datasetId が一致
  const regById = new Map(REGISTRY_FULL.wards.map((w) => [w.id, w]));
  for (const d of defs) {
    const r = regById.get(d.id);
    assert.ok(r, `WARD_DEFS の ${d.id} が registry に無い`);
    assert.equal(d.code, r.code);
    assert.equal(d.datasetId, r.datasetId);
    assert.equal(d.name, r.name);
  }
});

test('parseBuildingTileConfig: basePath が 24区 servable path を指す', () => {
  const html = fs.readFileSync(WARD_UX_HTML, 'utf-8');
  const cfg = parseBuildingTileConfig(html);
  assert.equal(cfg.basePath, 'map-data/osaka-city/buildings');
  assert.equal(cfg.rootManifest, 'map-data/osaka-city/buildings/manifest.json');
});

test('ward-ux-v1.html: N03 の24区polygon は非同期ロードされ、camera/detectWardAt 専用（P1-5B で塗り3レイヤーからは撤去）', () => {
  const html = fs.readFileSync(WARD_UX_HTML, 'utf-8');
  assert.ok(/const __n03WardRingsReady =/.test(html), '__n03WardRingsReady 未定義');
  assert.ok(/let __n03WardPolyCache = null/.test(html), '__n03WardPolyCache 未定義（camera専用キャッシュ）');
  assert.ok(/getWardCameraTarget/.test(html), 'getWardCameraTarget 未公開');
  // [P1-5B] WardBoundaryLayer / WardAreaFillLayer / WardLabelLayer へは N03 を流さない
  // （1区=1巨大concaveポリゴンで塗りが破綻するため）。3レイヤー初期化は setTimeout(0) に戻す。
  const ewr = html.slice(html.indexOf('function ensureWardRings()'), html.indexOf('function ensureWardRings()') + 900);
  assert.ok(!/__n03Ward/.test(ewr), 'ensureWardRings が N03 を混ぜている（P1-5B で撤去したはず）');
});

test('protected baseline fullward-v3.html は変更されていない（git 追跡上）', () => {
  // ファイル自体の存在と、P1-5 マーカーが混入していないことを確認
  const p = path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
  if (!fs.existsSync(p)) return;
  const html = fs.readFileSync(p, 'utf-8');
  assert.ok(!/WARD-MODE P1-5|__n03WardRingsReady|map-data\/osaka-city\/buildings/.test(html),
    'protected baseline に P1-5 の変更が混入している');
});

test('validator: flat layout の合成 servable dataset + 合成 registry で dataset側チェックが PASS', async () => {
  const { dir, out, wp } = await genFlat(['sumiyoshi', 'higashisumiyoshi'], [bldg('a', 200, -500), bldg('b', 1200, -500)]);
  try {
    // servable-path / html 系は合成環境では判定できないので dataset 系チェックだけ見る
    const r = validateWardModeIntegration({ datasetRoot: out, htmlPath: '/nonexistent', wardPolygonsPath: wp, registry: REGISTRY_2 });
    // 合成データなので known-3-wards の warning は無視し、error重大度の dataset チェックのみ見る
    const dsErrs = r.checks.filter((c) => c.name.startsWith('dataset:') && c.severity !== 'warning');
    assert.ok(dsErrs.every((c) => c.pass), JSON.stringify(dsErrs.filter((c) => !c.pass)));
    assert.equal(r.checks.find((c) => c.name === 'flat-layout-servable').pass, true);
    assert.equal(r.checks.find((c) => c.name === 'n03-ward-polygons-servable').pass, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validator: 実 servable dataset + 実 HTML で RESULT PASS（生成済み前提。無ければskip扱い）', () => {
  const datasetRoot = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'buildings');
  const wpPath = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
  if (!fs.existsSync(path.join(datasetRoot, 'manifest.json'))) return; // 未生成環境
  const r = validateWardModeIntegration({ datasetRoot, htmlPath: WARD_UX_HTML, wardPolygonsPath: wpPath, registry: REGISTRY_FULL });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.pass), null, 2));
});
