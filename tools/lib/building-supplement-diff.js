// tools/lib/building-supplement-diff.js
// [Issue #65] PLATEAU 未収録建物の補完候補を「既存一致 / 新規候補 / 保留」に分ける純粋ロジック。
//   座標は Live City world {x,z}(m, +X=east, -Z=north) 前提。呼び出し側が latLonToLiveCityWorld で変換する。
//   建物を一律に平行移動して合わせることはしない。重複除去でポリゴンを切り抜かない（採否のみ判定）。
//
//   ジオメトリ表現: 建物 = MultiPolygon = polys[] ; polygon = rings[] (rings[0]=外周, rings[1..]=内周(中庭))。
//   旧来の {ring} 入力は polys=[[ring]] に正規化する。内周・複数パートは捨てない。
//   交差面積は **格子近似ではなく厳密計算**（グリーンの定理による境界分割。凹形状・内周対応）。
//   重心包含だけでは包含を確定しない（包含 = 厳密交差面積/面積 ≈ 1）。
//   境界が数値的に曖昧（ほぼ共線/極小スリバー）または閾値の ±THRESHOLD_MARGIN 以内なら HOLD。
import { ringArea, ringBbox, ringSelfIntersects, pointInRingXZ } from './osm-building-fallback.js';

export const DECISION = Object.freeze({ MATCH_EXISTING: 'MATCH_EXISTING', NEW_CANDIDATE: 'NEW_CANDIDATE', HOLD: 'HOLD' });
export const TH = Object.freeze({
  matchOverlapSmaller: 0.5,   // 交差面積/小さい方の面積 >= で既存一致
  partnerOverlapSmaller: 0.15, // 分棟/合棟の相手とみなす最小重なり
  offsetDistanceM: 3,          // 重ならなくても境界距離がこれ未満で面積比が近い → 位置ずれ疑いで保留
  offsetAreaRatio: 0.5,
  minAreaM2: 9,                // これ未満は保留（誤検出・付属物）
  maxAspect: 25,               // 細長すぎる形は保留（bbox 比）
  newOverlapMax: 0.05,         // 新規候補とする最大重なり（超えて partner 未満は保留）
  containFrac: 1 - 1e-6,       // 交差/面積 がこれ以上なら包含
  thresholdMargin: 1e-3,       // 判定閾値(0.05/0.15/0.5)からこの幅以内は保留（浮動小数/入力丸めに対する安全帯）
  metersPerLevel: 3.0,
});
const EPS_ON = 1e-6;       // 境界上とみなす距離(m)
const EPS_SLIVER = 1e-3;   // これ未満の「境界ぎりぎり」は数値的に曖昧 → unsure

// ---------- 正規化 ----------
const closeOpen = (r) => (r.length > 1 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1] ? r.slice(0, -1) : r);
/** 入力 {ring} | {polys} → polys: rings[][][] (開リング)。 */
export function normalizeGeometry(c) {
  const polys = c.polys ?? (c.ring ? [[c.ring]] : []);
  return polys.map((p) => p.map(closeOpen));
}
const signed = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
/** 外周=CCW(+) / 内周=CW(-) に向きを揃えた polygon を返す。 */
function orient(poly) { return poly.map((r, i) => ((signed(r) > 0) === (i === 0) ? r : [...r].reverse())); }
export const polyArea = (poly) => poly.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * ringArea(r), 0);
export const geomArea = (polys) => polys.reduce((s, p) => s + polyArea(p), 0);
export function geomBbox(polys) {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const p of polys) { const q = ringBbox(p[0]); b.minX = Math.min(b.minX, q.minX); b.maxX = Math.max(b.maxX, q.maxX); b.minZ = Math.min(b.minZ, q.minZ); b.maxZ = Math.max(b.maxZ, q.maxZ); }
  return b;
}
const bboxHit = (a, b) => a.maxX >= b.minX && a.minX <= b.maxX && a.maxZ >= b.minZ && a.minZ <= b.maxZ;
const inflate = (b, d) => ({ minX: b.minX - d, maxX: b.maxX + d, minZ: b.minZ - d, maxZ: b.maxZ + d });
const inPoly = (x, z, poly) => pointInRingXZ(x, z, poly[0]) && !poly.slice(1).some((h) => pointInRingXZ(x, z, h));
/** 形状の妥当性: 3点未満/面積0/非有限/自己交差(外周・内周)。 */
export function geomValid(polys) {
  if (!polys.length) return false;
  for (const p of polys) for (const r of p) {
    if (r.length < 3) return false;
    for (const q of r) if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) return false;
    if (ringSelfIntersects(r)) return false;
  }
  return polys.every((p) => ringArea(p[0]) > 0) && geomArea(polys) > 0;
}

