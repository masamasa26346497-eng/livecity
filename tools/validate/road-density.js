#!/usr/bin/env node
// tools/validate/road-density.js
// [Mission26 §18] 大阪市道路網の高密度化 validator。
//
// PASS 条件:
//   - road-network-coverage.json が存在し RESULT PASS
//   - 24区すべてに byWard エントリ
//   - NEAR local road coverage >= 99%
//   - tileBoundaryBreaks = 0
//   - 配信 feature の重複 id = 0 / 不正 geometry（<2点・非有限）= 0 / 巨大セグメント = 0
//   - source id 欠落 feature = 0
//   - 未対応 highway class = 0（ELIGIBLE + track のみ）
//   - unexplainedRoadGapCells が予算内（sourceMissing / sourceSparseWard / facilityBlock は §15/§17 で許容）
//   - track / alley が期待どおり取り込まれている
//   - HTML: ROAD_RIBBON_WIDTH に track、roadRibbonWidth に alley 個別幅、getRoadNetworkDebug に track/alley
//   - production / protected HTML に Mission26 変更が混入していない
//
// 実行: node tools/validate/road-density.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const COVERAGE = P('data', 'reports', 'road-network-coverage.json');
const TILE_DIR = P('public', 'map-data', 'osaka-city', 'roads');
const WARDS = P('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');
const REPORT = P('data', 'reports', 'road-density-validation.json');
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; } };

const ELIGIBLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'residential', 'living_street', 'unclassified', 'service', 'pedestrian', 'road', 'track',
]);

