#!/usr/bin/env node
// tools/audit/umeda-roof-evaluate.js
// [Mission 35A §10/§11/§12/§13] 梅田の実 LOD2 678 棟を ground truth にして、
//   「LOD1 + 手元の証拠」から屋根タイプをどれだけ当てられるかを測る。
//   **実 LOD2 の geometry は推定側へ渡さない**（§10）。渡すのは footprint と属性と OSM タグだけ。
//   出力: data/reports/umeda-roof-evaluation.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { UMEDA, ringCentroid, ringArea } from './umeda-roof-evidence.js';
import { inferRoof, evaluate, QUALITY, meetsQuality, footprintShape } from '../lib/umeda-roof-inference.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const EVAL = {
  gt: P('data', 'processed', 'osaka-city', 'umeda-roof', 'groundtruth.json'),
  osmRoof: P('data', 'processed', 'osaka-city', 'umeda-roof', 'osm-roof-tags.json'),
  canonDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  out: P('data', 'reports', 'umeda-roof-evaluation.json'),
};
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** 2 つの ring の重なり（サンプリングで IoU を近似）。 */
export function ringIoU(a, b, step = 1.0) {
  if (!a || !b || a.length < 3 || b.length < 3) return 0;
  const bb = (r) => { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of r) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
    return { x0, x1, z0, z1 }; };
  const A = bb(a), B = bb(b);
  const x0 = Math.min(A.x0, B.x0), x1 = Math.max(A.x1, B.x1);
  const z0 = Math.min(A.z0, B.z0), z1 = Math.max(A.z1, B.z1);
  if (!(x1 > x0 && z1 > z0)) return 0;
  const s = Math.max(step, Math.max(x1 - x0, z1 - z0) / 120);
  const inside = (x, z, r) => {
    let ins = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) ins = !ins;
    }
    return ins;
  };
  let inter = 0, uni = 0;
  for (let x = x0 + s / 2; x < x1; x += s) for (let z = z0 + s / 2; z < z1; z += s) {
    const ia = inside(x, z, a), ib = inside(x, z, b);
    if (ia && ib) inter++;
    if (ia || ib) uni++;
  }
  return uni ? inter / uni : 0;
}

/** OSM の屋根タグ付き建物を canonical 建物へ結び付ける（footprint IoU が最大のもの）。 */
export function matchOsmRoof(canonRing, osmBuildings, cellIndex, CELL = 40) {
  const c = ringCentroid(canonRing);
  const cx = Math.floor(c[0] / CELL), cz = Math.floor(c[1] / CELL);
  let best = null, bestIoU = 0;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const idx of (cellIndex.get((cx + i) + ',' + (cz + j)) || [])) {
      const o = osmBuildings[idx];
      const iou = ringIoU(canonRing, o.ring);
      if (iou > bestIoU) { bestIoU = iou; best = o; }
    }
  }
  if (!best || bestIoU <= 0.05) return null;
  return { shape: best.roof['roof:shape'] || null, orientation: best.roof['roof:orientation'] || null,
    levels: best.roof['roof:levels'] != null ? Number(best.roof['roof:levels']) : null,
    height: best.roof['roof:height'] != null ? Number(best.roof['roof:height']) : null,
    matchIoU: +bestIoU.toFixed(3), wayId: best.wayId, name: best.name || null };
}

export function buildOsmIndex(osmBuildings, CELL = 40) {
  const idx = new Map();
  osmBuildings.forEach((o, i) => {
    const c = o.centroid;
    const k = Math.floor(c[0] / CELL) + ',' + Math.floor(c[1] / CELL);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(i);
  });
  return idx;
}

