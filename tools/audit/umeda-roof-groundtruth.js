#!/usr/bin/env node
// tools/audit/umeda-roof-groundtruth.js
// [Mission 35A §7/§10/§11/§12] 梅田の実 PLATEAU LOD2 から「本当の屋根タイプ」を取り出し、
//   推定ロジックの教師・検証データにする。
//   **実 LOD2 の geometry を推定側へコピーしない**（§10）。ここで作るのは
//   「この canonicalId の屋根はこの型」というラベルと形状指標だけ。
//
//   屋根タイプ（§7）:
//     FLAT / FLAT_WITH_PENTHOUSE / MULTI_LEVEL_FLAT / GABLE / HIP / SHED / COMPLEX / UNKNOWN
//
//   実行: node tools/audit/umeda-roof-groundtruth.js
//   出力: data/reports/umeda-roof-groundtruth.json
//         data/processed/osaka-city/umeda-roof/groundtruth.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { UMEDA, ringCentroid, ringArea } from './umeda-roof-evidence.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const GT = {
  highDir: P('data', 'processed', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high'),
  canonDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  out: P('data', 'reports', 'umeda-roof-groundtruth.json'),
  index: P('data', 'processed', 'osaka-city', 'umeda-roof', 'groundtruth.json'),
};
export const ROOF_TYPES = ['FLAT', 'FLAT_WITH_PENTHOUSE', 'MULTI_LEVEL_FLAT', 'GABLE', 'HIP', 'SHED', 'COMPLEX', 'UNKNOWN'];
// 判定のしきい値。実 LOD2 の三角形から「面の向き」と「高さの段」を測って型を決める。
export const CLASSIFY = {
  flatCosMin: 0.985,        // 法線がほぼ真上（傾き 10° 未満）なら水平面
  slopeMinDeg: 12,          // これ以上傾いていれば「勾配屋根」の面
  slopeMaxDeg: 70,          // これ以上は壁扱い（屋根面として数えない）
  levelBinM: 1.0,           // 段を数える高さの刻み
  levelShare: 0.06,         // 全屋根面積の 6% 以上を占める段だけ「段」と数える
  penthouseMaxAreaShare: 0.35,  // 上段が全体の 35% 以下 → 塔屋
  penthouseMinRiseM: 1.5,       // 上段が 1.5m 以上高い
  multiLevelMinShare: 0.15,     // 上段が 15% 以上 → 多段フラット
  slopedAreaShare: 0.25,        // 勾配面が屋根面積の 25% 以上 → 勾配屋根として扱う
  ridgeParallelCosMin: 0.80,    // 主要 2 面の向きが反対なら切妻
  complexPlaneCount: 6,         // 向きの異なる面が多すぎれば COMPLEX
};
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const inUmeda = (x, z) => Math.hypot(x - UMEDA.x, z - UMEDA.z) <= UMEDA.radiusM;

/** 三角形の法線と面積（world 座標 y-up）。 */
export function triNormalArea(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 1e-9)) return null;
  return { n: [nx / len, ny / len, nz / len], area: len / 2 };
}

/**
 * 実 LOD2 の roof part（三角形列）から屋根タイプを判定する。
 * @param {{positions:number[], indices:number[]}} roofPart
 * @param {number} footprintAreaM2
 */
