#!/usr/bin/env node
// tools/validate/major-building-lod.js
// [Mission27 §12] 中景・主要建物LOD の validator。
//
// PASS 条件:
//   - major-building-lod-audit.json が存在し RESULT PASS（選定率が 0.5〜10%）
//   - HTML: CityBuildingLOD が minor/major の 2 バケットへ分割（buildWardMeshes / isMajorBuilding /
//     bandVisibility / applyBand）、__MAJOR_BUILDING_LOD_DEBUG__ 公開
//   - overlap 防止: MID band で minor 非表示（major のみ）、HIDE_NEAR_M=4000 不変、
//     NEAR で両バケット非表示（BuildingTileLayer へ handoff）
//   - landmark 二重表示防止: appendBuilding の LandmarkLayer.isSuppressedBuilding ガード維持
//   - Mission25 最適化維持: minor/major とも markStaticMesh、material 共有、raycast 無効、
//     per-frame の全建物走査なし（applyBand は setCameraDistance / setVisible / loadWard からのみ）
//   - 遠景 CityBuildingLOD（FAR で minor+major）・近景 BuildingTileLayer は維持
//   - Mission24 完成度 PASS / production・protected 無変更
//
// 実行: node tools/validate/major-building-lod.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AUDIT = P('data', 'reports', 'major-building-lod.json');
const MAP_AUDIT = P('data', 'reports', 'map-completeness-audit.json');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const REPORT = P('data', 'reports', 'major-building-lod-validation.json');
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; } };

