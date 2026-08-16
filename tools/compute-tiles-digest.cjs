#!/usr/bin/env node
'use strict';
/* compute-tiles-digest.cjs — tiles-digest.cjs のCLIラッパー。
 * production-cutover.ps1 はこれを `node tools/compute-tiles-digest.cjs ... --json` で呼び出し、
 * verify-production-release.cjs / check-release-ready.cjs と完全に同一のNodeロジックで
 * public releases 側のタイルdigestを再計算する（PowerShellでの再実装によるアルゴリズム相違を排除）。
 * usage: node tools/compute-tiles-digest.cjs --tiles-dir <dir> --dataset <id> [--json] */
const { computeTilesDigest } = require('./lib/tiles-digest.cjs');
function parseArgs(argv) { const a = {}; for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k.startsWith('--')) { const v = argv[i + 1]; if (!v || v.startsWith('--')) a[k.slice(2)] = true; else { a[k.slice(2)] = v; i++; } } } return a; }
const A = parseArgs(process.argv.slice(2));
if (!A['tiles-dir'] || A['tiles-dir'] === true || !A.dataset || A.dataset === true) {
  console.error('usage: --tiles-dir <dir> --dataset <id> [--json]');
  process.exit(1);
}
try {
  const r = computeTilesDigest(A['tiles-dir'], A.dataset);
  if (A.json) { console.log(JSON.stringify(r)); }
  else { console.log(r.tilesDigest, 'tiles=' + r.count); }
  process.exit(0);
} catch (e) {
  console.error('[stop]', e.message);
  process.exit(1);
}
