// tools/lib/river-ribbon-validator.js
// [河川再構築] river ribbon validator（指示書 11節）。
// polygon validator（tools/lib/polygon-fill.js / water-semantic-validator.js）とは別に、
// 「centerline + width から作った ribbon が構造的に巨大水色面になっていないか」を検証する。
// THREE 非依存・純粋関数。ERROR は描画を止めるべき欠陥、WARN は要目視確認。

import { RIVER_WIDTH_LIMITS } from './river-width.js';

export const RIBBON_VALIDATION_LIMITS = Object.freeze({
  maxSegmentLenM: 400,        // centerline 隣接点間がこれを超えたら WARN（source line 分断/継ぎ目疑い）
  maxTriangleAreaM2: 30000,   // 1三角形がこれを超えたら ERROR（巨大三角形＝構造的破綻）
  maxTriangleEdgeM: 2000,     // 三角形の最長辺（=生成後のribbon geometryそのもの）がこれを超えたら ERROR
  rawJumpWarnM: 800,          // densify前のcenterline隣接点距離がこれを超えたら WARN（source疎密・要目視確認）
  rawJumpErrorM: 5000,        // 同、これを超えたら ERROR（1way内の単一区間としては非現実的なジャンプ＝継ぎ目破綻の疑い）
  widthJumpWarnRatio: 1.6,    // [Mission04] 隣接頂点間の幅比がこれ超で WARN
  widthJumpErrorRatio: 2.5,   // [Mission04] 隣接頂点間の幅比がこれ超で ERROR（2〜3倍級の瞬間jump）
  bboxSlackFactor: 1.6, // ribbon bbox対角の許容上限 = (centerline全長 + width) * この係数
});

function polylineLength(points) {
  let len = 0;
  for (let i = 0; i < points.length - 1; i++) len += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
  return len;
}

/**
 * @param {object} river  { id, name, width, centerline:number[][], left:number[][], right:number[][], trianglesXZ, maxTriangleArea, bbox }
 * @param {{widthLimits?:{min:number,max:number}}} [opts]  幅の許容範囲。既定は河川用（RIVER_WIDTH_LIMITS）。
 *   Mission03 の道路 ribbon は road 用の上限（例 28m）を渡して同じロジックを流用する。
 * @returns {{errors:string[], warns:string[]}}
 */
