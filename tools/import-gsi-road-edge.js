#!/usr/bin/env node
// tools/import-gsi-road-edge.js
// [Mission 31G-FIX15] GSI 基盤地図情報「道路縁」(RdEdg) の import pipeline。
//   raw（data/raw/gsi/road-edge/）→ normalize（Live City world・znorth-neg-v1）→
//   大阪市域 clip（N03 行政界）→ geometry validation → report。
//
//   §0/§8 遵守: source geometry（raw ファイル）は一切書き換えない。normalize 段階でも
//   simplify/buffer/snap/pair/polygonize はしない（座標変換のみ）。
//   §4 遵守: CRS が地理座標（lat/lon, JGD2000/JGD2011）以外（平面直角座標系等）の場合は
//   変換せず crsUnsupported として記録する（第6系等への強制変換はしない）。
//
//   実データが data/raw/gsi/road-edge/ に無い場合はエラーで落とさず
//   GSI_ROAD_EDGE_RAW_DATA_MISSING を表示して正常終了する（§2）。
//
// 出力:
//   data/processed/osaka-city/gsi-road-edge/road-edge-lines.json
//   data/processed/osaka-city/gsi-road-edge/manifest.json
//   data/reports/gsi-road-edge-prototype.json（base セクション。§28 スキーマ）
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { listCandidateFiles, detectFileFormat, detectFormat } from './lib/gsi-road-edge-format.js';
import { readZipEntries, extractEntry } from './lib/zip-reader.js';
import { parseRoadEdgeGml, detectDocumentCrs, posListToPairs } from './lib/gsi-road-edge-gml.js';
import { classifyCrs, latLonPairsToWorld, loadWards, touchesOsakaCity } from './lib/gsi-road-edge-transform.js';
import { validateLines } from './lib/gsi-road-edge-validate.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const RAW_DIR = P('data', 'raw', 'gsi', 'road-edge');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'gsi-road-edge');
const OUT_LINES = path.join(OUT_DIR, 'road-edge-lines.json');
const OUT_MANIFEST = path.join(OUT_DIR, 'manifest.json');
const REPORT = P('data', 'reports', 'gsi-road-edge-prototype.json');

function readExistingReport() {
  try { return JSON.parse(fs.readFileSync(REPORT, 'utf-8')); } catch { return {}; }
}

// ── 個別 GML 文字列 → RdEdg feature 群（world 未変換の raw record）を抽出 ──
function parseGmlText(xml, sourceFile) {
  const docCrs = detectDocumentCrs(xml);
  const { features, otherFeatureTypes } = parseRoadEdgeGml(xml);
  return { docCrs, otherFeatureTypes, records: features.map((f) => ({ ...f, sourceFile, docCrs })) };
}

function parseGeoJsonText(text, sourceFile) {
  let gj;
  try { gj = JSON.parse(text); } catch { return { docCrs: null, otherFeatureTypes: [], records: [] }; }
  const feats = gj.type === 'FeatureCollection' ? (gj.features || []) : gj.type === 'Feature' ? [gj] : [];
  const records = [];
  for (const f of feats) {
    const g = f.geometry || f;
    if (!g || !g.type) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      // GeoJSON は [lon, lat] 順（EPSG:4326 既定）。posListToPairs と揃えるため lat,lon の pairs へ。
      const pairsLatLon = line.map(([lon, lat]) => [lat, lon]);
      records.push({ id: f.id || (f.properties && f.properties.id) || null, srsName: 'EPSG:4326', posListRaw: [], coordsCount: pairsLatLon.length, attrs: f.properties || {}, sourceFile, docCrs: 'EPSG:4326', _pairsLatLon: pairsLatLon });
    }
  }
  return { docCrs: 'EPSG:4326', otherFeatureTypes: [], records };
}

