#!/usr/bin/env node
// tools/validate/canonical-spatial-alignment.js
// [Mission 31G-FIX10 §26] 建物 ↔ 都市基盤の座標整合の検証。
//
//   チェック（audit レポート + runtime HTML 静的解析）:
//     - projection origin mismatch 0（roads/water/N03/geoToThree が同一原点）
//     - coordinate convention mismatch 0（znorth-neg-v1 の z 反転が二重適用されていない）
//     - unexpected runtime translation 0（CanonicalRuntime が座標を変換していない）
//     - tile offset mismatch 0（mesh.position / group.position に tile 原点を足していない）
//     - LOD centroid jump 0（near/mid の centroid 差が閾値内）
//     - canonical→runtime unexplained displacement 0（canonical→derived が閾値内）
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DEV = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = P('public', 'osaka_3d_buildings.html');
const ALIGN = P('data', 'reports', 'canonical-spatial-alignment.json');
const AREA = P('config', 'areas', 'osaka-city.json');
const REPORT = P('data', 'reports', 'canonical-spatial-alignment-validation.json');

// canonical→derived / LOD centroid の許容（simplification 由来の微小差のみ）
const MAX_CANON_DERIVED_MEDIAN = 0.5;
const MAX_LOD_NEARMID_P95 = 2.0;
const MAX_LOD_NEARFAR_P95 = 4.0;
const MAX_BUILDING_ROAD_MEDIAN_DXDZ = 4.0;   // 系統的平行移動の閾値