// ---------- 厳密交差面積 ----------
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
  const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
/** 点と polygon(全リング)の境界との最短距離と、その最寄り辺の方向。 */
function nearestEdge(x, z, poly) {
  let best = { d: Infinity, dx: 0, dz: 0 };
  for (const r of poly) for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length], d = segDist(x, z, p[0], p[1], q[0], q[1]);
    if (d < best.d) best = { d, dx: q[0] - p[0], dz: q[1] - p[1] };
  }
  return best;
}
/** edge a→b 上で polyQ の辺と交わる/共線で端点が乗るパラメータ t∈(0,1)。 */
function splitParams(a, b, polyQ) {
  const ts = [0, 1], rx = b[0] - a[0], rz = b[1] - a[1], rr = rx * rx + rz * rz;
  for (const r of polyQ) for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length], sx = q[0] - p[0], sz = q[1] - p[1];
    const den = rx * sz - rz * sx;
    if (Math.abs(den) > 1e-12 * Math.max(1, rr)) {
      const t = ((p[0] - a[0]) * sz - (p[1] - a[1]) * sx) / den, u = ((p[0] - a[0]) * rz - (p[1] - a[1]) * rx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    for (const e of [p, q]) { // 端点が辺上（共線/T字）
      const t = rr > 0 ? ((e[0] - a[0]) * rx + (e[1] - a[1]) * rz) / rr : 0;
      if (t > 0 && t < 1 && segDist(e[0], e[1], a[0], a[1], b[0], b[1]) < EPS_ON) ts.push(t);
    }
  }
  return ts.sort((x, y) => x - y);
}
/** P の境界のうち Q 内部にある部分の ∮ (x dz - z dx)/2。coincident は同方向のみ P 側で計上。 */
function boundaryContribution(P, Q, countCoincident, state) {
  let sum = 0;
  for (const r of P) for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length], ts = splitParams(a, b, Q);
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k], t1 = ts[k + 1]; if (t1 - t0 < 1e-12) continue;
      const p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      const mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2, ne = nearestEdge(mx, mz, Q);
      let inc;
      if (ne.d < EPS_ON) { // 境界上（共線重なり）
        inc = countCoincident && ((b[0] - a[0]) * ne.dx + (b[1] - a[1]) * ne.dz) > 0;
      } else {
        if (ne.d < EPS_SLIVER) state.unsure = true; // 境界ぎりぎり（ほぼ共線/極小スリバー）
        inc = inPoly(mx, mz, Q);
      }
      if (inc) sum += (p0[0] * p1[1] - p1[0] * p0[1]) / 2;
    }
  }
  return sum;
}
/** 厳密交差面積（polygon 同士）。返り値 {area, unsure}。 */
export function polyIntersection(P0, Q0) {
  const P = orient(P0), Q = orient(Q0), state = { unsure: false };
  const area = boundaryContribution(P, Q, true, state) + boundaryContribution(Q, P, false, state);
  return { area: Math.max(0, area), unsure: state.unsure };
}
/** MultiPolygon 同士の厳密交差面積（パートは互いに素と仮定）。 */
export function intersectionArea(A, B) {
  const bb = geomBbox(B);
  let area = 0, unsure = false;
  for (const p of A) {
    if (!bboxHit(ringBbox(p[0]), bb)) continue;
    for (const q of B) {
      if (!bboxHit(ringBbox(p[0]), ringBbox(q[0]))) continue;
      const r = polyIntersection(p, q); area += r.area; unsure ||= r.unsure;
    }
  }
  return { area, unsure };
}

