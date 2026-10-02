#!/usr/bin/env node
// tools/audit/road-polygon-source-acquisition.js
// [Mission 31D §19-23] road polygon source（道路区域ポリゴン）の取得・import 基盤の準備。
//   Mission31C で polygon coverage ratio = 0（全 ribbon fallback）だったため、
//   道路面の正式 source をどこから・どう取得するかを確定する。
//   ネットワーク不可のため「取得方法・形式・座標系・coverage・推奨アクション」を構造化して出力。
//
//   出力: data/reports/road-polygon-source-acquisition.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const PLATEAU_SOURCES = P('data', 'plateau-sources.json');
const FETCH_PLATEAU = P('tools', 'fetch-plateau.js');
const CONVERT_BLDG = P('tools', 'convert-plateau-buildings.js');
const ROADS_RAW = P('data', 'raw', 'osaka-city', 'roads-osm.json');
const REPORT = P('data', 'reports', 'road-polygon-source-acquisition.json');

function scanRepoForRoadPolygon() {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents; try { ents = fs.readdirSync(resolveProjectPath(dir), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) { if (/tran|road-?area|doro|road-?edge|road-?surface|基盤地図/i.test(e.name)) hits.push(rel + '/'); walk(rel, depth + 1); }
      else if (/(tran|road.?area|road.?edge|rdedg).*\.(gml|geojson|json|fgb|shp)$/i.test(e.name)) hits.push(rel);
    }
  };
  for (const r of ['data/raw', 'data/processed', 'public/map-data']) walk(r, 0);
  return hits;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const repoHits = scanRepoForRoadPolygon();
  let plateauTranConfigured = false;
  try {
    const ps = JSON.parse(fs.readFileSync(PLATEAU_SOURCES, 'utf-8'));
    plateauTranConfigured = !!(ps.patterns && (ps.patterns.tranPattern || ps.patterns.tranPatterns));
  } catch { /* noop */ }

  const sources = [
    {
      priority: 'A', sourceId: 'plateau-tran-road',
      name: 'PLATEAU 交通モデル tran:Road（大阪市 3D 都市モデル）',
      availability: 'not-acquired',
      downloadMethod: 'G空間情報センター CKAN（PLATEAU 大阪市 27100）配布 ZIP 内の *tran*.gml。建物 (bldg) と同一 ZIP または別 ZIP。tools/fetch-plateau.js の CKAN 検索基盤を流用可。',
      format: 'CityGML 2.0 / tran モジュール。LOD1 = 道路縁ポリゴン（TrafficArea / AuxiliaryTrafficArea の gml:Polygon）、LOD0 = 中心線。FlatGeobuf 版が併配される年度もある。',
      coordinateReference: 'JGD2011 / EPSG:6697（緯度経度 + 標高）。tools/lib/projection.js で znorth-neg-v1 へ変換（建物と同じ経路）。',
      coverage: '大阪市 24 区全域（bldg と同一整備事業。coverage は建物 PLATEAU と同等の見込み）',
      geometryType: 'polygon（LOD1 TrafficArea。車道・歩道・交差点を面で保持。交差点の一体面あり）',
      license: 'PLATEAU（政府標準利用規約 2.0・出典明記）。建物 PLATEAU と同条件＝追加ライセンス確認不要',
      expectedPrecision: '±1.0–1.5m（DM 由来）',
      wardCoverageRisk: '低（bldg と同事業）',
      pipelineWork: [
        'data/plateau-sources.json に tranPattern を追加済み（このミッションで実施）。',
        'tools/fetch-plateau.js に --layer tran（isTran 判定 + tran GML 抽出）を追加。既存 bldg 経路は分岐で保護。',
        'tools/convert-plateau-tran.js（新規。convert-plateau-buildings.js の CityGML パーサを流用し TrafficArea polygon を抽出）。',
        'tools/build-canonical-roads.js を polygon-first へ切替（rank2 source として tran polygon を採用、無い区間のみ ribbon fallback）。',
      ],
      recommendedAction: 'ローカル PC で `node tools/fetch-plateau.js --dataset plateau-osaka-tran --city-code 27100 --list` で tran リソースの有無を確認 → 取得できれば data/raw/osaka-city/plateau-tran/ へ保存し 31C2（canonical roads polygon 化）で評価。',
    },
    {
      priority: 'B', sourceId: 'gsi-kiban-road-edge',
      name: '国土地理院 基盤地図情報「道路縁」(RdEdg)',
      availability: 'not-acquired',
      downloadMethod: 'GSI 基盤地図情報ダウンロードサービス（https://fgd.gsi.go.jp/download/）。無償・要アカウント。2次メッシュ単位の JPGIS(GML) を選択ダウンロード。',
      format: 'JPGIS 2.1 GML。RdEdg = 道路縁を表す LineString（左右の縁が別フィーチャ）。RdCompt（道路構成線）も併存。',
      coordinateReference: 'JGD2011（緯度経度）。メッシュ番号で範囲指定。',
      coverage: '大阪市全域（都市計画区域は 1/2500 相当の高精度 DM 由来）',
      geometryType: 'line（道路縁。polygon ではない）— ★ 面生成には左右縁の pairing が必要',
      license: '基盤地図情報 利用規約（測量成果の複製・使用申請は原則不要。出典「国土地理院」明記）',
      expectedPrecision: '±0.5–1.75m（都市計画区域 2500 / それ以外 25000）',
      wardCoverageRisk: '低',
      pipelineWork: [
        'tools/fetch-gsi-kiban.js（新規。手動 DL 前提。DL 済み ZIP を data/raw/osaka-city/gsi-kiban/ へ配置）。',
        'tools/convert-gsi-road-edge.js（新規。RdEdg LineString を読み、左右縁の pairing → 道路区域 polygon 生成）。',
        '★ pairing / 面生成は非自明。中心線（OSM）を軸に左右の最近傍縁を対応付ける処理が必要 → 31C2 の別課題候補。',
      ],
      recommendedAction: 'RdEdg は「縁 line」であり直接 polygon 扱いしない（§21）。PLATEAU tran（priority A・既に面）が取得できればそちらを優先。tran が取れない場合の次善策として RdEdg + pairing を 31C2 で検討。',
    },
    {
      priority: 'C', sourceId: 'osaka-city-road-ledger',
      name: '大阪市 道路台帳附図 GIS / 道路区域',
      availability: 'not-acquired',
      downloadMethod: '大阪市オープンデータポータル / 建設局。道路台帳附図は一部が GIS 公開、道路区域線は開示請求対象のことが多い。',
      format: 'Shapefile / GeoJSON（データにより）。道路区域 polygon または区域界 line。',
      coordinateReference: '平面直角座標系 第VI系（EPSG:6674）が一般的。',
      coverage: '大阪市管理道路（市道）。国道・府道は各管理者（近畿地方整備局 / 大阪府）別',
      geometryType: 'polygon or line（データにより）',
      license: '要確認（CC BY 4.0 のオープンデータ部分と、利用申請が必要な部分が混在）',
      expectedPrecision: '±0.25–0.5m（台帳附図）',
      wardCoverageRisk: '中（国道・府道が別管理者のため市道のみだとカバレッジに穴）',
      pipelineWork: ['取得できた形式に応じて convert ツールを個別作成。', 'polygon なら直接 canonical roads の rank1 source。line なら pairing 要。'],
      recommendedAction: '大阪市オープンデータポータルで「道路」「道路台帳」を検索し公開範囲・ライセンスを確認。priority A/B が取れない場合の補完。',
    },
    {
      priority: 'D', sourceId: 'osm-area-highway',
      name: 'OSM area:highway=* / highway=pedestrian + area=yes',
      availability: 'partial（raw OSM に 0 件・31C で確認済み）',
      downloadMethod: 'Overpass: way["area"="yes"]["highway"] / way["area:highway"]',
      format: 'polygon',
      coordinateReference: 'WGS84',
      coverage: '大阪市: 極低（駅前広場・歩行者空間中心。車道網はほぼ無し）',
      geometryType: 'polygon',
      license: 'ODbL 1.0',
      expectedPrecision: '±3m',
      wardCoverageRisk: '高（車道網カバレッジ不足）',
      pipelineWork: ['Overpass クエリに area:highway を追加。convert/roads.js で area feature を polygon として保持。'],
      recommendedAction: '車道網の面 source にはしない。歩行者空間の補助のみ（§21）。',
    },
  ];

  const report = {
    generatedAt,
    context: 'Mission31C: canonical roads polygonCoverageRatio = 0（全 42,547 feature が OSM centerline + 幅推定の ribbon fallback）。道路面の正式 source を確定する（§19）。',
    repoScan: { roadPolygonArtifacts: repoHits, plateauTranPatternConfigured: plateauTranConfigured },
    currentPipeline: {
      plateauFetcher: { path: toProjectRelativePath(FETCH_PLATEAU), currentScope: 'bldg GML のみ', tranSupport: false, exists: fs.existsSync(FETCH_PLATEAU) },
      plateauBuildingConverter: { path: toProjectRelativePath(CONVERT_BLDG), exists: fs.existsSync(CONVERT_BLDG), reusableForTran: 'CityGML パーサ部分は流用可' },
      osmRoads: { raw: toProjectRelativePath(ROADS_RAW), exists: fs.existsSync(ROADS_RAW), geometry: 'centerline のみ・area:highway 0 件' },
    },
    sources,
    priorityOrder: ['plateau-tran-road (A)', 'gsi-kiban-road-edge (B・pairing 要)', 'osaka-city-road-ledger (C)', 'osm-area-highway (D・補助のみ)'],
    decision: [
      '正式優先: A) PLATEAU tran:Road polygon → B) GSI 道路縁（pairing 後）→ C) 大阪市道路区域 → 取れない場合のみ OSM centerline + width（現 31C の状態を維持）。',
      'このミッション（31D）では config 準備（tranPattern 追加）+ 取得手順の確定まで。実データ取得と canonical roads の polygon 化は 31C2（別段階）。',
      '★ いずれの source も未取得のため canonical roads は 31D 時点でも全 ribbon fallback のまま（§0: 架空の道路区域は生成しない）。',
      'GSI 道路縁は line geometry のため直接 polygon 扱いしない（§21）。左右縁 pairing が必要で、それ自体を 31C2 の課題とする。',
    ],
    nextStep: '31C2（canonical roads polygon 化）: ローカル PC で PLATEAU tran の取得可否を確認 → 取れれば convert-plateau-tran.js を作り build-canonical-roads を polygon-first へ。',
    RESULT: 'AUDIT-DONE',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[road-polygon-source-acquisition] repo 内 road polygon artifact: ' + repoHits.length + ' 件');
  console.log('  plateau tranPattern configured: ' + plateauTranConfigured);
  console.log('  優先: ' + report.priorityOrder.join(' > '));
  console.log('  ★ 31D 時点で polygon source は全て未取得 → canonical roads は ribbon fallback のまま。取得は 31C2。');
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
}

main().catch((e) => { console.error('[road-polygon-source-acquisition] 失敗:', e && e.stack || e); process.exit(1); });
