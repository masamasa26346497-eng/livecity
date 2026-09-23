#!/usr/bin/env node
// tools/validate/landmark-models.js
// [見た目改善 Mission11B] ランドマーク 3D モデル経路の validator。
//
// 必須検証:
//   - landmarks.json の各 model が registry と整合（id / modelType / shape）
//   - modelUrl 指定（GLTF）なのにファイルが無い → 検出
//   - procedural model: positions/indices 有限、index 範囲内、triangleCount 整合
//   - real-world scale: model bbox 高さ ≈ osmHeight（比 [0.9, 1.15]）、footprint 幅 ≈ footprintBbox（拡大していない）
//   - duplicate suppression: resolved + modelAvailable のとき buildingIds が存在し実在する
//   - unresolved は safe skip（buildingIds 空 / suppress 対象にならない）
//   - City Mode bulk-load 禁止（HTML: 個別 loader を forEach で呼んでいない / merged 1 mesh）
//   - dev HTML の LandmarkLayer 配線 / __LANDMARK_LAYER_DEBUG__
//   - Mission10 / Mission11 registry / Mission14 debounce / Mission15 LabelEngine
//   - production / protected 変更なし
//
// 実行: node tools/validate/landmark-models.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { LANDMARK_SEED, modelPlanFor } from '../lib/landmark-registry.js';
import { getModelSpec, buildGeometry, summarizeModels } from '../lib/landmark-model-provider.js';

const DATA = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'));
const BUILDINGS_ROOT = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'buildings'));
const DEV_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.ward-ux-v1.html'));
const PROD_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.html'));
const PROTECTED_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.fullward-v3.html'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'landmark-models-validation.json'));

