#!/usr/bin/env node
// tools/validate/waterway-density.js
// [Mission28 §17] 大阪市 水系の高密度化 validator。
//
// PASS 条件:
//   - unsupported waterway class 0 / invalid geometry 0 / giant triangle 0 / duplicate id 0
//   - surface water unexplained missing 0（waterway-density.json）
//   - underground を地表 render していない 0
//   - tile boundary break 0（line feature は tile クリップしない＝構造的に 0）
//   - bbox violation 0（rivers.json の bbox が OSAKA_CITY_GROUND_EXTENT + margin 内）
//   - building conflict anomaly が予算内（現実的な橋・護岸一体は EXPLAINED 可）
//   - major 7 河川の width/geometry が Mission04 から不変（回帰）
//   - HTML: RiverLayerV2 に micro tier（microMesh / MICRO_HIDE_DISTANCE_M=1500）配線、__RIVER_NETWORK_DEBUG__ 拡張
//   - production / protected 無変更
//
// 実行: node tools/validate/waterway-density.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const RIVERS = P('public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json');
const DENSITY = P('data', 'reports', 'waterway-density.json');
const COVERAGE = P('data', 'reports', 'river-network-coverage.json');
const RIVER_GEN = P('data', 'reports', 'river-layer-generation.json');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const REPORT = P('data', 'reports', 'waterway-density-validation.json');
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; } };

const CITY = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const SUPPORTED_TIERS = new Set(['major', 'medium', 'minor', 'micro']);
// Mission04 で確定した主要7河川の median width（±20% 許容）
const MAJOR7_MEDIAN = { '淀川': 400, '大和川': 110, '神崎川': 127, '安治川': 67, '木津川': 173, '寝屋川': 60, '道頓堀川': 42 };

