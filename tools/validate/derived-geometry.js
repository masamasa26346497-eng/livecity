#!/usr/bin/env node
// tools/validate/derived-geometry.js
// [Mission 31F §28] Canonical → Derived の追跡と整合性を検証する。
//   - orphan canonical reference 0（derived の canonicalId が resolved canonical に存在）
//   - invalid derived geometry 0
//   - correction tracking missing 0（補正由来 feature に correctionIds がある）
//   - source provenance missing 0（sourceConfidence / derivedFrom）
//   - bbox invalid 0 / topology break 0（simplify で self-intersection / 面積消失）
//   - unexpected missing feature 0（ultra-near に全 canonical feature）
//   - tile manifest mismatch 0
//   - production / protected / ward-ux-v1 render 不変
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { polygonAreaM2 } from '../lib/canonical-geometry-schema.js';
import { ringSelfIntersects } from '../lib/geometry-simplify.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DERIVED = P('data', 'processed', 'osaka-city', 'derived');
const CANON = P('data', 'processed', 'osaka-city', 'canonical');
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const DEV = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const REPORT = P('data', 'reports', 'derived-geometry-validation.json');

const LAYERS = ['water', 'roads', 'buildings', 'parks', 'rail'];
const LODS = ['far', 'mid', 'near'];

// OneDrive 環境では大量ファイル書込直後に一時的な UNKNOWN read エラーが出る（cloud dehydrate/sync）。
// 実在するファイルへの transient error のみ retry する（ENOENT/parse エラーは即座に失敗させる）。
function readJsonRetry(p, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch (e) {
      lastErr = e;
      if (e.code === 'ENOENT') throw e;
      const wait = 120 * (i + 1);
      const end = Date.now() + wait;
      while (Date.now() < end) { /* busy wait（同期）*/ }
    }
  }
  throw lastErr;
}

function loadCanonicalIds(layer) {
  const ids = new Set();
  if (layer === 'water') {
    const b = JSON.parse(fs.readFileSync(P('data', 'processed', 'osaka-city', 'canonical', 'water.json'), 'utf-8'));
    for (const f of b.features) ids.add(f.canonicalId);
    return ids;
  }
  const dir = P('data', 'processed', 'osaka-city', 'canonical', layer);
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    for (const ft of (readJsonRetry(path.join(dir, f)).features || [])) ids.add(ft.canonicalId);
  }
  return ids;
}

