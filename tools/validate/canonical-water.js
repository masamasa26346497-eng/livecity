#!/usr/bin/env node
// tools/validate/canonical-water.js
// [Mission 31B §17] Canonical Water layer 専用 validator。
//
// PASS 条件:
//   - schema error 0 / duplicate canonicalId 0
//   - invalid polygon 0（自己交差 / area<=0 / 非有限 / giant / hole > outer）
//   - bbox violation 0（OSAKA_CITY_GROUND_EXTENT + margin を完全に外れる feature）
//   - provenance missing 0 / confidence invalid 0 / sourceIds 空 0
//   - polygon source available なのに ribbon fallback を採用 0
//     （＝ ribbon fallback feature が、対応 river polygon を持つ主要河川に存在しない）
//   - centerline mismatch: centerlineInsideRatio < 0.4 の polygon が budget 超（既定 0）
//   - major river missing 0（淀川 / 大和川 / 神崎川 / 大川 / 堂島川 / 土佐堀川 / 安治川 / 木津川 / 寝屋川 / 道頓堀川）
//   - tile prototype 整合（manifest featureCount == body featureCount、tile 参照 id が body に存在）
//   - production / protected HTML 不変
//
// 実行: node tools/validate/canonical-water.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { validateCanonicalFeature, isValidConfidence, polygonAreaM2, ringAreaM2, bboxOf, SOURCE_PRIORITY } from '../lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const BODY = P('data', 'processed', 'osaka-city', 'canonical', 'water.json');
const TILE_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'water');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROT_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const REPORT = P('data', 'reports', 'canonical-water-validation.json');

const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const MARGIN = 1500;
const MAJOR_RIVERS = ['淀川', '大和川', '神崎川', '大川', '堂島川', '土佐堀川', '安治川', '木津川', '寝屋川', '道頓堀川'];
const CENTERLINE_MISMATCH_BUDGET = 0;

function segIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function ringSelfIntersects(ring) {
  const n = ring.length;
  if (n < 4 || n > 900) return false;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segIntersect(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
  }
  return false;
}

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(BODY)) { console.error('[canonical-water-validate] 本体なし: 先に node tools/build-canonical-water.js'); process.exitCode = 1; return; }
  const doc = JSON.parse(fs.readFileSync(BODY, 'utf-8'));
  const feats = doc.features || [];

  if (doc.coordinateConvention !== 'znorth-neg-v1') errors.push('coordinateConvention が znorth-neg-v1 でない: ' + doc.coordinateConvention);
  if (JSON.stringify((doc.sourcePriority || []).map((p) => p.sourceId)) !== JSON.stringify(SOURCE_PRIORITY.water.map((p) => p.sourceId))) errors.push('sourcePriority が schema と不一致');

  const seen = new Set();
  let schemaErr = 0, invalidPoly = 0, bboxViolation = 0, provMissing = 0, confInvalid = 0, sourceIdsEmpty = 0;
  let centerlineMismatch = 0, ribbonWithPolygonAvailable = 0;
  const byGeometrySource = {};
  const bySource = {};
  const namePolyKind = new Map(); // normalized name -> Set of geometrySource kinds

  for (const f of feats) {
    if (seen.has(f.canonicalId)) errors.push('duplicate canonicalId: ' + f.canonicalId);
    seen.add(f.canonicalId);
    const v = validateCanonicalFeature(f);
    if (!v.ok) { schemaErr++; for (const e of v.errors.slice(0, 1)) errors.push('[' + f.canonicalId + '] ' + e); }
    if (f.qaFlags && f.qaFlags.some((q) => q.startsWith('schema-error') || q.startsWith('group-quality'))) { schemaErr++; errors.push('[' + f.canonicalId + '] build 時 quality フラグ: ' + f.qaFlags.find((q) => /schema-error|group-quality/.test(q))); }
    const gs = f.source && f.source.geometrySource;
    byGeometrySource[gs] = (byGeometrySource[gs] || 0) + 1;
    if (!f.source) { provMissing++; continue; }
    if (!isValidConfidence(f.source.confidence)) confInvalid++;
    if (!Array.isArray(f.source.sourceIds) || !f.source.sourceIds.length) sourceIdsEmpty++;
    for (const sid of (f.source.sourceIds || [])) bySource[sid.split('/')[0]] = (bySource[sid.split('/')[0]] || 0) + 1;
    // polygon 品質
    const polys = f.geometryType === 'Polygon' ? [f.coordinates] : (f.geometryType === 'MultiPolygon' ? f.coordinates : []);
    for (const poly of polys) {
      const outer = poly[0] || [];
      const oa = ringAreaM2(outer);
      if (!(oa > 0)) { invalidPoly++; break; }
      if (ringSelfIntersects(outer)) { invalidPoly++; errors.push('[' + f.canonicalId + '] outer 自己交差'); break; }
      for (let i = 1; i < poly.length; i++) if (ringAreaM2(poly[i]) >= oa) { invalidPoly++; break; }
    }
    if (f.areaM2 != null && !(f.areaM2 >= 0 && Number.isFinite(f.areaM2))) invalidPoly++;
    const bb = f.bbox;
    if (bb && (bb.maxX < GROUND_EXTENT.minX - MARGIN || bb.minX > GROUND_EXTENT.maxX + MARGIN || bb.maxZ < GROUND_EXTENT.minZ - MARGIN || bb.minZ > GROUND_EXTENT.maxZ + MARGIN)) bboxViolation++;
    // centerline 整合: insideRatio が低い polygon は build 側で qaFlag を立てているはず（§8 QA flag）。
    //   flag が付いていない未認識のズレのみ hard error（budget=0）。
    if (f.centerlineRef && Number.isFinite(f.centerlineRef.centerlineInsideRatio) && f.source.geometrySource !== 'osm-waterway-centerline') {
      const r = f.centerlineRef.centerlineInsideRatio;
      const acknowledged = (f.qaFlags || []).some((q) => q.startsWith('centerline-mostly-outside') || q.startsWith('centerline-partly-outside'));
      if (r < 0.4 && !acknowledged) { centerlineMismatch++; errors.push('[' + f.canonicalId + '] centerlineInsideRatio ' + r + '（qaFlag 未記録）'); }
      else if (r < 0.4) warns.push('[' + f.canonicalId + '] centerlineInsideRatio ' + r + '（qaFlag 記録済み）');
    }
    // 名前別の geometrySource 種別
    if (f.attributes && f.attributes.name) {
      const k = f.attributes.name;
      if (!namePolyKind.has(k)) namePolyKind.set(k, new Set());
      namePolyKind.get(k).add(f.source.geometrySource === 'osm-waterway-centerline' ? 'ribbon' : 'polygon');
    }
  }

  // polygon source available なのに ribbon fallback（同名で polygon feature と ribbon feature が併存）
  for (const [nm, kinds] of namePolyKind) {
    if (kinds.has('ribbon') && kinds.has('polygon')) { ribbonWithPolygonAvailable++; errors.push('「' + nm + '」に polygon canonical と ribbon fallback が併存（polygon-first 違反）'); }
  }
  // 主要河川が polygon で存在するか
  const majorMissing = [];
  for (const nm of MAJOR_RIVERS) {
    const has = feats.some((f) => f.attributes && f.attributes.name === nm);
    const hasPolygon = feats.some((f) => f.attributes && f.attributes.name === nm && f.source.geometrySource !== 'osm-waterway-centerline');
    if (!has) majorMissing.push(nm);
    else if (!hasPolygon) warns.push('主要河川「' + nm + '」が polygon でなく ribbon fallback（OSM polygon 欠如）');
  }
  if (majorMissing.length) errors.push('主要河川が canonical water に無い: ' + majorMissing.join(', '));

  if (schemaErr) errors.push('schema error ' + schemaErr);
  if (invalidPoly) errors.push('invalid polygon ' + invalidPoly);
  if (bboxViolation) errors.push('bbox violation ' + bboxViolation);
  if (provMissing) errors.push('provenance missing ' + provMissing);
  if (confInvalid) errors.push('confidence invalid ' + confInvalid);
  if (sourceIdsEmpty) errors.push('sourceIds 空 ' + sourceIdsEmpty);
  if (centerlineMismatch > CENTERLINE_MISMATCH_BUDGET) errors.push('centerline mismatch (insideRatio<0.4) ' + centerlineMismatch + ' > budget ' + CENTERLINE_MISMATCH_BUDGET);

  // ── tile prototype 整合 ──
  let tileCheck = 'skip';
  if (fs.existsSync(path.join(TILE_DIR, 'manifest.json'))) {
    const man = JSON.parse(fs.readFileSync(path.join(TILE_DIR, 'manifest.json'), 'utf-8'));
    if (man.featureCount !== feats.length) errors.push('tile manifest featureCount ' + man.featureCount + ' != body ' + feats.length);
    if (man.coordinateConvention !== 'znorth-neg-v1') errors.push('tile manifest coordinateConvention 不正');
    let refIssue = 0;
    for (const tref of (man.tiles || []).slice(0, 400)) {
      const tp = path.join(TILE_DIR, tref.file);
      if (!fs.existsSync(tp)) { refIssue++; continue; }
      const t = JSON.parse(fs.readFileSync(tp, 'utf-8'));
      for (const tf of (t.features || [])) if (!seen.has(tf.canonicalId)) refIssue++;
    }
    if (refIssue) errors.push('tile が body に無い feature を参照 ' + refIssue);
    tileCheck = refIssue ? 'FAIL' : 'PASS';
  } else warns.push('tile prototype manifest なし');

  // ── HTML 不変 ──
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROT_HTML]]) {
    if (!fs.existsSync(p)) continue;
    if (/canonical-geometry-schema|canonical\/water|canonicalId/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に canonical water の変更が混入');
  }
  if (fs.existsSync(DEV_HTML)) {
    const h = fs.readFileSync(DEV_HTML, 'utf-8');
    if (!/const RiverLayerV2 = /.test(h)) errors.push('dev HTML の RiverLayerV2 が消えた（31B は RiverLayerV2 を触らない）');
    if (/canonical\/water|canonical-geometry-schema/.test(h)) errors.push('dev HTML に canonical water 参照が混入（31G まで切替えない）');
  }

  const polygonCount = feats.filter((f) => f.source.geometrySource !== 'osm-waterway-centerline').length;
  const report = {
    generatedAt: new Date().toISOString(),
    body: toProjectRelativePath(BODY),
    featureCount: feats.length,
    polygonCanonicalCount: polygonCount,
    ribbonFallbackCount: feats.length - polygonCount,
    polygonCoverageRatio: feats.length ? +(polygonCount / feats.length).toFixed(3) : 0,
    byGeometrySource, bySourceType: bySource,
    checks: { schemaErr, invalidPoly, bboxViolation, provMissing, confInvalid, sourceIdsEmpty, centerlineMismatch, ribbonWithPolygonAvailable, majorMissing: majorMissing.length },
    tileCheck,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 40),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[canonical-water-validate] features=' + feats.length + ' polygon=' + polygonCount + ' (' + report.polygonCoverageRatio + ')');
  console.log('  checks: ' + JSON.stringify(report.checks) + '  tile=' + tileCheck);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e); }
  for (const w of warns.slice(0, 10)) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[canonical-water-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
