#!/usr/bin/env node
// tools/audit/umeda-stereo-and-scan-analysis.js
// [Mission 35B §5/§6/§7/§8] 「400dpi だから高解像度」という判断を排し、
//   撮影縮尺から地上画素寸法を計算する。あわせてステレオ復元で何が得られるかを、
//   重複率・基線高度比・視差測定精度から数値で出す。
//   さらに、オルソから取れるもの（§7）とステレオから取れるもの（§8）を、
//   §9/§10 の解像度実験の結果と突き合わせて判定する。
//   出力: data/reports/umeda-stereo-and-scan-analysis.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { scannedPhotoGsd, stereoHeightPrecision, baseHeightFromOverlap } from '../lib/gsi-tile-probe.js';
import { classifyGsd } from './umeda-aerial-source-probe.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const OUT = P('data', 'reports', 'umeda-stereo-and-scan-analysis.json');
export const RES_EXP = P('data', 'reports', 'umeda-roof-resolution-experiment.json');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** 日本の空中写真でよく使われる撮影縮尺。 */
export const PHOTO_SCALES = [4000, 6000, 8000, 10000, 12500, 15000, 20000, 25000, 30000, 40000];
/** スキャン解像度の候補。無料配布は 400dpi が多い。 */
export const SCAN_DPI = [200, 400, 600, 800, 1200, 1600];
/** ステレオの前提。日本の公共測量の標準的な値。 */
export const STEREO_ASSUMPTIONS = {
  forwardOverlap: 0.60, sideOverlap: 0.30,
  fieldAngleDeg: 74,                 // 広角カメラ（f=152mm / 23cm 判）相当
  parallaxPx: [0.3, 0.5, 1.0],       // 自動マッチングの視差測定精度
};
/** §8 で必要になる高さの精度。ground truth の実測から決める。 */
export const HEIGHT_NEEDS = [
  { id: 'penthouse', label: '塔屋の立ち上がり', needSigmaM: 0.5,
    why: '塔屋かどうかは 1.5m 以上の立ち上がりで判定している（35A の CLASSIFY.penthouseMinRiseM）。'
      + 'その 1/3 を測れないと判定が揺れる' },
  { id: 'multiLevelStep', label: '段差', needSigmaM: 0.35,
    why: '段の判定は 1.0m 刻みで束ねている（levelBinM）。その 1/3' },
  { id: 'roofPitch', label: '勾配', needSigmaM: 0.25,
    why: '勾配 30° を ±5° で当てるには、短辺 5m の棟で 0.25m 程度の高さ精度が要る' },
];

/** §5 スキャン解像度 × 撮影縮尺 の地上画素寸法表。 */
export function scanTable(scales = PHOTO_SCALES, dpis = SCAN_DPI) {
  return scales.map((s) => ({
    photoScale: '1:' + s.toLocaleString('en-US'),
    scaleDenom: s,
    byDpi: Object.fromEntries(dpis.map((d) => {
      const g = scannedPhotoGsd(s, d);
      return [d, { gsdM: +g.toFixed(3), gsdClass: classifyGsd(g) }];
    })),
  }));
}

/** ある GSD を達成するのに要るスキャン解像度 [dpi]。 */
export function dpiNeededFor(scaleDenom, targetGsdM) {
  // gsd = (25.4/dpi) * scale / 1000  →  dpi = 25.4 * scale / (gsd * 1000)
  return Math.ceil((25.4 * scaleDenom) / (targetGsdM * 1000));
}

/** §6 ステレオで得られる高さ精度の表。 */
export function stereoTable(gsdList, a = STEREO_ASSUMPTIONS) {
  const bh = baseHeightFromOverlap(a.forwardOverlap, a.fieldAngleDeg);
  return {
    baseHeightRatio: +bh.toFixed(3),
    forwardOverlap: a.forwardOverlap, sideOverlap: a.sideOverlap, fieldAngleDeg: a.fieldAngleDeg,
    rows: gsdList.map((g) => ({
      gsdM: g,
      sigmaHeightM: Object.fromEntries(a.parallaxPx.map((p) => [p, +stereoHeightPrecision(g, bh, p).toFixed(3)])),
    })),
  };
}

/** その高さ精度で §8 の用途を満たせるか。 */
export function judgeHeightNeeds(sigmaM) {
  return HEIGHT_NEEDS.map((h) => ({ ...h, sigmaM: +sigmaM.toFixed(3), ok: sigmaM <= h.needSigmaM }));
}

