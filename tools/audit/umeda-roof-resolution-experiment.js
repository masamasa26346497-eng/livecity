#!/usr/bin/env node
// tools/audit/umeda-roof-resolution-experiment.js
// [Mission 35B §9/§10] 梅田の実 PLATEAU LOD2 678 棟を ground truth にして、
//   「どの地上画素寸法（GSD）から屋根の特徴が読めなくなるか」を測る。
//
//   測るのは検出器の性能ではなく **物理的な上限** である。
//   その解像度で特徴が何画素になるかは、どんなアルゴリズムでも変えられない。
//   判定の基準は Johnson criteria（tools/lib/roof-detectability.js）。
//
//   これは §11 のとおり geometry を作る処理を一切含まない。測るだけ。
//   出力: data/reports/umeda-roof-resolution-experiment.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { UMEDA } from './umeda-roof-evidence.js';
import { footprintShape } from '../lib/umeda-roof-inference.js';
import {
  GSD_STEPS, JOHNSON, SUN_ELEVATION_DEG, SHADOW_COUNTS_FOR, criticalFeatures, judgeAtGsd, sweep,
  findCliff, minimumGsdFor, equivalentSideM,
} from '../lib/roof-detectability.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const OUT = P('data', 'reports', 'umeda-roof-resolution-experiment.json');
export const GT = P('data', 'processed', 'osaka-city', 'umeda-roof', 'groundtruth.json');
export const CANON_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** §9 で測る 4 つの指標に対応する屋根タイプの束。 */
export const METRIC_GROUPS = {
  roofFamily: ['FLAT', 'FLAT_WITH_PENTHOUSE', 'MULTI_LEVEL_FLAT', 'GABLE', 'HIP', 'SHED', 'COMPLEX'],
  ridge: ['GABLE', 'HIP'],
  penthouse: ['FLAT_WITH_PENTHOUSE'],
  multiLevel: ['MULTI_LEVEL_FLAT'],
};
/** 必要最低 GSD を決めるときの目標検出率。 */
export const TARGET_RATES = [0.95, 0.90, 0.85, 0.80];

/** 梅田の canonical footprint を読む。 */
export function loadFootprints() {
  const out = new Map();
  const TILE = 500;
  for (let tx = Math.floor((UMEDA.x - UMEDA.radiusM) / TILE); tx <= Math.floor((UMEDA.x + UMEDA.radiusM) / TILE); tx++) {
    for (let tz = Math.floor((UMEDA.z - UMEDA.radiusM) / TILE); tz <= Math.floor((UMEDA.z + UMEDA.radiusM) / TILE); tz++) {
      const doc = rj(path.join(CANON_DIR, `tile_${tx}_${tz}.json`));
      for (const ft of ((doc && doc.features) || [])) {
        const ring = ft.coordinates && ft.coordinates[0];
        if (ring && ring.length >= 3) out.set(ft.canonicalId, ring);
      }
    }
  }
  return out;
}

/** 分位点。 */
export function pct(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))].toFixed(2);
}

