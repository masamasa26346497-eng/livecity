#!/usr/bin/env node
// tools/import-gsi-building-outline.js
// [Mission 31G-FIX20] GSI 基盤地図情報「建築物の外周線」(BldL) の import pipeline。
//   raw（data/raw/gsi/building-outline/）→ normalize（Live City world・znorth-neg-v1）→
//   大阪市域 clip（N03 行政界）→ geometry validation → report。
//
//   §0/§5 遵守: source geometry（raw ファイル）は一切書き換えない。normalize 段階でも
//   simplify/buffer/snap/pair/polygonize はしない（座標変換のみ）。BldL は「建築物の外周線」
//   （屋根の外周線＝roof outer line。GSI仕様上の意味。§2/§13）であり、地上投影の建物形状そのもの
//   ではない点を明示的に記録する。
//   §3/§4 遵守: CRS が地理座標（lat/lon）以外（平面直角座標系等）の場合は変換せず crsUnsupported
//   として記録する（第6系等への強制変換はしない。既存 gsi-road-edge-transform.js をそのまま再利用）。
//
//   実データが data/raw/gsi/building-outline/ に無い場合はエラーで落とさず
//   GSI_BUILDING_OUTLINE_RAW_DATA_MISSING を表示して正常終了する（§1）。
//
// 出力:
//   data/processed/osaka-city/gsi-building-outline/building-outline-lines.json
//   data/processed/osaka-city/gsi-building-outline/manifest.json
//   data/reports/gsi-building-outline-import.json
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { listCandidateFiles, detectFileFormat, detectFormat } from './lib/gsi-road-edge-format.js';
import { readZipEntries, extractEntry, readZipEntriesFromBuffer, extractEntryFromBuffer } from './lib/zip-reader.js';
import { parseBuildingOutlineGml, detectDocumentCrs, posListToPairs } from './lib/gsi-building-outline-gml.js';
import { classifyCrs, latLonPairsToWorld, loadWards, touchesOsakaCity } from './lib/gsi-road-edge-transform.js';
import { validateLines } from './lib/gsi-road-edge-validate.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const RAW_DIR = P('data', 'raw', 'gsi', 'building-outline');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'gsi-building-outline');
const OUT_LINES = path.join(OUT_DIR, 'building-outline-lines.json');
const OUT_MANIFEST = path.join(OUT_DIR, 'manifest.json');
const REPORT = P('data', 'reports', 'gsi-building-outline-import.json');

function readExistingReport() {
  try { return JSON.parse(fs.readFileSync(REPORT, 'utf-8')); } catch { return {}; }
}

// [Mission 31G-FIX22 §4] importer scalability。大阪市24区全域(6メッシュ)を対象にすると
//   building-outline-lines.json（全 feature の座標を含む）が JSON.stringify の一回呼び出しでは
//   V8 の文字列長上限（RangeError: Invalid string length）を超える規模になり得ることを実測で確認
//   （§0/§5遵守: geometry の内容・精度は一切変えない。書き込み方法のみをstreamingに変える純粋な
//   スケーラビリティ対応）。1 feature ずつ JSON.stringify して書き出す（1 featureは高々数KB）。
//   書込先は writeJsonSafely と同じ「同一ディレクトリの一時ファイル→検証→rename」方式を踏襲する。
async function writeLargeLinesJson(filePath, meta, features) {
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
    try { fs.unlinkSync(tmpPath); } catch { /* 掃除失敗は無視 */ }
    throw e;
  }
  validateJsonStreamStructure(tmpPath);   // 巨大ファイルを1文字列として再読込せず検証（同じ上限に当たるのを避ける）
  fs.renameSync(tmpPath, filePath);
}

/** {}/[] の対応・文字列の閉じ・先頭 { 末尾 } のみを軽量に検証する（ファイル全体を1文字列にしない）。 */
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

// closed loop 判定（始点=終点。0.01m 許容）。§13: BldL は roof outer line＝閉曲線のはず。
function isClosedRing(coords) {
  if (coords.length < 4) return false;
  const a = coords[0], b = coords[coords.length - 1];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01;
}

