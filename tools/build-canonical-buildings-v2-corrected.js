#!/usr/bin/env node
// tools/build-canonical-buildings-v2-corrected.js
// [Mission 32N] CORRECTED BUILDING CANONICAL V2
//
//   Mission 32M で、V1 canonical 建物は tools/convert-plateau-buildings.js の latLonToJPRect(zone 7) を
//   経由していたため、地図（equirect）に対して時計回り 0.93° 回転していたことが確定した。
//   本スクリプトは V1 を上書きせず、**生 CityGML → 生 lat/lon → Live City 共通座標** で
//   canonical を並列に作り直す（§0: 回転補正はしない。§3: 平面直角座標系を一切経由しない）。
//
//   ■ 何を変えて、何を変えないか（§5/§6/§7）
//   - 対象の建物集合 = V1 canonical の canonicalId 集合（615,617）。ID は一切振り直さない。
//   - PLATEAU 建物（574,112）: 生 CityGML から、V1 と**同じ footprint 選択規則**で外周を選び、
//       latLonToLiveCityWorld() で投影する。
//       規則（tools/convert-plateau-buildings.js convertBuildingXml と同一）:
//         lod0FootPrint の最初の区画の exterior 群から最大面積のもの → 無ければ GroundSurface →
//         無ければ lod1Solid の平均標高が最も低いリング。座標は 2 桁に丸め、閉じ点は落とす。
//   - OSM 補完建物（41,505）: 元々 OSM lat/lon を同じ equirect で投影したものなので座標は変えない
//       （validator で OSM 原データと照合する）。
//   - 属性（高さ・用途・levels 等）は V1 のまま。**区だけは V2 の座標から N03 で再割り当て**（§11）。
//
//   ■ 出力（すべて新しい namespace。V1 には触れない §1/§13/§15）
//   data/processed/osaka-city/canonical/buildings-v2-corrected/{tile_*.json, attributes/, manifest.json}
//   data/processed/osaka-city/derived-v2-corrected/{far,mid,near}/buildings/
//   public/map-data/osaka-city/derived-v2-corrected/{far,mid,near}/buildings/
//   data/reports/canonical-building-v2-build.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { latLonToLiveCityWorld, LIVECITY_COORDINATE_SYSTEM_ID } from './lib/livecity-coordinate-system.js';
import { representativePoint } from './lib/building-representative-point.js';
import { classifyPointToWard } from './lib/point-in-polygon.js';
import { bboxOf, centroidOf } from './lib/canonical-geometry-schema.js';
import { processDerivedLayer, buildingLayerOpts, DERIVED_LOD_ORDER } from './build-derived-geometry.js';
import { readZipEntries, extractEntry } from './lib/zip-reader.js';
import { writeFilesVerified, readFileRetry } from './lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const V2 = {
  rawDir: P('data', 'raw', 'osaka-higashisumiyoshi'),
  // 大阪市 PLATEAU 建物の配布 zip（270 メッシュ）。展開済みフォルダに無いメッシュ（73）だけをここから読む。
  rawZip: P('data', 'raw', 'osaka-sumiyoshi', 'plateau', 'buildings-lod2', '2024', 'archive', 'CityGML_v4.zip'),
  v1Dir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings'),
  v1AttrDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'attributes'),
  outDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-corrected'),
  outAttrDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-corrected', 'attributes'),
  derivedRoot: P('data', 'processed', 'osaka-city', 'derived-v2-corrected'),
  publicDerivedRoot: P('public', 'map-data', 'osaka-city', 'derived-v2-corrected'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  report: P('data', 'reports', 'canonical-building-v2-build.json'),
};
const TILE_SIZE = 500;
const V1_PREFIX = 'cg_bldg_';

const r2 = (v) => Math.round(v * 100) / 100;
const rj = (p) => JSON.parse(readFileRetry(p));
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);

