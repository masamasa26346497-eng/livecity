#!/usr/bin/env node
'use strict';
/**
 * Mission 37C — Live City テーマ版 Cesium ページ用のレイヤー束を作る。
 *
 * なぜ必要か:
 *   `public/map-data/osaka-city/` は .gitignore されており Vercel には配信されない
 *   （Mission 37B が建物を `public/mission37b-3dtiles/` へ生成してコミットしたのと同じ理由）。
 *   道路・鉄道・水路・公園・ラベルも、POC 範囲だけを切り出してコミット可能な大きさにし、
 *   `public/mission37c-layers/<set>/` へ書き出す。
 *
 * 設計方針（将来の独立レイヤー化に繋げるため）:
 *   - 1 レイヤー = 1 ファイル。形は取得元タイルと同じ `{features:[{id, kind, p, ...}]}` のまま。
 *     将来ライブタイルへ差し替えるときは、ビューア側のローダーだけ変えれば済む。
 *   - 座標は取得元のまま znorth-neg-v1 のローカル m で持つ。投影は**ビューア側で 1 箇所**だけ行う
 *     （Mission 37B と同じ逆変換。定数は変更しない）。
 *   - 既存データは読むだけ。`public/map-data/` へは一切書かない。
 *
 * 使い方:
 *   node tools/mission37c-build-theme-layers.cjs
 *   node tools/mission37c-build-theme-layers.cjs --tx0 -6 --tx1 -4 --tz0 -3 --tz1 -1
 *   node tools/mission37c-build-theme-layers.cjs --set osaka-sumiyoshi-all --tx0 -12 --tx1 2 --tz0 -8 --tz1 4
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'public/map-data/osaka-city');
const DERIVED = path.join(SRC, 'derived');

// Mission 37B と同一。建物タイルの格子（500 m）。
const BUILDING_TILE_SIZE = 500;
// 線が POC 範囲の縁で不自然に途切れないよう、少し外まで取る。
const MARGIN_M = 300;
// 座標の丸め（0.1 m）。ファイルサイズ削減のみが目的で、表示位置は 10 cm 以内でしか動かない。
const COORD_DECIMALS = 1;

const VECTOR_LAYERS = [
  { id: 'roads', dir: 'roads' },
  { id: 'railways', dir: 'railways' },
  { id: 'waterways', dir: 'waterways' },
  { id: 'parks', dir: 'parks' },
];

function parseArgs(argv) {
  const a = { set: 'osaka-sumiyoshi-9tile', tx0: -6, tx1: -4, tz0: -3, tz1: -1, out: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--set') a.set = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (['--tx0', '--tx1', '--tz0', '--tz1'].includes(k)) a[k.slice(2)] = Number(argv[++i]);
    else throw new Error('unknown argument: ' + k);
  }
  for (const k of ['tx0', 'tx1', 'tz0', 'tz1']) {
    if (!Number.isInteger(a[k])) throw new Error('--' + k + ' must be an integer');
  }
  if (a.tx1 < a.tx0 || a.tz1 < a.tz0) throw new Error('tile range is inverted');
  a.out = a.out || path.join(ROOT, 'public/mission37c-layers', a.set);
  return a;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const r1 = (v) => Math.round(v * 10 ** COORD_DECIMALS) / 10 ** COORD_DECIMALS;

/** 建物タイル範囲 → ローカル m の矩形。Mission 37B の選択範囲と同じ式。 */
function localBox(a) {
  return {
    minX: a.tx0 * BUILDING_TILE_SIZE, maxX: (a.tx1 + 1) * BUILDING_TILE_SIZE,
    minZ: a.tz0 * BUILDING_TILE_SIZE, maxZ: (a.tz1 + 1) * BUILDING_TILE_SIZE,
  };
}
const grow = (b, m) => ({ minX: b.minX - m, maxX: b.maxX + m, minZ: b.minZ - m, maxZ: b.maxZ + m });
const inBox = (b, x, z) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;

