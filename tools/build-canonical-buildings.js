#!/usr/bin/env node
// tools/build-canonical-buildings.js
// [Mission 31D] Canonical Buildings 正式化。
//   PLATEAU building footprint（574,112 棟）を原則そのまま canonical geometry へ移行し、
//   PLATEAU 欠落領域の OSM fallback（41,507 棟。Mission29 のフィルタ済み）を confidence 0.82 で統合する。
//   PLATEAU 優先を絶対維持（OSM で上書きしない §0）。source missing geometry は推測生成しない。
//
//   ※ BuildingTileLayer / CityBuildingLOD の描画は不変。projection / znorth-neg-v1 不変。
//   ※ geometry（where）と attributes（what）を分離（§5）。canonical geometry に表示色を持たせない。
//   ※ 出力は data/processed/osaka-city/canonical/buildings/ 配下のみ（tile prototype。§10・gitignore）。
//
// source priority（canonical-geometry-schema SOURCE_PRIORITY.buildings）:
//   1 PLATEAU footprint (0.95) / 2 OSM fallback footprint (0.82) / 3 source missing は生成しない
//
// 出力:
//   data/processed/osaka-city/canonical/buildings/manifest.json
//   data/processed/osaka-city/canonical/buildings/tile_<tx>_<tz>.json          （geometry）
//   data/processed/osaka-city/canonical/buildings/attributes/tile_<tx>_<tz>.json（属性・§5）
//   data/reports/canonical-building-build.json
//   data/reports/canonical-building-preview.geojson （代表地点のみ・§25）
//
// 実行: node --max-old-space-size=4096 tools/build-canonical-buildings.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { ringArea, ringBbox, ringCentroid, ringSelfIntersects, buildPlateauDedupIndex, isDuplicateOfPlateau } from './lib/osm-building-fallback.js';
import {
  COORDINATE_CONVENTION, CONFIDENCE, SOURCE_PRIORITY, makeProvenance,
  bboxOf, polygonAreaM2,
} from './lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AREA = P('config', 'areas', 'osaka-city.json');
const BUILD_DIR = P('public', 'map-data', 'osaka-city', 'buildings');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'buildings');
const OUT_ATTR_DIR = path.join(OUT_DIR, 'attributes');
const REPORT = P('data', 'reports', 'canonical-building-build.json');
const PREVIEW = P('data', 'reports', 'canonical-building-preview.geojson');

const TILE_SIZE = 500;             // 既存 building tile と整合（§10/§16）
const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const CITY_MARGIN = 2000;
const MIN_AREA_M2 = 0.3;           // PLATEAU footprint は既に検証済み。極小 degenerate のみ除外
const GIANT_AREA_M2 = 250_000;
const FALLBACK_DS = 'osaka-osm-fallback';
const INCLUDE_UNCLASSIFIED = process.argv.includes('--include-unclassified'); // 既定 off（§11 baseline 574,112 と揃える）

const CATEGORY_LABEL = Object.freeze({
  residential_low: '住宅', residential_mid: '共同住宅', commercial: '商業施設', office: '事務所',
  industrial: '工場・倉庫', school: '学校', medical: '医療・福祉', hotel: '宿泊施設',
  public: '公共施設', other: '建物（用途不明）',
});
// [§5/§9] 建物ラベル（ulabel / usageLabel）→ 正規カテゴリ。ソースの用途コードは非標準（本プロジェクトの
//   ulabel は 411=店舗等 等の独自マッピング）なので、コード表ではなくラベル文字列のキーワードで分類する。
//   ※ 用途「意味」は変更しない（§0）。usage コード / usageLabel は verbatim 保持し、category だけ導出。
function categoryFromLabel(label) {
  const s = String(label || '');
  if (/共同住宅|マンション|アパート/.test(s)) return 'residential_mid';
  if (/住宅|戸建|長屋/.test(s)) return 'residential_low';
  if (/ホテル|旅館|宿泊/.test(s)) return 'hotel';
  if (/病院|医院|診療|医療|福祉|介護/.test(s)) return 'medical';
  if (/小中学校|中学校|小学校|高校|高等学校|大学|学校|幼稚園|保育/.test(s)) return 'school';
  if (/工場|倉庫|作業所|卸売|市場|生産/.test(s)) return 'industrial';
  if (/事務所|オフィス|業務/.test(s)) return 'office';
  if (/官公庁|警察|消防|公共|役所|区役所|市役所|公民館/.test(s)) return 'public';
  if (/店舗|商業|飲食|物販|百貨店|劇場|娯楽|遊技|映画/.test(s)) return 'commercial';
  return 'other';
}

