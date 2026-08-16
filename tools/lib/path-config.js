// ══════════════════════════════════════════════════════════════
// tools/lib/path-config.js
// ══════════════════════════════════════════════════════════════
// 大容量データの保存先を、ソースコード（OneDrive配下になりうる）から分離するための
// 共通パスモジュール。全ツールがここを経由してパスを解決する。
//
// データルートの優先順位:
//   1. --data-root <path>（CLI引数）
//   2. 環境変数 LIVECITY_DATA_ROOT
//   3. OS別既定値: Windows= C:\LiveCityData / macOS・Linux= ~/LiveCityData
//
// リポジトリ内に残すもの: ソースコード・設定・軽量manifest・テスト・package.json
// データルートへ逃がすもの: raw / archives / extracted / processed / tiles / cache / tmp / logs / checkpoints
//
// 後方互換: 旧構成（リポジトリ内の data/raw 等）にデータがある場合は検出して使う（削除も移動もしない）。
'use strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// OS別の既定データルート
export function defaultDataRoot() {
  if (process.platform === 'win32') return 'C:\\LiveCityData';
  return path.join(os.homedir(), 'LiveCityData');
}

// データルートを解決する。argv（parse済みオブジェクト）に --data-root があれば最優先。
export function resolveDataRoot(args = {}) {
  const fromArg = args['data-root'] || args.dataRoot;
  const raw = fromArg || process.env.LIVECITY_DATA_ROOT || defaultDataRoot();
  return path.resolve(raw);
}

// 大容量データの各サブディレクトリ。リポジトリ相対ではなくデータルート配下に置く。
// dataset を渡すと、その dataset 固有のパスも返す。
export function dataPaths(args = {}, dataset = null) {
  const root = resolveDataRoot(args);
  const p = {
    root,
    raw: path.join(root, 'raw'),
    archives: path.join(root, 'archives'),
    extracted: path.join(root, 'extracted'),
    processed: path.join(root, 'processed'),
    tiles: path.join(root, 'tiles'),
    cache: path.join(root, 'cache'),
    tmp: path.join(root, 'tmp'),
    logs: path.join(root, 'logs'),
    checkpoints: path.join(root, 'checkpoints')
  };
  if (dataset) {
    p.datasetRaw = path.join(p.raw, dataset);
    p.datasetProcessed = path.join(p.processed, dataset + '-buildings.json');
    p.datasetTiles = path.join(p.tiles, dataset);
    p.datasetCheckpoint = path.join(p.checkpoints, dataset);
  }
  return p;
}

// 必要なディレクトリを作成（存在すれば何もしない）
export function ensureDirs(paths, keys = null) {
  const list = keys || ['raw', 'archives', 'extracted', 'processed', 'tiles', 'cache', 'tmp', 'logs', 'checkpoints'];
  for (const k of list) if (paths[k]) fs.mkdirSync(paths[k], { recursive: true });
}

// 旧構成（リポジトリ内 data/raw/<dataset> 等）にデータがあるか検出する。
// あればそのパスを返し、無ければ null。呼び出し側が後方互換で使うため。
export function detectLegacyPath(kind, dataset, repoRoot = process.cwd()) {
  const candidates = {
    raw: path.join(repoRoot, 'data', 'raw', dataset || ''),
    processed: path.join(repoRoot, 'data', 'processed', (dataset ? dataset + '-buildings.json' : '')),
    tiles: path.join(repoRoot, 'public', 'data', 'buildings', dataset || ''),
    checkpoint: path.join(repoRoot, '.cache', 'convert', dataset || '')
  };
  const c = candidates[kind];
  if (c && fs.existsSync(c)) return c;
  return null;
}

// 入力GMLディレクトリを、新旧両対応で解決する。
// 明示引数 > 新データルート > 旧リポジトリ構成 の順。存在するものを返す。
export function resolveInputDir(args, dataset) {
  if (args.citygml && fs.existsSync(args.citygml)) return args.citygml;
  if (args.input && fs.existsSync(args.input)) return args.input;
  const p = dataPaths(args, dataset);
  if (fs.existsSync(p.datasetRaw)) return p.datasetRaw;
  const legacy = detectLegacyPath('raw', dataset);
  if (legacy) return legacy;
  return p.datasetRaw; // 未取得時の既定（fetch-plateauの出力先）
}

