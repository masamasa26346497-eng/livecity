#!/usr/bin/env node
// tools/download/plateau-buildings-lod2.js
//
// 大阪市PLATEAUのLOD2建築物データを「対象メッシュだけ」自動取得し、LOD2の有無を監査、
// 現行BLDGSとのID一致率を集計する。正規HTMLは変更しない。GLB生成もしない（別スクリプト）。
//
// 使い方:
//   node tools/download/plateau-buildings-lod2.js --year 2024 --mesh 51357422
//   node tools/download/plateau-buildings-lod2.js --year 2024 --mesh 51357420,51357421,51357422,51357423
//   （--area 省略時は データセット定義の targetArea = osaka-sumiyoshi）
//
// フロー:
//   1. CKAN API で対象年度パッケージを解決し、CityGML配布アーカイブURLを見つける。
//   2. アーカイブを raw/.../archive/ へキャッシュ取得（既存かつ整合なら再取得しない）。
//   3. アーカイブから対象メッシュの bldg GML だけを raw/.../gml/ へ抽出。
//   4. 各GMLを監査（LOD1/LOD2/LOD3件数, Roof/Wall/Ground, appearance, texture）→ processed/audit へ。
//   5. gml:id を現行BLDGSと照合 → processed/id-match へ。
//   6. LOD2が0件なら明確に停止（変換工程へ進ませない旨を表示）。
//
// ネットワーク不可の環境では、CKAN解決やアーカイブ取得の段階で「ネットワーク失敗」を
// 明確に報告して停止する（既存のLOD1・統計処理には一切影響しない）。

