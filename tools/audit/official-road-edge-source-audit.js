#!/usr/bin/env node
// tools/audit/official-road-edge-source-audit.js
// [Mission 31G-FIX14] Official Road Edge Source Acquisition Audit。
//
//   目的: 大阪市の実道路縁・車道境界データ（authoritative source）を調査し、
//   Canonical Road Visual Surface（FIX13 refined-road-surface.json）への正式接続可否を決定する。
//
//   ★ 本スクリプトは「取得済みデータの計測」ではない（このサンドボックスは bash からの
//     ネットワークダウンロードが不可 — CLAUDE.md「実行環境の分離」参照）。
//     WebSearch/WebFetch（Claude Code 側のツール。bash sandbox とは別経路）で 2026-09-11 に
//     一次情報（国土地理院・大阪市・G空間情報センター等の公式ページ）を調査し、その結果を
//     構造化して記録するのみ。実 geometry のダウンロード・座標変換・重畳計測は行っていない
//     （§7 sample alignment・§8 幹線道路比較・§9 official width 計測は実施不能 → NOT_PERFORMED）。
//
//   前身: tools/audit/road-polygon-source-acquisition.js（31D。当時はネットワーク調査も不可で
//     一般知識ベースの記録だった）。本 audit はその B/C 候補を実地確認し、新候補 C2 を追加する。
//
//   出力: data/reports/official-road-edge-source-audit.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const REPORT = P('data', 'reports', 'official-road-edge-source-audit.json');
const PLATEAU_TRAN_SAMPLE = P('data', 'raw', 'plateau', 'osaka-city', 'tran', '51357289_tran_6697_op.gml');

function currentPlateauVintage() {
  try {
    const g = fs.readFileSync(PLATEAU_TRAN_SAMPLE, 'utf-8');
    const m = g.match(/core:creationDate>([^<]+)</);
    return m ? m[1] : null;
  } catch { return null; }
}

