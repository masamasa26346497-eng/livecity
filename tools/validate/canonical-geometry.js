#!/usr/bin/env node
// tools/validate/canonical-geometry.js
// [Mission 31A §18 / 31D §18] Canonical Urban Geometry の schema validator（統合）。
//   data/processed/osaka-city/canonical/ の water（*.json）/ roads / buildings 3 layer を横断検証。
//   layer 間の schema 互換性（同一 canonicalId 空間・coordinateConvention・layer type）も確認。
//
// PASS 条件:
//   - invalid geometry 0 / duplicate canonicalId 0 / bbox valid / area finite
//   - provenance あり / confidence valid / sourceIds あり / layer type valid / coordinates valid
//   - coordinateConvention が znorth-neg-v1 で一致
//   - schema lib の自己整合（SOURCE_PRIORITY の各 layer が CANONICAL_LAYERS に含まれる 等）
//   - protected / production HTML 不変（このタスクは HTML を触らない）
//
// 実行: node tools/validate/canonical-geometry.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import {
  CANONICAL_LAYERS, COORDINATE_CONVENTION, SOURCE_PRIORITY, SOURCE_REGISTRY, CONFIDENCE,
  validateCanonicalFeature, isValidConfidence,
} from '../lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON_DIR = P('data', 'processed', 'osaka-city', 'canonical');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROT_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const REPORT = P('data', 'reports', 'canonical-geometry-validation.json');

function selfCheckSchema(errors) {
  for (const [layer, prio] of Object.entries(SOURCE_PRIORITY)) {
    if (!CANONICAL_LAYERS.includes(layer)) errors.push('SOURCE_PRIORITY に未知 layer: ' + layer);
    if (!Array.isArray(prio) || !prio.length) { errors.push(layer + ' の source priority が空'); continue; }
    if (prio[prio.length - 1].sourceId !== null) errors.push(layer + ' の source priority 末尾が「source missing は生成しない」でない');
    for (const p of prio) {
      if (p.sourceId != null && !SOURCE_REGISTRY[p.sourceId]) errors.push(layer + ' priority に registry 外 source: ' + p.sourceId);
    }
  }
  for (const l of CANONICAL_LAYERS) if (!SOURCE_PRIORITY[l]) errors.push('layer ' + l + ' の source priority 未定義');
  for (const [k, v] of Object.entries(CONFIDENCE)) if (!isValidConfidence(v)) errors.push('CONFIDENCE.' + k + ' が不正: ' + v);
}

