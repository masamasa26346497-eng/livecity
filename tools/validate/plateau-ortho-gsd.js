#!/usr/bin/env node
// tools/validate/plateau-ortho-gsd.js
// [Mission 35C §2/§6/§7/§9] PLATEAU 2020 / 2022 オルソの GSD 調査を検証する。
//   - §2 repo 内の raw data を消していない / 上書きしていない
//   - §4 地理座標系の度→m 変換をしている
//   - §6 A/B/C/D の分類
//   - §7 判定と「無料データだけで次へ進めるか」YES/NO
//   - §9 屋根 geometry を作っていない
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { classifyGsd, GSD_CLASS } from '../audit/umeda-aerial-source-probe.js';
import { OUT as AUDIT_OUT, EXTRACT_ROOT } from '../audit/plateau-ortho-gsd-audit.js';
import { WORK_DIR } from '../download/plateau-ortho-archive.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  audit: AUDIT_OUT,
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  roofs: P('public', 'map-data', 'osaka-city', 'derived-umeda-inferred-roof', 'inferred-roofs.json'),
  build35a: P('data', 'reports', 'umeda-inferred-roof-build.json'),
  val35a: P('data', 'reports', 'umeda-inferred-roof-validation.json'),
  prodBuild: P('data', 'reports', 'production-cutover-build.json'),
  baseline: P('data', 'reports', 'baselines', 'prod-protected-hashes.json'),
  rawRoot: P('data', 'raw'),
  out: P('data', 'reports', 'plateau-ortho-gsd-validation.json'),
};
/** §9 35A で作った屋根は 1 棟。35C は調査のみなので増減してはならない。 */
export const EXPECTED_GENERATED_ROOFS = 1;
/** §11(35B) の品質基準。下げてはならない。 */
export const QUALITY_GATE_35A = { roofTypeAccuracy: 0.85, ridgeMedianDeg: 10, roofIoUMedian: 0.85 };
/** §2 作業用のファイルは repo の外に置く。 */
export const REQUIRED_OUTSIDE_REPO = [WORK_DIR, EXTRACT_ROOT];

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };

