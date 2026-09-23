#!/usr/bin/env node
// tools/build-umeda-inferred-roof.js
// [Mission 35A §14/§15/§16/§17/§18/§19/§20/§21/§22/§30] 梅田の LOD1 建物に、
//   **証拠がある場合だけ** LOD2 相当の屋根を作る。
//
//   絶対条件:
//     - footprint を動かさない / 外へ膨らませない（§14）
//     - 全高を変えない（壁 + 屋根 = 信頼できる高さ。§15）
//     - canonicalId を変えない
//     - 実 PLATEAU LOD2/LOD3 とは別の namespace に出す（§1）
//     - FLAT は LOD1 の上面のまま（geometry を作らない。§16）
//
//   実行: node --max-old-space-size=8192 tools/build-umeda-inferred-roof.js
//   出力: data/processed/osaka-city/derived-umeda-inferred-roof/
//         public/map-data/osaka-city/derived-umeda-inferred-roof/
//         data/reports/umeda-inferred-roof-build.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { LIVECITY_COORDINATE_SYSTEM_ID } from './lib/livecity-coordinate-system.js';
import { writeFilesVerified } from './lib/synced-dir-writer.js';
import { UMEDA, loadUmedaTargets } from './audit/umeda-roof-evidence.js';
import { inferRoof, footprintShape, NO_EVIDENCE } from './lib/umeda-roof-inference.js';
import { matchOsmRoof, buildOsmIndex } from './audit/umeda-roof-evaluate.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const IR = {
  osmRoof: P('data', 'processed', 'osaka-city', 'umeda-roof', 'osm-roof-tags.json'),
  outProcessed: P('data', 'processed', 'osaka-city', 'derived-umeda-inferred-roof'),
  outPublic: P('public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof'),
  report: P('data', 'reports', 'umeda-inferred-roof-build.json'),
};
export const GENERATION_VERSION = '35A.1';
export const ROOF_SOURCE = 'OSM-roof-tags';
// §30 自動 reject の基準
export const GUARD = {
  maxRoofHeightShare: 0.35,   // 屋根が全高の 35% を超えたら作らない
  minRoofHeightM: 0.8,        // これ未満なら作る意味が無い
  maxRoofHeightM: 12,         // 極端な屋根は作らない
  maxSlopeDeg: 60,            // 急すぎる勾配は reject
  minSlopeDeg: 8,
  footprintEpsM: 0.01,        // footprint の外へ 1cm でも出たら reject
  minHeightM: 2,              // 建物が低すぎると屋根を切れない
};
// §16 FLAT は LOD1 の上面のまま。geometry を作らない。
export const NO_GEOMETRY_TYPES = new Set(['FLAT', 'UNKNOWN']);
// §17/§20 塔屋・多段は航空写真が要る。OSM タグだけでは作らない。
export const NEEDS_IMAGERY_TYPES = new Set(['FLAT_WITH_PENTHOUSE', 'MULTI_LEVEL_FLAT']);
// §21 複雑は自動生成しない
export const MANUAL_TYPES = new Set(['COMPLEX']);

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const r2 = (v) => Math.round(v * 100) / 100;

/** 点が ring の内側か（境界含む判定は呼び出し側で eps を見る）。 */
export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
/** 点から ring の辺までの最短距離（外側にどれだけ出たかを測る）。 */
export function distToRing(x, z, ring) {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0], az = ring[j][1], bx = ring[i][0], bz = ring[i][1];
    const dx = bx - ax, dz = bz - az;
    const L = dx * dx + dz * dz;
    let t = L > 0 ? ((x - ax) * dx + (z - az) * dz) / L : 0;
    t = Math.max(0, Math.min(1, t));
    d = Math.min(d, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return d;
}

