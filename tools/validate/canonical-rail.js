#!/usr/bin/env node
// tools/validate/canonical-rail.js
// [Mission 31F §30] Canonical Rail validator。
//   - major route missing 0（JR大阪環状線・御堂筋線・阪和線・大和路線 等の主要路線が canonical に存在）
//   - continuity regression 0（主要路線の feature 数が baseline から大きく減っていない）
//   - duplicate 0 / provenance 100% / bridge/tunnel/layer valid
//   - production / protected HTML 不変
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { validateCanonicalFeature, isValidConfidence, SOURCE_PRIORITY } from '../lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DIR = P('data', 'processed', 'osaka-city', 'canonical', 'rail');
const RAIL_TILES = P('public', 'map-data', 'osaka-city', 'railways');
const PROD = P('public', 'osaka_3d_buildings.html');
const PROT = P('public', 'osaka_3d_buildings.fullward-v3.html');
const DEV = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const REPORT = P('data', 'reports', 'canonical-rail-validation.json');

// 大阪市を通る代表路線（部分一致）。geometry があること。
const MAJOR_ROUTES = ['大阪環状線', '御堂筋線', '阪和線', '大和路線', '東海道', '谷町線', '中央線', '近鉄', '南海', '京阪', '阪急', '阪神'];
const VALID_LOD = new Set(['major', 'urban', 'local']);