export function classifyRoof(roofPart, footprintAreaM2) {
  if (!roofPart || !roofPart.positions || !roofPart.indices || roofPart.indices.length < 3) {
    return { type: 'UNKNOWN', reason: 'no-roof-geometry' };
  }
  const pos = roofPart.positions, idx = roofPart.indices;
  const tris = [];
  let flatArea = 0, slopedArea = 0, totalArea = 0;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = [pos[idx[i] * 3], pos[idx[i] * 3 + 1], pos[idx[i] * 3 + 2]];
    const b = [pos[idx[i + 1] * 3], pos[idx[i + 1] * 3 + 1], pos[idx[i + 1] * 3 + 2]];
    const c = [pos[idx[i + 2] * 3], pos[idx[i + 2] * 3 + 1], pos[idx[i + 2] * 3 + 2]];
    const t = triNormalArea(a, b, c);
    if (!t) continue;
    const up = Math.abs(t.n[1]);
    const tiltDeg = Math.acos(Math.min(1, up)) * 180 / Math.PI;
    if (tiltDeg > CLASSIFY.slopeMaxDeg) continue;          // 壁に近い面は屋根として数えない
    const y = (a[1] + b[1] + c[1]) / 3;
    // 水平投影面積（屋根の「広さ」は真上から見た面積で比べる）
    const planArea = t.area * up;
    tris.push({ y, planArea, tiltDeg, dir: Math.atan2(t.n[0], t.n[2]) });
    totalArea += planArea;
    if (up >= CLASSIFY.flatCosMin) flatArea += planArea; else if (tiltDeg >= CLASSIFY.slopeMinDeg) slopedArea += planArea;
  }
  if (!tris.length || totalArea <= 0) return { type: 'UNKNOWN', reason: 'no-usable-roof-triangles' };

  // 高さの段（水平面だけで数える）
  const bins = new Map();
  for (const t of tris) {
    if (t.tiltDeg > 20) continue;
    const k = Math.round(t.y / CLASSIFY.levelBinM);
    bins.set(k, (bins.get(k) || 0) + t.planArea);
  }
  const levels = [...bins.entries()].filter(([, a]) => a >= totalArea * CLASSIFY.levelShare)
    .map(([k, a]) => ({ y: k * CLASSIFY.levelBinM, area: a })).sort((p, q) => p.y - q.y);
  const slopedShare = slopedArea / totalArea;
  const metrics = { totalPlanAreaM2: +totalArea.toFixed(1), flatShare: +(flatArea / totalArea).toFixed(3),
    slopedShare: +slopedShare.toFixed(3), levelCount: levels.length,
    levels: levels.map((l) => ({ y: +l.y.toFixed(1), areaShare: +(l.area / totalArea).toFixed(3) })),
    roofSpreadM: +(Math.max(...tris.map((t) => t.y)) - Math.min(...tris.map((t) => t.y))).toFixed(2),
    footprintAreaM2: footprintAreaM2 != null ? +footprintAreaM2.toFixed(1) : null };

  // 勾配屋根か
  if (slopedShare >= CLASSIFY.slopedAreaShare) {
    // 勾配面を向きで束ねる
    const dirBins = new Map();
    for (const t of tris) {
      if (t.tiltDeg < CLASSIFY.slopeMinDeg) continue;
      const k = Math.round(t.dir / (Math.PI / 8));    // 22.5° 刻み
      dirBins.set(k, (dirBins.get(k) || 0) + t.planArea);
    }
    const dirs = [...dirBins.entries()].sort((a, b) => b[1] - a[1]);
    const distinct = dirs.filter(([, a]) => a >= slopedArea * 0.1).length;
    metrics.slopeDirections = distinct;
    if (distinct >= CLASSIFY.complexPlaneCount) return { type: 'COMPLEX', reason: 'many-slope-directions', metrics };
    if (distinct === 1) return { type: 'SHED', reason: 'single-slope', metrics, ridgeDeg: null };
    if (distinct === 2) {
      const d0 = dirs[0][0] * (Math.PI / 8), d1 = dirs[1][0] * (Math.PI / 8);
      const opposite = Math.abs(Math.cos(d0 - d1));    // 反対向き = cos ≈ -1
      metrics.dirOpposition = +opposite.toFixed(3);
      // 棟は 2 面の傾斜方向に直交する
      const ridge = ((d0 + Math.PI / 2) * 180 / Math.PI + 360) % 180;
      if (Math.cos(d0 - d1) <= -CLASSIFY.ridgeParallelCosMin) return { type: 'GABLE', reason: 'two-opposite-slopes', metrics, ridgeDeg: +ridge.toFixed(1) };
      return { type: 'COMPLEX', reason: 'two-non-opposite-slopes', metrics, ridgeDeg: +ridge.toFixed(1) };
    }
    if (distinct >= 3 && distinct <= 5) {
      const d0 = dirs[0][0] * (Math.PI / 8);
      const ridge = ((d0 + Math.PI / 2) * 180 / Math.PI + 360) % 180;
      return { type: 'HIP', reason: 'three-or-more-slopes', metrics, ridgeDeg: +ridge.toFixed(1) };
    }
  }
  // 平らな屋根
  if (levels.length <= 1) return { type: 'FLAT', reason: 'single-level', metrics };
  const top = levels[levels.length - 1], base = levels[0];
  const topShare = top.area / totalArea;
  const rise = top.y - base.y;
  if (topShare <= CLASSIFY.penthouseMaxAreaShare && rise >= CLASSIFY.penthouseMinRiseM) {
    return { type: 'FLAT_WITH_PENTHOUSE', reason: 'small-high-block', metrics, penthouseRiseM: +rise.toFixed(2), penthouseShare: +topShare.toFixed(3) };
  }
  if (topShare >= CLASSIFY.multiLevelMinShare) return { type: 'MULTI_LEVEL_FLAT', reason: 'multiple-large-levels', metrics };
  return { type: 'FLAT_WITH_PENTHOUSE', reason: 'small-upper-level', metrics, penthouseRiseM: +rise.toFixed(2), penthouseShare: +topShare.toFixed(3) };
}