/**
 * §18/§19 切妻・寄棟・片流れの屋根を footprint の内側に作る。
 *   棟は ridgeDeg（証拠から決めた向き）に沿って、footprint の最小外接矩形の中心線に置く。
 *   屋根の高さは全高の一部を使い、**壁を低くして全高を保つ**（§15）。
 * @returns {{ok:boolean, reason?:string, positions?:number[], indices?:number[], wallTopY?:number, ridgeY?:number}}
 */
export function buildSlopedRoof(ring, totalHeightM, roofType, ridgeDeg) {
  if (!ring || ring.length < 3) return { ok: false, reason: 'bad-footprint' };
  if (!(totalHeightM >= GUARD.minHeightM)) return { ok: false, reason: 'building-too-low' };
  const sh = footprintShape(ring);
  if (!sh) return { ok: false, reason: 'bad-footprint' };
  // 屋根の高さ: 短辺の半分 × tan(30°) を目安にし、全高の割合と絶対値で抑える
  const target = Math.min(sh.shortM * 0.5 * Math.tan(30 * Math.PI / 180), totalHeightM * GUARD.maxRoofHeightShare, GUARD.maxRoofHeightM);
  const roofH = Math.max(0, target);
  if (roofH < GUARD.minRoofHeightM) return { ok: false, reason: 'roof-too-shallow' };
  const slopeDeg = Math.atan2(roofH, Math.max(0.1, sh.shortM / 2)) * 180 / Math.PI;
  if (slopeDeg < GUARD.minSlopeDeg || slopeDeg > GUARD.maxSlopeDeg) return { ok: false, reason: 'extreme-slope' };
  const wallTopY = totalHeightM - roofH;       // §15 全高は変えない
  if (wallTopY <= 0) return { ok: false, reason: 'negative-wall-height' };

  const th = (ridgeDeg * Math.PI) / 180;
  const ux = Math.cos(th), uz = Math.sin(th);          // 棟方向
  const vx = -uz, vz = ux;                             // 棟に直交
  const c = sh.centroid;
  // footprint を (u,v) へ射影して範囲を取る
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of ring) {
    const dx = p[0] - c[0], dz = p[1] - c[1];
    const u = dx * ux + dz * uz, v = dx * vx + dz * vz;
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const toWorld = (u, v) => [c[0] + u * ux + v * vx, c[1] + u * uz + v * vz];
  const pos = [], idx = [];
  const push = (x, y, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };
  const clampMin = 0.2;   // footprint の縁から最低これだけ内側へ
  // 軒（footprint の頂点を wallTopY に置く）
  const eaves = ring.map((p) => push(p[0], wallTopY, p[1]));
  // 棟（v=0 の線上、u は footprint 範囲の内側へ少し寄せる）
  const inset = roofType === 'HIP' ? Math.min((maxU - minU) * 0.25, sh.shortM * 0.5) : 0;
  let ridgeIdx = [];
  if (roofType === 'SHED') {
    // 片流れ: 片側だけ持ち上げる
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const dv = ((p[0] - c[0]) * vx + (p[1] - c[1]) * vz);
      const t = (dv - minV) / Math.max(1e-6, maxV - minV);   // 0..1
      pos[eaves[i] * 3 + 1] = wallTopY + roofH * t;
    }
    // 上面は footprint そのまま（扇形分割）
    for (let i = 1; i < ring.length - 1; i++) idx.push(eaves[0], eaves[i], eaves[i + 1]);
    return { ok: true, positions: pos, indices: idx, wallTopY: r2(wallTopY), ridgeY: r2(totalHeightM), roofHeightM: r2(roofH), slopeDeg: r2(slopeDeg) };
  }
  // §14 棟の端点は必ず footprint の内側に置く。
  //   OBB の端をそのまま使うと、L 字など凸でない footprint では外へ出る（実測で reject された）。
  //   端から中心へ少しずつ寄せて、内側に入る最初の位置を採る。
  const clampInside = (u) => {
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const uu = u * (1 - t);                       // u=0（中心）へ寄せていく
      const w = toWorld(uu, 0);
      if (pointInRing(w[0], w[1], ring) && distToRing(w[0], w[1], ring) >= 0.2) return { u: uu, w };
    }
    return null;
  };
  const eA = clampInside(minU + inset), eB = clampInside(maxU - inset);
  if (!eA || !eB) return { ok: false, reason: 'ridge-cannot-fit-inside-footprint' };
  if (Math.abs(eB.u - eA.u) < Math.max(1.0, sh.shortM * 0.2)) return { ok: false, reason: 'ridge-too-short' };
  const a = eA.w, b = eB.w;
  ridgeIdx = [push(a[0], totalHeightM, a[1]), push(b[0], totalHeightM, b[1])];
  // 軒を棟の左右へ割り当てて三角形を張る
  for (let i = 0; i < ring.length; i++) {
    const i0 = eaves[i], i1 = eaves[(i + 1) % ring.length];
    const p0 = ring[i], p1 = ring[(i + 1) % ring.length];
    const u0 = (p0[0] - c[0]) * ux + (p0[1] - c[1]) * uz;
    const u1 = (p1[0] - c[0]) * ux + (p1[1] - c[1]) * uz;
    // その辺に近い棟端点を選ぶ
    const pick = (u) => (Math.abs(u - (minU + inset)) <= Math.abs(u - (maxU - inset)) ? ridgeIdx[0] : ridgeIdx[1]);
    const r0 = pick(u0), r1 = pick(u1);
    if (r0 === r1) idx.push(i0, i1, r0);
    else { idx.push(i0, i1, r0); idx.push(i1, r1, r0); }
  }
  return { ok: true, positions: pos, indices: idx, wallTopY: r2(wallTopY), ridgeY: r2(totalHeightM), roofHeightM: r2(roofH), slopeDeg: r2(slopeDeg) };
}