// ══════════════════════════════════════════════════════════════
// 区名 ↔ 区コード の整合性検証（誤った組み合わせを処理前に拒否する）
// ══════════════════════════════════════════════════════════════
// data/plateau-sources.json の wards を唯一の正とする。
// 例: 東住吉区=27121, 東淀川区=27114。「東住吉区+27114」のような不一致を検出する。
export function loadWardTable(sourcesPath = 'data/plateau-sources.json') {
  try {
    const j = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
    return (j && j.wards) || {};
  } catch (e) { return {}; }
}

// wardCode から正式な区名を引く
export function wardNameFor(wardCode, sourcesPath) {
  const w = loadWardTable(sourcesPath);
  const e = w[String(wardCode)];
  return e && e.name ? e.name : null;
}

// 区名 と 区コード の整合を検証。{ ok, expectedName, message } を返す。
// wardName / wardCode いずれかが未指定なら「検証不能だが不一致ではない」= ok:true とする
// （呼び出し側で必須化は別途行う）。
export function verifyWardConsistency(wardName, wardCode, sourcesPath = 'data/plateau-sources.json') {
  if (!wardCode) return { ok: true, expectedName: null, message: '区コード未指定（整合検証スキップ）' };
  const expected = wardNameFor(wardCode, sourcesPath);
  if (!expected) {
    return { ok: false, expectedName: null,
      message: `区コード ${wardCode} が対応表(${sourcesPath} の wards)に存在しません。コードを確認してください。` };
  }
  if (wardName && wardName !== expected) {
    return { ok: false, expectedName: expected,
      message: `区名と区コードが一致しません: 指定「${wardName}」だが ${wardCode} は「${expected}」です。` +
               ` 東住吉区=27121 / 東淀川区=27114 に注意してください。` };
  }
  return { ok: true, expectedName: expected, message: `整合OK: ${expected} = ${wardCode}` };
}

// ══════════════════════════════════════════════════════════════
// パス優先順位の統一解決: 明示指定 → LIVECITY_DATA_ROOT → 旧リポジトリパス（警告のみ）
// ══════════════════════════════════════════════════════════════
// 旧パスにデータがあっても勝手に使わない（削除・移動もしない）。警告を出しデータルートを既定にする。
// --prefer-legacy 指定時のみ旧パスを優先する。
// kind: 'raw' | 'processed' | 'checkpoint'
export function resolvePreferredPath(kind, args, dataset) {
  const explicit = {
    raw: args.citygml || args.input || null,
    processed: args.output || null,
    checkpoint: args['work-dir'] || null
  }[kind];
  if (explicit) return { path: explicit, source: 'explicit' };

  const dp = dataPaths(args, dataset);
  const rootPath = { raw: dp.datasetRaw, processed: dp.datasetProcessed, checkpoint: dp.datasetCheckpoint }[kind];
  const legacy = detectLegacyPath(kind, dataset);

  if (args['prefer-legacy'] && legacy) {
    return { path: legacy, source: 'legacy(--prefer-legacy)' };
  }
  if (legacy && legacy !== rootPath) {
    // 旧パスにデータがあるが、データルートを優先する。警告のみ（削除・移動しない）。
    return { path: rootPath, source: 'data-root', legacyWarning: legacy };
  }
  return { path: rootPath, source: 'data-root' };
}

// ══════════════════════════════════════════════════════════════
// 最終出力の安全な置換（Windows/Mac共通）
// ══════════════════════════════════════════════════════════════
// tmp（書き込み済み）→ output へ安全に差し替える。既存outputはbackupへ退避し、
// 成功後に削除、失敗時は復元する。Windowsの「既存があるとrename不可」問題も回避。
export function safeReplace(tmpPath, outputPath) {
  if (!fs.existsSync(tmpPath)) throw new Error('safeReplace: tmpが存在しません: ' + tmpPath);
  const backup = outputPath + '.backup-' + process.pid + '-' + Date.now();
  let backedUp = false;
  try {
    if (fs.existsSync(outputPath)) { fs.renameSync(outputPath, backup); backedUp = true; }
    fs.renameSync(tmpPath, outputPath);
    if (backedUp) { try { fs.rmSync(backup, { force: true }); } catch (e) {} }
  } catch (e) {
    // 失敗時: backupを復元
    try {
      if (backedUp && !fs.existsSync(outputPath) && fs.existsSync(backup)) fs.renameSync(backup, outputPath);
    } catch (e2) {}
    throw e;
  }
}
