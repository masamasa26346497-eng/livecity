#!/usr/bin/env node
// tools/import-gsi-building-area.js
// [Mission 32B §2] GSI 基盤地図情報「建築物」(BldA) の import pipeline。
//   raw（data/raw/gsi/building-outline/、BldLと同じZIP群に同梱）→ normalize（Live City world・
//   znorth-neg-v1）→ 大阪市域 clip（N03 行政界）→ geometry validation → report。
//
//   §0/§5 遵守: source geometry（raw ファイル）は一切書き換えない。normalize 段階でも
//   simplify/buffer/snap/pair/polygonize はしない（座標変換のみ）。
//   §2 実測確認（tools/lib/gsi-building-area-gml.js のヘッダ参照）: BldA は Polygon
//   （exterior 1 + interior 0..N・中庭等の穴を保持）。BldL（外周線）より直接的な footprint polygon。
//
//   tools/import-gsi-building-outline.js（BldL用）と同じ zip-of-zips 対応・重複メッシュ検出・
//   streaming書込パターンを踏襲する（コードは重複するが、対象feature typeが異なるため独立ファイルとし、
//   既存BldLパイプラインには一切触れない＝§0の「既存を壊さない」を優先）。
//
// 出力:
//   data/processed/osaka-city/gsi-building-area/building-area-polygons.json
//   data/processed/osaka-city/gsi-building-area/manifest.json
//   data/reports/gsi-building-area-import.json
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { listCandidateFiles, detectFileFormat, detectFormat } from './lib/gsi-road-edge-format.js';
import { readZipEntries, extractEntry, readZipEntriesFromBuffer, extractEntryFromBuffer } from './lib/zip-reader.js';
import { parseBuildingAreaGml, detectDocumentCrs, posListToPairs } from './lib/gsi-building-area-gml.js';
import { classifyCrs, latLonPairsToWorld, loadWards, touchesOsakaCity } from './lib/gsi-road-edge-transform.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const RAW_DIR = P('data', 'raw', 'gsi', 'building-outline'); // BldLと同一raw配置（同じZIP群に同梱のため）
const OUT_DIR = P('data', 'processed', 'osaka-city', 'gsi-building-area');
const OUT_POLYGONS = path.join(OUT_DIR, 'building-area-polygons.json');
const OUT_MANIFEST = path.join(OUT_DIR, 'manifest.json');
const REPORT = P('data', 'reports', 'gsi-building-area-import.json');

function readExistingReport() { try { return JSON.parse(fs.readFileSync(REPORT, 'utf-8')); } catch { return {}; } }

// [同じ理由でstreaming書込] BldA は exterior+interior双方を持つため BldL より1件あたりのpayloadが
//   大きく、6メッシュ全件では確実にV8の文字列長上限に当たる。1 feature ずつ書き出す。
async function writeLargePolygonsJson(filePath, meta, features) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const ws = fs.createWriteStream(tmpPath, { encoding: 'utf-8' });
  const put = async (s) => { if (!ws.write(s)) await once(ws, 'drain'); };
  try {
    await put('{\n');
    for (const [k, v] of Object.entries(meta)) await put('  ' + JSON.stringify(k) + ': ' + JSON.stringify(v) + ',\n');
    await put('  "features": [\n');
    for (let i = 0; i < features.length; i++) await put('    ' + JSON.stringify(features[i]) + (i < features.length - 1 ? ',\n' : '\n'));
    await put('  ]\n}\n');
    await new Promise((resolve, reject) => ws.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    ws.destroy();
    try { fs.unlinkSync(tmpPath); } catch { /* noop */ }
    throw e;
  }
  validateJsonStreamStructure(tmpPath);
  fs.renameSync(tmpPath, filePath);
}
function validateJsonStreamStructure(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 2) throw new Error('ファイルが小さすぎる: ' + filePath);
    const CHUNK = 1 << 20;
    const buf = Buffer.alloc(CHUNK);
    let depth = 0, inStr = false, esc = false, sawFirst = false, lastNonWs = 0;
    for (let off = 0; off < size; off += CHUNK) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - off), off);
      for (let i = 0; i < n; i++) {
        const c = buf[i];
        if (!sawFirst) {
          if (c === 0x7b) sawFirst = true;
          else if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) throw new Error('先頭が { でない: ' + filePath);
          if (!sawFirst) continue;
        }
        if (inStr) { if (esc) esc = false; else if (c === 0x5c) esc = true; else if (c === 0x22) inStr = false; continue; }
        if (c === 0x22) { inStr = true; continue; }
        if (c === 0x7b || c === 0x5b) depth++;
        else if (c === 0x7d || c === 0x5d) depth--;
        if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) lastNonWs = c;
      }
    }
    if (inStr) throw new Error('文字列が閉じていない: ' + filePath);
    if (depth !== 0) throw new Error('括弧の対応が取れていない(depth=' + depth + '): ' + filePath);
    if (lastNonWs !== 0x7d) throw new Error('末尾が } でない: ' + filePath);
  } finally { fs.closeSync(fd); }
}

