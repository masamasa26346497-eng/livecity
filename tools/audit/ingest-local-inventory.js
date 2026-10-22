#!/usr/bin/env node
// tools/audit/ingest-local-inventory.js
// [Mission 42] ローカルPCで tools/audit/local-data-inventory.ps1 が作った summary.json / files.csv を取り込み、
//   移管可否（blocked / hold / conditional）と保存先候補を集計して data/reports/mission42-transfer-readiness.json に出す。
//   ネットワーク不使用・実データ非接触。入力はパス/内容を含まない共有用出力だけを想定し、
//   path-map.local.csv や実パスらしき値が混入していたら取り込みを拒否する。
//
//   実行: node tools/audit/ingest-local-inventory.js --summary <summary.json> --files <files.csv> [--out <report.json>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLASSIFICATION_PATH = path.join(ROOT, 'config', 'transfer', 'license-classification.json');
const DEFAULT_OUT = path.join(ROOT, 'data', 'reports', 'mission42-transfer-readiness.json');

export const ALLOWED_COLUMNS = ['pathId', 'ext', 'sizeBytes', 'lastWriteUtc', 'sha256', 'sourceHint', 'riskFlags'];
const PATH_LIKE = /[\\/]|^[A-Za-z]:/;

/** Export-Csv 形式（全フィールドがダブルクォート）にも対応する最小CSVパーサ。 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function parseFilesCsv(text) {
  const [header, ...body] = parseCsv(text);
  if (!header) throw new Error('files.csv が空です');
  const extra = header.filter((h) => !ALLOWED_COLUMNS.includes(h));
  const missing = ALLOWED_COLUMNS.filter((h) => !header.includes(h));
  if (extra.length) throw new Error(`許可されていない列があります（パス/ファイル名の混入防止のため拒否）: ${extra.join(', ')}`);
  if (missing.length) throw new Error(`必須列が不足しています: ${missing.join(', ')}`);
  return body.map((cells, idx) => {
    const r = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
    for (const k of ['pathId', 'ext', 'sourceHint', 'riskFlags', 'lastWriteUtc']) {
      if (PATH_LIKE.test(r[k].replace(/^content:/, '').replace(/\./g, ''))) {
        throw new Error(`行${idx + 2}の ${k} にパスらしき値があります。共有用出力ではありません。`);
      }
    }
    r.sizeBytes = Number(r.sizeBytes);
    if (!Number.isFinite(r.sizeBytes) || r.sizeBytes < 0) throw new Error(`行${idx + 2}の sizeBytes が不正です`);
    return r;
  });
}

function strictest(decisions, order) {
  for (const d of order) if (decisions.includes(d)) return d;
  return order[order.length - 1];
}

function tierFor(size, tiers) {
  if (size <= tiers['github-repo'].maxBytes) return 'github-repo';
  if (size <= tiers['external-object-storage'].maxBytes) return 'external-object-storage';
  return 'external-object-storage-multipart';
}

/** 1ファイルの判定。リスクフラグ・出典候補のうち最も厳しい decision を採る。 */
export function classifyFile(row, cls) {
  const reasons = [];
  const decisions = [];
  for (const flag of row.riskFlags.split(';').filter(Boolean)) {
    const rc = cls.riskClasses[flag] || (flag.startsWith('content:') ? cls.riskClasses['content:*'] : null);
    if (rc) { decisions.push(rc.decision); reasons.push(flag); }
    else { decisions.push('hold'); reasons.push(`unknown-flag:${flag}`); }
  }
  const hints = (row.sourceHint || 'unknown').split('+').filter(Boolean);
  for (const h of hints) {
    const c = cls.classes[h] || cls.classes.unknown;
    decisions.push(c.decision); reasons.push(`source:${cls.classes[h] ? h : 'unknown'}`);
  }
  const decision = strictest(decisions, cls.decisionOrder);
  const tier = decision === 'conditional' ? tierFor(row.sizeBytes, cls.storageTiers) : 'none';
  return { decision, tier, reasons };
}

export function evaluateInventory(summary, rows, cls) {
  if (summary.schema !== 'livecity-local-inventory/v1') throw new Error(`未対応のschema: ${summary.schema}`);
  const bucket = () => ({ files: 0, bytes: 0 });
  const add = (b, size) => { b.files++; b.bytes += size; };
  const byDecision = { blocked: bucket(), hold: bucket(), conditional: bucket() };
  const byTier = {};
  const bySource = {};
  const reasonCounts = {};
  let unhashedDupRisk = 0;
  for (const r of rows) {
    const v = classifyFile(r, cls);
    add(byDecision[v.decision], r.sizeBytes);
    byTier[v.tier] ??= bucket(); add(byTier[v.tier], r.sizeBytes);
    const key = r.sourceHint || 'unknown';
    bySource[key] ??= { ...bucket(), blocked: 0, hold: 0, conditional: 0 };
    add(bySource[key], r.sizeBytes); bySource[key][v.decision]++;
    for (const reason of v.reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    if (!r.sha256 && r.sizeBytes > 0) unhashedDupRisk++;
  }
  const totalBytes = rows.reduce((s, r) => s + r.sizeBytes, 0);
  const warnings = [];
  if (summary.totals && summary.totals.files !== rows.length) warnings.push(`summary の件数(${summary.totals.files})と files.csv の行数(${rows.length})が不一致`);
  if (summary.totals && summary.totals.bytes !== totalBytes) warnings.push('summary の総容量と files.csv の合計が不一致');
  if (summary.hashMode === 'None') warnings.push('ハッシュ未取得: 重複判定と再現性検証ができない');
  if (!summary.contentScan) warnings.push('内容スキャン未実施: 秘密/個人情報はファイル名ベースの検出のみ（-ScanContent での再実行を推奨）');
  return {
    schema: 'livecity-transfer-readiness/v1',
    mission: 42,
    inputGeneratedAtUtc: summary.generatedAtUtc ?? null,
    auditStatus: 'ingested-from-user-supplied-inventory',
    totals: { files: rows.length, bytes: totalBytes, gib: Math.round((totalBytes / 2 ** 30) * 100) / 100 },
    byDecision,
    byStorageTier: byTier,
    bySourceHint: bySource,
    reasonCounts,
    filesWithoutHash: unhashedDupRisk,
    duplicates: summary.duplicates ?? null,
    warnings,
    policy: '全ファイルは user 承認前は公開不可。conditional も承認・出典記録・Phase1 の再現テスト通過後に限り移管候補になる。',
  };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

export function main() {
  const summaryPath = arg('summary'), filesPath = arg('files'), out = arg('out') || DEFAULT_OUT;
  if (!summaryPath || !filesPath) {
    console.error('usage: node tools/audit/ingest-local-inventory.js --summary <summary.json> --files <files.csv> [--out <report.json>]');
    process.exit(2);
  }
  if (/path-map\.local/i.test(summaryPath) || /path-map\.local/i.test(filesPath)) {
    console.error('path-map.local.csv は取り込めません（ローカル専用・共有禁止）。');
    process.exit(2);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8').replace(/^﻿/, ''));
  const rows = parseFilesCsv(fs.readFileSync(filesPath, 'utf8'));
  const cls = JSON.parse(fs.readFileSync(CLASSIFICATION_PATH, 'utf8'));
  const report = evaluateInventory(summary, rows, cls);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`wrote ${out}: files=${report.totals.files} gib=${report.totals.gib} blocked=${report.byDecision.blocked.files} hold=${report.byDecision.hold.files} conditional=${report.byDecision.conditional.files}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