/** 境界間の最短距離（全リング・頂点↔辺。重なる場合は 0 扱いを呼び出し側で行う）。 */
export function boundaryDistance(a, b) {
  const A = Array.isArray(a[0][0]) && Array.isArray(a[0][0][0]) ? a : [[a]], B = Array.isArray(b[0][0]) && Array.isArray(b[0][0][0]) ? b : [[b]];
  let d = Infinity;
  const rings = (G) => G.flatMap((p) => p);
  const scan = (R1, R2) => { for (const r1 of R1) for (const [x, z] of r1) for (const r2 of R2) for (let i = 0; i < r2.length; i++) { const p = r2[i], q = r2[(i + 1) % r2.length]; d = Math.min(d, segDist(x, z, p[0], p[1], q[0], q[1])); } };
  scan(rings(A), rings(B)); scan(rings(B), rings(A));
  return d;
}

// ---------- インデックス ----------
export function buildIndex(existing, cell = 50) {
  const grid = new Map();
  const items = existing.map((e) => { const polys = normalizeGeometry(e); return { ...e, polys, area: geomArea(polys), bbox: geomBbox(polys), valid: geomValid(polys) }; });
  items.forEach((it, idx) => {
    if (!it.polys.length) return;
    for (let gx = Math.floor(it.bbox.minX / cell); gx <= Math.floor(it.bbox.maxX / cell); gx++)
      for (let gz = Math.floor(it.bbox.minZ / cell); gz <= Math.floor(it.bbox.maxZ / cell); gz++) {
        const k = `${gx},${gz}`; (grid.get(k) || grid.set(k, []).get(k)).push(idx);
      }
  });
  return { items, grid, cell };
}
function near(index, bbox, margin) {
  const bb = inflate(bbox, margin), set = new Set(), c = index.cell;
  for (let gx = Math.floor(bb.minX / c); gx <= Math.floor(bb.maxX / c); gx++)
    for (let gz = Math.floor(bb.minZ / c); gz <= Math.floor(bb.maxZ / c); gz++)
      for (const i of index.grid.get(`${gx},${gz}`) || []) set.add(i);
  return [...set].sort((a, b) => a - b).map((i) => index.items[i]);
}
const nearThreshold = (r) => [TH.newOverlapMax, TH.partnerOverlapSmaller, TH.matchOverlapSmaller].some((t) => Math.abs(r - t) < TH.thresholdMargin);

/**
 * 候補 1 棟を判定。cand = {id, ring | polys, buildingPartOf?}。
 * 返り値: {decision, reason, metrics, partners[]}
 */
