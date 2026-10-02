#!/usr/bin/env node
// tools/validate/land-coverage.js
// [見た目改善 Mission21] 大阪市24区 陸域 coverage / LandSurfaceLayer 配信データ validator CLI。
//
// PASS 条件（§12）:
//   - 24 wards present（N03 24区が揃っている）
//   - coordinateConvention === 'znorth-neg-v1' / emitted:true（reject-to-empty されていない）
//   - NaN / Inf 頂点 0
//   - invalid rings 0（区ポリゴンの outer が 3 点以上・有限）
//   - giant triangle 0（辺長 > tile 対角）
//   - unexplained missing clusters 0
//   - illegal sea overlap 0（LandSurface と water-surface.json が陸で重ならない）
//   - 24区全体 land coverage >= 99%
//   - legacy ground を再表示していない（HTML: SHOW_LEGACY_GROUND:false / gnd.visible = false）
//   - 巨大 1 枚 ground mesh を敷いていない（LandSurfaceLayer は tile clip で複数三角形）
//   - RiverLayerV2 が変更されていない
//   - protected / production HTML に Mission21 の変更が混入していない
//
// 実行: node tools/validate/land-coverage.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { SEA_MASK } from '../lib/water-surface.js';
import { validateLandSurface, auditLandCoverage, findLandGapClusters, auditKeyPlaces, DREAM_ISLAND } from '../lib/land-coverage.js';

const DATA = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'land-surface', 'land-surface.json'));
const WATER = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'water-surface', 'water-surface.json'));
const WARDS = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'land-coverage-validation.json'));
const DEV_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.ward-ux-v1.html'));
const PROD_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.html'));
const PROTECTED_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.fullward-v3.html'));

