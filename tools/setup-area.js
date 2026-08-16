#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/setup-area.js — 行政区追加の全自動パイプライン
// ══════════════════════════════════════════════════════════════
// 参照点取得 → 原点推定 → coordinate-config.json生成 → CityGML変換 → タイル生成
// までを1コマンドで実行する。手作業の座標入力は一切不要。
//
// 使い方:
//   # 初回（原点較正を含む）
//   node tools/setup-area.js --dataset osaka-higashisumiyoshi --ward 東住吉区 \
//     --citygml data/source/osaka-higashisumiyoshi
//
//   # 2区目以降（原点は都市共通のため較正済みなら自動スキップ）
//   node tools/setup-area.js --dataset osaka-abeno --ward 阿倍野区 \
//     --citygml data/source/osaka-abeno
//
//   # 原点を再較正する場合
//   node tools/setup-area.js ... --recalibrate
//
// 重要な設計判断:
//   ローカル座標系は「都市共通の単一原点」であるため、原点較正は都市ごとに1回でよい。
//   区が増えるたびの較正・手入力は不要で、2区目以降は変換とタイル生成のみが走る。

// ── ES Module形式（package.jsonの "type": "module" に対応）──
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyWardConsistency, wardNameFor, resolvePreferredPath, dataPaths } from './lib/path-config.js';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      a[k] = v;
    }
  }
  return a;
}
function run(script, args, label) {
  console.log('\n──[' + label + ']── node ' + script + ' ' + args.join(' '));
  execFileSync('node', [script, ...args], { stdio: 'inherit' });
}

const args = parseArgs(process.argv.slice(2));
const { dataset } = args;
// 区名は --ward 指定が無ければ data/plateau-sources.json の wards.{区コード}.name から補完する
let ward = args.ward;
if (!ward && args['ward-code']) {
  const name = wardNameFor(String(args['ward-code']), args.sources || 'data/plateau-sources.json');
  if (name) { ward = name; console.log('区名を対応表から補完:', ward, '(' + args['ward-code'] + ')'); }
}

// ── 区名と区コードの整合性検証（誤った組み合わせを処理前に拒否）──
// 例: 東住吉区=27121 / 東淀川区=27114。「東住吉区+27114」のような不一致はここで停止する。
if (args['ward-code']) {
  const chk = verifyWardConsistency(ward, String(args['ward-code']), args.sources || 'data/plateau-sources.json');
  if (!chk.ok) {
    console.error('══ 区名と区コードの不一致 ══');
    console.error('  ' + chk.message);
    console.error('  処理を開始しません。--ward と --ward-code を正しい組み合わせにしてください。');
    process.exit(5);
  }
  if (!ward && chk.expectedName) ward = chk.expectedName;
  console.log('区名・区コード整合:', chk.message);
}
if (!ward && args['ward-code']) {
  ward = '区コード' + args['ward-code'];
  console.log('区名が対応表にないためコードで代替:', ward);
}
let { citygml } = args;
// ── STEP 0: PLATEAU CityGMLの自動取得 ──
// --citygml 未指定なら data/raw/{dataset} を既定の配置先とし、未取得なら fetch-plateau.js で取得する。
// --ward-code（例 東住吉区=27121）があれば市単位ZIPから当該区のGMLだけを抽出する。
if (!citygml && dataset) {
  // 入力GML: 明示 → LIVECITY_DATA_ROOT → 旧data/raw（警告のみ、--prefer-legacyで優先）
  const r = resolvePreferredPath('raw', args, dataset);
  citygml = r.path;
  if (r.legacyWarning) {
    console.warn('⚠ 旧パスにデータを検出:', r.legacyWarning);
    console.warn('  データルートを優先します:', citygml, '（旧パスを使うには --prefer-legacy）');
  }
  const hasGml = fs.existsSync(citygml) && fs.readdirSync(citygml).some(f => /\.gml$/i.test(f));
  // 既存rawが別の区コードで抽出されていないか検証（誤った27114データを東住吉区として再利用しない）
  const rawMetaPath = path.join(citygml, '.ward-code');
  if (hasGml && args['ward-code'] && fs.existsSync(rawMetaPath)) {
    const rawWardCode = fs.readFileSync(rawMetaPath, 'utf8').trim();
    if (rawWardCode && rawWardCode !== String(args['ward-code'])) {
      console.error('══ 既存CityGMLの区コードが一致しません ══');
      console.error('  ' + citygml + ' は区コード ' + rawWardCode + ' (' + (wardNameFor(rawWardCode) || '不明') + ') で抽出されています。');
      console.error('  今回の指定: ' + args['ward-code'] + ' (' + (wardNameFor(String(args['ward-code'])) || '不明') + ')');
      console.error('  誤区分データの可能性があります。別datasetを使うか、正しい区コードで再取得してください。');
      process.exit(7);
    }
  }
  if (!hasGml) {
    if (!args['ward-code'] && !args.url && !args['city-code']) {
      console.error('CityGMLが未取得です。次のいずれかを指定してください:');
      console.error('  --ward-code 27121        … 区コードから自動取得（東住吉区=27121。推奨）');
      console.error('  --url <zip url>          … 配布ZIPを直接指定');
      console.error('  --citygml <path>         … 手元のGMLを使用');
      process.exit(1);
    }
    const fetchArgs = ['--dataset', dataset, '--out', citygml];
    if (args['ward-code']) fetchArgs.push('--ward-code', String(args['ward-code']));
    if (args['city-code']) fetchArgs.push('--city-code', String(args['city-code']));
    if (typeof args.url === 'string') fetchArgs.push('--url', args.url);
    if (args['keep-archive']) fetchArgs.push('--keep-archive');
    run('tools/fetch-plateau.js', fetchArgs, 'STEP0 PLATEAU CityGML取得');
    // 取得した区コードを記録（次回の誤再利用検出用）
    if (args['ward-code']) { try { fs.writeFileSync(rawMetaPath, String(args['ward-code'])); } catch (e) {} }
  } else {
    console.log('══ STEP0 スキップ（取得済みCityGMLを使用）:', citygml, '══');
  }
}