export function classifyCandidate(cand, index) {
  const polys = normalizeGeometry(cand);
  const area = geomArea(polys);
  const bbox = geomBbox(polys);
  const w = bbox.maxX - bbox.minX, h = bbox.maxZ - bbox.minZ;
  const aspect = Math.max(w, h) / Math.max(1e-6, Math.min(w, h));
  const base = { area: +area.toFixed(2), aspect: +aspect.toFixed(2), parts: polys.length, holes: polys.reduce((s, p) => s + p.length - 1, 0) };
  if (!geomValid(polys)) return { decision: DECISION.HOLD, reason: 'invalid-geometry', metrics: base, partners: [] };
  const partners = [];
  let minDist = Infinity, nearest = null, unsure = false, borderline = false, invalidNeighbor = false, minor = 0;
  for (const e of near(index, bbox, TH.offsetDistanceM)) {
    if (!e.valid) { if (bboxHit(e.bbox, inflate(bbox, TH.offsetDistanceM))) invalidNeighbor = true; continue; }
    const { area: inter, unsure: u } = intersectionArea(polys, e.polys);
    unsure ||= u;
    const smaller = Math.min(area, e.area);
    const ratio = smaller > 0 ? inter / smaller : 0;
    if (nearThreshold(ratio)) borderline = true;
    if (ratio >= TH.partnerOverlapSmaller) {
      partners.push({
        id: e.id, overlapSmaller: +ratio.toFixed(4),
        existingContainsCand: inter / area >= TH.containFrac, candContainsExisting: inter / e.area >= TH.containFrac,
      });
    } else {
      if (ratio > TH.newOverlapMax) minor = Math.max(minor, ratio);
      const d = ratio > 0 ? 0 : boundaryDistance(polys, e.polys);
      if (d < minDist) { minDist = d; nearest = e; }
    }
  }
  partners.sort((a, b) => b.overlapSmaller - a.overlapSmaller || (a.id < b.id ? -1 : 1));
  const top = partners[0];
  const metrics = { ...base, partnerCount: partners.length, maxOverlapSmaller: top ? top.overlapSmaller : +minor.toFixed(4), nearestBoundaryM: Number.isFinite(minDist) ? +minDist.toFixed(2) : null };
  if (invalidNeighbor) return { decision: DECISION.HOLD, reason: 'neighbor-invalid-geometry', metrics, partners };
  if (unsure) return { decision: DECISION.HOLD, reason: 'numerically-ambiguous-boundary', metrics, partners };
  if (borderline) return { decision: DECISION.HOLD, reason: 'threshold-borderline', metrics, partners };
  if (top && (top.overlapSmaller >= TH.matchOverlapSmaller || top.candContainsExisting || top.existingContainsCand)) {
    const kind = partners.length > 1 ? 'split-or-merged' : top.existingContainsCand ? 'contained-by-existing' : top.candContainsExisting ? 'contains-existing' : 'overlap';
    return { decision: DECISION.MATCH_EXISTING, reason: `existing-${kind}`, metrics, partners };
  }
  if (top || minor > 0) return { decision: DECISION.HOLD, reason: 'partial-overlap-unclear', metrics, partners };
  if (nearest && minDist < TH.offsetDistanceM) {
    const r = Math.min(area, nearest.area) / Math.max(area, nearest.area);
    if (r >= TH.offsetAreaRatio) return { decision: DECISION.HOLD, reason: 'possible-offset-of-existing', metrics: { ...metrics, offsetAreaRatio: +r.toFixed(2) }, partners: [{ id: nearest.id, distanceM: +minDist.toFixed(2) }] };
  }
  if (area < TH.minAreaM2) return { decision: DECISION.HOLD, reason: 'too-small', metrics, partners };
  if (aspect > TH.maxAspect) return { decision: DECISION.HOLD, reason: 'too-elongated', metrics, partners };
  if (cand.buildingPartOf) return { decision: DECISION.HOLD, reason: 'building-part-parent-not-in-existing', metrics, partners };
  return { decision: DECISION.NEW_CANDIDATE, reason: 'no-existing-overlap', metrics, partners };
}

/**
 * 高さ。**height 属性が在るだけでは実測値扱いしない。**
 *   src.heightEstimated === false かつ heightSource 指定 → 実測(estimated:false)
 *   src.heightEstimated === true                         → 推定(estimated:true)
 *   それ以外（Overture/OSM の素の height 等）              → 数値は保持するが estimated:null（根拠未確認）
 *   階数のみ → levels*3.0m (estimated:true)。根拠なし → unknown。DEM は使わない。
 * 元ソースの精度情報(heightAccuracy)・出所(heightSource)は保持する。
 */
export function resolveHeight(src) {
  const acc = src.heightAccuracy ?? null;
  if (Number.isFinite(src.height) && src.height > 0) {
    if (src.heightEstimated === false && src.heightSource) return { heightM: src.height, heightSource: src.heightSource, estimated: false, heightAccuracy: acc };
    if (src.heightEstimated === true) return { heightM: src.height, heightSource: src.heightSource || 'source-height-estimated', estimated: true, heightAccuracy: acc };
    return { heightM: src.height, heightSource: src.heightSource || 'source-height-attribute-unverified', estimated: null, heightAccuracy: acc };
  }
  if (Number.isFinite(src.levels) && src.levels > 0) return { heightM: +(src.levels * TH.metersPerLevel).toFixed(1), heightSource: `levels*${TH.metersPerLevel}m`, estimated: true, heightAccuracy: acc };
  return { heightM: null, heightSource: 'unknown', estimated: false, heightAccuracy: acc };
}

