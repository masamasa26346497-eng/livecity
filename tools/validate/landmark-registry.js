#!/usr/bin/env node
// tools/validate/landmark-registry.js
// [見た目改善 Mission11] ランドマークレジストリ validator。
//
// 必須検証:
//   - duplicate landmark id = 0
//   - resolved landmark は buildingIds が空でなく、その id が実 building dataset に存在する
//   - unresolved は buildingIds が空（安全に無視できる）
//   - NaN / 非有限座標なし
//   - height mutation なし（seed / registry は建物実高度を持たない・書き換えない）
//   - suspiciousHeight（>500m）を候補採用していない
//   - dev HTML の配線（LANDMARK_REGISTRY IIFE / __LANDMARK_DEBUG__）
//   - CityBuildingLOD の単一 shared material / draw call 構造不変
//   - Mission10 BUILDING_HEIGHT_STYLE 維持 / Mission14 station debounce 維持 / Mission15 LabelEngine 復活なし
//   - production / protected 変更なし
//
// 実行: node tools/validate/landmark-registry.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import {
  LANDMARK_SEED, LANDMARK_CATEGORIES, LANDMARK_IMPORTANCE, SUSPICIOUS_HEIGHT_M,
  validateSeed, findDuplicateIds, isSuspiciousHeight,
} from '../lib/landmark-registry.js';

const DATA = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'));
const BUILDINGS_ROOT = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'buildings'));
const DEV_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.ward-ux-v1.html'));
const PROD_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.html'));
const PROTECTED_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.fullward-v3.html'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'landmark-registry-validation.json'));

function stripLineComments(src) {
  return src.split('\n').map((ln) => { const i = ln.indexOf('//'); return (i > 0 && ln[i - 1] === ':') || i < 0 ? ln : ln.slice(0, i); }).join('\n');
}

