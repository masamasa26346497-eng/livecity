#!/usr/bin/env node
// tools/validate/building-density.js
// [Mission29 §19] 大阪市 建物網羅性の最終強化 validator（PLATEAU + OSM fallback 統合）。
//
// PASS 条件:
//   - fallback id 重複 0 / tile 境界での重複 0
//   - invalid footprint 0（emitted 内に self-intersect / 非有限 / zero-area / giant / 頂点<3）
//   - 大阪市外の fallback 0
//   - fallback 全件に source(osm way id) / heightSource / confidence(0..1)
//   - confidence schema 妥当（heightSource ∈ {osm-height, osm-levels, class-default, generic-default}）
//   - unexplained building gap cluster = 0（building-coverage-audit）
//   - sparse mismatch residual = 0（building-visual-gap-reconciliation）
//   - roof / construction / ruins が fallback へ混入していない
//   - 24区別 breakdown が出ている
//   - LOD 統合: CityBuildingLOD が fallback dataset をロード / isMajorBuilding が fallback にも適用
//   - map completeness 100 維持 / production・protected 無変更
//
// 実行: node tools/validate/building-density.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { ringArea, ringSelfIntersects } from '../lib/osm-building-fallback.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const FB_DIR = P('public', 'map-data', 'osaka-city', 'buildings', 'osaka-osm-fallback');
const ROOT_MANIFEST = P('public', 'map-data', 'osaka-city', 'buildings', 'manifest.json');
const WARDS = P('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const FB_REPORT = P('data', 'reports', 'osm-building-fallback.json');
const COV_AUDIT = P('data', 'reports', 'building-coverage-audit.json');
const VISGAP = P('data', 'reports', 'building-visual-gap-reconciliation.json');
const MAP_AUDIT = P('data', 'reports', 'map-completeness-audit.json');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const REPORT = P('data', 'reports', 'building-density-validation.json');
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; } };

const CITY = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const MARGIN = 900;
const VALID_HEIGHT_SOURCE = new Set(['osm-height', 'osm-levels', 'class-default', 'generic-default']);
const EXCLUDED_USAGE = new Set(['roof', 'construction', 'ruins', 'proposed', 'demolished', 'razed']);

