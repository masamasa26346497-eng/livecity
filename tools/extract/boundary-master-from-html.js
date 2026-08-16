#!/usr/bin/env node
// tools/extract/boundary-master-from-html.js
// 実行: node tools/extract/boundary-master-from-html.js --area osaka-sumiyoshi --html <path>
//
// Live City本体HTML内に既に存在する TOWN_POLYGONS（町丁目境界ポリゴン、Three.js座標済み）
// から、人口統計処理が必要とする町丁目境界マスタ(administrative-boundaries.json)を生成する。
//
// 【重要な設計判断】TOWN_POLYGONSは過去のセッションで(出典不明の)町丁目境界データから
// 構築されたものであり、境界そのもの(座標)は元々Live City本体に存在する唯一の正本だった。
// 当初は座標の重複保存を避けるため、本マスタには座標を含めず boundaryId のみで参照する
// 設計にしていたが、公式属性データ(コード・名称・人口等)と暫定TOWN_POLYGONSの形状を
// レコード単位で統合する(tools/lib/boundary-master.js の mergeOfficialAttributesWithGeometry)
// 機能を実現するには、暫定側マスタにも実際の座標配列が必要となったため、ここで座標も
// 含めるよう変更した。地図描画自体は依然Live City本体のTOWN_POLYGONSを直接使用し続けており、
// 本マスタの座標はパイプライン側での統合・比較処理専用の機械可読コピーという位置づけである。
//
// 【町丁目コードについて】TOWN_POLYGONSのキー(例:"住吉区我孫子4丁目")には公式町丁目コードが
// 含まれていない。そのため本マスタは当初コード無しで生成され、tools/convert/demographics/index.js
// が人口データ(chochoCode付き)と名称一致した際に、その場でコードを補完する仕組みにする
// （結合の優先順位はコード→正規化名称だが、コード自体がマスタに存在しない初回はやむを得ず
// 名称一致が必須になる。この事実をunmatchedレポートと検証ログに明記する）。
import path from 'path';
import { readFile } from 'fs/promises';
import { writeJson } from '../lib/area.js';
import { normalizeChochoName } from '../lib/chocho-normalize.js';

function parseArgs(argv) {
  const args = { area: null, htmlPath: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
    if (argv[i] === '--html') args.htmlPath = argv[++i];
  }
  return args;
}

/**
 * 区名+町丁目名の結合文字列(例:"住吉区我孫子4丁目")から区名と町丁目名を分離する。
 * 大阪市の区名は2-4文字+「区」で終わる。
 */
function splitWardAndChocho(fullName) {
  const m = fullName.match(/^(.+?区)(.+)$/);
  if (!m) return { ward: null, chochoName: fullName };
  return { ward: m[1], chochoName: m[2] };
}

async function extractTownPolygons(htmlPath) {
  const html = await readFile(htmlPath, 'utf-8');
  const m = html.match(/const TOWN_POLYGONS = (\{.*?\});/s);
  if (!m) throw new Error('TOWN_POLYGONS が見つかりません。Live City本体のHTML構造が変更された可能性があります。');
  return JSON.parse(m[1]);
}

async function main(args) {
  if (!args.area) throw new Error('--area が指定されていません。');
  const htmlPath = args.htmlPath || '/mnt/user-data/outputs/osaka_3d_buildings.html';

  console.log(`=== 境界マスタ抽出: ${args.area} ===`);
  console.log(`参照元: ${htmlPath} 内の TOWN_POLYGONS`);

  const polygons = await extractTownPolygons(htmlPath);
  const keys = Object.keys(polygons);
  console.log(`抽出した町丁目数: ${keys.length}`);

  const master = keys.map((fullChochoName) => {
    const { ward, chochoName } = splitWardAndChocho(fullChochoName);
    const geometry = polygons[fullChochoName] || null;
    return {
      municipalityCode: null, // TOWN_POLYGONS自体には市区町村コードが存在しないため不明
      chochoCode: null, // 人口データとの名称一致時に convert/demographics/index.js が補完する
      chochoName, // 正規化前の正式名称（区名を除いた部分。例: "我孫子4丁目"）
      originalFullName: fullChochoName, // 正規化前の正式名称（区名込み、TOWN_POLYGONSのキーそのもの）
      normalizedChochoName: normalizeChochoName(chochoName),
      ward,
      boundaryId: fullChochoName, // 境界形状(TOWN_POLYGONS)との対応に使う一意なID
      geometry, // Three.js座標系のリング配列(TOWN_POLYGONSの値そのもの)
      hasFullPolygon: !!geometry,
      boundarySource: 'TOWN_POLYGONS (Live City本体HTML埋め込み、出典未確認の旧データから構築)',
      // 【恒久対応】本マスタは正式な行政界データではない。データ自体にこの事実を明示し、
      // コード・メタデータ・README・マニフェストのいずれからも判別できるようにする。
      boundaryDataStatus: 'legacy-unverified',
      boundarySourceType: 'embedded-html-town-polygons',
      officialBoundary: false,
    };
  });

  const outputPath = path.resolve(process.cwd(), 'data', 'raw', args.area, 'administrative-boundaries.json');
  await writeJson(outputPath, master);
  console.log(`境界マスタを生成しました: ${outputPath}`);
  console.log(`件数: ${master.length}`);

  const wardCounts = {};
  for (const m of master) wardCounts[m.ward] = (wardCounts[m.ward] || 0) + 1;
  console.log('区別件数:', JSON.stringify(wardCounts));

  return master;
}

const args = parseArgs(process.argv.slice(2));
main(args).catch((err) => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