/** そのパスが repo の中にあるか。 */
export function isInsideRepo(p) {
  const root = path.resolve(resolveProjectPath('.'));
  const rel = path.relative(root, path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function validatePlateauOrthoGsd() {
  const errors = [], warnings = [];
  const a = rj(F.audit);
  if (!a) errors.push('§3: plateau-ortho-gsd-audit.json が無い。先に監査を実行する');

  // ── §2 repo の外で作業している ─────────────────────────────────────
  const outsideRepo = REQUIRED_OUTSIDE_REPO.map((p) => ({ path: p, insideRepo: isInsideRepo(p) }));
  for (const o of outsideRepo) if (o.insideRepo) errors.push('§2: 作業用フォルダが repo の中にある: ' + o.path);

  // ── §2 repo 内の raw data を消していない ───────────────────────────
  //   35B までに置いた梅田の probe 成果が残っていること。
  const probeDir = P('data', 'raw', 'osaka-city', 'aerial-probe');
  const probeFiles = fs.existsSync(probeDir) ? fs.readdirSync(probeDir).length : 0;
  const rawIntact = fs.existsSync(F.rawRoot) && probeFiles > 0;
  if (!rawIntact) errors.push('§2: repo 内の raw data（data/raw/osaka-city/aerial-probe）が見当たらない');
  // 今回のアーカイブが repo 内へ紛れ込んでいないこと
  let strayArchives = [];
  try {
    const walk = (d, depth = 0) => {
      if (depth > 4) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f, depth + 1);
        else if (/\.7z$/i.test(e.name)) strayArchives.push(path.relative(resolveProjectPath('.'), f));
      }
    };
    walk(F.rawRoot);
  } catch { /* noop */ }
  if (strayArchives.length) errors.push('§2: repo 内に 7z が置かれている ' + strayArchives.join(','));

  // ── §3/§4 ヘッダから測っている / 度→m 変換をしている ───────────────
  const sets = a ? a.archives.flatMap((r) => (r.sets || []).map((s) => ({ archive: r.id, ...s }))) : [];
  const headerDerived = sets.some((s) => s.headersRead > 0);
  if (!headerDerived) errors.push('§3: GeoTIFF ヘッダを 1 枚も読めていない');
  const geographicSets = sets.filter((s) => (s.crsKind || []).includes('geographic'));
  const degreeConverted = geographicSets.every((s) => {
    const h = (s.headers || []).find((x) => x.crsKind === 'geographic' && x.modelPixelScale && x.modelPixelScale[0] != null);
    if (!h) return true;
    // 度のままなら 1e-5 未満の値になる。m へ直っていれば 0.01〜10 の範囲に入る。
    return h.modelPixelScale[0] < 1e-4 && h.gsdXm > 0.01 && h.gsdXm < 10;
  });
  if (!degreeConverted) errors.push('§4: 地理座標系の度→m 変換ができていない');

  // ── §6 分類 ────────────────────────────────────────────────────────
  const classified = sets.length > 0 && sets.every((s) => s.gsdClass == null || GSD_CLASS.some((g) => g.cls === s.gsdClass));
  if (!classified) errors.push('§6: A/B/C/D の分類が付いていない');
  const classMatchesGsd = sets.every((s) => !s.umeda || !s.umeda.gsdStats
    || s.umeda.gsdClass === classifyGsd(s.umeda.gsdStats.median));
  if (!classMatchesGsd) errors.push('§6: 分類が GSD と合っていない');

  // ── §5 梅田 coverage ───────────────────────────────────────────────
  const umedaCoverage = sets.map((s) => ({ archive: s.archive, set: s.set,
    captureFiscalYear: s.captureFiscalYear, meshes: s.umeda ? s.umeda.count : 0,
    min: s.umeda && s.umeda.gsdStats ? s.umeda.gsdStats.min : null,
    median: s.umeda && s.umeda.gsdStats ? s.umeda.gsdStats.median : null,
    max: s.umeda && s.umeda.gsdStats ? s.umeda.gsdStats.max : null,
    gsdClass: s.umeda ? s.umeda.gsdClass : null }));
  for (const u of umedaCoverage) {
    if (!u.meshes) errors.push(`§5: ${u.archive}/${u.set} で梅田を覆う画像が 0 枚`);
    // 梅田 PoC 範囲（約 1.4km × 1.25km）は 3 次メッシュ 2〜6 枚に収まる
    else if (u.meshes > 6) warnings.push(`§5: ${u.archive}/${u.set} の梅田該当が ${u.meshes} 枚。メッシュ範囲の計算を見直す`);
  }

  // ── §7 判定 ────────────────────────────────────────────────────────
  const decision = a ? a.decision : null;
  if (!decision) errors.push('§7: 判定が無い');
  else {
    const best = decision.classes.length ? decision.classes.reduce((x, y) => (x.gsdM <= y.gsdM ? x : y)) : null;
    const expectVerdict = !best ? null
      : best.cls === 'A' ? 'A' : best.cls === 'B' ? 'B' : 'C/D';
    if (expectVerdict && decision.verdict !== expectVerdict) {
      errors.push(`§7: 判定が実測と合わない（最良 ${best.gsdM}m = ${best.cls} なのに ${decision.verdict}）`);
    }
    const expectFree = decision.verdict === 'C/D' ? 'NO' : 'YES';
    if (decision.freeDataSufficient !== expectFree) errors.push('§7: YES/NO が判定と合っていない');
  }

  // ── §8 比較に 5 つ揃っているか ─────────────────────────────────────
  const cmpIds = a ? a.comparison.map((c) => c.id) : [];
  const needCompare = ['plateau-2024', 'osaka-city-0.50', 'gsi-seamlessphoto'];
  const comparisonComplete = needCompare.every((n) => cmpIds.includes(n))
    && cmpIds.some((c) => c.startsWith('plateau-2020')) && cmpIds.some((c) => c.startsWith('plateau-2022'));
  if (!comparisonComplete) errors.push('§8: 比較一覧に 2020 / 2022 / 2024 / 大阪市 / GSI が揃っていない: ' + cmpIds.join(','));

  // ── §9 geometry を作っていない ─────────────────────────────────────
  const roofs = rj(F.roofs);
  const roofCount = roofs ? (roofs.buildings || []).length : null;
  const geometryUnchanged = roofCount === EXPECTED_GENERATED_ROOFS;
  if (!geometryUnchanged) errors.push(`§9: 推定屋根の数が ${EXPECTED_GENERATED_ROOFS} から変わっている: ${roofCount}`);
  const b35 = rj(F.build35a);
  if (b35 && b35.stats && b35.stats.generated !== EXPECTED_GENERATED_ROOFS) errors.push('§9: 35A のビルド結果が変わっている');
  const v35 = rj(F.val35a);
  const q = v35 && v35.evaluation ? v35.evaluation.quality : null;
  const qualityGateUnchanged = !!(q && q.roofTypeAccuracy === QUALITY_GATE_35A.roofTypeAccuracy
    && q.ridgeMedianDeg === QUALITY_GATE_35A.ridgeMedianDeg && q.roofIoUMedian === QUALITY_GATE_35A.roofIoUMedian);
  if (!qualityGateUnchanged) errors.push('§9: 品質基準が変わっている');
  const devHtml = fs.readFileSync(F.dev, 'utf-8');
  if (/35C/.test(devHtml)) errors.push('§9: dev HTML に 35C の変更が入っている（今回は調査のみ）');

  // ── production / protected ─────────────────────────────────────────
  const prodBuild = rj(F.prodBuild) || {};
  const baseline = rj(F.baseline) || {};
  const productionModified = prodBuild.productionSha256 ? sha(F.prod) !== prodBuild.productionSha256 : null;
  const protectedModified = baseline.prot ? sha(F.prot) !== baseline.prot : null;
  if (productionModified !== false) errors.push('production HTML が変更されている');
  if (protectedModified !== false) errors.push('protected HTML が変更されている');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35C', RESULT,
    classification: errors.length ? 'ORTHO_GSD_AUDIT_FAILED' : 'ORTHO_GSD_AUDIT_SUCCESS',
    freeDataSufficient: decision ? decision.freeDataSufficient : null,
    verdict: decision ? decision.verdict : null,
    action: decision ? decision.action : null,
    outsideRepo, rawIntact, strayArchives,
    headerDerived, degreeConverted, classified, classMatchesGsd, comparisonComplete,
    umedaCoverage,
    comparison: a ? a.comparison : null,
    geometryUnchanged, generatedRoofs: roofCount, qualityGateUnchanged,
    productionModified, protectedModified,
    errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validatePlateauOrthoGsd().then((o) => {
    console.log(JSON.stringify(o, null, 2));
    process.exit(o.RESULT === 'PASS' ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
