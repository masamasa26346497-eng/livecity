#!/usr/bin/env node
// tools/build-resolved-canonical.js
// [Mission 31F §2] Resolved Canonical = Canonical + Corrections 適用後の状態を明示化する。
//   このパイプラインでは corrections は canonical build 時に適用済み:
//     - water: build-canonical-water.js が corrections/water/ を適用（安治川 harbor split）
//     - parks: build-canonical-parks.js が 31E RECLASSIFY advisory を適用
//     - roads / buildings / rail: corrections 0 → resolved = canonical（pass-through）
//   resolved/ にはレイヤーごとの lineage manifest を書き、canonical tile を正とする（重複コピーしない）。
//   original canonical / raw source は不変（§0）。
//
//   出力: data/processed/osaka-city/canonical/resolved/{index.json, <layer>.json}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { loadCorrections } from './lib/canonical-corrections.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON = P('data', 'processed', 'osaka-city', 'canonical');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'resolved');
const REPORT = P('data', 'reports', 'resolved-canonical-build.json');

const LAYERS = [
  { layer: 'water', kind: 'body', body: P('data', 'processed', 'osaka-city', 'canonical', 'water.json'), tileDir: P('data', 'processed', 'osaka-city', 'canonical', 'water') },
  { layer: 'roads', kind: 'tiles', tileDir: P('data', 'processed', 'osaka-city', 'canonical', 'roads') },
  { layer: 'buildings', kind: 'tiles', tileDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings'), attrDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'attributes') },
  { layer: 'parks', kind: 'tiles', tileDir: P('data', 'processed', 'osaka-city', 'canonical', 'parks') },
  { layer: 'rail', kind: 'tiles', tileDir: P('data', 'processed', 'osaka-city', 'canonical', 'rail') },
];

function fileHash(p) {
  if (!fs.existsSync(p)) return null;
  return 'sha1:' + crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
}
function countTileFeatures(dir) {
  if (!fs.existsSync(dir)) return { tiles: 0, features: 0 };
  const seen = new Set();
  let tiles = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    tiles++;
    for (const ft of (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')).features || [])) seen.add(ft.canonicalId);
  }
  return { tiles, features: seen.size };
}

async function main() {
  const generatedAt = new Date().toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const layerLineage = [];
  let totalFeatures = 0, totalCorrections = 0, correctionErrors = 0;

  for (const L of LAYERS) {
    const corr = loadCorrections(L.layer);
    const appliedInBuild = [];
    const buildReportPath = P('data', 'reports', `canonical-${L.layer === 'roads' ? 'road' : L.layer === 'buildings' ? 'building' : L.layer}-build.json`);
    let buildReport = null;
    if (fs.existsSync(buildReportPath)) buildReport = JSON.parse(fs.readFileSync(buildReportPath, 'utf-8'));
    // water build report が corrections31E を持つ
    if (buildReport && buildReport.corrections31E) {
      const c31 = buildReport.corrections31E;
      for (const a of (c31.applied || [])) appliedInBuild.push(a);
      correctionErrors += (c31.errors || []).length;
    }

    let counts, manifestPath;
    if (L.kind === 'body') {
      const body = JSON.parse(fs.readFileSync(L.body, 'utf-8'));
      counts = { tiles: countTileFeatures(L.tileDir).tiles, features: body.featureCount };
      manifestPath = L.body;
    } else {
      counts = countTileFeatures(L.tileDir);
      manifestPath = path.join(L.tileDir, 'manifest.json');
    }
    totalFeatures += counts.features;
    const nApplied = appliedInBuild.length + (L.layer === 'parks' && fs.existsSync(P('data', 'processed', 'osaka-city', 'canonical', 'corrections', 'parks', 'park-polygon-reclassify-advisory.json')) ? 1 : 0);
    totalCorrections += nApplied;

    const lineage = {
      layer: L.layer,
      baseCanonical: {
        manifest: toProjectRelativePath(manifestPath),
        hash: fileHash(manifestPath),
        featureCount: counts.features,
        tiles: counts.tiles,
      },
      corrections: {
        recordsInDir: corr.map((r) => ({ correctionId: r.correctionId, operation: r.operation, reviewStatus: r.reviewStatus || null, error: r._error || null })),
        appliedDuringBuild: appliedInBuild,
        appliedCount: nApplied,
        note: L.layer === 'water' ? 'build-canonical-water.js が corrections/water/ を適用済み。resolved geometry = canonical/water.json（補正反映済み）。'
          : L.layer === 'parks' ? 'build-canonical-parks.js が 31E RECLASSIFY advisory を適用済み（parkClass=misclassified-block）。'
            : 'corrections 0。resolved = canonical（pass-through）。',
      },
      resolvedGeometrySource: L.kind === 'body' ? toProjectRelativePath(L.body) : toProjectRelativePath(L.tileDir),
      attributesSource: L.attrDir ? toProjectRelativePath(L.attrDir) : null,
      reversible: true,
      reversibilityNote: 'corrections/<layer>/*.json を削除して該当 build を再実行すれば元 canonical に戻る。raw source は不変。',
    };
    layerLineage.push(lineage);
    await writeJson(path.join(OUT_DIR, L.layer + '.json'), { generatedAt, ...lineage });
    console.log('  ' + L.layer.padEnd(10) + ' features ' + String(counts.features).padStart(7) + ' / corrections ' + nApplied + ' / tiles ' + counts.tiles);
  }

  const index = {
    generatedAt,
    pipeline: 'Source → Canonical → Corrections → [Resolved Canonical] → Derived → LOD → Tile → Render',
    note: 'Resolved Canonical はこのパイプラインでは canonical build 時に corrections を適用済みのため、canonical tile を正とする「view」。geometry の物理コピーはしない（§0: canonical source を壊さない / correction 履歴を消さない）。',
    layers: layerLineage.map((l) => ({
      layer: l.layer,
      featureCount: l.baseCanonical.featureCount,
      correctionsApplied: l.corrections.appliedCount,
      geometrySource: l.resolvedGeometrySource,
    })),
    totalFeatures, totalCorrectionsApplied: totalCorrections, correctionErrors,
    RESULT: correctionErrors === 0 ? 'PASS' : 'CORRECTION-FAIL',
  };
  await writeJson(path.join(OUT_DIR, 'index.json'), index);
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, index);
  console.log('[resolved-canonical] total features ' + totalFeatures + ' / corrections applied ' + totalCorrections + ' / errors ' + correctionErrors);
  console.log('保存: ' + toProjectRelativePath(OUT_DIR) + '/index.json  RESULT: ' + index.RESULT);
  if (correctionErrors > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[resolved-canonical] 失敗:', e && e.stack || e); process.exit(1); });
