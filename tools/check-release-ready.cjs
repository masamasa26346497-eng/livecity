#!/usr/bin/env node
'use strict';
/* check-release-ready.cjs — production-cutover.ps1 が必ず通すゲート。
 * RELEASE_READY.json が存在し、
 *   (a) files に記録された各ファイル(HTML/dataset manifest/root manifest/overlay)のSHA256が実ファイルと一致
 *   (b) tilesDigest/tileFiles を release-root から再計算した結果が READY の記録と完全一致
 *       （tileCountの一致だけでは不十分。1タイルの内容改ざん・差替も検出する）
 * の両方を満たす場合のみ exit 0。それ以外は理由を出力して exit 1。
 * usage: node tools/check-release-ready.cjs --release-root <dir> [--ready <file>] */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { computeTilesDigest } = require('./lib/tiles-digest.cjs');
function parseArgs(argv) { const a = {}; for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k.startsWith('--')) { const v = argv[i + 1]; if (!v || v.startsWith('--')) a[k.slice(2)] = true; else { a[k.slice(2)] = v; i++; } } } return a; }
const A = parseArgs(process.argv.slice(2));
if (!A['release-root'] || A['release-root'] === true) { console.error('usage: --release-root <dir> [--ready <file>]'); process.exit(1); }
const RELROOT = path.resolve(A['release-root']);
const READY = path.resolve(A.ready && A.ready !== true ? A.ready : path.join(RELROOT, 'RELEASE_READY.json'));
const fail = (msg) => { console.error('[cutover-gate NG]', msg); process.exit(1); };
if (!fs.existsSync(READY)) fail('RELEASE_READY.json が存在しない: ' + READY);
let ready;
try { ready = JSON.parse(fs.readFileSync(READY, 'utf8')); } catch (e) { fail('READYがJSONとして読めない: ' + e.message); }
for (const k of ['releaseId', 'buildId', 'coordinateConvention', 'dataset', 'buildings', 'tileCount', 'files', 'tilesDigest', 'tileFiles', 'verifiedAt']) {
  if (!(k in ready)) fail('READYに必須フィールドが無い: ' + k);
}
if (ready.coordinateConvention !== 'znorth-neg-v1') fail('規約が不正: ' + ready.coordinateConvention);
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// (a) files（HTML/dataset manifest/root manifest/overlay）
for (const [rel, expect] of Object.entries(ready.files)) {
  const p = path.join(RELROOT, rel);
  if (!fs.existsSync(p)) fail('対象ファイルが無い: ' + p);
  const got = sha256(p);
  if (got !== expect) fail(`ハッシュ不一致: ${rel}\n  READY: ${expect}\n  実測 : ${got}`);
}

// (b) タイル本体の全体digest再計算（tileCount一致だけでは許可しない）
const tilesDir = path.join(RELROOT, 'buildings', ready.dataset);
let recomputed;
try { recomputed = computeTilesDigest(tilesDir, ready.dataset); }
catch (e) { fail('タイルdigest再計算に失敗: ' + e.message); }
if (recomputed.count !== ready.tileFiles.length) {
  fail(`タイル数不一致: 実ファイル${recomputed.count}件 / READY記録${ready.tileFiles.length}件`);
}
if (recomputed.count !== ready.tileCount) {
  fail(`タイル数がREADY.tileCountと不一致: 実ファイル${recomputed.count}件 / tileCount=${ready.tileCount}`);
}
if (recomputed.tilesDigest !== ready.tilesDigest) {
  // どのタイルが原因か特定できるよう差分を報告
  const expByPath = new Map(ready.tileFiles.map((t) => [t.relativePath, t.sha256]));
  const gotByPath = new Map(recomputed.tileFiles.map((t) => [t.relativePath, t.sha256]));
  const mismatched = [];
  for (const [rp, exp] of expByPath) { const got = gotByPath.get(rp); if (got === undefined) mismatched.push(`欠落: ${rp}`); else if (got !== exp) mismatched.push(`改ざん: ${rp} (READY=${exp.slice(0, 12)}… 実測=${got.slice(0, 12)}…)`); }
  for (const rp of gotByPath.keys()) if (!expByPath.has(rp)) mismatched.push(`未記録の余剰ファイル: ${rp}`);
  fail(`タイルdigest不一致(tilesDigest)。詳細:\n  ${mismatched.slice(0, 10).join('\n  ')}${mismatched.length > 10 ? `\n  ...他${mismatched.length - 10}件` : ''}`);
}

console.log('[cutover-gate OK] releaseId=%s buildId=%s buildings=%s tiles=%s files=%d tilesDigest=%s verifiedAt=%s',
  ready.releaseId, ready.buildId, ready.buildings, ready.tileCount, Object.keys(ready.files).length, ready.tilesDigest.slice(0, 16) + '…', ready.verifiedAt);
process.exit(0);