/** §11 建物タイプ・高さ・footprint 形状をなるべく均等にして train/validation へ分ける。 */
export function stratifiedSplit(records, validationShare = 0.3, seed = 20260923) {
  const key = (r) => {
    const h = r.heightM == null ? 'h?' : (r.heightM < 10 ? 'h1' : r.heightM < 20 ? 'h2' : r.heightM < 45 ? 'h3' : 'h4');
    const a = r.footprintAreaM2 == null ? 'a?' : (r.footprintAreaM2 < 100 ? 'a1' : r.footprintAreaM2 < 400 ? 'a2' : r.footprintAreaM2 < 1500 ? 'a3' : 'a4');
    return r.roofType + '|' + h + '|' + a;
  };
  const groups = new Map();
  for (const r of records) { const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  // 決定的な擬似乱数（seed 固定。再実行で同じ分割になる）
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const train = [], validation = [];
  for (const [, arr] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const shuffled = arr.slice();
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const nVal = Math.max(arr.length >= 2 ? 1 : 0, Math.round(arr.length * validationShare));
    for (let i = 0; i < shuffled.length; i++) (i < nVal ? validation : train).push(shuffled[i]);
  }
  return { train, validation, groups: groups.size };
}

export function run() {
  // canonical の footprint（面積と高さ）
  const canon = new Map();
  const TILE = 500;
  const t0x = Math.floor((UMEDA.x - UMEDA.radiusM) / TILE), t1x = Math.floor((UMEDA.x + UMEDA.radiusM) / TILE);
  const t0z = Math.floor((UMEDA.z - UMEDA.radiusM) / TILE), t1z = Math.floor((UMEDA.z + UMEDA.radiusM) / TILE);
  for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
    const doc = rj(path.join(GT.canonDir, `tile_${tx}_${tz}.json`));
    const attrs = (rj(path.join(GT.canonDir, 'attributes', `tile_${tx}_${tz}.json`)) || {}).attributes || {};
    for (const ft of ((doc && doc.features) || [])) {
      const a = attrs[ft.canonicalId] || {};
      canon.set(ft.canonicalId, { areaM2: ft.areaM2, heightM: a.heightM ?? null, heightUnknown: !!a.heightUnknown,
        usageCategory: a.usageCategory ?? null, ring: ft.coordinates && ft.coordinates[0], centroid: ft.centroid });
    }
  }

  const records = [];
  const skipped = { notInUmeda: 0, noRoofPart: 0 };
  for (const f of fs.readdirSync(GT.highDir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    for (const b of ((rj(path.join(GT.highDir, f)) || {}).buildings || [])) {
      const c = b.centroid || [0, 0];
      if (!inUmeda(c[0], c[1])) { skipped.notInUmeda++; continue; }
      const roofPart = (b.parts || []).find((p) => p.kind === 'roof');
      if (!roofPart) { skipped.noRoofPart++; continue; }
      const cn = canon.get(b.canonicalId) || {};
      const cls = classifyRoof(roofPart, cn.areaM2);
      records.push({ canonicalId: b.canonicalId, lod: b.lod, tier: b.tier || null,
        roofType: cls.type, classifyReason: cls.reason, ridgeDeg: cls.ridgeDeg ?? null,
        metrics: cls.metrics || null,
        heightM: b.heightM ?? cn.heightM ?? null, footprintAreaM2: cn.areaM2 ?? null,
        usageCategory: cn.usageCategory ?? null, roofLevels: b.roofLevels ?? null,
        centroid: [+c[0].toFixed(2), +c[1].toFixed(2)] });
    }
  }
  const byType = records.reduce((a, r) => { a[r.roofType] = (a[r.roofType] || 0) + 1; return a; }, {});
  const split = stratifiedSplit(records);

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35A',
    area: UMEDA, classifyThresholds: CLASSIFY,
    groundTruthCount: records.length, skipped, byRoofType: byType,
    split: { train: split.train.length, validation: split.validation.length, strata: split.groups,
      validationShare: +(split.validation.length / Math.max(1, records.length)).toFixed(3) },
    byTypeTrain: split.train.reduce((a, r) => { a[r.roofType] = (a[r.roofType] || 0) + 1; return a; }, {}),
    byTypeValidation: split.validation.reduce((a, r) => { a[r.roofType] = (a[r.roofType] || 0) + 1; return a; }, {}),
    note: '実 LOD2 の geometry は推定側へコピーしない。ここで作るのは型ラベルと形状指標だけ（§10）。',
  };
  fs.mkdirSync(path.dirname(GT.out), { recursive: true });
  fs.writeFileSync(GT.out, JSON.stringify(out, null, 2));
  fs.mkdirSync(path.dirname(GT.index), { recursive: true });
  fs.writeFileSync(GT.index, JSON.stringify({ version: 1, generatedAt: out.generatedAt,
    records, trainIds: split.train.map((r) => r.canonicalId), validationIds: split.validation.map((r) => r.canonicalId) }));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[gt] 梅田の実 LOD2', o.groundTruthCount, JSON.stringify(o.skipped));
  console.log('[gt] 屋根タイプ', JSON.stringify(o.byRoofType));
  console.log('[gt] split', JSON.stringify(o.split));
  console.log('[gt] out', GT.out);
}
