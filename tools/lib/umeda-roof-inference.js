// tools/lib/umeda-roof-inference.js
// [Mission 35A §7/§8/§9] 梅田の LOD1 建物について、**証拠がある場合だけ** 屋根タイプを推定する。
//   純粋関数だけを置く（ファイル I/O もネットワークも無い）。テストから直接呼べる。
//
//   §4: 高さ・階数だけから屋根形状を決めてはいけない。
//   §6: 証拠が無ければ推定しない（NO_ROOF_EVIDENCE のまま LOD1）。
//   §9: HIGH のみ通常表示の候補。MEDIUM は QA、LOW は LOD1 維持。

export const ROOF_TYPES = ['FLAT', 'FLAT_WITH_PENTHOUSE', 'MULTI_LEVEL_FLAT', 'GABLE', 'HIP', 'SHED', 'COMPLEX', 'UNKNOWN'];
export const CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'];
export const NO_EVIDENCE = 'NO_ROOF_EVIDENCE';

/** OSM の roof:shape → こちらの型。曖昧・複合は採らない（UNKNOWN / COMPLEX へ倒す）。 */
export const OSM_ROOF_SHAPE_MAP = {
  flat: 'FLAT',
  gabled: 'GABLE',
  hipped: 'HIP',
  'half-hipped': 'HIP',
  side_hipped: 'HIP',
  'cross hipped': 'COMPLEX',
  cross_gabled: 'COMPLEX',
  skillion: 'SHED',
  'lean_to': 'SHED',
  pyramidal: 'HIP',
  mansard: 'COMPLEX',
  gambrel: 'COMPLEX',
  saltbox: 'COMPLEX',
  round: 'COMPLEX',
  dome: 'COMPLEX',
  cone: 'COMPLEX',
  many: 'COMPLEX',
  mixed: 'COMPLEX',
};
/** §21 自動生成しない型（将来の手作業候補） */
export const MANUAL_CANDIDATE_TYPES = new Set(['COMPLEX']);

