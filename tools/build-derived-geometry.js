#!/usr/bin/env node
// tools/build-derived-geometry.js
// [Mission 31F §12–§22] Resolved Canonical → Derived Geometry（LOD / Tile）。
//   canonical 本体は絶対に simplify しない（§0）。derived/ のみ simplify + LOD 絞り込み + tile。
//   共通 tile schema（§18）:
//     { tileId, layer, lod, tileSize, bbox, featureCount, canonicalIds, sourceVersion, features }
//   derived feature（§22）:
//     { canonicalId, derivedFrom, layer, lod, geometryType, coordinates, bbox, centroid,
//       simplificationToleranceM, correctionIds, sourceConfidence, attributes }
//
//   出力: data/processed/osaka-city/derived/{far,mid,near}/<layer>/{manifest.json, tile_*.json}
//         data/processed/osaka-city/derived/manifest.json
//         data/reports/derived-geometry-build.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { bboxOf, centroidOf, polygonAreaM2 } from './lib/canonical-geometry-schema.js';
import { simplifyGeometry } from './lib/geometry-simplify.js';
import { MAJOR_MIN_HEIGHT_M, MAJOR_MIN_FP_AREA_M2 } from './lib/major-building-lod.js';
import { STRICT_TILE_RE, writeFilesVerified, readFileRetry } from './lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const CANON = P('data', 'processed', 'osaka-city', 'canonical');
const DERIVED = P('data', 'processed', 'osaka-city', 'derived');
const REPORT = P('data', 'reports', 'derived-geometry-build.json');

// §20 LOD 別 error tolerance（メートル）。near = 全 feature を tolM 2m で保持する「完全＋微 simplify」level。
//   （旧 ultra-near = tolM 0 の完全コピーは near とほぼ同一かつ容量 2 倍だったため 31G で廃止。
//    resolved canonical 本体が「full precision」の唯一の正となる。）
const LOD = {
  far: { tolM: 12 },
  mid: { tolM: 6 },
  near: { tolM: 2 },
};
// [Mission 31G-FIX24 §1/§6/§7] buildings の near tier のみ canonical exact footprint（tolM=0）へ変更。
//   実測（data/reports/building-exact-near-alignment.json・615,617棟全数）で、上記コメントが主張する
//   「near(tolM=2)はultra-near(tolM=0)とほぼ同一」を明確に否定するデータが出た:
//     - 159,232棟(25.9%)が0.25m超、74,881棟(12.2%)が1.0m超、4,907棟(0.8%)が2.0m超の頂点ずれ
//     - 9棟は20m超（Visvalingam-Whyatt=面積ベース simplify の既知の弱点＝細い"spike"頂点は
//       遠くにあっても三角形面積が小さいため誤って除去されうる）
//   これはユーザー報告「建物が全体的にちょっとずれている」の一因になりうる規模のため、
//   near tier のみ tolM=0（simplify自体を行わない・canonical coordinatesをそのまま使う）へ変更する。
//   §20方針: road/water/park/railのnear tierは影響範囲を最小化するため変更しない
//   （tolM=2のまま。building以外のlayerには一切触れない）。
const LOD_TOLERANCE_OVERRIDE = { buildings: { near: 0 } };
function tolForLayerLod(layer, lod) {
  const o = LOD_TOLERANCE_OVERRIDE[layer];
  return (o && o[lod] != null) ? o[lod] : LOD[lod].tolM;
}
const LOD_ORDER = ['far', 'mid', 'near'];

// §19 tile size は既存整合を優先（buildings 500m / それ以外 2000m）。
const TILE_SIZE = { buildings: 500, roads: 2000, water: 2000, parks: 2000, rail: 2000 };

