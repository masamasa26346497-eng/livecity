#!/usr/bin/env node
// tools/supplement/build-supplement-layer.js  [Issue #65]
// 小範囲補完パイプラインCLI（ネットワーク不要・秘密不要。入力は全て明示指定）。
//   node tools/supplement/build-supplement-layer.js \
//     --existing-dir public/map-data/osaka-city/buildings/osaka-sumiyoshi \
//     --candidates <file> --candidates-format geojson|world \
//     --source osm-v3 --source-version <ver> [--license ODbL-1.0 --license-verified true --attribution <帰属表記>] [--acquired-at ISO] \
//     --out-dir <新規dir(非空不可・既存dirと重ならない)>
//   geojson = WGS84 Polygon/MultiPolygon(Overture/OSM抽出)、world = 旧V3/V4 recovered-index.json 等 {buildings:[{id,ring}]}。
//   入力が取得できない場合は exit 2 と構造化エラー(JSON)を出して終了する（fixtureで代替しない）。
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isMainModule } from '../lib/paths.js';
import { loadFeatures } from '../audit/building-supplement-audit.js';
import { loadExistingTiles, loadWorldCandidates, buildSupplement, writeSupplement, SupplementInputError } from '../lib/supplement-pipeline.js';

export function run(argv) {
  const a = {}; for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['existing-dir', 'candidates', 'source', 'source-version', 'out-dir']) if (!a[k]) throw new SupplementInputError('missing-arg', `--${k} required`);
  const fmt = a['candidates-format'] || 'geojson';
  const existing = loadExistingTiles(a['existing-dir']);
  let candidates, candSha, candInfo = {};
  if (fmt === 'world') { const w = loadWorldCandidates(a.candidates); candidates = w.candidates; candSha = w.sha256; candInfo = { adapter: w.format, declaredCount: w.declaredCount, countMismatch: w.countMismatch }; }
  else if (fmt === 'geojson') {
    try { candSha = crypto.createHash('sha256').update(fs.readFileSync(a.candidates)).digest('hex'); } catch (e) { throw new SupplementInputError('candidates', `cannot read ${a.candidates}: ${e.code || e.message}`); }
    try { candidates = loadFeatures(a.candidates, 'c'); } catch (e) { throw new SupplementInputError('candidates-parse', `invalid GeoJSON: ${a.candidates}`); }
  } else throw new SupplementInputError('bad-format', `--candidates-format must be geojson|world`);
  const ctx = { source: a.source, sourceVersion: a['source-version'], license: a.license, licenseVerified: a['license-verified'] === 'true', attribution: a.attribution, acquiredAt: a['acquired-at'] };
  const result = buildSupplement({ existing, candidates, ctx });
  return writeSupplement({
    outDir: a['out-dir'], result,
    meta: { ctx, tileSize: existing.tileSize, existingDir: a['existing-dir'], existingRef: existing.manifestRef, missingTiles: existing.missingTiles, degradedTiles: existing.degradedTiles, existingStats: existing.stats,
      inputs: { candidates: { file: path.basename(a.candidates), format: fmt, sha256: candSha, count: candidates.length, ...candInfo }, existingTiles: { count: existing.items.length, covered: existing.coveredTiles.size } } },
  });
}
if (isMainModule(import.meta.url)) {
  try { const m = run(process.argv.slice(2)); console.log(JSON.stringify(m.counts, null, 1)); }
  catch (e) {
    if (e instanceof SupplementInputError) { console.error(JSON.stringify({ error: { code: e.code, message: e.message, detail: e.detail } })); process.exit(2); }
    throw e;
  }
}