async function main() {
  const generatedAt = new Date().toISOString();
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const files = listCandidateFiles(RAW_DIR);

  if (files.length === 0) {
    const report = {
      ...readExistingReport(),
      generatedAt,
      rawDataPresent: false,
      sourceFiles: [],
      sourceCrs: null,
      featureType: null,
      featureCount: 0,
      osakaFeatureCount: 0,
      invalidCount: 0,
      duplicateCount: 0,
      coverage: null,
      sampleAreas: null,
      STATUS: 'GSI_ROAD_EDGE_RAW_DATA_MISSING',
      userAction: 'GSI 基盤地図情報から大阪市を含む道路縁（RdEdg）データを取得し、data/raw/gsi/road-edge/ へ配置してください（ZIP のまま可。詳細: data/raw/gsi/road-edge/README.md）。',
      canonicalRoadUnchanged: true,
      canonicalBuildingUnchanged: true,
      fix13RoadVisualSurfaceUnchanged: true,
    };
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    await writeJson(REPORT, report);
    console.log('[import-gsi-road-edge] GSI_ROAD_EDGE_RAW_DATA_MISSING');
    console.log('  ' + report.userAction);
    console.log('保存: ' + toProjectRelativePath(REPORT));
    return;
  }

  // ── raw ファイル読み込み・形式判定 ──
  const wards = loadWards();
  const sourceFiles = [];
  const allRecords = [];
  const otherFeatureTypesSet = new Set();
  const formatCounts = {};
  const unparsedFiles = [];

  for (const filePath of files) {
    const fmt = detectFileFormat(filePath);
    formatCounts[fmt] = (formatCounts[fmt] || 0) + 1;
    const rel = toProjectRelativePath(filePath);
    sourceFiles.push({ path: rel, format: fmt, bytes: fs.statSync(filePath).size });

    if (fmt === 'gml-xml') {
      const xml = fs.readFileSync(filePath, 'utf-8');
      const { docCrs, otherFeatureTypes, records } = parseGmlText(xml, rel);
      otherFeatureTypes.forEach((t) => otherFeatureTypesSet.add(t));
      allRecords.push(...records);
    } else if (fmt === 'geojson') {
      const { records } = parseGeoJsonText(fs.readFileSync(filePath, 'utf-8'), rel);
      allRecords.push(...records);
    } else if (fmt === 'zip') {
      let entries;
      try { entries = readZipEntries(filePath); } catch (e) { unparsedFiles.push({ path: rel, reason: 'ZIP 読み込み失敗: ' + e.message }); continue; }
      for (const entry of entries) {
        if (entry.uncompSize === 0) continue;
        let buf;
        try { buf = extractEntry(filePath, entry); } catch { continue; }
        const efmt = detectFormat(buf.slice(0, 512));
        const entryRel = rel + '::' + entry.name;
        if (efmt === 'gml-xml') {
          const { docCrs, otherFeatureTypes, records } = parseGmlText(buf.toString('utf-8'), entryRel);
          otherFeatureTypes.forEach((t) => otherFeatureTypesSet.add(t));
          allRecords.push(...records);
        } else if (efmt === 'geojson') {
          const { records } = parseGeoJsonText(buf.toString('utf-8'), entryRel);
          allRecords.push(...records);
        } else if (efmt === 'shapefile') {
          unparsedFiles.push({ path: entryRel, reason: 'Shapefile 検出（このバージョンでは未パース。GML/GeoJSON を優先取得してください）' });
        }
      }
    } else if (fmt === 'shapefile') {
      unparsedFiles.push({ path: rel, reason: 'Shapefile 検出（このバージョンでは未パース。GML/GeoJSON を優先取得してください）' });
    } else {
      unparsedFiles.push({ path: rel, reason: '未知の形式（拡張子ではなく内容から判定した結果）' });
    }
  }

  // ── CRS 分類・世界座標変換・大阪市 clip ──
  const crsCounts = {};
  let crsUnsupportedCount = 0, osakaExternalCount = 0;
  const normalizedFeatures = [];
  const importedAt = generatedAt;
  for (const rec of allRecords) {
    const srs = rec.srsName || rec.docCrs;
    crsCounts[srs || '(unknown)'] = (crsCounts[srs || '(unknown)'] || 0) + 1;

    let pairsLatLon;
    if (rec._pairsLatLon) {
      pairsLatLon = rec._pairsLatLon;
    } else {
      const cls = classifyCrs(srs);
      if (!cls.supported) { crsUnsupportedCount++; continue; }
      pairsLatLon = [];
      for (const raw of rec.posListRaw) pairsLatLon.push(...posListToPairs(raw, cls.axisOrder === 'lon-lat' ? 'lon-lat' : 'lat-lon'));
    }
    if (pairsLatLon.length < 2) continue;
    const worldCoords = latLonPairsToWorld(pairsLatLon);
    if (!touchesOsakaCity(worldCoords, wards)) { osakaExternalCount++; continue; }

    normalizedFeatures.push({
      id: 'gsi_rdedg_' + (rec.id || normalizedFeatures.length),
      geometry: { type: 'LineString', coordinates: worldCoords },
      sourceCrs: srs || null,
      sourceDataset: 'GSI-kiban-road-edge',
      sourceFeatureId: rec.id || null,
      sourceDate: (rec.attrs && rec.attrs.devDate) || null,
      confidence: 0.7,   // §14 とは別軸（データ取り込み時点の confidence。pairing confidence は sample-compare で別付与）
      provenance: { sourceFile: rec.sourceFile, importedAt },
      attrs: rec.attrs || {},
    });
  }

  const { stats: valStats, invalidIds, duplicateIds } = validateLines(normalizedFeatures);
  const cleanFeatures = normalizedFeatures.filter((f) => !invalidIds.includes(f.id));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  await writeJson(OUT_LINES, { version: 1, kind: 'gsi-road-edge-lines', generatedAt, coordinateConvention: 'znorth-neg-v1', count: cleanFeatures.length, features: cleanFeatures });
  const manifest = {
    version: 1, generatedAt, sourceFiles: sourceFiles.map((s) => s.path), formatCounts, crsCounts,
    featureCountRaw: allRecords.length, featureCountNormalized: normalizedFeatures.length, featureCountClean: cleanFeatures.length,
    crsUnsupportedCount, osakaExternalCount, unparsedFiles,
    otherFeatureTypes: [...otherFeatureTypesSet],
    validation: valStats,
    note: 'source geometry 不変（raw ファイルは加工していない）。simplify/buffer/snap/pair/polygonize は行っていない（§8）。',
  };
  await writeJson(OUT_MANIFEST, manifest);

  const report = {
    ...readExistingReport(),
    generatedAt,
    rawDataPresent: true,
    sourceFiles: sourceFiles.map((s) => s.path),
    sourceFormats: formatCounts,
    sourceCrs: Object.keys(crsCounts),
    featureType: { primary: 'RdEdg', otherTypesInSameFiles: [...otherFeatureTypesSet] },
    featureCount: allRecords.length,
    osakaFeatureCount: cleanFeatures.length,
    invalidCount: valStats.invalidCoordinates + valStats.zeroLength + valStats.extremeOutlier,
    duplicateCount: valStats.duplicates,
    selfIntersectingCount: valStats.selfIntersecting,
    crsUnsupportedCount,
    osakaExternalCount,
    unparsedFiles,
    coverage: cleanFeatures.length > 0 ? ('大阪市域に触れる RdEdg line ' + cleanFeatures.length + ' 件を抽出') : '大阪市域内 feature 0 件（source coverage 不足の可能性）',
    STATUS: cleanFeatures.length > 0 ? 'GSI_ROAD_EDGE_IMPORTED' : 'GSI_ROAD_EDGE_IMPORTED_ZERO_OSAKA_FEATURES',
    canonicalRoadUnchanged: true,
    canonicalBuildingUnchanged: true,
    fix13RoadVisualSurfaceUnchanged: true,
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[import-gsi-road-edge] files=' + sourceFiles.length + ' rawRecords=' + allRecords.length
    + ' normalized=' + normalizedFeatures.length + ' clean(Osaka内)=' + cleanFeatures.length);
  console.log('  crsUnsupported=' + crsUnsupportedCount + ' osakaExternal=' + osakaExternalCount + ' invalid=' + report.invalidCount + ' duplicate=' + report.duplicateCount);
  console.log('  保存: ' + toProjectRelativePath(OUT_LINES) + ' / ' + toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[import-gsi-road-edge] 失敗:', e && e.stack || e); process.exit(1); });