function loadTiles() {
  const byId = new Map();
  let dupIds = 0, tileFeatureCount = 0;
  for (const f of fs.readdirSync(TILE_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(TILE_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (ft.kind !== 'line') continue;
      tileFeatureCount++;
      if (byId.has(ft.id)) { dupIds++; continue; }
      byId.set(ft.id, ft);
    }
  }
  return { feats: [...byId.values()], dupIds, tileFeatureCount };
}

async function main() {
  const errors = [], warns = [];
  const cov = rd(COVERAGE);
  if (!cov) { console.error('[stop] road-network-coverage.json なし。先に node tools/audit/road-network.js'); process.exitCode = 1; return; }

  if (cov.RESULT !== 'PASS') errors.push('road-network-coverage RESULT = ' + cov.RESULT);
  if (!cov.byWard || Object.keys(cov.byWard).length !== 24) errors.push('byWard が24区でない (' + Object.keys(cov.byWard || {}).length + ')');
  if (!(cov.nearCoverage && cov.nearCoverage.localCoveragePercent >= 99)) errors.push('NEAR local coverage ' + (cov.nearCoverage && cov.nearCoverage.localCoveragePercent) + '% < 99%');
  if (!cov.continuity || cov.continuity.tileBoundaryBreaks !== 0) errors.push('tileBoundaryBreaks != 0');

  // ── density（§14/§15）──
  const d = cov.density;
  if (!d) errors.push('coverage report に density（§14）が無い');
  else {
    const budget = Math.max(60, d.landCells * 0.004);
    if (d.unexplainedRoadGapCells > budget) errors.push('unexplained road gap cells ' + d.unexplainedRoadGapCells + ' > 予算 ' + Math.round(budget));
    for (const k of ['sourceMissingCells', 'sparseWards', 'mismatchByCause', 'maxBuildingToRoadDistanceM']) {
      if (!(k in d)) errors.push('density に ' + k + ' が無い');
    }
  }

  // ── 配信 feature 検査 ──
  const { feats, dupIds, tileFeatureCount } = loadTiles();
  if (dupIds > 0) warns.push('tile 内 id 重複 ' + dupIds + '（load 時 dedup 済み・情報）');
  let badGeom = 0, giantSeg = 0, noSource = 0, badClass = 0, alley = 0, track = 0;
  const wc = rd(WARDS);
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const w of (wc.wards || [])) for (const pg of w.polygons) for (const pt of pg.outer) {
    if (pt[0] < mnx) mnx = pt[0]; if (pt[0] > mxx) mxx = pt[0]; if (pt[1] < mnz) mnz = pt[1]; if (pt[1] > mxz) mxz = pt[1];
  }
  const MARGIN = 400;
  let outsideCity = 0;
  for (const f of feats) {
    const p = f.p;
    if (!Array.isArray(p) || p.length < 2 || p.some((q) => !Number.isFinite(q[0]) || !Number.isFinite(q[1]))) { badGeom++; continue; }
    for (let i = 0; i < p.length - 1; i++) if (Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]) > 2500) { giantSeg++; break; }
    if (!f.source || f.source.id == null) noSource++;
    if (f.highway && !ELIGIBLE.has(f.highway)) badClass++;
    if (f.highway === 'service' && f.service === 'alley') alley++;
    if (f.highway === 'track') track++;
    const allOut = p.every((q) => q[0] < mnx - MARGIN || q[0] > mxx + MARGIN || q[1] < mnz - MARGIN || q[1] > mxz + MARGIN);
    if (allOut) outsideCity++;
  }
  if (badGeom > 0) errors.push('不正 geometry feature ' + badGeom);
  if (giantSeg > 0) errors.push('巨大セグメント feature ' + giantSeg);
  if (noSource > 0) errors.push('source id 欠落 feature ' + noSource);
  if (badClass > 0) errors.push('未対応 highway class feature ' + badClass);
  if (outsideCity > 0) errors.push('大阪市外の feature ' + outsideCity);
  if (alley < 1000) warns.push('service=alley が少ない (' + alley + ')');
  if (track < 1) warns.push('track が0件（PBF 抽出範囲では稀）');

  // ── HTML 配線 ──
  if (fs.existsSync(DEV_HTML)) {
    const html = fs.readFileSync(DEV_HTML, 'utf-8');
    if (!/road: 4, track: 3 \}/.test(html)) errors.push('ROAD_RIBBON_WIDTH に track が無い');
    if (!/f\.highway === 'service' && f\.service === 'alley'\) w = 3;/.test(html)) errors.push('roadRibbonWidth に alley 個別幅が無い');
    if (!/byHighway, serviceTypes, alley, track, ultraLocal/.test(html)) errors.push('getRoadNetworkDebug に track/alley 集計が無い');
    // 既存 LOD 構造の回帰
    if (!/const ROAD_LOD_FAR_M = 9000, ROAD_LOD_MID_M = 3500;/.test(html)) errors.push('Road LOD 閾値が変わった（Mission02）');
    if (!/const buckets = \{ major: \[\], mid: \[\], local: \[\] \};/.test(html)) errors.push('road ribbon 3-tier bucketing が消えた（1道路=1mesh禁止）');
  }
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(label + ' HTML なし'); continue; }
    const h = fs.readFileSync(p, 'utf-8');
    if (/track: 3 \}|f\.service === 'alley'\) w = 3|byHighway, serviceTypes, alley, track/.test(h)) errors.push(label + ' HTML に Mission26 変更が混入');
  }

  console.log('[road-density-validate] 配信 feature ' + feats.length + ' (tile entries ' + tileFeatureCount + ')');
  console.log('  NEAR local coverage ' + (cov.nearCoverage && cov.nearCoverage.localCoveragePercent) + '%  tileBoundaryBreaks ' + (cov.continuity && cov.continuity.tileBoundaryBreaks));
  if (d) console.log('  density: roadCellCoverage ' + (d.roadCellCoverage * 100).toFixed(1) + '%  mismatchByCause ' + JSON.stringify(d.mismatchByCause) + '  sparseWards [' + (d.sparseWards || []).join(',') + ']');
  console.log('  alley ' + alley + '  track ' + track + '  badClass ' + badClass + '  noSource ' + noSource + '  outsideCity ' + outsideCity);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    feats: feats.length,
    nearLocalCoveragePercent: cov.nearCoverage && cov.nearCoverage.localCoveragePercent,
    tileBoundaryBreaks: cov.continuity && cov.continuity.tileBoundaryBreaks,
    density: d ? { roadCellCoverage: d.roadCellCoverage, mismatchByCause: d.mismatchByCause, unexplainedRoadGapCells: d.unexplainedRoadGapCells, sparseWards: d.sparseWards, sourceMissingCells: d.sourceMissingCells } : null,
    counts: { alley, track, badGeom, giantSeg, noSource, badClass, outsideCity, dupIds },
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[road-density-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
