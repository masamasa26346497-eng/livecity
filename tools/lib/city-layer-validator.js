// tools/lib/city-layer-validator.js
// P1-6: 都市レイヤー tile（tools/build-city-layer-tiles.js の出力）の共通 validator。
// 例外は投げず構造化結果を返す。河川は water validator を併用する（呼び出し側）。

import fs from 'node:fs';
import path from 'node:path';
import { analyzeRing } from './geometry-anomaly.js';
import { boundsOfPoints } from './city-tile-grid.js';

function check(name, pass, detail, severity = 'error') {
  return { name, pass, detail, severity };
}

function featBounds(f) {
  const pts = f.kind === 'station' ? f.p : [...(f.p || []), ...((f.holes || []).flat())];
  return boundsOfPoints(pts);
}

/**
 * @param {string} layerRoot data/processed/osaka-city/<layer>
 * @param {{grid?:object, wardPolygons?:object}} [ctx]
 *   grid: createCityTileGrid の結果（あれば tile境界整合・grid coverage を検証）
 *   wardPolygons: ward-classification-polygons.json（あれば 24区 bbox coverage を検証）
 */
export function validateCityLayer(layerRoot, ctx = {}) {
  const checks = [];
  const manifestPath = path.join(layerRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, checks: [check('manifest-exists', false, `${manifestPath} が無い`)], summary: {} };
  }
  const man = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  checks.push(check('manifest-exists', true, `layer=${man.layer} featureCount=${man.featureCount} tileCount=${man.tileCount}`));
  checks.push(check('coordinate-convention', man.coordinateConvention === 'znorth-neg-v1', `coordinateConvention=${man.coordinateConvention}`));

  const grid = ctx.grid || null;
  const tileSize = man.tileSize || (grid && grid.tileSize) || 2000;
  const buffer = man.buffer ?? (grid && grid.buffer) ?? 200;

  // ── 全 tile 走査 ──
  const uniqueIds = new Set();
  let tileFilesMissing = 0;
  let nonFinite = 0;
  let dupWithinTile = 0;
  let outsideTileBounds = 0;
  let oversizedAreas = [];
  let selfIntAreas = [];
  let oversizedLinesWarn = 0;
  let manifestTileCountMismatch = false;
  let scannedTiles = 0;
  let scannedFeatureEntries = 0;

  for (const t of (man.tiles || [])) {
    const tf = path.join(layerRoot, t.file);
    if (!fs.existsSync(tf)) { tileFilesMissing++; continue; }
    scannedTiles++;
    let tile;
    try { tile = JSON.parse(fs.readFileSync(tf, 'utf-8')); } catch { checks.push(check('tile-parse', false, `${t.file} 壊れ`)); continue; }
    const tb = { minX: t.tx * tileSize, maxX: (t.tx + 1) * tileSize, minZ: t.tz * tileSize, maxZ: (t.tz + 1) * tileSize };
    const seenInTile = new Set();
    const feats = tile.features || [];
    if (feats.length !== t.count) manifestTileCountMismatch = true;
    for (const f of feats) {
      scannedFeatureEntries++;
      if (f.id) { uniqueIds.add(f.id); if (seenInTile.has(f.id)) dupWithinTile++; else seenInTile.add(f.id); }
      const pts = f.kind === 'station' ? f.p : [...(f.p || []), ...((f.holes || []).flat())];
      for (const p of pts) {
        if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) nonFinite++;
      }
      const fb = featBounds(f);
      if (Number.isFinite(fb.minX)) {
        // feature bbox が tile bbox（buffer込み）と全く重ならない → 誤割当
        const overlaps = !(fb.maxX < tb.minX - buffer || fb.minX > tb.maxX + buffer || fb.maxZ < tb.minZ - buffer || fb.minZ > tb.maxZ + buffer);
        if (!overlaps) outsideTileBounds++;
      }
      // 幾何異常（面系）。河川（未連結 multipolygon が主問題）は bbox 対角比も見る厳しめ判定、
      // 公園は単純な四角形が多く bbox 比だと誤検出するため中央値倍率のみ。
      if (f.kind === 'area') {
        const areaOpts = man.layer === 'waterways'
          ? { oversizedAbs: 350, oversizedMedianMult: 15, oversizedBboxRatio: 0.33 }
          : { oversizedAbs: 800, oversizedMedianMult: 12 };
        for (const ring of [f.p, ...((f.holes || []))]) {
          const ev = analyzeRing(ring, areaOpts);
          if (ev.oversizedSegments > 0 && !oversizedAreas.includes(f.id)) oversizedAreas.push(f.id);
          if (ev.selfIntersections > 0 && !selfIntAreas.includes(f.id)) selfIntAreas.push(f.id);
        }
      } else if (f.kind === 'line') {
        const ev = analyzeRing(f.p, { oversizedAbs: 1500, oversizedMedianMult: 40 });
        if (ev.oversizedSegments > 0) oversizedLinesWarn++;
      }
    }
  }

  checks.push(check('tile-files-exist', tileFilesMissing === 0, tileFilesMissing ? `${tileFilesMissing} tile ファイル欠落` : `${scannedTiles} tiles OK`));
  checks.push(check('manifest-tilecount-consistent', !manifestTileCountMismatch, manifestTileCountMismatch ? 'manifest の count と tile 実数が不一致' : 'OK'));
  checks.push(check('source-count-consistent', uniqueIds.size === man.featureCount,
    `unique feature id ${uniqueIds.size} / manifest.featureCount ${man.featureCount}`));
  checks.push(check('no-duplicate-id-within-tile', dupWithinTile === 0, dupWithinTile ? `同一 tile 内 id 重複 ${dupWithinTile}` : 'OK'));
  checks.push(check('coords-finite', nonFinite === 0, nonFinite ? `非有限座標 ${nonFinite}点` : 'OK'));
  checks.push(check('features-in-tile-bounds', outsideTileBounds === 0, outsideTileBounds ? `tile bbox と重ならない feature ${outsideTileBounds}` : 'OK'));
  checks.push(check('no-oversized-area-segments', oversizedAreas.length === 0, oversizedAreas.length ? `巨大セグメントを含む面 ${oversizedAreas.length}: ${oversizedAreas.slice(0, 5).join(', ')}` : 'OK'));
  checks.push(check('no-area-self-intersections', selfIntAreas.length === 0, selfIntAreas.length ? `自己交差を含む面 ${selfIntAreas.length}: ${selfIntAreas.slice(0, 5).join(', ')}` : 'OK'));
  if (oversizedLinesWarn) checks.push(check('line-oversized-segments', true, `中央値40倍かつ>1.5km の線分を含む線 ${oversizedLinesWarn}（要目視: way接続漏れの可能性）`, 'warning'));

  // ── 24区 bbox coverage / known 3 wards coverage ──
  if (ctx.wardPolygons && Array.isArray(ctx.wardPolygons.wards) && man.bboxLocal) {
    const gb = man.bboxLocal;
    const notCovered = [];
    for (const w of ctx.wardPolygons.wards) {
      const wb = w.bbox;
      if (!wb) continue;
      const inside = wb.minX >= gb.minX - 1 && wb.maxX <= gb.maxX + 1 && wb.minZ >= gb.minZ - 1 && wb.maxZ <= gb.maxZ + 1;
      if (!inside) notCovered.push(w.wardName);
    }
    checks.push(check('24-ward-bbox-coverage', notCovered.length === 0,
      notCovered.length ? `grid bbox が覆っていない区: ${notCovered.join('、')}` : `24区すべて grid bbox 内`));

    const KNOWN = { sumiyoshi: '住吉区', higashisumiyoshi: '東住吉区', hirano: '平野区' };
    const knownMissing = [];
    for (const id of Object.keys(KNOWN)) {
      const w = ctx.wardPolygons.wards.find((x) => x.wardId === id);
      if (!w) { knownMissing.push(id); continue; }
      const wb = w.bbox;
      const inside = wb.minX >= gb.minX - 1 && wb.maxX <= gb.maxX + 1 && wb.minZ >= gb.minZ - 1 && wb.maxZ <= gb.maxZ + 1;
      if (!inside) knownMissing.push(KNOWN[id]);
    }
    checks.push(check('known-3-wards-coverage', knownMissing.length === 0, knownMissing.length ? knownMissing.join('、') : '住吉区・東住吉区・平野区 OK'));
  }

  const errorFails = checks.filter((c) => !c.pass && c.severity === 'error');
  return {
    ok: errorFails.length === 0,
    checks,
    summary: {
      layer: man.layer, featureCount: man.featureCount, tileCount: man.tileCount,
      featureTileEntries: scannedFeatureEntries, uniqueFeatureIds: uniqueIds.size,
      errorFailCount: errorFails.length, warningCount: checks.filter((c) => !c.pass && c.severity === 'warning').length,
      layerMeta: man.layerMeta || null,
    },
  };
}