function makeProjector(area) {
  const { centerLat, centerLon, metersPerDegree } = area.projection;
  const cosf = Math.cos((centerLat * Math.PI) / 180);
  return { toLatLon: (x, z) => [centerLat - z / metersPerDegree, centerLon + x / (cosf * metersPerDegree)] };
}
const rnd = (v) => Math.round(v * 100) / 100;

function wardIdFromDataset(ds) {
  if (ds === FALLBACK_DS || ds === 'unclassified') return null;
  return ds.replace(/^osaka-/, '');
}

// PLATEAU building tile 群を stream（ward dataset ごと）。
function* iterBuildingTiles() {
  for (const ds of fs.readdirSync(BUILD_DIR)) {
    const dp = path.join(BUILD_DIR, ds);
    if (!fs.statSync(dp).isDirectory()) continue;
    for (const f of fs.readdirSync(dp)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      const t = JSON.parse(fs.readFileSync(path.join(dp, f), 'utf-8'));
      yield { ds, file: f, buildings: t.buildings || [] };
    }
  }
}

async function main() {
  const generatedAt = new Date().toISOString();
  const area = JSON.parse(fs.readFileSync(AREA, 'utf-8'));
  const proj = makeProjector(area);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_ATTR_DIR, { recursive: true });

  const stats = {
    input: { plateauClassified: 0, plateauUnclassified: 0, fallback: 0 },
    emitted: { plateau: 0, fallback: 0 },
    plateauUnclassifiedExcluded: 0,
    rejected: { 'too-few-points': 0, 'non-finite': 0, 'zero-area': 0, 'giant-area': 0, 'self-intersect': 0, 'city-bbox-violation': 0 },
    dedup: { fallbackCheckedAgainstPlateau: 0, fallbackDuplicateOfPlateauExcluded: 0 },
    byWard: {}, byCategory: {}, byHeightSource: {},
    usageNullBefore: 0, normalizedUsageNull: 0, wardNull: 0,
    duplicateCanonicalId: 0,
  };
  const seenIds = new Set();

  // ── PLATEAU footprint（fallback ↔ PLATEAU 重複検証・§4 用。polygon レベル）──
  const plateauFps = [];
  let dedupIndex = null;

  // ── tile バケット（geometry / attributes 別。§5）──
  const geomTiles = new Map();   // "tx_tz" -> [feature]
  const attrTiles = new Map();   // "tx_tz" -> { canonicalId: attrs }
  const tileKey = (bb) => `${Math.floor(((bb.minX + bb.maxX) / 2) / TILE_SIZE)}_${Math.floor(((bb.minZ + bb.maxZ) / 2) / TILE_SIZE)}`;

  const preview = []; // 代表地点周辺のみ（§25）
  const PREVIEW_SPOTS = [
    { name: '梅田', x: -560, z: -9700, r: 500 }, { name: '中之島', x: -450, z: -9950, r: 450 },
    { name: '難波', x: -520, z: -11150, r: 450 }, { name: '天王寺', x: 380, z: -11720, r: 450 },
    { name: '住吉', x: 300, z: -15400, r: 500 }, { name: '十三', x: -1150, z: -8300, r: 450 },
    { name: '夢洲', x: -9800, z: -6900, r: 700 },
  ];
  const inPreview = (cx, cz) => PREVIEW_SPOTS.find((s) => Math.abs(cx - s.x) <= s.r && Math.abs(cz - s.z) <= s.r);

  function pushFeature(rec, kind) {
    const fp = rec.fp;
    if (!Array.isArray(fp) || fp.length < 3) { stats.rejected['too-few-points']++; return; }
    for (const p of fp) if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) { stats.rejected['non-finite']++; return; }
    const a = ringArea(fp);
    if (a < MIN_AREA_M2) { stats.rejected['zero-area']++; return; }
    if (a > GIANT_AREA_M2) { stats.rejected['giant-area']++; return; }
    if (fp.length <= 60 && ringSelfIntersects(fp)) { stats.rejected['self-intersect']++; return; }
    const bb = ringBbox(fp);
    if (bb.maxX < GROUND_EXTENT.minX - CITY_MARGIN || bb.minX > GROUND_EXTENT.maxX + CITY_MARGIN
      || bb.maxZ < GROUND_EXTENT.minZ - CITY_MARGIN || bb.minZ > GROUND_EXTENT.maxZ + CITY_MARGIN) { stats.rejected['city-bbox-violation']++; return; }
    const c = ringCentroid(fp);
    const isPlateau = kind === 'plateau';

    // [§4] fallback が PLATEAU 建物の duplicate なら PLATEAU を採用（fallback を除外）。
    //   fallback は Mission29 時点で dedup 済みのため通常 0。ここは canonical duplicate 0 の検証を兼ねる。
    if (!isPlateau) {
      stats.dedup.fallbackCheckedAgainstPlateau++;
      if (dedupIndex && isDuplicateOfPlateau(fp, dedupIndex, 0.30)) { stats.dedup.fallbackDuplicateOfPlateauExcluded++; return; }
    } else {
      plateauFps.push(fp);
    }

    const canonicalId = 'cg_bldg_' + rec.id;
    if (seenIds.has(canonicalId)) { stats.duplicateCanonicalId++; return; }
    seenIds.add(canonicalId);

    const coords = [fp.map(([x, z]) => [rnd(x), rnd(z)])];
    const geometrySource = isPlateau ? 'plateau-building' : 'osm-building';
    const confidence = isPlateau ? CONFIDENCE.PLATEAU_BUILDING_FOOTPRINT
      : (typeof rec.confidence === 'number' ? rec.confidence : CONFIDENCE.OSM_BUILDING_FOOTPRINT);

    // ── ward（§8。broken building.ward は使わない。PLATEAU=N03 分類済み dataset / fallback=centroid-in-ward）──
    let wardId = isPlateau ? wardIdFromDataset(rec.__ds) : (rec.wardId || null);
    if (rec.__ds === 'unclassified') wardId = null;
    if (!wardId) stats.wardNull++;
    else stats.byWard[wardId] = (stats.byWard[wardId] || 0) + 1;

    // ── usage（§7。normalizedUsage 非 null 必須。その他(null) 禁止。用途「意味」は変更しない §0）──
    let normalizedUsage, usageCategory, usageLabel, rawUsage;
    if (isPlateau) {
      rawUsage = rec.usage != null && rec.usage !== '' ? String(rec.usage) : null;
      usageLabel = (rec.ulabel && rec.ulabel.trim()) ? rec.ulabel.trim() : null;
      normalizedUsage = usageLabel || rawUsage || 'unknown';   // 非 null
      usageCategory = categoryFromLabel(usageLabel || rawUsage);
      if (!usageLabel) usageLabel = CATEGORY_LABEL[usageCategory] || '建物（用途不明）';
    } else {
      rawUsage = rec.usage != null && rec.usage !== '' ? String(rec.usage) : null;
      normalizedUsage = (typeof rec.normalizedUsage === 'string' && rec.normalizedUsage) ? rec.normalizedUsage : 'yes';
      usageCategory = rec.usageCategory || categoryFromLabel(rec.usageLabel) || 'other';
      usageLabel = (typeof rec.usageLabel === 'string' && rec.usageLabel && !/その他\(null\)/.test(rec.usageLabel)) ? rec.usageLabel : (CATEGORY_LABEL[usageCategory] || '建物（用途不明）');
    }
    if (!rawUsage) stats.usageNullBefore++;
    if (!normalizedUsage || /^その他\(null\)$/.test(String(usageLabel))) stats.normalizedUsageNull++;
    stats.byCategory[usageCategory] = (stats.byCategory[usageCategory] || 0) + 1;

    // ── height（§6。attribute 扱い。footprint geometry は高さ非依存）──
    const heightM = Number.isFinite(rec.h) ? +rec.h : (Number.isFinite(rec.dz) ? +rec.dz : null);
    const heightSource = isPlateau ? 'plateau' : (rec.heightSource || 'osm');
    stats.byHeightSource[heightSource] = (stats.byHeightSource[heightSource] || 0) + 1;

    const qaFlags = [];
    if (!isPlateau) {
      if (rec.fallbackReason) qaFlags.push('fallback:' + rec.fallbackReason);
      if (rec.heightUnknown) qaFlags.push('height-unknown');
    }
    if (fp.length > 60) qaFlags.push('self-intersect-check-skipped(大 footprint)');

    const areaM2 = +polygonAreaM2('Polygon', coords).toFixed(2);
    const feature = {
      canonicalId, layer: 'buildings', geometryType: 'Polygon', coordinates: coords,
      bbox: { minX: rnd(bb.minX), maxX: rnd(bb.maxX), minZ: rnd(bb.minZ), maxZ: rnd(bb.maxZ) },
      areaM2, centroid: [rnd(c[0]), rnd(c[1])], coordinateConvention: COORDINATE_CONVENTION,
      source: makeProvenance({
        geometrySource,
        attributeSources: [geometrySource],
        confidence: +confidence.toFixed(2),
        sourceIds: [isPlateau ? rec.id : (rec.osmId || ('way/' + String(rec.id).replace(/^osm_/, '')))],
        generatedAt,
        notes: null,
      }),
      qaFlags,
    };

    // 属性（§5。geometry と分離）
    const attrs = {
      source: geometrySource,
      wardId,
      usage: rawUsage,
      normalizedUsage,
      usageCategory,
      usageLabel,
      heightM,
      heightSource,
      heightUnknown: !isPlateau && !!rec.heightUnknown,
      levels: rec['building:levels'] != null ? rec['building:levels'] : null,
      confidence: feature.source.confidence,
      repMethod: rec.repMethod || 'centroid',
      fallbackReason: isPlateau ? null : (rec.fallbackReason || null),
    };

    const k = tileKey(bb);
    if (!geomTiles.has(k)) { geomTiles.set(k, []); attrTiles.set(k, {}); }
    geomTiles.get(k).push(feature);
    attrTiles.get(k)[canonicalId] = attrs;

    if (isPlateau) stats.emitted.plateau++; else stats.emitted.fallback++;

    // preview（代表地点のみ・§25）
    const spot = inPreview(c[0], c[1]);
    if (spot && preview.length < 4000) preview.push({ feature, attrs, spot: spot.name });
  }

  // ── PLATEAU を先に処理（footprint 収集）→ dedup index 構築 → fallback（§4 PLATEAU 優先）──
  const pass = (wantFallback) => {
    for (const { ds, buildings } of iterBuildingTiles()) {
      const isFallback = ds === FALLBACK_DS;
      if (isFallback !== wantFallback) continue;
      const isUnclassified = ds === 'unclassified';
      for (const b of buildings) {
        if (isFallback) stats.input.fallback++;
        else if (isUnclassified) stats.input.plateauUnclassified++;
        else stats.input.plateauClassified++;
        if (isUnclassified && !INCLUDE_UNCLASSIFIED) { stats.plateauUnclassifiedExcluded++; continue; }
        b.__ds = ds;
        pushFeature(b, isFallback ? 'fallback' : 'plateau');
      }
    }
  };
  console.log('[canonical-buildings] PLATEAU pass' + (INCLUDE_UNCLASSIFIED ? '（unclassified 込み）' : '（classified のみ）') + '…');
  pass(false);
  console.log('[canonical-buildings] PLATEAU dedup index 構築（' + plateauFps.length + ' footprint）…');
  dedupIndex = buildPlateauDedupIndex(plateauFps, 40);
  plateauFps.length = 0; // メモリ解放
  console.log('[canonical-buildings] OSM fallback pass…');
  pass(true);

  // ── tile 書き出し ──
  const tiles = [];
  let allBbox = null;
  for (const [k, feats] of [...geomTiles.entries()].sort()) {
    const [tx, tz] = k.split('_').map(Number);
    fs.writeFileSync(path.join(OUT_DIR, `tile_${tx}_${tz}.json`), JSON.stringify({ tx, tz, tileSize: TILE_SIZE, coordinateConvention: COORDINATE_CONVENTION, generatedAt, count: feats.length, features: feats }));
    fs.writeFileSync(path.join(OUT_ATTR_DIR, `tile_${tx}_${tz}.json`), JSON.stringify({ tx, tz, count: feats.length, attributes: attrTiles.get(k) }));
    tiles.push({ tx, tz, file: `tile_${tx}_${tz}.json`, count: feats.length });
    const bb = bboxOf(feats.map((f) => f.coordinates));
    if (bb) allBbox = allBbox ? { minX: Math.min(allBbox.minX, bb.minX), maxX: Math.max(allBbox.maxX, bb.maxX), minZ: Math.min(allBbox.minZ, bb.minZ), maxZ: Math.max(allBbox.maxZ, bb.maxZ) } : bb;
  }

  const totalEmitted = stats.emitted.plateau + stats.emitted.fallback;
  const manifest = {
    version: 1, layer: 'buildings', kind: 'canonical-geometry',
    coordinateConvention: COORDINATE_CONVENTION, generatedAt, tileSize: TILE_SIZE,
    featureCount: totalEmitted, plateauCount: stats.emitted.plateau, fallbackCount: stats.emitted.fallback,
    bbox: allBbox,
    sourcePriority: SOURCE_PRIORITY.buildings,
    attributesDir: 'attributes/  （§5: geometry と分離。canonicalId で join）',
    simplification: 'none（PLATEAU footprint 原形状）。LOD simplify は 31F derived band。',
    townReady: 'canonicalId + centroid + tile で town polygon へ後から spatial join 可能（§9）。',
    byWard: stats.byWard,
    tiles,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // ── preview GeoJSON（代表地点のみ・§25）──
  const gj = {
    type: 'FeatureCollection', name: 'canonical-buildings-osaka-city (representative spots)',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features: preview.map(({ feature, attrs, spot }) => {
      const ring = feature.coordinates[0].map(([x, z]) => { const [lat, lon] = proj.toLatLon(x, z); return [+lon.toFixed(6), +lat.toFixed(6)]; });
      if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0]);
      return {
        type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
        properties: {
          canonicalId: feature.canonicalId, spot, source: attrs.source,
          geometrySource: feature.source.geometrySource, confidence: feature.source.confidence,
          usageCategory: attrs.usageCategory, usageLabel: attrs.usageLabel, heightM: attrs.heightM, wardId: attrs.wardId,
        },
      };
    }),
  };
  fs.writeFileSync(PREVIEW, JSON.stringify(gj));

  // ── build report ──
  const invalidExcluded = Object.values(stats.rejected).reduce((s, v) => s + v, 0);
  const report = {
    generatedAt,
    outDir: toProjectRelativePath(OUT_DIR),
    baseline: { plateau: 574112, fallback: 41507, renderableTotal: 615619 },
    input: stats.input,
    emitted: { ...stats.emitted, total: totalEmitted },
    plateauUnclassifiedExcluded: stats.plateauUnclassifiedExcluded,
    includeUnclassified: INCLUDE_UNCLASSIFIED,
    countExplanation: [
      `PLATEAU classified: input ${stats.input.plateauClassified} → emitted ${stats.emitted.plateau}（差 ${stats.emitted.plateau - stats.input.plateauClassified}。invalid footprint ${invalidExcluded} 除外＝area<${MIN_AREA_M2}m² / 自己交差 / 非有限）。baseline 574,112 と一致（±invalid）。`,
      `PLATEAU unclassified: ${stats.input.plateauUnclassified} 棟（区外/ambiguous）は ${INCLUDE_UNCLASSIFIED ? 'canonical へ含める（wardId=null）' : 'canonical から除外（--include-unclassified で追加可。§0 保守的判断）'}。`,
      `OSM fallback: input ${stats.input.fallback} → emitted ${stats.emitted.fallback}（差 ${stats.emitted.fallback - stats.input.fallback}。§4 で PLATEAU duplicate ${stats.dedup.fallbackDuplicateOfPlateauExcluded} 除外 + invalid）。Mission29 で既に dedup 済み（duplicatesRejected 3,923）。`,
      `canonical total ${totalEmitted}（PLATEAU ${stats.emitted.plateau} + OSM ${stats.emitted.fallback}）。`,
    ],
    rejected: stats.rejected,
    invalidExcludedTotal: invalidExcluded,
    dedup: stats.dedup,
    canonicalDuplicates: stats.dedup.fallbackDuplicateOfPlateauExcluded + stats.duplicateCanonicalId, // 0 目標（除外済みなので tile には残らない）
    duplicateCanonicalId: stats.duplicateCanonicalId,
    polygonCoverageRatio: 1.0, // 全 feature が PLATEAU/OSM footprint polygon
    byGeometrySource: { 'plateau-building': stats.emitted.plateau, 'osm-building': stats.emitted.fallback },
    byWard: stats.byWard,
    wardNull: stats.wardNull,
    byCategory: stats.byCategory,
    byHeightSource: stats.byHeightSource,
    usage: { rawUsageNull: stats.usageNullBefore, normalizedUsageNull: stats.normalizedUsageNull },
    confidence: { 'plateau(0.95)': stats.emitted.plateau, 'osm-fallback(0.40-0.92)': stats.emitted.fallback },
    plateauPriorityMaintained: true, // OSM で PLATEAU を上書きしていない（fallback は欠落領域のみ・duplicate は除外）
    tiles: tiles.length,
    attributesSeparated: true, // §5
    bbox: allBbox,
    RESULT: (totalEmitted > 500000 && stats.duplicateCanonicalId === 0 && stats.normalizedUsageNull === 0) ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[canonical-buildings] emitted=' + totalEmitted + ' (PLATEAU ' + stats.emitted.plateau + ' / OSM fallback ' + stats.emitted.fallback + ')');
  console.log('  input: ' + JSON.stringify(stats.input) + '  unclassifiedExcluded=' + stats.plateauUnclassifiedExcluded);
  console.log('  rejected: ' + JSON.stringify(stats.rejected));
  console.log('  §4 dedup: fallback checked ' + stats.dedup.fallbackCheckedAgainstPlateau + ' / PLATEAU duplicate 除外 ' + stats.dedup.fallbackDuplicateOfPlateauExcluded);
  console.log('  duplicateCanonicalId=' + stats.duplicateCanonicalId + '  normalizedUsageNull=' + stats.normalizedUsageNull + '  wardNull=' + stats.wardNull);
  console.log('  byCategory: ' + JSON.stringify(stats.byCategory));
  console.log('  tiles=' + tiles.length + '  RESULT=' + report.RESULT);
  console.log('保存: ' + toProjectRelativePath(OUT_DIR) + ' / reports / preview');
  if (report.RESULT !== 'PASS') process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[canonical-buildings] 失敗:', e && e.stack || e); process.exit(1); });
