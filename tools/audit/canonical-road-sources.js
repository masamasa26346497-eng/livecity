#!/usr/bin/env node
// tools/audit/canonical-road-sources.js
// [Mission 31A §12] canonical roads の geometry source 候補の比較レポート。
//   道路を「centerline + 幅」ではなく「道路区域ポリゴン」を正式形状にできる source を整理する。
//   実装はしない（31C）。現状データの計測 + 各 source の素性を構造化して出力。
//   出力: data/reports/canonical-road-source-comparison.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { SOURCE_REGISTRY, SOURCE_PRIORITY } from '../lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
/** レポート JSON を読む（無ければ null）。成果物の有無で「取得済みか」を判定するために使う。 */
function readJson(rel) {
  const p = resolveProjectPath(rel);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}
const ROADS_DIR = P('public', 'map-data', 'osaka-city', 'roads');
const RAW_ROADS = P('data', 'raw', 'osaka-city', 'roads-osm.json');
const REPORT = P('data', 'reports', 'canonical-road-source-comparison.json');

function measureCurrentOsm() {
  const manifest = fs.existsSync(path.join(ROADS_DIR, 'manifest.json'))
    ? JSON.parse(fs.readFileSync(path.join(ROADS_DIR, 'manifest.json'), 'utf-8')) : null;
  const byClass = {};
  let uniqueIds = new Set(), lenTotalM = 0, withNameCount = 0, vertexCount = 0;
  for (const f of (fs.existsSync(ROADS_DIR) ? fs.readdirSync(ROADS_DIR) : [])) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(ROADS_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (ft.kind !== 'line' || !Array.isArray(ft.p)) continue;
      if (uniqueIds.has(ft.id)) continue;
      uniqueIds.add(ft.id);
      byClass[ft.highway || '?'] = (byClass[ft.highway || '?'] || 0) + 1;
      if (ft.name) withNameCount++;
      vertexCount += ft.p.length;
      for (let i = 0; i + 1 < ft.p.length; i++) lenTotalM += Math.hypot(ft.p[i + 1][0] - ft.p[i][0], ft.p[i + 1][1] - ft.p[i][1]);
    }
  }
  return {
    manifestFeatureCount: manifest ? manifest.featureCount : null,
    uniqueFeatureIds: uniqueIds.size,
    tileCount: manifest ? manifest.tileCount : null,
    byClass,
    centerlineLengthKm: +(lenTotalM / 1000).toFixed(1),
    namedFraction: uniqueIds.size ? +(withNameCount / uniqueIds.size).toFixed(3) : 0,
    avgVerticesPerFeature: uniqueIds.size ? +(vertexCount / uniqueIds.size).toFixed(1) : 0,
    sourceWays: manifest && manifest.layerMeta ? manifest.layerMeta.sourceWays : null,
    skipReasons: manifest && manifest.layerMeta ? manifest.layerMeta.skipReasons : null,
    geometryKind: 'centerline (LineString)',
    hasAreaGeometry: false,
  };
}