/** 補完レイヤー用レコード。権利未確認は status=hold-license。LOD1/LOD2 と称さない。 */
export function toSupplementRecord(cand, verdict, ctx) {
  const h = resolveHeight(cand);
  return {
    canonicalId: `supp:${ctx.source}:${cand.id}`,
    source: ctx.source, sourceId: cand.id, sourceVersion: ctx.sourceVersion,
    surveyDate: cand.surveyDate ?? null, acquiredAt: ctx.acquiredAt ?? null,
    license: ctx.license ?? 'unknown', sourceDatasets: cand.sourceDatasets ?? [],
    geometryConfidence: verdict.decision === DECISION.NEW_CANDIDATE ? 'candidate' : 'unverified',
    ...h,
    representation: 'supplement-extrusion-not-plateau-lod',
    status: verdict.decision === DECISION.NEW_CANDIDATE ? (ctx.license && ctx.license !== 'unknown' ? 'candidate' : 'candidate-hold-license') : verdict.decision === DECISION.HOLD ? 'hold' : 'matched-existing',
    decisionReason: verdict.reason, matchedExistingIds: (verdict.partners || []).map((p) => p.id).filter(Boolean),
  };
}

/**
 * 候補同士の重複: id 順に NEW_CANDIDATE を採用リストへ入れ、後続が採用済みと
 * 既存一致相当(≥0.5)/部分重なり(>0.05)なら HOLD(candidate-duplicate) にする。入力順に依存しない。
 */
function dedupeNewCandidates(sorted, verdicts) {
  const accepted = [];
  sorted.forEach((c, i) => {
    const v = verdicts[i]; if (v.decision !== DECISION.NEW_CANDIDATE) return;
    const polys = normalizeGeometry(c), area = geomArea(polys), bb = geomBbox(polys);
    for (const a of accepted) {
      if (!bboxHit(bb, inflate(a.bb, 0))) continue;
      const { area: inter, unsure } = intersectionArea(polys, a.polys), r = inter / Math.min(area, a.area);
      if (r > TH.newOverlapMax || unsure) { verdicts[i] = { decision: DECISION.HOLD, reason: 'candidate-duplicate', metrics: { ...v.metrics, duplicateOverlapSmaller: +r.toFixed(4) }, partners: [{ id: a.id, overlapSmaller: +r.toFixed(4) }] }; return; }
    }
    accepted.push({ id: c.id, polys, area, bb });
  });
}

/** 全体監査。出力は入力順に依存しない（id で整列）ため冪等。 */
export function auditCandidates(candidates, existing, ctx) {
  const index = buildIndex(existing);
  const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const verdicts = sorted.map((c) => classifyCandidate(c, index));
  dedupeNewCandidates(sorted, verdicts);
  const records = [], summary = { total: sorted.length, byDecision: {}, byReason: {}, heightMeasured: 0, heightEstimated: 0, heightUnverified: 0, heightUnknown: 0, surveyDateUnknown: 0, bySourceDataset: {} };
  sorted.forEach((c, i) => {
    const v = verdicts[i], rec = toSupplementRecord(c, v, ctx);
    records.push({ ...rec, metrics: v.metrics });
    summary.byDecision[v.decision] = (summary.byDecision[v.decision] || 0) + 1;
    summary.byReason[v.reason] = (summary.byReason[v.reason] || 0) + 1;
    if (v.decision === DECISION.NEW_CANDIDATE) {
      if (rec.heightSource === 'unknown') summary.heightUnknown++;
      else if (rec.estimated === true) summary.heightEstimated++;
      else if (rec.estimated === false) summary.heightMeasured++;
      else summary.heightUnverified++;
      if (rec.surveyDate == null) summary.surveyDateUnknown++;
      for (const d of rec.sourceDatasets.length ? rec.sourceDatasets : ['unknown']) summary.bySourceDataset[d] = (summary.bySourceDataset[d] || 0) + 1;
    }
  });
  return { summary, records };
}
