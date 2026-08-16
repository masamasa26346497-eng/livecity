#!/usr/bin/env node
// tools/convert/landuse.js
// 実行: node tools/convert/landuse.js --area osaka-sumiyoshi
//
// data/raw/<area>/landuse-osm.json (Overpass生データ) を読み込み、
// LiveCityのローカル座標系(x,z)へ変換して data/processed/<area>/landuse.json を出力する。
//
// 座標変換は tools/lib/projection.js の geoToLocal を使う。これは既存HTML内の geoToThree() と
// 完全に同一の式であり、建物(BLDGS)・道路(OSM_ROADS)・公園(OSM_PARKS)と同じ座標系になる。
//
// 出力形式(将来のMultiPolygon対応を見据えた正式構造):
//   [
//     {
//       id: "way/123456",
//       osmType: "way" | "relation",
//       category: "parking" | "park" | "grass" | "cemetery" | "industrial" |
//                 "commercial" | "construction" | "railway" | "wood" | "water",
//       subtype: "parking_surface" | "leisure_park" | ... ,
//       priority: 1..4,
//       duplicateWithExistingParkLayer: true | false,  // 既存 parks.json と重複するか
//       tags: { ...OSMの元タグ },
//       polygons: [
//         { outer: [[x,z], ...], holes: [ [[x,z], ...], ... ] }
//       ]
//     },
//     ...
//   ]
//
// 【安全性】変換が正常終了するまで既存の processed ファイルを上書きしない(一時ファイル経由で置換)。
// 【注意】amenity=parking の「点(node)」は面レイヤーには使わない。除外件数のみ統計に残す。
import path from 'path';
import { rename, unlink, writeFile } from 'fs/promises';
import { loadAreaConfig, rawDir, processedDir, ensureDir, readJsonIfExists } from '../lib/area.js';
import { convertCoordsArray } from '../lib/projection.js';
import { isMainModule, toProjectRelativePath } from '../lib/paths.js';
import { classifyLanduse, isDuplicateWithExistingParkLayer } from '../lib/landuse.js';

const INPUT_FILE = 'landuse-osm.json';
const OUTPUT_FILE = 'landuse.json';
const MIN_RING_POINTS = 4; // 閉じたリングとして成立する最小点数(始点と終点が同一なので実質3頂点)