// [Mission 31C §2] repo 内に PLATEAU tran:Road（交通モデル・道路区域面）データがあるか調査する。
function auditPlateauTran() {
  const roots = ['data/raw', 'data/processed', 'public/map-data'];
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(resolveProjectPath(dir), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) {
        if (/\btran\b|transportation|road-?area|doro|road-?surface/i.test(e.name)) found.push({ path: rel, kind: 'dir' });
        walk(rel, depth + 1);
      } else if (/tran.*\.(gml|json|geojson|fgb)$|road.?area.*\.(json|geojson)$/i.test(e.name)) {
        found.push({ path: rel, kind: 'file' });
      }
    }
  };
  for (const r of roots) walk(r, 0);
  // plateau-sources.json に tran パターンがあるか
  let tranPatternConfigured = false;
  try {
    const ps = JSON.parse(fs.readFileSync(resolveProjectPath('data/plateau-sources.json'), 'utf-8'));
    tranPatternConfigured = !!(ps.patterns && (ps.patterns.tranPattern || ps.patterns.roadPattern));
  } catch { /* noop */ }
  // [31C2] 実際に変換・採用済みかは成果物レポートで判定する（ディレクトリの有無だけでは判断しない）。
  const conv = readJson('data/reports/plateau-tran-conversion.json');
  const cov = readJson('data/reports/plateau-tran-coverage.json');
  const acquired = !!(conv && conv.RESULT === 'CONVERTED');
  return {
    available: acquired,
    artifactsOnDisk: found.length,
    foundArtifacts: found.slice(0, 20),
    fetcherSupport: {
      script: 'tools/fetch-plateau.js --layer tran / tools/extract-plateau-tran.js（配布 ZIP から展開）',
      currentPattern: tranPatternConfigured ? 'bldgPattern + tranPattern' : 'bldgPattern のみ（建物 GML）',
      tranPatternConfigured,
    },
    featureCount: acquired ? (conv.roadSurfacePolygons || 0) : 0,
    geometryType: acquired
      ? 'tran:Road / lod1MultiSurface = 道路区域面（車道＋歩道を含む道路敷地）。実データに TrafficArea の細分はほぼ無い（0.4%）'
      : 'tran:Road（LOD1 = 道路区域ポリゴン）',
    coverage: acquired
      ? `27100 大阪市 2025 CityGML から udx/tran ${conv.stats ? conv.stats.files : '?'} file を展開し ${conv.roadSurfacePolygons} 道路面を変換（invalid 率 ${conv.invalidRate}）`
      : 'repo 内に無し（0）',
    wardCoverage: cov ? `${cov.wardCoverage.wardsWithTran}/${cov.wardCoverage.total} 区（cityCellCoverage ${cov.cityCellCoverage}）` : 'n/a（未計測）',
    roadAreaCoverage: cov ? `${(cov.totalAreaM2 / 1e6).toFixed(2)} km²` : 'n/a（未計測）',
    bridgeTunnel: 'uro:sectionType（高架橋/橋梁/交差部/アンダーパス/トンネル）で構造を判別。トンネルは地表面から除外する。',
    intersectionShape: 'lod1 は交差点を一体面で持つ。ribbon の団子状膨張は polygon 採用で解消（canonical-road-intersection-compare.json）。',
    osmCenterlineConsistency: cov
      ? `centerline サンプルの ${(cov.osmAlignment.insideRatio * 100).toFixed(1)}% が polygon 内側 / 未対応 ${(cov.osmAlignment.unmatchedRatio * 100).toFixed(1)}% / オフセット p50 ${cov.osmAlignment.offsetM.p50}m`
      : 'n/a（未計測）',
    recommendation: acquired
      ? '取得・採用済み（rank2 polygon-first source）。再実行手順は MISSION31C2_RUNBOOK.md。'
      : 'MISSION31C2_RUNBOOK.md の手順で配布 ZIP から展開するか、ローカル PC で fetch-plateau.js --layer tran を実行。',
    status: acquired
      ? 'acquired（canonical roads の polygon-first geometry source として採用済み）'
      : 'not-acquired（sourceMissing。§0 に従い架空の道路区域は生成しない）',
  };
}

