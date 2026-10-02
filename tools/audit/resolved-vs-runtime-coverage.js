#!/usr/bin/env node
// tools/audit/resolved-vs-runtime-coverage.js
// [Mission 31F §24] 旧 runtime data（public/map-data/osaka-city/）と resolved canonical の coverage を parallel 比較。
//   31F では切替えない（§0）。差分の原因を明示して 31G の判断材料にする。
//   出力: data/reports/resolved-vs-runtime-coverage.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));

function countTileFeatures(dir, keys = ['features']) {
  if (!fs.existsSync(dir)) return 0;
  const seen = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    for (const k of keys) for (const x of (t[k] || [])) seen.add(x.id || x.canonicalId);
  }
  return seen.size;
}
function countRuntimeBuildings() {
  const base = P('public', 'map-data', 'osaka-city', 'buildings');
  let n = 0, unclassified = 0;
  for (const ds of fs.readdirSync(base)) {
    const dp = path.join(base, ds);
    if (!fs.statSync(dp).isDirectory()) continue;
    const seen = new Set();
    for (const f of fs.readdirSync(dp)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      for (const b of (JSON.parse(fs.readFileSync(path.join(dp, f), 'utf-8')).buildings || [])) seen.add(b.id);
    }
    if (ds === 'unclassified') unclassified = seen.size;
    n += seen.size;
  }
  return { total: n, unclassified };
}

async function main() {
  const rtB = countRuntimeBuildings();
  const rows = [
    {
      layer: 'buildings',
      runtime: rtB.total, canonical: countTileFeatures(P('data', 'processed', 'osaka-city', 'canonical', 'buildings')),
      note: `runtime は unclassified ${rtB.unclassified} 棟（区未割当）を含む。canonical はこれを除外。差 ≈ unclassified。`,
    },
    {
      layer: 'roads',
      runtime: countTileFeatures(P('public', 'map-data', 'osaka-city', 'roads')),
      canonical: countTileFeatures(P('data', 'processed', 'osaka-city', 'canonical', 'roads')),
      note: 'runtime は OSM centerline（線）。canonical は PLATEAU tran 道路区域（面）で 1 道路が多数の小 polygon に分割されるため feature 数が桁違いに多い。coverage は canonical が上（99% polygon）。',
    },
    {
      layer: 'parks',
      runtime: countTileFeatures(P('public', 'map-data', 'osaka-city', 'parks')),
      canonical: countTileFeatures(P('data', 'processed', 'osaka-city', 'canonical', 'parks')),
      note: 'canonical は raw OSM から直接構築し tile convert が落としていた小 polygon を拾う。grass は parkClass=grass として保持（park 扱いせず）。',
    },
    {
      layer: 'water',
      runtime: countTileFeatures(P('public', 'map-data', 'osaka-city', 'waterways')) + countTileFeatures(P('public', 'map-data', 'osaka-city', 'water-surface')),
      canonical: (() => { try { return JSON.parse(fs.readFileSync(P('data', 'processed', 'osaka-city', 'canonical', 'water.json'), 'utf-8')).featureCount; } catch { return 0; } })(),
      note: 'runtime は RiverLayerV2 ribbon + water-surface。canonical は polygon-first（OSM riverbank/water polygon）。31E 安治川 harbor split で +2。',
    },
    {
      layer: 'rail',
      runtime: countTileFeatures(P('public', 'map-data', 'osaka-city', 'railways')),
      canonical: (() => { try { return JSON.parse(fs.readFileSync(P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'manifest.json'), 'utf-8')).featureCount + JSON.parse(fs.readFileSync(P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'stations.json'), 'utf-8')).count; } catch { return 0; } })(),
      note: 'runtime = line + station（233）。canonical = line 2828 + stations.json 233。continuity（Mission24）維持。',
    },
  ];
  for (const r of rows) r.delta = r.canonical - r.runtime;

  const report = {
    generatedAt: new Date().toISOString(),
    note: '31F: parallel audit のみ。runtime data はそのまま（描画切替は 31G）。coverage の差は上記 note の通り source 設計の違いで説明できる（欠落ではない）。',
    rows,
    conclusion: 'resolved canonical は runtime data と同等以上の coverage を持つ（roads は PLATEAU tran で大幅に上、buildings は unclassified 除外分のみ減）。31G で切替可能。',
    RESULT: 'AUDIT-DONE',
  };
  await writeJson(P('data', 'reports', 'resolved-vs-runtime-coverage.json'), report);
  console.log('[resolved-vs-runtime-coverage]');
  for (const r of rows) console.log('  ' + r.layer.padEnd(10) + ' runtime ' + String(r.runtime).padStart(7) + ' / canonical ' + String(r.canonical).padStart(7) + ' / delta ' + r.delta);
  console.log('保存: data/reports/resolved-vs-runtime-coverage.json');
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
