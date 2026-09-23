#!/usr/bin/env node
// tools/audit/major-building-lod.js
// [Mission27 §2] 中景・主要建物LOD の選定基準を実データ分布で監査する。
//   出力: data/reports/major-building-lod.json
//
// 入力:
//   public/map-data/osaka-city/buildings/<dataset>/tile_*.json   （PLATEAU + OSM fallback。全建物）
//   public/map-data/osaka-city/landmarks/landmarks.json           （ランドマーク building id）
//   public/map-data/osaka-city/boundaries/ward-classification-polygons.json（区別集計）
//
// 実行: node tools/audit/major-building-lod.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { auditMajorBuildingLod, MAJOR_MIN_HEIGHT_M, MAJOR_MIN_FP_AREA_M2 } from '../lib/major-building-lod.js';

const BUILD_DIR = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'buildings'));
const LANDMARKS = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'));
const WARDS = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'major-building-lod.json'));

function loadBuildings() {
  const out = [];
  for (const ds of fs.readdirSync(BUILD_DIR)) {
    const dp = path.join(BUILD_DIR, ds);
    if (!fs.statSync(dp).isDirectory() || ds === 'unclassified') continue;
    for (const f of fs.readdirSync(dp)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      const t = JSON.parse(fs.readFileSync(path.join(dp, f), 'utf-8'));
      for (const b of (t.buildings || [])) {
        if (!Array.isArray(b.fp) || b.fp.length < 3) continue;
        out.push({ id: b.id, dz: b.dz, h: b.h, fp: b.fp, repX: b.repX, repZ: b.repZ, heightUnknown: b.heightUnknown });
      }
    }
  }
  return out;
}

function loadLandmarkBuildingIds() {
  const ids = new Set();
  let modelIds = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(LANDMARKS, 'utf-8'));
    for (const l of (j.landmarks || [])) {
      for (const bid of (l.buildingIds || [])) ids.add(bid);
      if (l.modelAvailable || (l.model && l.model.available)) for (const bid of (l.buildingIds || [])) modelIds.add(bid);
    }
  } catch (e) { /* optional */ }
  return { ids, modelIds };
}

async function main() {
  if (!fs.existsSync(BUILD_DIR)) { console.error('[stop] 建物 tile なし: ' + toProjectRelativePath(BUILD_DIR)); process.exitCode = 1; return; }
  const buildings = loadBuildings();
  const { ids: landmarkIds, modelIds } = loadLandmarkBuildingIds();
  const wards = JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards || [];

  const a = auditMajorBuildingLod({ buildings, landmarkIds, wards });

  // 閾値感度（調整判断用）
  const sens = {};
  for (const hM of [25, 30, 35, 45]) {
    let n = 0;
    for (const b of buildings) { const h = (typeof b.dz === 'number') ? b.dz : (b.h || 0); if (h >= hM) n++; }
    sens['height>=' + hM] = n;
  }
  for (const aM2 of [2000, 3000, 5000]) {
    let n = 0;
    for (const b of buildings) {
      const fp = b.fp; let ar = 0;
      for (let i = 0; i < fp.length; i++) { const p = fp[i], q = fp[(i + 1) % fp.length]; ar += p[0] * q[1] - q[0] * p[1]; }
      if (Math.abs(ar) / 2 >= aM2) n++;
    }
    sens['area>=' + aM2] = n;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'PLATEAU + OSM fallback の全建物を height / footprintArea / landmark で分類。中景LODは選定建物のみ簡易ブロック表示。',
    thresholds: a.thresholds,
    totalBuildings: a.totalBuildings,
    heightUnknown: a.heightUnknown,
    landmarkBuildingIds: landmarkIds.size,
    landmarkWithModel: modelIds.size,
    selectedMajor: a.selectedMajor,
    selectedFraction: a.selectedFraction,
    selectedPercent: +(a.selectedFraction * 100).toFixed(2),
    byCriterion: a.byCriterion,
    thresholdSensitivity: sens,
    heightHistogram: a.heightHistogram,
    areaHistogram: a.areaHistogram,
    byWard: a.byWard,
    RESULT: (a.selectedFraction > 0.005 && a.selectedFraction < 0.10) ? 'PASS' : 'REVIEW',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[major-building-lod-audit] 全建物 ' + a.totalBuildings + '  → 主要建物 ' + a.selectedMajor + ' (' + report.selectedPercent + '%)');
  console.log('  基準別: height>=' + MAJOR_MIN_HEIGHT_M + ' ' + a.byCriterion.height + ' / area>=' + MAJOR_MIN_FP_AREA_M2 + ' ' + a.byCriterion.area + ' / landmark ' + a.byCriterion.landmark);
  console.log('  感度: ' + JSON.stringify(sens));
  console.log('  byWard(多い順): ' + Object.entries(a.byWard).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([w, n]) => w + ':' + n).join(' '));
  console.log('保存:', toProjectRelativePath(REPORT), ' RESULT:', report.RESULT);
}

main().catch((e) => { console.error('[major-building-lod-audit] 失敗:', e && e.stack || e); process.exitCode = 1; });
