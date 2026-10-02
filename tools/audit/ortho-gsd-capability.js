#!/usr/bin/env node
// tools/audit/ortho-gsd-capability.js
// [Mission 35C §7/§8] 35C で実測した各オルソの GSD を、35B の解像度実験（梅田の実 LOD2 678 棟）
//   にそのまま当てて、「その成果で屋根の輪郭を何割なぞれるか」を出す。
//   §9 のとおり geometry は作らない。測るだけ。
//   出力: data/reports/ortho-gsd-capability.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { UMEDA } from './umeda-roof-evidence.js';
import { footprintShape } from '../lib/umeda-roof-inference.js';
import { criticalFeatures, judgeAtGsd, equivalentSideM } from '../lib/roof-detectability.js';
import { METRIC_GROUPS, loadFootprints, pct, GT } from './umeda-roof-resolution-experiment.js';
import { OUT as AUDIT_OUT } from './plateau-ortho-gsd-audit.js';
import { classifyGsd } from './umeda-aerial-source-probe.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const OUT = P('data', 'reports', 'ortho-gsd-capability.json');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** 35B で確定済みの成果（35C の実測と並べる）。 */
export const BASELINE_SOURCES = [
  { id: 'plateau-2024', label: 'PLATEAU 2024 配布 / オルソ', gsdM: 0.4529 },
  { id: 'gsi-seamlessphoto', label: '地理院タイル seamlessphoto・ort（z18）', gsdM: 0.4909 },
  { id: 'osaka-city-0.50', label: '大阪市航空写真（公開版・全 18 年度）', gsdM: 0.50 },
];
/** 目標。35B の結論。 */
export const TARGET_GSD_M = 0.20;

export function buildCriticalFeatures() {
  const gt = rj(GT);
  if (!gt) throw new Error('先に tools/audit/umeda-roof-groundtruth.js を実行する');
  const fps = loadFootprints();
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
  for (const r of gt.records) {
    const ring = fps.get(r.canonicalId);
    if (!ring) continue;
    cfs.push(criticalFeatures(r, footprintShape(ring), minExcludableM));
  }
  return { cfs, minExcludableM, groundTruthCount: gt.records.length };
}

export function evaluateAt(cfs, gsdM) {
  const row = {};
  for (const [metric, types] of Object.entries(METRIC_GROUPS)) {
    const subset = cfs.filter((c) => types.includes(c.roofType));
    let rec = 0, del = 0;
    for (const cf of subset) {
      if (judgeAtGsd(cf, gsdM, 'recognition').ok) rec++;
      if (judgeAtGsd(cf, gsdM, 'delineation').ok) del++;
    }
    row[metric] = { n: subset.length,
      recognitionRate: subset.length ? +(rec / subset.length).toFixed(4) : null,
      delineationRate: subset.length ? +(del / subset.length).toFixed(4) : null };
  }
  return row;
}

export function run() {
  const t0 = Date.now();
  const { cfs, minExcludableM, groundTruthCount } = buildCriticalFeatures();
  const audit = rj(AUDIT_OUT);
  const measured = [];
  for (const r of ((audit && audit.archives) || [])) {
    for (const s of (r.sets || [])) {
      if (!s.umeda || !s.umeda.gsdStats) continue;
      measured.push({ id: r.id + (s.set === '(single)' ? '' : '/' + s.set),
        label: `PLATEAU ${r.year} 配布 / 撮影 ${s.captureFiscalYear} 年度`,
        gsdXm: s.umeda.gsdXStats.median, gsdYm: s.umeda.gsdYStats.median,
        gsdM: s.umeda.gsdStats.median, measuredIn: '35C' });
    }
  }
  const all = [...measured, ...BASELINE_SOURCES.map((b) => ({ ...b, measuredIn: '35B' })),
    { id: 'target', label: '35B が推奨する最低 GSD', gsdM: TARGET_GSD_M, measuredIn: '35B（目標）' }];

  const rows = all.map((s) => ({ ...s, gsdClass: classifyGsd(s.gsdM), byMetric: evaluateAt(cfs, s.gsdM) }))
    .sort((a, b) => a.gsdM - b.gsdM);

  const best = rows.filter((r) => r.id !== 'target').reduce((a, b) => (a.gsdM <= b.gsdM ? a : b));
  const target = rows.find((r) => r.id === 'target');
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35C',
    area: UMEDA, groundTruthCount, evaluated: cfs.length, minExcludableM,
    targetGsdM: TARGET_GSD_M,
    note: '判定は 35B と同じ Johnson criteria。recognition=6px で「種類が分かる」、delineation=12px で「輪郭をなぞって geometry を起こせる」。',
    rows,
    best: { id: best.id, gsdM: best.gsdM, gsdClass: best.gsdClass,
      roofFamilyDelineation: best.byMetric.roofFamily.delineationRate,
      penthouseDelineation: best.byMetric.penthouse.delineationRate },
    target: { gsdM: target.gsdM, roofFamilyDelineation: target.byMetric.roofFamily.delineationRate },
    gapVsTarget: +(target.byMetric.roofFamily.delineationRate - best.byMetric.roofFamily.delineationRate).toFixed(4),
    geometryGenerated: false,
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[cap] 梅田の実 LOD2', o.evaluated, '棟で判定');
  console.log('[cap] GSD       class  roof family        ridge            penthouse         multi-level   （認識 / 輪郭）');
  for (const r of o.rows) {
    const f = (m) => `${(m.recognitionRate * 100).toFixed(0)}%/${(m.delineationRate * 100).toFixed(0)}%`.padEnd(10);
    console.log('   ', String(r.gsdM).padEnd(8), r.gsdClass, '  ',
      f(r.byMetric.roofFamily), '      ', f(r.byMetric.ridge), '     ', f(r.byMetric.penthouse), '     ', f(r.byMetric.multiLevel), ' | ', r.label);
  }
  console.log('[cap] 手元の最良', o.best.id, o.best.gsdM + 'm', '→ 屋根の輪郭', (o.best.roofFamilyDelineation * 100).toFixed(0) + '%');
  console.log('[cap] 目標', o.target.gsdM + 'm', '→', (o.target.roofFamilyDelineation * 100).toFixed(0) + '%',
    '（差 ' + (o.gapVsTarget * 100).toFixed(0) + ' pt）');
  console.log('[cap] out', OUT);
}
