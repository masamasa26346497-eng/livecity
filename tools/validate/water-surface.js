#!/usr/bin/env node
// tools/validate/water-surface.js
// [見た目改善 Mission06] WaterSurfaceLayer（大阪湾・港湾水面）の配信データ validator CLI。
//
// PASS 条件:
//   - coordinateConvention === 'znorth-neg-v1'
//   - NaN / Inf 頂点 0
//   - 退化三角形 0 / sliver 三角形 0
//   - 過大三角形（辺長・z高さ上限超）0 → 「異常に巨大な triangle」なし
//   - 内陸テスト点が海面に内包される件数 0 → 内陸塗り潰しなし
//   - 総面積が妥当レンジ内（陸を塗っていない）
//   - bbox が大阪市地表矩形 + margin 内
//   - 生成物が reject-to-empty されていない（＝ emitted:true）
//   - protected / production HTML に Mission06 の変更が混入していない
//
// 実行: node tools/validate/water-surface.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { GROUND_EXTENT, INLAND_TEST_POINTS, MAX_RUN_WIDTH_M, DEFAULT_CELL_M, validateWaterSurface } from '../lib/water-surface.js';

const DATA = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'water-surface', 'water-surface.json'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'water-surface-validation.json'));
const PROD_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.html'));
const PROTECTED_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.fullward-v3.html'));

function bboxOfPositions(pos) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i + 1 < pos.length; i += 2) {
    const x = pos[i], z = pos[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

async function main() {
  const errors = [];
  const warns = [];

  if (!fs.existsSync(DATA)) {
    console.error(`[water-surface-validate] 配信データが見つかりません: ${toProjectRelativePath(DATA)}`);
    console.error('  先に: node tools/build-water-surface.js');
    process.exitCode = 1;
    return;
  }
  const doc = JSON.parse(fs.readFileSync(DATA, 'utf-8'));

  if (doc.coordinateConvention !== 'znorth-neg-v1') errors.push(`coordinateConvention が znorth-neg-v1 でない: ${doc.coordinateConvention}`);
  if (doc.rejectedToEmpty === true) errors.push('生成物が reject-to-empty（生成側の検証に失敗）: ' + (doc.validationErrors || []).join(' / '));
  if (doc.emitted !== true) errors.push('emitted !== true（海面三角形が出荷されていない）');

  const pos = Array.isArray(doc.positions) ? doc.positions : [];
  if (pos.length < 6) errors.push(`positions がほぼ空 (${pos.length})`);

  const v = validateWaterSurface({
    positions: pos,
    cellM: doc.cellM || DEFAULT_CELL_M,
    maxWidthM: MAX_RUN_WIDTH_M,
    extent: GROUND_EXTENT,
    inlandPoints: INLAND_TEST_POINTS,
  });
  for (const e of v.errors) errors.push(e);

  // bbox containment
  const bb = bboxOfPositions(pos);
  const M = 200;
  if (pos.length >= 6) {
    if (bb.minX < GROUND_EXTENT.minX - M || bb.maxX > GROUND_EXTENT.maxX + M ||
        bb.minZ < GROUND_EXTENT.minZ - M || bb.maxZ > GROUND_EXTENT.maxZ + M) {
      errors.push(`bbox が地表矩形 + ${M}m を外れる: ${JSON.stringify(bb)}`);
    }
  }

  // protected / production HTML に Mission06 の痕跡がないこと
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(`${label} HTML が見つからない: ${toProjectRelativePath(p)}`); continue; }
    const html = fs.readFileSync(p, 'utf-8');
    if (/WaterSurfaceLayer|__WATER_SURFACE_DEBUG__|water-surface\.json/.test(html)) {
      errors.push(`${label} HTML に Mission06（WaterSurfaceLayer）の変更が混入している`);
    }
  }

  console.log(`[water-surface-validate] triangles=${v.stats.triangles} area=${(v.stats.areaM2 / 1e6).toFixed(1)}km² rects=${doc.rectangleCount}`);
  console.log(`  nan=${v.stats.nanCount} degenerate=${v.stats.degenerateCount} sliver=${v.stats.sliverCount} oversize=${v.stats.oversizeCount} tall=${v.stats.tallCount} outOfExtent=${v.stats.outOfExtentCount}`);
  console.log(`  inlandHits=${v.stats.inlandHits}/${INLAND_TEST_POINTS.length}  maxEdge=${Math.round(v.stats.maxEdgeM)}m  bbox=${JSON.stringify(bb)}`);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    data: toProjectRelativePath(DATA),
    coordinateConvention: doc.coordinateConvention,
    emitted: doc.emitted, rejectedToEmpty: doc.rejectedToEmpty,
    triangleCount: v.stats.triangles, rectangleCount: doc.rectangleCount, areaKm2: +(v.stats.areaM2 / 1e6).toFixed(3),
    stats: v.stats, bbox: bb,
    inlandTestPointCount: INLAND_TEST_POINTS.length,
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[water-surface-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
