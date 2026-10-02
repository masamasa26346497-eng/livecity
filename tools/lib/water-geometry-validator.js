// tools/lib/water-geometry-validator.js
// 河川・水域データ（OSM_WATER 形式の配列）の幾何異常を検証する。
//
// OSM_WATER の各要素:
//   線: { id, name, kind:'line', subtype, p:[[x,z],...], w? }
//   面: { id, name, kind:'area', subtype, p:[[x,z],...], holes?:[[[x,z],...],...] }
//
// 主目的は「川面を横断する巨大三角形」の原因になる次の異常を、三角形分割される前に検出すること:
//   - 巨大セグメント（未連結multipolygon・座標破損の兆候）
//   - 面リングの自己交差
//   - 面リングが実質的に退化している（ユニーク点 < 3）
//   - 非有限座標
// 検出はするが自動修正はしない（fix-forwardは取得パイプライン側の責務）。

import { analyzeRing } from './geometry-anomaly.js';

/**
 * @param {Array} items OSM_WATER 相当の配列
 * @param {{oversizedAbs?:number, oversizedMedianMult?:number}} [opts]
 * @returns {{ok:boolean, summary:object, offenders:object[], checks:object[]}}
 */
export function validateWaterGeometry(items, opts = {}) {
  const list = Array.isArray(items) ? items : (items && Array.isArray(items.items) ? items.items : null);
  if (!list) {
    return { ok: false, summary: { total: 0 }, offenders: [], checks: [{ name: 'input-shape', pass: false, detail: 'OSM_WATER配列が見つかりません。' }] };
  }

  const ringOpts = {
    oversizedAbs: opts.oversizedAbs ?? 350, // 水域は行政界より粗いノードもあるため絶対しきい値をやや下げる
    oversizedMedianMult: opts.oversizedMedianMult ?? 15,
    // 河岸polygonは細長い（bbox対角が大きい）ため、対角比でも判定する。未連結memberの飛びは
    // たいてい地物全体の1/3以上を横断する。
    oversizedBboxRatio: opts.oversizedBboxRatio ?? 0.33,
  };

  let areas = 0, lines = 0;
  let totalOversized = 0, totalSelfInt = 0, totalNonFinite = 0, degenerate = 0, unclosedScan = 0;
  const offenders = [];

  list.forEach((w, i) => {
    if (!w || !Array.isArray(w.p)) { degenerate++; return; }
    const kind = w.kind || (w.p.length >= 3 ? 'area' : 'line');
    if (kind === 'line') lines++; else areas++;

    const label = w.name || w.id || `#${i}`;
    const rings = [{ role: 'outer', pts: w.p }];
    for (const h of (w.holes || [])) rings.push({ role: 'inner', pts: h });

    let itemOversized = 0, itemSelfInt = 0, itemNonFinite = 0, itemUnscanned = false, itemDegenerate = false;
    for (const r of rings) {
      const ev = analyzeRing(r.pts, ringOpts);
      itemNonFinite += ev.nonFinite;
      // 線は交差・巨大セグメント判定の対象外（中心線は自己交差も長い直線区間も正常にありうる）。
      if (kind === 'area') {
        itemOversized += ev.oversizedSegments;
        itemSelfInt += ev.selfIntersections;
        if (!ev.selfIntersectionScanned && ev.points >= 4) itemUnscanned = true;
        if (ev.uniquePoints < 3) itemDegenerate = true;
      }
    }

    totalOversized += itemOversized;
    totalSelfInt += itemSelfInt;
    totalNonFinite += itemNonFinite;
    if (itemUnscanned) unclosedScan++;
    if (itemDegenerate) degenerate++;

    if (itemOversized || itemSelfInt || itemNonFinite || itemDegenerate) {
      offenders.push({
        id: w.id || null, name: w.name || '', kind, subtype: w.subtype || null,
        points: w.p.length, oversizedSegments: itemOversized, selfIntersections: itemSelfInt,
        nonFiniteCoords: itemNonFinite, degenerate: itemDegenerate, label,
      });
    }
  });

  const checks = [
    { name: 'coords-finite', pass: totalNonFinite === 0, detail: totalNonFinite ? `非有限座標 ${totalNonFinite}点` : 'OK' },
    { name: 'no-degenerate-area-rings', pass: degenerate === 0, detail: degenerate ? `退化した面 ${degenerate}件` : 'OK' },
    { name: 'no-oversized-segments', pass: totalOversized === 0, detail: totalOversized ? `巨大セグメントを含む面 ${offenders.filter(o => o.oversizedSegments).length}件 / 計${totalOversized}辺` : 'OK' },
    { name: 'no-area-self-intersections', pass: totalSelfInt === 0, detail: totalSelfInt ? `自己交差を含む面 ${offenders.filter(o => o.selfIntersections).length}件` : 'OK' },
  ];
  if (unclosedScan) {
    checks.push({ name: 'self-intersection-scan-coverage', pass: true, detail: `点数上限超でスキャン未実施 ${unclosedScan}件`, severity: 'warning' });
  }

  const ok = checks.every((c) => c.pass || c.severity === 'warning');
  return {
    ok,
    summary: { total: list.length, areas, lines, offenders: offenders.length,
      oversizedSegments: totalOversized, selfIntersections: totalSelfInt, nonFiniteCoords: totalNonFinite, degenerate },
    offenders,
    checks,
  };
}