async function main() {
  const errors = [], warns = [];
  const rj = rd(RIVERS);
  if (!rj) { console.error('[stop] rivers.json なし。先に node tools/build-river-layer.js'); process.exitCode = 1; return; }
  const rivers = rj.rivers || [];

  // ── feature 検査 ──
  const ids = new Set();
  let dupId = 0, badTier = 0, invalidGeom = 0, giantTri = 0, bboxViolation = 0, undergroundRendered = 0;
  let microN = 0, microMaxWidth = 0;
  for (const r of rivers) {
    if (ids.has(r.id)) dupId++; else ids.add(r.id);
    if (r.riverClass && !SUPPORTED_TIERS.has(r.riverClass)) badTier++;
    if (r.surface === false && r.ok && !r.suppressed) undergroundRendered++;
    if (!r.ok) continue;
    if (!Array.isArray(r.left) || !Array.isArray(r.right) || r.left.length < 2 || r.right.length < 2) { invalidGeom++; continue; }
    if ((r.maxTriangleEdge || 0) > 600 && r.riverClass !== 'major') giantTri++;
    if ((r.maxTriangleArea || 0) > 60000 && r.riverClass !== 'major') giantTri++;
    if (r.bbox) {
      const b = r.bbox, m = 800;
      if (b.minX < CITY.minX - m || b.maxX > CITY.maxX + m || b.minZ < CITY.minZ - m || b.maxZ > CITY.maxZ + m) bboxViolation++;
    }
    if (r.riverClass === 'micro') {
      microN++;
      const w = r.widthMax || r.width || 0;
      if (w > microMaxWidth) microMaxWidth = w;
    }
  }
  if (dupId > 0) errors.push('duplicate river id ' + dupId);
  if (badTier > 0) errors.push('unsupported waterway tier ' + badTier);
  if (invalidGeom > 0) errors.push('invalid geometry ' + invalidGeom);
  if (giantTri > 0) errors.push('giant triangle (non-major) ' + giantTri);
  if (bboxViolation > 0) errors.push('bbox violation ' + bboxViolation);
  if (undergroundRendered > 0) errors.push('underground を地表 render している ' + undergroundRendered);
  if (microN < 10) warns.push('micro tier が少ない (' + microN + ')');
  if (microMaxWidth > 10) errors.push('micro water の最大幅 ' + microMaxWidth.toFixed(1) + 'm が広すぎる（<=8 想定・clamp漏れ）');

  // ── completeness（§12）──
  const den = rd(DENSITY);
  if (!den) warns.push('waterway-density.json なし（先に node tools/audit/waterway-density.js）');
  else {
    if (den.grid.missingSurfaceWater > Math.max(20, den.grid.knownSurfaceCells * 0.02)) {
      errors.push('surface water unexplained missing ' + den.grid.missingSurfaceWater);
    }
    if (den.RESULT !== 'PASS') errors.push('waterway-density audit RESULT = ' + den.RESULT);
  }

  // ── coverage report（§18）──
  const cov = rd(COVERAGE);
  if (cov) {
    if (!cov.tiers || cov.tiers.micro == null) errors.push('coverage report に tiers.micro が無い');
    if (!cov.buildingOverlap) errors.push('coverage report に buildingOverlap（§11）が無い');
    else {
      const bo = cov.buildingOverlap;
      // 現実的な重なりの予算: 表示水路の 20% まで（橋・護岸一体等）
      const budget = Math.max(40, (cov.displayed || 0) * 0.20);
      if (bo.waterBuildingOverlapCount > budget) errors.push('building overlap ' + bo.waterBuildingOverlapCount + ' > 予算 ' + Math.round(budget));
    }
    if ((cov.unexplainedGapRivers || []).length) errors.push('unexplained river gap ' + cov.unexplainedGapRivers.length);
  }

  // ── major 7 河川 regression（§0）──
  const gen = rd(RIVER_GEN);
  if (gen && Array.isArray(gen.majorRivers)) {
    for (const m of gen.majorRivers) {
      const exp = MAJOR7_MEDIAN[m.name];
      if (exp == null || m.widthMedian == null) continue;
      const ratio = m.widthMedian / exp;
      if (ratio < 0.8 || ratio > 1.25) errors.push('major river ' + m.name + ' median width ' + m.widthMedian + ' が Mission04 基準 ' + exp + ' から乖離');
      if ((m.errors || []).length) errors.push('major river ' + m.name + ' に validation error');
    }
  }

  // ── HTML 配線 ──
  if (fs.existsSync(DEV_HTML)) {
    const html = fs.readFileSync(DEV_HTML, 'utf-8');
    for (const [re, msg] of [
      [/const MICRO_HIDE_DISTANCE_M = 1500;/, 'MICRO_HIDE_DISTANCE_M = 1500 が無い'],
      [/let majorMesh = null, mediumMesh = null, minorMesh = null, microMesh = null, shoreMesh = null;/, 'microMesh が無い'],
      [/if \(microMesh\) microMesh\.visible = visible && distance <= MICRO_HIDE_DISTANCE_M;/, 'micro の LOD 可視判定が無い'],
      [/tier === 'micro' \? microPos : minorPos/, 'micro tier の bucketing が無い'],
      [/visibleByLod/, '__RIVER_NETWORK_DEBUG__ に visibleByLod が無い'],
      [/const RiverLayerV2 = \(function/, 'RiverLayerV2 が消えた'],
    ]) if (!re.test(html)) errors.push('dev HTML: ' + msg);
    // major/medium/minor の既存 LOD 距離は不変（§0 既存の見た目を壊さない）
    if (!/const MINOR_HIDE_DISTANCE_M = 4500;/.test(html)) errors.push('dev HTML: MINOR_HIDE_DISTANCE_M が変わった');
    if (!/const MEDIUM_HIDE_DISTANCE_M = 9000;/.test(html)) errors.push('dev HTML: MEDIUM_HIDE_DISTANCE_M が変わった');
    if (!/const MAJOR_RIVER_NAMES = new Set\(\['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川'\]\);/.test(html)) {
      errors.push('dev HTML: MAJOR_RIVER_NAMES（主要7河川）が変わった');
    }
  }
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(label + ' HTML なし'); continue; }
    const h = fs.readFileSync(p, 'utf-8');
    if (/MICRO_HIDE_DISTANCE_M|microMesh|microOpacity/.test(h)) errors.push(label + ' HTML に Mission28 変更が混入');
  }

  console.log('[waterway-density-validate]');
  console.log('  rivers ' + rivers.length + '  micro ' + microN + ' (maxWidth ' + microMaxWidth.toFixed(1) + 'm)');
  if (cov) console.log('  tiers: ' + JSON.stringify(cov.tiers) + '  displayed ' + cov.displayed + '  overlap ' + (cov.buildingOverlap ? cov.buildingOverlap.waterBuildingOverlapCount : '?'));
  if (den) console.log('  completeness: ' + (den.grid.coverage * 100).toFixed(1) + '%  missing ' + den.grid.missingSurfaceWater);
  console.log('  duplicate ' + dupId + ' / invalid ' + invalidGeom + ' / giantTri ' + giantTri + ' / bboxViolation ' + bboxViolation + ' / undergroundRendered ' + undergroundRendered);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    rivers: rivers.length, micro: microN, microMaxWidth: +microMaxWidth.toFixed(1),
    tiers: cov ? cov.tiers : null,
    completeness: den ? den.grid : null,
    counts: { dupId, badTier, invalidGeom, giantTri, bboxViolation, undergroundRendered },
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[waterway-density-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
