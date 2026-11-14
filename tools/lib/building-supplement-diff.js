// tools/lib/building-supplement-diff.js
// [Issue #65] PLATEAU 未収録建物の補完候補を「既存一致 / 新規候補 / 保留」に分ける純粋ロジック。
//   座標は Live City world {x,z}(m, +X=east, -Z=north) 前提。呼び出し側が latLonToLiveCityWorld で変換する。
//   建物を一律に平行移動して合わせることはしない。重複除去でポリゴンを切り抜かない（採否のみ判定）。
//   交差面積は bbox 内の決定的な格子サンプリング近似（SAMPLE_N x SAMPLE_N）。誤差は面積の数%。
import { ringArea, ringBbox, ringCentroid, pointInRingXZ } from './osm-building-fallback.js';

export const SAMPLE_N = 24;
export const DECISION = Object.freeze({ MATCH_EXISTING: 'MATCH_EXISTING', NEW_CANDIDATE: 'NEW_CANDIDATE', HOLD: 'HOLD' });
export const TH = Object.freeze({
  matchOverlapSmaller: 0.5,   // 交差面積/小さい方の面積 >= で既存一致（包含・位置ずれ同一建物を含む）
  partnerOverlapSmaller: 0.15, // 分棟/合棟の相手とみなす最小重なり
  offsetDistanceM: 3,          // 重ならなくても境界距離がこれ未満で面積比が近い → 位置ずれ疑いで保留
  offsetAreaRatio: 0.5,
  minAreaM2: 9,                // これ未満は保留（誤検出・付属物）
  maxAspect: 25,               // 細長すぎる形は保留
  newOverlapMax: 0.05,         // 新規候補とする最大重なり
  metersPerLevel: 3.0,
});

const bboxHit = (a, b) => a.maxX >= b.minX && a.minX <= b.maxX && a.maxZ >= b.minZ && a.minZ <= b.maxZ;
const inflate = (b, d) => ({ minX: b.minX - d, maxX: b.maxX + d, minZ: b.minZ - d, maxZ: b.maxZ + d });

/** 2 リングの交差面積（近似）。小さい方の bbox を格子サンプリングする。 */
export function intersectionAreaApprox(a, b, n = SAMPLE_N) {
  const ba = ringBbox(a), bb = ringBbox(b);
  if (!bboxHit(ba, bb)) return 0;
  const aa = ringArea(a), ab = ringArea(b);
  const [s, o, sb, sa] = aa <= ab ? [a, b, ba, aa] : [b, a, bb, ab];
  const w = sb.maxX - sb.minX, h = sb.maxZ - sb.minZ;
  if (w <= 0 || h <= 0) return 0;
  let inS = 0, both = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = sb.minX + ((i + 0.5) / n) * w, z = sb.minZ + ((j + 0.5) / n) * h;
    if (!pointInRingXZ(x, z, s)) continue;
    inS++;
    if (pointInRingXZ(x, z, o)) both++;
  }
  return inS ? sa * (both / inS) : 0;
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
  const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
/** 境界間の最短距離（頂点↔辺。重なる場合は呼び出し側で 0 扱い）。 */
export function boundaryDistance(a, b) {
  let d = Infinity;
  for (const [x, z] of a) for (let i = 0; i < b.length; i++) { const p = b[i], q = b[(i + 1) % b.length]; d = Math.min(d, segDist(x, z, p[0], p[1], q[0], q[1])); }
  for (const [x, z] of b) for (let i = 0; i < a.length; i++) { const p = a[i], q = a[(i + 1) % a.length]; d = Math.min(d, segDist(x, z, p[0], p[1], q[0], q[1])); }
  return d;
}

