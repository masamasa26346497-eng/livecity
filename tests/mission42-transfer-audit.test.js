// tests/mission42-transfer-audit.test.js
// Mission 42: 移管前監査（取り込み・ゲート判定・PowerShellスクリプトの読み取り専用性）の回帰テスト。実データ・ネットワーク不使用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFilesCsv, classifyFile, evaluateInventory } from '../tools/audit/ingest-local-inventory.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cls = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/transfer/license-classification.json'), 'utf8'));
const HEADER = 'pathId,ext,sizeBytes,lastWriteUtc,sha256,sourceHint,riskFlags';
const row = (o) => ({ pathId: 'abc', ext: '.gml', sizeBytes: 10, lastWriteUtc: '2026-01-01', sha256: 'x', sourceHint: 'plateau', riskFlags: '', ...o });

test('分類: 自動承認の decision は存在せず、unknown は hold、google は blocked', () => {
  for (const c of Object.values(cls.classes)) assert.ok(['hold', 'conditional', 'blocked'].includes(c.decision));
  assert.equal(cls.classes.unknown.decision, 'hold');
  assert.equal(cls.classes.google.decision, 'blocked');
  assert.equal(cls.classes.ipss.decision, 'hold'); // リポジトリ自身が商用可否「要確認」と記載
});

test('判定: 最も厳しい decision が勝つ（リスクフラグ > 出典 / 複数出典）', () => {
  assert.equal(classifyFile(row({}), cls).decision, 'conditional');
  assert.equal(classifyFile(row({ sourceHint: 'unknown' }), cls).decision, 'hold');
  assert.equal(classifyFile(row({ sourceHint: 'plateau+google' }), cls).decision, 'blocked');
  assert.equal(classifyFile(row({ riskFlags: 'pii-name' }), cls).decision, 'blocked');
  assert.equal(classifyFile(row({ riskFlags: 'content:aws-access-key' }), cls).decision, 'blocked');
  assert.equal(classifyFile(row({ riskFlags: 'weird-new-flag' }), cls).decision, 'hold');
});

test('保存先: conditional のみ層が付与され、サイズで振り分けられる', () => {
  assert.equal(classifyFile(row({ sizeBytes: 1e6 }), cls).tier, 'github-repo');
  assert.equal(classifyFile(row({ sizeBytes: 60e6 }), cls).tier, 'external-object-storage');
  assert.equal(classifyFile(row({ sizeBytes: 3e9 }), cls).tier, 'external-object-storage-multipart');
  assert.equal(classifyFile(row({ sizeBytes: 1e6, sourceHint: 'unknown' }), cls).tier, 'none');
});

test('取り込み: Export-Csv 形式（全項目クォート）を読める', () => {
  const csv = `"pathId","ext","sizeBytes","lastWriteUtc","sha256","sourceHint","riskFlags"\r\n"a1",".gml","5","2026-01-01","","plateau",""\r\n`;
  const rows = parseFilesCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sizeBytes, 5);
});

test('取り込み: パス列の混入・実パスらしき値を拒否する', () => {
  assert.throws(() => parseFilesCsv('pathId,relPath\nabc,C:\\x\\y.gml\n'), /許可されていない列/);
  assert.throws(() => parseFilesCsv(`${HEADER}\nC:\\data\\a,.gml,1,2026-01-01,,plateau,\n`), /パスらしき値/);
  assert.throws(() => parseFilesCsv(`${HEADER}\nabc,.gml,-1,2026-01-01,,plateau,\n`), /sizeBytes/);
  assert.throws(() => parseFilesCsv('pathId,ext\nabc,.gml\n'), /必須列/);
});

test('集計: 件数・容量・警告が整合する', () => {
  const rows = parseFilesCsv([HEADER, 'a,.gml,100,2026-01-01,h1,plateau,', 'b,.csv,50,2026-01-01,,unknown,', 'c,.json,10,2026-01-01,,osm,secret-name'].join('\n'));
  const summary = { schema: 'livecity-local-inventory/v1', hashMode: 'DuplicateCandidates', contentScan: false, totals: { files: 3, bytes: 160 } };
  const rep = evaluateInventory(summary, rows, cls);
  assert.equal(rep.byDecision.conditional.files, 1);
  assert.equal(rep.byDecision.hold.files, 1);
  assert.equal(rep.byDecision.blocked.files, 1);
  assert.equal(rep.totals.bytes, 160);
  assert.ok(rep.warnings.some((w) => w.includes('内容スキャン未実施')));
  assert.throws(() => evaluateInventory({ schema: 'other' }, rows, cls), /未対応/);
});

test('PowerShellインベントリ: 破壊的/通信系コマンドを含まず、OutDirがRoot内を禁止している', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'tools/audit/local-data-inventory.ps1'), 'utf8');
  const body = ps.replace(/<#[\s\S]*?#>/, '').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  for (const bad of ['Remove-Item', 'Move-Item', 'Rename-Item', 'Copy-Item', 'Invoke-WebRequest', 'Invoke-RestMethod', 'Start-BitsTransfer', 'Set-ItemProperty', 'git push', 'curl ', 'wget ']) {
    assert.ok(!body.includes(bad), `禁止コマンド: ${bad}`);
  }
  assert.ok(/OutDir は Root の外側/.test(ps));
  assert.ok(!/Select-Object[^\n]*relPath[^\n]*\|\s*\n?\s*Export-Csv[^\n]*files\.csv/.test(ps));
});

test('files.csv 出力列は relPath を含まない（共有用出力に実パスを出さない）', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'tools/audit/local-data-inventory.ps1'), 'utf8');
  const m = ps.match(/Select-Object (pathId, ext[^|\n]*)\|\s*\n\s*Export-Csv -LiteralPath \(Join-Path \$OutDir 'files\.csv'\)/);
  assert.ok(m, 'files.csv の出力定義が見つからない');
  assert.ok(!m[1].includes('relPath'));
  assert.equal(m[1].split(',').map((s) => s.trim()).join(','), 'pathId,ext,sizeBytes,lastWriteUtc,sha256,sourceHint,riskFlags');
});