/**
 * [Mission 35A §24] 推定屋根を出す棟は LOD1 の箱を出さないので、**壁も自前で出す**。
 *   壁が無いと屋根だけが宙に浮く（実ブラウザの近接確認で発見）。
 *   壁は canonical の footprint をそのまま 0 → wallTopY まで立ち上げるだけで、
 *   footprint も全高も変えない（§14/§15）。
 * @returns {{positions:number[], indices:number[]}}
 */
export function buildWalls(ring, wallTopY) {
  const pos = [], idx = [];
  if (!ring || ring.length < 3 || !(wallTopY > 0)) return { positions: pos, indices: idx };
  for (let i = 0; i < ring.length; i++) {
    const p0 = ring[i], p1 = ring[(i + 1) % ring.length];
    if (p0[0] === p1[0] && p0[1] === p1[1]) continue;
    const b = pos.length / 3;
    pos.push(p0[0], 0, p0[1], p1[0], 0, p1[1], p1[0], wallTopY, p1[1], p0[0], wallTopY, p0[1]);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return { positions: pos, indices: idx };
}

/** 屋根と壁を 1 つの geometry へまとめる。 */
export function mergeGeometry(roof, walls) {
  const base = roof.positions.length / 3;
  return {
    positions: roof.positions.concat(walls.positions),
    indices: roof.indices.concat(walls.indices.map((i) => i + base)),
    roofIndexCount: roof.indices.length,
    wallIndexCount: walls.indices.length,
  };
}

/** §30 作った屋根が条件を破っていないか。 */
export function guardRoof(geom, ring, totalHeightM) {
  if (!geom || !geom.ok) return { ok: false, reason: geom ? geom.reason : 'no-geometry' };
  const pos = geom.positions;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return { ok: false, reason: 'non-finite' };
    if (y < 0) return { ok: false, reason: 'negative-height' };
    if (y > totalHeightM + 0.01) return { ok: false, reason: 'height-overflow' };
    // §14 footprint の外へ出ていないか
    if (!pointInRing(x, z, ring) && distToRing(x, z, ring) > GUARD.footprintEpsM) {
      return { ok: false, reason: 'roof-outside-footprint' };
    }
  }
  if (!geom.indices || geom.indices.length < 3) return { ok: false, reason: 'invalid-mesh' };
  return { ok: true };
}

