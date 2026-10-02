// tools/lib/roof-detectability.js
// [Mission 35B §9/§10] 「その解像度で、屋根の特徴が何画素になるか」を出す純粋関数。
//   アルゴリズムに依らない物理的な上限である。数画素も無いものは、どんな検出器でも読めない。
//
//   Johnson criteria（critical dimension を横切る線対数）を段階の基準にする:
//     detection    ≈ 1.5 line pairs =  3 px  「何かある」
//     recognition  ≈ 3.0 line pairs =  6 px  「種類が分かる」
//     delineation  ≈ 6.0 line pairs = 12 px  「輪郭をなぞって geometry を起こせる」
//
//   **影の扱い**（ここを間違えると結論が甘くなる）:
//     立ち上がりが落とす影は「何かある」「どれくらい高い」までは言える。
//     しかし塔屋の輪郭は影からはなぞれない（影は地物の形に、傾いた投影と
//     下の面の凹凸が混ざったものになる）。
//     よって **影は detection にだけ数え、recognition / delineation には数えない**。
//   Mission 35A で実際に起きたこと（平屋根の細分を当てられない）と整合する。

export const JOHNSON = { detection: 3, recognition: 6, delineation: 12 };
/** 影を根拠に使ってよい段階。 */
export const SHADOW_COUNTS_FOR = new Set(['detection']);
/** §10 で測る解像度。 */
export const GSD_STEPS = [0.10, 0.125, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.80, 1.00];
/** 影の長さを出すときの太陽高度。大阪市の航空写真は 1 月撮影なので冬季を見込んで 35°。 */
export const SUN_ELEVATION_DEG = 35;
/**
 * 「平らである」と言い切るには、**無いことを確かめる対象** が見えていなければならない。
 * その大きさは ground truth の塔屋の小さいほう（p10）を使う。走査時に上書きされる。
 */
export const DEFAULT_MIN_EXCLUDABLE_M = 3.2;

/** 面積 [m2] を正方形とみなした 1 辺 [m]。特徴の「太さ」の代表値。 */
export function equivalentSideM(areaM2) {
  return areaM2 > 0 ? Math.sqrt(areaM2) : 0;
}
/** 高さ h の立ち上がりが落とす影の長さ [m]。 */
export function shadowLengthM(riseM, sunElevationDeg = SUN_ELEVATION_DEG) {
  if (!(riseM > 0)) return 0;
  return riseM / Math.tan((sunElevationDeg * Math.PI) / 180);
}
/** 長さ [m] を、その解像度での画素数にする。 */
export function pxAt(lengthM, gsdM) {
  return gsdM > 0 ? lengthM / gsdM : 0;
}

/**
 * 1 棟について、屋根タイプの判別に効く critical dimension を出す。
 * @param {object} r ground truth の 1 レコード
 * @param {{longM:number, shortM:number}|null} shape footprint の OBB
 * @param {number} minExcludableM 「無いことを確かめる」対象の大きさ
 */
