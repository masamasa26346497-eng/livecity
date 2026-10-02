#!/usr/bin/env node
// tools/audit/fallback-building-ward-scope.js
// [追加修正タスク｜選択範囲外建物の残留表示] §1-B 範囲外表示の切り分け監査。
//   OSM fallback 建物レコードの wardId を全件検査し、
//     - wardId が付いているか（build 側で centroid-in-ward 判定済みのはず）
//     - centroid を再判定した区と一致するか（区所属ルールの健全性）
//     - footprint が隣区へまたぐ建物の件数（centroid 基準で所属を確定＝§4）
//   を集計する。HTML 側（ward-ux-v1.html）の区スコープ配線
//   （FALLBACK_KEY_PREFIX / applyBand の wardScoped 分岐 / __FALLBACK_BUILDING_DEBUG__）も確認。
//   出力: data/reports/fallback-building-ward-scope-audit.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { indexWards, wardAt } from '../lib/building-coverage.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DS_DIR = P('public', 'map-data', 'osaka-city', 'buildings', 'osaka-osm-fallback');
const WARDS = P('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const REPORT = P('data', 'reports', 'fallback-building-ward-scope-audit.json');

function loadFallbackBuildings() {
  const out = [];
  if (!fs.existsSync(DS_DIR)) return out;
  for (const f of fs.readdirSync(DS_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(DS_DIR, f), 'utf-8'));
    for (const b of (t.buildings || [])) out.push(b);
  }
  return out;
}

async function main() {
  const blds = loadFallbackBuildings();
  const idx = indexWards(JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards || []);
  const validWardIds = new Set(idx.map((w) => w.wardId));
  const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf-8') : '';

  const byWard = {};
  let missingWardId = 0, invalidWardId = 0, centroidMismatch = 0, straddle = 0, outsideAllWards = 0;
  const mismatchSamples = [];
  for (const b of blds) {
    const wid = b.wardId;
    byWard[wid || '(none)'] = (byWard[wid || '(none)'] || 0) + 1;
    if (!wid) { missingWardId++; continue; }
    if (!validWardIds.has(wid)) { invalidWardId++; continue; }
    const cx = b.repX != null ? b.repX : b.fp[0][0];
    const cz = b.repZ != null ? b.repZ : b.fp[0][1];
    const centroidWard = wardAt(cx, cz, idx);
    if (!centroidWard) outsideAllWards++;
    else if (centroidWard !== wid) {
      centroidMismatch++;
      if (mismatchSamples.length < 20) mismatchSamples.push({ id: b.id, stored: wid, centroid: centroidWard });
    }
    // footprint 頂点が別区にまたぐか（centroid 基準で所属確定なので情報として集計）
    if (Array.isArray(b.fp) && b.fp.some(([x, z]) => { const w2 = wardAt(x, z, idx); return w2 && w2 !== wid; })) straddle++;
  }

  const htmlChecks = {
    fallbackKeyPrefix: /const FALLBACK_KEY_PREFIX = 'osm-fallback:';/.test(html),
    perWardBucketing: /wardState\.set\(key, \{ \.\.\.m, status:/.test(html) && /FALLBACK_KEY_PREFIX \+ fw/.test(html),
    applyBandWardScope: /const wardScoped = !cityActive && !!curWard;/.test(html)
      && /wardScoped && wid !== curWard/.test(html)
      && /s\.fbWard === curWard/.test(html),
    getStatsPrefixAware: /wid\.startsWith\(FALLBACK_KEY_PREFIX\)/.test(html),
    fallbackDebugApi: /window\.__FALLBACK_BUILDING_DEBUG__ =/.test(html)
      && /outOfWardVisibleCount/.test(html),
    cityModeUnchanged: /if \(cityActive\)|!cityActive/.test(html), // City Mode 分岐がある
  };

  const dataOk = missingWardId === 0 && invalidWardId === 0 && centroidMismatch === 0;
  const htmlOk = Object.values(htmlChecks).every(Boolean);
  const RESULT = (dataOk && htmlOk && blds.length > 0) ? 'PASS' : 'FAIL';

  const report = {
    generatedAt: new Date().toISOString(),
    dataset: toProjectRelativePath(DS_DIR),
    wardPolygons: toProjectRelativePath(WARDS),
    fallbackBuildings: blds.length,
    wardAssignmentRule: 'footprint centroid が入る区に所属（§4）。centroid が不安定な場合のみ overlap 最大区。emitted は centroid-in-ward を必須にしているため全件 centroid ベース。',
    missingWardId, invalidWardId, centroidMismatch, outsideAllWards,
    straddleWardBuildings: straddle,
    byWard,
    mismatchSamples,
    htmlChecks,
    diagnosis: dataOk
      ? 'fallback 全件が有効な wardId を持ち、centroid 再判定と一致。HTML は区スコープで非選択区を非表示化。'
      : 'wardId の欠落・不整合あり。',
    RESULT,
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[fallback-building-ward-scope] buildings=' + blds.length
    + ' missingWardId=' + missingWardId + ' invalidWardId=' + invalidWardId
    + ' centroidMismatch=' + centroidMismatch + ' straddle=' + straddle + ' htmlOk=' + htmlOk);
  console.log('  htmlChecks: ' + JSON.stringify(htmlChecks));
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + RESULT);
  if (RESULT !== 'PASS') process.exitCode = 1;
}

main().catch((e) => { console.error('[fallback-building-ward-scope] 失敗:', e && e.stack || e); process.exitCode = 1; });