/** footprint の形状指標（推定の補助。これ単独では型を決めない）。 */
export function footprintShape(ring) {
  if (!ring || ring.length < 3) return null;
  let cx = 0, cz = 0;
  for (const p of ring) { cx += p[0]; cz += p[1]; }
  cx /= ring.length; cz /= ring.length;
  // 主軸（2 次モーメント）
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of ring) { const dx = p[0] - cx, dz = p[1] - cz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
  const n = ring.length;
  sxx /= n; szz /= n; sxz /= n;
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ct = Math.cos(theta), st = Math.sin(theta);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of ring) {
    const dx = p[0] - cx, dz = p[1] - cz;
    const u = dx * ct + dz * st, v = -dx * st + dz * ct;
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const lenU = maxU - minU, lenV = maxV - minV;
  const long = Math.max(lenU, lenV), short = Math.min(lenU, lenV);
  // 主軸の向き（長辺方向）を 0-180° で
  const longIsU = lenU >= lenV;
  const axisDeg = (((longIsU ? theta : theta + Math.PI / 2) * 180 / Math.PI) + 360) % 180;
  let area = 0;
  for (let i = 0; i < n; i++) { const a = ring[i], b = ring[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  area = Math.abs(area) / 2;
  return { centroid: [cx, cz], longM: +long.toFixed(2), shortM: +short.toFixed(2),
    elongation: short > 0 ? +(long / short).toFixed(3) : null,
    obbAreaM2: +(long * short).toFixed(2), areaM2: +area.toFixed(2),
    rectangularity: long * short > 0 ? +(area / (long * short)).toFixed(3) : null,
    longAxisDeg: +axisDeg.toFixed(1), vertices: n };
}

/**
 * §7/§8/§9 屋根タイプの推定。
 * @param {object} b  { canonicalId, ring, areaM2, heightM, heightUnknown, usageCategory }
 * @param {object} ev { osmRoof?: {shape, orientation, levels, height, matchIoU}, gsiOutline?: {lines, coverage} }
 * @returns {{roofType, confidence, evidence, reason, ridgeDeg?, manualCandidate?}}
 */
export function inferRoof(b, ev = {}) {
  const shape = footprintShape(b.ring);
  const osm = ev.osmRoof || null;

  // ── 証拠 1: OSM の roof:shape（人が航空写真等を見て入れた観測値）──────
  if (osm && osm.shape) {
    const mapped = OSM_ROOF_SHAPE_MAP[String(osm.shape).toLowerCase()];
    if (!mapped) {
      return { roofType: 'UNKNOWN', confidence: 'LOW', evidence: 'osm-roof-shape-unmapped',
        reason: 'roof:shape="' + osm.shape + '" は対応表に無い', osmShape: osm.shape };
    }
    if (MANUAL_CANDIDATE_TYPES.has(mapped)) {
      return { roofType: mapped, confidence: 'LOW', evidence: 'osm-roof-shape',
        reason: '複雑すぎるので自動生成しない（§21）', manualCandidate: true, osmShape: osm.shape };
    }
    // footprint との一致度が高いほど信用できる（別の建物のタグを拾っていないか）
    const iou = osm.matchIoU != null ? osm.matchIoU : 0;
    const conf = iou >= 0.6 ? 'HIGH' : iou >= 0.35 ? 'MEDIUM' : 'LOW';
    let ridgeDeg = null;
    if (mapped === 'GABLE' || mapped === 'HIP' || mapped === 'SHED') {
      // §18 棟の向きは「長辺方向の決め打ち」にしない。OSM の roof:orientation があるときだけ決める。
      if (osm.orientation === 'along' && shape) ridgeDeg = shape.longAxisDeg;
      else if (osm.orientation === 'across' && shape) ridgeDeg = (shape.longAxisDeg + 90) % 180;
      else {
        return { roofType: 'UNKNOWN', confidence: 'LOW', evidence: 'osm-roof-shape',
          reason: '勾配屋根だが roof:orientation が無く、棟の向きを決める証拠が無い（§18）',
          osmShape: osm.shape, wouldBe: mapped };
      }
    }
    return { roofType: mapped, confidence: conf, evidence: 'osm-roof-shape',
      reason: 'OSM roof:shape=' + osm.shape + '（footprint 一致 IoU ' + iou.toFixed(2) + '）',
      ridgeDeg, osmShape: osm.shape, osmOrientation: osm.orientation || null };
  }

  // ── 証拠 2: OSM の roof:levels / roof:height（形そのものではないが段の証拠）──
  if (osm && (osm.levels != null || osm.height != null)) {
    return { roofType: 'UNKNOWN', confidence: 'LOW', evidence: 'osm-roof-metrics-only',
      reason: 'roof:levels / roof:height はあるが形の証拠が無い' };
  }

  // ── 証拠なし ──────────────────────────────────────────────────────────
  // §4/§6: footprint と高さだけで屋根形状を決めてはいけない。
  return { roofType: 'UNKNOWN', confidence: 'LOW', evidence: NO_EVIDENCE,
    reason: '航空写真も OSM の屋根タグも無いため推定しない（§6）', shape };
}

/**
 * §12 評価。ground truth（実 LOD2 由来の型）と推定結果を突き合わせる。
 * 勾配屋根どうしの取り違えと、平屋根系の細分（FLAT / PENTHOUSE / MULTI_LEVEL）は別に数える。
 */
export const FLAT_FAMILY = new Set(['FLAT', 'FLAT_WITH_PENTHOUSE', 'MULTI_LEVEL_FLAT']);
export const SLOPED_FAMILY = new Set(['GABLE', 'HIP', 'SHED']);
export function evaluate(pairs) {
  const res = { n: pairs.length, exact: 0, familyMatch: 0, unknown: 0,
    confusion: {}, byConfidence: {}, ridgeErrors: [] };
  for (const p of pairs) {
    const t = p.truth, g = p.predicted;
    const conf = p.confidence || 'LOW';
    if (!res.byConfidence[conf]) res.byConfidence[conf] = { n: 0, exact: 0, family: 0, unknown: 0 };
    const c = res.byConfidence[conf];
    c.n++;
    if (g === 'UNKNOWN') { res.unknown++; c.unknown++; continue; }
    const key = t + '→' + g;
    res.confusion[key] = (res.confusion[key] || 0) + 1;
    if (t === g) { res.exact++; c.exact++; }
    if ((FLAT_FAMILY.has(t) && FLAT_FAMILY.has(g)) || (SLOPED_FAMILY.has(t) && SLOPED_FAMILY.has(g))) { res.familyMatch++; c.family++; }
    if (p.truthRidgeDeg != null && p.predictedRidgeDeg != null) {
      let d = Math.abs(p.truthRidgeDeg - p.predictedRidgeDeg) % 180;
      if (d > 90) d = 180 - d;
      res.ridgeErrors.push(+d.toFixed(2));
    }
  }
  const judged = res.n - res.unknown;
  res.exactAccuracy = judged ? +(res.exact / judged).toFixed(4) : null;
  res.familyAccuracy = judged ? +(res.familyMatch / judged).toFixed(4) : null;
  res.coverage = res.n ? +((res.n - res.unknown) / res.n).toFixed(4) : null;
  const sorted = res.ridgeErrors.slice().sort((a, b) => a - b);
  res.ridgeErrorDeg = sorted.length
    ? { n: sorted.length, median: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted[sorted.length - 1] }
    : null;
  return res;
}

/** §13 採用基準。実測を見て決めるが、既定はミッションの目標値。 */
export const QUALITY = { roofTypeAccuracy: 0.85, ridgeMedianDeg: 10, roofIoUMedian: 0.85 };
export function meetsQuality(evalResult, q = QUALITY) {
  if (!evalResult || evalResult.exactAccuracy == null) return false;
  if (evalResult.exactAccuracy < q.roofTypeAccuracy) return false;
  if (evalResult.ridgeErrorDeg && evalResult.ridgeErrorDeg.median > q.ridgeMedianDeg) return false;
  return true;
}
