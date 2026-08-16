#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/run-tests.js
// ══════════════════════════════════════════════════════════════
// パイプラインの回帰テスト。合成GMLを生成し、変換→タイル生成を通して
// 不具合修正（BuildingPart誤検出/failed残留/統計復元/件数整合）を検証する。
// ネットワーク・実PLATEAUデータ不要。終了コードで成否を返す。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const TMP = path.join(os.tmpdir(), 'livecity-test-' + Date.now());
const CFG = path.join(TMP, 'cfg.json');
const SOURCES = path.join(TMP, 'plateau-sources.json'); // テスト用の自己生成設定（本番data/に依存しない）
let pass = 0, fail = 0;
// 子プロセスのログからANSIエスケープを除去してから判定する
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }
function check(name, cond, detail) {
  if (cond) { console.log('  ✓', name); pass++; }
  else { console.log('  ✗', name, detail ? '— ' + detail : ''); fail++; }
}
function run(args) {
  const out = execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return stripAnsi(out);
}

// 合成GML生成: 通常Building + BuildingPart内包 + Installation(ノイズ)
function makeGml(seed, count, opts = {}) {
  let g = '<?xml version="1.0"?><core:CityModel xmlns:bldg="b" xmlns:gml="g" xmlns:core="c" xmlns:gen="n">';
  for (let i = 0; i < count; i++) {
    const la = 34.62 + i * 0.0001, lo = 135.52 + i * 0.0001;
    const ring = `${la.toFixed(6)} ${lo.toFixed(6)} 0 ${(la + 0.0002).toFixed(6)} ${lo.toFixed(6)} 0 ${(la + 0.0002).toFixed(6)} ${(lo + 0.0003).toFixed(6)} 0 ${la.toFixed(6)} ${lo.toFixed(6)} 0`;
    const fp = `<bldg:lod0FootPrint><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>${ring}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod0FootPrint>`;
    let inner = `<bldg:measuredHeight uom="m">${10 + (i % 20)}</bldg:measuredHeight>${fp}`;
    if (opts.withPart && i === 0) {
      // BuildingPartを内包（親Buildingとして1棟に数えるべき）
      inner += `<bldg:consistsOfBuildingPart><bldg:BuildingPart gml:id="${seed}_${i}_part">${fp}</bldg:BuildingPart></bldg:consistsOfBuildingPart>`;
    }
    g += `<core:cityObjectMember><bldg:Building gml:id="${seed}_${i}">${inner}</bldg:Building></core:cityObjectMember>`;
    if (opts.withNoise && i === 0) {
      g += `<core:cityObjectMember><bldg:BuildingInstallation gml:id="${seed}_inst">noise</bldg:BuildingInstallation></core:cityObjectMember>`;
    }
  }
  return g + '</core:CityModel>';
}

function setup() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify({
    version: 1, city: 'test', cityCode: '27100', coordinateMode: 'geographic-jprect',
    jprectZone: 6, axisOrder: 'lat lon', localOrigin: { projectedE: -45000, projectedN: -154000 },
    axisMapping: { sceneXSign: 1, sceneZSign: -1 }, unit: 'meter', tileSize: 500
  }));
  // テスト用の区コード対応表を自己生成（本番 data/plateau-sources.json に依存しない）
  fs.writeFileSync(SOURCES, JSON.stringify({
    version: 1,
    patterns: { gmlPatterns: ['\\.gml$'], bldgPatterns: ['bldg'] },
    cities: { '27100': { name: '大阪市', url: null } },
    wards: {
      '27121': { name: '東住吉区', cityCode: '27100', url: null },
      '27114': { name: '東淀川区', cityCode: '27100', url: null }
    }
  }, null, 1));
}
function cleanup() { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }

// ── テスト1: BuildingPart誤検出しないこと ──
function testBuildingPart() {
  console.log('\n[テスト1] BuildingPart/Installationを親Buildingとして誤検出しない');
  const dir = path.join(TMP, 't1'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.gml'), makeGml('A', 3, { withPart: true, withNoise: true }));
  const out = path.join(TMP, 't1.json'); const work = path.join(TMP, 't1-work');
  run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't1', '--ward', 'テスト',
    '--coordinate-config', CFG, '--output', out, '--work-dir', work]);
  const arr = JSON.parse(fs.readFileSync(out, 'utf8'));
  // 3棟のBuildingのみ（BuildingPart/Installationを数えない）
  check('Building 3棟のみ抽出', arr.length === 3, '実際=' + arr.length);
  check('IDにpart/instを含まない', !arr.some(b => /part|inst/.test(b.id)), JSON.stringify(arr.map(b => b.id)));
}

// ── テスト2: failed残留の解消と統計復元 ──
function testResumeFailedAndStats() {
  console.log('\n[テスト2] 失敗→原因解消→再開でfailed削除・統計正確・最終JSON生成・終了コード0');
  const dir = path.join(TMP, 't2'); fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, 'f' + i + '.gml'), makeGml('S' + i, 100));
  // f2 を閉じタグ不足の壊れGMLにして失敗を誘発（再帰検索の対象になるファイル）
  fs.writeFileSync(path.join(dir, 'f2.gml'), '<root><bldg:Building gml:id="broken">no close tag');
  const out = path.join(TMP, 't2.json'); const work = path.join(TMP, 't2-work');
  let code1 = 0;
  try {
    run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't2', '--ward', 'テスト',
      '--coordinate-config', CFG, '--output', out, '--work-dir', work, '--keep-work']);
  } catch (e) { code1 = e.status; }
  check('1回目は失敗（終了コード≠0）', code1 !== 0, 'code=' + code1);
  const prog1 = JSON.parse(fs.readFileSync(path.join(work, 'progress.json'), 'utf8'));
  check('failedにf2記録', prog1.failed.some(f => /f2/.test(f.file)));
  check('1回目は最終JSON未生成', !fs.existsSync(out));
  const stat1 = prog1.stats.output;

  // 原因解消して再実行
  fs.rmSync(path.join(dir, 'f2.gml'));
  fs.writeFileSync(path.join(dir, 'f2.gml'), makeGml('S2', 100));
  let code2 = 0;
  try {
    run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't2', '--ward', 'テスト',
      '--coordinate-config', CFG, '--output', out, '--work-dir', work, '--keep-work']);
  } catch (e) { code2 = e.status; }
  check('2回目は成功（終了コード0）', code2 === 0, 'code=' + code2);
  const prog2 = JSON.parse(fs.readFileSync(path.join(work, 'progress.json'), 'utf8'));
  check('failedが空になった', prog2.failed.length === 0, JSON.stringify(prog2.failed));
  check('doneKeysに全4ファイル', prog2.doneKeys.length === 4, '実際=' + prog2.doneKeys.length);
  check('最終JSON生成', fs.existsSync(out));
  const arr = JSON.parse(fs.readFileSync(out, 'utf8'));
  check('統計output(400)と最終JSON件数一致', arr.length === 400 && prog2.stats.output === 400,
    'json=' + arr.length + ' stats=' + prog2.stats.output);
  check('3リスト整合(done∩failed=空)', !prog2.doneKeys.some(k => prog2.failed.map(f => f.file).includes(k)));
}