export function run() {
  const t0 = Date.now();
  const res = rj(RES_EXP);
  const scans = scanTable();
  const gsdList = res ? res.gsdSteps : [0.1, 0.2, 0.3, 0.5, 1.0];
  const stereo = stereoTable(gsdList);

  // §5 400dpi で class A/B に届く撮影縮尺はどれか
  const at400 = scans.filter((s) => s.byDpi[400].gsdClass === 'A' || s.byDpi[400].gsdClass === 'B')
    .map((s) => s.photoScale);
  // 0.20m を 400dpi で得るのに必要な撮影縮尺
  const scaleNeededAt400 = Math.floor((0.20 * 1000) / (25.4 / 400));

  // §7 オルソから取れるもの（解像度実験の delineation を根拠にする）
  const del = res ? res.byMetric : null;
  const orthoCapability = [
    { item: 'roof outer outline', dependsOn: 'roofFamily', note: '建物の外形は footprint（canonical）で既に持っている。オルソで足すのは屋根面の内訳' },
    { item: 'ridge line', dependsOn: 'ridge' },
    { item: 'roof orientation', dependsOn: 'ridge' },
    { item: 'visible penthouse outline', dependsOn: 'penthouse' },
    { item: 'roof color boundaries', dependsOn: 'roofFamily', note: '色境界は形の証拠にならない。面の切れ目の手がかりにはなる' },
    { item: 'setback outline', dependsOn: 'multiLevel' },
  ].map((c) => {
    const m = del && del[c.dependsOn];
    return { ...c, n: m ? m.n : null,
      minimumGsdM95: m ? m.delineation.minimumGsdM['0.95'] : null,
      minimumGsdM90: m ? m.delineation.minimumGsdM['0.9'] : null,
      atAvailable045: res ? (res.atAvailableSources.find((a) => a.id === 'plateau-2024-ortho') || {}).byMetric?.[c.dependsOn]?.delineationRate ?? null : null };
  });

  // §8 ステレオから取れるもの
  const stereoCapability = gsdList.map((g) => {
    const s = stereo.rows.find((r) => r.gsdM === g);
    const sigma = s.sigmaHeightM[0.5];
    return { gsdM: g, sigmaHeightM: sigma, needs: judgeHeightNeeds(sigma),
      allNeedsMet: judgeHeightNeeds(sigma).every((h) => h.ok) };
  });
  const stereoMinGsd = stereoCapability.filter((c) => c.allNeedsMet).map((c) => c.gsdM);

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35B',
    scan: {
      note: '400dpi は「高解像度」を意味しない。地上画素寸法は撮影縮尺で決まる。',
      table: scans,
      classAorBAt400dpi: at400,
      scaleNeededForGsd020At400dpi: at400.length ? null : `1:${scaleNeededAt400.toLocaleString('en-US')} より大きい縮尺（実運用にはほぼ存在しない）`,
      dpiNeededForGsd020: Object.fromEntries(PHOTO_SCALES.map((s) => [`1:${s}`, dpiNeededFor(s, 0.20)])),
      dpiNeededForGsd025: Object.fromEntries(PHOTO_SCALES.map((s) => [`1:${s}`, dpiNeededFor(s, 0.25)])),
    },
    stereo: { assumptions: STEREO_ASSUMPTIONS, ...stereo,
      heightNeeds: HEIGHT_NEEDS, capability: stereoCapability,
      gsdMeetingAllHeightNeeds: stereoMinGsd.length ? Math.max(...stereoMinGsd) : null },
    orthoCapability,
    resolutionExperimentUsed: !!res,
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[scan] 撮影縮尺 × スキャン dpi → 地上画素寸法 [m]');
  console.log('        ' + SCAN_DPI.map((d) => String(d).padStart(7)).join(''));
  for (const s of o.scan.table) {
    console.log('  ' + s.photoScale.padEnd(8) + SCAN_DPI.map((d) => (s.byDpi[d].gsdM.toFixed(2) + s.byDpi[d].gsdClass).padStart(7)).join(''));
  }
  console.log('[scan] 400dpi で class A/B になる撮影縮尺:', o.scan.classAorBAt400dpi.length ? o.scan.classAorBAt400dpi.join(', ') : 'なし');
  console.log('[scan] 0.20m を得るのに要る dpi:', JSON.stringify(o.scan.dpiNeededForGsd020));
  console.log('[stereo] 基線高度比 B/H =', o.stereo.baseHeightRatio, '（重複 60%）');
  for (const c of o.stereo.capability) console.log('   GSD', String(c.gsdM).padEnd(6), 'σh=' + c.sigmaHeightM + 'm',
    c.needs.map((n) => n.id + (n.ok ? '○' : '×')).join(' '));
  console.log('[stereo] すべての高さ要求を満たす一番粗い GSD:', o.stereo.gsdMeetingAllHeightNeeds);
  console.log('[ortho] 用途ごとの必要 GSD（輪郭をなぞれること）:');
  for (const c of o.orthoCapability) console.log('   ', c.item.padEnd(26), '95%:' + c.minimumGsdM95 + 'm', '90%:' + c.minimumGsdM90 + 'm',
    '0.45m での達成率:' + (c.atAvailable045 == null ? '-' : (c.atAvailable045 * 100).toFixed(0) + '%'));
  console.log('[out]', OUT);
}
