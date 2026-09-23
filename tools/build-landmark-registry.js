#!/usr/bin/env node
// tools/build-landmark-registry.js
// [見た目改善 Mission11] LANDMARK_SEED を 24区 building dataset へ厳密照合し、配信用レジストリを生成。
// ══════════════════════════════════════════════════════════════════════════════════
// ネットワーク不要。入力:
//   public/map-data/osaka-city/buildings/<ward>/tile_*.json（footprint 照合先）
//   tools/lib/landmark-registry.js（検証済みシード）
//
// 出力:
//   public/map-data/osaka-city/landmarks/landmarks.json   （HTML が fetch）
//   data/processed/osaka-city/landmarks/landmarks.json     （確認用・同内容）
//   data/reports/landmark-registry-build.json              （生成レポート）
//
// 照合は resolveLandmarkBuildings()（内包 + 高さ一致、または 30m 内の一意な高さ一致棟のみ）。
// 距離だけの nearest 割当はしない。確定できないものは resolved:false で出荷する。
//
// 実行:  node tools/build-landmark-registry.js [--check]
// ══════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import {
  LANDMARK_SEED, resolveLandmarkBuildings, validateSeed, findDuplicateIds,
  SUSPICIOUS_HEIGHT_M, LANDMARK_STYLE, LANDMARK_SHADE_CEIL, ringBboxXZ, modelPlanFor,
} from './lib/landmark-registry.js';
import { getModelSpec, buildGeometry } from './lib/landmark-model-provider.js';

const BUILDINGS_ROOT = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'buildings'));
const OUT_PUBLIC = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'));
const OUT_PROCESSED = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'landmarks', 'landmarks.json'));
const OUT_REPORT = resolveProjectPath(path.join('data', 'reports', 'landmark-registry-build.json'));

// ward id（seed）→ dataset id
const dsIdOf = (wardId) => `osaka-${wardId}`;

function loadWardBuildings(wardId) {
  const dir = path.join(BUILDINGS_ROOT, dsIdOf(wardId));
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const tile = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    for (const b of (tile.buildings || [])) out.push(b);
  }
  return out;
}

export function buildLandmarkRegistry({ buildingsByWard }) {
  const seedCheck = validateSeed(LANDMARK_SEED);
  const landmarks = [];
  let suspiciousSkipped = 0;

  for (const s of LANDMARK_SEED) {
    const wardBs = buildingsByWard[s.ward] || [];
    // anchor 周辺 250m の候補だけ渡す（照合は厳密なので広めでよい）
    const near = wardBs.filter((b) => {
      if (!b.fp || b.fp.length < 3) return false;
      const bb = ringBboxXZ(b.fp);
      const cx = (bb.minX + bb.maxX) / 2, cz = (bb.minZ + bb.maxZ) / 2;
      return Math.hypot(cx - s.anchorX, cz - s.anchorZ) < 250;
    });
    const res = resolveLandmarkBuildings(s, near);
    if (res.reason && /suspicious/i.test(res.reason)) suspiciousSkipped++;

    const plan = modelPlanFor(s.id);
    const entry = {
      id: s.id, name: s.name, nameEn: s.nameEn || null,
      category: s.category, importance: s.importance, ward: s.ward,
      source: { osm: s.osm },
      x: s.anchorX, z: s.anchorZ,
      osmHeight: s.height,
      footprintBbox: s.footprintBbox || null,
      resolved: res.resolved,
      resolveMethod: res.method || null,
      unresolvedReason: res.resolved ? null : (res.reason || null),
      buildingIds: res.buildingIds,
      matchedHeights: res.matchedHeights || null,
      // [Mission11B] 3D モデル経路
      modelType: plan.modelType,
      proceduralShape: plan.proceduralShape,
      modelUrl: plan.modelUrl,
      heightSource: plan.heightSource,
    };
    // LandmarkModelProvider でモデル仕様を評価。procedural なら geometry を焼き込む
    //   （HTML は new THREE.BufferGeometry() へ載せるだけ。HTML に生成コードを持たせない）。
    const spec = getModelSpec(entry);
    entry.modelAvailable = spec.available;
    entry.modelKind = spec.available ? spec.kind : null;
    entry.modelUnavailableReason = spec.available ? null : spec.reason;
    entry.modelEstimate = spec.available ? spec.estimate : null;
    if (spec.available && spec.kind === 'procedural') {
      const geo = buildGeometry(spec);
      // 実世界スケール尊重: geometry は「中心 XZ 原点 / y は地面 0 から height」。倍率は掛けない。
      entry.model = {
        kind: 'procedural', shape: spec.shape,
        positions: geo.positions.map((v) => Math.round(v * 100) / 100),
        indices: geo.indices,
        triangleCount: geo.triangleCount,
        bbox: { w: +geo.bbox.w.toFixed(2), d: +geo.bbox.d.toFixed(2), h: +geo.bbox.h.toFixed(2) },
      };
    } else if (spec.available && spec.kind === 'gltf') {
      entry.model = { kind: 'gltf', url: spec.url, triangleCount: null };
    } else {
      entry.model = null;
    }
    landmarks.push(entry);
  }

  const resolved = landmarks.filter((l) => l.resolved);
  const withModel = landmarks.filter((l) => l.modelAvailable);
  const byImp = (imp) => landmarks.filter((l) => l.importance === imp).length;

  return {
    payload: {
      version: 1,
      coordinateConvention: 'znorth-neg-v1',
      generatedAt: new Date().toISOString(),
      method: 'LANDMARK_SEED（OSM 検証済み） × 24区 building footprint 厳密照合（内包+高さ一致 / 30m内の一意な高さ一致棟）。距離のみの nearest 割当なし。',
      suspiciousHeightThresholdM: SUSPICIOUS_HEIGHT_M,
      style: { landmark: LANDMARK_STYLE, shadeCeil: LANDMARK_SHADE_CEIL },
      counts: {
        total: landmarks.length,
        resolved: resolved.length,
        unresolved: landmarks.length - resolved.length,
        major: byImp('MAJOR'), regional: byImp('REGIONAL'), local: byImp('LOCAL'),
        resolvedBuildingIds: resolved.reduce((n, l) => n + l.buildingIds.length, 0),
        withModel: withModel.length,
        modelTriangles: withModel.reduce((n, l) => n + (l.modelEstimate ? l.modelEstimate.triangles : 0), 0),
      },
      landmarks,
    },
    report: {
      generatedAt: new Date().toISOString(),
      seedValidation: seedCheck,
      duplicateIds: findDuplicateIds(LANDMARK_SEED),
      suspiciousSkipped,
      resolvedList: resolved.map((l) => ({ id: l.id, name: l.name, method: l.resolveMethod, buildingIds: l.buildingIds, matchedHeights: l.matchedHeights, osmHeight: l.osmHeight })),
      unresolvedList: landmarks.filter((l) => !l.resolved).map((l) => ({ id: l.id, name: l.name, reason: l.unresolvedReason })),
      modelList: landmarks.map((l) => ({ id: l.id, modelType: l.modelType, shape: l.proceduralShape, available: l.modelAvailable, reason: l.modelUnavailableReason, estimate: l.modelEstimate, heightSource: l.heightSource })),
      RESULT: seedCheck.ok ? 'PASS' : 'FAIL',
    },
  };
}