// correction 由来の canonicalId（water の split-off / corrected）
function correctionAffectedIds() {
  const s = new Set();
  const b = JSON.parse(fs.readFileSync(P('data', 'processed', 'osaka-city', 'canonical', 'water.json'), 'utf-8'));
  for (const f of b.features) if ((f.qaFlags || []).some((q) => q.startsWith('corrected-31E') || q.startsWith('split-from-'))) s.add(f.canonicalId);
  const pdir = P('data', 'processed', 'osaka-city', 'canonical', 'parks');
  if (fs.existsSync(pdir)) for (const f of fs.readdirSync(pdir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    for (const ft of (readJsonRetry(path.join(pdir, f)).features || [])) if ((ft.qaFlags || []).some((q) => q.startsWith('reclassified-31E'))) s.add(ft.canonicalId);
  }
  return s;
}

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(path.join(DERIVED, 'manifest.json'))) { console.error('[derived-validate] derived manifest なし。先に build-derived-geometry.js'); process.exitCode = 1; return; }
  const topManifest = readJsonRetry(path.join(DERIVED, 'manifest.json'));

  const corrIds = correctionAffectedIds();
  const checks = { orphan: 0, invalidGeom: 0, correctionMissing: 0, provMissing: 0, bboxInvalid: 0, topologyBreak: 0, missingUltraNear: 0, manifestMismatch: 0 };

  for (const layer of LAYERS) {
    const canonIds = loadCanonicalIds(layer);
    for (const lod of LODS) {
      const dir = path.join(DERIVED, lod, layer);
      const mp = path.join(dir, 'manifest.json');
      if (!fs.existsSync(mp)) { errors.push(`${lod}/${layer}/manifest.json が無い`); continue; }
      const m = readJsonRetry(mp);
      if (m.coordinateConvention !== 'znorth-neg-v1') errors.push(`${lod}/${layer} coordinateConvention 不正`);

      const seen = new Set();
      let tileEntryCount = 0; // tile 境界をまたぐ feature は複数 tile に入るので合計は distinct を超える
      const tileFiles = fs.readdirSync(dir).filter((f) => /^tile_.*\.json$/.test(f));
      // manifest.tiles と実 tile の整合
      const manifestTiles = new Set((m.tiles || []).map((t) => t.file));
      for (const tf of tileFiles) if (!manifestTiles.has(tf)) { checks.manifestMismatch++; errors.push(`${lod}/${layer}/${tf} が manifest.tiles に無い`); }

      for (const tf of tileFiles) {
        const t = readJsonRetry(path.join(dir, tf));
        if (t.layer !== layer || t.lod !== lod) errors.push(`${lod}/${layer}/${tf} の layer/lod が不一致`);
        if (!Array.isArray(t.canonicalIds) || t.canonicalIds.length !== (t.features || []).length) { checks.manifestMismatch++; }
        for (const d of (t.features || [])) {
          tileEntryCount++;
          if (seen.has(d.canonicalId)) continue;
          seen.add(d.canonicalId);
          // §28 orphan
          if (!canonIds.has(d.canonicalId)) { checks.orphan++; if (checks.orphan <= 5) errors.push(`orphan: ${lod}/${layer} ${d.canonicalId} が canonical に無い`); }
          // provenance
          if (!d.derivedFrom || d.derivedFrom !== d.canonicalId) { checks.provMissing++; }
          if (d.sourceConfidence == null) { checks.provMissing++; }
          if (!Array.isArray(d.correctionIds)) { checks.correctionMissing++; }
          // correction tracking: 補正由来 id なら correctionIds 非空
          if (corrIds.has(d.canonicalId) && (!d.correctionIds || !d.correctionIds.length)) { checks.correctionMissing++; if (checks.correctionMissing <= 5) errors.push(`correction tracking 欠落: ${lod}/${layer} ${d.canonicalId}`); }
          // bbox
          if (!d.bbox || ['minX', 'maxX', 'minZ', 'maxZ'].some((k) => !Number.isFinite(d.bbox[k])) || d.bbox.minX > d.bbox.maxX || d.bbox.minZ > d.bbox.maxZ) { checks.bboxInvalid++; }
          // geometry / topology
          const polys = d.geometryType === 'Polygon' ? [d.coordinates] : (d.geometryType === 'MultiPolygon' ? d.coordinates : null);
          if (polys) {
            for (const poly of polys) {
              const outer = poly[0] || [];
              if (outer.length < 3) { checks.invalidGeom++; break; }
              if (polygonAreaM2('Polygon', poly) <= 0) { checks.invalidGeom++; break; }
              if (outer.length <= 400 && ringSelfIntersects(outer)) { checks.topologyBreak++; if (checks.topologyBreak <= 5) errors.push(`topology break: ${lod}/${layer} ${d.canonicalId} outer 自己交差`); break; }
            }
          } else if (d.geometryType === 'LineString') {
            if (!Array.isArray(d.coordinates) || d.coordinates.length < 2) checks.invalidGeom++;
          } else if (d.geometryType === 'MultiLineString') {
            if (!d.coordinates.every((l) => Array.isArray(l) && l.length >= 2)) checks.invalidGeom++;
          }
          // simplify tolerance ≤ manifest tol
          if (d.simplificationToleranceM !== m.simplificationToleranceM) checks.provMissing++;
        }
      }
      if (m.featureCount !== seen.size) { checks.manifestMismatch++; errors.push(`${lod}/${layer} manifest.featureCount ${m.featureCount} != distinct tile feature ${seen.size}`); }
      if (m.distinctCanonicalIds !== seen.size) { checks.manifestMismatch++; errors.push(`${lod}/${layer} manifest.distinctCanonicalIds ${m.distinctCanonicalIds} != ${seen.size}`); }

      // §25 near = resolved canonical の完全表現（全 canonical feature を持つ）
      if (lod === 'near') {
        const missing = canonIds.size - seen.size;
        if (missing > 0) { checks.missingUltraNear += missing; errors.push(`${layer} near に canonical feature ${missing} 件が欠落（§25）`); }
      }
    }
    // 単調性 far ⊆ mid ⊆ near
    const c = {};
    for (const lod of LODS) c[lod] = readJsonRetry(path.join(DERIVED, lod, layer, 'manifest.json')).distinctCanonicalIds;
    if (!(c.far <= c.mid && c.mid <= c.near)) errors.push(`${layer}: LOD feature 数の単調性が崩れている ${JSON.stringify(c)}`);
  }

  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (fs.existsSync(p) && /\/derived\/|derived-geometry/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に derived 参照が混入');
  }
  if (fs.existsSync(DEV) && /osaka-city\/derived\//.test(fs.readFileSync(DEV, 'utf-8'))) errors.push('dev HTML に derived 参照が混入（31G まで切替えない）');

  for (const [k, v] of Object.entries(checks)) if (v > 0 && !errors.some((e) => e.includes(k))) errors.push(`${k}: ${v}`);

  const report = {
    generatedAt: new Date().toISOString(),
    derivedDir: toProjectRelativePath(DERIVED),
    totals: topManifest.totals,
    checks,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 40), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[derived-validate] checks: ' + JSON.stringify(checks));
  for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[derived-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