export function run() {
  const gt = rj(EVAL.gt);
  if (!gt) throw new Error('先に tools/audit/umeda-roof-groundtruth.js を実行する');
  const osm = rj(EVAL.osmRoof);
  if (!osm) throw new Error('先に tools/audit/umeda-roof-evidence.js を実行する');

  // canonical の footprint（ground truth 側の建物にも必要）
  const canon = new Map();
  const TILE = 500;
  const t0x = Math.floor((UMEDA.x - UMEDA.radiusM) / TILE), t1x = Math.floor((UMEDA.x + UMEDA.radiusM) / TILE);
  const t0z = Math.floor((UMEDA.z - UMEDA.radiusM) / TILE), t1z = Math.floor((UMEDA.z + UMEDA.radiusM) / TILE);
  for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
    const doc = rj(path.join(EVAL.canonDir, `tile_${tx}_${tz}.json`));
    const attrs = (rj(path.join(EVAL.canonDir, 'attributes', `tile_${tx}_${tz}.json`)) || {}).attributes || {};
    for (const ft of ((doc && doc.features) || [])) {
      const a = attrs[ft.canonicalId] || {};
      canon.set(ft.canonicalId, { ring: ft.coordinates && ft.coordinates[0], areaM2: ft.areaM2,
        heightM: a.heightM ?? null, heightUnknown: !!a.heightUnknown, usageCategory: a.usageCategory ?? null });
    }
  }
  const osmIdx = buildOsmIndex(osm.buildings);
  const valIds = new Set(gt.validationIds);

  // ── 評価 ────────────────────────────────────────────────────────────
  const rows = [];
  for (const r of gt.records) {
    const cn = canon.get(r.canonicalId);
    if (!cn || !cn.ring) continue;
    // §10 実 LOD2 の geometry は渡さない。渡すのは LOD1 footprint と属性だけ。
    const ev = { osmRoof: matchOsmRoof(cn.ring, osm.buildings, osmIdx) };
    const inf = inferRoof({ canonicalId: r.canonicalId, ring: cn.ring, areaM2: cn.areaM2,
      heightM: cn.heightM, heightUnknown: cn.heightUnknown, usageCategory: cn.usageCategory }, ev);
    rows.push({ canonicalId: r.canonicalId, split: valIds.has(r.canonicalId) ? 'validation' : 'train',
      truth: r.roofType, truthRidgeDeg: r.ridgeDeg ?? null,
      predicted: inf.roofType, predictedRidgeDeg: inf.ridgeDeg ?? null,
      confidence: inf.confidence, evidence: inf.evidence, reason: inf.reason,
      osmShape: inf.osmShape || null, osmMatchIoU: ev.osmRoof ? ev.osmRoof.matchIoU : null });
  }
  const val = rows.filter((r) => r.split === 'validation');
  const train = rows.filter((r) => r.split === 'train');
  const evalAll = evaluate(rows);
  const evalVal = evaluate(val);
  const evalTrain = evaluate(train);
  // HIGH 信頼度だけに絞った場合
  const evalHigh = evaluate(rows.filter((r) => r.confidence === 'HIGH'));

  const evidenceCounts = rows.reduce((a, r) => { a[r.evidence] = (a[r.evidence] || 0) + 1; return a; }, {});
  const confCounts = rows.reduce((a, r) => { a[r.confidence] = (a[r.confidence] || 0) + 1; return a; }, {});

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35A',
    area: UMEDA, groundTruth: gt.groundTruthCount, byRoofType: gt.byRoofType,
    split: gt.split,
    quality: QUALITY,
    evidenceCounts, confidenceCounts: confCounts,
    evaluation: { all: evalAll, train: evalTrain, validation: evalVal, highConfidenceOnly: evalHigh },
    meetsQuality: { validation: meetsQuality(evalVal), highConfidenceOnly: meetsQuality(evalHigh) },
    // 屋根タイプの内訳（何が支配的か）
    truthDistribution: rows.reduce((a, r) => { a[r.truth] = (a[r.truth] || 0) + 1; return a; }, {}),
    note: '実 LOD2 の geometry は推定へ渡していない（§10）。渡したのは LOD1 footprint・高さ・用途・OSM の屋根タグのみ。',
    samples: rows.filter((r) => r.evidence === 'osm-roof-shape').slice(0, 40),
  };
  fs.mkdirSync(path.dirname(EVAL.out), { recursive: true });
  fs.writeFileSync(EVAL.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[eval] ground truth', o.groundTruth, JSON.stringify(o.byRoofType));
  console.log('[eval] 証拠の内訳', JSON.stringify(o.evidenceCounts));
  console.log('[eval] 信頼度', JSON.stringify(o.confidenceCounts));
  console.log('[eval] validation', JSON.stringify({ n: o.evaluation.validation.n, judged: o.evaluation.validation.n - o.evaluation.validation.unknown,
    exact: o.evaluation.validation.exactAccuracy, family: o.evaluation.validation.familyAccuracy, coverage: o.evaluation.validation.coverage }));
  console.log('[eval] HIGH のみ', JSON.stringify({ n: o.evaluation.highConfidenceOnly.n, exact: o.evaluation.highConfidenceOnly.exactAccuracy,
    ridge: o.evaluation.highConfidenceOnly.ridgeErrorDeg }));
  console.log('[eval] 品質基準を満たすか', JSON.stringify(o.meetsQuality));
  console.log('[eval] out', EVAL.out);
}