/**
 * 折れ線を矩形で切る。矩形の中に入っている頂点の連なりごとに切り出し、
 * 境界をまたぐ 1 つ外側の頂点も残す（縁で線が浮かないように）。
 * 2 頂点未満になった断片は捨てる。
 */
function clipLine(points, box) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < points.length; i++) {
    const inside = inBox(box, points[i][0], points[i][1]);
    if (inside) {
      if (!cur) { cur = []; if (i > 0) cur.push(points[i - 1]); } // 入る直前の 1 点
      cur.push(points[i]);
    } else if (cur) {
      cur.push(points[i]); // 出た直後の 1 点
      runs.push(cur); cur = null;
    }
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.length >= 2);
}

/** 2000 m タイルのうち矩形に重なるものを列挙する。 */
function overlappingTiles(manifest, box) {
  const size = manifest.tileSize;
  const out = [];
  for (let tx = Math.floor(box.minX / size); tx <= Math.floor(box.maxX / size); tx++) {
    for (let tz = Math.floor(box.minZ / size); tz <= Math.floor(box.maxZ / size); tz++) {
      out.push({ tx, tz, file: `tile_${tx}_${tz}.json` });
    }
  }
  return out;
}

function buildVectorLayer(layer, box, report) {
  const dir = path.join(SRC, layer.dir);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    report.push({ layer: layer.id, status: 'source-missing', path: path.relative(ROOT, manifestPath) });
    return null;
  }
  const manifest = readJson(manifestPath);
  const tiles = overlappingTiles(manifest, box);
  const seen = new Set();
  const features = [];
  const stats = { sourceTiles: 0, missingTiles: 0, lines: 0, areas: 0, droppedOutside: 0, vertices: 0 };

  for (const t of tiles) {
    const p = path.join(dir, t.file);
    if (!fs.existsSync(p)) { stats.missingTiles++; continue; }
    stats.sourceTiles++;
    for (const f of readJson(p).features || []) {
      // タイル境界の buffer で同じ feature が複数タイルに入るため、id で一度だけ扱う。
      if (!f || !Array.isArray(f.p) || seen.has(f.id)) continue;
      seen.add(f.id);
      const base = {};
      for (const [k, v] of Object.entries(f)) if (k !== 'p') base[k] = v;

      if (f.kind === 'area') {
        // 面は小さいので切らない。1 頂点でも範囲に入っていれば丸ごと採用する。
        if (!f.p.some((pt) => inBox(box, pt[0], pt[1]))) { stats.droppedOutside++; continue; }
        const ring = f.p.map((pt) => [r1(pt[0]), r1(pt[1])]);
        features.push({ ...base, p: ring });
        stats.areas++; stats.vertices += ring.length;
      } else {
        const runs = clipLine(f.p, box);
        if (!runs.length) { stats.droppedOutside++; continue; }
        runs.forEach((run, i) => {
          const line = run.map((pt) => [r1(pt[0]), r1(pt[1])]);
          features.push({ ...base, id: runs.length > 1 ? `${f.id}#${i}` : f.id, p: line });
          stats.lines++; stats.vertices += line.length;
        });
      }
    }
  }
  report.push({ layer: layer.id, status: 'ok', ...stats, features: features.length });
  return {
    layer: layer.id,
    mission: '37C',
    source: path.relative(ROOT, dir).replace(/\\/g, '/'),
    sourceGeneratedAt: manifest.generatedAt || null,
    coordinateConvention: manifest.coordinateConvention || 'znorth-neg-v1',
    coordinateSystem: 'local-meters',
    bboxLocal: box,
    count: features.length,
    features,
  };
}

/**
 * 建物属性のサイドカー。3D Tiles の GLB は canonicalId しか持たないため、
 * 建物情報パネルで高さ・用途を出すにはこれが必要。
 * タイル単位に分けておき、ビューアはクリックされたタイルの分だけ遅延取得する
 * （9 タイル一括 約0.5MB を初回に読ませない）。
 * 値は配列で持つ: [h, usage, repX, repZ, z0]
 */
