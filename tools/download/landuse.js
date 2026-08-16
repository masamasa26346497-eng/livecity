#!/usr/bin/env node
// tools/download/landuse.js
// 実行: node tools/download/landuse.js --area osaka-sumiyoshi [--force]
//
// OSM Overpass APIから土地利用の面データを取得する。
// クエリが巨大になりタイムアウトするのを避けるため、以下の3群に分けて順に取得し、
// 取得結果を1つの生データファイルへ統合して保存する。
//   1) parking          : amenity=parking (way/relation。nodeは統計用に取得のみ)
//   2) landuse          : leisure=park / landuse=* (recreation_ground, grass, cemetery,
//                         industrial, commercial, retail, construction, railway)
//   3) natural_and_water: natural=wood/scrub/grassland/water, waterway=riverbank
//
// 出力: data/raw/<area>/landuse-osm.json
//   { fetchedAt, area, bbox, groups: { parking: [...elements], landuse: [...], natural_and_water: [...] },
//     stats: { ... } }
//
// 【安全性】すべての群の取得が正常終了するまで、既存の生データファイルは上書きしない。
// 一時ファイルへ書き出し、全群成功後にのみ置換する(部分的な取得結果で既存データを壊さない)。
//
// 注意: このスクリプトは実際にOverpass APIへネットワーク接続する。
// Claude Codeの隔離環境(ネットワーク無効)では実行できない。
// ネットワーク接続可能なローカルPCまたはCI環境で実行すること。
import path from 'path';
import { rename, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { loadAreaConfig, rawDir, ensureDir, readJsonIfExists } from '../lib/area.js';
import { buildOverpassQuery, runOverpassQuery } from '../lib/overpass.js';
import { isMainModule, toProjectRelativePath } from '../lib/paths.js';
import { LANDUSE_QUERY_GROUPS } from '../lib/landuse.js';

const OUTPUT_FILE = 'landuse-osm.json';
const QUERY_TIMEOUT_SEC = 120; // 面データはノード数が多くなりやすいため長めに取る

function parseArgs(argv) {
  const args = { area: null, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--area') args.area = argv[++i] || null;
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`
土地利用(landuse)データの取得

使い方:
  node tools/download/landuse.js --area <areaId> [--force]

オプション:
  --area <areaId>   対象エリアID (例: osaka-sumiyoshi)  ※必須
  --force           既存の生データがあっても再取得する
  --help, -h        このヘルプを表示

取得対象(3群に分けてOverpassへ問い合わせ):
  parking           : amenity=parking
  landuse           : leisure=park, landuse=recreation_ground/grass/cemetery/
                      industrial/commercial/retail/construction/railway
  natural_and_water : natural=wood/scrub/grassland/water, waterway=riverbank

出力:
  data/raw/<areaId>/${OUTPUT_FILE}

次の手順:
  node tools/convert/landuse.js --area <areaId>
`);
}

/** 1つのクエリ群を取得する。 */
async function fetchGroup(groupName, filters, bbox) {
  const osmFilter = filters.join(';');
  const query = buildOverpassQuery(bbox, osmFilter, QUERY_TIMEOUT_SEC);
  console.log(`  [${groupName}] Overpassへ問い合わせ中 (${filters.length}条件)...`);
  const data = await runOverpassQuery(query, {
    onRetry: (attempt, reason) => {
      console.warn(`  [${groupName}] 再試行 ${attempt} 回目 (${reason})`);
    },
  });
  const elements = Array.isArray(data.elements) ? data.elements : [];
  const counts = { node: 0, way: 0, relation: 0 };
  for (const el of elements) {
    if (counts[el.type] !== undefined) counts[el.type]++;
  }
  console.log(
    `  [${groupName}] 取得: 計${elements.length}要素 (way ${counts.way} / relation ${counts.relation} / node ${counts.node})`
  );
  return { elements, counts };
}

export async function downloadLanduse({ area, force = false }) {
  if (!area) throw new Error('--area は必須です (例: --area osaka-sumiyoshi)');

  const areaConfig = await loadAreaConfig(area);
  const layer = areaConfig.layers && areaConfig.layers.landuse;
  if (layer && layer.enabled === false) {
    console.log('landuseレイヤーは無効化されています (config/areas/<area>.json の layers.landuse.enabled)');
    return null;
  }

  const outDir = rawDir(area);
  const outPath = path.join(outDir, OUTPUT_FILE);

  if (!force && existsSync(outPath)) {
    const existing = await readJsonIfExists(outPath);
    if (existing) {
      console.log(`既存の生データを再利用します: ${toProjectRelativePath(outPath)}`);
      console.log('  再取得する場合は --force を付けて実行してください。');
      return existing;
    }
  }

  const bbox = areaConfig.bbox;
  console.log(`土地利用データを取得します (area=${area})`);
  console.log(`  bbox: ${bbox.south},${bbox.west},${bbox.north},${bbox.east}`);

  // 3群を順に取得する。1群でも失敗したら例外を投げ、既存ファイルは触らない。
  const groups = {};
  const stats = { byGroup: {}, totalElements: 0 };
  for (const [groupName, filters] of Object.entries(LANDUSE_QUERY_GROUPS)) {
    const { elements, counts } = await fetchGroup(groupName, filters, bbox);
    groups[groupName] = elements;
    stats.byGroup[groupName] = counts;
    stats.totalElements += elements.length;
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    area,
    bbox,
    source: 'osm-overpass',
    queryGroups: Object.keys(LANDUSE_QUERY_GROUPS),
    stats,
    groups,
  };

  // 【安全な置換】一時ファイルへ書いてから rename する。
  // 全群の取得が成功した後にのみ既存ファイルを置き換えるため、途中失敗で既存データが壊れない。
  await ensureDir(outDir);
  const tmpPath = `${outPath}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    await rename(tmpPath, outPath);
  } catch (err) {
    // 失敗時は一時ファイルを片付け、既存ファイルはそのまま残す
    try { await unlink(tmpPath); } catch { /* 一時ファイルが無ければ無視 */ }
    throw err;
  }

  console.log(`\n生データを保存しました: ${toProjectRelativePath(outPath)}`);
  console.log(`  合計 ${stats.totalElements} 要素`);
  console.log('\n次の手順:');
  console.log(`  node tools/convert/landuse.js --area ${area}`);
  return payload;
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.area) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  downloadLanduse(args).catch((err) => {
    console.error(`\n取得に失敗しました: ${err.message}`);
    console.error('既存の生データ・処理済みデータは変更していません。');
    process.exit(1);
  });
}
