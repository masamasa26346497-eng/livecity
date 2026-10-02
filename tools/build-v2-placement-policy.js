#!/usr/bin/env node
// tools/build-v2-placement-policy.js
// [Mission 32P §11-§14] Building Placement Policy を Corrected V2 + OSM fallback V2（600,764 棟）から作り直す。
//
//   入力: data/processed/osaka-city/v2-final/building-overlaps.json（tools/audit/v2-final-overlap.js）
//         … 1m ラスタで測った建物ごとの ROAD V3 / water 重なりと、水域重なりの分類（§9）。
//   旧 V1 由来の policy（31E 索引・tran 道路区域での SUPPRESS）は使わない（§11）。
//
//   規則（§12）:
//     Road  : ROAD V3 の carriageway と比べる。道路との重なりだけでは SUPPRESS しない（最大 REVIEW）。
//     Water : 実在の水上構造（REAL_WATER_STRUCTURE）は EXEMPT。
//             SUPPRESS は「高 confidence の衝突」＝ BUILDING_SOURCE_CONFLICT で footprint のほぼ全部が水面上のときだけ。
//             それ以外の大きな重なりは REVIEW（推測で消さない）。
//
//   出力（V2N namespace だけを置き換える）:
//     data/processed/osaka-city/derived-v2-osmv2/building-placement/{manifest,tile_*}.json
//     public/map-data/osaka-city/derived-v2-osmv2/building-placement/
//     data/processed/osaka-city/derived-v2-osmv2/building-ward-index.json（+ public）
//     data/reports/v2-placement-policy.json
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeFilesVerified, readFileRetry } from './lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const VP = {
  overlaps: P('data', 'processed', 'osaka-city', 'v2-final', 'building-overlaps.json'),
  buildings: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  outDir: P('data', 'processed', 'osaka-city', 'derived-v2-osmv2', 'building-placement'),
  publicDir: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement'),
  wardIndex: P('data', 'processed', 'osaka-city', 'derived-v2-osmv2', 'building-ward-index.json'),
  publicRoot: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2'),
  wardIndexReport: P('data', 'reports', 'ward-building-index-v2-final.json'),
  report: P('data', 'reports', 'v2-placement-policy.json'),
  prevV1: P('data', 'reports', 'building-placement-policy.json'),
  prevV2: P('data', 'reports', 'building-placement-policy-v2-corrected.json'),
  prevV2N: P('data', 'reports', 'building-placement-policy-v2-osmv2.json'),
};
const rj = (p) => JSON.parse(readFileRetry(p));
export const PLACEMENT_VARIANT = 'v2-final';

export const TH = Object.freeze({
  WATER_SUPPRESS_RATIO: 0.85,
  WATER_SUPPRESS_AREA: 15,
  WATER_REVIEW_RATIO: 0.30,
  WATER_EXEMPT_MIN_RATIO: 0.05,
  NARROW_WATERWAY_MAX_RATIO: 0.6,
  ROAD_V3_REVIEW_RATIO: 0.30,
  ROAD_V3_REVIEW_AREA: 10,
});
const NARROW = new Set(['canal', 'drainage', 'ditch']);
const SEMANTIC_RE = /駅|停車場|プラット|ホーム|橋|高架|歩廊|アーケード|回廊|港湾|埠頭|ふ頭|岸壁|物揚|上屋|水門|樋門|閘門|排水機場|ポンプ場|揚水機|ゲート|桟橋|船|渡船|フェリー/;