if (!dataset || !ward || !citygml) {
  console.error('usage: node tools/setup-area.js --dataset <id> --ward <区名> [--ward-code 27121 | --citygml <gml|dir> | --url <zip>] [--recalibrate] [--refs-limit 60] [--skip-overlays]');
  process.exit(1);
}
// ── 座標設定は「都市ごと」に持つ（全国展開時に他都市の原点を誤用しないため）──
// 区コード27121(東住吉区) → 市コード27100 → data/buildings/27100/coordinate-config.json
// 旧構成（data/buildings/coordinate-config.json）が存在する場合はそれを引き継ぐ（後方互換）。
const wardCode = args['ward-code'] ? String(args['ward-code']) : null;
const cityCode = String(args['city-code'] || (wardCode ? wardCode.slice(0, 3) + '00' : '')) || null;
const LEGACY_CONFIG = 'data/buildings/coordinate-config.json';
const CONFIG = args.config
  || (cityCode ? path.join('data/buildings', cityCode, 'coordinate-config.json') : LEGACY_CONFIG);
if (!args.config && cityCode && !fs.existsSync(CONFIG) && fs.existsSync(LEGACY_CONFIG)) {
  // 旧配置のconfigを都市ディレクトリへ移行（初回のみ・内容は変更しない）
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.copyFileSync(LEGACY_CONFIG, CONFIG);
  console.log('既存の座標設定を都市別配置へ移行:', LEGACY_CONFIG, '→', CONFIG);
}
const REFS = args.refs || path.join(path.dirname(CONFIG), 'references.auto.json');
const REPORT = path.join(path.dirname(CONFIG), 'origin-estimation-report.json');
// 大容量の中間物はデータルート優先。旧data/配下に既存があれば警告のみ（--prefer-legacyで優先）。
// 完成タイルはブラウザが直接読むため public/data/buildings に置く（配信用の実体）。
const rProc = resolvePreferredPath('processed', args, dataset);
const PROCESSED = rProc.path;
if (rProc.legacyWarning) console.warn('⚠ 旧processedを検出（未使用）:', rProc.legacyWarning, '→ 使用:', PROCESSED);
const OUTDIR = `public/data/buildings/${dataset}`; // 配信先（維持）
fs.mkdirSync(path.dirname(PROCESSED), { recursive: true });

