#!/usr/bin/env node
// tools/build-ward-building-index.js
// [Mission 31G-FIX9] Ward Mode で「一区の全建物 tile」を確定するためのインデックス。
//   canonical building（不変）を stream し、各 ward が占める 500m building tile 一覧と
//   建物数 / SUPPRESS 数 / renderable 数を出す。runtime は Ward 選択時にこの tile 一覧を
//   全部 progressive load して pin する（camera 移動で消さない）。
//
//   出力: data/processed/osaka-city/derived/building-ward-index.json
//     { version, generatedAt, tileSize, wards: { <wardId>: {
//         buildingCount, suppressCount, reviewCount, exemptCount, renderableCount,
//         tileCount, tiles: [[tx,tz], ...] } } }
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { readFileRetry } from './lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
// [Mission 32N] V2 corrected 用に入出力を環境変数で差し替えられるようにする（未指定なら従来どおり V1）。
const E = process.env;
const envPath = (k, dflt) => (E[k] ? path.resolve(E[k]) : dflt);
const BUILD_DIR = envPath('WARD_INDEX_BUILD_DIR', P('data', 'processed', 'osaka-city', 'canonical', 'buildings'));
const ATTR_DIR = envPath('WARD_INDEX_ATTR_DIR', P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'attributes'));
const PLACE_DIR = envPath('WARD_INDEX_PLACE_DIR', P('data', 'processed', 'osaka-city', 'derived', 'building-placement'));
const OUT = envPath('WARD_INDEX_OUT', P('data', 'processed', 'osaka-city', 'derived', 'building-ward-index.json'));
const REPORT = envPath('WARD_INDEX_REPORT', P('data', 'reports', 'ward-building-index.json'));
const TILE = 500;

function loadPlacement() {
  // canonicalId → policy（SUPPRESS / REVIEW / EXEMPT）。DISPLAY は tile に載らない。
  const m = new Map();
  const mp = path.join(PLACE_DIR, 'manifest.json');
  if (!fs.existsSync(mp)) return m;
  const man = JSON.parse(fs.readFileSync(mp, 'utf-8'));
  for (const t of (man.tiles || [])) {
    const p = path.join(PLACE_DIR, t.file);
    if (!fs.existsSync(p)) continue;
    const tile = JSON.parse(fs.readFileSync(p, 'utf-8'));
    for (const [cid, e] of Object.entries(tile.policies || {})) m.set(cid, e.policy);
  }
  return m;
}

async function main() {
  const generatedAt = new Date().toISOString();
  if (!fs.existsSync(path.join(BUILD_DIR, 'manifest.json'))) { console.error('[ward-index] canonical buildings が無い'); process.exit(1); }
  const placement = loadPlacement();
  console.log(`[ward-index] placement: ${placement.size} 棟（非 DISPLAY）`);

  const wards = {};   // wardId → { tiles:Set('tx_tz'), buildingCount, suppress, review, exempt }
  const ensure = (w) => (wards[w] || (wards[w] = { tiles: new Set(), buildingCount: 0, suppress: 0, review: 0, exempt: 0 }));

  let processed = 0;
  for (const f of fs.readdirSync(BUILD_DIR)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    const tile = JSON.parse(readFileRetry(path.join(BUILD_DIR, f)));
    // attributes（wardId）
    const ap = path.join(ATTR_DIR, f);
    const attrs = fs.existsSync(ap) ? JSON.parse(readFileRetry(ap)).attributes || {} : {};
    for (const ft of (tile.features || [])) {
      processed++;
      const a = Array.isArray(attrs) ? null : attrs[ft.canonicalId];
      const wardId = (a && a.wardId) || null;
      if (!wardId) continue;               // ward 未分類（fallback の一部）は Ward Mode 対象外
      const c = ft.centroid || (ft.bbox ? [(ft.bbox.minX + ft.bbox.maxX) / 2, (ft.bbox.minZ + ft.bbox.maxZ) / 2] : null);
      if (!c) continue;
      const tx = Math.floor(c[0] / TILE), tz = Math.floor(c[1] / TILE);
      const w = ensure(wardId);
      w.tiles.add(tx + '_' + tz);
      w.buildingCount++;
      const pol = placement.get(ft.canonicalId);
      if (pol === 'SUPPRESS') w.suppress++;
      else if (pol === 'REVIEW') w.review++;
      else if (pol === 'EXEMPT') w.exempt++;
    }
    if (processed % 100000 === 0) console.log(`  …${processed} 棟`);
  }

  const out = { version: 1, kind: 'building-ward-index', generatedAt, tileSize: TILE, wards: {} };
  const summary = {};
  for (const [wardId, w] of Object.entries(wards)) {
    const tiles = [...w.tiles].map((k) => k.split('_').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const renderableCount = w.buildingCount - w.suppress;   // §15: SUPPRESS は表示対象外
    out.wards[wardId] = {
      buildingCount: w.buildingCount, suppressCount: w.suppress, reviewCount: w.review, exemptCount: w.exempt,
      renderableCount, tileCount: tiles.length, tiles,
    };
    summary[wardId] = { buildings: w.buildingCount, renderable: renderableCount, tiles: tiles.length };
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));

  const report = {
    generatedAt, tileSize: TILE, wardCount: Object.keys(out.wards).length,
    totalBuildings: Object.values(wards).reduce((s, w) => s + w.buildingCount, 0),
    totalSuppress: Object.values(wards).reduce((s, w) => s + w.suppress, 0),
    perWard: summary,
    maxTilesPerWard: Math.max(...Object.values(out.wards).map((w) => w.tileCount)),
    RESULT: (Object.keys(out.wards).length >= 24) ? 'PASS' : 'CHECK',
  };
  await writeJson(REPORT, report);
  console.log('[ward-index] wards=' + report.wardCount + '  totalBuildings=' + report.totalBuildings + '  maxTiles/ward=' + report.maxTilesPerWard);
  console.log('  例: ' + ['kita', 'chuo', 'sumiyoshi'].map((w) => w + ' ' + JSON.stringify(summary[w])).join(' / '));
  console.log('保存: ' + toProjectRelativePath(OUT) + '  RESULT: ' + report.RESULT);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[ward-index] 失敗:', e && e.stack || e); process.exit(1); });