/** 1 棟の policy（§12）。road overlap だけで SUPPRESS は返さない。 */
export function decideV2(r) {
  const wr = r.area ? r.w / r.area : 0;
  const rr = r.area ? r.v3 / r.area : 0;
  const k = r.water || {};
  const base = { waterOverlapRatio: +wr.toFixed(3), roadOverlapRatio: +rr.toFixed(3), overlapAreaM2: Math.max(r.w, r.v3), roadSource: 'ROAD_V3', waterClass: k.cls || null, conflictId: null };
  if (r.w > 0) {
    if (k.cls === 'REAL_WATER_STRUCTURE' && wr > TH.WATER_EXEMPT_MIN_RATIO) return { policy: 'EXEMPT', reason: 'real-water-structure' + (k.structure ? ':' + k.structure.slice(0, 40) : ''), ...base };
    if (NARROW.has(k.waterClass) && wr < TH.NARROW_WATERWAY_MAX_RATIO) return { policy: 'EXEMPT', reason: 'over-narrow-waterway:' + k.waterClass, ...base };
    if (wr >= TH.WATER_SUPPRESS_RATIO && r.w >= TH.WATER_SUPPRESS_AREA) {
      if (k.cls === 'BUILDING_SOURCE_CONFLICT' && k.waterClass !== 'harbor') return { policy: 'SUPPRESS', reason: 'high-confidence-water-conflict', ...base };
      return { policy: 'REVIEW', reason: 'water-major-overlap:' + (k.cls || '?'), ...base };
    }
    if (wr >= TH.WATER_REVIEW_RATIO) return { policy: 'REVIEW', reason: 'water-partial-overlap:' + (k.cls || '?'), ...base };
  }
  if (rr >= TH.ROAD_V3_REVIEW_RATIO && r.v3 >= TH.ROAD_V3_REVIEW_AREA) {
    if (r.label && SEMANTIC_RE.test(r.label)) return { policy: 'EXEMPT', reason: 'semantic-structure-on-carriageway:' + r.label.slice(0, 12), ...base };
    return { policy: 'REVIEW', reason: 'road-v3-carriageway-overlap', ...base };
  }
  return { policy: 'DISPLAY', reason: (r.w || r.v3) ? 'boundary-overlap-within-tolerance' : 'no-overlap-with-v3-or-water', ...base };
}