async function main() {
  const generatedAt = new Date().toISOString();
  const researchDate = '2026-09-11';

  // ── A: 国土地理院 基盤地図情報 道路縁（RdEdg）──
  const gsiKiban = {
    id: 'gsi-kiban-road-edge', label: 'A. 国土地理院 基盤地図情報「道路縁」(RdEdg)',
    provider: '国土交通省 国土地理院（GSI）',
    datasetName: '基盤地図情報 基本項目（道路縁 RdEdg）',
    acquisitionMethod: '基盤地図情報ダウンロードサービス（https://service.gsi.go.jp/kiban/）。要ユーザー登録・ログイン。2次メッシュ単位で JPGIS(GML)/SHP を選択ダウンロード。無償。',
    crs: 'JGD2000 または JGD2011（緯度経度）。znorth-neg-v1 への変換は tools/lib/projection.js の経路を流用可（PLATEAU と同じ変換段）。',
    geometryType: 'line（道路縁 = 道路と道路以外の境界を表す LineString。polygon ではない）',
    geometryNote: '「道路縁」は名称通り境界線。車道と歩道の区別は道路縁だけでは付かない（§3: road boundary ≠ carriageway edge。歩道と車道の間に別途「道路区域界」等が無い限り、道路縁のみでは車道/歩道を分離できない）。面化には対向する縁同士の pairing が必要（§11・非自明）。',
    coverage: '整備範囲は都市計画区域（全国 約10万km²のうち約8万km²）＝ 大阪市は都市計画区域内のため対象。都市計画区域内は縮尺1/2,500相当、区域外は1/25,000相当の精度で整備。',
    precisionClass: '公開ページからは A1/A2/B/C1/C2 等の精度区分の大阪市内訳は確認できず（問い合わせ窓口への個別照会が必要）。1/2,500相当という位置付けのみ確認。',
    expectedPositionalAccuracyM: '概ね 1〜2m オーダー（1/2,500地形図の標準精度からの推定。精度区分未確認のため確定値ではない）',
    updateFrequency: '基本項目は年4回（1月・4月・7月・10月）更新',
    updateDate: '継続更新中（最新版は四半期更新で取得時点のもの）',
    license: '国土地理院コンテンツ利用規約。商用利用可・出典明記必須（編集・加工時は加工した旨も明記）。「測量成果の複製又は使用」に該当する利用形態では測量法に基づく別申請が必要になる場合がある、との記載あり（具体的にどの利用形態が該当するかは今回未確認）。',
    commercialUse: '許容（出典表示を条件に商用利用可、と国土地理院コンテンツ利用規約に明記）。ただし測量法上の複製・使用申請要否は本調査では未確定（要個別照会）。',
    redistributionPermission: '編集・加工後の再配布は出典＋加工内容の明記で可（コンテンツ利用規約の一般原則）。',
    apiOrDownload: 'download（API 無し。基盤地図情報ダウンロードサービスからの手動/バッチ取得）',
    fileFormat: 'JPGIS 2.1 (GML) / SHP',
    sources: [
      'https://web1.gsi.go.jp/kiban/syurui.html',
      'https://www.gsi.go.jp/kiban/faq.html',
      'https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html',
      'https://service.gsi.go.jp/kiban/',
    ],
    verifiedByDownload: false,
    assessment: '最有力候補。全国統一 authoritative source・大阪市全域を高精度区分でカバー・商用利用可（出典明記）。ただし line geometry のため polygon 化に pairing 実装が必要、精度区分の内訳と測量法申請要否の最終確認は個別照会が必要。今回は未取得・未検証。',
  };

  // ── B: 大阪市 道路台帳 ──
  const osakaLedger = {
    id: 'osaka-city-road-ledger', label: 'B. 大阪市 道路台帳',
    provider: '大阪市 建設局 総務部 管財課',
    datasetName: '道路台帳平面図（位置・路線名・現況平面図・幅員・延長・舗装種別等）',
    acquisitionMethod: '① Web 閲覧: 「マップナビおおさか」地図情報サイトで市道の位置・路線名・現況平面図を閲覧可能（無許可 scraping は行わない・§5）。② 窓口: 建設局総務部管財課で閲覧・写しの交付（対面/郵送）。',
    crs: '不明（公式ページに記載なし）',
    geometryType: '不明（Web 閲覧のみ確認。ダウンロード可能な GIS ファイル形式の言及なし）',
    coverage: '大阪市が管理する市道（国道・府道は別管理者＝近畿地方整備局・大阪府）',
    precisionClass: '不明',
    expectedPositionalAccuracyM: '不明（台帳図面ベースなら高精度の可能性があるが未確認）',
    updateFrequency: '不明',
    updateDate: '不明',
    license: '不明（GIS ダウンロード提供の記載自体が無いため評価不能）',
    commercialUse: '不明',
    redistributionPermission: '不明',
    apiOrDownload: 'download不可・API不可（確認できた範囲では Web 閲覧サイトと窓口対応のみ。オープンデータとしての GIS 公開は確認できず）',
    fileFormat: 'N/A（GIS ファイル配布は未確認）',
    sources: [
      'https://www.city.osaka.lg.jp/kensetsu/page/0000370589.html',
      'https://www.city.osaka.lg.jp/toshikeikaku/page/0000250227.html（マップナビおおさかオープンデータ一覧・道路台帳データ自体は非掲載）',
    ],
    verifiedByDownload: false,
    assessment: '道路台帳そのものは GIS オープンデータとして提供されていない（Web 閲覧 + 窓口対応のみ）。採用不可（§18 のうち「Web閲覧のみ」に該当・download/API/オープンデータいずれも不可と確認）。',
  };

  // ── C2: 大阪市地形図（構造化データ）── 31D 未収載の新候補。道路台帳そのものではないが、
  //     大阪市自身が整備する実測ベース地図に「道路区画ポリゴン」層を含む。
  const osakaTopoMap = {
    id: 'osaka-city-topo-map', label: 'C2. 大阪市地形図（構造化データ_ESRI Shapefile）※新規発見・31D 未収載',
    provider: '大阪市 + 一般財団法人道路管理センター（著作権共有）',
    datasetName: '大阪市地形図（構造化データ）R06年度版等（G空間情報センター配布）',
    acquisitionMethod: 'G空間情報センター（https://www.geospatial.jp/ckan/dataset/r06-esri-shapefile 等）からレイヤー別 ZIP を個別ダウンロード。無償・登録不要の様子（要確認）。',
    crs: 'JGD2011 平面直角座標系（系番号は個別ファイルで要確認。大阪市は第VI系 EPSG:6674 相当と推定）',
    geometryType: 'polygon（8 レイヤーのうち「道路区画ポリゴン」が該当候補。ただし「道路縁」「歩道」の名称を持つ専用レイヤーは確認できず、車道/歩道の区分が道路区画ポリゴン単体でどこまで付くかは未確認）',
    coverage: '大阪市全域（H30〜R06年度まで複数年度あり・最新は R06=2024年度）',
    precisionClass: '「公共測量成果」との記載あり（詳細な精度区分は個別ファイルの仕様書に記載、今回未取得）',
    expectedPositionalAccuracyM: '不明（公共測量成果ベースのため GSI 基盤地図情報と同等〜それ以上の可能性はあるが未検証）',
    updateFrequency: '年度更新（H30・R01・R02・R03・R04・R05・R06 が個別データセットとして存在。継続整備中）',
    updateDate: '最新 R06年度（2024年度）',
    license: '独自利用規約。著作権は大阪市および一般財団法人道路管理センターに帰属。測量法（第43条・第44条）に基づく手続きが必要な場合があり、「測量成果ワンストップサービス」での承認申請が案内されている。',
    commercialUse: '不明・要申請の可能性が高い（測量法上の複製・使用申請プロセスが明記されており、単純な「無条件オープンデータ」ではない）。§16 の基準（利用条件が不明なら採用しない）に照らし、現時点では採用条件を満たさない。',
    redistributionPermission: '不明（要問い合わせ）',
    apiOrDownload: 'download（レイヤー別 ZIP・211KB〜52.6MB）。API 無し。',
    fileFormat: 'ESRI Shapefile（DM/DXF/MXD/PDF 版も別データセットで存在）',
    sources: [
      'https://www.geospatial.jp/ckan/dataset/r06-esri-shapefile',
      'https://www.geospatial.jp/ckan/dataset/r05-esri-shapefile',
    ],
    verifiedByDownload: false,
    assessment: '新規発見の有力候補（大阪市自身が整備する実測地図・道路区画ポリゴンを含む）。ただし測量法上の申請要否が未解決のため、§16「利用条件が不明なら採用しない」により今回は不採用。取得手続き（測量成果ワンストップサービスでの申請）を確認できれば次ミッションの検討対象。',
  };

  // ── D: 大阪府オープンデータ ──
  const osakaPref = {
    id: 'osaka-pref-opendata', label: 'D. 大阪府オープンデータ／地図情報システム',
    provider: '大阪府',
    datasetName: '大阪府地図情報システム（都市計画道路・地形図・土砂災害警戒区域等の Web 閲覧）',
    acquisitionMethod: 'Web 閲覧のみ確認。ダウンロード機能の記載なし。',
    crs: '不明', geometryType: '不明（Web 閲覧のみ）',
    coverage: '都市計画道路等は閲覧可能。道路縁・道路区域の GIS ファイル配布は未確認。',
    precisionClass: '不明', expectedPositionalAccuracyM: '不明', updateFrequency: '不明', updateDate: '不明',
    license: '不明', commercialUse: '不明', redistributionPermission: '不明',
    apiOrDownload: 'download不可・API不可（Web 閲覧システムのみ確認）', fileFormat: 'N/A',
    sources: ['https://www.pref.osaka.lg.jp/o130030/jigyokanri/cals/tizu.html'],
    verifiedByDownload: false,
    assessment: '道路縁 GIS データの配布は確認できず。採用対象外。',
  };

  // ── E: 国土数値情報（MLIT）道路データ ──
  const ksjRoad = {
    id: 'mlit-ksj-road', label: 'E. 国土数値情報（MLIT）道路データセット（N01 等）',
    provider: '国土交通省',
    datasetName: '国土数値情報 道路データ（N01）／ 道路密度・道路延長メッシュデータ（N04）等',
    acquisitionMethod: '国土数値情報ダウンロードサービス（https://nlftp.mlit.go.jp/ksj/）。都道府県別に無償ダウンロード。',
    crs: 'JGD2000/JGD2011', geometryType: 'line（centerline。幅員は「3m以上／3m未満」の 2 区分属性のみ）',
    coverage: '全国（都道府県単位）',
    precisionClass: '広域統計用途の簡略データ（1/25,000 地形図ベースに近い粒度と推定）',
    expectedPositionalAccuracyM: '数m〜十数mオーダーと推定（既存 OSM centerline より粗い可能性が高い）',
    updateFrequency: '不定期改定（データセットにより異なる）',
    updateDate: '不明（データセットにより異なる）',
    license: '国土数値情報 利用規約（多くは商用利用・二次利用可、出典明記）',
    commercialUse: '概ね可（規約は利用規約ページで個別確認要）',
    redistributionPermission: '概ね可（出典明記条件）',
    apiOrDownload: 'download（API 無し）', fileFormat: 'Shapefile / JPGIS(GML) / GeoJSON',
    sources: ['https://nlftp.mlit.go.jp/ksj/', 'https://nlftp.mlit.go.jp/ksj/gmlold/datalist/gmlold_KsjTmplt-N01.html'],
    verifiedByDownload: false,
    assessment: 'centerline + 幅員 2 区分（3m以上/未満）のみで、FIX13 が既に持つ OSM centerline+lanes/width より情報量が少ない。carriageway 精密化には使えない。不採用。',
  };

  // ── F: PLATEAU 追加道路データ（新しい年度の再取得）──
  const plateauVintage = currentPlateauVintage();
  const plateauUpdate = {
    id: 'plateau-newer-vintage', label: 'F. PLATEAU 大阪市（新しい年度の再取得）',
    provider: '国土交通省 都市局（Project PLATEAU） / 社会基盤情報流通推進協議会',
    datasetName: '3D都市モデル（Project PLATEAU）大阪市（2024年度）',
    acquisitionMethod: 'G空間情報センター CKAN（plateau-27100-osaka-shi-2024）。既存 tools/fetch-plateau.js の CKAN 経路を再利用可能。',
    crs: 'EPSG:6697（既存 PLATEAU 取得と同一）',
    geometryType: 'tran モジュール（LOD1 道路区域 polygon。標準製品仕様書 v4 ベースのため LOD2 植生等の記述はあるが、tran:TrafficArea の収録率が向上しているかは今回未確認）',
    coverage: '大阪市全域',
    precisionClass: '既存取得分と同じ空中写真測量ベースと推定',
    expectedPositionalAccuracyM: '既存 PLATEAU（FIX10/11 で ±1.0-1.5m 相当と評価済み）と同等の見込み',
    updateFrequency: '年度更新（PLATEAU は整備年度ごとに新規データセット）',
    updateDate: '2024年度（2024FY）',
    license: 'PLATEAU 標準利用規約（政府標準利用規約 2.0 準拠・商用利用可・出典明記）。既存 bldg/tran と同条件。',
    commercialUse: '可（既存取得分と同条件）',
    redistributionPermission: '可（出典明記条件）',
    apiOrDownload: 'download（CKAN 経由）', fileFormat: 'CityGML 2.0 / 3D Tiles',
    localVintage: { creationDate: plateauVintage, note: plateauVintage ? ('現在ローカルに取得済みの tran GML は creationDate=' + plateauVintage + '（令和4年度＝2022年度相当・uro 3.2 スキーマ）。2024年度版はそれより 2 年度新しい。') : '現在の tran GML の creationDate 取得失敗' },
    sources: [
      'https://www.geospatial.jp/ckan/dataset/plateau-27100-osaka-shi-2024',
      'https://www.mlit.go.jp/plateau/',
    ],
    verifiedByDownload: false,
    assessment: '道路縁 source そのものではないが、現行 PLATEAU（2022年度取得）より新しい 2024年度版が存在。TrafficArea 収録率向上の有無は未確認のため、道路面精密化への寄与は不明。「road edge データ」の代替にはならない（依然 lod1 道路区域 polygon が主）。将来的な PLATEAU ベースライン更新ミッションの候補として記録のみ。',
  };

  const sources = [gsiKiban, osakaLedger, osakaTopoMap, osakaPref, ksjRoad, plateauUpdate];
  const usableSources = [];   // 実地検証で「採用可能」と確定したもの = 0 件（今回 §7-9 のサンプル検証を実施できていない）
  const rejectedSources = sources.filter((s) => /採用対象外|不採用|採用不可/.test(s.assessment)).map((s) => s.id);
  const pendingSources = sources.filter((s) => !rejectedSources.includes(s.id)).map((s) => s.id);

  const report = {
    generatedAt,
    researchDate,
    context: 'Mission 31G-FIX14: FIX12/FIX13 で Road Visual Surface を精密化したが、幹線道路では PLATEAU 道路区域が依然実舗装より広い（F_SOURCE_DIFFERENCE）。official road edge の acquisition 可否を確定する。',
    method: 'WebSearch/WebFetch（Claude Code 側ツール。bash sandbox ネットワーク不可とは別経路）による一次情報調査。実 geometry のダウンロード・座標変換・重畳計測（§7/§8/§9）は本セッションでは実施不能。',
    sourcesChecked: sources.map((s) => ({ id: s.id, label: s.label, provider: s.provider })),
    usableSources,
    rejectedSources,
    pendingFurtherVerification: pendingSources,
    coverage: Object.fromEntries(sources.map((s) => [s.id, s.coverage])),
    license: Object.fromEntries(sources.map((s) => [s.id, s.license])),
    commercialUse: Object.fromEntries(sources.map((s) => [s.id, s.commercialUse])),
    geometryType: Object.fromEntries(sources.map((s) => [s.id, s.geometryType])),
    accuracy: Object.fromEntries(sources.map((s) => [s.id, s.expectedPositionalAccuracyM])),
    updateFrequency: Object.fromEntries(sources.map((s) => [s.id, s.updateFrequency])),
    sampleResults: 'NOT_PERFORMED — 実 geometry を取得できないため §7 sample alignment（edge-to-edge distance / road width / building overlap / intersection continuity）は実施不能。usableSources が確定した後、ローカル PC での取得後に別ミッションで実施する。',
    majorRoadWidths: 'NOT_PERFORMED — 同上の理由により official width と PLATEAU/FIX13/OSM lanes の比較は実施不能。FIX13 §24-10 の PLATEAU polygon vs OSM lanes 比較（既存データのみ）を参照。',
    sourceDetail: sources,
    recommendedSource: {
      primary: 'gsi-kiban-road-edge',
      reason: '全国統一 authoritative・商用利用可（出典明記）・大阪市全域を高精度区分でカバー・更新頻度も明確（四半期）。line geometry の pairing 実装が唯一の技術的ハードル。',
      secondary: 'osaka-city-topo-map（測量法申請プロセスを確認できれば）',
      note: 'いずれも本セッションでは未取得・未検証。ローカル PC でのアカウント登録・ダウンロード・pairing 実装・sample alignment 検証が次の実務ステップ。',
    },
    adoptionDecision: 'OFFICIAL_SOURCE_NOT_USABLE',
    adoptionDecisionNote: '候補 source は複数存在する（特に GSI 基盤地図情報 道路縁）が、本セッションはネットワークダウンロード不可のため実 geometry を取得・検証できず、§17 の採用条件（geometry precision 実測比較・building alignment 改善実証等）を満たすか判定不能。「source が存在しない」のではなく「本セッションでは acquisition・検証ができない」ことを明記する。FIX13 を正式 baseline として維持する。',
    integrationDesignCreated: false,
    fix13GeometryUnchanged: true,
    canonicalRoadSourceGeometryUnchanged: true,
    buildingGeometryUnchanged: true,
    RESULT: 'OFFICIAL_SOURCE_NOT_USABLE',
  };

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[official-road-edge-source-audit] sources checked: ' + sources.length);
  console.log('  usable(採用確定): ' + usableSources.length + '  rejected(不採用): ' + rejectedSources.length + '  pending(要ローカルPC検証): ' + pendingSources.length);
  console.log('  recommended primary: ' + report.recommendedSource.primary);
  console.log('  ADOPTION DECISION: ' + report.adoptionDecision);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[official-road-edge-source-audit] 失敗:', e && e.stack || e); process.exit(1); });