async function main() {
  const generatedAt = new Date().toISOString();
  const current = measureCurrentOsm();
  const plateauTran = auditPlateauTran();

  // 各 source 候補の素性（Mission 31A §12 の比較軸）。数値は設計時点の評価・要現地確認。
  const candidates = [
    {
      sourceId: 'official-road-area',
      label: SOURCE_REGISTRY['official-road-area'].label,
      geometryKind: 'road area polygon',
      coverage: '大阪市: 要確認（道路基盤地図情報・大阪市道路台帳GISは区域ポリゴンを持つが一般公開範囲が限定的）',
      precision: '±0.5m 級（公共測量成果）',
      license: '自治体により CC BY / 申請制 / 目的外利用制限などばらつき。要精査',
      updateFrequency: '年次〜数年（道路管理者更新）',
      geometryQuality: '区域ポリゴンとして最も正確。歩道・車道分離あり',
      osakaCoverage: 'unknown（取得可否を 31C で調査）',
      acquisition: 'G空間情報センター / 大阪市オープンデータ / 国土地理院 基盤地図情報(道路縁) を横断調査',
      recommendedRank: 1,
    },
    {
      sourceId: 'plateau-tran-road',
      label: SOURCE_REGISTRY['plateau-tran-road'].label,
      geometryKind: 'tran:Road 面（LOD1 は道路縁ポリゴン）',
      coverage: '大阪市: PLATEAU 3D都市モデルの交通モデルとして整備済み（建物と同じ整備範囲）',
      precision: '±1〜1.5m（DM 由来）',
      license: 'PLATEAU（政府標準利用規約2.0・出典明記）。建物と同条件',
      updateFrequency: 'PLATEAU 更新に追随（数年周期）',
      geometryQuality: '道路縁ポリゴン。交差点の面形状あり。歩道分離は LOD による',
      osakaCoverage: '高い見込み（建物 PLATEAU と同一整備事業）。現状 Live City 未取得',
      acquisition: 'PLATEAU CityGML / FlatGeobuf の tran フォルダ。建物取得パイプラインを流用可',
      recommendedRank: 2,
    },
    {
      sourceId: 'osm-road-centerline',
      label: SOURCE_REGISTRY['osm-road-centerline'].label,
      geometryKind: 'centerline (LineString) + width 推定',
      coverage: '大阪市24区: 高い（' + current.uniqueFeatureIds + ' feature / ' + current.centerlineLengthKm + ' km。Mission26 で高密度化）',
      precision: '±3〜5m（センターライン。幅は width タグ or クラス既定で推定）',
      license: 'ODbL 1.0（既存レイヤーと同条件）',
      updateFrequency: '継続的（コミュニティ編集）',
      geometryQuality: 'centerline は良好だが「区域」ではない。幅推定で面化する必要。交差点の面形状なし',
      osakaCoverage: '実測: ' + current.uniqueFeatureIds + ' 本 / ' + Object.keys(current.byClass).length + ' クラス。source missing = 東淀川区/淀川区北部（Mission31 PBF 範囲）',
      acquisition: '既存 data/raw/osaka-city/roads-osm.json（Overpass）',
      recommendedRank: 3,
    },
    {
      sourceId: 'osm-area-highway',
      label: SOURCE_REGISTRY['osm-area-highway'].label,
      geometryKind: 'area:highway=* / highway=pedestrian + area=yes polygon',
      coverage: '大阪市: 低い（駅前広場・歩行者空間・一部の大型交差点のみ）',
      precision: '±3m',
      license: 'ODbL 1.0',
      updateFrequency: '継続的',
      geometryQuality: '面形状として正確だが車道網カバレッジが極端に低い。補助 source',
      osakaCoverage: '部分的（pedestrian area は現状 ' + (current.byClass.pedestrian || 0) + ' 本の一部）',
      acquisition: 'Overpass: way["area"="yes"]["highway"] / way["area:highway"]',
      recommendedRank: 4,
    },
  ];

  // §3 公的道路区域 source の詳細調査（未取得）。
  const officialSources = [
    { source: '国土地理院 基盤地図情報「道路縁」(RdEdg)', geometryType: '道路縁 LineString → polygon 化要', coverage: '全国', precision: '±0.5–1.75m（都市計画区域 2500 / それ以外 25000）', updateFrequency: '随時', license: '基盤地図情報 利用規約（出典明記・非商用/商用可・申請不要）', osakaCoverage: '大阪市全域あり（DM 由来）', availability: 'not-acquired（GSI ダウンロードサービス・要無償アカウント・ローカル取得）', canonicalPriority: 1 },
    { source: '国土数値情報 道路（N01）/ 高速道路時系列（N06）', geometryType: '道路中心線（polygon でない）', coverage: '全国', precision: '1/25000', updateFrequency: '年次', license: '国土数値情報 利用約款', osakaCoverage: 'あり', availability: 'not-acquired（中心線のみ＝OSM と同種）', canonicalPriority: 4 },
    { source: '大阪市 道路台帳附図 GIS / 道路区域', geometryType: '道路区域 polygon', coverage: '大阪市', precision: '±0.25–0.5m（台帳附図）', updateFrequency: '随時（道路管理者）', license: '要確認（開示請求 / 一部オープンデータ）', osakaCoverage: '大阪市管理道路（国道・府道の一部は別管理者）', availability: 'not-acquired（一般公開範囲が限定的・要調査）', canonicalPriority: 1 },
    { source: '大阪府 / 大阪市 オープンデータ（道路 GIS）', geometryType: 'データにより polygon / line', coverage: '府域 / 市域', precision: '不明', updateFrequency: '不定期', license: 'CC BY 4.0（データにより）', osakaCoverage: '部分的', availability: 'not-acquired（要調査）', canonicalPriority: 2 },
    { source: 'PLATEAU tran:Road（大阪市 3D 都市モデル）', geometryType: 'tran LOD1 道路縁ポリゴン', coverage: 'PLATEAU 整備都市', precision: '±1–1.5m', updateFrequency: 'PLATEAU 更新周期', license: 'PLATEAU（政府標準利用規約2.0）', osakaCoverage: '大阪市全域（bldg と同事業）', availability: 'not-acquired（fetcher が bldg のみ。31D で tran 対応）', canonicalPriority: 2 },
  ];

  const report = {
    generatedAt,
    purpose: 'canonical roads の geometry source（道路区域ポリゴン）候補比較 + PLATEAU tran 監査（§1/§2/§3）。',
    currentOsmCenterline: current,
    plateauTranAudit: plateauTran, // §2
    officialRoadAreaSources: officialSources, // §3
    sourcePriorityDesign: SOURCE_PRIORITY.roads,
    candidates,
    comparisonAxes: ['geometryKind', 'coverage', 'precision', 'license', 'updateFrequency', 'geometryQuality', 'osakaCoverage'],
    availabilitySummary: {
      'official-road-area': 'not-acquired（GSI 道路縁 / 大阪市道路台帳。ローカル取得候補・rank1）',
      'plateau-tran-road': plateauTran.available
        ? `取得済み（${plateauTran.featureCount} 道路面 / ${plateauTran.roadAreaCoverage}）。canonical roads の polygon-first geometry source（rank2）`
        : 'not-acquired（fetcher bldg のみ・rank2 候補）',
      'osm-area-highway': '0 件（raw OSM waterways/roads に area:highway 無し）',
      'osm-road-centerline': `取得済み（${current.uniqueFeatureIds} 本 / ${current.centerlineLengthKm} km）。31C2 以降は geometry ではなく属性（名称・車線数・bridge/tunnel）の PRIMARY source ＋ polygon 非対応区間の ribbon fallback`,
    },
    recommendation: plateauTran.available ? [
      '31C2 結論: PLATEAU tran:Road の道路区域面を取得し polygon-first へ移行済み。canonical roads は polygon 起点 1 枚 = 1 feature で構築され、面の二重計上は構造的に発生しない。',
      'OSM centerline は捨てていない（§0）。geometry を polygon に譲り、属性の PRIMARY source と centerlineRef として残す。',
      '残課題 (a): rank1 の公的道路区域（GSI 基盤地図情報「道路縁」/ 大阪市道路台帳）は未取得。PLATEAU より高精度なら将来差し替える。',
      '残課題 (b): sectionType が市域の 42.7% で「不明」。高架の完全判別には別 source が要る。',
      '残課題 (c): 東淀川区・淀川区・旭区は geometry が埋まったが OSM 属性（名称・車線数）は欠測のまま。広域 PBF 取得と連動。架空生成しない（§0）。',
    ] : [
      '結論: polygon source は 1 件も取得できていない → canonical roads は全 feature が OSM centerline + 幅推定の ribbon fallback（§18）。',
      '(a) 配布 ZIP から tools/extract-plateau-tran.js で展開、または tools/fetch-plateau.js --layer tran でローカル取得、',
      '(b) GSI 基盤地図情報「道路縁」のローカル取得、のいずれかで polygon source を確保する。',
      'source missing（東淀川区/淀川区北部の OSM 道路欠落）は広域 PBF 取得と連動。架空生成しない（§0）。',
    ],
    RESULT: 'AUDIT-DONE',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[canonical-road-sources] 現 OSM centerline: ' + current.uniqueFeatureIds + ' 本 / ' + current.centerlineLengthKm + ' km / area geometry: ' + current.hasAreaGeometry);
  console.log('  PLATEAU tran: available=' + plateauTran.available + ' (' + plateauTran.foundArtifacts.length + ' artifacts) ' + plateauTran.status);
  console.log('  polygon source: ' + (plateauTran.available
    ? 'plateau-tran-road 取得済み → canonical roads は polygon-first'
    : 'なし → canonical roads は全 feature ribbon fallback'));
  console.log('  候補 source: ' + candidates.map((c) => c.sourceId + '(rank' + c.recommendedRank + ')').join(', '));
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
}

main().catch((e) => { console.error('[canonical-road-sources] 失敗:', e && e.stack || e); process.exit(1); });
