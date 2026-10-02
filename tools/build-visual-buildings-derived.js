#!/usr/bin/env node
// tools/build-visual-buildings-derived.js
// [Mission 32B §23/§36] Visual Building Geometry を既存の near/mid/far LOD tile architecture へ。
//   NEAR=exact（Canonical Buildingsと同じ§0方針: near tierは簡略化しない）、MID/FAR=simplified。
//   §0: data/processed/osaka-city/visual-buildings/ 自体（tools/build-visual-buildings.jsの出力）は
//   読み取り専用。ここではその内容を near/mid/far 各tierへコピー・簡略化するだけ（新規geometry生成なし）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { simplifyGeometry } from './lib/geometry-simplify.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const SRC_DIR = P('data', 'processed', 'osaka-city', 'visual-buildings');
const OUT_ROOT = P('data', 'processed', 'osaka-city', 'derived-visual-buildings'); // 既存derived/と衝突しない専用ディレクトリ（[[shared-derived-dir-rmsync-trap]]対策）
const LOD = { far: { tolM: 12 }, mid: { tolM: 6 }, near: { tolM: 0 } };
const isTile = (f) => /^tile_-?\d+_-?\d+\.json$/.test(f);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

function ringArea(ring) { let a = 0; for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; a += x1 * z2 - x2 * z1; } return Math.abs(a) / 2; }
function ringBbox(ring) { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity; for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; } return { minX, maxX, minZ, maxZ }; }
function ringCentroidSimple(ring) { let sx = 0, sz = 0; for (const [x, z] of ring) { sx += x; sz += z; } return [sx / ring.length, sz / ring.length]; }

async function main() {
  const generatedAt = new Date().toISOString();
  if (!fs.existsSync(path.join(SRC_DIR, 'manifest.json'))) {
    console.log('[visual-buildings-derived] source無し。先に tools/build-visual-buildings.js');
    return;
  }
  const files = fs.readdirSync(SRC_DIR).filter(isTile);

  fs.mkdirSync(OUT_ROOT, { recursive: true });
  for (const lod of Object.keys(LOD)) fs.rmSync(path.join(OUT_ROOT, lod), { recursive: true, force: true });

  const results = {};
  for (const lod of Object.keys(LOD)) {
    const tolM = LOD[lod].tolM;
    const outDir = path.join(OUT_ROOT, lod);
    fs.mkdirSync(outDir, { recursive: true });
    let featureCount = 0, vertexCount = 0, droppedEmpty = 0;
    const tileList = [];
    for (const f of files) {
      const src = rj(path.join(SRC_DIR, f));
      if (!src) continue;
      const outFeats = [];
      for (const vf of src.features) {
        const simplified = tolM > 0 ? simplifyGeometry('Polygon', vf.geometry.coordinates, tolM) : { geometryType: 'Polygon', coordinates: vf.geometry.coordinates };
        if (!simplified) { droppedEmpty++; continue; }
        const ring = simplified.coordinates[0];
        outFeats.push({
          visualId: vf.visualId,
          canonicalId: vf.canonicalIds[0], // 既存runtime(picking/property card)互換の単一ID
          canonicalIds: vf.canonicalIds,
          layer: 'buildings', lod,
          geometryType: 'Polygon', coordinates: simplified.coordinates,
          bbox: ringBbox(ring), centroid: ringCentroidSimple(ring),
          simplificationToleranceM: tolM,
          geometrySource: vf.geometrySource, matchType: vf.matchType, confidence: vf.confidence,
          attributes: { heightM: vf.heightM, usageCategory: vf.usageCategory, usage: vf.usage, usageLabel: vf.usageLabel, wardId: vf.wardId, source: vf.geometrySource },
        });
        featureCount++; vertexCount += ring.length;
      }
      if (!outFeats.length) continue;
      fs.writeFileSync(path.join(outDir, f), JSON.stringify({ tileId: 'visual-buildings/' + lod + '/' + f.replace('tile_', '').replace('.json', ''), layer: 'buildings', lod, tileSize: 500, featureCount: outFeats.length, features: outFeats }));
      const m = f.match(/^tile_(-?\d+)_(-?\d+)\.json$/);
      tileList.push({ tx: +m[1], tz: +m[2], file: f, count: outFeats.length });
    }
    tileList.sort((a, b) => (a.tx - b.tx) || (a.tz - b.tz));
    const manifest = {
      version: 1, layer: 'buildings', lod, kind: 'visual-buildings-derived', coordinateConvention: 'znorth-neg-v1',
      generatedAt, tileSize: 500, simplificationToleranceM: tolM, passthrough: tolM === 0,
      featureCount, vertexCount, droppedEmptyAfterSimplify: droppedEmpty, tiles: tileList,
      note: 'source: data/processed/osaka-city/visual-buildings/（Visual Building Geometry。GSI polygon優先+PLATEAU fallback）。' +
        'near(tolM=0)はexact（FIX24の建物exact方針をVisual Buildingへも踏襲）。',
    };
    await writeJson(path.join(outDir, 'manifest.json'), manifest);
    results[lod] = { featureCount, tileCount: tileList.length, droppedEmpty };
    console.log('[visual-buildings-derived] ' + lod + ': features=' + featureCount + ' tiles=' + tileList.length + ' droppedEmpty=' + droppedEmpty);
  }
  console.log('保存: ' + toProjectRelativePath(OUT_ROOT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[visual-buildings-derived] 失敗:', e && e.stack || e); process.exit(1); });