export function validateRiverRibbon(river, opts = {}) {
  const widthLimits = opts.widthLimits || RIVER_WIDTH_LIMITS;
  const errors = [], warns = [];
  const tag = river.name ? `[${river.name}]` : `[${river.id || '?'}]`;

  const cl = river.centerline || [];
  if (cl.length < 2) { errors.push(`${tag} centerlineが2点未満`); return { errors, warns }; }
  for (const p of cl) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      errors.push(`${tag} centerlineに非有限座標がある`); break;
    }
  }
  for (const arr of [river.left, river.right]) {
    for (const p of (arr || [])) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
        errors.push(`${tag} offset(left/right)に非有限座標がある`); break;
      }
    }
  }

  // width finite / > 0 / 上限内
  if (!Number.isFinite(river.width) || river.width <= 0) {
    errors.push(`${tag} width が不正: ${river.width}`);
  } else if (river.width > widthLimits.max) {
    errors.push(`${tag} width が上限超過: ${river.width}m > ${widthLimits.max}m`);
  } else if (river.width < widthLimits.min) {
    warns.push(`${tag} width が下限未満: ${river.width}m < ${widthLimits.min}m`);
  }

  // [Mission04] 頂点単位の幅列（river.widths）: 全て有限・>0、隣接頂点間の幅比が
  //   2.5倍を超える瞬間jumpは ERROR（指示書11節の「2〜3倍級の瞬間jump」）、1.6倍超は WARN。
  if (Array.isArray(river.widths) && river.widths.length) {
    let badFinite = false, maxJumpRatio = 1;
    for (let i = 0; i < river.widths.length; i++) {
      const w = river.widths[i];
      if (!Number.isFinite(w) || w <= 0) { badFinite = true; break; }
      if (i > 0) {
        const prev = river.widths[i - 1];
        const r = Math.max(w, prev) / Math.max(1e-6, Math.min(w, prev));
        if (r > maxJumpRatio) maxJumpRatio = r;
      }
    }
    if (badFinite) errors.push(`${tag} widths（頂点単位の幅）に非有限/非正の値がある`);
    else if (maxJumpRatio > RIBBON_VALIDATION_LIMITS.widthJumpErrorRatio) {
      errors.push(`${tag} 隣接頂点間で幅が ${maxJumpRatio.toFixed(2)}倍 変化（>${RIBBON_VALIDATION_LIMITS.widthJumpErrorRatio}倍の瞬間jump）`);
    } else if (maxJumpRatio > RIBBON_VALIDATION_LIMITS.widthJumpWarnRatio) {
      warns.push(`${tag} 隣接頂点間で幅が ${maxJumpRatio.toFixed(2)}倍 変化（要目視: >${RIBBON_VALIDATION_LIMITS.widthJumpWarnRatio}倍）`);
    }
  }

  // source line continuity: centerline の隣接点間隔（densify前の間隔を見たいが、ここではdense後の
  // 配列しか無い場合もあるため、密でも疎でも「異常に長い1辺」だけを検出する閾値にする）
  let maxSeg = 0;
  for (let i = 0; i < cl.length - 1; i++) {
    const d = Math.hypot(cl[i + 1][0] - cl[i][0], cl[i + 1][1] - cl[i][1]);
    if (d > maxSeg) maxSeg = d;
  }
  if (maxSeg > RIBBON_VALIDATION_LIMITS.maxSegmentLenM) {
    warns.push(`${tag} centerline最大辺長 ${Math.round(maxSeg)}m > ${RIBBON_VALIDATION_LIMITS.maxSegmentLenM}m（source継ぎ目/欠損の疑い）`);
  }

  // 巨大三角形なし
  if (Number.isFinite(river.maxTriangleArea) && river.maxTriangleArea > RIBBON_VALIDATION_LIMITS.maxTriangleAreaM2) {
    errors.push(`${tag} 巨大三角形: maxTriangleArea=${Math.round(river.maxTriangleArea)}m² > ${RIBBON_VALIDATION_LIMITS.maxTriangleAreaM2}m²`);
  }
  // 三角形の最長辺が異常（数km級の横飛び＝source継ぎ目破綻の疑い）
  if (Number.isFinite(river.maxTriangleEdge) && river.maxTriangleEdge > RIBBON_VALIDATION_LIMITS.maxTriangleEdgeM) {
    errors.push(`${tag} 三角形の最長辺が異常: maxTriangleEdge=${Math.round(river.maxTriangleEdge)}m > ${RIBBON_VALIDATION_LIMITS.maxTriangleEdgeM}m（数km級の横飛びの疑い）`);
  }
  // densify前（生のcenterline）のジャンプ確認（source疎密の検出）。
  //   800m超はWARN（実データで淀川の一部区間が該当。node間隔が疎いだけで、ribbon自体は
  //   maxTriangleEdgeチェックで破綻していないことを別途確認済み＝要目視確認レベル）。
  //   5000m超は1way内の単一区間として非現実的なためERROR（継ぎ目破綻の疑い）。
  if (Number.isFinite(river.rawMaxSegment) && river.rawMaxSegment > RIBBON_VALIDATION_LIMITS.rawJumpErrorM) {
    errors.push(`${tag} centerline生データに巨大ジャンプ: rawMaxSegment=${Math.round(river.rawMaxSegment)}m > ${RIBBON_VALIDATION_LIMITS.rawJumpErrorM}m`);
  } else if (Number.isFinite(river.rawMaxSegment) && river.rawMaxSegment > RIBBON_VALIDATION_LIMITS.rawJumpWarnM) {
    warns.push(`${tag} centerline生データのnode間隔が疎: rawMaxSegment=${Math.round(river.rawMaxSegment)}m > ${RIBBON_VALIDATION_LIMITS.rawJumpWarnM}m（直線区間が実際の川の曲がりと異なる可能性。要目視確認）`);
  }
  // self crossing: 幅方向ベクトル（left[i]-right[i]）が隣接頂点間で反転していないか。
  //   反転＝ribbonの左右が局所的に入れ替わる＝ヘアピン等の鋭角で帯が自己交差する。
  //   河川では稀なため ERROR（severity既定）。道路はランプ/鋭角コーナーが多く、maxTriangleEdge
  //   チェックで巨大三角形が無いことを別途確認できるため、opts.selfCrossingSeverity='warn' を渡す
  //   （局所的な小さいオーバーラップは道路面fillに隠れて実害が小さい＝要目視確認レベル）。
  {
    const L = river.left || [], R = river.right || [];
    const n = Math.min(L.length, R.length);
    const sev = opts.selfCrossingSeverity === 'warn' ? warns : errors;
    let prevW = null;
    for (let i = 0; i < n; i++) {
      const w = [L[i][0] - R[i][0], L[i][1] - R[i][1]];
      if (prevW) {
        const dot = w[0] * prevW[0] + w[1] * prevW[1];
        if (dot < 0) { sev.push(`${tag} i=${i} で幅方向が反転（self crossingの疑い）`); break; }
      }
      prevW = w;
    }
  }

  // ribbon bbox が centerline から異常に離れていないか。
  // 直線ribbonのbbox対角は概ね sqrt(length² + width²) 程度（length>>widthならlengthに漸近、
  // 逆に短い河川ではwidthが支配的になる）。両者の和にslack係数を掛けた値を許容上限とする
  // （centerline長のみと比較すると、短い区間×広い川幅で誤検出するため width も加味する）。
  if (river.bbox) {
    const diag = Math.hypot(river.bbox.maxX - river.bbox.minX, river.bbox.maxZ - river.bbox.minZ);
    const length = polylineLength(cl);
    const width = Number.isFinite(river.width) ? river.width : 0;
    const allowed = (length + width) * RIBBON_VALIDATION_LIMITS.bboxSlackFactor;
    if (length > 0 && diag > allowed && diag > 50) { // 50m未満の極小差は無視
      warns.push(`${tag} bbox対角(${Math.round(diag)}m)が centerline長+width(${Math.round(length + width)}m)×${RIBBON_VALIDATION_LIMITS.bboxSlackFactor}を超過（centerlineから離れたvertexの疑い）`);
    }
  }

  // centerlineから異常に離れたoffset頂点なし（width/2 の許容誤差を大きく超えるものを検出）
  const half = Number.isFinite(river.width) ? river.width / 2 : null;
  if (half != null) {
    const tolerance = Math.max(half * 3, half + 50); // miter clampの上限(maxMiterRatio)を考慮した緩めの許容値
    const n = Math.min(cl.length, (river.left || []).length, (river.right || []).length);
    for (let i = 0; i < n; i++) {
      const dl = Math.hypot(river.left[i][0] - cl[i][0], river.left[i][1] - cl[i][1]);
      const dr = Math.hypot(river.right[i][0] - cl[i][0], river.right[i][1] - cl[i][1]);
      if (dl > tolerance || dr > tolerance) {
        warns.push(`${tag} i=${i} のoffset頂点がcenterlineから異常に離れている(left=${dl.toFixed(1)}m, right=${dr.toFixed(1)}m, tolerance=${tolerance.toFixed(1)}m)`);
        break; // 1件報告すれば十分（同じriverで大量に出さない）
      }
    }
  }

  return { errors, warns };
}