export function run() {
  const t0 = Date.now();
  const gt = rj(GT);
  if (!gt) throw new Error('先に tools/audit/umeda-roof-groundtruth.js を実行する');
  const fps = loadFootprints();

  // ── 各棟の critical dimension ──────────────────────────────────────
  // 「平ら」と言い切るために見えていなければならない大きさは、
  //   ground truth の塔屋の小さいほう（p10）から決める（決め打ちにしない）。
  const penthouseSides = [];
  for (const r of gt.records) {
    if (r.roofType !== 'FLAT_WITH_PENTHOUSE') continue;
    const m = r.metrics || {};
    const planArea = m.totalPlanAreaM2 || r.footprintAreaM2 || 0;
    const top = (m.levels || []).slice(-1)[0];
    const share = r.penthouseShare ?? (top ? top.areaShare : null);
    if (share != null) penthouseSides.push(equivalentSideM(share * planArea));
  }
  const minExcludableM = pct(penthouseSides, 0.10) ?? 3.2;

  const cfs = [];
  let noFootprint = 0;
  for (const r of gt.records) {
    const ring = fps.get(r.canonicalId);
    if (!ring) { noFootprint++; continue; }
    const shape = footprintShape(ring);
    cfs.push(criticalFeatures(r, shape, minExcludableM));
  }

  // ── 特徴の実寸の分布（どれだけ小さいものを相手にしているか）────────
  const dims = {};
  for (const cf of cfs) {
    for (const f of cf.features) {
      const k = cf.roofType + '/' + f.key;
      (dims[k] || (dims[k] = { lengths: [], rises: [], shadows: [] })).lengths.push(f.lengthM);
      if (f.riseM != null) dims[k].rises.push(f.riseM);
      if (f.shadowM) dims[k].shadows.push(f.shadowM);
    }
  }
  const featureSizes = Object.entries(dims).map(([k, v]) => ({
    feature: k, n: v.lengths.length,
    lengthM: { p10: pct(v.lengths, 0.1), median: pct(v.lengths, 0.5), p90: pct(v.lengths, 0.9) },
    riseM: v.rises.length ? { p10: pct(v.rises, 0.1), median: pct(v.rises, 0.5), p90: pct(v.rises, 0.9) } : null,
    shadowM: v.shadows.length ? { median: pct(v.shadows, 0.5) } : null,
  })).sort((a, b) => a.feature.localeCompare(b.feature));

  // ── §10 解像度スイープ ─────────────────────────────────────────────
  const levels = ['detection', 'recognition', 'delineation'];
  const sweeps = {};
  for (const lv of levels) sweeps[lv] = sweep(cfs, GSD_STEPS, lv);

  // ── §9 指標ごと（roof family / ridge / penthouse / multi-level）────
  const byMetric = {};
  for (const [metric, types] of Object.entries(METRIC_GROUPS)) {
    const subset = cfs.filter((c) => types.includes(c.roofType));
    const rec = sweep(subset, GSD_STEPS, 'recognition');
    const del = sweep(subset, GSD_STEPS, 'delineation');
    byMetric[metric] = { n: subset.length,
      recognition: { sweep: rec, cliff: findCliff(rec), minimumGsdM: Object.fromEntries(TARGET_RATES.map((t) => [t, minimumGsdFor(rec, t)])) },
      delineation: { sweep: del, cliff: findCliff(del), minimumGsdM: Object.fromEntries(TARGET_RATES.map((t) => [t, minimumGsdFor(del, t)])) } };
  }

  // ── 手元にある実データの解像度で、何が読めるか ─────────────────────
  const AVAILABLE = [
    { id: 'plateau-2024-ortho', gsdM: 0.45, note: 'PLATEAU 大阪市 2024 オルソ（緯度方向。経度方向は 0.37m）' },
    { id: 'osaka-city-photo', gsdM: 0.50, note: '大阪市航空写真（公開版、全年度共通）' },
    { id: 'gsi-seamlessphoto', gsdM: 0.49, note: '地理院タイル z18（梅田の緯度）' },
  ];
  const atAvailable = AVAILABLE.map((a) => {
    const row = {};
    for (const [metric, types] of Object.entries(METRIC_GROUPS)) {
      const subset = cfs.filter((c) => types.includes(c.roofType));
      let rec = 0, del = 0;
      for (const cf of subset) {
        if (judgeAtGsd(cf, a.gsdM, 'recognition').ok) rec++;
        if (judgeAtGsd(cf, a.gsdM, 'delineation').ok) del++;
      }
      row[metric] = { n: subset.length,
        recognitionRate: subset.length ? +(rec / subset.length).toFixed(4) : null,
        delineationRate: subset.length ? +(del / subset.length).toFixed(4) : null };
    }
    return { ...a, byMetric: row };
  });

  // geometry を起こすのが目的なので、主指標は delineation（輪郭をなぞれるか）。
  const overall = sweeps.delineation;
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35B',
    area: UMEDA, groundTruthCount: gt.records.length, evaluated: cfs.length, noFootprint,
    method: {
      basis: 'Johnson criteria（critical dimension を何画素で見込めるか）',
      thresholdsPx: JOHNSON,
      sunElevationDeg: SUN_ELEVATION_DEG,
      shadowCountsFor: [...SHADOW_COUNTS_FOR],
      minExcludableM,
      note: '影は「何かある」「どれくらい高い」までしか言えず、輪郭はなぞれない。'
        + 'よって影は detection にだけ数え、recognition / delineation には数えない。'
        + 'これはアルゴリズムに依らない上限であり、実際の検出器はこれ以下になる。',
    },
    gsdSteps: GSD_STEPS,
    byRoofType: gt.records.reduce((a, r) => { a[r.roofType] = (a[r.roofType] || 0) + 1; return a; }, {}),
    featureSizes,
    sweeps,
    cliff: findCliff(overall),
    minimumGsdM: Object.fromEntries(TARGET_RATES.map((t) => [t, minimumGsdFor(overall, t)])),
    byMetric,
    atAvailableSources: atAvailable,
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[res-exp] 評価した棟', o.evaluated, '/', o.groundTruthCount, '（footprint 無し', o.noFootprint, '）');
  console.log('[res-exp] 特徴の実寸 (m):');
  for (const f of o.featureSizes) console.log('   ', f.feature.padEnd(32), 'n=' + String(f.n).padStart(3),
    'p10=' + f.lengthM.p10, 'median=' + f.lengthM.median, 'p90=' + f.lengthM.p90,
    f.shadowM ? '影 median=' + f.shadowM.median : '');
  console.log('[res-exp] 「平ら」と言い切るのに要る最小の特徴', o.method.minExcludableM + 'm');
  for (const lv of ['detection', 'recognition', 'delineation']) {
  console.log('[res-exp] 解像度 vs 読み取れる割合（' + lv + ' / 閾値 ' + o.method.thresholdsPx[lv] + 'px）:');
  for (const r of o.sweeps[lv]) console.log('    GSD', String(r.gsdM).padEnd(6), (r.rate * 100).toFixed(1) + '%',
    Object.entries(r.byType).map(([k, v]) => k + ':' + (v.rate * 100).toFixed(0) + '%').join(' ')); }
  console.log('[res-exp] 崖（delineation）', JSON.stringify(o.cliff));
  console.log('[res-exp] 必要最低 GSD', JSON.stringify(o.minimumGsdM));
  for (const [m, v] of Object.entries(o.byMetric)) console.log('   ', m.padEnd(12), 'n=' + String(v.n).padStart(3),
    '認識 GSD', JSON.stringify(v.recognition.minimumGsdM), '輪郭 GSD', JSON.stringify(v.delineation.minimumGsdM));
  console.log('[res-exp] 手元の成果で読める割合:');
  for (const a of o.atAvailableSources) console.log('   ', a.id.padEnd(22), a.gsdM + 'm',
    Object.entries(a.byMetric).map(([k, v]) => k + ' 認識' + (v.recognitionRate == null ? '-' : (v.recognitionRate * 100).toFixed(0) + '%')
      + '/輪郭' + (v.delineationRate == null ? '-' : (v.delineationRate * 100).toFixed(0) + '%')).join('  '));
  console.log('[res-exp] out', OUT);
}
