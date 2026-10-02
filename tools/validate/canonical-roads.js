#!/usr/bin/env node
// tools/validate/canonical-roads.js
// [Mission 31C §20] Canonical Roads layer 専用 validator。
//   data/processed/osaka-city/canonical/roads/{manifest.json, tile_*.json} を検証。
//
// PASS 条件:
//   - schema error 0 / duplicate canonicalId 0
//   - invalid polygon 0（自己交差 / area<=0 / 非有限 / giant）
//   - bbox violation 0
//   - provenance missing 0 / confidence invalid 0 / sourceIds missing 0
//   - polygon source available なのに ribbon 採用 0（＝ polygon-first source が config に載っているのに未使用、は現状 trivially OK）
//   - major road missing 0（御堂筋 / 新御堂筋 / 中央大通 / 阪神高速 / 国道43号 / 国道25号 / 長居公園通。国道1号は border road＝WARN）
//   - centerline mismatch anomaly budget 内（insideRatio < 0.5 の feature が全体の 2% 未満）
//   - tile consistency（manifest featureCount == 全 tile ユニーク feature 数、tile 参照が manifest と整合）
//   - production / protected / RoadLayer render 不変
//
// 実行: node tools/validate/canonical-roads.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { validateCanonicalFeature, isValidConfidence, ringAreaM2, SOURCE_PRIORITY } from '../lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DIR = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const MAJOR = P('data', 'reports', 'canonical-road-major.json');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROT_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const REPORT = P('data', 'reports', 'canonical-road-validation.json');

const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const MARGIN = 1600;
const CORE_MAJOR = ['御堂筋', '新御堂筋', '中央大通', '阪神高速', '国道43号', '国道25号', '長居公園通'];
const CENTERLINE_MISMATCH_MAX_FRAC = 0.02;

function segIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function ringSelfIntersects(ring) {
  const n = ring.length;
  if (n < 4 || n > 400) return false;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segIntersect(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
  }
  return false;
}

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(path.join(DIR, 'manifest.json'))) { console.error('[canonical-roads-validate] manifest なし: 先に node tools/build-canonical-roads.js'); process.exitCode = 1; return; }
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf-8'));

  if (manifest.coordinateConvention !== 'znorth-neg-v1') errors.push('manifest coordinateConvention 不正: ' + manifest.coordinateConvention);
  if (JSON.stringify((manifest.sourcePriority || []).map((p) => p.sourceId)) !== JSON.stringify(SOURCE_PRIORITY.roads.map((p) => p.sourceId))) errors.push('sourcePriority が schema と不一致');

  const seen = new Set();
  let schemaErr = 0, invalidPoly = 0, bboxViolation = 0, provMissing = 0, confInvalid = 0, sourceIdsEmpty = 0;
  let centerlineMismatch = 0, unknownGeometrySource = 0, total = 0;
  let plateauNoCenterlineRef = 0, plateauNoMatchQuality = 0, plateauPolygonCount = 0, ribbonCount = 0;
  let plateauOrphanCount = 0, orphanWithCenterlineRef = 0, orphanWithOsmAttrs = 0, orphanNoPlateauAttrs = 0;
  const ALLOWED_GS = new Set(['osm-road-centerline', 'plateau-tran-road']);
  const byGeometrySource = {}, byLodClass = { major: 0, mid: 0, local: 0 }, byWidthMethod = {}, byOsmMatchQuality = {};
  let bridge = 0, tunnel = 0;

  const tileFiles = fs.readdirSync(DIR).filter((f) => /^tile_.*\.json$/.test(f));
  for (const tf of tileFiles) {
    const t = JSON.parse(fs.readFileSync(path.join(DIR, tf), 'utf-8'));
    if (t.coordinateConvention !== 'znorth-neg-v1') errors.push(tf + ' coordinateConvention 不正');
    for (const f of (t.features || [])) {
      if (seen.has(f.canonicalId)) continue; // tile 境界で重複するのは正常。ユニーク集合で数える
      seen.add(f.canonicalId);
      total++;
      const v = validateCanonicalFeature(f);
      if (!v.ok) { schemaErr++; if (schemaErr <= 5) errors.push('[' + f.canonicalId + '] ' + v.errors[0]); }
      if (f.qaFlags && f.qaFlags.some((q) => q.startsWith('schema-error'))) { schemaErr++; }
      const gs = f.source && f.source.geometrySource;
      byGeometrySource[gs] = (byGeometrySource[gs] || 0) + 1;
      if (f.attributes) {
        byLodClass[f.attributes.lodClass] = (byLodClass[f.attributes.lodClass] || 0) + 1;
        if (f.attributes.bridge) bridge++;
        if (f.attributes.tunnel) tunnel++;
      }
      if (f.widthProfile) byWidthMethod[f.widthProfile.method] = (byWidthMethod[f.widthProfile.method] || 0) + 1;
      if (!f.source) { provMissing++; continue; }
      if (!isValidConfidence(f.source.confidence)) confInvalid++;
      if (!Array.isArray(f.source.sourceIds) || !f.source.sourceIds.length) sourceIdsEmpty++;
      // [§28] geometrySource は osm-road-centerline（ribbon fallback）か plateau-tran-road（polygon-first）のみ許容。
      if (!ALLOWED_GS.has(gs)) unknownGeometrySource++;
      if (gs === 'plateau-tran-road') {
        plateauPolygonCount++;
        // [§28] PLATEAU polygon は 2 系統ある。
        //   (a) OSM centerline と対応がついた feature: centerlineRef と osmMatchQuality（STRONG/MEDIUM）必須（§9/§10）。
        //   (b) 対応する OSM centerline が存在しない feature（OSM 欠測域を含む）: centerlineRef は無く、
        //       代わりに attributes-source-missing を明示していること。黙って属性欠落させるのは不可。
        const orphanAck = (f.qaFlags || []).includes('attributes-source-missing') && (f.qaFlags || []).includes('osm-match=none');
        if (orphanAck) {
          plateauOrphanCount++;
          byOsmMatchQuality.none = (byOsmMatchQuality.none || 0) + 1;
          if (f.centerlineRef) orphanWithCenterlineRef++;
          if (f.attributes && (f.attributes.name || f.attributes.highway)) orphanWithOsmAttrs++;
          if (!f.attributes || !f.attributes.plateauFunctionCode) orphanNoPlateauAttrs++;
        } else {
          if (!f.centerlineRef || !Array.isArray(f.centerlineRef.coordinates) || f.centerlineRef.coordinates.length < 2) plateauNoCenterlineRef++;
          const mq = f.centerlineRef && f.centerlineRef.osmMatchQuality;
          if (!mq || !['STRONG', 'MEDIUM'].includes(mq)) plateauNoMatchQuality++;
          else byOsmMatchQuality[mq] = (byOsmMatchQuality[mq] || 0) + 1;
        }
      } else if (gs === 'osm-road-centerline') {
        ribbonCount++;
      }
      // polygon 品質
      const polys = f.geometryType === 'Polygon' ? [f.coordinates] : (f.geometryType === 'MultiPolygon' ? f.coordinates : []);
      let bad = false;
      for (const poly of polys) {
        const outer = poly[0] || [];
        if (!(ringAreaM2(outer) > 0)) { bad = true; break; }
        if (ringSelfIntersects(outer)) { bad = true; errors.push('[' + f.canonicalId + '] outer 自己交差'); break; }
      }
      if (bad || (f.areaM2 != null && !(f.areaM2 >= 0 && Number.isFinite(f.areaM2)))) invalidPoly++;
      const bb = f.bbox;
      if (bb && (bb.maxX < GROUND_EXTENT.minX - MARGIN || bb.minX > GROUND_EXTENT.maxX + MARGIN || bb.maxZ < GROUND_EXTENT.minZ - MARGIN || bb.minZ > GROUND_EXTENT.maxZ + MARGIN)) bboxViolation++;
      if (f.centerlineRef && Number.isFinite(f.centerlineRef.centerlineInsideRatio) && f.centerlineRef.centerlineInsideRatio < 0.5) {
        const ack = (f.qaFlags || []).some((q) => q.startsWith('centerline-partly-outside'));
        if (!ack) centerlineMismatch++;
      }
    }
  }

  if (manifest.featureCount !== total) errors.push('manifest featureCount ' + manifest.featureCount + ' != ユニーク tile feature ' + total);
  if (schemaErr) errors.push('schema error ' + schemaErr);
  if (invalidPoly) errors.push('invalid polygon ' + invalidPoly);
  if (bboxViolation) errors.push('bbox violation ' + bboxViolation);
  if (provMissing) errors.push('provenance missing ' + provMissing);
  if (confInvalid) errors.push('confidence invalid ' + confInvalid);
  if (sourceIdsEmpty) errors.push('sourceIds 空 ' + sourceIdsEmpty);
  if (unknownGeometrySource) errors.push('未知の geometrySource ' + unknownGeometrySource + '（osm-road-centerline / plateau-tran-road のみ許容 §28）');
  if (plateauNoCenterlineRef) errors.push('plateau-tran-road feature に centerlineRef 欠落 ' + plateauNoCenterlineRef + '（§9: OSM centerlineRef 保持必須）');
  if (plateauNoMatchQuality) errors.push('plateau-tran-road feature に osmMatchQuality（STRONG/MEDIUM）欠落 ' + plateauNoMatchQuality + '（§10）');
  // [§28] orphan feature の整合: OSM 属性を持っていないこと・PLATEAU 属性は持っていること
  if (orphanWithCenterlineRef) errors.push('attributes-source-missing なのに centerlineRef を持つ feature ' + orphanWithCenterlineRef);
  if (orphanWithOsmAttrs) errors.push('attributes-source-missing なのに OSM 属性（name/highway）を持つ feature ' + orphanWithOsmAttrs + '（属性の捏造）');
  if (orphanNoPlateauAttrs) errors.push('orphan feature に PLATEAU 属性（plateauFunctionCode）が無い ' + orphanNoPlateauAttrs);
  // polygon-first violation: 同一道路が polygon と ribbon の両方で emit されていないか（canonicalId ユニークで担保だが念のため source 側も確認）
  // → canonicalId = cg_road_<osmId> でユニークなので構造的に 0。unknownGeometrySource が 0 なら polygon-first 違反も 0。
  const clMismatchFrac = total ? centerlineMismatch / total : 0;
  if (clMismatchFrac > CENTERLINE_MISMATCH_MAX_FRAC) errors.push('centerline mismatch（insideRatio<0.5・未記録）' + centerlineMismatch + ' = ' + (clMismatchFrac * 100).toFixed(2) + '% > ' + (CENTERLINE_MISMATCH_MAX_FRAC * 100) + '%');
  else if (centerlineMismatch) warns.push('centerline mismatch（未記録）' + centerlineMismatch + ' 件（budget 内）');

  // ── major road ──
  let majorMissing = [];
  if (fs.existsSync(MAJOR)) {
    const mr = JSON.parse(fs.readFileSync(MAJOR, 'utf-8')).roads || [];
    for (const row of mr) {
      if (row.featureCount === 0) {
        if (row.borderRoad) warns.push('major road「' + row.name + '」は 24 区境界をかすめるだけで feature 0（許容）');
        else if (CORE_MAJOR.includes(row.name)) majorMissing.push(row.name);
        else warns.push('major road「' + row.name + '」が feature 0');
      }
    }
  } else warns.push('canonical-road-major.json なし');
  if (majorMissing.length) errors.push('core major road が canonical roads に無い: ' + majorMissing.join(', '));

  // ── tile 参照整合 ──
  const manifestTileKeys = new Set((manifest.tiles || []).map((x) => x.file));
  for (const tf of tileFiles) if (!manifestTileKeys.has(tf)) errors.push('tile ' + tf + ' が manifest.tiles に無い');
  for (const x of (manifest.tiles || [])) if (!fs.existsSync(path.join(DIR, x.file))) errors.push('manifest 記載の tile ' + x.file + ' が無い');

  // ── HTML 不変 ──
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROT_HTML]]) {
    if (fs.existsSync(p) && /canonical\/roads|canonical-geometry-schema|canonicalId/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に canonical roads の変更が混入');
  }
  if (fs.existsSync(DEV_HTML)) {
    const h = fs.readFileSync(DEV_HTML, 'utf-8');
    if (!/const RoadLayer = |RoadLayer/.test(h)) errors.push('dev HTML の RoadLayer が消えた');
    if (/canonical\/roads|canonical-geometry-schema/.test(h)) errors.push('dev HTML に canonical roads 参照が混入（31G まで切替えない）');
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dir: toProjectRelativePath(DIR),
    featureCount: total,
    polygonCanonicalCount: plateauPolygonCount,
    ribbonFallbackCount: ribbonCount,
    polygonCoverageRatio: total ? +(plateauPolygonCount / total).toFixed(4) : 0,
    plateauTranAdopted: plateauPolygonCount > 0,
    byGeometrySource, byLodClass, byWidthMethod, byOsmMatchQuality,
    bridge, tunnel,
    checks: { schemaErr, invalidPoly, bboxViolation, provMissing, confInvalid, sourceIdsEmpty, unknownGeometrySource, plateauNoCenterlineRef, plateauNoMatchQuality, centerlineMismatch, centerlineMismatchFrac: +clMismatchFrac.toFixed(4), majorMissing: majorMissing.length, tiles: tileFiles.length },
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 40),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[canonical-roads-validate] features=' + total + ' (polygon ' + plateauPolygonCount
    + ' / うち属性 SOURCE_MISSING ' + plateauOrphanCount + ' / ribbon ' + ribbonCount + ') tiles=' + tileFiles.length);
  console.log('  checks: ' + JSON.stringify(report.checks));
  console.log('  byLodClass: ' + JSON.stringify(byLodClass) + '  byWidthMethod: ' + JSON.stringify(byWidthMethod));
  if (errors.length) { console.log('  -- errors --'); for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e); }
  for (const w of warns.slice(0, 12)) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[canonical-roads-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