// ── §13–§17 LOD 別 feature フィルタ ──
function buildingVisibleAt(lod, attr, areaM2) {
  const h = attr && attr.heightM != null ? +attr.heightM : 0;
  const major = h >= MAJOR_MIN_HEIGHT_M || areaM2 >= MAJOR_MIN_FP_AREA_M2;
  const medium = h >= 12 || areaM2 >= 800;
  if (lod === 'far') return major;
  if (lod === 'mid') return major || medium;
  return true; // near = 完全
}
function roadVisibleAt(lod, attr) {
  const c = attr && attr.lodClass;
  if (lod === 'far') return c === 'major';
  if (lod === 'mid') return c === 'major' || c === 'mid';
  return true; // near = 完全（alley / track / pedestrian も）
}
function waterVisibleAt(lod, attr, areaM2) {
  const wc = attr && attr.waterClass;
  const rc = attr && attr.riverClass;
  const bigRiver = rc === 'major' || wc === 'harbor' || wc === 'sea' || areaM2 >= 200000;
  const medium = areaM2 >= 20000 || wc === 'river' || wc === 'canal';
  if (lod === 'far') return bigRiver;
  if (lod === 'mid') return bigRiver || medium;
  return true; // near = 完全（micro 水面も）
}
function parkVisibleAt(lod, attr, areaM2) {
  const rankable = attr && attr.rankable;
  const pc = attr && attr.parkClass;
  const isRealPark = pc === 'park' || pc === 'recreation_ground' || pc === 'garden' || pc === 'playground' || pc === 'sports_ground';
  if (lod === 'far') return rankable && areaM2 >= 50000;
  if (lod === 'mid') return isRealPark && areaM2 >= 8000;
  return true; // near = 完全（grass / green_space / misclassified-block も）
}
function railVisibleAt(lod, attr) {
  const c = attr && attr.lodClass;
  if (lod === 'far') return c === 'major';
  if (lod === 'mid') return c === 'major' || c === 'urban';
  return true; // near = 完全（local も）
}

function correctionIdsOf(f) {
  const ids = [];
  if (f.attributes && f.attributes.correctionApplied) ids.push(f.attributes.correctionApplied);
  for (const q of (f.qaFlags || [])) {
    if (q.startsWith('corrected-31E') || q.startsWith('reclassified-31E') || q.startsWith('split-from-')) ids.push(q);
  }
  return [...new Set(ids)];
}

// canonical feature → derived feature（simplify 済み geometry を渡す）
function toDerived(f, lod, tolM, g, attrPick) {
  const bbox = bboxOf(g.coordinates);
  const centroid = centroidOf(g.geometryType, g.coordinates);
  return {
    canonicalId: f.canonicalId,
    derivedFrom: f.canonicalId,
    layer: f.layer, lod,
    geometryType: g.geometryType,
    coordinates: g.coordinates,
    bbox,
    centroid: centroid ? [+centroid[0].toFixed(2), +centroid[1].toFixed(2)] : null,
    simplificationToleranceM: tolM,
    correctionIds: correctionIdsOf(f),
    sourceConfidence: f.source ? f.source.confidence : null,
    attributes: attrPick,
  };
}