async function main() {
  const check = process.argv.includes('--check');
  if (!fs.existsSync(BUILDINGS_ROOT)) {
    console.error(`[stop] building datasets が見つかりません: ${toProjectRelativePath(BUILDINGS_ROOT)}`);
    process.exit(1);
  }
  const wards = [...new Set(LANDMARK_SEED.map((s) => s.ward))];
  const buildingsByWard = {};
  for (const w of wards) buildingsByWard[w] = loadWardBuildings(w);
  console.log(`[landmark-registry] seed=${LANDMARK_SEED.length} / 対象区=${wards.length}（${wards.join(',')}）`);

  const { payload, report } = buildLandmarkRegistry({ buildingsByWard });
  const c = payload.counts;
  console.log(`[landmark-registry] resolved=${c.resolved}/${c.total}（buildingIds ${c.resolvedBuildingIds}件）/ unresolved=${c.unresolved}`);
  console.log(`  importance: MAJOR=${c.major} REGIONAL=${c.regional} LOCAL=${c.local}`);
  console.log('  -- resolved --');
  for (const r of report.resolvedList) console.log(`   [${r.method}] ${r.id.padEnd(32)} ${JSON.stringify(r.buildingIds)} dz=${JSON.stringify(r.matchedHeights)} (osm ${r.osmHeight ?? '?'})`);
  console.log('  -- unresolved --');
  for (const u of report.unresolvedList) console.log(`   ${u.id.padEnd(32)} ${u.reason}`);
  console.log(`  -- 3D models: withModel=${c.withModel} / modelTriangles≈${c.modelTriangles} --`);
  for (const m of report.modelList) {
    console.log(`   ${m.id.padEnd(32)} ${String(m.modelType).padEnd(11)} shape=${String(m.shape || '-').padEnd(16)} ${m.available ? 'AVAILABLE tri≈' + m.estimate.triangles : 'skip: ' + m.reason}`);
  }
  if (!report.seedValidation.ok) { console.error('  seed validation errors:'); for (const e of report.seedValidation.errors) console.error('   [ERROR] ' + e); }
  console.log('  RESULT:', report.RESULT);

  await writeJson(OUT_REPORT, report);
  if (check) { console.log('[landmark-registry] --check: ファイルは書き込みません'); process.exit(report.seedValidation.ok ? 0 : 1); }
  await writeJson(OUT_PUBLIC, payload);
  await writeJson(OUT_PROCESSED, payload);
  console.log(`[landmark-registry] 書込: ${toProjectRelativePath(OUT_PUBLIC)}`);
  console.log(`[landmark-registry]       ${toProjectRelativePath(OUT_REPORT)}`);
  if (!report.seedValidation.ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error('生成に失敗:', e && e.stack || e); process.exit(1); });
}
