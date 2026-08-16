#!/usr/bin/env node
'use strict';
/* stamp-convention.cjs — split-building-tiles.js が生成した release用 manifest（temp配下の自ビルド生成物）へ
 * coordinateConvention: "znorth-neg-v1" を追記する。既に付与済み・temp外・非manifestは停止。
 * usage: node tools/stamp-convention.cjs --project-root <dir> --manifest <path> [--manifest <path> ...]
 * （唯一の in-place 修正ツール。対象は <ProjectRoot>/temp/ 内の manifest.json のみに限定） */
const fs = require('fs');
const path = require('path');
const G = require('./lib/io-guard.cjs');
const CONV = 'znorth-neg-v1';
const argv = process.argv.slice(2);
const A = G.parseArgs(argv);
const ROOT = G.requireProjectRoot(A);
const targets = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--manifest' && argv[i + 1]) targets.push(path.resolve(argv[++i]));
if (!targets.length) { console.error('usage: --project-root <dir> --manifest <file> [...]'); process.exit(1); }
const tempRoot = path.join(ROOT, 'temp');
for (const p of targets) {
  if (!G.insideOrEqual(tempRoot, p)) { console.error('[stop] temp配下以外のmanifestは修正しない:', p); process.exit(2); }
  if (path.basename(p) !== 'manifest.json') { console.error('[stop] manifest.json 以外は対象外:', p); process.exit(2); }
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (m.coordinateConvention === CONV) { console.error('[stop] 既に付与済み:', p); process.exit(2); }
  m.coordinateConvention = CONV;
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
  console.log('stamped:', p);
}