// レイヤーの canonical feature を（tile ごとに）読み、attr を join し、LOD ごとに derived tile を書く。
function processLayer(layer, opts) {
  const srcDir = opts.srcDir;
  const attrDir = opts.attrDir;
  // [Mission 32N] OneDrive の競合コピー（tile_x_z-<PC名>.json）を読まないよう、名前は厳密に判定する。
  const tileFiles = fs.readdirSync(srcDir).filter((f) => STRICT_TILE_RE.test(f));
  const readSrc = opts.syncedWrite ? (p) => readFileRetry(p) : (p) => fs.readFileSync(p, 'utf-8');
  const size = TILE_SIZE[layer];
  const perLod = {};
  for (const lod of LOD_ORDER) perLod[lod] = { tiles: new Map(), featureCount: 0, vertexCount: 0, canonicalIds: new Set() };

  const seenGlobal = new Set();
  for (const tf of tileFiles) {
    const t = JSON.parse(readSrc(path.join(srcDir, tf)));
    // attr tile（buildings のみ）
    let attrMap = null;
    if (attrDir) {
      const ap = path.join(attrDir, tf);
      if (fs.existsSync(ap)) attrMap = JSON.parse(readSrc(ap)).attributes || {};
    }
    for (const f of (t.features || [])) {
      if (seenGlobal.has(f.canonicalId)) continue; // tile 境界の重複を 1 回だけ
      seenGlobal.add(f.canonicalId);
      const attr = attrMap ? attrMap[f.canonicalId] : (f.attributes || {});
      const areaM2 = f.areaM2 != null ? f.areaM2 : (/Polygon/.test(f.geometryType) ? polygonAreaM2(f.geometryType, f.coordinates) : 0);
      const attrPick = opts.pickAttr(attr, f);

      for (const lod of LOD_ORDER) {
        if (!opts.visible(lod, attr, areaM2)) continue;
        const tolM = tolForLayerLod(layer, lod);
        let g;
        if (tolM <= 0) g = { geometryType: f.geometryType, coordinates: f.coordinates };
        else {
          g = simplifyGeometry(f.geometryType, f.coordinates, tolM);
          if (!g) { // simplify で消滅 → 1 段軽い tolerance で救済
            g = simplifyGeometry(f.geometryType, f.coordinates, tolM / 2) || { geometryType: f.geometryType, coordinates: f.coordinates };
          }
        }
        const d = toDerived(f, lod, tolM, g, attrPick);
        // vertex 数
        let vc = 0; const walk = (v) => { if (typeof v[0] === 'number') vc++; else v.forEach(walk); };
        walk(d.coordinates);
        const B = perLod[lod];
        B.featureCount++; B.vertexCount += vc; B.canonicalIds.add(f.canonicalId);
        for (let tx = Math.floor(d.bbox.minX / size); tx <= Math.floor(d.bbox.maxX / size); tx++)
          for (let tz = Math.floor(d.bbox.minZ / size); tz <= Math.floor(d.bbox.maxZ / size); tz++) {
            const k = tx + '_' + tz;
            if (!B.tiles.has(k)) B.tiles.set(k, []);
            B.tiles.get(k).push(d);
          }
      }
    }
  }

  // 書き出し
  const lodSummaries = {};
  for (const lod of LOD_ORDER) {
    const B = perLod[lod];
    // [Mission 32N] V2 corrected 用に出力先を切り替えられるようにする（既定は従来の derived/<lod>/<layer>）。
    //   消すのは自分が書く <outRoot>/<lod>/<layerDir> だけ（共有親は消さない §14）。
    const outDir = path.join(opts.outRoot || DERIVED, lod, opts.layerDir || layer);
    //   opts.syncedWrite: ディレクトリを消さずに上書き＋読み戻し検証（OneDrive 競合対策 / tools/lib/synced-dir-writer.js）
    const pending = opts.syncedWrite ? new Map() : null;
    if (!pending) {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
    }
    const tiles = [];
    let diskBytes = 0;
    for (const [k, feats] of [...B.tiles.entries()].sort()) {
      const [tx, tz] = k.split('_').map(Number);
      const bbox = bboxOf(feats.map((d) => d.coordinates));
      const tile = {
        tileId: `${layer}/${lod}/${tx}_${tz}`,
        layer, lod, tileSize: size,
        bbox, featureCount: feats.length,
        canonicalIds: feats.map((d) => d.canonicalId),
        sourceVersion: opts.sourceVersion,
        features: feats,
      };
      const body = JSON.stringify(tile);
      if (pending) { pending.set(`tile_${tx}_${tz}.json`, body); diskBytes += Buffer.byteLength(body); }
      else fs.writeFileSync(path.join(outDir, `tile_${tx}_${tz}.json`), body);
      tiles.push({ tx, tz, file: `tile_${tx}_${tz}.json`, count: feats.length });
    }
    if (!pending) for (const t of tiles) diskBytes += fs.statSync(path.join(outDir, t.file)).size;
    const manifestBody = JSON.stringify({
      version: 1, layer, lod, kind: 'derived-geometry', coordinateConvention: 'znorth-neg-v1',
      generatedAt: opts.generatedAt, tileSize: size,
      simplificationToleranceM: tolForLayerLod(layer, lod), passthrough: !!LOD[lod].passthrough,
      featureCount: B.featureCount, distinctCanonicalIds: B.canonicalIds.size, vertexCount: B.vertexCount,
      sourceVersion: opts.sourceVersion,
      tiles,
    }, null, 2);
    if (pending) {
      pending.set('manifest.json', manifestBody);
      writeFilesVerified(outDir, pending, { label: `${opts.layerDir || layer}/${lod}` });
    } else {
      fs.writeFileSync(path.join(outDir, 'manifest.json'), manifestBody);
    }
    lodSummaries[lod] = {
      featureCount: B.featureCount, distinctCanonicalIds: B.canonicalIds.size,
      vertexCount: B.vertexCount, tiles: tiles.length, diskBytes,
      toleranceM: tolForLayerLod(layer, lod),
    };
  }
  return { canonicalCount: seenGlobal.size, lod: lodSummaries };
}