function buildBuildingAttrs(a, outDir, report) {
  const dir = path.join(SRC, 'buildings', 'osaka-sumiyoshi');
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    report.push({ layer: 'building-attrs', status: 'source-missing', path: path.relative(ROOT, manifestPath) });
    return null;
  }
  const srcManifest = readJson(manifestPath);
  const attrDir = path.join(outDir, 'attrs');
  fs.mkdirSync(attrDir, { recursive: true });
  const tiles = [];
  let buildings = 0, bytes = 0;
  for (let tx = a.tx0; tx <= a.tx1; tx++) {
    for (let tz = a.tz0; tz <= a.tz1; tz++) {
      const p = path.join(dir, `tile_${tx}_${tz}.json`);
      if (!fs.existsSync(p)) { tiles.push({ tx, tz, status: 'missing' }); continue; }
      const byId = {};
      let n = 0;
      for (const b of readJson(p).buildings || []) {
        if (!b || !b.id) continue;
        byId[b.id] = [r1(b.h || 0), b.usage || null, r1(b.repX || 0), r1(b.repZ || 0), r1(b.z0 || 0)];
        n++;
      }
      const file = `t_${tx}_${tz}.json`;
      const payload = { tx, tz, count: n, fields: ['h', 'usage', 'repX', 'repZ', 'z0'], byId };
      fs.writeFileSync(path.join(attrDir, file), JSON.stringify(payload));
      const size = fs.statSync(path.join(attrDir, file)).size;
      tiles.push({ tx, tz, file: 'attrs/' + file, count: n, bytes: size });
      buildings += n; bytes += size;
    }
  }
  report.push({ layer: 'building-attrs', status: 'ok', tiles: tiles.length, buildings, bytes });
  return {
    ward: srcManifest.ward || null, wardId: srcManifest.wardId || null, wardCode: srcManifest.wardCode || null,
    lod: srcManifest.lod != null ? srcManifest.lod : null,
    sourceGeneratedAt: srcManifest.generatedAt || null,
    buildings, bytes, tiles,
  };
}

/** ラベル（主要駅・地名・公園・区名）。目立たせる対象を絞るため importance をそのまま持つ。 */
function buildLabelLayer(box, report) {
  const out = { layer: 'labels', mission: '37C', coordinateConvention: 'znorth-neg-v1', coordinateSystem: 'local-meters', bboxLocal: box, sources: {}, items: [] };
  const push = (kind, id, name, x, z, extra) => {
    if (!name || !Number.isFinite(x) || !Number.isFinite(z) || !inBox(box, x, z)) return false;
    out.items.push({ kind, id, name, x: r1(x), z: r1(z), ...extra });
    return true;
  };
  const tally = {};

  const stationsPath = path.join(DERIVED, 'rail-stations.json');
  if (fs.existsSync(stationsPath)) {
    const j = readJson(stationsPath);
    out.sources.stations = 'derived/rail-stations.json';
    tally.station = (j.stations || []).filter((s) => Array.isArray(s.point)
      && push('station', s.stationId, s.name, s.point[0], s.point[1], { importance: 'major' })).length;
  }
  const placesPath = path.join(DERIVED, 'place-labels.json');
  if (fs.existsSync(placesPath)) {
    const j = readJson(placesPath);
    out.sources.places = 'derived/place-labels.json';
    tally.place = (j.places || []).filter((p) => push('place', p.id, p.name, p.x, p.z,
      { importance: p.importance || 'local', placeType: p.placeType || null, rank: p.rank || null })).length;
  }
  const anchorsPath = path.join(DERIVED, 'map-label-anchors.json');
  if (fs.existsSync(anchorsPath)) {
    const j = readJson(anchorsPath);
    out.sources.anchors = 'derived/map-label-anchors.json';
    tally.park = (j.parks || []).filter((p) => push('park', p.id, p.name, p.x, p.z,
      { importance: p.importance || 'local', areaM2: p.areaM2 || null })).length;
    tally.ward = (j.wards || []).filter((w) => push('ward', w.id, w.name, w.x, w.z,
      { importance: 'major', wardId: w.wardId || null })).length;
  }
  out.count = out.items.length;
  out.countsByKind = tally;
  report.push({ layer: 'labels', status: out.count ? 'ok' : 'empty', features: out.count, byKind: tally });
  return out;
}