/**
 * [河川再導入・指示書8節] 各riverのribbon bboxが大阪市24区の外接矩形(+margin)に収まっているかを
 * 検証する（尼崎・堺・東大阪方向へ数km伸び続ける表示を防ぐ最終チェック）。
 * centerline source自体は既に24区ward-polygonでクリップ済みだが（tools/lib/polyline-ward-clip.js）、
 * ribbon offset（幅の分だけ外側へ広がる）まで含めた最終形状での確認として独立に持つ。
 * @param {object[]} rivers
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} cityBbox
 * @param {number} [marginM=500] 橋・河口部等でのわずかな逸脱を許容する余白
 */
export function validateCityBboxContainment(rivers, cityBbox, marginM = 500) {
  const violations = [];
  for (const r of rivers) {
    if (!r.bbox) continue;
    const b = r.bbox;
    const outLeft = Math.max(0, cityBbox.minX - marginM - b.minX);
    const outRight = Math.max(0, b.maxX - (cityBbox.maxX + marginM));
    const outTop = Math.max(0, cityBbox.minZ - marginM - b.minZ);
    const outBottom = Math.max(0, b.maxZ - (cityBbox.maxZ + marginM));
    const maxOverflow = Math.max(outLeft, outRight, outTop, outBottom);
    if (maxOverflow > 0) {
      violations.push({ id: r.id, name: r.name, overflowM: Math.round(maxOverflow), bbox: b });
    }
  }
  return { violations, violationCount: violations.length };
}

/**
 * 複数riverをまとめて検証し、集計結果を返す。
 * @param {object[]} rivers  river.riverClass が 'minor' なら minor 用の幅上下限で検証する。
 * @param {{minorWidthLimits?:{min:number,max:number}}} [opts]
 */
export function validateRiverRibbons(rivers, opts = {}) {
  const errors = [], warns = [];
  for (const r of rivers) {
    const perOpts = r.riverClass === 'minor'
      ? { widthLimits: opts.minorWidthLimits || { min: 3, max: 30 }, selfCrossingSeverity: 'warn' }
      : {};
    const res = validateRiverRibbon(r, perOpts);
    errors.push(...res.errors);
    warns.push(...res.warns);
  }
  return { errors, warns, riverCount: rivers.length, errorCount: errors.length, warnCount: warns.length };
}