// [Mission 31G-FIX24 実測で発見・修正] このscriptが所有する出力（LOD別tile一式・自身のmanifest.json）
//   だけを消す。以前は data/processed/osaka-city/derived/ ディレクトリ全体を fs.rmSync していたため、
//   同じ親ディレクトリを共有する「他scriptが所有する成果物」（refined-road-surface.json /
//   road-render-class.json / building-ward-index.json / building-placement/）まで巻き添えで
//   消えてしまう実バグがあった（31G-FIX24作業中に実際に発生・tools/build-refined-road-surface.js等を
//   再実行して復旧した）。「このscriptが作るものだけを消す」設計へ修正する。
const OWNED_TOP_LEVEL = ['manifest.json']; // このscript自身が書き出す唯一のtop-levelファイル
function cleanOwnedOutputs() {
  fs.mkdirSync(DERIVED, { recursive: true });
  for (const lod of LOD_ORDER) fs.rmSync(path.join(DERIVED, lod), { recursive: true, force: true });
  for (const f of OWNED_TOP_LEVEL) fs.rmSync(path.join(DERIVED, f), { force: true });
}

async function main() {
  const generatedAt = new Date().toISOString();
  cleanOwnedOutputs();
  const results = {};

  console.log('[derived] water...');
  {
    const body = JSON.parse(fs.readFileSync(P('data', 'processed', 'osaka-city', 'canonical', 'water.json'), 'utf-8'));
    // water は body 形式。tile 形式へ薄く変換して processLayer と同じ扱い。
    const tmp = P('data', 'processed', 'osaka-city', 'canonical', 'water');
    results.water = processLayerFromFeatures('water', body.features, {
      generatedAt, sourceVersion: body.generatedAt,
      visible: waterVisibleAt,
      pickAttr: (a) => ({ name: a.name || null, waterClass: a.waterClass || null, riverClass: a.riverClass || null }),
    });
  }
  console.log('[derived] roads...');
  results.roads = processLayer('roads', {
    srcDir: P('data', 'processed', 'osaka-city', 'canonical', 'roads'),
    generatedAt, sourceVersion: readGen(P('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json')),
    visible: (lod, a) => roadVisibleAt(lod, a),
    pickAttr: (a) => ({ name: a.name || null, highway: a.highway || null, lodClass: a.lodClass || null, bridge: a.bridge || null, tunnel: a.tunnel || null }),
  });
  console.log('[derived] buildings...');
  results.buildings = processLayer('buildings', buildingLayerOpts({
    srcDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings'),
    attrDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'attributes'),
    generatedAt, sourceVersion: readGen(P('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json')),
  }));
  console.log('[derived] parks...');
  results.parks = processLayer('parks', {
    srcDir: P('data', 'processed', 'osaka-city', 'canonical', 'parks'),
    generatedAt, sourceVersion: readGen(P('data', 'processed', 'osaka-city', 'canonical', 'parks', 'manifest.json')),
    visible: (lod, a, area) => parkVisibleAt(lod, a, area),
    pickAttr: (a) => ({ name: a.name || null, parkClass: a.parkClass || null, rankable: !!a.rankable }),
  });
  console.log('[derived] rail...');
  results.rail = processLayer('rail', {
    srcDir: P('data', 'processed', 'osaka-city', 'canonical', 'rail'),
    generatedAt, sourceVersion: readGen(P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'manifest.json')),
    visible: (lod, a) => railVisibleAt(lod, a),
    pickAttr: (a) => ({ name: a.name || null, railway: a.railway || null, lodClass: a.lodClass || null, railClass: a.railClass || null }),
  });

  // ── §25 derived completeness ──
  const completeness = {};
  for (const [layer, r] of Object.entries(results)) {
    completeness[layer] = { canonicalCount: r.canonicalCount };
    for (const lod of LOD_ORDER) {
      const s = r.lod[lod];
      completeness[layer][lod] = {
        derivedRepresentedCount: s.distinctCanonicalIds,
        // far/mid は LOD 方針で意図的に間引く（expectedHidden）。near だけは全 canonical feature を持つ。
        expectedHidden: lod === 'near' ? 0 : (r.canonicalCount - s.distinctCanonicalIds),
        actualMissing: lod === 'near' ? (r.canonicalCount - s.distinctCanonicalIds) : 0,
      };
    }
  }

  // ── §26 performance budget 予測 ──
  const perf = {};
  let totalDisk = 0, totalTiles = 0, totalFeat = 0, totalVert = 0;
  for (const [layer, r] of Object.entries(results)) {
    perf[layer] = {};
    for (const lod of LOD_ORDER) {
      const s = r.lod[lod];
      perf[layer][lod] = {
        tileCount: s.tiles, featureCount: s.featureCount, vertexCount: s.vertexCount,
        triangleCountEstimate: Math.round(s.vertexCount * 0.9), // polygon fan 近似
        estimatedDrawCalls: s.tiles, // tile ごと 1 draw call 近似
        diskBytes: s.diskBytes,
      };
      totalDisk += s.diskBytes; totalTiles += s.tiles; totalFeat += s.featureCount; totalVert += s.vertexCount;
    }
  }

  fs.writeFileSync(path.join(DERIVED, 'manifest.json'), JSON.stringify({
    version: 1, kind: 'derived-geometry-index', coordinateConvention: 'znorth-neg-v1', generatedAt,
    pipeline: 'Resolved Canonical → Derived → LOD → Tile',
    lodTolerances: Object.fromEntries(Object.entries(LOD).map(([k, v]) => [k, v.tolM])), // 既定値（layer override適用前）
    // [Mission 31G-FIX24 §1] layer別のtolerance override（buildings.near=0等）。既定値と異なるlayerのみ記載。
    lodToleranceOverrides: LOD_TOLERANCE_OVERRIDE,
    tileSizes: TILE_SIZE,
    layers: Object.keys(results),
    perLayerLod: Object.fromEntries(Object.entries(results).map(([l, r]) => [l, r.lod])),
    totals: { diskBytes: totalDisk, tiles: totalTiles, features: totalFeat, vertices: totalVert },
  }, null, 2));

  const report = {
    generatedAt,
    layers: Object.fromEntries(Object.entries(results).map(([l, r]) => [l, { canonicalCount: r.canonicalCount, lod: r.lod }])),
    completeness, performanceBudget: perf,
    totals: { diskBytes: totalDisk, diskMB: +(totalDisk / 1048576).toFixed(1), tiles: totalTiles, features: totalFeat, vertices: totalVert },
    RESULT: 'PASS',
  };
  // near で actualMissing があれば FAIL（near = resolved canonical の完全表現）
  let missTotal = 0;
  for (const layer of Object.keys(completeness)) missTotal += completeness[layer]['near'].actualMissing;
  if (missTotal > 0) report.RESULT = 'MISSING-FEATURES';

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[derived] done. disk ' + report.totals.diskMB + 'MB / tiles ' + totalTiles + ' / features ' + totalFeat + ' / vertices ' + totalVert);
  for (const [l, r] of Object.entries(results)) {
    console.log('  ' + l.padEnd(10) + LOD_ORDER.map((lod) => lod + ':' + r.lod[lod].featureCount).join(' '));
  }
  console.log('  near missing (must be 0): ' + missTotal + '  RESULT: ' + report.RESULT);
  console.log('保存: ' + toProjectRelativePath(DERIVED) + '/manifest.json / ' + toProjectRelativePath(REPORT));
  if (report.RESULT !== 'PASS') process.exitCode = 1;
}