// ── テスト3: 変換→タイル生成の件数整合 ──
function testTilePipeline() {
  console.log('\n[テスト3] 変換→タイル生成で件数完全整合');
  const dir = path.join(TMP, 't3'); fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, 'g' + i + '.gml'), makeGml('T' + i, 200));
  const out = path.join(TMP, 't3.json'); const work = path.join(TMP, 't3-work');
  run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't3', '--ward', 'テスト',
    '--coordinate-config', CFG, '--output', out, '--work-dir', work, '--keep-work']);
  const arr = JSON.parse(fs.readFileSync(out, 'utf8'));
  check('変換600棟', arr.length === 600, '実際=' + arr.length);
  const tileDir = path.join(TMP, 't3-tiles'); const rootDir = path.join(TMP, 't3-root');
  run(['tools/split-building-tiles.js', '--jsonl-dir', path.join(work, 'chunks'),
    '--dataset', 't3', '--ward', 'テスト', '--output', tileDir, '--root', rootDir]);
  const m = JSON.parse(fs.readFileSync(path.join(tileDir, 'manifest.json'), 'utf8'));
  let tileTotal = 0;
  for (const t of m.tiles) {
    const tt = JSON.parse(fs.readFileSync(path.join(tileDir, t.file), 'utf8'));
    tileTotal += tt.buildings.length;
    if (tt.count !== tt.buildings.length) check('タイルcount整合 ' + t.file, false);
  }
  check('manifest.totalBuildings==600', m.totalBuildings === 600, '実際=' + m.totalBuildings);
  check('タイル内建物合計==600', tileTotal === 600, '実際=' + tileTotal);
  check('建物キー構成が既存互換', (() => {
    const b = JSON.parse(fs.readFileSync(path.join(tileDir, m.tiles[0].file), 'utf8')).buildings[0];
    return ['id', 'fp', 'z0', 'dz', 'h', 'usage', 'ulabel', 'ward'].every(k => k in b);
  })());
}

// ── テスト4: メモリが入力量に比例しない ──
function testMemory() {
  console.log('\n[テスト4] メモリが入力ファイル数に比例しない');
  const dir = path.join(TMP, 't4'); fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, 'm' + String(i).padStart(2, '0') + '.gml'), makeGml('M' + i, 300));
  const out = path.join(TMP, 't4.json'); const work = path.join(TMP, 't4-work');
  const log = run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't4', '--ward', 'テスト',
    '--coordinate-config', CFG, '--output', out, '--work-dir', work]);
  const peakM = log.match(/peak heapUsed=(\d+)MB/);
  const peak = peakM ? parseInt(peakM[1], 10) : 9999;
  check('20ファイル×300棟=6000棟変換', JSON.parse(fs.readFileSync(out, 'utf8')).length === 6000);
  check('peak heap < 300MB（入力非比例）', peak < 300, 'peak=' + peak + 'MB');
}

// ── テスト5: 区名↔区コードの整合性（誤った組み合わせを拒否）──
function testWardConsistency() {
  console.log('\n[テスト5] 区名と区コードの整合性検証');
  const dir = path.join(TMP, 't5'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.gml'), makeGml('W', 10));
  const cfg2 = path.join(TMP, 'cfg2.json');
  fs.writeFileSync(cfg2, JSON.stringify({ version: 1, city: 'osaka', cityCode: '27100',
    coordinateMode: 'geographic-jprect', jprectZone: 6, axisOrder: 'lat lon',
    localOrigin: { projectedE: -45000, projectedN: -154000 }, axisMapping: { sceneXSign: 1, sceneZSign: -1 } }));
  const base = (wardName, wardCode, tag) => {
    const out = path.join(TMP, 't5' + tag + '.json'); const work = path.join(TMP, 't5' + tag + '-work');
    try {
      run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't5' + tag, '--ward', wardName,
        '--ward-code', wardCode, '--coordinate-config', cfg2, '--output', out, '--work-dir', work, '--restart',
        '--sources', SOURCES]);
      return 0;
    } catch (e) { return e.status; }
  };
  // 東住吉区+27121は成功
  check('東住吉区+27121は成功', base('東住吉区', '27121', 'a') === 0);
  // 東住吉区+27114は処理前に失敗（exit 5）
  check('東住吉区+27114は失敗(exit5)', base('東住吉区', '27114', 'b') === 5);
  // 東淀川区+27114は成功
  check('東淀川区+27114は成功', base('東淀川区', '27114', 'c') === 0);
}

