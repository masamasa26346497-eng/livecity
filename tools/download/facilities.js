#!/usr/bin/env node
// tools/download/facilities.js
// 実行: node tools/download/facilities.js --area osaka-sumiyoshi [--force]
//
// OSM Overpass APIから、施設・観光地データを単一クエリで一括取得する(ご指示通り、
// 施設と観光地を別々に取得すると不要なAPIリクエストが増えるため、1回のクエリで取得し、
// 取得後の分類処理(tools/convert/facilities-extended.js)でcategory:"tourism"とその他を
// 振り分ける設計とする)。
//
// 注意: このスクリプトは実際にOverpass APIへネットワーク接続する。
// Claude Codeの隔離環境(ネットワーク無効)では実行できない。
// ネットワーク接続可能なローカルPCまたはCI環境で実行すること。
import path from 'path';
import { existsSync } from 'fs';
import { loadAreaConfig, rawDir, ensureDir, writeJson, readJsonIfExists } from '../lib/area.js';
import { buildOverpassQuery, runOverpassQuery } from '../lib/overpass.js';
import { isMainModule, toProjectRelativePath } from '../lib/paths.js';

// ご指示で列挙された全カテゴリのOSMタグを1つのOverpassクエリへまとめる。
// node/way両方を対象にする(店舗等はnodeで登録されることが多いが、大規模施設はwayの場合もある)。
const FACILITY_OSM_FILTER = [
  // 買い物
  'shop=supermarket', 'shop=convenience', 'shop=chemist', 'shop=mall', 'shop=department_store',
  // 医療
  'amenity=hospital', 'amenity=clinic', 'amenity=dentist', 'amenity=pharmacy', 'healthcare',
  // 教育・子育て
  'amenity=kindergarten', 'amenity=school', 'amenity=college', 'amenity=university', 'amenity=childcare',
  // 公共・生活
  'amenity=townhall', 'amenity=police', 'amenity=fire_station', 'amenity=post_office',
  'amenity=library', 'amenity=community_centre', 'amenity=toilets', 'amenity=bank', 'amenity=atm',
  // 交通
  'public_transport=station', 'public_transport=platform', 'railway=station', 'railway=halt',
  'highway=bus_stop', 'amenity=bicycle_parking', 'amenity=parking', 'amenity=taxi',
  // 公園・運動
  'leisure=park', 'leisure=playground', 'leisure=sports_centre', 'leisure=pitch', 'leisure=garden',
  // 観光
  'tourism=attraction', 'tourism=museum', 'tourism=gallery', 'tourism=viewpoint', 'tourism=information',
  'historic', 'amenity=place_of_worship', 'shop=gift', 'amenity=theatre',
];

/**
 * "shop=supermarket"のような単一条件を、node/way両方のOverpass QL文に展開する。
 * "healthcare"や"historic"のように値を指定しない場合はワイルドカード(タグの存在のみ)とする。
 */
function buildFilterStatements(tagList) {
  const statements = [];
  for (const tag of tagList) {
    const [key, value] = tag.split('=');
    const cond = value ? `["${key}"="${value}"]` : `["${key}"]`;
    statements.push(`node${cond}`);
    statements.push(`way${cond}`);
  }
  return statements.join(';') + ';';
}

function parseArgs(argv) {
  const args = { area: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
    else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

export async function run(args) {
  if (!args.area) throw new Error('--area が指定されていません。');
  const areaConfig = await loadAreaConfig(args.area);

  const outDir = rawDir(args.area);
  await ensureDir(outDir);
  const outPath = path.join(outDir, 'facilities-osm.json');
  const metaPath = outPath.replace(/\.json$/, '.meta.json');

  if (existsSync(outPath) && !args.force) {
    console.log(`[SKIP] facilities-osm: 既存ファイルが存在します (${toProjectRelativePath(outPath)})。--forceで再取得できます。`);
    return { status: 'skipped-exists' };
  }

  const osmFilter = buildFilterStatements(FACILITY_OSM_FILTER);
  const query = buildOverpassQuery(areaConfig.bbox, osmFilter, 90);

  console.log(`=== 施設・観光地データ取得: ${args.area} ===`);
  console.log(`対象bbox: ${JSON.stringify(areaConfig.bbox)}`);

  let usedEndpoint = null;
  const data = await runOverpassQuery(query, {
    onRetry: (attempt, reason) => console.warn(`[RETRY] 試行${attempt}: ${reason}`),
  });

  await writeJson(outPath, data);
  const meta = {
    source: 'OpenStreetMap (Overpass API)',
    downloadedAt: new Date().toISOString(),
    elementCount: (data.elements || []).length,
    bbox: areaConfig.bbox,
    license: 'ODbL 1.0',
    attribution: '© OpenStreetMap contributors',
  };
  await writeJson(metaPath, meta);

  console.log(`[OK] facilities-osm: ${meta.elementCount}件のOSM要素を取得しました。`);
  console.log(`保存先: ${toProjectRelativePath(outPath)}`);

  return { status: 'downloaded', elementCount: meta.elementCount, outPath };
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  run(args).catch((err) => {
    console.error('予期しないエラー:', err.message);
    process.exit(1);
  });
}