export function run() {
  const t0 = Date.now();
  const osm = rj(IR.osmRoof);
  if (!osm) throw new Error('先に tools/audit/umeda-roof-evidence.js を実行する');
  const { targets } = loadUmedaTargets();
  const osmIdx = buildOsmIndex(osm.buildings);

  const stats = { targets: targets.length, byType: {}, byConfidence: {}, byEvidence: {},
    generated: 0, generatedByType: {}, rejected: 0, rejectReasons: {},
    noGeometryNeeded: 0, needsImagery: 0, manualCandidate: 0 };
  const buildings = [];
  const decisions = [];
  for (const b of targets) {
    const ev = { osmRoof: matchOsmRoof(b.ring, osm.buildings, osmIdx) };
    const inf = inferRoof(b, ev);
    stats.byType[inf.roofType] = (stats.byType[inf.roofType] || 0) + 1;
    stats.byConfidence[inf.confidence] = (stats.byConfidence[inf.confidence] || 0) + 1;
    stats.byEvidence[inf.evidence] = (stats.byEvidence[inf.evidence] || 0) + 1;
    const dec = { canonicalId: b.canonicalId, roofType: inf.roofType, confidence: inf.confidence,
      evidence: inf.evidence, reason: inf.reason, ridgeDeg: inf.ridgeDeg ?? null,
      heightM: b.heightM, heightUnknown: b.heightUnknown, areaM2: b.areaM2, generated: false, rejectReason: null };

    // §9 HIGH だけが通常表示の候補
    if (inf.confidence !== 'HIGH') { dec.rejectReason = 'CONFIDENCE_' + inf.confidence; decisions.push(dec); continue; }
    if (MANUAL_TYPES.has(inf.roofType)) { stats.manualCandidate++; dec.rejectReason = 'MANUAL_CANDIDATE'; decisions.push(dec); continue; }
    // §16 FLAT は LOD1 の上面のままで正しい。作る必要が無い。
    if (NO_GEOMETRY_TYPES.has(inf.roofType)) { stats.noGeometryNeeded++; dec.rejectReason = 'FLAT_KEEPS_LOD1_TOP'; decisions.push(dec); continue; }
    // §17/§20 塔屋・多段は航空写真が要る
    if (NEEDS_IMAGERY_TYPES.has(inf.roofType)) { stats.needsImagery++; dec.rejectReason = 'NEEDS_AERIAL_IMAGERY'; decisions.push(dec); continue; }
    // §15 全高は信頼できる高さが要る
    if (b.heightUnknown || !(b.heightM > 0)) { dec.rejectReason = 'NO_TRUSTED_HEIGHT'; decisions.push(dec); continue; }

    const geom = buildSlopedRoof(b.ring, b.heightM, inf.roofType, inf.ridgeDeg);
    const g = guardRoof(geom, b.ring, b.heightM);
    if (!g.ok) {
      stats.rejected++;
      stats.rejectReasons[g.reason] = (stats.rejectReasons[g.reason] || 0) + 1;
      dec.rejectReason = g.reason;
      decisions.push(dec);
      continue;
    }
    // §24 LOD1 の箱を消す以上、壁もこちらで出す（屋根だけだと宙に浮く）
    const merged = mergeGeometry(geom, buildWalls(b.ring, geom.wallTopY));
    const gw = guardRoof({ ok: true, ...merged }, b.ring, b.heightM);
    if (!gw.ok) {
      stats.rejected++;
      stats.rejectReasons['walls-' + gw.reason] = (stats.rejectReasons['walls-' + gw.reason] || 0) + 1;
      dec.rejectReason = 'walls-' + gw.reason;
      decisions.push(dec);
      continue;
    }
    stats.generated++;
    stats.generatedByType[inf.roofType] = (stats.generatedByType[inf.roofType] || 0) + 1;
    dec.generated = true;
    decisions.push(dec);
    buildings.push({
      canonicalId: b.canonicalId,
      // §22 provenance（必須項目）
      geometrySource: 'PLATEAU_LOD1',
      representation: 'INFERRED_ROOF',
      roofSource: ROOF_SOURCE,
      roofSourceDate: osm.sourceDate || null,
      roofInferenceMethod: 'osm-roof-shape+footprint-obb',
      roofInferenceConfidence: inf.confidence,
      roofType: inf.roofType,
      generationVersion: GENERATION_VERSION,
      ridgeDeg: inf.ridgeDeg,
      totalHeightM: r2(b.heightM), wallTopY: geom.wallTopY, ridgeY: geom.ridgeY,
      roofHeightM: geom.roofHeightM, slopeDeg: geom.slopeDeg,
      fp: b.ring.map(([x, z]) => [r2(x), r2(z)]),
      positions: merged.positions.map(r2), indices: merged.indices,
      roofIndexCount: merged.roofIndexCount, wallIndexCount: merged.wallIndexCount,
    });
  }

  const generatedAt = new Date().toISOString();
  const manifest = {
    version: 1, kind: 'umeda-inferred-roof', namespace: 'derived-umeda-inferred-roof',
    representation: 'INFERRED_ROOF',
    warning: 'これは推定であり、PLATEAU の実 LOD2 ではない。UI で LOD2 と称してはならない（§1）。',
    coordinateConvention: 'znorth-neg-v1', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID,
    generatedAt, missionId: '35A', generationVersion: GENERATION_VERSION,
    area: UMEDA, targets: stats.targets, buildingCount: buildings.length,
    byType: stats.generatedByType, roofSource: ROOF_SOURCE,
  };
  const files = new Map([
    ['manifest.json', JSON.stringify(manifest, null, 2)],
    ['inferred-roofs.json', JSON.stringify({ version: 1, generatedAt, missionId: '35A',
      representation: 'INFERRED_ROOF', count: buildings.length, buildings })],
    ['decisions.json', JSON.stringify({ version: 1, generatedAt, missionId: '35A',
      note: '梅田の LOD1 建物 1 棟ごとの判断。dev QA が「なぜ屋根が無いのか」を出すのに使う。',
      count: decisions.length, decisions })],
  ]);
  for (const dir of [IR.outProcessed, IR.outPublic]) {
    fs.mkdirSync(dir, { recursive: true });
    writeFilesVerified(dir, files, { label: 'umeda inferred roof', removeStray: true });
  }
  const report = { version: 1, generatedAt, missionId: '35A', area: UMEDA,
    generationVersion: GENERATION_VERSION, roofSource: ROOF_SOURCE, guard: GUARD,
    stats, elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(IR.report), { recursive: true });
  fs.writeFileSync(IR.report, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[inferred-roof] 対象', o.stats.targets);
  console.log('[inferred-roof] 型', JSON.stringify(o.stats.byType));
  console.log('[inferred-roof] 信頼度', JSON.stringify(o.stats.byConfidence));
  console.log('[inferred-roof] 証拠', JSON.stringify(o.stats.byEvidence));
  console.log('[inferred-roof] 生成', o.stats.generated, JSON.stringify(o.stats.generatedByType));
  console.log('[inferred-roof] 生成しなかった理由: FLAT は LOD1 のまま', o.stats.noGeometryNeeded,
    '/ 航空写真が要る', o.stats.needsImagery, '/ 手作業候補', o.stats.manualCandidate, '/ guard reject', o.stats.rejected, JSON.stringify(o.stats.rejectReasons));
  console.log('[inferred-roof] out', IR.report);
}