// ── テスト6: サブフォルダ内のGML再帰検索 ──
function testRecursiveGml() {
  console.log('\n[テスト6] サブフォルダ内のGMLを再帰検索・除外フォルダを無視');
  const dir = path.join(TMP, 't6'); fs.mkdirSync(path.join(dir, 'udx', 'bldg'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'top.gml'), makeGml('R0', 50));
  fs.writeFileSync(path.join(dir, 'udx', 'bldg', 'nested.gml'), makeGml('R1', 60));
  fs.writeFileSync(path.join(dir, '.cache', 'ignore.gml'), makeGml('R2', 999)); // 除外されるべき
  fs.writeFileSync(path.join(dir, 'tmp', 'ignore2.gml'), makeGml('R3', 999));    // 除外されるべき
  const out = path.join(TMP, 't6.json'); const work = path.join(TMP, 't6-work');
  const log = run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't6', '--ward', 'テスト',
    '--coordinate-config', CFG, '--output', out, '--work-dir', work]);
  const arr = JSON.parse(fs.readFileSync(out, 'utf8'));
  check('サブフォルダのGMLを発見（top50+nested60=110棟）', arr.length === 110, '実際=' + arr.length);
  check('.cache/tmp内のGMLを除外', /GML検索: 2 ファイル/.test(log), log.match(/GML検索:.*/)?.[0] || '');
}

// ── テスト7: LIVECITY_DATA_ROOT でパス解決が統一される ──
function testDataRoot() {
  console.log('\n[テスト7] LIVECITY_DATA_ROOT指定時に全ツールが同じ保存先を解決');
  const dr = path.join(TMP, 'DataRoot');
  const log = execFileSync('node', ['--input-type=module', '-e', `
    import { dataPaths, resolveDataRoot } from './tools/lib/path-config.js';
    const p = dataPaths({}, 'ds1');
    console.log(JSON.stringify({ root: resolveDataRoot({}), raw: p.datasetRaw, proc: p.datasetProcessed, cp: p.datasetCheckpoint }));
  `], { encoding: 'utf8', env: { ...process.env, LIVECITY_DATA_ROOT: dr } });
  const j = JSON.parse(log.trim());
  check('rootがLIVECITY_DATA_ROOT', j.root === dr, j.root);
  check('rawがdata-root配下', j.raw.startsWith(dr), j.raw);
  check('processedがdata-root配下', j.proc.startsWith(dr), j.proc);
  check('checkpointがdata-root配下', j.cp.startsWith(dr), j.cp);
}

// ── テスト8: データ移行後もsetup-areaが入力を発見できる（resolveInputDir）──
function testMigrationDiscovery() {
  console.log('\n[テスト8] データ移行後の入力発見');
  const dr = path.join(TMP, 'DR2');
  const dsRaw = path.join(dr, 'raw', 'dsX');
  fs.mkdirSync(dsRaw, { recursive: true });
  fs.writeFileSync(path.join(dsRaw, 'a.gml'), makeGml('MG', 10));
  const log = execFileSync('node', ['--input-type=module', '-e', `
    import { resolveInputDir } from './tools/lib/path-config.js';
    console.log(resolveInputDir({}, 'dsX'));
  `], { encoding: 'utf8', env: { ...process.env, LIVECITY_DATA_ROOT: dr } });
  check('移行先rawを発見', log.trim() === dsRaw, log.trim());
}