function collectBuildingIds() {
  const ids = new Set();
  if (!fs.existsSync(BUILDINGS_ROOT)) return ids;
  const manifest = JSON.parse(fs.readFileSync(path.join(BUILDINGS_ROOT, 'manifest.json'), 'utf-8'));
  for (const ds of manifest.datasets || []) {
    const dir = path.join(BUILDINGS_ROOT, ds.id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      for (const b of (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')).buildings || [])) ids.add(b.id);
    }
  }
  return ids;
}

function checkHtml(errors, warns) {
  const raw = fs.readFileSync(DEV_HTML, 'utf-8');
  const html = stripLineComments(raw);
  if (!/const LANDMARK_REGISTRY = \(function \(\) \{/.test(html)) errors.push('dev HTML に LANDMARK_REGISTRY IIFE が無い');
  if (!/window\.__LANDMARK_DEBUG__ = /.test(html)) errors.push('dev HTML に __LANDMARK_DEBUG__ が無い');
  // 高さ改変なし
  const muts = html.match(/\bb\.(dz|z0|h)\s*[*+/-]?=\s*[^=]/g) || [];
  if (muts.length) errors.push(`建物実高度への代入: ${muts.map((s) => s.trim()).join(' | ')}`);
  // Mission10 維持
  if (!/const BUILDING_HEIGHT_STYLE = \(function \(\) \{/.test(html)) errors.push('Mission10 BUILDING_HEIGHT_STYLE が消えている');
  // Mission14 station debounce 維持
  if (!/lastRebuildAt|pendingSince/.test(html)) warns.push('Mission14 station debounce 変数が見当たらない（要確認）');
  // Mission15 LabelEngine 復活なし
  if (/const LabelEngine = \(function/.test(html)) errors.push('Mission15 LabelEngine が復活している');
  // ランドマークを色相で塗っていない
  const iifeStart = html.indexOf('const LANDMARK_REGISTRY = (function');
  const iifeEnd = html.indexOf('LANDMARK_REGISTRY.load(');
  const iife = (iifeStart >= 0 && iifeEnd > iifeStart) ? html.slice(iifeStart, iifeEnd) : '';
  if (iife && /emissive|neon|setHSL|new THREE\.Color\(0x(?!ffffff)/.test(iife)) errors.push('LANDMARK_REGISTRY に色/発光の痕跡');
  // CityBuildingLOD 構造
  const s = html.indexOf('const CityBuildingLOD = (function');
  const e = html.indexOf('const CityModeManager = (function', s);
  const block = (s >= 0 && e > s) ? html.slice(s, e) : '';
  if (block) {
    const mats = block.match(/new THREE\.(Mesh\w*Material|LineBasicMaterial|ShaderMaterial)/g) || [];
    if (mats.length !== 1) errors.push(`CityBuildingLOD の material 生成が ${mats.length} 箇所（1 のはず）`);
    const append = block.slice(block.indexOf('function appendBuilding'), block.indexOf('function buildWardMesh'));
    if (/new THREE\.(Mesh|BufferGeometry|Line)\(/.test(append)) errors.push('CityBuildingLOD.appendBuilding が per-building オブジェクトを生成');
    if (!/const y0 = b\.z0, y1 = b\.z0 \+ b\.dz;/.test(append)) errors.push('CityBuildingLOD 押し出し高さが b.z0+b.dz でない');
  } else warns.push('CityBuildingLOD ブロック特定失敗');
}

function checkProtected(errors) {
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) continue;
    if (/LANDMARK_REGISTRY|__LANDMARK_DEBUG__|landmarks\.json/.test(fs.readFileSync(p, 'utf-8'))) {
      errors.push(`${label} HTML に Mission11 の変更が混入`);
    }
  }
}

async function main() {
  const errors = [], warns = [];

  const seedCheck = validateSeed(LANDMARK_SEED);
  for (const e of seedCheck.errors) errors.push('seed: ' + e);
  const dups = findDuplicateIds(LANDMARK_SEED);
  if (dups.length) errors.push(`duplicate seed id: ${dups.join(', ')}`);

  checkHtml(errors, warns);
  checkProtected(errors);

  let doc = null;
  if (!fs.existsSync(DATA)) {
    errors.push(`landmarks.json が無い（node tools/build-landmark-registry.js）: ${toProjectRelativePath(DATA)}`);
  } else {
    doc = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
    if (doc.coordinateConvention !== 'znorth-neg-v1') errors.push(`coordinateConvention 不正: ${doc.coordinateConvention}`);
    const lms = doc.landmarks || [];
    const ids = new Set();
    for (const l of lms) {
      if (ids.has(l.id)) errors.push(`duplicate landmark id in json: ${l.id}`);
      ids.add(l.id);
      if (!Number.isFinite(l.x) || !Number.isFinite(l.z)) errors.push(`${l.id}: NaN/非有限座標`);
      if (!LANDMARK_CATEGORIES.includes(l.category)) errors.push(`${l.id}: category 不正 ${l.category}`);
      if (!LANDMARK_IMPORTANCE.includes(l.importance)) errors.push(`${l.id}: importance 不正 ${l.importance}`);
      if (isSuspiciousHeight(l.osmHeight)) errors.push(`${l.id}: suspiciousHeight を採用している (${l.osmHeight})`);
      if (l.resolved) {
        if (!Array.isArray(l.buildingIds) || l.buildingIds.length === 0) errors.push(`${l.id}: resolved なのに buildingIds が空`);
      } else if (l.buildingIds && l.buildingIds.length) {
        errors.push(`${l.id}: unresolved なのに buildingIds が残っている`);
      }
      if (!['PROCEDURAL', 'LOD1', 'LOD2', 'LOD3', 'GLTF'].includes(l.modelType)) errors.push(`${l.id}: modelType 不正 ${l.modelType}`);
    }
    // resolved の buildingId が実在するか
    const realIds = collectBuildingIds();
    if (realIds.size) {
      for (const l of lms.filter((x) => x.resolved)) {
        for (const bid of l.buildingIds) {
          if (!realIds.has(bid)) errors.push(`${l.id}: buildingId ${bid} が building dataset に存在しない`);
        }
      }
    } else warns.push('building dataset を読めず buildingId 実在チェックをスキップ');

    console.log(`[landmark-registry-validate] total=${lms.length} resolved=${doc.counts.resolved} unresolved=${doc.counts.unresolved}`);
    console.log(`  MAJOR=${doc.counts.major} REGIONAL=${doc.counts.regional} LOCAL=${doc.counts.local} / resolvedBuildingIds=${doc.counts.resolvedBuildingIds}`);
    for (const l of lms.filter((x) => x.resolved)) console.log(`  [resolved] ${l.id} ← ${JSON.stringify(l.buildingIds)} (${l.resolveMethod})`);
  }

  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    data: toProjectRelativePath(DATA),
    seedCount: LANDMARK_SEED.length,
    suspiciousHeightThresholdM: SUSPICIOUS_HEIGHT_M,
    counts: doc ? doc.counts : null,
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[landmark-registry-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