function ringAreaAbs(pts) {
  let a2 = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a2 += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a2) / 2;
}
function segIntersect(p1, p2, p3, p4) {
  const ccw = (a, b, c) => (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = ccw(p3, p4, p1), d2 = ccw(p3, p4, p2), d3 = ccw(p1, p2, p3), d4 = ccw(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
/** posList（lat lon h …）→ [[x, z, h], …]（Live City 共通座標）。 */
function parsePosListWorld(text) {
  const n = text.trim().split(/\s+/).map(Number);
  const pts = [];
  for (let i = 0; i + 2 < n.length; i += 3) {
    const w = latLonToLiveCityWorld(n[i], n[i + 1]);
    pts.push([w.x, w.z, n[i + 2]]);
  }
  return pts;
}
function ringsIn(xml, sectionRe) {
  const sec = xml.match(sectionRe);
  if (!sec) return [];
  const out = [];
  const re = /<gml:exterior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
  let m; while ((m = re.exec(sec[0]))) out.push(m[1]);
  return out;
}
/**
 * V1 と同一の footprint 選択規則で外周を選び、共通座標で返す。
 * 面積比較・最下面判定は投影後の座標で行う（V1 も投影後の座標で比較していた）。
 */
export function selectFootprintWorld(xml) {
  let texts = ringsIn(xml, /<bldg:lod0FootPrint>[\s\S]*?<\/bldg:lod0FootPrint>/);
  let fpSource = 'lod0FootPrint';
  if (!texts.length) { texts = ringsIn(xml, /<bldg:GroundSurface\b[\s\S]*?<\/bldg:GroundSurface>/); fpSource = 'GroundSurface'; }
  let ring = null;
  if (texts.length) {
    let bestArea = -1;
    for (const t of texts) { const pts = parsePosListWorld(t); const a = ringAreaAbs(pts); if (a > bestArea) { bestArea = a; ring = pts; } }
  } else {
    const solid = xml.match(/<bldg:lod1Solid>[\s\S]*?<\/bldg:lod1Solid>/);
    if (solid) {
      const re = /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
      let m, bestAlt = Infinity;
      while ((m = re.exec(solid[0]))) {
        const pts = parsePosListWorld(m[1]);
        const avg = pts.reduce((a, p) => a + p[2], 0) / pts.length;
        if (avg < bestAlt) { bestAlt = avg; ring = pts; }
      }
      fpSource = 'lowestRing';
    }
  }
  if (!ring || ring.length < 3) return { fp: null, fpSource: null, reason: 'no-ring' };
  let fp = ring.map((p) => [r2(p[0]), r2(p[1])]);
  if (fp.length >= 2 && fp[0][0] === fp[fp.length - 1][0] && fp[0][1] === fp[fp.length - 1][1]) fp = fp.slice(0, -1);
  if (fp.length < 3) return { fp: null, fpSource, reason: 'too-few-points' };
  for (const p of fp) if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return { fp: null, fpSource, reason: 'non-finite' };
  let selfIntersect = false;
  outer: for (let i = 0; i < fp.length; i++) for (let j = i + 2; j < fp.length; j++) {
    if (i === 0 && j === fp.length - 1) continue;
    if (segIntersect(fp[i], fp[(i + 1) % fp.length], fp[j], fp[(j + 1) % fp.length])) { selfIntersect = true; break outer; }
  }
  return { fp, fpSource, selfIntersect };
}

/** 生 GML（テキスト）を <core:cityObjectMember> 単位で走査する。 */
function* iterRawBuildings(s) {
  let idx = s.indexOf('<core:cityObjectMember>');
  while (idx >= 0) {
    const next = s.indexOf('<core:cityObjectMember>', idx + 23);
    const part = s.slice(idx, next < 0 ? s.length : next);
    const m = part.match(/<bldg:Building gml:id="([^"]+)"/);
    if (m) {
      const wn = part.match(/<gen:stringAttribute name="区名"><gen:value>([^<]*)</);
      yield { gmlId: m[1], xml: part, rawWardName: wn ? wn[1] : null };
    }
    idx = next;
  }
}

// §14: 出力は自分が所有するディレクトリ（V2.outDir / V2.outAttrDir / <V2 root>/<lod>/buildings）だけ。
//   ディレクトリごと消す→作り直すと OneDrive が競合コピーを作り正規ファイルを失うため（32N 実測）、
//   上書き＋期待外ファイルだけ削除＋読み戻し検証で書く（tools/lib/synced-dir-writer.js）。
function publishDir(src, dst, label) {
  const m = JSON.parse(readFileRetry(path.join(src, 'manifest.json')));
  const files = new Map([['manifest.json', readFileRetry(path.join(src, 'manifest.json'))]]);
  let bytes = 0;
  for (const t of m.tiles || []) { const body = readFileRetry(path.join(src, t.file)); files.set(t.file, body); bytes += Buffer.byteLength(body); }
  const w = writeFilesVerified(dst, files, { label });
  return { files: files.size, bytes, rewrites: w.rewrites, strayRemoved: w.strayRemoved };
}

export async function buildCanonicalBuildingsV2() {
  const t0 = Date.now();
  const generatedAt = new Date().toISOString();

  // ── V1 の ID 集合・非幾何フィールド・属性を読む（座標は読まない。V1 は read-only） ──
  const v1 = new Map();   // canonicalId -> { rec(座標なし), v1Centroid, v1Area, v1Vertices, kind }
  for (const f of fs.readdirSync(V2.v1Dir)) {
    if (!isTile(f)) continue;
    for (const ft of rj(path.join(V2.v1Dir, f)).features || []) {
      if (v1.has(ft.canonicalId)) continue;
      const { coordinates, bbox, centroid, areaM2, ...rest } = ft;
      const ring = ft.geometryType === 'Polygon' ? coordinates[0] : coordinates[0][0];
      v1.set(ft.canonicalId, {
        rec: rest,
        kind: ft.source && ft.source.geometrySource === 'plateau-building' ? 'plateau' : 'fallback',
        v1Centroid: centroid, v1Area: areaM2, v1Vertices: ring ? ring.length : null,
        coordinates: ft.source && ft.source.geometrySource === 'plateau-building' ? null : coordinates, // fallback は座標を保持
        geometryType: ft.geometryType,
      });
    }
  }
  const v1Attr = new Map();
  for (const f of fs.readdirSync(V2.v1AttrDir)) {
    if (!isTile(f)) continue;
    const a = rj(path.join(V2.v1AttrDir, f)).attributes || {};
    for (const [cid, v] of Object.entries(a)) if (!v1Attr.has(cid)) v1Attr.set(cid, v);
  }
  const v1Count = v1.size;
  const v1Plateau = [...v1.values()].filter((x) => x.kind === 'plateau').length;
  console.log('[v2] V1 ids:', v1Count, 'plateau:', v1Plateau, 'attrs:', v1Attr.size);

  // ── 生 CityGML から PLATEAU 建物を作り直す ──
  const stats = {
    rawFiles: 0, rawBuildings: 0, rawNotInV1: 0, duplicateRawIds: 0,
    rebuilt: 0, fpSource: {}, selfIntersectNow: 0, noRing: 0,
    vertexCountSameAsV1: 0, vertexCountDiffers: 0,
  };
  const geom = new Map(); // canonicalId -> { fp, rawWardName, fpSource }
  const files = fs.readdirSync(V2.rawDir).filter((f) => /_bldg_\d+_op\.gml$/.test(f)).sort();
  const folderMeshes = new Set(files.map((f) => f.slice(0, 8)));
  // 読み込み元: 展開済みフォルダ（優先）＋ zip の中で展開済みフォルダに無いメッシュ
  const sources = files.map((f) => ({ kind: 'folder', name: toProjectRelativePath(path.join(V2.rawDir, f)), read: () => readFileRetry(path.join(V2.rawDir, f)) }));
  stats.zipFiles = 0; stats.zipBuildingsRebuilt = 0;
  if (fs.existsSync(V2.rawZip)) {
    for (const e of readZipEntries(V2.rawZip)) {
      if (!/bldg\/\d{8}_bldg_\d+_op\.gml$/.test(e.name)) continue;
      const mesh = e.name.split('/').pop().slice(0, 8);
      if (folderMeshes.has(mesh)) continue;
      sources.push({ kind: 'zip', name: toProjectRelativePath(V2.rawZip) + '::' + e.name, read: () => extractEntry(V2.rawZip, e).toString('utf-8') });
    }
  }
  stats.sourceFiles = { folder: files.length, zip: sources.filter((x) => x.kind === 'zip').length };
  for (const src of sources) {
    stats.rawFiles++;
    if (src.kind === 'zip') stats.zipFiles++;
    for (const b of iterRawBuildings(src.read())) {
      stats.rawBuildings++;
      const cid = V1_PREFIX + b.gmlId;
      const meta = v1.get(cid);
      if (!meta || meta.kind !== 'plateau') { stats.rawNotInV1++; continue; }
      if (geom.has(cid)) { stats.duplicateRawIds++; continue; }
      const sel = selectFootprintWorld(b.xml);
      if (!sel.fp) { stats.noRing++; continue; }
      if (sel.selfIntersect) stats.selfIntersectNow++;
      stats.fpSource[sel.fpSource] = (stats.fpSource[sel.fpSource] || 0) + 1;
      if (sel.fp.length === meta.v1Vertices) stats.vertexCountSameAsV1++; else stats.vertexCountDiffers++;
      // 形状は保持しつつ数値はコンパクトに持つ
      const flat = new Float64Array(sel.fp.length * 2);
      sel.fp.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; });
      geom.set(cid, { flat, rawWardName: b.rawWardName, fpSource: sel.fpSource, selfIntersect: !!sel.selfIntersect, rawKind: src.kind });
      stats.rebuilt++;
      if (src.kind === 'zip') stats.zipBuildingsRebuilt++;
    }
    if (stats.rawFiles % 20 === 0) console.log('[v2] raw files', stats.rawFiles, '/', sources.length, 'rebuilt', stats.rebuilt);
  }
  const missingPlateau = [...v1.entries()].filter(([cid, m]) => m.kind === 'plateau' && !geom.has(cid)).map(([cid]) => cid);
  console.log('[v2] rebuilt', stats.rebuilt, 'missing', missingPlateau.length);

  // ── 区の再割り当て（§11: 旧ラベルは引き継がない） ──
  const wards = rj(V2.wardPolys).wards;
  const wardStats = { assigned: 0, outside: 0, ambiguous: 0, changedFromV1: 0, byWard: {}, byStatus: {} };

  const geomTiles = new Map(), attrTiles = new Map();
  let bbAll = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  let emitted = 0, emittedPlateau = 0, emittedFallback = 0;
  for (const [cid, meta] of v1) {
    let coordinates;
    if (meta.kind === 'plateau') {
      const g = geom.get(cid);
      if (!g) continue; // missingPlateau として報告（件数不一致になる）
      const ring = [];
      for (let i = 0; i < g.flat.length; i += 2) ring.push([g.flat[i], g.flat[i + 1]]);
      coordinates = [ring];
    } else {
      coordinates = meta.coordinates;
    }
    const geometryType = meta.geometryType;
    const bbox = bboxOf(coordinates);
    const c = centroidOf(geometryType, coordinates);
    const outerRing = geometryType === 'Polygon' ? coordinates[0] : coordinates[0][0];
    const areaM2 = r2(ringAreaAbs(outerRing));
    const rec = {
      ...meta.rec,
      coordinates, bbox, areaM2,
      centroid: c ? [r2(c[0]), r2(c[1])] : null,
      coordinateConvention: 'znorth-neg-v1',
      coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID,
      source: {
        ...meta.rec.source,
        generatedAt,
        notes: meta.kind === 'plateau'
          ? '[32N] 生 CityGML lat/lon → latLonToLiveCityWorld（平面直角座標系を経由しない）'
          : '[32N] OSM 補完建物。元から Live City equirect のため座標は V1 と同一',
      },
    };
    // key 順を V1 と揃える
    const ordered = {
      canonicalId: rec.canonicalId, layer: rec.layer, geometryType: rec.geometryType,
      coordinates: rec.coordinates, bbox: rec.bbox, areaM2: rec.areaM2, centroid: rec.centroid,
      coordinateConvention: rec.coordinateConvention, coordinateSystem: rec.coordinateSystem,
      source: rec.source,
      qaFlags: [...(rec.qaFlags || []), ...(meta.kind === 'plateau' && geom.get(cid).selfIntersect ? ['v2-self-intersect-after-rounding'] : [])],
    };
    // 区
    const rp = representativePoint(outerRing);
    const res = rp.valid ? classifyPointToWard(rp.x, rp.z, wards) : { wardId: null, status: 'no-representative-point' };
    wardStats.byStatus[res.status] = (wardStats.byStatus[res.status] || 0) + 1;
    if (res.wardId) { wardStats.assigned++; wardStats.byWard[res.wardId] = (wardStats.byWard[res.wardId] || 0) + 1; }
    else if (res.status === 'outside') wardStats.outside++; else wardStats.ambiguous++;
    const a1 = v1Attr.get(cid) || {};
    if ((a1.wardId || null) !== (res.wardId || null)) wardStats.changedFromV1++;
    const attr = {
      ...a1,
      wardId: res.wardId || null,
      wardIdV1: a1.wardId || null,
      wardStatus: res.status,
      repMethod: rp.method || a1.repMethod || null,
      rawWardName: meta.kind === 'plateau' ? (geom.get(cid).rawWardName || null) : null,
      rawSourceKind: meta.kind === 'plateau' ? geom.get(cid).rawKind : 'osm',
    };
    const key = Math.floor(((bbox.minX + bbox.maxX) / 2) / TILE_SIZE) + '_' + Math.floor(((bbox.minZ + bbox.maxZ) / 2) / TILE_SIZE);
    if (!geomTiles.has(key)) { geomTiles.set(key, []); attrTiles.set(key, {}); }
    geomTiles.get(key).push(ordered);
    attrTiles.get(key)[cid] = attr;
    bbAll = { minX: Math.min(bbAll.minX, bbox.minX), maxX: Math.max(bbAll.maxX, bbox.maxX), minZ: Math.min(bbAll.minZ, bbox.minZ), maxZ: Math.max(bbAll.maxZ, bbox.maxZ) };
    emitted++; if (meta.kind === 'plateau') emittedPlateau++; else emittedFallback++;
  }
  let canonicalBytes = 0;
  const geomFiles = new Map(), attrFiles = new Map();
  for (const [key, feats] of geomTiles) {
    const [tx, tz] = key.split('_').map(Number);
    const body = JSON.stringify({ tx, tz, tileSize: TILE_SIZE, coordinateConvention: 'znorth-neg-v1', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, generatedAt, count: feats.length, features: feats });
    geomFiles.set(`tile_${tx}_${tz}.json`, body);
    attrFiles.set(`tile_${tx}_${tz}.json`, JSON.stringify({ tx, tz, count: feats.length, attributes: attrTiles.get(key) }));
    canonicalBytes += Buffer.byteLength(body);
  }
  const manifest = {
    version: 2, layer: 'buildings', kind: 'canonical-geometry', variant: 'v2-corrected',
    coordinateConvention: 'znorth-neg-v1', coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID,
    generatedAt, tileSize: TILE_SIZE,
    featureCount: emitted, plateauCount: emittedPlateau, fallbackCount: emittedFallback,
    bbox: bbAll, tiles: geomTiles.size,
    supersedes: 'canonical/buildings（V1: 平面直角座標 第7系由来・Mission 32M）。V1 は保持・未削除。',
    zone7Used: false,
  };
  geomFiles.set('manifest.json', JSON.stringify(manifest, null, 2));
  const canonicalWrite = {
    geometry: writeFilesVerified(V2.outDir, geomFiles, { label: 'canonical/buildings-v2-corrected' }),
    attributes: writeFilesVerified(V2.outAttrDir, attrFiles, { label: 'canonical/buildings-v2-corrected/attributes' }),
  };
  geomFiles.clear(); attrFiles.clear();
  console.log('[v2] canonical written', emitted, 'tiles', geomTiles.size, JSON.stringify(canonicalWrite));

  const report = {
    version: 1, generatedAt, missionId: '32N',
    coordinateSystem: LIVECITY_COORDINATE_SYSTEM_ID, zone7Used: false,
    v1: { count: v1Count, plateau: v1Plateau, fallback: v1Count - v1Plateau },
    v2: { count: emitted, plateau: emittedPlateau, fallback: emittedFallback, tiles: geomTiles.size, canonicalBytes, bbox: bbAll },
    missingPlateau: { count: missingPlateau.length, sample: missingPlateau.slice(0, 20) },
    rawScan: stats,
    ward: wardStats,
    canonicalWrite,
    derived: null,
    published: null,
    elapsedMs: Date.now() - t0,
  };
  // canonical 段階の結果を先に保存する（derived 段階だけ再実行できるように）
  fs.writeFileSync(V2.report, JSON.stringify(report, null, 2));
  return runDerivedStage(report);
}