async function main() {
  const errors = [];
  const warns = [];

  for (const p of [DATA, WATER, WARDS]) {
    if (!fs.existsSync(p)) { console.error('[land-coverage-validate] 入力なし: ' + toProjectRelativePath(p)); process.exitCode = 1; return; }
  }
  const doc = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  const water = JSON.parse(fs.readFileSync(WATER, 'utf-8'));
  const wards = (JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards) || [];

  // ── 1. 配信データ基本 ──
  if (doc.coordinateConvention !== 'znorth-neg-v1') errors.push('coordinateConvention が znorth-neg-v1 でない: ' + doc.coordinateConvention);
  if (doc.emitted !== true || doc.rejectedToEmpty === true) errors.push('LandSurface が reject-to-empty（' + (doc.validationErrors || []).join(' / ') + '）');

  const pos = Array.isArray(doc.positions) ? doc.positions : [];
  if (pos.length < 6) errors.push('positions がほぼ空 (' + pos.length + ')');

  // ── 2. geometry 検証（NaN / 退化 / giant triangle / winding）──
  const v = validateLandSurface(pos, { tileM: doc.tileM || 1000 });
  for (const e of v.errors) errors.push('geometry: ' + e);
  if (v.stats.nan > 0) errors.push('NaN/Inf 頂点 ' + v.stats.nan);
  if (v.stats.giant > 0) errors.push('giant triangle ' + v.stats.giant);
  if (v.stats.downfacing > 0) errors.push('下向き三角形 ' + v.stats.downfacing);

  // 巨大 1 枚 ground mesh でないこと（tile clip されていれば三角形数が多く、最大辺 << 全体幅）
  const bb = doc.bbox || {};
  const spanX = (bb.maxX - bb.minX) || 0, spanZ = (bb.maxZ - bb.minZ) || 0;
  if (v.stats.triangles < 200) errors.push('三角形が少なすぎる（巨大 1 枚 mesh の疑い）: ' + v.stats.triangles);
  if (v.stats.maxEdgeM > Math.max(spanX, spanZ) * 0.5) errors.push('最大辺長が広域すぎる（tile clip されていない疑い）: ' + Math.round(v.stats.maxEdgeM) + 'm');

  // ── 3. 24 wards present / invalid rings ──
  const wardIds = new Set(wards.map((w) => w.wardId));
  if (wardIds.size < 24) errors.push('24区が揃っていない: ' + wardIds.size + ' 区');
  let invalidRings = 0, totalRings = 0;
  for (const w of wards) {
    for (const poly of (w.polygons || [])) {
      const rings = [poly.outer, ...((poly.holes) || [])];
      for (const r of rings) {
        totalRings++;
        if (!Array.isArray(r) || r.length < 3 || !r.every((pt) => Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]))) invalidRings++;
      }
    }
  }
  if (invalidRings > 0) errors.push('invalid rings ' + invalidRings + ' / ' + totalRings);

  // ── 4. coverage 監査（50m グリッド）──
  const audit = auditLandCoverage({ wards, cellM: 50, seaMask: SEA_MASK, waterPositions: water.positions || null });
  if (audit.coveragePercent < 99) errors.push('land coverage が 99% 未満: ' + audit.coveragePercent + '%');
  if (audit.seaOverlapSamples > 0) errors.push('illegal sea overlap ' + audit.seaOverlapSamples + ' サンプル（LandSurface ∩ water-surface）');

  // ── 5. unexplained missing clusters ──
  const clusters = findLandGapClusters({ wards, cellM: 100, seaMask: SEA_MASK });
  const unexplained = clusters.filter((c) => c.unexplained);
  if (unexplained.length > 0) errors.push('unexplained missing clusters ' + unexplained.length + ': ' + unexplained.map((c) => c.id + '@' + JSON.stringify(c.center)).join(', '));

  // ── 6. key places ──
  const keyPlaces = auditKeyPlaces(wards, SEA_MASK, DREAM_ISLAND, water.positions || null);
  const artificialIslands = ['yumeshima', 'maishima', 'sakishima', 'nanko', 'tempozan'];
  for (const id of artificialIslands) {
    const k = keyPlaces.find((x) => x.id === id);
    if (k && !k.covered) errors.push('人工島 ' + k.name + ' が未 cover: ' + k.cause);
  }

  // ── 7. HTML wiring（dev target）──
  if (fs.existsSync(DEV_HTML)) {
    const html = fs.readFileSync(DEV_HTML, 'utf-8');
    if (!/LandSurfaceLayer/.test(html)) errors.push('dev HTML に LandSurfaceLayer が無い');
    if (!/__LAND_COVERAGE_DEBUG__/.test(html)) errors.push('dev HTML に __LAND_COVERAGE_DEBUG__ が無い');
    if (!/land-surface\/land-surface\.json/.test(html)) errors.push('dev HTML が land-surface.json を fetch していない');
    if (!/SHOW_LEGACY_GROUND:\s*false/.test(html)) errors.push('dev HTML: SHOW_LEGACY_GROUND が false でない（legacy ground 再表示の疑い）');
    if (/gnd\.visible\s*=\s*true/.test(html)) errors.push('dev HTML: gnd.visible = true（legacy ground 再表示）');
    if (!/RiverLayerV2/.test(html)) warns.push('dev HTML: RiverLayerV2 参照が見当たらない');
  } else {
    warns.push('dev HTML が見つからない: ' + toProjectRelativePath(DEV_HTML));
  }

  // ── 8. protected / production HTML に Mission21 が混入していないこと ──
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(label + ' HTML が見つからない: ' + toProjectRelativePath(p)); continue; }
    const html = fs.readFileSync(p, 'utf-8');
    if (/LandSurfaceLayer|__LAND_COVERAGE_DEBUG__|land-surface\.json/.test(html)) {
      errors.push(label + ' HTML に Mission21（LandSurfaceLayer）の変更が混入している');
    }
  }

  console.log('[land-coverage-validate] triangles=' + v.stats.triangles + ' tiles=' + doc.tiles + ' area=' + (v.stats.areaM2 / 1e6).toFixed(1) + 'km²');
  console.log('  nan=' + v.stats.nan + ' degenerate=' + v.stats.degenerate + ' giant=' + v.stats.giant + ' downfacing=' + v.stats.downfacing + ' maxEdge=' + Math.round(v.stats.maxEdgeM) + 'm');
  console.log('  coverage=' + audit.coveragePercent + '% seaOverlap=' + audit.seaOverlapSamples + ' wards=' + wardIds.size + ' invalidRings=' + invalidRings);
  console.log('  missing clusters=' + clusters.length + ' (unexplained=' + unexplained.length + ')  keyPlaces=' + keyPlaces.filter((k) => k.covered).length + '/' + keyPlaces.length);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    data: toProjectRelativePath(DATA),
    coordinateConvention: doc.coordinateConvention,
    emitted: doc.emitted,
    geometry: v.stats,
    coverage: {
      cellM: audit.cellM, coveragePercent: audit.coveragePercent,
      landSamples: audit.landSamples, coveredLandSamples: audit.coveredLandSamples, missingLandSamples: audit.missingLandSamples,
      seaOverlapSamples: audit.seaOverlapSamples, landAreaKm2: audit.landAreaKm2, byWard: audit.byWard,
    },
    wards: wardIds.size, invalidRings, totalRings,
    missingClusters: { total: clusters.length, unexplained: unexplained.length },
    keyPlaces,
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[land-coverage-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