import { existsSync, statSync, readFileSync, readdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { loadDataset } from '../lib/dataset.js';
import { loadAreaConfig, ensureDir, writeJson } from '../lib/area.js';
import { isMainModule, toProjectRelativePath, PROJECT_ROOT } from '../lib/paths.js';
import { downloadLargeFile, sha256OfFile } from '../lib/http-download.js';
import { auditCityGml, extractAllBuildingIds, detectCoordinateSystem } from '../lib/citygml.js';
import { loadCurrentBuildings } from '../lib/current-buildings.js';
import { readCentralDirectory, extractEntryBuffer } from '../lib/zip-reader.js';
import { extractEntriesWithFallback } from '../lib/zip-fallback.js';
import {
  lod2RawArchiveDir, lod2RawGmlDir, lod2AuditDir, lod2IdMatchDir,
  readSourceManifest, writeSourceManifest,
} from '../lib/lod2-paths.js';

const DATASET_ID = 'plateau-osaka-buildings-lod2';

function parseArgs(argv) {
  const args = { year: null, mesh: null, area: null, force: false, offlineArchive: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--year') args.year = Number(argv[++i]);
    else if (a === '--mesh') args.mesh = argv[++i];
    else if (a === '--area') args.area = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--offline-archive') args.offlineArchive = argv[++i]; // ローカルZIP指定(ネット不可時の検証用)
  }
  return args;
}

function fail(msg, code = 1) {
  console.error(`\n[停止] ${msg}`);
  process.exit(code);
}

/**
 * CKAN package_show を叩いて、対象年度パッケージのCityGMLアーカイブ(url,name,size,format)を返す。
 * fetchが使えない/失敗した場合は例外。
 */
async function resolveCityGmlArchive(dataset, year, ua, timeoutMs) {
  const pkgId = `plateau-${dataset.cityCode}-${dataset.citySlug}-${year}`;
  const apiUrl = `${dataset.ckanApiBase}/package_show?id=${encodeURIComponent(pkgId)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let json;
  try {
    const res = await fetch(apiUrl, { signal: ctrl.signal, headers: { 'user-agent': ua } });
    clearTimeout(t);
    if (!res.ok) throw new Error(`CKAN API HTTP ${res.status}`);
    json = await res.json();
  } catch (e) {
    clearTimeout(t);
    throw new Error(`CKAN解決に失敗: ${apiUrl}\n  ${e.message}`);
  }
  if (!json.success || !json.result) throw new Error(`CKAN応答が不正: ${pkgId}`);
  const resources = json.result.resources || [];
  // CityGML形式のアーカイブを探す（format=CityGML もしくは name/url に citygml を含むzip）
  const isCityGml = (r) => {
    const s = `${r.format || ''} ${r.name || ''} ${r.url || ''}`.toLowerCase();
    return s.includes('citygml') && (s.includes('.zip') || (r.url || '').toLowerCase().endsWith('.zip'));
  };
  const cands = resources.filter(isCityGml);
  if (cands.length === 0) {
    return { pkgId, archive: null, resourceCount: resources.length };
  }
  // 最も大きい/新しいものを採用（複数バージョンがある場合、最新V系を優先したいが確実な指標はsize）
  cands.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
  const r = cands[0];
  return {
    pkgId,
    archive: { url: r.url, name: r.name || path.basename(r.url), size: Number(r.size) || null, format: r.format || null },
    resourceCount: resources.length,
  };
}

/**
 * ZIP内の対象メッシュ bldg GML エントリを列挙する（pure-Node、中央ディレクトリのみ読む＝全展開しない）。
 * @returns {{ entriesByMesh: Record<string, object[]>, allEntries: object[] }}
 */
function listMeshGmlEntries(zipPath, meshes) {
  let allEntries;
  try {
    allEntries = readCentralDirectory(zipPath); // ファイル末尾の中央ディレクトリのみ読む
  } catch (e) {
    throw new Error(`ZIPの中央ディレクトリ解析に失敗（破損の可能性）: ${e.message}`);
  }
  const result = {};
  for (const mesh of meshes) {
    result[mesh] = allEntries.filter((ent) => {
      const base = ent.fileName.split('/').pop() || '';
      return base.startsWith(mesh) && /bldg/i.test(ent.fileName) && ent.fileName.toLowerCase().endsWith('.gml');
    });
  }
  return { entriesByMesh: result, allEntries };
}

/**
 * 単一エントリを Buffer で取り出す（pure-Node）。未対応圧縮方式ならフォールバック側で処理する。
 */
function extractEntry(zipPath, entry) {
  return extractEntryBuffer(zipPath, entry);
}

/**
 * 対象メッシュのGMLが raw/.../gml/ に既に存在するか調べ、存在すればファイル情報を返す。
 * これにより、抽出済みGMLがある場合はアーカイブ取得・ZIP一覧・ZIP抽出を丸ごとスキップできる。
 * @returns {Record<string, {found:boolean, gmlFiles:Array}>}
 */
function findExistingGml(area, year, meshes) {
  const gmlDir = lod2RawGmlDir(area, year);
  const result = {};
  let files = [];
  if (existsSync(gmlDir)) {
    files = readdirSync(gmlDir).filter((f) => f.toLowerCase().endsWith('.gml'));
  }
  for (const mesh of meshes) {
    // 対象メッシュ番号で始まる bldg GML（例: 51357422_bldg_6697_op.gml）
    const meshFiles = files.filter((f) => f.startsWith(mesh) && /bldg/i.test(f));
    result[mesh] = {
      found: meshFiles.length > 0,
      gmlFiles: meshFiles.map((base) => {
        const dest = path.join(gmlDir, base);
        return { entry: base, file: toProjectRelativePath(dest), bytes: statSync(dest).size };
      }),
    };
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataset = await loadDataset(DATASET_ID);
  const area = args.area || dataset.targetArea;
  const year = args.year || dataset.defaultYear;
  if (!dataset.supportedYears.includes(year)) {
    fail(`対象年度が想定外です: ${year}。対応年度: ${dataset.supportedYears.join(', ')}`);
  }
  const meshes = (args.mesh ? args.mesh.split(',') : dataset.targetMeshes).map((s) => s.trim()).filter(Boolean);
  // 対象メッシュがデータセット定義の対象範囲に含まれるか軽く検証（タイポ検出）
  for (const m of meshes) {
    if (!/^\d{8}$/.test(m)) fail(`メッシュ番号の形式が不正です: "${m}"（8桁の3次メッシュ番号を指定してください）`);
  }

  const areaConfig = await loadAreaConfig(area);
  const ua = dataset.download.userAgent;

  console.log(`LiveCity LOD2取得パイプライン`);
  console.log(`  area=${area}  year=${year}  meshes=${meshes.join(',')}`);
  console.log(`  provider=${dataset.provider}`);

  await ensureDir(lod2RawArchiveDir(area, year));
  await ensureDir(lod2RawGmlDir(area, year));

  const manifest = await readSourceManifest(area, year);

  // ---- ステップ0: 既存GMLの検出（抽出済みならアーカイブ取得・ZIP工程をスキップ） ----
  const meshResults = {};
  const existing = findExistingGml(area, year, meshes);
  const meshesNeedingExtract = [];
  for (const mesh of meshes) {
    if (existing[mesh].found) {
      console.log(`[SKIP] メッシュ ${mesh}: 抽出済みGMLを再利用します（ZIP一覧取得・抽出を行いません）。`);
      for (const f of existing[mesh].gmlFiles) console.log(`        → ${f.file} (${(f.bytes/1e6).toFixed(1)}MB)`);
      meshResults[mesh] = { found: true, gmlFiles: existing[mesh].gmlFiles };
      manifest.meshes[mesh] = {
        found: true,
        gmlFiles: existing[mesh].gmlFiles.map((f) => f.file),
        source: 'existing-raw-gml',
        reusedAt: new Date().toISOString(),
      };
    } else {
      meshesNeedingExtract.push(mesh);
    }
  }

  // 全メッシュが既存GMLで揃っているなら、アーカイブ取得・ZIP処理を完全に省略する。
  if (meshesNeedingExtract.length === 0) {
    console.log(`[INFO] 全対象メッシュのGMLが既に存在します。アーカイブ取得とZIP抽出をスキップして監査へ進みます。`);
    await writeSourceManifest(area, year, manifest);
  } else {
    // ---- ステップ1-2: アーカイブの解決と取得（不足メッシュがある場合のみ／またはオフライン指定ZIP） ----
    let zipPath;
    if (args.offlineArchive) {
      zipPath = path.resolve(args.offlineArchive);
      if (!existsSync(zipPath)) fail(`--offline-archive が見つかりません: ${zipPath}`);
      console.log(`[INFO] オフライン指定ZIPを使用: ${zipPath}`);
    } else {
      let resolved;
      try {
        resolved = await resolveCityGmlArchive(dataset, year, ua, dataset.download.timeoutMs);
      } catch (e) {
        fail(`ネットワーク失敗またはURL解決不可。\n  ${e.message}\n` +
          `  ネットワークが無効な環境では --offline-archive <zip path> でローカルZIPを指定して監査だけ実行できます。\n` +
          `  なお対象GMLが data/raw/.../gml/ に既にあれば、取得なしで監査だけ実行されます。`);
      }
      if (!resolved.archive) {
        fail(`対象年度パッケージ(${resolved.pkgId})にCityGMLアーカイブが見つかりません` +
          `（リソース数=${resolved.resourceCount}）。年度・都市コードを確認してください。`);
      }
      console.log(`[INFO] CityGMLアーカイブ: ${resolved.archive.name} (${resolved.archive.size ? (resolved.archive.size/1e6).toFixed(0)+'MB' : 'サイズ不明'})`);
      zipPath = path.join(lod2RawArchiveDir(area, year), resolved.archive.name);
      const prior = manifest.archives[resolved.archive.name] || null;
      let dl;
      try {
        dl = await downloadLargeFile(resolved.archive.url, zipPath, {
          ...dataset.download,
          priorRecord: args.force ? null : prior,
        });
      } catch (e) {
        fail(`アーカイブ取得に失敗しました（既存の正式ファイル・.tempは保持、再実行で再開可能）。\n  ${e.message}`);
      }
      manifest.archives[resolved.archive.name] = {
        url: resolved.archive.url,
        downloadedAt: new Date().toISOString(),
        bytes: dl.bytes,
        contentLength: dl.contentLength,
        etag: dl.etag,
        lastModified: dl.lastModified,
        sha256: dl.sha256,
        cacheStatus: dl.status,
      };
      await writeSourceManifest(area, year, manifest);
    }

    // ---- ステップ3: 不足メッシュのGML抽出（pure-Node zip-reader、unzipコマンド非依存） ----
    let entriesByMesh;
    try {
      ({ entriesByMesh } = listMeshGmlEntries(zipPath, meshesNeedingExtract));
    } catch (e) {
      fail(`ZIP内のメッシュGML列挙に失敗: ${e.message}`);
    }

    for (const mesh of meshesNeedingExtract) {
      const entries = entriesByMesh[mesh] || [];
      const lod2Entries = entries.filter((e) => /lod2/i.test(e.fileName));
      const chosen = (lod2Entries.length ? lod2Entries : entries);
      if (chosen.length === 0) {
        console.log(`[WARN] メッシュ ${mesh}: 対象bldg GMLがZIP内に見つかりません。`);
        meshResults[mesh] = { found: false, gmlFiles: [] };
        manifest.meshes[mesh] = { found: false, checkedAt: new Date().toISOString() };
        continue;
      }
      const savedFiles = [];
      const needFallback = [];
      for (const entry of chosen) {
        const base = entry.fileName.split('/').pop();
        const dest = path.join(lod2RawGmlDir(area, year), base);
        try {
          const buf = extractEntry(zipPath, entry); // pure-Node（stored/deflate）
          await writeFile(dest, buf);
          const sha = await sha256OfFile(dest);
          savedFiles.push({ entry: entry.fileName, file: toProjectRelativePath(dest), bytes: buf.length, sha256: sha });
        } catch (e) {
          console.log(`[INFO] pure-Node解凍不可(${e.message}) — フォールバック対象: ${entry.fileName}`);
          needFallback.push(entry.fileName);
        }
      }
      if (needFallback.length > 0) {
        try {
          const { tool, saved } = extractEntriesWithFallback(zipPath, needFallback, lod2RawGmlDir(area, year));
          for (const dest of saved) {
            const sha = await sha256OfFile(dest);
            savedFiles.push({ entry: path.basename(dest), file: toProjectRelativePath(dest), bytes: statSync(dest).size, sha256: sha, extractedBy: tool });
          }
        } catch (e) {
          fail(`ZIP抽出に失敗しました（Node実装・OSツールとも不可）: ${e.message}`);
        }
      }
      meshResults[mesh] = { found: savedFiles.length > 0, gmlFiles: savedFiles };
      manifest.meshes[mesh] = {
        found: savedFiles.length > 0,
        gmlFiles: savedFiles.map((f) => f.file),
        extractedAt: new Date().toISOString(),
      };
    }
    await writeSourceManifest(area, year, manifest);
  }

  // ---- ステップ4-5: 監査 + ID照合 ----
  await ensureDir(lod2AuditDir(area, year));
  await ensureDir(lod2IdMatchDir(area, year));

  const currentBuildings = await loadCurrentBuildings(areaConfig.projection);
  const currentIdSet = new Set(currentBuildings.map((b) => b.id));

  let totalLod2 = 0;
  const perMeshAudit = {};

  for (const mesh of meshes) {
    const r = meshResults[mesh];
    if (!r || !r.found) { perMeshAudit[mesh] = { found: false }; continue; }

    // メッシュ内の全GMLを結合して監査（通常は1ファイル）。
    // gmlFiles.file はプロジェクト相対(/区切り)で記録しているため、PROJECT_ROOT基準で開き直す。
    let combinedXml = '';
    for (const f of r.gmlFiles) {
      combinedXml += await readFile(pathFromRel(f.file), 'utf-8');
    }

    let audit;
    try {
      audit = auditCityGml(combinedXml);
    } catch (e) {
      fail(`メッシュ ${mesh} のGML解析に失敗（XML破損の可能性）: ${e.message}`);
    }
    totalLod2 += audit.lod2AnyCount;

    // 座標系・軸順序の検出（固定値で決めつけず、srsNameと実座標の両方から推定）
    const crs = detectCoordinateSystem(combinedXml);
    if (crs.isProjectedPlaneRectangular) {
      console.warn(`[注意] メッシュ ${mesh}: 平面直角座標系の可能性があります` +
        `(srsName=${crs.srsName}, epsg=${crs.epsgCode})。変換式は緯度経度前提のため、変換段階で要確認。`);
    }
    if (crs.epsgVsValueMismatch) {
      console.warn(`[注意] メッシュ ${mesh}: srsName(${crs.srsName})と実座標値の推定が食い違います。軸順序を要確認。`);
    }

    const auditOut = {
      areaId: area, year, mesh,
      analyzedFiles: r.gmlFiles.map((f) => f.file),
      audit,
      coordinateSystem: crs, // srsName/srsDimension/座標サンプル/軸順序/Envelope/平面直角判定
      analyzedAt: new Date().toISOString(),
    };
    await writeJson(path.join(lod2AuditDir(area, year), `lod2-audit-${year}-${mesh}.json`), auditOut);
    perMeshAudit[mesh] = { found: true, ...audit };

    // ID照合
    const lod2Ids = extractAllBuildingIds(combinedXml);
    const lod2IdSet = new Set(lod2Ids);
    const exactMatches = lod2Ids.filter((id) => currentIdSet.has(id));
    const unmatchedLod2 = lod2Ids.filter((id) => !currentIdSet.has(id));
    const unmatchedCurrent = currentBuildings.filter((b) => !lod2IdSet.has(b.id)).map((b) => b.id);
    const first50 = lod2Ids.slice(0, 50);
    const first50Matches = first50.filter((id) => currentIdSet.has(id));

    const idMatch = {
      areaId: area, year, mesh,
      lod2BuildingCount: lod2Ids.length,
      currentBuildingCount: currentBuildings.length,
      exactIdMatchCount: exactMatches.length,
      exactIdMatchRate: lod2Ids.length ? Number((exactMatches.length / lod2Ids.length).toFixed(4)) : 0,
      first50: {
        lod2Count: first50.length,
        exactMatchCount: first50Matches.length,
        exactMatchRate: first50.length ? Number((first50Matches.length / first50.length).toFixed(4)) : 0,
      },
      unmatchedLod2IdCount: unmatchedLod2.length,
      unmatchedCurrentIdCount: unmatchedCurrent.length,
      unmatchedLod2IdsSample: unmatchedLod2.slice(0, 50),
      unmatchedCurrentIdsSample: unmatchedCurrent.slice(0, 50),
      // 年度差の可能性: 一致率が低いほど「現BLDGSと別年度」の疑いが強い
      likelyYearMismatch: lod2Ids.length > 0 && (exactMatches.length / lod2Ids.length) < 0.5,
      centroidMatchNeededCount: unmatchedLod2.length, // gml:id不一致分は重心照合が必要
      matchedAt: new Date().toISOString(),
    };
    await writeJson(path.join(lod2IdMatchDir(area, year), `id-match-${year}-${mesh}.json`), idMatch);
  }

  // ---- ステップ6: サマリ表示 + LOD2が0件なら変換へ進まず停止（監査JSONは上で出力済み） ----
  console.log('\n========== LOD2監査サマリ ==========');
  for (const mesh of meshes) {
    const a = perMeshAudit[mesh];
    if (!a || !a.found) { console.log(`  メッシュ ${mesh}: GML未取得/未発見`); continue; }
    console.log(`  メッシュ ${mesh}: 建物${a.buildingCount}`);
    console.log(`    LOD1: solid ${a.lod1SolidCount} / multiSurface ${a.lod1MultiSurfaceCount}`);
    console.log(`    LOD2: 保有 ${a.lod2AnyCount} (solid ${a.lod2SolidCount} / multiSurface ${a.lod2MultiSurfaceCount})`);
    console.log(`    LOD3保有: ${a.lod3AnyCount}`);
    console.log(`    境界面: Roof ${a.roofSurfaceTotal} / Wall ${a.wallSurfaceTotal} / Ground ${a.groundSurfaceTotal} / boundedBy ${a.boundedByTotal}`);
    console.log(`    外観: appearance ${a.appearancePresent} / ParameterizedTexture ${a.parameterizedTextureCount} / imageURI ${a.imageUriCount}`);
  }
  console.log(`\n  監査JSON: ${toProjectRelativePath(lod2AuditDir(area, year))}/lod2-audit-${year}-<mesh>.json （各メッシュ出力済み）`);

  if (totalLod2 === 0) {
    console.error('\n[結果] 対象メッシュにLOD2建築物が0件でした（= LOD1のみ）。');
    console.error('       監査JSONは「LOD2なし」として出力済みです（上記パス）。');
    console.error('       変換工程(tools/convert/buildings-lod2.js)へは進みません。');
    console.error('       対象区がLOD2整備範囲外の可能性があります。年度変更や近隣メッシュの確認を検討してください。');
    console.error('       既存のLOD1表示・統計処理には影響ありません。');
    process.exit(2);
  }

  console.log(`\n✅ 取得・監査・ID照合が完了しました（LOD2合計 ${totalLod2} 棟）。`);
  console.log(`   監査: ${toProjectRelativePath(lod2AuditDir(area, year))}/`);
  console.log(`   ID照合: ${toProjectRelativePath(lod2IdMatchDir(area, year))}/`);
  console.log(`   次段階: node tools/convert/buildings-lod2.js --year ${year} --mesh ${meshes[0]}`);
}

// プロジェクト相対パス(/区切り)を絶対パスへ戻す小ヘルパ（記録は toProjectRelativePath で作るため PROJECT_ROOT 基準）
function pathFromRel(rel) {
  return path.isAbsolute(rel) ? rel : path.join(PROJECT_ROOT, rel);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('予期しないエラー:', err);
    process.exit(1);
  });
}

export { resolveCityGmlArchive, listMeshGmlEntries, main };
