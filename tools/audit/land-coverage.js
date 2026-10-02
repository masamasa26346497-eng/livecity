#!/usr/bin/env node
// tools/audit/land-coverage.js
// [見た目改善 Mission21] 大阪市24区の陸域 coverage 監査レポートを生成する。
//   §3 24区 grid audit / §4 missing cluster / §5 人工島・港湾 重点監査。
//   出力: data/reports/land-coverage-audit.json
//
// 実行: node tools/audit/land-coverage.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { SEA_MASK } from '../lib/water-surface.js';
import { auditLandCoverage, findLandGapClusters, auditKeyPlaces, DREAM_ISLAND } from '../lib/land-coverage.js';

const WARDS = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
const WATER = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'water-surface', 'water-surface.json'));
const RIVERS = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'land-coverage-audit.json'));

async function main() {
  const wards = JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards || [];
  const waterPositions = fs.existsSync(WATER) ? (JSON.parse(fs.readFileSync(WATER, 'utf-8')).positions || null) : null;
  let riverAnchors = [];
  try {
    const rv = JSON.parse(fs.readFileSync(RIVERS, 'utf-8'));
    for (const r of (rv.rivers || [])) {
      const cl = r.centerline || r.left || [];
      if (cl.length) { const m = cl[Math.floor(cl.length / 2)]; if (m) riverAnchors.push({ x: m[0], z: m[1] }); }
    }
  } catch (e) { /* rivers optional */ }

  const audit = auditLandCoverage({ wards, cellM: 50, seaMask: SEA_MASK, waterPositions });
  const clusters = findLandGapClusters({ wards, cellM: 100, seaMask: SEA_MASK, riverAnchors });
  const keyPlaces = auditKeyPlaces(wards, SEA_MASK, DREAM_ISLAND, waterPositions);

  const unexplained = clusters.filter((c) => c.unexplained);
  const byWard = {};
  for (const [w, s] of Object.entries(audit.byWard)) {
    byWard[w] = { samples: s.samples, covered: s.covered, missing: s.samples - s.covered, coveragePercent: +(s.covered / s.samples * 100).toFixed(2) };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'N03 24区ポリゴン（+夢洲コア補完）× 50m グリッド。SEA_MASK / water-surface.json との関係を集計。',
    cellM: audit.cellM,
    bbox: audit.bbox,
    totalSamples: audit.totalSamples,
    landSamples: audit.landSamples,
    waterSamples: audit.waterSamples,
    coveredLandSamples: audit.coveredLandSamples,
    missingLandSamples: audit.missingLandSamples,
    coveragePercent: audit.coveragePercent,
    landAreaKm2: audit.landAreaKm2,
    seaOverlap: {
      samples: audit.seaOverlapSamples,
      areaHa: +(audit.seaOverlapSamples * audit.cellM * audit.cellM / 1e4).toFixed(2),
      note: 'water-surface.json（Mission06）が N03 陸を水として描く件数。50m グリッド（water の native 解像度）で測定。',
    },
    byWard,
    missingClusters: {
      total: clusters.length,
      unexplained: unexplained.length,
      list: clusters.slice(0, 30),
    },
    keyPlaces,
    dreamIsland: { id: DREAM_ISLAND.id, name: DREAM_ISLAND.name, reason: DREAM_ISLAND.reason, outer: DREAM_ISLAND.outer },
    RESULT: (audit.coveragePercent >= 99 && audit.seaOverlapSamples === 0 && unexplained.length === 0) ? 'PASS' : 'REVIEW',
  };

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[land-coverage-audit] cell=' + audit.cellM + 'm  total=' + audit.totalSamples);
  console.log('  land=' + audit.landSamples + ' (' + audit.landAreaKm2 + ' km²)  water=' + audit.waterSamples);
  console.log('  coverage=' + audit.coveragePercent + '%  missing=' + audit.missingLandSamples + '  seaOverlap=' + audit.seaOverlapSamples);
  console.log('  missing clusters: ' + clusters.length + ' (unexplained: ' + unexplained.length + ')');
  for (const c of clusters.slice(0, 8)) console.log('    ' + c.id + ' center=' + JSON.stringify(c.center) + ' area≈' + (c.estimatedAreaM2 / 1e4).toFixed(1) + 'ha landNb=' + c.landNeighborFrac + '  ' + c.likelyCause + (c.unexplained ? '  ← UNEXPLAINED' : ''));
  console.log('  key places covered: ' + keyPlaces.filter((k) => k.covered).length + '/' + keyPlaces.length);
  for (const k of keyPlaces.filter((k) => !k.covered)) console.log('    NOT covered: ' + k.name + ' — ' + k.cause);
  console.log('  -- byWard --');
  for (const [w, s] of Object.entries(byWard)) console.log('    ' + w.padEnd(18) + s.coveragePercent + '% (' + s.covered + '/' + s.samples + ')');
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
}

main().catch((e) => { console.error('監査に失敗:', e && e.stack || e); process.exit(1); });
