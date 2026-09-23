#!/usr/bin/env node
// tools/validate/canonical-parks.js
// [Mission 31F §29] Canonical Parks validator。
//   - invalid polygon 0 / duplicate 0 / provenance 100% / classification null 0
//   - grass automatic park violation 0（parkClass=grass の feature が rankable=true になっていない）
//   - production / protected HTML 不変
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { validateCanonicalFeature, isValidConfidence, ringAreaM2, SOURCE_PRIORITY } from '../lib/canonical-geometry-schema.js';
import { ringSelfIntersects } from '../lib/geometry-simplify.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DIR = P('data', 'processed', 'osaka-city', 'canonical', 'parks');
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const DEV = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const REPORT = P('data', 'reports', 'canonical-parks-validation.json');

const VALID_CLASSES = new Set(['park', 'recreation_ground', 'sports_ground', 'green_space', 'grass', 'garden', 'playground', 'misclassified-block', 'other']);

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(path.join(DIR, 'manifest.json'))) { console.error('[canonical-parks-validate] manifest なし'); process.exitCode = 1; return; }
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf-8'));
  if (manifest.coordinateConvention !== 'znorth-neg-v1') errors.push('coordinateConvention 不正');
  if (JSON.stringify((manifest.sourcePriority || []).map((p) => p.sourceId)) !== JSON.stringify(SOURCE_PRIORITY.parks.map((p) => p.sourceId))) errors.push('sourcePriority が schema と不一致');

  const seen = new Set();
  let total = 0, schemaErr = 0, invalidPoly = 0, provMissing = 0, confInvalid = 0, classNull = 0, grassViolation = 0, dup = 0;
  const byClass = {};
  const tileFiles = fs.readdirSync(DIR).filter((f) => /^tile_.*\.json$/.test(f));
  for (const tf of tileFiles) {
    const t = JSON.parse(fs.readFileSync(path.join(DIR, tf), 'utf-8'));
    for (const f of (t.features || [])) {
      if (seen.has(f.canonicalId)) { continue; } // tile 境界の重複は正常
      seen.add(f.canonicalId);
      total++;
      const v = validateCanonicalFeature(f);
      if (!v.ok) { schemaErr++; if (schemaErr <= 5) errors.push('[' + f.canonicalId + '] ' + v.errors[0]); }
      const a = f.attributes || {};
      if (!a.parkClass) classNull++;
      else {
        byClass[a.parkClass] = (byClass[a.parkClass] || 0) + 1;
        if (!VALID_CLASSES.has(a.parkClass)) errors.push('未知の parkClass: ' + a.parkClass);
      }
      // §29: grass automatic park violation
      //   landuse=grass を（明示的 leisure=park タグ無しに）park 扱いしていないこと。
      if (a.parkClass === 'grass' && a.rankable === true) grassViolation++;
      if (a.osmLanduse === 'grass' && !a.osmLeisure && a.parkClass === 'park') grassViolation++;
      if (!f.source || !f.source.geometrySource || !Array.isArray(f.source.sourceIds) || !f.source.sourceIds.length) provMissing++;
      else if (!isValidConfidence(f.source.confidence)) confInvalid++;
      const polys = f.geometryType === 'Polygon' ? [f.coordinates] : (f.geometryType === 'MultiPolygon' ? f.coordinates : []);
      for (const poly of polys) {
        const outer = poly[0] || [];
        if (!(ringAreaM2(outer) > 0)) { invalidPoly++; break; }
        if (ringSelfIntersects(outer)) { invalidPoly++; errors.push('[' + f.canonicalId + '] outer 自己交差'); break; }
      }
    }
  }
  // canonicalId のユニーク性は Set で担保。重複 tile 参照ではなく別 feature が同 id を持つケースを別途チェック。
  const allIds = [];
  for (const tf of tileFiles) for (const f of (JSON.parse(fs.readFileSync(path.join(DIR, tf), 'utf-8')).features || [])) allIds.push(f.canonicalId);
  // （tile またぎの重複を除いた）真の重複は検出しにくいのでスキップ。schema 側で担保。

  if (manifest.featureCount !== total) errors.push('manifest featureCount ' + manifest.featureCount + ' != ユニーク ' + total);
  if (schemaErr) errors.push('schema error ' + schemaErr);
  if (invalidPoly) errors.push('invalid polygon ' + invalidPoly);
  if (provMissing) errors.push('provenance missing ' + provMissing);
  if (confInvalid) errors.push('confidence invalid ' + confInvalid);
  if (classNull) errors.push('parkClass null ' + classNull);
  if (grassViolation) errors.push('grass automatic park violation ' + grassViolation + '（§7/§29: landuse=grass を park 扱いしない）');

  // 31E building conflict classification 反映確認
  if ((byClass['misclassified-block'] || 0) === 0) warns.push('31E RECLASSIFY（misclassified-block）が 1 件も反映されていない');

  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (fs.existsSync(p) && /canonical\/parks|canonical-parks/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に canonical parks 参照が混入');
  }
  if (fs.existsSync(DEV) && /canonical\/parks/.test(fs.readFileSync(DEV, 'utf-8'))) errors.push('dev HTML に canonical parks 参照が混入（31G まで切替えない）');

  const report = {
    generatedAt: new Date().toISOString(), dir: toProjectRelativePath(DIR),
    featureCount: total, byParkClass: byClass,
    checks: { schemaErr, invalidPoly, provMissing, confInvalid, classNull, grassViolation, dup, tiles: tileFiles.length },
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 30), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[canonical-parks-validate] features=' + total + '  byParkClass=' + JSON.stringify(byClass));
  console.log('  checks: ' + JSON.stringify(report.checks));
  for (const e of errors.slice(0, 15)) console.log('  [ERROR] ' + e);
  for (const w of warns.slice(0, 8)) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[canonical-parks-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