function stripLineComments(src) {
  return src.split('\n').map((ln) => { const i = ln.indexOf('//'); return (i > 0 && ln[i - 1] === ':') || i < 0 ? ln : ln.slice(0, i); }).join('\n');
}
function collectBuildingIds() {
  const ids = new Set();
  if (!fs.existsSync(BUILDINGS_ROOT)) return ids;
  const m = JSON.parse(fs.readFileSync(path.join(BUILDINGS_ROOT, 'manifest.json'), 'utf-8'));
  for (const ds of m.datasets || []) {
    const dir = path.join(BUILDINGS_ROOT, ds.id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      for (const b of (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')).buildings || [])) ids.add(b.id);
    }
  }
  return ids;
}

function checkGeometry(l, errors) {
  const m = l.model;
  if (!m) return;
  if (m.kind === 'gltf') {
    if (m.url && !fs.existsSync(resolveProjectPath(m.url.replace(/^\//, '')))) errors.push(`${l.id}: GLTF modelUrl ${m.url} が存在しない`);
    return;
  }
  if (m.kind !== 'procedural') { errors.push(`${l.id}: 未知の model.kind ${m.kind}`); return; }
  if (!Array.isArray(m.positions) || !Array.isArray(m.indices)) { errors.push(`${l.id}: positions/indices が配列でない`); return; }
  if (m.positions.length % 3 !== 0) errors.push(`${l.id}: positions 長が 3 の倍数でない`);
  if (m.indices.length % 3 !== 0) errors.push(`${l.id}: indices 長が 3 の倍数でない`);
  if (m.indices.length / 3 !== m.triangleCount) errors.push(`${l.id}: triangleCount 不整合 (${m.triangleCount} vs ${m.indices.length / 3})`);
  const nv = m.positions.length / 3;
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
    if (![x, y, z].every(Number.isFinite)) { errors.push(`${l.id}: 非有限座標`); return; }
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  for (const id of m.indices) if (!Number.isInteger(id) || id < 0 || id >= nv) { errors.push(`${l.id}: index が範囲外 (${id} / ${nv})`); break; }
  // real-world scale
  if (Math.abs(minY) > 0.5) errors.push(`${l.id}: model の底が y=0 でない (minY=${minY.toFixed(1)})`);
  if (typeof l.osmHeight === 'number') {
    const r = maxY / l.osmHeight;
    if (r < 0.9 || r > 1.15) errors.push(`${l.id}: model 高さ ${maxY.toFixed(1)}m が osmHeight ${l.osmHeight}m から乖離（比 ${r.toFixed(2)}）＝見栄え目的の拡大の疑い`);
  }
  if (l.footprintBbox) {
    const mw = maxX - minX, md = maxZ - minZ;
    const fw = Math.max(l.footprintBbox.w, l.footprintBbox.h), fmodel = Math.max(mw, md);
    if (fmodel > fw * 1.25) errors.push(`${l.id}: model footprint ${fmodel.toFixed(0)}m が OSM footprint ${fw}m を大きく超える（拡大の疑い）`);
  }
  // 生成器と一致するか（build 時と同じ結果になる = 決定的）
  const spec = getModelSpec(l);
  if (spec.available && spec.kind === 'procedural') {
    const fresh = buildGeometry(spec);
    if (fresh.triangleCount !== m.triangleCount) errors.push(`${l.id}: 焼き込み triangleCount が再生成と一致しない`);
  }
}

function checkHtml(errors, warns) {
  const raw = fs.readFileSync(DEV_HTML, 'utf-8');
  const html = stripLineComments(raw);
  if (!/const LandmarkLayer = \(function \(\) \{/.test(html)) errors.push('dev HTML に LandmarkLayer IIFE が無い');
  if (!/window\.__LANDMARK_LAYER_DEBUG__ = /.test(html)) errors.push('dev HTML に __LANDMARK_LAYER_DEBUG__ が無い');
  // City Mode bulk-load 禁止: LandmarkLayer は 1 merged mesh（forEach で per-landmark new Mesh していない）
  const iife = html.slice(html.indexOf('const LandmarkLayer = (function'), html.indexOf('LandmarkLayer.init()'));
  const meshCreations = (iife.match(/new THREE\.Mesh\(/g) || []).length;
  if (meshCreations > 1) errors.push(`LandmarkLayer が ${meshCreations} 個の Mesh を生成（merged 1 個のはず）`);
  const matCreations = (iife.match(/new THREE\.\w*Material\(/g) || []).length;
  if (matCreations > 1) errors.push(`LandmarkLayer が ${matCreations} 個の material を生成（1 個のはず）`);
  if (!/GLTFLoader|DRACOLoader/.test(iife) === false) warns.push('GLTFLoader を含む（今回は spec のみのはず。要確認）');
  // duplicate suppression の配線
  if (!/LandmarkLayer\.isSuppressedBuilding\(b\.id\)/.test(html)) errors.push('building builder に suppress の配線が無い');
  // 実高度不変
  const muts = html.match(/\bb\.(dz|z0|h)\s*[*+/-]?=\s*[^=]/g) || [];
  if (muts.length) errors.push(`建物実高度への代入: ${muts.map((s) => s.trim()).join(' | ')}`);
  // regression guards
  if (!/const BUILDING_HEIGHT_STYLE = \(function \(\) \{/.test(html)) errors.push('Mission10 BUILDING_HEIGHT_STYLE が消えた');
  if (!/const LANDMARK_REGISTRY = \(function \(\) \{/.test(html)) errors.push('Mission11 LANDMARK_REGISTRY が消えた');
  if (!/now - pendingSince > 1600 && now - lastRebuildAt > 3000/.test(html)) errors.push('Mission14 station debounce が変わった');
  if (/const LabelEngine = \(function/.test(html)) errors.push('Mission15 LabelEngine が復活している');
  // CityBuildingLOD 構造
  const s = html.indexOf('const CityBuildingLOD = (function');
  const e = html.indexOf('const CityModeManager = (function', s);
  const block = (s >= 0 && e > s) ? html.slice(s, e) : '';
  const mats = block.match(/new THREE\.(Mesh\w*Material|LineBasicMaterial|ShaderMaterial)/g) || [];
  if (mats.length !== 1) errors.push(`CityBuildingLOD の material 生成が ${mats.length} 箇所`);
}

function checkProtected(errors) {
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) continue;
    if (/LandmarkLayer|__LANDMARK_LAYER_DEBUG__|landmark-model-provider/.test(fs.readFileSync(p, 'utf-8'))) {
      errors.push(`${label} HTML に Mission11B の変更が混入`);
    }
  }
}

async function main() {
  const errors = [], warns = [];
  checkHtml(errors, warns);
  checkProtected(errors);

  if (!fs.existsSync(DATA)) {
    errors.push('landmarks.json が無い（node tools/build-landmark-registry.js）');
  } else {
    const doc = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
    const lms = doc.landmarks || [];
    const seedById = new Map(LANDMARK_SEED.map((s) => [s.id, s]));
    const realIds = collectBuildingIds();

    for (const l of lms) {
      const plan = modelPlanFor(l.id);
      if (l.modelType !== plan.modelType) errors.push(`${l.id}: modelType ${l.modelType} が plan ${plan.modelType} と不一致`);
      if ((l.proceduralShape || null) !== (plan.proceduralShape || null)) errors.push(`${l.id}: proceduralShape 不一致`);
      if (!seedById.has(l.id)) errors.push(`${l.id}: seed に存在しない`);
      checkGeometry(l, errors);
      // duplicate suppression
      if (l.model && l.model.kind && l.resolved) {
        if (!l.buildingIds || l.buildingIds.length === 0) errors.push(`${l.id}: 専用モデルあり + resolved なのに buildingIds 空`);
        for (const bid of (l.buildingIds || [])) if (realIds.size && !realIds.has(bid)) errors.push(`${l.id}: buildingId ${bid} が存在しない`);
      }
      // unresolved safe skip
      if (!l.resolved && l.buildingIds && l.buildingIds.length) errors.push(`${l.id}: unresolved なのに buildingIds 残存（suppress 誤爆リスク）`);
    }

    const summary = summarizeModels(lms);
    console.log(`[landmark-models] total=${summary.total} available=${summary.available}（procedural ${summary.proceduralAvailable}）totalTriangles≈${summary.totalTriangles}`);
    for (const r of summary.rows.filter((x) => x.available)) console.log(`  [${r.kind}] ${r.id} ${r.shape || ''} tri≈${r.triangles}`);
    if (summary.totalTriangles > 100000) warns.push(`procedural 合計 ${summary.totalTriangles} tri（budget 100k を超過）`);
  }

  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    data: toProjectRelativePath(DATA),
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[landmark-models] 失敗:', e && e.stack || e); process.exitCode = 1; });
