// tools/lib/lod2-paths.js
// LOD2建築物パイプライン専用のパス解決。ご指示8の保存構成に厳密に従う。
//   data/raw/{area}/plateau/buildings-lod2/{year}/
//     source-manifest.json
//     archive/
//     gml/  51357422_bldg_*.gml
//   data/processed/{area}/buildings-lod2/{year}/
//     audit/  id-match/  geometry-report/
//   public/map-data/{area}/buildings/lod2/{year}/   (今回は監査段階のため巨大出力しない)
//     index.json  tiles/

import path from 'path';
import { PROJECT_ROOT } from './paths.js';
import { readJsonIfExists, writeJson } from './area.js';

export function lod2RawDir(area, year) {
  return path.join(PROJECT_ROOT, 'data', 'raw', area, 'plateau', 'buildings-lod2', String(year));
}
export function lod2RawArchiveDir(area, year) {
  return path.join(lod2RawDir(area, year), 'archive');
}
export function lod2RawGmlDir(area, year) {
  return path.join(lod2RawDir(area, year), 'gml');
}
export function lod2SourceManifestPath(area, year) {
  return path.join(lod2RawDir(area, year), 'source-manifest.json');
}
export function lod2ProcessedDir(area, year) {
  return path.join(PROJECT_ROOT, 'data', 'processed', area, 'buildings-lod2', String(year));
}
export function lod2AuditDir(area, year) {
  return path.join(lod2ProcessedDir(area, year), 'audit');
}
export function lod2IdMatchDir(area, year) {
  return path.join(lod2ProcessedDir(area, year), 'id-match');
}
export function lod2GeometryReportDir(area, year) {
  return path.join(lod2ProcessedDir(area, year), 'geometry-report');
}
export function lod2PublicDir(area, year) {
  return path.join(PROJECT_ROOT, 'public', 'map-data', area, 'buildings', 'lod2', String(year));
}

/**
 * source-manifest.json を読む（無ければ初期構造）。
 */
export async function readSourceManifest(area, year) {
  const p = lod2SourceManifestPath(area, year);
  const existing = await readJsonIfExists(p);
  if (existing) return existing;
  return {
    areaId: area,
    domain: 'buildings-lod2',
    year,
    provider: '国土交通省 Project PLATEAU',
    generatedAt: null,
    archives: {}, // key: ファイル名 -> {url, downloadedAt, bytes, contentLength, etag, lastModified, sha256}
    meshes: {},   // key: メッシュ番号 -> {gmlFile, source, extractedAt, bytes, sha256, found}
  };
}

export async function writeSourceManifest(area, year, manifest) {
  manifest.generatedAt = new Date().toISOString();
  await writeJson(lod2SourceManifestPath(area, year), manifest);
}
