#!/usr/bin/env node
'use strict';
/* audit-tiles.cjs v2 — remoteタイル群の読み取り専用監査。
 * allOk に含む検証:
 *   - manifest.tiles のファイル名集合 ↔ 実ファイル集合の完全一致（双方向）
 *   - 各tile: ファイル名のtx/tz = 本体のtx/tz = manifest記録、count = buildings.length = manifest記録
 *   - Σcount / ユニークID / invalid / dup が manifest.totalBuildings と整合（invalid=0, dup=0）
 *   - root manifest の該当dataset記録（件数/タイル数）との一致
 *   - coordinateConvention が既に znorth-neg-v1 なら停止（既移行の疑い）
 * usage: node tools/audit-tiles.cjs --project-root <root> --dataset <id>
 *        [--buildings-root <root>/public/data/buildings] [--out <root>/temp/...json] */
const fs = require('fs');
const path = require('path');
const G = require('./lib/io-guard.cjs');
const A = G.parseArgs(process.argv.slice(2));
const ROOT = G.requireProjectRoot(A);
const DATASET = A.dataset;
if (!DATASET || DATASET === true) { console.error('usage: --project-root <dir> --dataset <id> [--buildings-root <dir>] [--out <file>]'); process.exit(1); }
const BROOT = path.resolve(A['buildings-root'] && A['buildings-root'] !== true ? A['buildings-root'] : path.join(ROOT, 'public', 'data', 'buildings'));
const dir = path.join(BROOT, DATASET);
const manifestPath = path.join(dir, 'manifest.json');
if (!fs.existsSync(manifestPath)) { console.error('[stop] dataset manifest が無い:', manifestPath); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const rootManifestPath = path.join(BROOT, 'manifest.json');
const rootManifest = fs.existsSync(rootManifestPath) ? JSON.parse(fs.readFileSync(rootManifestPath, 'utf8')) : null;

const actualFiles = fs.readdirSync(dir).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f)).sort();
const manifestTiles = manifest.tiles || [];
const manifestFiles = manifestTiles.map((t) => t.file).sort();
const setA = new Set(actualFiles), setM = new Set(manifestFiles);
const onlyActual = actualFiles.filter((f) => !setM.has(f));
const onlyManifest = manifestFiles.filter((f) => !setA.has(f));

const ids = new Set(); let dup = 0, invalid = 0, sum = 0, perTileMismatch = 0;
const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
const entryByFile = new Map(manifestTiles.map((t) => [t.file, t]));
for (const f of actualFiles) {
  const m = f.match(/^tile_(-?\d+)_(-?\d+)\.json$/);
  const ftx = parseInt(m[1], 10), ftz = parseInt(m[2], 10);
  const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const entry = entryByFile.get(f);
  const blds = t.buildings || [];
  const okTile = t.tx === ftx && t.tz === ftz && (!entry || (entry.tx === ftx && entry.tz === ftz && entry.count === blds.length)) && t.count === blds.length;
  if (!okTile) perTileMismatch++;
  for (const b of blds) {
    sum++;
    if (!b || !b.id || !Array.isArray(b.fp) || b.fp.length < 3 || b.fp.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) { invalid++; continue; }
    if (ids.has(b.id)) { dup++; continue; }
    ids.add(b.id);
    for (const p of b.fp) { if (p[0] < bounds.minX) bounds.minX = p[0]; if (p[0] > bounds.maxX) bounds.maxX = p[0]; if (p[1] < bounds.minZ) bounds.minZ = p[1]; if (p[1] > bounds.maxZ) bounds.maxZ = p[1]; }
  }
}
// root manifest 側の該当dataset記録
let rootEntryOk = false, rootEntry = null;
if (rootManifest && Array.isArray(rootManifest.datasets)) {
  rootEntry = rootManifest.datasets.find((d) => d.id === DATASET) || null;
  if (rootEntry) {
    const rb = rootEntry.buildings != null ? rootEntry.buildings : rootEntry.totalBuildings;
    const rt = rootEntry.tiles != null ? rootEntry.tiles : rootEntry.tileCount;
    rootEntryOk = (rb == null || rb === manifest.totalBuildings) && (rt == null || rt === manifest.tileCount);
  }
}
const convDataset = manifest.coordinateConvention || null;
const convRoot = rootManifest ? (rootManifest.coordinateConvention || null) : null;
const checks = {
  fileSetsIdentical: onlyActual.length === 0 && onlyManifest.length === 0 && actualFiles.length === manifest.tileCount,
  perTileTxTzCountMatch: perTileMismatch === 0,
  sumEqualsTotal: sum === manifest.totalBuildings,
  uniqueEqualsTotal: ids.size === manifest.totalBuildings,
  invalidZero: invalid === 0,
  dupZero: dup === 0,
  rootManifestEntryMatch: rootEntryOk,
  notAlreadyMigrated: convDataset !== 'znorth-neg-v1' && convRoot !== 'znorth-neg-v1',
};
const report = {
  dataset: DATASET,
  manifest: { totalBuildings: manifest.totalBuildings, tileCount: manifest.tileCount, coordinateConvention: convDataset, bounds: manifest.bounds },
  rootManifest: { present: !!rootManifest, entry: rootEntry, coordinateConvention: convRoot },
  scanned: { tileFiles: actualFiles.length, sumCount: sum, uniqueIds: ids.size, invalid, dup, perTileMismatch, onlyActual: onlyActual.slice(0, 5), onlyManifest: onlyManifest.slice(0, 5), bounds },
  checks, heapMB: G.memMB(),
};
console.log(JSON.stringify(report, null, 2));
const allOk = Object.values(checks).every(Boolean);
console.log('\nSTEP0 判定:', allOk ? 'OK' : 'NG（停止条件該当: ' + Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', ') + '）');
if (A.out && A.out !== true) { G.assertSafeOutput(ROOT, manifestPath, A.out); G.writeNoOverwrite(A.out, JSON.stringify(report, null, 2)); }
process.exit(allOk ? 0 : 1);
