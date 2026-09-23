#!/usr/bin/env node
// tools/build-gsi-road-edge-tiles.js
// [Mission 31G-ALIGNMENT-RESET §8/§9/§10/§27/§31] GSI 基盤地図情報「道路縁」(RdEdg) を
//   camera 近傍タイルだけを fetch できるよう 500m グリッドへ分割する。
// §0 遵守: 座標・属性は一切加工しない（simplify/buffer/snap/pair/polygonize なし）。
//   data/processed/osaka-city/gsi-road-edge/road-edge-lines.json（FIX16 で正規化済み・
//   znorth-neg-v1・112,199 features）の座標をそのままコピーするだけの再配置。
//   §31: 「1 road = 1 mesh」を避けるため、runtime 側は tile 単位で LineSegments へ merge する
//   （このスクリプトは tile への振り分けのみ。merge 自体は runtime 側の責務）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';

const SRC = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'gsi-road-edge', 'road-edge-lines.json'));
const OUT_DIR = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'derived', 'gsi-road-edge'));
const TILE_SIZE = 500; // buildings/building-placement と同じグリッド（camera近傍fetchの粒度を揃える）

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
    console.log('[gsi-road-edge-tiles] ソース無し: ' + toProjectRelativePath(SRC) + '（tools/import-gsi-road-edge.js を先に実行してください）');
    return;
  }
  const t0 = Date.now();
  const src = JSON.parse(fs.readFileSync(SRC, 'utf-8'));
  const features = src.features || [];
  console.log('[gsi-road-edge-tiles] source features=' + features.length + ' (parse ' + (Date.now() - t0) + 'ms)');

  // 既存 far/mid/near LOD と同じ「このscriptが所有する出力だけを消す」方針
  // （[[shared-derived-dir-rmsync-trap]]の教訓 — 31G-FIX24 で発生した親ディレクトリ巻き添え削除
  //   バグの再発防止。derived/ 配下は他scriptとの共有ディレクトリのため、自分のサブディレクトリのみ削除する）。
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const tiles = new Map(); // key `${tx}_${tz}` -> {tx,tz,features:[]}
  let assignmentCount = 0;
  let invalidCount = 0;
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
      roadType: (f.attrs && f.attrs.type) || null,
      confidence: f.confidence != null ? f.confidence : null,
      sourceDate: f.sourceDate || null,
    };
    // bbox が跨る全タイルへ収録する（タイル境界での欠落を防ぐ。§9「まず道路縁を正確に描く」を
    //   camera近傍のどのタイルからでも保証するための意図的な重複。重複件数は manifest に記録）。
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
      tileId: 'gsi-road-edge/' + t.tx + '_' + t.tz,
      layer: 'gsi-road-edge',
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
    layer: 'gsi-road-edge',
    kind: 'gsi-road-edge-tiles',
    coordinateConvention: 'znorth-neg-v1',
    generatedAt: new Date().toISOString(),
    tileSize: TILE_SIZE,
    sourceFile: toProjectRelativePath(SRC),
    sourceVersion: src.generatedAt || null,
    distinctFeatureCount: features.length - invalidCount,
    invalidFeatureCount: invalidCount,
    tileAssignmentCount: assignmentCount, // タイル境界重複を含む延べ件数（distinctFeatureCountとは別）
    tileCount: tileList.length,
    tiles: tileList,
    note: '座標・属性はsource(road-edge-lines.json)からのコピーのみ。simplify/buffer/snap/pair/polygonizeは一切行っていない（§0/§10）。',
  };
  await writeJson(path.join(OUT_DIR, 'manifest.json'), manifest);
  console.log('[gsi-road-edge-tiles] distinct=' + manifest.distinctFeatureCount + ' invalid=' + invalidCount +
    ' tiles=' + tileList.length + ' assignments=' + assignmentCount + ' (' + (Date.now() - t0) + 'ms)');
  console.log('保存: ' + toProjectRelativePath(OUT_DIR));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[gsi-road-edge-tiles] 失敗:', e && e.stack || e); process.exit(1); });