/**
 * derived（far/mid/near exact）を V2 専用 namespace へ（§13）。
 * OneDrive 上では大量の読み書き中に一時的な `UNKNOWN: read` が出ることがあるので、
 * `--derived-only` で canonical を作り直さずにこの段階だけ再実行できる。
 */
function withRetry(label, fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return fn(); }
    catch (e) {
      if (i >= tries || !/UNKNOWN|EBUSY|EPERM/.test(String(e && (e.code || e.message)))) throw e;
      console.warn('[v2] ' + label + ' 一時的な I/O エラーで再試行 ' + i + '/' + (tries - 1) + ': ' + (e.code || e.message));
      const until = Date.now() + 3000 * i; while (Date.now() < until) { /* wait */ }
    }
  }
}
function runDerivedStage(report) {
  const t0 = Date.now();
  const generatedAt = report.generatedAt;
  const derived = withRetry('derived', () => processDerivedLayer('buildings', buildingLayerOpts({
    srcDir: V2.outDir, attrDir: V2.outAttrDir, generatedAt, sourceVersion: generatedAt,
    outRoot: V2.derivedRoot, layerDir: 'buildings', syncedWrite: true,
  })));
  const published = {};
  for (const lod of DERIVED_LOD_ORDER) {
    published[lod] = withRetry('publish ' + lod, () => publishDir(path.join(V2.derivedRoot, lod, 'buildings'), path.join(V2.publicDerivedRoot, lod, 'buildings'), 'public ' + lod));
  }
  console.log('[v2] derived', JSON.stringify(derived.lod));
  report.derived = derived.lod;
  report.published = published;
  report.derivedElapsedMs = Date.now() - t0;
  fs.writeFileSync(V2.report, JSON.stringify(report, null, 2));
  return report;
}

export function rerunDerivedStage() {
  const report = JSON.parse(fs.readFileSync(V2.report, 'utf-8'));
  const m = JSON.parse(fs.readFileSync(path.join(V2.outDir, 'manifest.json'), 'utf-8'));
  if (report.generatedAt !== m.generatedAt) throw new Error('build report と V2 canonical manifest の generatedAt が一致しない（canonical 段階から再実行すること）');
  return runDerivedStage(report);
}

if (isMainModule(import.meta.url)) {
  const run = process.argv.includes('--derived-only') ? async () => rerunDerivedStage() : buildCanonicalBuildingsV2;
  run().then((r) => {
    console.log('[v2] DONE v2.count=' + r.v2.count + ' missing=' + r.missingPlateau.count + ' elapsed=' + Math.round(r.elapsedMs / 1000) + 's');
    console.log('[v2] rawScan=' + JSON.stringify(r.rawScan));
    console.log('[v2] ward=' + JSON.stringify({ assigned: r.ward.assigned, outside: r.ward.outside, ambiguous: r.ward.ambiguous, changedFromV1: r.ward.changedFromV1 }));
  }).catch((e) => { console.error('[v2] 失敗:', e && e.stack || e); process.exit(1); });
}