function pnpoly(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(FB_DIR)) { console.error('[stop] fallback dataset なし。先に node tools/build-osm-building-fallback.js'); process.exitCode = 1; return; }

  const wards = (rd(WARDS) || {}).wards || [];
  const wardPolys = [];
  for (const w of wards) for (const pg of (w.polygons || [])) wardPolys.push({ wardId: w.wardId, outer: pg.outer || [], holes: pg.holes || [] });
  const wardAt = (x, z) => {
    for (const p of wardPolys) {
      if (!pnpoly(x, z, p.outer)) continue;
      let hole = false;
      for (const h of p.holes) if (pnpoly(x, z, h)) { hole = true; break; }
      if (!hole) return p.wardId;
    }
    return null;
  };

  const ids = new Set();
  let total = 0, dupId = 0, tileDup = 0, invalidGeom = 0, giant = 0, outside = 0;
  let noSource = 0, noHeightSource = 0, badHeightSource = 0, noConfidence = 0, badConfidence = 0, excludedUsage = 0;
  const byWard = {};
  const heightSourceCount = {};
  for (const f of fs.readdirSync(FB_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(FB_DIR, f), 'utf-8'));
    for (const b of (t.buildings || [])) {
      total++;
      if (ids.has(b.id)) { dupId++; tileDup++; } else ids.add(b.id); // 同 id が2度＝cross-tile 重複配置
      const fp = b.fp;
      if (!Array.isArray(fp) || fp.length < 3 || fp.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) { invalidGeom++; continue; }
      const a = ringArea(fp);
      if (a < 4) invalidGeom++;
      if (a > 60000) giant++;
      if (ringSelfIntersects(fp)) invalidGeom++;
      if (!b.osmId || !/^way\/\d+/.test(String(b.osmId))) noSource++;
      if (!b.heightSource) noHeightSource++;
      else { heightSourceCount[b.heightSource] = (heightSourceCount[b.heightSource] || 0) + 1; if (!VALID_HEIGHT_SOURCE.has(b.heightSource)) badHeightSource++; }
      if (typeof b.confidence !== 'number') noConfidence++;
      else if (b.confidence < 0 || b.confidence > 1) badConfidence++;
      if (b.usage && EXCLUDED_USAGE.has(String(b.usage).toLowerCase())) excludedUsage++;
      const wd = wardAt(b.repX, b.repZ);
      if (!wd) {
        const farOut = b.repX < CITY.minX - MARGIN || b.repX > CITY.maxX + MARGIN || b.repZ < CITY.minZ - MARGIN || b.repZ > CITY.maxZ + MARGIN;
        if (farOut) outside++;
      } else byWard[wd] = (byWard[wd] || 0) + 1;
    }
  }

  if (dupId > 0) errors.push('fallback id 重複 ' + dupId);
  if (tileDup > 0) errors.push('tile 境界での重複配置 ' + tileDup);
  if (invalidGeom > 0) errors.push('invalid footprint ' + invalidGeom);
  if (giant > 0) errors.push('giant footprint (>60000m2) ' + giant);
  if (outside > 0) errors.push('大阪市外の fallback ' + outside);
  if (noSource > 0) errors.push('source(osm way id) 欠落 ' + noSource);
  if (noHeightSource > 0) errors.push('heightSource 欠落 ' + noHeightSource);
  if (badHeightSource > 0) errors.push('未知の heightSource ' + badHeightSource);
  if (noConfidence > 0) errors.push('confidence 欠落 ' + noConfidence);
  if (badConfidence > 0) errors.push('confidence が 0..1 の外 ' + badConfidence);
  if (excludedUsage > 0) errors.push('roof/construction/ruins が fallback へ混入 ' + excludedUsage);
  if (Object.keys(byWard).length < 20) warns.push('fallback が 24区中 ' + Object.keys(byWard).length + ' 区にしか無い');

  const cov = rd(COV_AUDIT);
  if (cov) {
    if (cov.gapClusters.unexplained !== 0) errors.push('unexplained building gap cluster ' + cov.gapClusters.unexplained);
    if (cov.RESULT !== 'PASS') errors.push('building-coverage-audit RESULT = ' + cov.RESULT);
    if (!cov.byWard || Object.keys(cov.byWard).length !== 24) errors.push('building-coverage-audit byWard が24区でない');
  } else warns.push('building-coverage-audit.json なし');
  const vg = rd(VISGAP);
  if (vg) {
    if (vg.sparseMismatch.residualCells !== 0) errors.push('sparse mismatch residual ' + vg.sparseMismatch.residualCells);
    if (vg.sparseMismatch.missedCells !== 0) errors.push('sparse mismatch missed ' + vg.sparseMismatch.missedCells);
    if (vg.remainingExplained && vg.remainingExplained.unexplained !== 0) errors.push('visual gap unexplained ' + vg.remainingExplained.unexplained);
  } else warns.push('building-visual-gap-reconciliation.json なし');
  const fbr = rd(FB_REPORT);
  if (fbr) {
    if (!fbr.byUsage) errors.push('fallback report に byUsage が無い');
    if (!fbr.confidence || typeof fbr.confidence.mean !== 'number') errors.push('fallback report に confidence.mean が無い');
    if (!fbr.footprintQuality) errors.push('fallback report に footprintQuality が無い');
  }
  const root = rd(ROOT_MANIFEST);
  const fbDs = root && (root.datasets || []).find((d) => d.id === 'osaka-osm-fallback');
  if (!fbDs) errors.push('root manifest に osaka-osm-fallback dataset が無い');
  else if (Math.abs(fbDs.buildings - total) > 50) warns.push('root manifest の fallback 件数 ' + fbDs.buildings + ' と実 tile 件数 ' + total + ' が乖離');
  if (!(root && root.osmFallback && typeof root.osmFallback.confidenceMean === 'number')) errors.push('root manifest osmFallback.confidenceMean が無い');

  if (fs.existsSync(DEV_HTML)) {
    const html = fs.readFileSync(DEV_HTML, 'utf-8');
    if (!/await loadWard\('osm-fallback', 'osaka-osm-fallback'\);/.test(html)) errors.push('CityBuildingLOD が fallback dataset をロードしていない（LOD 統合）');
    if (!/function isMajorBuilding\(b\) \{/.test(html)) errors.push('isMajorBuilding（Mission27）が消えた＝fallback の major 判定不能');
    if (!/const isFb = b\.source === 'osm-fallback' \|\| \(typeof b\.id === 'string' && b\.id\.startsWith\('osm_'\)\)/.test(html)) errors.push('BuildingTileLayer の fallback 判定が消えた');
    if (!/function markStaticMesh\(obj\) \{/.test(html)) errors.push('markStaticMesh（Mission25 性能）が消えた');
  }
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(label + ' HTML なし'); continue; }
    const h = fs.readFileSync(p, 'utf-8');
    if (/osaka-osm-fallback|__BUILDING_COVERAGE_DEBUG__|isMajorBuilding/.test(h)) errors.push(label + ' HTML に建物補完/LOD の変更が混入');
  }

  const mc = rd(MAP_AUDIT);
  if (mc && (mc.overallScore !== 100 || mc.criticalCount !== 0 || mc.highCount !== 0)) errors.push('map completeness が 100 でない');

  console.log('[building-density-validate] fallback ' + total + ' 棟 / heightSource ' + JSON.stringify(heightSourceCount));
  console.log('  id重複 ' + dupId + ' / tile重複 ' + tileDup + ' / invalidGeom ' + invalidGeom + ' / giant ' + giant + ' / 市外 ' + outside);
  console.log('  source欠落 ' + noSource + ' / confidence欠落 ' + noConfidence + ' / excluded usage ' + excludedUsage + ' / 24区中 ' + Object.keys(byWard).length + ' 区');
  if (cov) console.log('  gap cluster ' + cov.gapClusters.total + ' (unexplained ' + cov.gapClusters.unexplained + ') / cell coverage ' + (cov.gridAudit.afterFallback.buildingCellCoverage * 100).toFixed(1) + '%');
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    fallbackBuildings: total, heightSourceCount, byWard,
    plateauBuildings: cov ? cov.corpus.classified : null,
    totalRenderable: cov ? cov.corpus.totalRenderable : null,
    gapClusters: cov ? cov.gapClusters.total : null,
    unexplainedGapClusters: cov ? cov.gapClusters.unexplained : null,
    buildingCellCoverage: cov ? cov.gridAudit.afterFallback.buildingCellCoverage : null,
    counts: { dupId, tileDup, invalidGeom, giant, outside, noSource, noConfidence, excludedUsage },
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[building-density-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