async function main() {
  const errors = [], warns = [];
  const layerStats = {};
  selfCheckSchema(errors);

  const files = fs.existsSync(CANON_DIR) ? fs.readdirSync(CANON_DIR).filter((f) => f.endsWith('.json')) : [];
  if (!files.length) warns.push('canonical/*.json がまだ無い（31A は water prototype のみ）');

  const seenIds = new Set();
  let totalFeatures = 0;
  for (const file of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(CANON_DIR, file), 'utf-8'));
    const feats = doc.features || [];
    const layer = doc.layer || file.replace(/\.json$/, '');
    const st = { file, layer, features: feats.length, schemaErrors: 0, dupIds: 0, lowConfidence: 0, qaFlagged: 0, byGeometrySource: {} };
    if (doc.coordinateConvention !== COORDINATE_CONVENTION) errors.push(file + ' の coordinateConvention が ' + COORDINATE_CONVENTION + ' でない: ' + doc.coordinateConvention);
    for (const f of feats) {
      totalFeatures++;
      if (seenIds.has(f.canonicalId)) { st.dupIds++; errors.push('duplicate canonicalId: ' + f.canonicalId); }
      seenIds.add(f.canonicalId);
      const v = validateCanonicalFeature(f);
      if (!v.ok) { st.schemaErrors++; for (const e of v.errors.slice(0, 2)) errors.push(file + ' [' + f.canonicalId + '] ' + e); }
      if (f.source && isValidConfidence(f.source.confidence) && f.source.confidence < 0.6) st.lowConfidence++;
      if (Array.isArray(f.qaFlags) && f.qaFlags.length) st.qaFlagged++;
      const gs = f.source && f.source.geometrySource || '(none)';
      st.byGeometrySource[gs] = (st.byGeometrySource[gs] || 0) + 1;
      if (Array.isArray(f.qaFlags) && f.qaFlags.some((q) => q.startsWith('schema-error'))) { st.schemaErrors++; errors.push(file + ' [' + f.canonicalId + '] build 時 schema-error フラグ'); }
    }
    layerStats[layer] = st;
  }

  // ── roads / buildings（manifest + tile。full 走査はせず sample + tile 整合を確認。専用 validator が本検査）──
  for (const sub of ['roads', 'buildings']) {
    const subDir = path.join(CANON_DIR, sub);
    const manPath = path.join(subDir, 'manifest.json');
    if (!fs.existsSync(manPath)) { warns.push('canonical/' + sub + '/manifest.json がまだ無い'); continue; }
    const man = JSON.parse(fs.readFileSync(manPath, 'utf-8'));
    const st = { file: sub + '/manifest.json', layer: man.layer || sub, features: man.featureCount || 0, schemaErrors: 0, dupIds: 0, sampled: 0, byGeometrySource: {} };
    if (man.coordinateConvention !== COORDINATE_CONVENTION) errors.push('canonical/' + sub + ' の coordinateConvention 不正');
    if (JSON.stringify((man.sourcePriority || []).map((p) => p.sourceId)) !== JSON.stringify(SOURCE_PRIORITY[st.layer].map((p) => p.sourceId))) errors.push('canonical/' + sub + ' の sourcePriority が schema と不一致');
    const tileFs = fs.readdirSync(subDir).filter((f) => /^tile_.*\.json$/.test(f));
    if (!tileFs.length) errors.push('canonical/' + sub + ' に tile が無い');
    // 先頭・中間・末尾 tile を sample 検証
    const idx = [0, Math.floor(tileFs.length / 2), tileFs.length - 1].filter((i, k, a) => a.indexOf(i) === k && i >= 0);
    for (const i of idx) {
      const t = JSON.parse(fs.readFileSync(path.join(subDir, tileFs[i]), 'utf-8'));
      if (t.coordinateConvention !== COORDINATE_CONVENTION) errors.push(sub + '/' + tileFs[i] + ' coordinateConvention 不正');
      for (const f of (t.features || [])) {
        st.sampled++;
        if (seenIds.has(f.canonicalId)) { st.dupIds++; errors.push('layer 横断 duplicate canonicalId: ' + f.canonicalId); }
        seenIds.add(f.canonicalId);
        const v = validateCanonicalFeature(f);
        if (!v.ok) { st.schemaErrors++; if (st.schemaErrors <= 3) errors.push(sub + '/' + tileFs[i] + ' [' + f.canonicalId + '] ' + v.errors[0]); }
        const gs = f.source && f.source.geometrySource || '(none)';
        st.byGeometrySource[gs] = (st.byGeometrySource[gs] || 0) + 1;
      }
    }
    totalFeatures += st.features;
    layerStats[st.layer] = st;
  }
  // 3 layer 揃ったか
  const haveLayers = new Set(Object.values(layerStats).map((s) => s.layer));
  for (const need of ['water', 'roads', 'buildings']) if (!haveLayers.has(need)) warns.push('canonical layer 未構築: ' + need);

  for (const [label, p] of [['production', PROD_HTML], ['protected', PROT_HTML]]) {
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    if (/canonical-geometry-schema|CANONICAL_LAYERS|canonicalId/.test(h)) errors.push(label + ' HTML に canonical geometry の変更が混入');
  }

  const report = {
    generatedAt: new Date().toISOString(),
    canonicalDir: toProjectRelativePath(CANON_DIR),
    files, totalFeatures, layerStats,
    schemaSelfCheck: errors.filter((e) => /SOURCE_PRIORITY|CONFIDENCE|source priority/.test(e)).length === 0 ? 'PASS' : 'FAIL',
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 50), warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[canonical-geometry-validate] files=' + files.length + ' features=' + totalFeatures);
  for (const [l, s] of Object.entries(layerStats)) console.log('  ' + l + ': ' + s.features + ' feat / schemaErr ' + s.schemaErrors + ' / dupId ' + s.dupIds + ' / lowConf ' + s.lowConfidence + ' / qaFlagged ' + s.qaFlagged);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e); }
  for (const w of warns) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[canonical-geometry-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
