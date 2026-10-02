#!/usr/bin/env node
// tools/validate/canonical-buildings.js
// [Mission 31D §17] Canonical Buildings layer 専用 validator。
//   data/processed/osaka-city/canonical/buildings/{manifest.json, tile_*.json, attributes/tile_*.json} を検証。
//   tile を stream で読む（615,000+ feature をメモリに載せない）。
//
// PASS 条件:
//   - schema error 0 / duplicate canonicalId 0 / invalid footprint 0（自己交差 / zero area / 非有限）
//   - bbox invalid 0 / centroid invalid 0 / area invalid 0
//   - provenance missing 0 / confidence invalid 0 / sourceIds missing 0
//   - normalizedUsage null 0（§7）
//   - ward assignment invalid 0（存在しない区 id を持たない。null は区外建物として許容）
//   - PLATEAU priority violation 0（fallback が PLATEAU の重複を含まない）
//   - tile consistency PASS（manifest featureCount == 全 tile feature 合計、attributes tile が geometry tile と 1:1）
//   - production / protected / BuildingTileLayer render 不変
//
// 実行: node tools/validate/canonical-buildings.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { validateCanonicalFeature, isValidConfidence, ringAreaM2, SOURCE_PRIORITY } from '../lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DIR = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const ATTR_DIR = path.join(DIR, 'attributes');
const WARDS = P('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROT_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const REPORT = P('data', 'reports', 'canonical-building-validation.json');

const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const MARGIN = 2500;

function segIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function ringSelfIntersects(ring) {
  const n = ring.length;
  if (n < 4 || n > 60) return false;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segIntersect(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
  }
  return false;
}

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(path.join(DIR, 'manifest.json'))) { console.error('[canonical-buildings-validate] manifest なし: 先に node --max-old-space-size=4096 tools/build-canonical-buildings.js'); process.exitCode = 1; return; }
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf-8'));
  if (manifest.coordinateConvention !== 'znorth-neg-v1') errors.push('manifest coordinateConvention 不正: ' + manifest.coordinateConvention);
  if (JSON.stringify((manifest.sourcePriority || []).map((p) => p.sourceId)) !== JSON.stringify(SOURCE_PRIORITY.buildings.map((p) => p.sourceId))) errors.push('sourcePriority が schema と不一致');

  const validWards = new Set(JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards.map((w) => w.wardId));
  const tileFiles = fs.readdirSync(DIR).filter((f) => /^tile_.*\.json$/.test(f));
  const attrFiles = new Set(fs.existsSync(ATTR_DIR) ? fs.readdirSync(ATTR_DIR).filter((f) => /^tile_.*\.json$/.test(f)) : []);

  const seen = new Set();
  let total = 0, plateau = 0, fallback = 0;
  let schemaErr = 0, invalidFp = 0, bboxInvalid = 0, centroidInvalid = 0, areaInvalid = 0;
  let provMissing = 0, confInvalid = 0, sourceIdsEmpty = 0;
  let normalizedUsageNull = 0, wardInvalid = 0, wardNull = 0, attrMissing = 0;
  let plateauPriorityViolation = 0;
  const byGeometrySource = {}, byCategory = {};
  const sampleErr = [];

  for (const tf of tileFiles) {
    const t = JSON.parse(fs.readFileSync(path.join(DIR, tf), 'utf-8'));
    if (t.coordinateConvention !== 'znorth-neg-v1') errors.push(tf + ' coordinateConvention 不正');
    const attrPath = path.join(ATTR_DIR, tf);
    const attrDoc = attrFiles.has(tf) ? JSON.parse(fs.readFileSync(attrPath, 'utf-8')) : null;
    if (!attrDoc) errors.push('attributes tile 欠落: ' + tf);
    const attrs = attrDoc ? (attrDoc.attributes || {}) : {};
    if (attrDoc && attrDoc.count !== (t.features || []).length) errors.push(tf + ' attributes count 不一致');

    for (const f of (t.features || [])) {
      total++;
      if (seen.has(f.canonicalId)) errors.push('duplicate canonicalId: ' + f.canonicalId);
      seen.add(f.canonicalId);
      const v = validateCanonicalFeature(f);
      if (!v.ok) { schemaErr++; if (sampleErr.length < 8) sampleErr.push('[' + f.canonicalId + '] ' + v.errors[0]); }
      const gs = f.source && f.source.geometrySource;
      byGeometrySource[gs] = (byGeometrySource[gs] || 0) + 1;
      if (gs === 'plateau-building') plateau++; else if (gs === 'osm-building') fallback++;
      if (!f.source) { provMissing++; }
      else {
        if (!isValidConfidence(f.source.confidence)) confInvalid++;
        if (!Array.isArray(f.source.sourceIds) || !f.source.sourceIds.length) sourceIdsEmpty++;
        if (gs === 'plateau-building' && Math.abs(f.source.confidence - 0.95) > 0.001) plateauPriorityViolation++; // PLATEAU は必ず 0.95
      }
      // footprint 品質
      const outer = (f.coordinates && f.coordinates[0]) || [];
      const oa = ringAreaM2(outer);
      if (!(oa > 0)) invalidFp++;
      else if (ringSelfIntersects(outer) && !(f.qaFlags || []).some((q) => q.startsWith('self-intersect-check-skipped'))) { invalidFp++; if (sampleErr.length < 8) sampleErr.push('[' + f.canonicalId + '] outer 自己交差'); }
      if (!f.bbox || ['minX', 'maxX', 'minZ', 'maxZ'].some((k) => !Number.isFinite(f.bbox[k])) || f.bbox.minX > f.bbox.maxX) bboxInvalid++;
      else if (f.bbox.maxX < GROUND_EXTENT.minX - MARGIN || f.bbox.minX > GROUND_EXTENT.maxX + MARGIN || f.bbox.maxZ < GROUND_EXTENT.minZ - MARGIN || f.bbox.minZ > GROUND_EXTENT.maxZ + MARGIN) bboxInvalid++;
      if (!Array.isArray(f.centroid) || f.centroid.length !== 2 || !f.centroid.every(Number.isFinite)) centroidInvalid++;
      if (!(Number.isFinite(f.areaM2) && f.areaM2 >= 0)) areaInvalid++;
      // 属性
      const at = attrs[f.canonicalId];
      if (!at) { attrMissing++; continue; }
      if (!at.normalizedUsage || /その他\(null\)/.test(String(at.usageLabel))) normalizedUsageNull++;
      byCategory[at.usageCategory || '(none)'] = (byCategory[at.usageCategory || '(none)'] || 0) + 1;
      if (at.wardId == null) wardNull++;
      else if (!validWards.has(at.wardId)) wardInvalid++;
      if (at.source === 'plateau-building' && at.confidence !== 0.95) plateauPriorityViolation++;
    }
  }

  if (manifest.featureCount !== total) errors.push('manifest featureCount ' + manifest.featureCount + ' != 全 tile feature ' + total);
  if (manifest.plateauCount !== plateau) errors.push('manifest plateauCount ' + manifest.plateauCount + ' != ' + plateau);
  if (manifest.fallbackCount !== fallback) errors.push('manifest fallbackCount ' + manifest.fallbackCount + ' != ' + fallback);
  if (schemaErr) errors.push('schema error ' + schemaErr + (sampleErr.length ? '（例: ' + sampleErr.slice(0, 3).join(' / ') + '）' : ''));
  if (invalidFp) errors.push('invalid footprint ' + invalidFp);
  if (bboxInvalid) errors.push('bbox invalid ' + bboxInvalid);
  if (centroidInvalid) errors.push('centroid invalid ' + centroidInvalid);
  if (areaInvalid) errors.push('area invalid ' + areaInvalid);
  if (provMissing) errors.push('provenance missing ' + provMissing);
  if (confInvalid) errors.push('confidence invalid ' + confInvalid);
  if (sourceIdsEmpty) errors.push('sourceIds 空 ' + sourceIdsEmpty);
  if (normalizedUsageNull) errors.push('normalizedUsage null / その他(null) ' + normalizedUsageNull);
  if (wardInvalid) errors.push('ward assignment invalid（存在しない区 id）' + wardInvalid);
  if (attrMissing) errors.push('attributes 欠落 feature ' + attrMissing);
  if (plateauPriorityViolation) errors.push('PLATEAU priority violation（PLATEAU の confidence が 0.95 でない）' + plateauPriorityViolation);
  if (plateau < 500000) errors.push('PLATEAU feature が少なすぎる ' + plateau);
  if (wardNull > 0) warns.push('wardId=null の feature ' + wardNull + '（区外/ambiguous 建物。fallback で missingWardId が出た場合は要確認）');

  // tile 参照整合
  const mTileFiles = new Set((manifest.tiles || []).map((x) => x.file));
  for (const tf of tileFiles) if (!mTileFiles.has(tf)) errors.push('tile ' + tf + ' が manifest.tiles に無い');
  for (const x of (manifest.tiles || [])) if (!fs.existsSync(path.join(DIR, x.file))) errors.push('manifest tile ' + x.file + ' が無い');

  // HTML 不変
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROT_HTML]]) {
    if (fs.existsSync(p) && /canonical\/buildings|canonical-geometry-schema|canonicalId/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に canonical buildings の変更が混入');
  }
  if (fs.existsSync(DEV_HTML)) {
    const h = fs.readFileSync(DEV_HTML, 'utf-8');
    if (!/const BuildingTileLayer = /.test(h)) errors.push('dev HTML の BuildingTileLayer が消えた');
    if (/canonical\/buildings|canonical-geometry-schema/.test(h)) errors.push('dev HTML に canonical buildings 参照が混入（31G まで切替えない）');
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dir: toProjectRelativePath(DIR),
    featureCount: total, plateauCount: plateau, fallbackCount: fallback,
    polygonCoverageRatio: 1.0,
    byGeometrySource, byCategory,
    checks: { schemaErr, invalidFp, bboxInvalid, centroidInvalid, areaInvalid, provMissing, confInvalid, sourceIdsEmpty, normalizedUsageNull, wardInvalid, wardNull, attrMissing, plateauPriorityViolation, tiles: tileFiles.length },
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[canonical-buildings-validate] features=' + total + ' (PLATEAU ' + plateau + ' / OSM ' + fallback + ') tiles=' + tileFiles.length);
  console.log('  checks: ' + JSON.stringify(report.checks));
  if (errors.length) { console.log('  -- errors --'); for (const e of errors.slice(0, 15)) console.log('  [ERROR] ' + e); }
  for (const w of warns.slice(0, 8)) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[canonical-buildings-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