function extractMeshCode(name) { const m = name.match(/FG-GML-(\d{6})-/); return m ? m[1] : null; }

function parseGmlText(xml, sourceFile) {
  const docCrs = detectDocumentCrs(xml);
  const { features, otherFeatureTypes } = parseBuildingAreaGml(xml);
  return { docCrs, otherFeatureTypes, records: features.map((f) => ({ ...f, sourceFile, docCrs })) };
}

// [tools/import-gsi-building-outline.js と同じ方針] ネストZIP対応・BldAのみdecompress・重複メッシュ検出。
function processZipEntries(entries, extractFn, pathPrefix, ctx) {
  for (const entry of entries) {
    if (entry.uncompSize === 0) continue;
    const entryRel = pathPrefix + '::' + entry.name;
    const looksLikeNestedZip = /\.zip$/i.test(entry.name);
    if (looksLikeNestedZip) {
      let nbuf;
      try { nbuf = extractFn(entry); } catch (e) { ctx.unparsedFiles.push({ path: entryRel, reason: 'nested ZIP 展開失敗: ' + e.message }); continue; }
      let innerEntries;
      try { innerEntries = readZipEntriesFromBuffer(nbuf); } catch (e) { ctx.unparsedFiles.push({ path: entryRel, reason: 'nested ZIP 読込失敗: ' + e.message }); continue; }
      ctx.zipEntryTotal += innerEntries.length;
      const meshCode = extractMeshCode(entry.name);
      if (meshCode) ctx.meshCodesSeen.add(meshCode);
      processZipEntries(innerEntries, (e2) => extractEntryFromBuffer(nbuf, e2), entryRel, ctx);
      continue;
    }
    const looksLikeBldA = /-BldA-/i.test(entry.name);
    if (!looksLikeBldA) {
      const m = entry.name.match(/-([A-Za-z]+)-\d{8}-/); if (m) ctx.otherFeatureTypesSet.add(m[1]);
      continue;
    }
    // BldA は1メッシュあたり複数ファイル(0001,0002,...)に分割されるため、meshCode単位ではなく
    // ファイル名そのもの(entry.name)単位で重複判定する（BldL importerのmeshCode単位判定とは異なる。
    // 理由: 同一meshに複数BldAファイルが正規に存在するため、meshCode単位だと2つ目以降を誤って重複扱いしてしまう）。
    const fileKey = entry.name;
    if (ctx.importedFileKeys.has(fileKey)) {
      ctx.duplicateFileSkipped.push({ path: entryRel, fileKey, note: '同名ファイルが既に取込済み（重複スキップ）' });
      continue;
    }
    const meshCode = extractMeshCode(entry.name);
    if (meshCode) ctx.meshCodesSeen.add(meshCode);
    let buf;
    try { buf = extractFn(entry); } catch (e) { ctx.unparsedFiles.push({ path: entryRel, reason: 'ZIP entry 展開失敗: ' + e.message }); continue; }
    const efmt = detectFormat(buf.slice(0, 512));
    if (efmt === 'gml-xml') {
      const { otherFeatureTypes, records } = parseGmlText(buf.toString('utf-8'), entryRel);
      otherFeatureTypes.forEach((t) => ctx.otherFeatureTypesSet.add(t));
      for (const r of records) ctx.allRecords.push(r);
      ctx.importedFileKeys.add(fileKey);
      if (meshCode) ctx.importedMeshCodes.add(meshCode);
    } else if (efmt === 'shapefile') {
      ctx.unparsedFiles.push({ path: entryRel, reason: 'Shapefile 検出（未パース）' });
    }
  }
}

function ringArea(ring) { let a = 0; for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; a += x1 * z2 - x2 * z1; } return Math.abs(a) / 2; }