// ── テスト9: 誤った区コードのcheckpointを別区として再開しない ──
function testWrongCheckpoint() {
  console.log('\n[テスト9] 別区コードの既存checkpointを再開しない');
  const dir = path.join(TMP, 't9'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.gml'), makeGml('C', 20));
  const cfg2 = path.join(TMP, 'cfg2.json');
  const out = path.join(TMP, 't9.json'); const work = path.join(TMP, 't9-work');
  // まず東淀川区(27114)で処理
  run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't9', '--ward', '東淀川区',
    '--ward-code', '27114', '--coordinate-config', cfg2, '--output', out, '--work-dir', work, '--keep-work',
    '--sources', SOURCES]);
  // 同じworkを東住吉区(27121)で再開しようとする→拒否(exit6)
  let code = 0;
  try {
    run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't9', '--ward', '東住吉区',
      '--ward-code', '27121', '--coordinate-config', cfg2, '--output', out, '--work-dir', work, '--keep-work',
      '--sources', SOURCES]);
  } catch (e) { code = e.status; }
  check('別区コードでの再開を拒否(exit6)', code === 6, 'code=' + code);
}

// ── テスト10: manifestのward/wardCode/dataset整合と件数一致 ──
function testManifestConsistency() {
  console.log('\n[テスト10] manifestのward/wardCode/dataset整合・件数一致');
  const dir = path.join(TMP, 't10'); fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(dir, 'g' + i + '.gml'), makeGml('MC' + i, 150));
  const cfg2 = path.join(TMP, 'cfg2.json');
  const out = path.join(TMP, 't10.json'); const work = path.join(TMP, 't10-work');
  run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 'osaka-test', '--ward', '東住吉区',
    '--ward-code', '27121', '--coordinate-config', cfg2, '--output', out, '--work-dir', work, '--keep-work',
    '--sources', SOURCES]);
  const tileDir = path.join(TMP, 't10-tiles'); const rootDir = path.join(TMP, 't10-root');
  run(['tools/split-building-tiles.js', '--jsonl-dir', path.join(work, 'chunks'),
    '--dataset', 'osaka-test', '--ward', '東住吉区', '--ward-code', '27121',
    '--output', tileDir, '--root', rootDir]);
  const m = JSON.parse(fs.readFileSync(path.join(tileDir, 'manifest.json'), 'utf8'));
  check('manifest.ward=東住吉区', m.ward === '東住吉区', m.ward);
  check('manifest.wardCode=27121', m.wardCode === '27121', String(m.wardCode));
  check('manifest.id=osaka-test', m.id === 'osaka-test', m.id);
  let tileTotal = 0;
  for (const t of m.tiles) tileTotal += JSON.parse(fs.readFileSync(path.join(tileDir, t.file), 'utf8')).buildings.length;
  check('変換300棟==タイル合計==manifest', JSON.parse(fs.readFileSync(out, 'utf8')).length === 300 && tileTotal === 300 && m.totalBuildings === 300,
    'json=' + JSON.parse(fs.readFileSync(out, 'utf8')).length + ' tile=' + tileTotal + ' manifest=' + m.totalBuildings);
}