function parseArgs(argv) {
  const args = { area: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--area') args.area = argv[++i] || null;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`
土地利用(landuse)データの座標変換

使い方:
  node tools/convert/landuse.js --area <areaId>

オプション:
  --area <areaId>   対象エリアID (例: osaka-sumiyoshi)  ※必須
  --help, -h        このヘルプを表示

入力:
  data/raw/<areaId>/${INPUT_FILE}   ※先に tools/download/landuse.js を実行しておくこと

出力:
  data/processed/<areaId>/${OUTPUT_FILE}
`);
}

/** [{lat,lon},...] 形式のOverpass geometry を [[lon,lat],...] へ直す(convertCoordsArrayの入力形式に合わせる)。 */
function geometryToLonLat(geometry) {
  const out = [];
  for (const g of geometry) {
    // Overpassは欠損ノードを null で返すことがある(bbox境界の切れ端など)
    if (!g || typeof g.lat !== 'number' || typeof g.lon !== 'number') return null;
    out.push([g.lon, g.lat]);
  }
  return out;
}

/** リングが閉じているか(始点と終点が一致するか)。閉じていなければ閉じる。 */
function closeRing(points) {
  if (points.length < 3) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const isClosed = first[0] === last[0] && first[1] === last[1];
  return isClosed ? points : [...points, [first[0], first[1]]];
}

/**
 * relation の members から outer/inner のリング群を組み立てる。
 * OSMのmultipolygon relationは、outer/inner の way が複数の断片に分かれていることがあるため、
 * 端点をつなぎ合わせてリングを構成する(way-stitching)。
 * つなぎ合わせられない断片は「不完全」として安全にスキップする(例外を投げない)。
 */
function assembleRings(members, role) {
  const segments = [];
  for (const m of members) {
    if (m.type !== 'way') continue;
    if ((m.role || 'outer') !== role) continue;
    if (!Array.isArray(m.geometry)) continue; // geometryが無いメンバーはスキップ
    const pts = geometryToLonLat(m.geometry);
    if (!pts || pts.length < 2) continue;     // 欠損ノードを含む断片はスキップ
    segments.push(pts);
  }
  if (!segments.length) return [];

  const rings = [];
  const used = new Array(segments.length).fill(false);
  const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let ring = [...segments[i]];

    // 端点が一致する断片を繰り返し連結する
    let extended = true;
    while (extended) {
      extended = false;
      const tail = ring[ring.length - 1];
      const head = ring[0];
      if (samePoint(head, tail)) break; // 既に閉じている

      for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue;
        const seg = segments[j];
        const segHead = seg[0];
        const segTail = seg[seg.length - 1];

        if (samePoint(tail, segHead)) {
          ring = ring.concat(seg.slice(1));
          used[j] = true; extended = true; break;
        }
        if (samePoint(tail, segTail)) {
          ring = ring.concat([...seg].reverse().slice(1));
          used[j] = true; extended = true; break;
        }
        if (samePoint(head, segTail)) {
          ring = seg.slice(0, -1).concat(ring);
          used[j] = true; extended = true; break;
        }
        if (samePoint(head, segHead)) {
          ring = [...seg].reverse().slice(0, -1).concat(ring);
          used[j] = true; extended = true; break;
        }
      }
    }

    const closed = closeRing(ring);
    // 閉じられない/点数不足のリングは不完全として捨てる(1件の破損で全体を止めない)
    if (closed && closed.length >= MIN_RING_POINTS) rings.push(closed);
  }
  return rings;
}

/** 単純な多角形の符号付き面積(リングの内外判定・穴の割り当てに使う)。 */
function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** 点がリングの内部にあるか(レイキャスティング)。穴をどのouterに割り当てるかの判定に使う。 */
function pointInRing(pt, ring) {
  let inside = false;
  const [px, py] = pt;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** OSM要素1件 → Landuseレコード(正式構造)。対象外・不完全なら null。 */
export function convertElement(el, projection) {
  if (!el || !el.tags) return null;
  const cls = classifyLanduse(el.tags);
  if (!cls) return null; // 対象タグでない

  // 点(node)は面レイヤーには使わない。呼び出し側で統計に計上する。
  if (el.type === 'node') return null;

  let polygons = [];

  if (el.type === 'way') {
    if (!Array.isArray(el.geometry)) return null;
    const lonlat = geometryToLonLat(el.geometry);
    if (!lonlat) return null; // 欠損ノードを含む → 安全にスキップ
    const closed = closeRing(lonlat);
    if (!closed || closed.length < MIN_RING_POINTS) return null; // 閉じられない → スキップ
    polygons = [{ outer: convertCoordsArray(closed, projection), holes: [] }];
  } else if (el.type === 'relation') {
    if (!Array.isArray(el.members)) return null;
    const outerRings = assembleRings(el.members, 'outer');
    const innerRings = assembleRings(el.members, 'inner');
    if (!outerRings.length) return null; // outerが1つも組み立てられない → 不完全relationとしてスキップ

    // 各 inner(穴) を、それを含む outer へ割り当てる。
    // どのouterにも含まれない不整合なinnerは捨てる(描画を壊さないため)。
    polygons = outerRings.map((outer) => ({ outerLonLat: outer, holesLonLat: [] }));
    for (const inner of innerRings) {
      const probe = inner[0];
      // 面積が小さいouterを優先して割り当てる(入れ子のouterがある場合に最も内側へ入れる)
      const candidates = polygons
        .map((p, idx) => ({ idx, area: Math.abs(ringArea(p.outerLonLat)) }))
        .filter(({ idx }) => pointInRing(probe, polygons[idx].outerLonLat))
        .sort((a, b) => a.area - b.area);
      if (candidates.length) polygons[candidates[0].idx].holesLonLat.push(inner);
    }
    polygons = polygons.map((p) => ({
      outer: convertCoordsArray(p.outerLonLat, projection),
      holes: p.holesLonLat.map((h) => convertCoordsArray(h, projection)),
    }));
  } else {
    return null;
  }

  if (!polygons.length) return null;

  return {
    id: `${el.type}/${el.id}`,
    osmType: el.type,
    category: cls.category,
    subtype: cls.subtype,
    priority: cls.priority,
    duplicateWithExistingParkLayer: isDuplicateWithExistingParkLayer(cls.subtype),
    tags: el.tags,
    polygons,
  };
}

export async function convertLanduse({ area }) {
  if (!area) throw new Error('--area は必須です (例: --area osaka-sumiyoshi)');

  const areaConfig = await loadAreaConfig(area);
  const projection = areaConfig.projection;

  const inPath = path.join(rawDir(area), INPUT_FILE);
  const raw = await readJsonIfExists(inPath);
  if (!raw) {
    throw new Error(
      `生データが見つかりません: ${toProjectRelativePath(inPath)}\n` +
        `  先に次を実行してください: node tools/download/landuse.js --area ${area}`
    );
  }

  const groups = raw.groups || {};
  const stats = {
    input: { total: 0, way: 0, relation: 0, node: 0 },
    output: { total: 0, polygons: 0, holes: 0 },
    excluded: { parkingNodes: 0, notTargetTag: 0, incompleteGeometry: 0 },
    byCategory: {},
    bySubtype: {},
    duplicateWithExistingParkLayer: 0,
  };

  const records = [];
  const seen = new Set(); // 群をまたいで同一要素が返ることがあるためID重複を除く

  for (const [, elements] of Object.entries(groups)) {
    if (!Array.isArray(elements)) continue;
    for (const el of elements) {
      stats.input.total++;
      if (stats.input[el.type] !== undefined) stats.input[el.type]++;

      // 点の駐車場は面レイヤーに使わないが、件数は残す
      if (el.type === 'node') {
        if (el.tags && el.tags.amenity === 'parking') stats.excluded.parkingNodes++;
        else stats.excluded.notTargetTag++;
        continue;
      }

      const key = `${el.type}/${el.id}`;
      if (seen.has(key)) continue;

      if (!el.tags || !classifyLanduse(el.tags)) {
        stats.excluded.notTargetTag++;
        continue;
      }

      const rec = convertElement(el, projection);
      if (!rec) {
        // タグは対象だがジオメトリが不完全(欠損ノード・閉じないリング・outerなしrelation)
        stats.excluded.incompleteGeometry++;
        continue;
      }

      seen.add(key);
      records.push(rec);

      stats.output.total++;
      stats.output.polygons += rec.polygons.length;
      stats.output.holes += rec.polygons.reduce((s, p) => s + p.holes.length, 0);
      stats.byCategory[rec.category] = (stats.byCategory[rec.category] || 0) + 1;
      stats.bySubtype[rec.subtype] = (stats.bySubtype[rec.subtype] || 0) + 1;
      if (rec.duplicateWithExistingParkLayer) stats.duplicateWithExistingParkLayer++;
    }
  }

  // 【安全な置換】一時ファイルへ書いてから rename する。
  const outDir = processedDir(area);
  const outPath = path.join(outDir, OUTPUT_FILE);
  await ensureDir(outDir);
  const tmpPath = `${outPath}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(records, null, 2), 'utf-8');
    await rename(tmpPath, outPath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* 無ければ無視 */ }
    throw err;
  }

  // ── 結果レポート ──
  console.log(`\n変換しました: ${toProjectRelativePath(outPath)}`);
  console.log(`\n入力: 計${stats.input.total}要素 (way ${stats.input.way} / relation ${stats.input.relation} / node ${stats.input.node})`);
  console.log(`出力: ${stats.output.total}件 (polygon ${stats.output.polygons} / 穴(inner ring) ${stats.output.holes})`);
  console.log(`\n除外:`);
  console.log(`  amenity=parking の点(面レイヤー対象外): ${stats.excluded.parkingNodes}件`);
  console.log(`  対象外タグ                            : ${stats.excluded.notTargetTag}件`);
  console.log(`  ジオメトリ不完全(安全にスキップ)      : ${stats.excluded.incompleteGeometry}件`);
  console.log(`\nカテゴリ別:`);
  for (const [c, n] of Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(14)} ${String(n).padStart(5)}件`);
  }
  console.log(`\nサブタイプ別:`);
  for (const [s, n] of Object.entries(stats.bySubtype).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(28)} ${String(n).padStart(5)}件`);
  }
  console.log(`\n既存ParkLayer(parks.json)と重複: ${stats.duplicateWithExistingParkLayer}件`);
  console.log(`  → duplicateWithExistingParkLayer:true を付与済み。描画時に重複除外できる。`);

  return { records, stats, outPath };
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.area) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  convertLanduse(args).catch((err) => {
    console.error(`\n変換に失敗しました: ${err.message}`);
    console.error('既存の処理済みデータは変更していません。');
    process.exit(1);
  });
}
