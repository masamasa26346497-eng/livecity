#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/cleanup-data.js
// ══════════════════════════════════════════════════════════════
// 処理成功済みデータの中間生成物を安全に削除する。dry-runが既定で、--apply が無い限り削除しない。
//
// 削除対象（分類して表示）:
//   .tmp / .part            … 中断で残った一時ファイル
//   convert中間チャンク       … 完成タイルとmanifestが揃っている場合のみ
//   展開済みGML(raw)         … --remove-extracted 指定時のみ（元ZIPが別にある前提）
//   古いキャッシュ            … .cache配下の一時物
// 削除しないもの: 完成タイル / manifest / coordinate-config / 再開に必要なcheckpoint（未完了時）
//
// 使い方:
//   node tools/cleanup-data.js --dry-run                          全datasetの候補を表示
//   node tools/cleanup-data.js --dataset osaka-higashisumiyoshi --dry-run
//   node tools/cleanup-data.js --dataset osaka-higashisumiyoshi --apply
//   オプション: --remove-extracted（展開済みGMLも対象） --remove-archives（元ZIPも対象）
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { dataPaths, detectLegacyPath } from './lib/path-config.js';

function parseArgs(argv) {
  const FLAGS = new Set(['apply', 'dry-run', 'remove-extracted', 'remove-archives', 'all']);
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    if (FLAGS.has(k)) { a[k] = true; continue; }
    const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    a[k] = v;
  }
  return a;
}

function dirSize(p) {
  let total = 0;
  const walk = d => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else { try { total += fs.statSync(fp).size; } catch (e2) {} }
    }
  };
  if (fs.existsSync(p)) { if (fs.statSync(p).isDirectory()) walk(p); else total = fs.statSync(p).size; }
  return total;
}
const fmtMB = b => (b / 1024 / 1024).toFixed(1) + 'MB';

// datasetが「処理成功済み」か: 完成タイルのmanifestが存在し、進捗にfailedが無い
function checkpointDirs(dataset, args) {
  // データルート配下と旧.cache/convertの両方を検査対象にする（勝手に片方だけ見て見落とさない）
  const dirs = [];
  const dp = dataPaths(args, dataset);
  if (dp.datasetCheckpoint) dirs.push(dp.datasetCheckpoint);
  const legacy = detectLegacyPath('checkpoint', dataset);
  if (legacy && !dirs.includes(legacy)) dirs.push(legacy);
  return dirs.filter(d => fs.existsSync(d));
}

function isComplete(dataset, args) {
  const tileManifest = path.join('public/data/buildings', dataset, 'manifest.json');
  if (!fs.existsSync(tileManifest)) return false;
  for (const cp of checkpointDirs(dataset, args)) {
    const progressPath = path.join(cp, 'progress.json');
    if (fs.existsSync(progressPath)) {
      try { const p = JSON.parse(fs.readFileSync(progressPath, 'utf8')); if ((p.failed || []).length) return false; } catch (e) {}
    }
  }
  return true;
}

function collectCandidates(dataset, args) {
  const items = [];
  const seen = new Set();
  const add = (kind, p, protectedIf) => {
    if (!p || seen.has(p) || !fs.existsSync(p)) return;
    seen.add(p);
    items.push({ kind, path: p, size: dirSize(p), protected: !!protectedIf });
  };
  const complete = isComplete(dataset, args);
  const dp = dataPaths(args, dataset);

  // convert中間チャンク（完成時のみ削除可）: データルート＋旧パスの両方
  for (const cp of checkpointDirs(dataset, args)) add('convert-checkpoint', cp, !complete);
  // 正規化中間JSON（互換用。完成後は任意で削除可）: 両方
  add('processed-json', dp.datasetProcessed, !complete);
  add('processed-json(legacy)', detectLegacyPath('processed', dataset), !complete);
  // 展開済みGML（明示指定時のみ）: 両方
  if (args['remove-extracted']) {
    add('extracted-gml', dp.datasetRaw, !complete);
    add('extracted-gml(legacy)', detectLegacyPath('raw', dataset), !complete);
  }
  // 元ZIP（明示指定時のみ）: 両方
  if (args['remove-archives']) {
    add('archive', dp.archives, false);
    add('archive(legacy)', path.join('.cache', 'plateau'), false);
  }

  return { items, complete };
}

function scanTmpFiles(root) {
  const found = [];
  const walk = d => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.git')) walk(fp); }
      else if (/\.(tmp|part)$/.test(e.name)) found.push({ kind: 'tmp/part', path: fp, size: (() => { try { return fs.statSync(fp).size; } catch (e2) { return 0; } })(), protected: false });
    }
  };
  walk(root);
  return found;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = !!args.apply;
  const datasets = args.dataset ? [args.dataset]
    : (fs.existsSync('public/data/buildings')
        ? fs.readdirSync('public/data/buildings').filter(d => { try { return fs.statSync(path.join('public/data/buildings', d)).isDirectory(); } catch (e) { return false; } })
        : []);

  console.log(apply ? '══ クリーンアップ実行（--apply）══' : '══ クリーンアップ候補（dry-run。--apply で実削除）══');
  let allItems = [];
  for (const ds of datasets) {
    const { items, complete } = collectCandidates(ds, args);
    if (items.length) {
      console.log(`\n[dataset: ${ds}] ${complete ? '処理完了' : '未完了（再開に必要なものは保護）'}`);
      for (const it of items) {
        console.log(`  ${it.protected ? '🔒保護' : '🗑削除候補'} ${it.kind.padEnd(20)} ${fmtMB(it.size).padStart(10)}  ${it.path}`);
        if (!it.protected) allItems.push(it);
      }
    }
  }
  // .tmp / .part はdataset横断で回収
  const tmps = scanTmpFiles('.').concat(fs.existsSync('data') ? scanTmpFiles('data') : []);
  const uniqTmp = [...new Map(tmps.map(t => [t.path, t])).values()];
  if (uniqTmp.length) {
    console.log('\n[一時ファイル .tmp/.part]');
    for (const it of uniqTmp) { console.log(`  🗑削除候補 ${it.kind.padEnd(20)} ${fmtMB(it.size).padStart(10)}  ${it.path}`); allItems.push(it); }
  }

  const totalSize = allItems.reduce((a, b) => a + b.size, 0);
  console.log(`\n削除候補: ${allItems.length} 件 / 合計 ${fmtMB(totalSize)}`);
  if (!allItems.length) { console.log('削除対象はありません。'); return; }

  if (!apply) {
    console.log('\n--apply を付けると上記を削除します。保護（🔒）は削除しません。');
    return;
  }
  let removed = 0, freed = 0;
  for (const it of allItems) {
    try { fs.rmSync(it.path, { recursive: true, force: true }); removed++; freed += it.size; }
    catch (e) { console.warn('  削除失敗:', it.path, e.message); }
  }
  console.log(`\n削除完了: ${removed} 件 / 解放 ${fmtMB(freed)}`);
}

main();