// ── テスト11: チャンク障害復旧（各コミット段階の停止からの復旧）──
function testChunkRecovery() {
  console.log('\n[テスト11] チャンク障害復旧: 各コミット段階の停止で欠落・重複なし');
  const dir = path.join(TMP, 't11'); fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, 'c' + i + '.gml'), makeGml('CR' + i, 100));
  const out = path.join(TMP, 't11.json'); const work = path.join(TMP, 't11-work');
  const chunks = path.join(work, 'chunks');
  // 正常に一度処理して基準を作る
  run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't11', '--ward', 'テスト',
    '--coordinate-config', CFG, '--output', out, '--work-dir', work, '--keep-work']);
  const baseCount = JSON.parse(fs.readFileSync(out, 'utf8')).length;
  check('基準変換500棟', baseCount === 500, '実際=' + baseCount);

  // 障害注入1: 「rename後・meta保存前」= metaを1つ削除 → 再処理されるべき
  const metas = fs.readdirSync(chunks).filter(f => f.endsWith('.meta.json'));
  fs.unlinkSync(path.join(chunks, metas[0]));
  // progressのdoneKeysからは消さない（progress保存前で落ちた状態を模擬）
  let log = run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't11', '--ward', 'テスト',
    '--coordinate-config', CFG, '--output', out, '--work-dir', work, '--keep-work']);
  check('meta欠落を復旧（ログ表示）', /チャンク復旧/.test(log), log.match(/チャンク復旧.*/)?.[0] || 'なし');
  let c1 = JSON.parse(fs.readFileSync(out, 'utf8'));
  check('meta欠落復旧後も500棟・重複なし', c1.length === 500 && new Set(c1.map(b => b.id)).size === 500, '実際=' + c1.length);

  // 障害注入2: 「jsonl件数とmeta件数の不一致」→ 再処理
  const jsonls = fs.readdirSync(chunks).filter(f => f.endsWith('.jsonl'));
  fs.appendFileSync(path.join(chunks, jsonls[0]), '{"id":"CORRUPT","fp":[[0,0],[1,0],[1,1]],"z0":0,"dz":3,"h":3,"usage":"","ulabel":"","ward":"テスト"}\n');
  log = run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't11', '--ward', 'テスト',
    '--coordinate-config', CFG, '--output', out, '--work-dir', work, '--keep-work']);
  let c2 = JSON.parse(fs.readFileSync(out, 'utf8'));
  check('件数不一致を再処理して500棟・CORRUPT混入なし', c2.length === 500 && !c2.some(b => b.id === 'CORRUPT'), '実際=' + c2.length);

  // 障害注入3: 古い.tmpが残存 → 掃除される
  fs.writeFileSync(path.join(chunks, 'stale123.jsonl.tmp'), 'garbage');
  log = run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't11', '--ward', 'テスト',
    '--coordinate-config', CFG, '--output', out, '--work-dir', work, '--keep-work']);
  check('古いtmpを掃除', !fs.existsSync(path.join(chunks, 'stale123.jsonl.tmp')));
}

// ── テスト12: 200タイルLRU往復（MAX_OPEN=64を大きく超える）──
function testLruStress() {
  console.log('\n[テスト12] 200タイル往復LRU: 件数・タイル数・JSON正常性');
  // 建物を200タイルに散らすため、座標を大きく離す。1ファイルに全建物を入れ、複数回往復させる。
  const dir = path.join(TMP, 't12'); fs.mkdirSync(dir, { recursive: true });
  // 200タイル×各3棟=600棟。tileSize=500mなので、緯度をずらしてタイルを離散させる。
  let g = '<?xml version="1.0"?><core:CityModel xmlns:bldg="b" xmlns:gml="g" xmlns:core="c">';
  const TILES = 200, PER = 3, ROUNDS = 3;
  // ROUND回、各タイルに1棟ずつ書く＝同じタイルへ往復追記
  for (let r = 0; r < ROUNDS; r++) {
    for (let t = 0; t < TILES; t++) {
      const la = 34.6 + t * 0.01; // 0.01度≈1.1km ごとに別タイル
      const lo = 135.5 + (r * 0.0001);
      const ring = `${la.toFixed(6)} ${lo.toFixed(6)} 0 ${(la + 0.0005).toFixed(6)} ${lo.toFixed(6)} 0 ${(la + 0.0005).toFixed(6)} ${(lo + 0.0005).toFixed(6)} 0 ${la.toFixed(6)} ${lo.toFixed(6)} 0`;
      g += `<core:cityObjectMember><bldg:Building gml:id="L_${r}_${t}"><bldg:measuredHeight uom="m">10</bldg:measuredHeight>` +
        `<bldg:lod0FootPrint><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>${ring}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod0FootPrint></bldg:Building></core:cityObjectMember>`;
    }
  }
  g += '</core:CityModel>';
  fs.writeFileSync(path.join(dir, 'big.gml'), g);
  const out = path.join(TMP, 't12.json'); const work = path.join(TMP, 't12-work');
  run(['tools/convert-plateau-buildings.js', '--input', dir, '--dataset', 't12', '--ward', 'テスト',
    '--coordinate-config', CFG, '--output', out, '--work-dir', work, '--keep-work']);
  const total = ROUNDS * TILES; // 各(r,t)が別ID＝600棟
  const arr = JSON.parse(fs.readFileSync(out, 'utf8'));
  check('変換' + total + '棟', arr.length === total, '実際=' + arr.length);
  const tileDir = path.join(TMP, 't12-tiles'); const rootDir = path.join(TMP, 't12-root');
  const log = run(['tools/split-building-tiles.js', '--jsonl-dir', path.join(work, 'chunks'),
    '--dataset', 't12', '--ward', 'テスト', '--output', tileDir, '--root', rootDir]);
  const m = JSON.parse(fs.readFileSync(path.join(tileDir, 'manifest.json'), 'utf8'));
  check('タイル数がMAX_OPEN(64)超', m.tileCount > 64, 'tiles=' + m.tileCount);
  let tileTotal = 0, allValid = true;
  for (const t of m.tiles) {
    try { const tt = JSON.parse(fs.readFileSync(path.join(tileDir, t.file), 'utf8')); tileTotal += tt.buildings.length; if (tt.count !== tt.buildings.length) allValid = false; }
    catch (e) { allValid = false; }
  }
  check('全タイルJSON正常', allValid);
  check('タイル合計==' + total + '（往復追記でも欠落なし）', tileTotal === total, 'tileTotal=' + tileTotal);
  check('manifest.totalBuildings一致', m.totalBuildings === total);
  const peak = stripAnsi(log).match(/peak heapUsed=(\d+)MB/);
  console.log('    LRUストレス peak heap:', peak ? peak[1] + 'MB' : '不明');
}