async function main() {
  const errors = [], warns = [];
  const a = rd(AUDIT);
  if (!a) { console.error('[stop] major-building-lod.json なし。先に node tools/audit/major-building-lod.js'); process.exitCode = 1; return; }

  if (a.RESULT !== 'PASS') errors.push('audit RESULT = ' + a.RESULT);
  if (!(a.selectedFraction > 0.005 && a.selectedFraction < 0.10)) errors.push('主要建物選定率 ' + a.selectedPercent + '% が想定外（0.5〜10%）');
  if (a.selectedMajor < 5000) errors.push('主要建物 ' + a.selectedMajor + ' 棟は少なすぎる');
  if (a.thresholds.midMaxM !== 9000) errors.push('MID_MAX_M が 9000 でない');
  if (a.thresholds.hideNearM !== 4000) errors.push('HIDE_NEAR_M が 4000 でない');

  if (!fs.existsSync(DEV_HTML)) { console.error('[stop] dev HTML なし'); process.exitCode = 1; return; }
  const html = fs.readFileSync(DEV_HTML, 'utf-8');

  // ── CityBuildingLOD の minor/major 分割 ──
  for (const [re, msg] of [
    [/const MID_MAX_M = 9000;/, 'MID_MAX_M = 9000 が無い'],
    [/const MAJOR_MIN_HEIGHT_M = 30;/, 'MAJOR_MIN_HEIGHT_M = 30 が無い'],
    [/const MAJOR_MIN_FP_AREA_M2 = 3000;/, 'MAJOR_MIN_FP_AREA_M2 = 3000 が無い'],
    [/function isMajorBuilding\(b\) \{/, 'isMajorBuilding が無い'],
    [/function buildWardMeshes\(wardId, buildingsArr\) \{/, 'buildWardMeshes（minor/major 分割）が無い'],
    [/function bandVisibility\(r\) \{/, 'bandVisibility が無い'],
    [/function applyBand\(\) \{/, 'applyBand が無い'],
    [/window\.__MAJOR_BUILDING_LOD_DEBUG__ =/, '__MAJOR_BUILDING_LOD_DEBUG__ 未公開'],
    [/function getMajorLodDebug\(\) \{/, 'getMajorLodDebug が無い'],
  ]) if (!re.test(html)) errors.push('dev HTML: ' + msg);

  // ── overlap 防止（band 排他）──
  //   far: minor && far / major && (far||mid)。mid: minor=false, major=true。near: 両方 false。
  if (!/const far = r > MID_MAX_M;\s*\n\s*const mid = r > HIDE_NEAR_M && r <= MID_MAX_M;/.test(html)) {
    errors.push('dev HTML: band 判定（far>9000 / mid 4000..9000）が変わった');
  }
  if (!/minor: visible && far, major: visible && \(far \|\| mid\)/.test(html)) {
    errors.push('dev HTML: minor は FAR のみ / major は FAR+MID の可視ルールが無い（3重表示防止）');
  }
  if (!/const HIDE_NEAR_M = 4000;/.test(html)) errors.push('dev HTML: HIDE_NEAR_M = 4000 が変わった');

  // ── landmark 二重表示防止（既存ガード維持）──
  const cbl = html.slice(html.indexOf('const CityBuildingLOD = (function'), html.indexOf('const CityModeManager = (function'));
  if (!/LandmarkLayer\.isSuppressedBuilding\(b\.id\)\) return;/.test(cbl)) errors.push('appendBuilding の LandmarkLayer.isSuppressedBuilding ガードが消えた（§8 二重表示防止）');

  // ── Mission25 最適化維持 ──
  if (!/mesh\.raycast = \(\) => \{\};/.test(cbl)) errors.push('中景/遠景ブロックの raycast 無効化が無い（§3）');
  const markCount = (cbl.match(/markStaticMesh\(mesh\)/g) || []).length;
  if (markCount < 1) errors.push('buildOneMesh に markStaticMesh が無い（§4/§10）');
  if (!/const mesh = new THREE\.Mesh\(geom, getMaterial\(\)\);/.test(cbl)) errors.push('minor/major で material 共有していない（§4）');
  // per-frame の全建物走査が無いこと: applyBand の呼び出し元
  const applyBandCallers = (cbl.match(/applyBand\(\)/g) || []).length;
  if (applyBandCallers < 3 || applyBandCallers > 8) warns.push('applyBand の呼び出し回数 ' + applyBandCallers + '（setCameraDistance/setVisible/loadWard 想定）');
  if (/requestAnimationFrame[\s\S]{0,120}applyBand\(\)/.test(html)) errors.push('applyBand が render loop から呼ばれている（per-frame 走査禁止）');

  // ── 既存レイヤー・debug API 回帰 ──
  for (const kw of ['const BuildingTileLayer = (function', '__BUILDING_COVERAGE_DEBUG__', '__MAP_COMPLETENESS_DEBUG__',
    '__PERFORMANCE_DEBUG__', 'CityBuildingLOD.build()', 'CityBuildingLOD.setVisible']) {
    if (!html.includes(kw)) errors.push('dev HTML: 既存 ' + kw + ' が消えた');
  }
  // getStats 互換キー（他 debug API が参照）
  for (const k of ['wardsStarted', 'wardsReady', 'osmFallbackStatus', 'osmFallbackTriangles']) {
    if (!cbl.includes(k)) errors.push('CityBuildingLOD.getStats の互換キー ' + k + ' が消えた');
  }

  // ── Mission24 完成度 ──
  const mc = rd(MAP_AUDIT);
  if (mc) {
    if (mc.overallScore !== 100) errors.push('map completeness overallScore ' + mc.overallScore);
    if (mc.criticalCount !== 0 || mc.highCount !== 0) errors.push('map completeness CRITICAL/HIGH != 0');
  } else warns.push('map-completeness-audit.json なし');

  // ── production / protected ──
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(label + ' HTML なし'); continue; }
    const h = fs.readFileSync(p, 'utf-8');
    if (/isMajorBuilding|buildWardMeshes|__MAJOR_BUILDING_LOD_DEBUG__|MID_MAX_M/.test(h)) errors.push(label + ' HTML に Mission27 変更が混入');
  }

  console.log('[major-building-lod-validate]');
  console.log('  全建物 ' + a.totalBuildings + ' → 主要建物 ' + a.selectedMajor + ' (' + a.selectedPercent + '%)  基準別 ' + JSON.stringify(a.byCriterion));
  console.log('  band ルール: FAR>9000 minor+major / MID 4000-9000 major only / NEAR<4000 BuildingTileLayer');
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    selectedMajor: a.selectedMajor, selectedPercent: a.selectedPercent, byCriterion: a.byCriterion,
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[major-building-lod-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