/** 既存 footprint の bbox 格子インデックス。 */
export function buildIndex(existing, cell = 50) {
  const grid = new Map();
  const items = existing.map((e) => ({ ...e, area: ringArea(e.ring), bbox: ringBbox(e.ring) }));
  items.forEach((it, idx) => {
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

/**
 * 候補 1 棟を判定。cand = {id, ring, buildingPartOf?}。
 * 返り値: {decision, reason, metrics, partners[]}
 */
export function classifyCandidate(cand, index) {
  const area = ringArea(cand.ring);
  const bbox = ringBbox(cand.ring);
  const w = bbox.maxX - bbox.minX, h = bbox.maxZ - bbox.minZ;
  const aspect = Math.max(w, h) / Math.max(1e-6, Math.min(w, h));
  const base = { area: +area.toFixed(2), aspect: +aspect.toFixed(2) };
  if (cand.ring.length < 3 || !(area > 0)) return { decision: DECISION.HOLD, reason: 'invalid-geometry', metrics: base, partners: [] };
  const partners = [];
  let minDist = Infinity, nearest = null;
  for (const e of near(index, bbox, TH.offsetDistanceM)) {
    const inter = intersectionAreaApprox(cand.ring, e.ring);
    const smaller = Math.min(area, e.area);
    const ratio = smaller > 0 ? inter / smaller : 0;
    const cc = ringCentroid(cand.ring), ec = ringCentroid(e.ring);
    const cIn = pointInRingXZ(cc[0], cc[1], e.ring);
    const eIn = pointInRingXZ(ec[0], ec[1], cand.ring);
    if (ratio >= TH.partnerOverlapSmaller || cIn || eIn) partners.push({ id: e.id, overlapSmaller: +ratio.toFixed(3), candContainsExisting: eIn && area >= e.area, existingContainsCand: cIn && area <= e.area });
    else {
      const d = boundaryDistance(cand.ring, e.ring);
      if (d < minDist) { minDist = d; nearest = e; }
    }
  }
  partners.sort((a, b) => b.overlapSmaller - a.overlapSmaller || (a.id < b.id ? -1 : 1));
  const top = partners[0];
  const metrics = { ...base, partnerCount: partners.length, maxOverlapSmaller: top ? top.overlapSmaller : 0, nearestBoundaryM: Number.isFinite(minDist) ? +minDist.toFixed(2) : null };
  if (top && (top.overlapSmaller >= TH.matchOverlapSmaller || top.candContainsExisting || top.existingContainsCand)) {
    const kind = partners.length > 1 ? 'split-or-merged' : top.existingContainsCand ? 'contained-by-existing' : top.candContainsExisting ? 'contains-existing' : 'overlap';
    return { decision: DECISION.MATCH_EXISTING, reason: `existing-${kind}`, metrics, partners };
  }
  if (top) return { decision: DECISION.HOLD, reason: 'partial-overlap-unclear', metrics, partners };
  if (nearest && minDist < TH.offsetDistanceM) {
    const r = Math.min(area, nearest.area) / Math.max(area, nearest.area);
    if (r >= TH.offsetAreaRatio) return { decision: DECISION.HOLD, reason: 'possible-offset-of-existing', metrics: { ...metrics, offsetAreaRatio: +r.toFixed(2) }, partners: [{ id: nearest.id, distanceM: +minDist.toFixed(2) }] };
  }
  if (area < TH.minAreaM2) return { decision: DECISION.HOLD, reason: 'too-small', metrics, partners };
  if (aspect > TH.maxAspect) return { decision: DECISION.HOLD, reason: 'too-elongated', metrics, partners };
  if (cand.buildingPartOf) return { decision: DECISION.HOLD, reason: 'building-part-parent-not-in-existing', metrics, partners };
  return { decision: DECISION.NEW_CANDIDATE, reason: 'no-existing-overlap', metrics, partners };
}

/** 高さ: 根拠ある値を優先。階数推定は estimated=true。根拠なしは unknown。DEM は使わない。 */
export function resolveHeight(src) {
  if (Number.isFinite(src.height) && src.height > 0) return { heightM: src.height, heightSource: src.heightSource || 'source-height-attribute', estimated: false };
  if (Number.isFinite(src.levels) && src.levels > 0) return { heightM: +(src.levels * TH.metersPerLevel).toFixed(1), heightSource: `levels*${TH.metersPerLevel}m`, estimated: true };
  return { heightM: null, heightSource: 'unknown', estimated: false };
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

/** 全体監査。出力は入力順に依存しない（id で整列）ため冪等。 */
export function auditCandidates(candidates, existing, ctx) {
  const index = buildIndex(existing);
  const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const records = [], summary = { total: sorted.length, byDecision: {}, byReason: {}, heightKnown: 0, heightEstimated: 0, heightUnknown: 0, surveyDateUnknown: 0, bySourceDataset: {} };
  for (const c of sorted) {
    const v = classifyCandidate(c, index);
    const rec = toSupplementRecord(c, v, ctx);
    records.push({ ...rec, metrics: v.metrics });
    summary.byDecision[v.decision] = (summary.byDecision[v.decision] || 0) + 1;
    summary.byReason[v.reason] = (summary.byReason[v.reason] || 0) + 1;
    if (v.decision === DECISION.NEW_CANDIDATE) {
      if (rec.heightSource === 'unknown') summary.heightUnknown++; else if (rec.estimated) summary.heightEstimated++; else summary.heightKnown++;
      if (rec.surveyDate == null) summary.surveyDateUnknown++;
      for (const d of rec.sourceDatasets.length ? rec.sourceDatasets : ['unknown']) summary.bySourceDataset[d] = (summary.bySourceDataset[d] || 0) + 1;
    }
  }
  return { summary, records };
}