function main() {
  const a = parseArgs(process.argv);
  const box = grow(localBox(a), MARGIN_M);
  const report = [];
  fs.mkdirSync(a.out, { recursive: true });

  const written = [];
  for (const layer of VECTOR_LAYERS) {
    const data = buildVectorLayer(layer, box, report);
    if (!data) continue;
    const file = layer.id + '.json';
    fs.writeFileSync(path.join(a.out, file), JSON.stringify(data));
    written.push({ layer: layer.id, file, count: data.count, bytes: fs.statSync(path.join(a.out, file)).size });
  }
  const labels = buildLabelLayer(box, report);
  fs.writeFileSync(path.join(a.out, 'labels.json'), JSON.stringify(labels));
  written.push({ layer: 'labels', file: 'labels.json', count: labels.count, bytes: fs.statSync(path.join(a.out, 'labels.json')).size });

  const attrs = buildBuildingAttrs(a, a.out, report);
  const usagePath = path.join(ROOT, 'config/building-usage-labels.json');
  const usageLabels = fs.existsSync(usagePath) ? readJson(usagePath) : null;

  const manifest = {
    mission: '37C',
    set: a.set,
    generatedAt: new Date().toISOString(),
    note: 'Live City テーマ版 Cesium ページ用のレイヤー束。public/map-data は .gitignore で配信されないため、POC 範囲だけを切り出して配信可能にしたもの。',
    buildingTileRange: { tx0: a.tx0, tx1: a.tx1, tz0: a.tz0, tz1: a.tz1, tileSize: BUILDING_TILE_SIZE },
    bboxLocal: box,
    marginM: MARGIN_M,
    coordinateConvention: 'znorth-neg-v1',
    coordinateSystem: 'local-meters',
    // ビューアは必ずこの定数で投影する。Mission 37B / geoToThree() と同一で、ここでは変更しない。
    projection: { clat: 34.604208, clon: 135.525020, metersPerDegree: 111320, note: 'lon = clon + x/(cos(clat)*mpd), lat = clat - z/mpd' },
    coordDecimals: COORD_DECIMALS,
    layers: written,
    // 建物は Mission 37B が生成した 3D Tiles をそのまま使う（再生成も改変もしない）。
    buildings: {
      tileset: 'mission37b-3dtiles/' + a.set + '/tileset.json',
      note: 'Mission 37B の生成物を参照するだけ。canonicalId 体系・GLB は変更しない。',
      ...(attrs || { status: 'source-missing' }),
    },
    usageLabels: usageLabels ? { source: usageLabels.source, labels: usageLabels.labels } : null,
    buildStats: report,
  };
  fs.writeFileSync(path.join(a.out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const total = written.reduce((s, w) => s + w.bytes, 0);
  console.log('[37C] out ' + path.relative(ROOT, a.out).replace(/\\/g, '/'));
  for (const w of written) console.log('  ' + w.layer.padEnd(10) + String(w.count).padStart(7) + ' features  ' + (w.bytes / 1024).toFixed(0).padStart(6) + ' KB');
  console.log('  ' + 'total'.padEnd(10) + ' '.repeat(16) + (total / 1024).toFixed(0).padStart(6) + ' KB');
  for (const r of report) if (r.status !== 'ok') console.log('  ! ' + JSON.stringify(r));
}

if (require.main === module) main();
module.exports = { clipLine, localBox, grow, inBox, overlappingTiles, BUILDING_TILE_SIZE, MARGIN_M };