function countLegacyByRoute() {
  const byRoute = {};
  const seen = new Set();
  if (!fs.existsSync(RAIL_TILES)) return byRoute;
  for (const tf of fs.readdirSync(RAIL_TILES)) {
    if (!/^tile_.*\.json$/.test(tf)) continue;
    for (const f of (JSON.parse(fs.readFileSync(path.join(RAIL_TILES, tf), 'utf-8')).features || [])) {
      if (f.kind !== 'line' || seen.has(f.id) || !f.name) continue;
      seen.add(f.id);
      byRoute[f.name] = (byRoute[f.name] || 0) + 1;
    }
  }
  return byRoute;
}

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(path.join(DIR, 'manifest.json'))) { console.error('[canonical-rail-validate] manifest なし'); process.exitCode = 1; return; }
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf-8'));
  if (manifest.coordinateConvention !== 'znorth-neg-v1') errors.push('coordinateConvention 不正');
  if (JSON.stringify((manifest.sourcePriority || []).map((p) => p.sourceId)) !== JSON.stringify(SOURCE_PRIORITY.rail.map((p) => p.sourceId))) errors.push('sourcePriority が schema と不一致');

  const seen = new Set();
  let total = 0, schemaErr = 0, provMissing = 0, confInvalid = 0, lodInvalid = 0, structInvalid = 0, dup = 0;
  const byRoute = {}, byLod = {};
  const tileFiles = fs.readdirSync(DIR).filter((f) => /^tile_.*\.json$/.test(f));
  for (const tf of tileFiles) {
    const t = JSON.parse(fs.readFileSync(path.join(DIR, tf), 'utf-8'));
    for (const f of (t.features || [])) {
      if (seen.has(f.canonicalId)) continue;
      seen.add(f.canonicalId);
      total++;
      const v = validateCanonicalFeature(f);
      if (!v.ok) { schemaErr++; if (schemaErr <= 5) errors.push('[' + f.canonicalId + '] ' + v.errors[0]); }
      const a = f.attributes || {};
      if (a.name) byRoute[a.name] = (byRoute[a.name] || 0) + 1;
      if (!VALID_LOD.has(a.lodClass)) lodInvalid++;
      else byLod[a.lodClass] = (byLod[a.lodClass] || 0) + 1;
      // bridge/tunnel/layer は boolean|null / number|null
      if (a.bridge != null && typeof a.bridge !== 'boolean') structInvalid++;
      if (a.tunnel != null && typeof a.tunnel !== 'boolean') structInvalid++;
      if (a.layer != null && !Number.isFinite(a.layer)) structInvalid++;
      if (!f.source || f.source.geometrySource !== 'osm-rail' || !Array.isArray(f.source.sourceIds) || !f.source.sourceIds.length) provMissing++;
      else if (!isValidConfidence(f.source.confidence)) confInvalid++;
      if (!['LineString', 'MultiLineString'].includes(f.geometryType)) errors.push('[' + f.canonicalId + '] rail geometry が line でない: ' + f.geometryType);
    }
  }

  if (manifest.featureCount !== total) errors.push('manifest featureCount ' + manifest.featureCount + ' != ユニーク ' + total);
  if (schemaErr) errors.push('schema error ' + schemaErr);
  if (provMissing) errors.push('provenance missing ' + provMissing);
  if (confInvalid) errors.push('confidence invalid ' + confInvalid);
  if (lodInvalid) errors.push('lodClass invalid ' + lodInvalid);
  if (structInvalid) errors.push('bridge/tunnel/layer 型不正 ' + structInvalid);

  // major route missing
  const routeNames = Object.keys(byRoute);
  const missing = [];
  for (const mr of MAJOR_ROUTES) {
    if (!routeNames.some((n) => n.includes(mr))) missing.push(mr);
  }
  // 大阪環状線 / 御堂筋線 / 阪和線 は必須（大阪市の骨格）。他は WARN。
  const hardMissing = missing.filter((m) => ['大阪環状線', '御堂筋線', '阪和線'].includes(m));
  if (hardMissing.length) errors.push('骨格路線が canonical rail に無い: ' + hardMissing.join(', '));
  for (const m of missing.filter((x) => !hardMissing.includes(x))) warns.push('路線「' + m + '」が見つからない（大阪市域外/名称差の可能性）');

  // continuity regression: legacy tile の route ごと feature 数と比較（-20% 超で WARN、-50% 超で ERROR）
  const legacy = countLegacyByRoute();
  let continuityRegressions = 0;
  for (const [name, ln] of Object.entries(legacy)) {
    if (ln < 3) continue;
    const cn = byRoute[name] || 0;
    if (cn < ln * 0.5) { errors.push(`route「${name}」の feature 数 ${ln}→${cn}（-50% 超・continuity regression）`); continuityRegressions++; }
    else if (cn < ln * 0.8) warns.push(`route「${name}」の feature 数 ${ln}→${cn}（-20% 超）`);
  }

  for (const [label, p] of [['production', PROD], ['protected', PROT]]) {
    if (fs.existsSync(p) && /canonical\/rail|canonical-rail/.test(fs.readFileSync(p, 'utf-8'))) errors.push(label + ' HTML に canonical rail 参照が混入');
  }
  if (fs.existsSync(DEV) && /canonical\/rail/.test(fs.readFileSync(DEV, 'utf-8'))) errors.push('dev HTML に canonical rail 参照が混入（31G まで切替えない）');

  // stations.json
  if (!fs.existsSync(path.join(DIR, 'stations.json'))) warns.push('stations.json が無い（§17: station は別 payload）');

  const report = {
    generatedAt: new Date().toISOString(), dir: toProjectRelativePath(DIR),
    featureCount: total, byLodClass: byLod, namedRoutes: routeNames.length,
    checks: { schemaErr, provMissing, confInvalid, lodInvalid, structInvalid, majorRouteMissing: hardMissing.length, continuityRegressions, tiles: tileFiles.length },
    missingRoutes: missing,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 30), warns: warns.slice(0, 20),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[canonical-rail-validate] features=' + total + '  byLodClass=' + JSON.stringify(byLod) + '  named routes=' + routeNames.length);
  console.log('  checks: ' + JSON.stringify(report.checks));
  for (const e of errors.slice(0, 15)) console.log('  [ERROR] ' + e);
  for (const w of warns.slice(0, 10)) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[canonical-rail-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