async function main() {
  const generatedAt = new Date().toISOString();
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const files = listCandidateFiles(RAW_DIR);

  if (files.length === 0) {
    const report = {
      ...readExistingReport(), generatedAt, rawDataPresent: false, sourceFiles: [], featureCount: 0, osakaFeatureCount: 0,
      STATUS: 'GSI_BUILDING_AREA_RAW_DATA_MISSING',
      userAction: 'GSI 基盤地図情報「建築物」(BldA) を含む ZIP を data/raw/gsi/building-outline/ へ配置してください（BldLと同じZIPに同梱）。',
      canonicalBuildingUnchanged: true, canonicalRoadUnchanged: true,
    };
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    await writeJson(REPORT, report);
    console.log('[import-gsi-building-area] GSI_BUILDING_AREA_RAW_DATA_MISSING');
    return;
  }

  const wards = loadWards();
  const sourceFiles = [];
  const formatCounts = {};
  const sortedFiles = [...files].sort((a, b) => {
    const an = path.basename(a), bn = path.basename(b);
    const aAll = /-ALL-/i.test(an) ? 0 : 1, bAll = /-ALL-/i.test(bn) ? 0 : 1;
    if (aAll !== bAll) return aAll - bAll;
    return an.localeCompare(bn);
  });

  const ctx = {
    allRecords: [], otherFeatureTypesSet: new Set(), zipEntryTotal: 0, unparsedFiles: [],
    meshCodesSeen: new Set(), importedMeshCodes: new Set(), importedFileKeys: new Set(), duplicateFileSkipped: [],
  };

  for (const filePath of sortedFiles) {
    const fmt = detectFileFormat(filePath);
    formatCounts[fmt] = (formatCounts[fmt] || 0) + 1;
    const rel = toProjectRelativePath(filePath);
    sourceFiles.push({ path: rel, format: fmt, bytes: fs.statSync(filePath).size });
    if (fmt === 'zip') {
      let entries;
      try { entries = readZipEntries(filePath); } catch (e) { ctx.unparsedFiles.push({ path: rel, reason: 'ZIP 読み込み失敗: ' + e.message }); continue; }
      ctx.zipEntryTotal += entries.length;
      processZipEntries(entries, (entry) => extractEntry(filePath, entry), rel, ctx);
    } else if (fmt === 'gml-xml') {
      const xml = fs.readFileSync(filePath, 'utf-8');
      if (/-BldA-/i.test(path.basename(filePath))) {
        const { otherFeatureTypes, records } = parseGmlText(xml, rel);
        otherFeatureTypes.forEach((t) => ctx.otherFeatureTypesSet.add(t));
        for (const r of records) ctx.allRecords.push(r);
      }
    } else {
      ctx.unparsedFiles.push({ path: rel, reason: '未知またはBldA対象外の形式' });
    }
  }

  const { allRecords, otherFeatureTypesSet, zipEntryTotal, unparsedFiles, meshCodesSeen, importedMeshCodes, duplicateFileSkipped } = ctx;

  const crsCounts = {};
  let crsUnsupportedCount = 0, osakaExternalCount = 0, invalidExteriorCount = 0;
  const normalizedFeatures = [];
  for (const rec of allRecords) {
    const srs = rec.srsName || rec.docCrs;
    crsCounts[srs || '(unknown)'] = (crsCounts[srs || '(unknown)'] || 0) + 1;
    const cls = classifyCrs(srs);
    if (!cls.supported) { crsUnsupportedCount++; continue; }
    const axisOrder = cls.axisOrder === 'lon-lat' ? 'lon-lat' : 'lat-lon';
    const extPairs = posListToPairs(rec.exteriorPosList, axisOrder);
    if (extPairs.length < 3) { invalidExteriorCount++; continue; }
    const exteriorWorld = latLonPairsToWorld(extPairs);
    if (!touchesOsakaCity(exteriorWorld, wards)) { osakaExternalCount++; continue; }
    const interiorWorlds = [];
    for (const ip of rec.interiorPosLists) {
      const pairs = posListToPairs(ip, axisOrder);
      if (pairs.length >= 3) interiorWorlds.push(latLonPairsToWorld(pairs));
    }
    normalizedFeatures.push({
      id: 'gsi_blda_' + (rec.id || normalizedFeatures.length),
      geometryType: 'Polygon',
      coordinates: [exteriorWorld, ...interiorWorlds],
      area: +ringArea(exteriorWorld).toFixed(2),
      holeCount: interiorWorlds.length,
      sourceCrs: srs || null,
      sourceDataset: 'GSI-kiban-building-area',
      sourceFeatureId: rec.id || null,
      sourceDate: (rec.attrs && rec.attrs.devDate) || null,
      provenance: { sourceFile: rec.sourceFile, importedAt: generatedAt },
      attrs: rec.attrs || {},
    });
  }

  // 簡易validation（zeroArea / 自己交差検出はしない・§0で新規geometryアルゴリズムを増やしすぎない）
  let zeroAreaCount = 0;
  const cleanFeatures = normalizedFeatures.filter((f) => { if (f.area <= 0.01) { zeroAreaCount++; return false; } return true; });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  await writeLargePolygonsJson(OUT_POLYGONS,
    { version: 1, kind: 'gsi-building-area-polygons', generatedAt, coordinateConvention: 'znorth-neg-v1', count: cleanFeatures.length },
    cleanFeatures);

  const holeFeatureCount = cleanFeatures.filter((f) => f.holeCount > 0).length;
  const manifest = {
    version: 1, generatedAt, sourceFiles: sourceFiles.map((s) => s.path), formatCounts, crsCounts,
    featureCountRaw: allRecords.length, featureCountNormalized: normalizedFeatures.length, featureCountClean: cleanFeatures.length,
    holeFeatureCount, zipEntryTotal, crsUnsupportedCount, osakaExternalCount, invalidExteriorCount, zeroAreaCount,
    unparsedFiles, otherFeatureTypes: [...otherFeatureTypesSet],
    meshCodesSeen: [...meshCodesSeen].sort(), meshCodesImported: [...importedMeshCodes].sort(), duplicateFileSkipped,
    note: 'source geometry 不変。BldAはGSI仕様上「建築物」＝建物の面(Polygon、中庭等の穴を保持)。' +
      'simplify/buffer/snap/pair/polygonizeは行っていない（§0/§5）。',
  };
  await writeJson(OUT_MANIFEST, manifest);

  const report = {
    ...readExistingReport(), generatedAt, rawDataPresent: true, sourceFiles: sourceFiles.map((s) => s.path),
    sourceFormats: formatCounts, sourceCrs: Object.keys(crsCounts),
    featureType: { primary: 'BldA', semantics: '建築物（建物の面。Polygon。中庭等の穴=interior ringを保持）' },
    zipEntryTotal,
    meshInventory: { meshCodesSeen: [...meshCodesSeen].sort(), meshCodesImported: [...importedMeshCodes].sort(), meshCount: importedMeshCodes.size, duplicateFileSkipped },
    featureCount: allRecords.length, osakaFeatureCount: cleanFeatures.length, holeFeatureCount,
    crsUnsupportedCount, osakaExternalCount, invalidExteriorCount, zeroAreaCount, unparsedFiles,
    coverage: cleanFeatures.length > 0 ? ('大阪市域に触れる BldA polygon ' + cleanFeatures.length + ' 件を抽出') : '大阪市域内 feature 0 件',
    STATUS: cleanFeatures.length > 0 ? 'GSI_BUILDING_AREA_IMPORTED' : 'GSI_BUILDING_AREA_IMPORTED_ZERO_OSAKA_FEATURES',
    canonicalBuildingUnchanged: true, canonicalRoadUnchanged: true,
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[import-gsi-building-area] files=' + sourceFiles.length + ' zipEntries=' + zipEntryTotal
    + ' rawRecords=' + allRecords.length + ' normalized=' + normalizedFeatures.length + ' clean(Osaka内)=' + cleanFeatures.length
    + ' holes=' + holeFeatureCount);
  console.log('  meshCodesSeen=' + [...meshCodesSeen].sort().join(',') + ' meshCodesImported=' + [...importedMeshCodes].sort().join(',')
    + ' duplicateFileSkipped=' + duplicateFileSkipped.length);
  console.log('  crsUnsupported=' + crsUnsupportedCount + ' osakaExternal=' + osakaExternalCount + ' invalidExterior=' + invalidExteriorCount + ' zeroArea=' + zeroAreaCount);
  console.log('  保存: ' + toProjectRelativePath(OUT_POLYGONS) + ' / ' + toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[import-gsi-building-area] 失敗:', e && e.stack || e); process.exit(1); });