// [Mission 32N] 建物 layer の LOD 可視判定と属性抽出（V1 main と V2 corrected で同一のものを使う）。
export function buildingLayerOpts(base) {
  return {
    ...base,
    visible: (lod, a, area) => buildingVisibleAt(lod, a, area),
    pickAttr: (a) => ({
      usage: a.usage != null ? a.usage : null,
      normalizedUsage: a.normalizedUsage || null,
      usageCategory: a.usageCategory || null,
      usageLabel: a.usageLabel || null,
      heightM: a.heightM != null ? a.heightM : null,
      source: a.source || null,
      wardId: a.wardId || null,
    }),
  };
}
export { processLayer as processDerivedLayer, LOD_ORDER as DERIVED_LOD_ORDER };

function readGen(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')).generatedAt; } catch { return null; } }

// water は body 形式なので features 配列から直接処理する版
function processLayerFromFeatures(layer, features, opts) {
  const size = TILE_SIZE[layer];
  const perLod = {};
  for (const lod of LOD_ORDER) perLod[lod] = { tiles: new Map(), featureCount: 0, vertexCount: 0, canonicalIds: new Set() };
  const seen = new Set();
  for (const f of features) {
    if (seen.has(f.canonicalId)) continue;
    seen.add(f.canonicalId);
    const attr = f.attributes || {};
    const areaM2 = f.areaM2 != null ? f.areaM2 : polygonAreaM2(f.geometryType, f.coordinates);
    const attrPick = opts.pickAttr(attr, f);
    for (const lod of LOD_ORDER) {
      if (!opts.visible(lod, attr, areaM2)) continue;
      const tolM = tolForLayerLod(layer, lod); // [Mission 31G-FIX24] このfunctionは現状waterのみで呼ばれ、
        // buildingsのoverrideとは無関係だが、一貫性のためtolForLayerLod()経由に統一する。
      let g;
      if (tolM <= 0) g = { geometryType: f.geometryType, coordinates: f.coordinates };
      else g = simplifyGeometry(f.geometryType, f.coordinates, tolM) || simplifyGeometry(f.geometryType, f.coordinates, tolM / 2) || { geometryType: f.geometryType, coordinates: f.coordinates };
      const d = toDerived(f, lod, tolM, g, attrPick);
      let vc = 0; const walk = (v) => { if (typeof v[0] === 'number') vc++; else v.forEach(walk); }; walk(d.coordinates);
      const B = perLod[lod];
      B.featureCount++; B.vertexCount += vc; B.canonicalIds.add(f.canonicalId);
      for (let tx = Math.floor(d.bbox.minX / size); tx <= Math.floor(d.bbox.maxX / size); tx++)
        for (let tz = Math.floor(d.bbox.minZ / size); tz <= Math.floor(d.bbox.maxZ / size); tz++) {
          const k = tx + '_' + tz;
          if (!B.tiles.has(k)) B.tiles.set(k, []);
          B.tiles.get(k).push(d);
        }
    }
  }
  const lodSummaries = {};
  for (const lod of LOD_ORDER) {
    const B = perLod[lod];
    const outDir = path.join(DERIVED, lod, layer);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const tiles = [];
    for (const [k, feats] of [...B.tiles.entries()].sort()) {
      const [tx, tz] = k.split('_').map(Number);
      const tile = { tileId: `${layer}/${lod}/${tx}_${tz}`, layer, lod, tileSize: size, bbox: bboxOf(feats.map((d) => d.coordinates)), featureCount: feats.length, canonicalIds: feats.map((d) => d.canonicalId), sourceVersion: opts.sourceVersion, features: feats };
      fs.writeFileSync(path.join(outDir, `tile_${tx}_${tz}.json`), JSON.stringify(tile));
      tiles.push({ tx, tz, file: `tile_${tx}_${tz}.json`, count: feats.length });
    }
    let diskBytes = 0; for (const t of tiles) diskBytes += fs.statSync(path.join(outDir, t.file)).size;
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
      version: 1, layer, lod, kind: 'derived-geometry', coordinateConvention: 'znorth-neg-v1', generatedAt: opts.generatedAt,
      tileSize: size, simplificationToleranceM: tolForLayerLod(layer, lod), passthrough: !!LOD[lod].passthrough,
      featureCount: B.featureCount, distinctCanonicalIds: B.canonicalIds.size, vertexCount: B.vertexCount, sourceVersion: opts.sourceVersion, tiles,
    }, null, 2));
    lodSummaries[lod] = { featureCount: B.featureCount, distinctCanonicalIds: B.canonicalIds.size, vertexCount: B.vertexCount, tiles: tiles.length, diskBytes, toleranceM: tolForLayerLod(layer, lod) };
  }
  return { canonicalCount: seen.size, lod: lodSummaries };
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[derived] 失敗:', e && e.stack || e); process.exit(1); });