function parseGmlText(xml, sourceFile) {
  const docCrs = detectDocumentCrs(xml);
  const { features, bldaCount, otherFeatureTypes } = parseBuildingOutlineGml(xml);
  return { docCrs, bldaCount, otherFeatureTypes, records: features.map((f) => ({ ...f, sourceFile, docCrs })) };
}

// [Mission 31G-FIX22 §1] GSI の命名規則 "FG-GML-<meshcode>-..." からメッシュコード（6桁）を取り出す。
//   ファイル名からの推測であり geometry 判定には使わない（inventory・重複検出の参考情報のみ）。
function extractMeshCode(name) {
  const m = name.match(/FG-GML-(\d{6})-/);
  return m ? m[1] : null;
}

// [Mission 31G-FIX22 §1/§4] ネスト ZIP（ZIP の中に ZIP。基盤地図情報の一括ダウンロード形式で新規確認）
//   に対応するため、ZIP エントリ列を再帰的に処理する共通関数へ抽出する。
//   §0 遵守: source geometry は一切書き換えない。BldL 以外は依然として decompress しない
//   （FIX21性能対策をネスト内側にもそのまま適用）。
//   §4 遵守: allRecords への追加は spread ではなく for...of（FIX21 RangeError 修正）のみを使う。
//   重複メッシュ対策: 同一 meshCode の BldL が複数ファイルに存在する場合（新パッケージと旧FIX21
//   standalone ファイルの両方に mesh 523514 が含まれる等）、最初に取り込んだものだけを採用し、
//   以降は「同一メッシュの重複」として記録した上でスキップする（二重カウント防止・§0捏造禁止＝
//   黙って混ぜない）。
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
    const looksLikeBldL = /-BldL-/i.test(entry.name);
    const looksLikeBldA = /-BldA-/i.test(entry.name);
    if (!looksLikeBldL) {
      if (looksLikeBldA) { ctx.bldaFileBytes += entry.uncompSize; ctx.bldaFileCount++; }
      else { const m = entry.name.match(/-([A-Za-z]+)-\d{8}-/); if (m) ctx.otherFeatureTypesSet.add(m[1]); }
      continue;
    }
    const meshCode = extractMeshCode(entry.name);
    if (meshCode) ctx.meshCodesSeen.add(meshCode);
    if (meshCode && ctx.importedMeshCodes.has(meshCode)) {
      const prior = ctx.importedMeshBldLBytes.get(meshCode);
      ctx.duplicateMeshSkipped.push({
        path: entryRel, meshCode, uncompSize: entry.uncompSize, priorUncompSize: prior,
        note: prior === entry.uncompSize ? 'byte数が既取込分と一致（同一データの再梱包と推定）' : 'byte数が既取込分と不一致（要確認だが二重カウント防止のため未使用のままスキップ）',
      });
      continue;
    }
    let buf;
    try { buf = extractFn(entry); } catch (e) { ctx.unparsedFiles.push({ path: entryRel, reason: 'ZIP entry 展開失敗: ' + e.message }); continue; }
    const efmt = detectFormat(buf.slice(0, 512));
    if (efmt === 'gml-xml') {
      const { bldaCount, otherFeatureTypes, records } = parseGmlText(buf.toString('utf-8'), entryRel);
      ctx.bldaTotal += bldaCount;
      otherFeatureTypes.forEach((t) => ctx.otherFeatureTypesSet.add(t));
      for (const r of records) ctx.allRecords.push(r);   // [FIX21実測] spread(...)は大量件数でstack overflowするため通常loopにする
      if (meshCode) { ctx.importedMeshCodes.add(meshCode); ctx.importedMeshBldLBytes.set(meshCode, entry.uncompSize); }
    } else if (efmt === 'shapefile') {
      ctx.unparsedFiles.push({ path: entryRel, reason: 'Shapefile 検出（このバージョンでは未パース。GML を優先取得してください）' });
    }
  }
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
      STATUS: 'GSI_BUILDING_OUTLINE_RAW_DATA_MISSING',
      userAction: 'GSI 基盤地図情報から大阪市を含む「建築物の外周線」（BldL）データを取得し、data/raw/gsi/building-outline/ へ配置してください（ZIP のまま可。詳細: data/raw/gsi/building-outline/README.md）。',
      canonicalBuildingUnchanged: true,
      canonicalRoadUnchanged: true,
    };
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    await writeJson(REPORT, report);
    console.log('[import-gsi-building-outline] GSI_BUILDING_OUTLINE_RAW_DATA_MISSING');
    console.log('  ' + report.userAction);
    console.log('保存: ' + toProjectRelativePath(REPORT));
    return;
  }

  const wards = loadWards();
  const sourceFiles = [];
  const formatCounts = {};

  // [Mission 31G-FIX22 §1] mesh 523514 が新パッケージ（ネストZIP）と旧FIX21 standalone ZIP の
  //   両方に含まれることを事前調査で確認済み。決定的な重複解消のため、単一メッシュ完結の
  //   "-ALL-" standalone ファイル（FIX21で既に実測・検証済みのもの）を優先的に先読みし、
  //   後から読む側の同一 meshCode BldL は「重複」として自動スキップする（processZipEntries内）。
  const sortedFiles = [...files].sort((a, b) => {
    const an = path.basename(a), bn = path.basename(b);
    const aAll = /-ALL-/i.test(an) ? 0 : 1;
    const bAll = /-ALL-/i.test(bn) ? 0 : 1;
    if (aAll !== bAll) return aAll - bAll;
    return an.localeCompare(bn);
  });

  const ctx = {
    allRecords: [],
    otherFeatureTypesSet: new Set(),
    bldaTotal: 0,                 // BldL と同じ XML 内から実測した BldA feature 数（参考値）
    bldaFileBytes: 0, bldaFileCount: 0,   // BldA 専用ファイル（別entry）の展開前サイズ・件数（§1: 内容は読まない）
    zipEntryTotal: 0,             // §1: ZIP内部（ネスト含む）のGML/XML数
    unparsedFiles: [],
    meshCodesSeen: new Set(),           // §1: ファイル名から判別できたメッシュコード全て（重複含む・inventory用）
    importedMeshCodes: new Set(),       // 実際に取り込んだ（重複スキップされなかった）メッシュコード
    importedMeshBldLBytes: new Map(),   // meshCode -> 取り込んだBldLのuncompSize（重複検出の参考比較用）
    duplicateMeshSkipped: [],           // §1: 重複のため未使用のままスキップしたBldLファイル一覧
  };

  for (const filePath of sortedFiles) {
    const fmt = detectFileFormat(filePath);
    formatCounts[fmt] = (formatCounts[fmt] || 0) + 1;
    const rel = toProjectRelativePath(filePath);
    sourceFiles.push({ path: rel, format: fmt, bytes: fs.statSync(filePath).size });

    if (fmt === 'gml-xml') {
      const xml = fs.readFileSync(filePath, 'utf-8');
      const meshCode = extractMeshCode(path.basename(filePath));
      if (meshCode) ctx.meshCodesSeen.add(meshCode);
      if (meshCode && ctx.importedMeshCodes.has(meshCode)) {
        ctx.duplicateMeshSkipped.push({ path: rel, meshCode, note: '同一メッシュの BldL が既に取込済み（重複スキップ）' });
        continue;
      }
      const { bldaCount, otherFeatureTypes, records } = parseGmlText(xml, rel);
      ctx.bldaTotal += bldaCount;
      otherFeatureTypes.forEach((t) => ctx.otherFeatureTypesSet.add(t));
      for (const r of records) ctx.allRecords.push(r);   // [FIX21実測] spread(...)は大量件数でstack overflowするため通常loopにする
      if (meshCode) { ctx.importedMeshCodes.add(meshCode); ctx.importedMeshBldLBytes.set(meshCode, fs.statSync(filePath).size); }
    } else if (fmt === 'zip') {
      let entries;
      try { entries = readZipEntries(filePath); } catch (e) { ctx.unparsedFiles.push({ path: rel, reason: 'ZIP 読み込み失敗: ' + e.message }); continue; }
      ctx.zipEntryTotal += entries.length;
      // [FIX21実測での性能対策・FIX22でネストZIPにも同様適用] 基盤地図情報 ZIP は 1 feature type = 1
      //   (以上の)別ファイルに分かれており（BldA が90MB級×4、RdCompt/SBBdry/RdEdg等も数十〜100MB級）、
      //   BldL 以外は本ミッションで一切使わない。ファイル名から feature type が判別できる（GSI の
      //   命名規則）ため、BldL 以外は decompress（extractEntry）自体を行わない。§FIX22で新規確認した
      //   「ZIPの中にZIP」形式（<meshcode>-11-<date>.zip がネストしたもの）も再帰的に同じ規則で処理する
      //   （processZipEntries）。§0 遵守: rawは不変・判定結果は不変の純粋な性能最適化・構造対応。
      processZipEntries(entries, (entry) => extractEntry(filePath, entry), rel, ctx);
    } else if (fmt === 'shapefile') {
      ctx.unparsedFiles.push({ path: rel, reason: 'Shapefile 検出（このバージョンでは未パース。GML を優先取得してください）' });
    } else {
      ctx.unparsedFiles.push({ path: rel, reason: '未知の形式（拡張子ではなく内容から判定した結果）' });
    }
  }

  const { allRecords, otherFeatureTypesSet, bldaTotal, bldaFileBytes, bldaFileCount, zipEntryTotal, unparsedFiles,
    meshCodesSeen, importedMeshCodes, duplicateMeshSkipped } = ctx;

  const crsCounts = {};
  let crsUnsupportedCount = 0, osakaExternalCount = 0, notClosedCount = 0;
  const normalizedFeatures = [];
  const importedAt = generatedAt;
  for (const rec of allRecords) {
    const srs = rec.srsName || rec.docCrs;
    crsCounts[srs || '(unknown)'] = (crsCounts[srs || '(unknown)'] || 0) + 1;

    const cls = classifyCrs(srs);
    if (!cls.supported) { crsUnsupportedCount++; continue; }
    let pairsLatLon = [];
    for (const raw of rec.posListRaw) pairsLatLon.push(...posListToPairs(raw, cls.axisOrder === 'lon-lat' ? 'lon-lat' : 'lat-lon'));
    if (pairsLatLon.length < 3) continue;
    const worldCoords = latLonPairsToWorld(pairsLatLon);
    if (!touchesOsakaCity(worldCoords, wards)) { osakaExternalCount++; continue; }
    const closed = isClosedRing(worldCoords);
    if (!closed) notClosedCount++;   // §13: 閉じていない場合は正直に記録（除外はしない・後段の判断に委ねる）

    normalizedFeatures.push({
      id: 'gsi_bldl_' + (rec.id || normalizedFeatures.length),
      geometry: { type: 'LineString', coordinates: worldCoords },
      closed,   // true なら建物外周の閉曲線として扱ってよい（面積・重心計算に使用可能）
      sourceCrs: srs || null,
      sourceDataset: 'GSI-kiban-building-outline',
      sourceFeatureId: rec.id || null,
      sourceDate: (rec.attrs && rec.attrs.devDate) || null,
      provenance: { sourceFile: rec.sourceFile, importedAt },
      attrs: rec.attrs || {},
    });
  }

  const { stats: valStats, invalidIds, duplicateIds } = validateLines(normalizedFeatures);
  const cleanFeatures = normalizedFeatures.filter((f) => !invalidIds.includes(f.id));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // [FIX22実測] 6メッシュ全件では JSON.stringify 一括呼び出しが V8 の文字列長上限を超える
  //   （RangeError: Invalid string length）ため streaming 書込に変更（§4）。内容・精度は不変。
  await writeLargeLinesJson(OUT_LINES,
    { version: 1, kind: 'gsi-building-outline-lines', generatedAt, coordinateConvention: 'znorth-neg-v1', count: cleanFeatures.length },
    cleanFeatures);
  const manifest = {
    version: 1, generatedAt, sourceFiles: sourceFiles.map((s) => s.path), formatCounts, crsCounts,
    featureCountRaw: allRecords.length, featureCountNormalized: normalizedFeatures.length, featureCountClean: cleanFeatures.length,
    bldaFeatureCountInSameFiles: bldaTotal,   // 参考: BldLと同一XML内から実測したBldA feature数。本パイプラインではgeometryを取り込まない
    bldaSeparateFileCount: bldaFileCount, bldaSeparateFileBytes: bldaFileBytes,   // BldA専用ファイル（別entry）。§1により内容未展開・件数は不明
    zipEntryTotal,
    crsUnsupportedCount, osakaExternalCount, notClosedCount, unparsedFiles,
    otherFeatureTypes: [...otherFeatureTypesSet],
    // [Mission 31G-FIX22 §1] メッシュ inventory・重複解消の記録（正直な二重カウント防止の証跡）。
    meshCodesSeen: [...meshCodesSeen].sort(),
    meshCodesImported: [...importedMeshCodes].sort(),
    duplicateMeshSkipped,
    validation: valStats,
    note: 'source geometry 不変。BldL は GSI仕様上「建築物の外周線」＝roof outer line（屋根の外周線）であり、'
      + '地上投影の建物形状そのものではない（§2/§13）。simplify/buffer/snap/pair/polygonize は行っていない（§5）。',
  };
  await writeJson(OUT_MANIFEST, manifest);

  const report = {
    ...readExistingReport(),
    generatedAt,
    rawDataPresent: true,
    sourceFiles: sourceFiles.map((s) => s.path),
    sourceFormats: formatCounts,
    sourceCrs: Object.keys(crsCounts),
    featureType: { primary: 'BldL', semantics: '建築物の外周線（roof outer line。GSI仕様上、屋根の外周線）', otherTypesInSameFiles: [...otherFeatureTypesSet], bldaFeatureCountInSameFiles: bldaTotal, bldaSeparateFileCount: bldaFileCount, bldaSeparateFileBytes: bldaFileBytes },
    zipEntryTotal,
    rawFileInventory: sourceFiles.map((s) => ({ path: s.path, format: s.format, bytes: s.bytes })),
    // [Mission 31G-FIX22 §1] メッシュ inventory（コード数・重複解消の証跡）。
    meshInventory: {
      meshCodesSeen: [...meshCodesSeen].sort(),
      meshCodesImported: [...importedMeshCodes].sort(),
      meshCount: importedMeshCodes.size,
      duplicateMeshSkipped,
      note: duplicateMeshSkipped.length > 0
        ? '重複メッシュを検出し、二重カウントを避けるため後発分をスキップした（詳細は duplicateMeshSkipped）。'
        : '重複メッシュは検出されなかった。',
    },
    featureCount: allRecords.length,
    osakaFeatureCount: cleanFeatures.length,
    invalidCount: valStats.invalidCoordinates + valStats.zeroLength + valStats.extremeOutlier,
    duplicateCount: valStats.duplicates,
    selfIntersectingCount: valStats.selfIntersecting,
    notClosedCount,
    crsUnsupportedCount,
    osakaExternalCount,
    unparsedFiles,
    coverage: cleanFeatures.length > 0 ? ('大阪市域に触れる BldL line ' + cleanFeatures.length + ' 件を抽出') : '大阪市域内 feature 0 件（source coverage 不足の可能性）',
    STATUS: cleanFeatures.length > 0 ? 'GSI_BUILDING_OUTLINE_IMPORTED' : 'GSI_BUILDING_OUTLINE_IMPORTED_ZERO_OSAKA_FEATURES',
    userAction: null,   // [FIX21] raw data 投入済みのため、旧「配置してください」メッセージを持ち越さない
    canonicalBuildingUnchanged: true,
    canonicalRoadUnchanged: true,
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[import-gsi-building-outline] files=' + sourceFiles.length + ' zipEntries=' + zipEntryTotal
    + ' rawRecords=' + allRecords.length + ' normalized=' + normalizedFeatures.length + ' clean(Osaka内)=' + cleanFeatures.length);
  console.log('  meshCodesSeen=' + [...meshCodesSeen].sort().join(',') + ' meshCodesImported=' + [...importedMeshCodes].sort().join(',')
    + ' duplicateMeshSkipped=' + duplicateMeshSkipped.length);
  console.log('  crsUnsupported=' + crsUnsupportedCount + ' osakaExternal=' + osakaExternalCount + ' notClosed=' + notClosedCount
    + ' invalid=' + report.invalidCount + ' duplicate=' + report.duplicateCount + ' BldA(参考・同一XML内)=' + bldaTotal
    + ' BldA(別ファイル未展開)=' + bldaFileCount + '件/' + Math.round(bldaFileBytes / 1e6) + 'MB');
  console.log('  保存: ' + toProjectRelativePath(OUT_LINES) + ' / ' + toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[import-gsi-building-outline] 失敗:', e && e.stack || e); process.exit(1); });