export function buildV2Placement() {
  const generatedAt = new Date().toISOString();
  const ov = rj(VP.overlaps);
  const total = ov.totals.buildings;
  const counts = { total, DISPLAY: 0, SUPPRESS: 0, REVIEW: 0, EXEMPT: 0 };
  const byReason = {}, byWaterClass = {}, byWard = {};
  const perTile = new Map();
  const samples = { SUPPRESS: [], REVIEW: [], EXEMPT: [] };
  for (const r of ov.buildings) {
    const d = decideV2(r);
    if (d.policy === 'DISPLAY') continue;
    counts[d.policy]++;
    const rk = d.reason.split(':')[0] + (d.reason.startsWith('water-') ? ':' + d.reason.split(':')[1] : '');
    byReason[d.policy + ' ' + rk] = (byReason[d.policy + ' ' + rk] || 0) + 1;
    if (d.waterClass) byWaterClass[d.policy + ' ' + d.waterClass] = (byWaterClass[d.policy + ' ' + d.waterClass] || 0) + 1;
    const w = (byWard[r.ward || 'none'] ||= { SUPPRESS: 0, REVIEW: 0, EXEMPT: 0 }); w[d.policy]++;
    let pt = perTile.get(r.tile); if (!pt) perTile.set(r.tile, (pt = {}));
    pt[r.id] = d;
    const s = samples[d.policy];
    if (s.length < (d.policy === 'SUPPRESS' ? 100 : 40)) s.push({ canonicalId: r.id, ...d, source: r.src, label: r.label, ward: r.ward, center: r.c, areaM2: r.area, depthM: r.wDepth, waterName: r.water ? r.water.waterName : null, osmCover: r.water ? r.water.osmCover : null });
  }
  counts.DISPLAY = total - counts.SUPPRESS - counts.REVIEW - counts.EXEMPT;

  const files = new Map();
  const tiles = [];
  for (const [key, pt] of [...perTile.entries()].sort()) {
    const [tx, tz] = key.split('_').map(Number);
    const file = `tile_${tx}_${tz}.json`;
    files.set(file, JSON.stringify({ tx, tz, tileSize: 500, generatedAt, policies: pt }));
    tiles.push({ tx, tz, file, count: Object.keys(pt).length });
  }
  const manifest = {
    version: 1, kind: 'building-placement-policy', variant: PLACEMENT_VARIANT, generatedAt, tileSize: 500,
    canonicalBuildingCount: total,
    policyCounts: { DISPLAY: counts.DISPLAY, SUPPRESS: counts.SUPPRESS, REVIEW: counts.REVIEW, EXEMPT: counts.EXEMPT },
    thresholds: TH, roadSource: 'ROAD_V3', waterSource: 'canonical water',
    buildingSet: toProjectRelativePath(VP.buildings), overlapInput: toProjectRelativePath(VP.overlaps), overlapGeneratedAt: ov.generatedAt,
    uses31e: false, usesV1Geometry: false,
    note: 'Mission 32P。DISPLAY は既定。tile には SUPPRESS/REVIEW/EXEMPT のみ。道路との重なりだけでは SUPPRESS しない。',
    tiles,
  };
  files.set('manifest.json', JSON.stringify(manifest, null, 2));
  const w1 = writeFilesVerified(VP.outDir, files, { label: 'v2 placement' });
  const w2 = writeFilesVerified(VP.publicDir, files, { label: 'public v2 placement' });

  // §14 ward index（V2 の N03 区・新 placement）
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', P('tools', 'build-ward-building-index.js')], {
    env: { ...process.env, WARD_INDEX_BUILD_DIR: VP.buildings, WARD_INDEX_ATTR_DIR: path.join(VP.buildings, 'attributes'), WARD_INDEX_PLACE_DIR: VP.outDir, WARD_INDEX_OUT: VP.wardIndex, WARD_INDEX_REPORT: VP.wardIndexReport },
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('ward index の再生成に失敗');
  writeFilesVerified(VP.publicRoot, new Map([['building-ward-index.json', readFileRetry(VP.wardIndex)]]), { label: 'public ward index', settleMs: 5000, removeStray: false });
  const wi = rj(VP.wardIndex);
  const wardCounts = Object.fromEntries(Object.entries(wi.wards || {}).map(([k, v]) => [k, { buildingCount: v.buildingCount, renderableCount: v.renderableCount, tileCount: v.tileCount }]));

  const prev = (p) => (fs.existsSync(p) ? rj(p).policyCounts : null);
  const report = {
    version: 1, generatedAt, missionId: '32P', variant: PLACEMENT_VARIANT,
    buildingSet: { dir: toProjectRelativePath(VP.buildings), total },
    rules: [
      'REAL_WATER_STRUCTURE（用途ラベル or OSM 桟橋/橋/船着場/houseboat）かつ水面比 > 5% → EXEMPT',
      '水路（canal/drainage/ditch）で水面比 < 60% → EXEMPT',
      '水面比 >= 85% かつ 15m² 以上: BUILDING_SOURCE_CONFLICT（harbor 以外）→ SUPPRESS / その他 → REVIEW',
      '水面比 >= 30% → REVIEW',
      'ROAD V3 carriageway 比 >= 30% かつ 10m² 以上 → REVIEW（駅・高架などの用途は EXEMPT）。道路では SUPPRESS しない',
      'それ以外 → DISPLAY',
    ],
    thresholds: TH,
    policyCounts: manifest.policyCounts,
    byReason, byWaterClass, byWard,
    comparison: {
      v1Official: prev(VP.prevV1),
      v2OldOsmPreliminary32N: prev(VP.prevV2),
      v2NewOsmPreliminary32O: prev(VP.prevV2N),
      note: 'v1Official は V1 建物（回転）＋ 31E 索引 ＋ tran 道路区域。32N/32O の値は V2 建物だが tran 道路区域基準の暫定値。',
    },
    wardIndex: { generatedFromV2: true, file: toProjectRelativePath(VP.wardIndex), wards: Object.keys(wardCounts).length, totalBuildings: Object.values(wardCounts).reduce((a, v) => a + v.buildingCount, 0), wardCounts },
    samples,
    writes: { data: w1, public: w2 },
  };
  fs.writeFileSync(VP.report, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  try {
    const r = buildV2Placement();
    console.log('[v2-placement]', JSON.stringify(r.policyCounts), JSON.stringify(r.byReason));
    console.log('[v2-placement] wards', r.wardIndex.wards, 'total', r.wardIndex.totalBuildings);
    for (const s of r.samples.SUPPRESS) console.log('  SUPPRESS', s.canonicalId, s.waterOverlapRatio, s.depthM, s.label, s.ward, s.waterName, s.osmCover, JSON.stringify(s.center));
  } catch (e) { console.error('[v2-placement] 失敗:', e && e.stack || e); process.exit(1); }
}