// ── テスト13: 既存完成出力がある状態での安全な置換 ──
function testSafeReplace() {
  console.log('\n[テスト13] 既存出力がある状態での安全な置換（safeReplace）');

  const out = path.join(TMP, 'sr.json');
  const tmpDir = TMP;

  // JSON.stringifyでWindowsの「\」を安全にエスケープしてから
  // node -eへ渡す。
  const script = `
    import { safeReplace } from './tools/lib/path-config.js';
    import fs from 'node:fs';

    const out = ${JSON.stringify(out)};
    const tmpDir = ${JSON.stringify(tmpDir)};

    fs.writeFileSync(out, JSON.stringify([1,2,3]));
    fs.writeFileSync(out + '.tmp', JSON.stringify([4,5,6,7]));

    safeReplace(out + '.tmp', out);

    console.log('AFTER=' + fs.readFileSync(out, 'utf8'));
    console.log('TMPGONE=' + !fs.existsSync(out + '.tmp'));
    console.log(
      'NOBACKUP=' +
      (fs.readdirSync(tmpDir).filter(f => f.includes('.backup-')).length === 0)
    );
  `;

  const log = execFileSync(
    'node',
    ['--input-type=module', '-e', script],
    { encoding: 'utf8' }
  );

  check('既存出力を新出力で置換', /AFTER=\[4,5,6,7\]/.test(log));
  check('tmpが消費された', /TMPGONE=true/.test(log));
  check('backupが残らない', /NOBACKUP=true/.test(log));
}
// ── テスト14: LIVECITY_DATA_ROOTが旧パスより優先される ──
function testDataRootPriority() {
  console.log('\n[テスト14] パス優先順位: 明示 > LIVECITY_DATA_ROOT > 旧パス');
  const dr = path.join(TMP, 'PriorityDR');
  const evalPath = (env, extraArgs) => {
    const log = execFileSync('node', ['--input-type=module', '-e', `
      import { resolvePreferredPath } from './tools/lib/path-config.js';
      console.log(JSON.stringify(resolvePreferredPath('raw', ${JSON.stringify(extraArgs)}, 'dsP')));
    `], { encoding: 'utf8', env: { ...process.env, ...env } });
    return JSON.parse(stripAnsi(log).trim());
  };
  // 明示指定が最優先
  check('明示指定が最優先', evalPath({ LIVECITY_DATA_ROOT: dr }, { citygml: '/explicit/path' }).source === 'explicit');
  // 明示なし → data-root（旧パスがあっても）
  const r = evalPath({ LIVECITY_DATA_ROOT: dr }, {});
  check('明示なしはdata-root', r.source === 'data-root' && r.path.startsWith(dr), r.path);
  // --prefer-legacy 指定時のみ旧パス（旧パスが実在する場合）
  const legacyDir = path.join(process.cwd(), 'data', 'raw', 'dsPL');
  fs.mkdirSync(legacyDir, { recursive: true });
  try {
    const rl = evalPath({ LIVECITY_DATA_ROOT: dr }, { 'prefer-legacy': true });
    // dsP用なのでlegacyは無い→data-root。dsPL用に別途確認
    const rl2 = execFileSync('node', ['--input-type=module', '-e', `
      import { resolvePreferredPath } from './tools/lib/path-config.js';
      console.log(JSON.stringify(resolvePreferredPath('raw', {'prefer-legacy':true}, 'dsPL')));
    `], { encoding: 'utf8', env: { ...process.env, LIVECITY_DATA_ROOT: dr } });
    const j = JSON.parse(stripAnsi(rl2).trim());
    check('--prefer-legacyで旧パス優先', /legacy/.test(j.source) && j.path === legacyDir, JSON.stringify(j));
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
}

// ── テスト15: cleanupがデータルート/旧パス両方を検査し、dry-runで削除しない ──
function testCleanupDataRoot() {
  console.log('\n[テスト15] cleanupのデータルート対応とdry-run安全性');
  const dr = path.join(TMP, 'CleanDR');
  // データルート側にcheckpoint、public側に完成manifestを模擬
  const cp = path.join(dr, 'checkpoints', 'cds1');
  fs.mkdirSync(path.join(cp, 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(cp, 'progress.json'), JSON.stringify({ failed: [] }));
  fs.writeFileSync(path.join(cp, 'chunks', 'x.jsonl'), '{}');
  const pub = path.join('public', 'data', 'buildings', 'cds1');
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, 'manifest.json'), JSON.stringify({ totalBuildings: 1 }));
  try {
    const log = execFileSync('node', ['tools/cleanup-data.js', '--dataset', 'cds1', '--dry-run'],
      { encoding: 'utf8', env: { ...process.env, LIVECITY_DATA_ROOT: dr } });
    const clean = stripAnsi(log);
    check('データルート側checkpointを検出', clean.includes(cp), cp);
    check('dry-runでは削除されない', fs.existsSync(path.join(cp, 'chunks', 'x.jsonl')));
    // 完成タイルmanifestは削除候補に入らない
    check('完成manifestは候補外', !clean.includes(path.join(pub, 'manifest.json')));
  } finally {
    fs.rmSync(pub, { recursive: true, force: true });
  }
}

function main() {
  console.log('══ Live City パイプライン回帰テスト ══');
  setup();
  try {
    testBuildingPart();
    testResumeFailedAndStats();
    testTilePipeline();
    testMemory();
    testWardConsistency();
    testRecursiveGml();
    testDataRoot();
    testMigrationDiscovery();
    testWrongCheckpoint();
    testManifestConsistency();
    testChunkRecovery();
    testLruStress();
    testSafeReplace();
    testDataRootPriority();
    testCleanupDataRoot();
  } catch (e) {
    console.error('\nテスト実行中に例外:', e.message);
    fail++;
  } finally {
    cleanup();
  }
  console.log(`\n══ 結果: ${pass} passed / ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
}
main();
