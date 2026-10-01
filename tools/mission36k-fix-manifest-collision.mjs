#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SOURCE_MANIFEST_REL = 'public/map-data/osaka-city/building-sources/plateau-2024-manifest.json';
const RUNTIME_MANIFEST_REL = 'public/map-data/osaka-city/buildings/manifest.json';
const REPORT_REL = 'data/reports/building-dataset-generation.json';
const REGISTRY_REL = 'config/wards/registry.json';

const TOOL_PATCHES = [
  {
    file: 'tools/mission36k-build-ward-building-manifest.mjs',
    from: "const OUT_PUBLIC = path.resolve('public/map-data/osaka-city/buildings/manifest.json');",
    to: `const OUT_PUBLIC = path.resolve('${SOURCE_MANIFEST_REL}');`,
  },
  {
    file: 'tools/mission36k-fetch-ward-building-source.mjs',
    from: "const MANIFEST_PATH = path.resolve('public/map-data/osaka-city/buildings/manifest.json');",
    to: `const MANIFEST_PATH = path.resolve('${SOURCE_MANIFEST_REL}');`,
  },
  {
    file: 'tools/mission36k-smoke-b3dm.mjs',
    from: "const MANIFEST = path.resolve('public/map-data/osaka-city/buildings/manifest.json');",
    to: `const MANIFEST = path.resolve('${SOURCE_MANIFEST_REL}');`,
  },
];

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, rel), 'utf8').replace(/^\uFEFF/, ''));
}

function patchTool({ file, from, to }) {
  const abs = path.resolve(ROOT, file);
  let text = fs.readFileSync(abs, 'utf8');
  if (text.includes(to)) return 'already-fixed';
  if (!text.includes(from)) throw new Error(`Expected manifest-path anchor not found in ${file}`);
  text = text.replace(from, to);
  fs.writeFileSync(abs, text, 'utf8');
  return 'patched';
}

function buildRuntimeManifest(registry, report) {
  if (!Array.isArray(registry.wards) || registry.wards.length !== 24) {
    throw new Error(`Expected 24 wards in registry, got ${registry.wards?.length}`);
  }
  if (report.totals?.classified !== 574112) {
    throw new Error(`Unexpected classified building total: ${report.totals?.classified}`);
  }

  const datasets = registry.wards.map((ward) => {
    const buildings = Number(report.wardBuildingCount?.[ward.id] || 0);
    const tiles = Number(report.wardTileCount?.[ward.id] || 0);
    const bounds = report.wardBounds?.[ward.id] || null;
    if (!(buildings > 0) || !(tiles > 0) || !bounds) {
      throw new Error(`Incomplete runtime building report for ward=${ward.id}`);
    }
    return {
      id: ward.datasetId,
      wardId: ward.id,
      ward: ward.name,
      wardCode: ward.code,
      manifest: `./${ward.datasetId}/manifest.json`,
      buildings,
      tiles,
      bounds,
      dataReadyCandidate: true,
    };
  });

  const buildingSum = datasets.reduce((n, d) => n + d.buildings, 0);
  const tileSum = datasets.reduce((n, d) => n + d.tiles, 0);
  if (buildingSum !== report.totals.classified) {
    throw new Error(`Runtime manifest building sum mismatch: ${buildingSum} != ${report.totals.classified}`);
  }
  if (tileSum !== 1096) {
    throw new Error(`Runtime manifest tile sum mismatch: ${tileSum} != 1096`);
  }

  return {
    version: 1,
    city: 'osaka-city',
    cityName: registry.city,
    cityCode: registry.cityCode,
    generatedAt: new Date().toISOString(),
    coordinateSystem: 'meters-local',
    coordinateConvention: 'znorth-neg-v1',
    tileSize: Number(report.source?.tileSize || 500),
    layout: 'flat',
    wardCount: datasets.length,
    buildingCount: buildingSum,
    tileCount: tileSum,
    datasets,
    unclassified: {
      count: Number(report.totals?.unclassified || 0),
      policy: 'not force-assigned; authoritative N03 point-in-polygon only',
    },
    sourceReport: '../../../data/reports/building-dataset-generation.json',
    note: 'Live City runtime building manifest. PLATEAU source/acquisition metadata is intentionally stored separately under building-sources/.',
  };
}

const patchResults = Object.fromEntries(TOOL_PATCHES.map((p) => [p.file, patchTool(p)]));
const registry = readJson(REGISTRY_REL);
const report = readJson(REPORT_REL);
const runtime = buildRuntimeManifest(registry, report);
const runtimePath = path.resolve(ROOT, RUNTIME_MANIFEST_REL);
fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2) + '\n', 'utf8');

const verify = readJson(RUNTIME_MANIFEST_REL);
if (!Array.isArray(verify.datasets) || verify.datasets.length !== 24) throw new Error('Runtime manifest must contain 24 datasets');
if (verify.buildingCount !== 574112) throw new Error(`Runtime buildingCount=${verify.buildingCount}`);
if (verify.tileCount !== 1096) throw new Error(`Runtime tileCount=${verify.tileCount}`);
if (verify.mission === '36K' || verify.wards) throw new Error('PLATEAU source manifest shape leaked into runtime manifest');

console.log(JSON.stringify({
  patchResults,
  runtimeManifest: RUNTIME_MANIFEST_REL,
  sourceManifest: SOURCE_MANIFEST_REL,
  wards: verify.datasets.length,
  buildings: verify.buildingCount,
  tiles: verify.tileCount,
}, null, 2));