// ── STEP 1-3: 原点較正（都市で1回のみ。既存configがあればスキップ）──
if (args.recalibrate || !fs.existsSync(CONFIG)) {
  console.log('══ 原点較正を実行します（都市共通・初回のみ） ══');
  // 新規都市（既存の局所座標データが無い）は原点を定義するだけでよい。
  // 既存都市（大阪）は埋め込みデータから参照点を取得して原点を逆推定する。
  if (typeof args['define-origin'] === 'string') {
    run('tools/estimate-origin.js',
      ['--define-origin', String(args['define-origin']), '--emit-config', CONFIG]
        .concat(String(args['define-origin']) === 'auto' ? ['--from-citygml', citygml] : [])
        .concat(cityCode ? ['--city-code', cityCode] : [])
        .concat(args.city ? ['--city', args.city] : []),
      'STEP1-3 原点の定義（新規都市）');
  } else {
  const refArgs = ['--html', args['html-ref'] || 'public/osaka_3d_buildings.html',
    '--out', REFS, '--limit', String(args['refs-limit'] || 60)];
  if (args.landuse) refArgs.push('--landuse', args.landuse); // 任意入力（存在すれば併用）
  run('tools/fetch-osm-references.js', refArgs, 'STEP1 参照点の自動取得(OSM)');
  run('tools/estimate-origin.js',
    ['--refs', REFS, '--out', REPORT, '--emit-config', CONFIG]
      .concat(cityCode ? ['--city-code', cityCode] : []),
    'STEP2-3 原点推定 → coordinate-config.json 自動生成');
  }
} else {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  // 他都市のconfigを誤って使わないための照合（全国展開時の事故防止）
  if (cityCode && cfg.cityCode && String(cfg.cityCode) !== cityCode) {
    console.error('══ 座標設定の都市が一致しません ══');
    console.error('  設定ファイル:', CONFIG, '(cityCode=' + cfg.cityCode + ')');
    console.error('  今回の対象  : cityCode=' + cityCode);
    console.error('別都市の原点で変換すると建物が誤った位置に配置されます。');
    console.error('  --config で正しい設定を指定するか、--define-origin <緯度,経度> で新規に定義してください。');
    process.exit(3);
  }
  console.log('══ 原点較正はスキップ（この都市の既存configを使用） ══');
  console.log('  ' + CONFIG + ' : 系' + cfg.jprectZone + ' / 原点E=' + cfg.localOrigin.projectedE +
    ' N=' + cfg.localOrigin.projectedN + ' / 残差' + (cfg.calibration ? cfg.calibration.maxResidualM + 'm' : '-'));
}

// ── STEP 4: CityGML → JSONLチャンク（低メモリ逐次変換）──
// 変換は1ファイルずつストリーム処理し、GML単位でatomicなJSONLチャンクを作る。
// 途中停止しても同じコマンドの再実行で続きから処理される（--restart で最初から）。
// STEP5がチャンクを直接読むため --keep-work でチャンクを残す。互換用に正規化JSONも出力。
const rCp = resolvePreferredPath('checkpoint', args, dataset);
const WORKDIR = rCp.path;
if (rCp.legacyWarning) console.warn('⚠ 旧checkpointを検出（未使用）:', rCp.legacyWarning, '→ 使用:', WORKDIR);
const CHUNKS = path.join(WORKDIR, 'chunks');
const convertArgs = ['--input', citygml, '--dataset', dataset, '--ward', ward,
  '--coordinate-config', CONFIG, '--output', PROCESSED, '--work-dir', WORKDIR, '--keep-work',
  ...(args['ward-code'] ? ['--ward-code', String(args['ward-code'])] : []),
  '--html-ref', args['html-ref'] || 'public/osaka_3d_buildings.html'];
if (args.restart) convertArgs.push('--restart');
if (args.force) convertArgs.push('--force');
run('tools/convert-plateau-buildings.js', convertArgs, 'STEP4 CityGML変換（低メモリ逐次処理）');

// ── STEP 5: タイル生成（convertのJSONLチャンクをストリーム読み＝低メモリ）──
// 巨大な中間JSONを介さず、チャンクから直接タイルへ振り分ける。上位manifestへ自動登録＝HTML変更不要。
run('tools/split-building-tiles.js',
  ['--jsonl-dir', CHUNKS, '--dataset', dataset, '--ward', ward, '--output', OUTDIR]
    .concat(args['ward-code'] ? ['--ward-code', String(args['ward-code'])] : []),
  'STEP5 タイル生成 + manifest登録（低メモリ）');

// STEP5成功後、変換の作業チャンクは不要（正規化JSONは互換用に残す）。cleanup候補として案内。
console.log('（クリーンアップ候補: node tools/cleanup-data.js --dataset ' + dataset + ' --dry-run）');

// ── STEP 6: オーバーレイ（道路・公園・学校・駐車場・河川・墓地・神社・寺院）──
// 建物manifestのboundsから取得範囲を自動決定するため、STEP5の後に実行する。
// 区ごとの特別処理は無く、datasetIdだけで動作する。--skip-overlays で省略可。
if (!args['skip-overlays']) {
  try {
    run('tools/fetch-overlays.js',
      ['--dataset', dataset, '--coordinate-config', CONFIG]
        .concat(args.endpoint ? ['--endpoint', args.endpoint] : []),
      'STEP6 オーバーレイ取得');
  } catch (e) {
    console.warn('[setup-area] オーバーレイ取得に失敗しました（建物データは生成済みです）。');
    console.warn('  後から次を実行できます: node tools/fetch-overlays.js --dataset ' + dataset);
  }
} else {
  console.log('\n──[STEP6]── --skip-overlays 指定のためオーバーレイ取得を省略');
}

console.log('\n══ 完了: ' + ward + ' (' + dataset + ') ══');
console.log('HTMLの変更は不要です（BuildingTileLayerが上位manifestから自動登録）。');
console.log('次: ブラウザで区境と表示を確認 → tools/measure-render-performance.js で性能計測');
console.log('（オーバーレイのみ再取得する場合: node tools/fetch-overlays.js --dataset ' + dataset + '）');