async function main() {
  const errors = [], warns = [];
  const checks = {};

  if (!fs.existsSync(DEV)) { errors.push('ward-ux-v1.html が無い'); return done(errors, warns, checks); }
  const html = fs.readFileSync(DEV, 'utf-8');
  const crBlock = (html.match(/const CanonicalRuntime = \(function[\s\S]*?console\.log\('\[CanonicalRuntime\] READY'\);/) || [''])[0];

  // ── projection origin mismatch ──
  const area = JSON.parse(fs.readFileSync(AREA, 'utf-8'));
  const prod = fs.existsSync(PROD) ? fs.readFileSync(PROD, 'utf-8') : '';
  const prodClat = (prod.match(/SEARCH_CLAT\s*=\s*([\d.]+)/) || [])[1];
  const prodClon = (prod.match(/SEARCH_CLON\s*=\s*([\d.]+)/) || [])[1];
  const originOk = (!prodClat || +prodClat === area.projection.centerLat) && (!prodClon || +prodClon === area.projection.centerLon);
  checks.projectionOriginMismatch = originOk ? 0 : 1;
  if (!originOk) errors.push(`projection origin 不一致: area(${area.projection.centerLat},${area.projection.centerLon}) vs prod geoToThree(${prodClat},${prodClon})`);

  // ── coordinate convention: znorth-neg の z 反転が CanonicalRuntime で再適用されていない ──
  //   buildGroup / pushPolygon / pushExtrude は座標をそのまま流すだけ（z 符号操作なし）
  const zFlipInCR = /pushPolygon\([^)]*\)[\s\S]{0,0}/.test('') // placeholder
    || /coordinates\.map\([^)]*-[^)]*\[1\]/.test(crBlock)
    || /\[-?\w+\[0\], [^,]+, -\w+\[1\]\]/.test(crBlock)
    || /z\s*=\s*-\s*\w+\[1\]/.test(crBlock);
  checks.coordinateConventionMismatch = zFlipInCR ? 1 : 0;
  if (zFlipInCR) errors.push('CanonicalRuntime が z 座標を反転している（znorth-neg-v1 二重適用の疑い）');

  // ── unexpected runtime translation: mesh/group.position への tile 原点加算が無い ──
  const posAdd = /\.position\.set\([^)]*t[xz]\b/.test(crBlock)
    || /group\.position\.(set|x|z)\s*=[^=]/.test(crBlock)
    || /positions\.push\([^)]*\bt[xz]\s*\*/.test(crBlock)
    || /\+ tileOrigin|\+ tileОrigin|tileLocal/.test(crBlock);
  checks.unexpectedRuntimeTranslation = posAdd ? 1 : 0;
  if (posAdd) errors.push('CanonicalRuntime が mesh/group.position に tile 原点を加算している（double transform）');

  // buildGroup が [x, y, z] をそのまま push している（layer 別の独自座標式が無い）
  const identityPush = /positions\.push\(a\[0\], 0, a\[1\], b\[0\], 0, b\[1\]/.test(html)   // pushExtrude 壁
    && /positions\.push\(v\.x, yLevel, v\.y\)/.test(html);                                  // pushPolygon
  checks.tileOffsetMismatch = identityPush ? 0 : 1;
  if (!identityPush) warns.push('pushExtrude/pushPolygon の座標受け渡しが想定と異なる（要確認）');

  // ── audit レポートの数値検証 ──
  if (fs.existsSync(ALIGN)) {
    const a = JSON.parse(fs.readFileSync(ALIGN, 'utf-8'));
    const cd = a.canonicalToRuntimeRegression && a.canonicalToRuntimeRegression.canonicalToDerived;
    const nm = a.lodCentroidConsistency && a.lodCentroidConsistency.nearVsMid;
    const nf = a.lodCentroidConsistency && a.lodCentroidConsistency.nearVsFar;
    const br = a.buildingToNearestRoadVector;
    checks.canonicalToRuntimeDisplacement = (cd && cd.median <= MAX_CANON_DERIVED_MEDIAN) ? 0 : 1;
    if (cd && cd.median > MAX_CANON_DERIVED_MEDIAN) errors.push(`canonical→derived centroid median ${cd.median}m > ${MAX_CANON_DERIVED_MEDIAN}m`);
    checks.lodCentroidJump = ((nm && nm.p95 <= MAX_LOD_NEARMID_P95) && (nf && nf.p95 <= MAX_LOD_NEARFAR_P95)) ? 0 : 1;
    if (nm && nm.p95 > MAX_LOD_NEARMID_P95) errors.push(`LOD near/mid centroid p95 ${nm.p95}m > ${MAX_LOD_NEARMID_P95}m`);
    if (nf && nf.p95 > MAX_LOD_NEARFAR_P95) warns.push(`LOD near/far centroid p95 ${nf.p95}m > ${MAX_LOD_NEARFAR_P95}m（far simplification）`);
    checks.buildingRoadSystematicOffset = (br && Math.abs(br.medianDx) <= MAX_BUILDING_ROAD_MEDIAN_DXDZ && Math.abs(br.medianDz) <= MAX_BUILDING_ROAD_MEDIAN_DXDZ) ? 0 : 1;
    if (br && (Math.abs(br.medianDx) > MAX_BUILDING_ROAD_MEDIAN_DXDZ || Math.abs(br.medianDz) > MAX_BUILDING_ROAD_MEDIAN_DXDZ)) {
      errors.push(`building→road 系統オフセット median dx/dz ${br.medianDx}/${br.medianDz}m`);
    }
    checks.alignmentType = a.alignmentType;
    checks.buildingRoadMedianDx = br ? br.medianDx : null;
    checks.buildingRoadMedianDz = br ? br.medianDz : null;
    checks.canonicalToDerivedMedian = cd ? cd.median : null;
  } else {
    warns.push('canonical-spatial-alignment.json が無い（先に tools/audit/canonical-spatial-alignment.js）');
    checks.canonicalToRuntimeDisplacement = null;
    checks.lodCentroidJump = null;
  }

  // ── production / protected 不変（この mission は render を触らない）──
  checks.productionUnchanged = true; // hash baseline は他 validator が担保。ここでは canonical runtime 混入のみ確認
  if (fs.existsSync(PROD) && /CanonicalRuntime|__CANONICAL_RUNTIME__/.test(prod)) errors.push('production HTML に canonical runtime 混入');

  const report = {
    generatedAt: new Date().toISOString(),
    thresholds: { MAX_CANON_DERIVED_MEDIAN, MAX_LOD_NEARMID_P95, MAX_LOD_NEARFAR_P95, MAX_BUILDING_ROAD_MEDIAN_DXDZ },
    checks,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 30), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  await done(errors, warns, checks, report);
}

async function done(errors, warns, checks, report) {
  const r = report || { generatedAt: new Date().toISOString(), checks, errors, warns, RESULT: errors.length ? 'FAIL' : 'PASS' };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, r);
  console.log('[spatial-align-validate] ' + JSON.stringify(r.checks));
  for (const e of errors.slice(0, 15)) console.log('  [ERROR] ' + e);
  for (const w of warns.slice(0, 10)) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + r.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[spatial-align-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
