#!/usr/bin/env node
// Mission 133: 24区受入表の生成（読み取り専用・ネットワーク不使用）。
//   node tools/verify-ward-layers.js --http                      # 先に在庫/HTTPを検査
//   node tools/mission133-acceptance.js [--browser <browser-results.json>]
// browser-results.json: { "<wardKey>": { buildings:{pixelDiff,pass}, roads:{...}, water:{...}, clickId, fps, memoryMB, alignment:{pass} } }
// 出力: data/reports/mission116/ward-acceptance-table.{json,md}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcceptanceTable, renderMarkdown } from './lib/acceptance-table.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'data/reports/mission116');
let browserFile = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i] === '--browser') browserFile = path.resolve(argv[++i]);

const vf = path.join(dir, 'ward-layer-verification.json');
if (!fs.existsSync(vf)) { console.error('先に node tools/verify-ward-layers.js を実行してください'); process.exit(2); }
const verify = JSON.parse(fs.readFileSync(vf, 'utf8'));
const browser = browserFile ? JSON.parse(fs.readFileSync(browserFile, 'utf8')) : {};
const table = buildAcceptanceTable(verify.results, browser);
fs.writeFileSync(path.join(dir, 'ward-acceptance-table.json'), JSON.stringify(table, null, 2));
const md = renderMarkdown(table);
fs.writeFileSync(path.join(dir, 'ward-acceptance-table.md'), md);
console.log(md);
if (!table.allVerified) process.exitCode = 1;
