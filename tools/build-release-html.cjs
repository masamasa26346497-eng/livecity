#!/usr/bin/env node
'use strict';
/* build-release-html.cjs — staging HTML（規約ガード+geoToThree反転済み）を基に、
 * BUILD_ID と basePath 群を release パスへ置換した release用HTML を生成する。
 * 置換（4点・全て存在必須）:
 *   LIVE_CITY_BUILD_ID = 'multiward-overlay-v1'         → '<buildId>'
 *   basePath: 'data/buildings',                          → 'data/buildings/releases/<releaseId>',
 *   rootManifest: 'data/buildings/manifest.json',        → 'data/buildings/releases/<releaseId>/manifest.json',
 *   basePath: 'data/overlays',                           → 'data/overlays/releases/<releaseId>',
 * usage: node tools/build-release-html.cjs --project-root <dir> --html <staging html> --out <release html> \
 *          --release-id <id> --build-id <id> */
const fs = require('fs');
const path = require('path');
const G = require('./lib/io-guard.cjs');
const A = G.parseArgs(process.argv.slice(2));
const ROOT = G.requireProjectRoot(A);
for (const k of ['html', 'out', 'release-id', 'build-id']) if (!A[k] || A[k] === true) { console.error('missing --' + k); process.exit(1); }
const SRC = path.resolve(A.html), DST = path.resolve(A.out);
G.assertSafeOutput(ROOT, SRC, DST);
let html = fs.readFileSync(SRC, 'utf8');
const rid = A['release-id'], bid = A['build-id'];
const rules = [
  ["LIVE_CITY_BUILD_ID = 'multiward-overlay-v1'", `LIVE_CITY_BUILD_ID = '${bid}'`],
  ["basePath: 'data/buildings',", `basePath: 'data/buildings/releases/${rid}',`],
  ["rootManifest: 'data/buildings/manifest.json',", `rootManifest: 'data/buildings/releases/${rid}/manifest.json',`],
  ["basePath: 'data/overlays',", `basePath: 'data/overlays/releases/${rid}',`],
];
for (const [from, to] of rules) {
  if (!html.includes(from)) { console.error('[stop] 置換元が見つからない:', from); process.exit(4); }
  html = html.split(from).join(to);
}
for (const [from] of rules) if (html.includes(from)) { console.error('[stop] 旧文字列が残存:', from); process.exit(4); }
G.writeNoOverwrite(DST, html);
console.log('release HTML 生成:', DST, `(BUILD_ID=${bid}, release=${rid})`);