export function criticalFeatures(r, shape, minExcludableM = DEFAULT_MIN_EXCLUDABLE_M) {
  const m = r.metrics || {};
  const planArea = m.totalPlanAreaM2 || r.footprintAreaM2 || 0;
  const out = { canonicalId: r.canonicalId, roofType: r.roofType,
    footprintAreaM2: r.footprintAreaM2 ?? null,
    obbLongM: shape ? +shape.longM.toFixed(2) : null,
    obbShortM: shape ? +shape.shortM.toFixed(2) : null,
    features: [] };
  const add = (key, lengthM, riseM, why) => {
    if (!(lengthM > 0)) return;
    out.features.push({ key, lengthM: +lengthM.toFixed(2),
      riseM: riseM != null ? +riseM.toFixed(2) : null,
      shadowM: riseM != null ? +shadowLengthM(riseM).toFixed(2) : null, why });
  };

  if (r.roofType === 'FLAT_WITH_PENTHOUSE') {
    const levels = m.levels || [];
    const top = levels.length ? levels[levels.length - 1] : null;
    const share = r.penthouseShare ?? (top ? top.areaShare : null);
    const rise = r.penthouseRiseM ?? (levels.length >= 2 ? levels[levels.length - 1].y - levels[0].y : null);
    if (share != null) add('penthouse', equivalentSideM(share * planArea), rise, '塔屋の平面の広がり');
  } else if (r.roofType === 'MULTI_LEVEL_FLAT') {
    const levels = m.levels || [];
    const minShare = levels.length ? Math.min(...levels.map((l) => l.areaShare)) : null;
    const rise = levels.length >= 2 ? levels[levels.length - 1].y - levels[0].y : null;
    if (minShare != null) add('smallestLevel', equivalentSideM(minShare * planArea), rise, '一番小さい段の広がり');
  } else if (r.roofType === 'GABLE' || r.roofType === 'HIP') {
    if (shape) {
      add('ridgeLength', shape.longM, m.roofSpreadM ?? null, '棟の長さ');
      add('slopeRun', shape.shortM / 2, m.roofSpreadM ?? null, '片面の流れ方向の長さ');
    }
  } else if (r.roofType === 'SHED') {
    if (shape) add('slopeRun', shape.shortM, m.roofSpreadM ?? null, '流れ方向の長さ');
  } else if (r.roofType === 'FLAT') {
    // 「平ら」は不在の主張。塔屋や段が **無い** ことを確かめられる必要がある。
    // 建物が大きいことは根拠にならない。
    add('excludeSmallFeature', Math.min(minExcludableM, shape ? shape.shortM : minExcludableM), null,
      '塔屋・段が無いと言い切るために見えていなければならない大きさ');
  } else {
    // COMPLEX。複数の面を別々に読めることが要る。面の数で割った代表寸法。
    const planes = m.slopeDirections || m.levelCount || 3;
    if (shape) add('componentPlane', Math.sqrt((r.footprintAreaM2 || planArea) / Math.max(2, planes)), m.roofSpreadM ?? null, '構成面 1 枚の広がり');
  }
  return out;
}

/**
 * ある解像度で、その棟の屋根タイプを読み取れるか。
 * critical dimension のうち一番厳しいもので決める（一番読みにくい特徴が律速）。
 * 影は detection のときだけ根拠に数える。
 */
export function judgeAtGsd(cf, gsdM, level = 'recognition') {
  const need = JOHNSON[level];
  if (need == null) throw new Error('不明な段階: ' + level);
  if (!cf.features.length) return { ok: false, reason: 'no-critical-feature', minPx: null, needPx: need };
  const useShadow = SHADOW_COUNTS_FOR.has(level);
  let minPx = Infinity, worst = null;
  for (const f of cf.features) {
    const objPx = pxAt(f.lengthM, gsdM);
    const px = useShadow && f.shadowM ? Math.max(objPx, pxAt(f.shadowM, gsdM)) : objPx;
    if (px < minPx) { minPx = px; worst = f.key; }
  }
  return { ok: minPx >= need, minPx: +minPx.toFixed(2), limitingFeature: worst, needPx: need, usedShadow: useShadow };
}

/** 全棟・全解像度で集計する。 */
export function sweep(records, gsdSteps = GSD_STEPS, level = 'recognition') {
  const rows = [];
  for (const g of gsdSteps) {
    const byType = {};
    let ok = 0;
    for (const cf of records) {
      const j = judgeAtGsd(cf, g, level);
      const t = byType[cf.roofType] || (byType[cf.roofType] = { n: 0, ok: 0 });
      t.n++; if (j.ok) { t.ok++; ok++; }
    }
    for (const t of Object.values(byType)) t.rate = +(t.ok / t.n).toFixed(4);
    rows.push({ gsdM: g, n: records.length, ok, rate: records.length ? +(ok / records.length).toFixed(4) : 0, byType });
  }
  return rows;
}

/** 検出率が最も急に落ちる区間（＝崖）。 */
export function findCliff(sweepRows) {
  let best = null;
  for (let i = 1; i < sweepRows.length; i++) {
    const drop = sweepRows[i - 1].rate - sweepRows[i].rate;
    if (!best || drop > best.drop) {
      best = { drop: +drop.toFixed(4), fromGsdM: sweepRows[i - 1].gsdM, toGsdM: sweepRows[i].gsdM,
        fromRate: sweepRows[i - 1].rate, toRate: sweepRows[i].rate };
    }
  }
  return best;
}

/** 目標の検出率を満たす一番粗い解像度（＝必要最低 GSD）。満たす段が無ければ null。 */
export function minimumGsdFor(sweepRows, targetRate) {
  let best = null;
  for (const r of sweepRows) if (r.rate >= targetRate && (!best || r.gsdM > best.gsdM)) best = r;
  return best ? best.gsdM : null;
}
