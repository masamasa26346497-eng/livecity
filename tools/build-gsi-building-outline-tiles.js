#!/usr/bin/env node
// tools/build-gsi-building-outline-tiles.js
// [Mission ALIGNMENT-VISIBILITY-FINAL §3/§11] GSI基盤地図情報「建築物の外周線」(BldL) を
//   Reference Alignment の magenta overlay 用に city-wide タイル化する。
// §0 遵守: 座標・属性は一切加工しない（simplify/buffer/snap/pair/polygonize なし）。
//   data/processed/osaka-city/gsi-building-outline/building-outline-lines.json（FIX20-22で正規化済み・
//   znorth-neg-v1・596,183 features）の座標をそのままコピーするだけの再配置。
//   ソースは1feature=1行のstreaming形式（432MB級のためJSON.parse一括不可・FIX22参照）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { readFeatureCollectionStreaming } from './lib/large-json-array-reader.js';

const SRC = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'gsi-building-outline', 'building-outline-lines.json'));
const OUT_DIR = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'derived', 'gsi-building-outline'));
const TILE_SIZE = 500; // buildings/gsi-road-edge と同じグリッド（タイル境界をtx/tzで揃える）

function bboxOf(coords) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of coords) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.log('[gsi-building-outline-tiles] ソース無し: ' + toProjectRelativePath(SRC));
    return;
  }
  const t0 = Date.now();
  const src = await readFeatureCollectionStreaming(SRC);
  const features = (src && src.features) || [];
  console.log('[gsi-building-outline-tiles] source features=' + features.length + ' (streaming read ' + (Date.now() - t0) + 'ms)');

  // [[shared-derived-dir-rmsync-trap]]の教訓: derived/ 配下は他scriptとの共有ディレクトリのため、
  //   自分の出力サブディレクトリ(gsi-building-outline/)のみ削除する。
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const tiles = new Map();
  let assignmentCount = 0, invalidCount = 0;
  for (const f of features) {
    const coords = f.geometry && f.geometry.coordinates;
    if (!coords || coords.length < 2) { invalidCount++; continue; }
    const bbox = bboxOf(coords);
    const txMin = Math.floor(bbox.minX / TILE_SIZE), txMax = Math.floor(bbox.maxX / TILE_SIZE);
    const tzMin = Math.floor(bbox.minZ / TILE_SIZE), tzMax = Math.floor(bbox.maxZ / TILE_SIZE);
    const rec = {
      id: f.id,
      geometryType: 'LineString',
      coordinates: coords,
      closed: !!f.closed,
      buildingType: (f.attrs && f.attrs.type) || null,
    };
    for (let tx = txMin; tx <= txMax; tx++) {
      for (let tz = tzMin; tz <= tzMax; tz++) {
        const key = tx + '_' + tz;
        let t = tiles.get(key);
        if (!t) { t = { tx, tz, features: [] }; tiles.set(key, t); }
        t.features.push(rec);
        assignmentCount++;
      }
    }
  }

  const tileList = [];
  for (const [, t] of tiles) {
    const file = 'tile_' + t.tx + '_' + t.tz + '.json';
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const f of t.features) {
      const b = bboxOf(f.coordinates);
      if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX;
      if (b.minZ < minZ) minZ = b.minZ; if (b.maxZ > maxZ) maxZ = b.maxZ;
    }
    const payload = {
      tileId: 'gsi-building-outline/' + t.tx + '_' + t.tz,
      layer: 'gsi-building-outline',
      tileSize: TILE_SIZE,
      bbox: { minX, maxX, minZ, maxZ },
      featureCount: t.features.length,
      features: t.features,
    };
    fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(payload));
    tileList.push({ tx: t.tx, tz: t.tz, file, count: t.features.length });
  }
  tileList.sort((a, b) => (a.tx - b.tx) || (a.tz - b.tz));

  const manifest = {
    version: 1,
    layer: 'gsi-building-outline',
    kind: 'gsi-building-outline-tiles',
    coordinateConvention: 'znorth-neg-v1',
    generatedAt: new Date().toISOString(),
    tileSize: TILE_SIZE,
    sourceFile: toProjectRelativePath(SRC),
    sourceVersion: src.generatedAt || null,
    distinctFeatureCount: features.length - invalidCount,
    invalidFeatureCount: invalidCount,
    tileAssignmentCount: assignmentCount,
    tileCount: tileList.length,
    tiles: tileList,
    note: '座標・属性はsource(building-outline-lines.json)からのコピーのみ。BldLはGSI仕様上「建築物の外周線」' +
      '＝roof outer line（屋根の外周線）であり地上投影の建物形状そのものではない点に注意（FIX20 §13）。' +
      'simplify/buffer/snap/pair/polygonizeは一切行っていない（§0）。',
  };
  await writeJson(path.join(OUT_DIR, 'manifest.json'), manifest);
  console.log('[gsi-building-outline-tiles] distinct=' + manifest.distinctFeatureCount + ' invalid=' + invalidCount +
    ' tiles=' + tileList.length + ' assignments=' + assignmentCount + ' (' + (Date.now() - t0) + 'ms)');
  console.log('保存: ' + toProjectRelativePath(OUT_DIR));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[gsi-building-outline-tiles] 失敗:', e && e.stack || e); process.exit(1); });
