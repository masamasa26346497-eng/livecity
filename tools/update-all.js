#!/usr/bin/env node
// tools/update-all.js
// 実行: node tools/update-all.js [--area osaka-sumiyoshi]
//
// 目的（ご指示1）: 既存の個別更新コマンドを「順番に呼び出すだけ」の一括更新入口。
//   新しい取得・変換処理は一切実装しない。各ステップは package.json の既存 npm scripts を
//   そのまま子プロセスとして実行する（＝正規パイプラインの再利用）。
//
// 必須条件への対応:
//   - 途中で失敗したら即座に非ゼロ終了し、後続を続行しない（fail-fast）。
//   - 既存の個別コマンドは削除しない（本ファイルは追加のみ）。
//   - 一括更新後に4つの統計JSONの存在・JSON妥当性・件数(>0)を検証する。
//   - 0件生成を正常完了として扱わない（0件は検証NGで非ゼロ終了）。
//   - 外部データ更新が不要でも、余計な新規取得処理は足さない（既存コマンドのforceは付けない＝
//     rawがあればdownloadはskipped-existsで再利用される既存挙動に従う）。

import { spawn } from 'child_process';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = { area: 'osaka-sumiyoshi' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
  }
  return args;
}

// npm run <script> -- --area <areaId> を子プロセスで実行する。
// Windows対応のため npm.cmd を明示解決する。
// `--` 以降を付けることで、npm scripts が呼ぶ node スクリプトへ --area が確実に伝播する
//（既存 tools/orchestrate.js 等はいずれも --area を解釈する）。
function runNpmScript(scriptName, areaId) {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npmArgs = ['run', scriptName, '--', '--area', areaId];
    // 子プロセスへ実際に渡すコマンドをログへ表示する（引数伝播の可視化）。
    console.log(`\n────────── ${npmCmd} ${npmArgs.join(' ')} ──────────`);
    const child = spawn(npmCmd, npmArgs, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32', // Windowsで.cmdを確実に起動するため
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm run ${scriptName} -- --area ${areaId} が exit code ${code} で失敗しました。`));
    });
    child.on('error', (err) => reject(err));
  });
}

// 一括更新の対象は、現在の正規パイプラインが対応しているものだけ。
// 依存順序: demographics(人口・世帯・年齢・town-stats統合を含む) → facilities。
// ※ demographics の process 内で town-stats.json まで生成される（merge/town-stats.js）ため、
//   地域統計を別コマンドとして重複実行しない。
const STEPS = [
  'data:import:demographics', // 人口・世帯・年齢構成・地域統計(town-stats) を download→process
  'data:import:facilities',   // 施設(OSM) を download→process
];

// 一括更新後に検証する配信JSON（4点）。件数>0を必須とする。
function statsTargets(areaId) {
  const base = path.join(ROOT, 'public', 'map-data', areaId);
  return [
    { label: '人口・世帯 (summary)', file: path.join(base, 'demographics', 'summary.json'), recordsKey: 'records' },
    { label: '年齢構成 (age-structure)', file: path.join(base, 'demographics', 'age-structure.json'), recordsKey: 'records' },
    { label: '地域統計 (town-stats)', file: path.join(base, 'demographics', 'town-stats.json'), recordsKey: 'records' },
    { label: '施設 (facilities)', file: path.join(base, 'facilities', 'facilities.json'), recordsKey: 'records' },
  ];
}

// 生成物の検証: 存在・JSONパース可否・records件数>0。0件やパース不能は失敗として扱う。
function verifyOutputs(areaId) {
  const targets = statsTargets(areaId);
  let ok = true;
  console.log('\n========== 生成物の検証（件数・出力先） ==========');
  for (const t of targets) {
    const rel = path.relative(ROOT, t.file);
    if (!existsSync(t.file)) {
      console.log(`  ✗ ${t.label}: ファイルがありません (${rel})`);
      ok = false;
      continue;
    }
    let data;
    try {
      data = JSON.parse(readFileSync(t.file, 'utf-8'));
    } catch (e) {
      console.log(`  ✗ ${t.label}: JSONとして読み込めません (${rel}) - ${e.message}`);
      ok = false;
      continue;
    }
    const records = data && data[t.recordsKey];
    const count = Array.isArray(records) ? records.length : null;
    if (count === null) {
      console.log(`  ✗ ${t.label}: "${t.recordsKey}" 配列がありません (${rel})`);
      ok = false;
    } else if (count === 0) {
      console.log(`  ✗ ${t.label}: 0件です。0件生成は正常完了と見なしません (${rel})`);
      ok = false;
    } else {
      console.log(`  ✓ ${t.label}: ${count}件 → ${rel}`);
    }
  }
  return ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Live City データ一括更新 (area=${args.area})`);
  console.log('既存の個別コマンドを順番に実行します。途中失敗時は中断します。');

  for (const step of STEPS) {
    try {
      await runNpmScript(step, args.area);
    } catch (err) {
      console.error(`\n[中断] ${err.message}`);
      console.error('後続処理は実行しません。既存の正常なJSONは保護されています（安全書込のため）。');
      process.exit(1); // fail-fast: 非ゼロ終了
    }
  }

  const ok = verifyOutputs(args.area);
  if (!ok) {
    console.error('\n[失敗] 生成物の検証に失敗しました。上記の項目を確認してください。');
    process.exit(1);
  }
  console.log('\n✅ 一括更新が完了しました。プレビューは `npm run preview` を使用してください。');
}

main().catch((err) => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
