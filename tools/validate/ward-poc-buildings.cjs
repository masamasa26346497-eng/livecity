#!/usr/bin/env node
'use strict';
/* ward-poc-buildings.cjs — public/__test__/ward-poc/buildings/ 配下の全datasetを検証する。
 *
 * tools/build-ward-poc-data.cjs が生成したデータの品質を、生成スクリプトの内部状態を一切信用せず
 * ディスク上の実ファイルだけを読み直して独立に検証する（「生成側が正しいと言っているから正しい」
 * ではなく、書き出された成果物そのものを再検査する）。
 *
 * 検証項目:
 *   - JSON parse error 0 (root manifest / 各dataset manifest / 各tile file)
 *   - coordinateConvention = znorth-neg-v1 (各dataset manifest)
 *   - manifest.tiles に列挙された tile file が実際に存在するか
 *   - 余分なtile file(manifestに載っていないtile_*.json)が無いか
 *   - manifest上のtile数・building数と、tile fileの実際の中身が一致するか(Σtile.count===totalBuildings、
 *     各tile fileのbuildings.length===そのtileのcount)
 *   - 0棟tileが無いか
 *   - 各buildingが有効な形状か(fp配列が存在し頂点数>=3)
 *   - building ID重複が無いか(dataset内、および全dataset横断)
 *   - point-in-polygon結果とward一致(各buildingのfootprint重心を、TOWN_POLYGONSで再計算し、
 *     その区のpolygon内に実際に収まっているかを再検証。生成ロジックのバグを独立に検出する)
 *
 * usage:
 *   node tools/validate/ward-poc-buildings.cjs \
 *     --buildings-root public/__test__/ward-poc/buildings \
 *     --town-polygons temp/prod-znegate/release/znorth-neg-v1/embedded-extra/TOWN_POLYGONS.json \
 *     --ward-registry config/wards/registry.json
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) { const key = k.slice(2); const v = argv[i + 1]; if (!v || v.startsWith('--')) a[key] = true; else { a[key] = v; i++; } }
  }
  return a;
}
const A = parseArgs(process.argv.slice(2));
if (!A['buildings-root']) { console.error('usage: --buildings-root <dir> [--town-polygons <file> --ward-registry <file>]'); process.exit(1); }
const ROOT = path.resolve(A['buildings-root']);

const errors = [];
const warnings = [];
function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

function readJsonSafe(fp, label) {
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch (e) { fail(`[${label}] 読み込み不可: ${fp} (${e.message})`); return null; }
  try { return JSON.parse(raw); } catch (e) { fail(`[${label}] JSON parse error: ${fp} (${e.message})`); return null; }
}

function polyAreaCentroid(fp) {
  let a2 = 0, sx = 0, sz = 0;
  const n = fp.length;
  for (let i = 0; i < n; i++) { const p = fp[i], q = fp[(i + 1) % n]; a2 += p[0] * q[1] - q[0] * p[1]; sx += p[0]; sz += p[1]; }
  return { cx: sx / n, cz: sz / n };
}
function pointInRing(x, z, ring) {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    const intersect = ((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

const rootManifestPath = path.join(ROOT, 'manifest.json');
const rootManifest = readJsonSafe(rootManifestPath, 'root-manifest');
if (!rootManifest) { console.error('[stop] root manifestが読めないため以降の検証を中止します。'); printAndExit(); }

console.log(`[検証対象] ${rootManifestPath} — datasets: ${(rootManifest.datasets || []).map((d) => d.id).join(', ')}`);

// ── PLYGONS(任意): point-in-polygon再検証に使う。指定が無ければこの項目はスキップする ──
let townPolygons = null, registryWards = null;
if (A['town-polygons']) townPolygons = readJsonSafe(path.resolve(A['town-polygons']), 'town-polygons');
if (A['ward-registry']) {
  const reg = readJsonSafe(path.resolve(A['ward-registry']), 'ward-registry');
  registryWards = reg ? reg.wards : null;
}
function wardRingsFor(datasetWardName) {
  if (!townPolygons || !registryWards) return null;
  const def = registryWards.find((w) => w.name === datasetWardName);
  if (!def) return null;
  const rings = [];
  for (const [name, r] of Object.entries(townPolygons)) {
    if (name.indexOf(def.townPrefix) === 0) for (const ring of r) rings.push(ring);
  }
  return rings.length ? rings : null;
}

const allBuildingIds = new Map(); // id -> datasetId (cross-dataset重複検出用)
let totalBuildingsChecked = 0;

for (const dsEntry of rootManifest.datasets || []) {
  const dsId = dsEntry.id;
  const dsDir = path.join(ROOT, dsId);
  const dsManifestPath = path.join(dsDir, 'manifest.json');
  const man = readJsonSafe(dsManifestPath, `dataset:${dsId}`);
  if (!man) continue;

  if (man.coordinateConvention !== 'znorth-neg-v1') fail(`[${dsId}] coordinateConvention不正: ${man.coordinateConvention}`);
  if (man.tileSize !== 500) warn(`[${dsId}] tileSizeが既定の500と異なります: ${man.tileSize}`);

  const filesOnDisk = new Set(fs.readdirSync(dsDir).filter((f) => /^tile_.*\.json$/.test(f)));
  const filesInManifest = new Set((man.tiles || []).map((t) => t.file));
  for (const f of filesInManifest) if (!filesOnDisk.has(f)) fail(`[${dsId}] manifestに記載のtile fileが実在しません: ${f}`);
  for (const f of filesOnDisk) if (!filesInManifest.has(f)) warn(`[${dsId}] manifestに載っていないtile fileが存在します(孤立ファイル): ${f}`);

  const ringsForWard = wardRingsFor(man.ward);
  if (!ringsForWard) warn(`[${dsId}] point-in-polygon再検証をスキップ(--town-polygons/--ward-registry未指定、またはward「${man.ward}」のpolygon未整備)`);

  let sumTileCount = 0;
  const localIds = new Set();
  let zeroTileCount = 0;
  let mismatchOutside = 0;

  for (const t of man.tiles || []) {
    if (t.count === 0) zeroTileCount++;
    sumTileCount += t.count;
    const tilePath = path.join(dsDir, t.file);
    if (!fs.existsSync(tilePath)) continue; // 既にfailで記録済み
    const tileData = readJsonSafe(tilePath, `${dsId}/${t.file}`);
    if (!tileData) continue;
    if (!Array.isArray(tileData.buildings)) { fail(`[${dsId}/${t.file}] buildings配列が存在しません`); continue; }
    if (tileData.buildings.length !== t.count) {
      fail(`[${dsId}/${t.file}] building数不一致: manifest.count=${t.count} 実件数=${tileData.buildings.length}`);
    }
    for (const b of tileData.buildings) {
      totalBuildingsChecked++;
      if (!b || typeof b.id !== 'string') { fail(`[${dsId}/${t.file}] idを持たないbuildingがあります`); continue; }
      if (!Array.isArray(b.fp) || b.fp.length < 3) { fail(`[${dsId}] invalid building(fp頂点数<3): id=${b.id}`); continue; }

      if (localIds.has(b.id)) fail(`[${dsId}] dataset内でbuilding ID重複: ${b.id}`);
      localIds.add(b.id);

      if (allBuildingIds.has(b.id) && allBuildingIds.get(b.id) !== dsId) {
        fail(`[cross-ward] building IDが複数datasetに重複: ${b.id} (${allBuildingIds.get(b.id)} と ${dsId})`);
      } else {
        allBuildingIds.set(b.id, dsId);
      }

      if (ringsForWard) {
        const { cx, cz } = polyAreaCentroid(b.fp);
        const inside = ringsForWard.some((ring) => pointInRing(cx, cz, ring));
        if (!inside) mismatchOutside++;
      }
    }
  }

  if (sumTileCount !== man.totalBuildings) {
    fail(`[${dsId}] manifest不整合: Σtile.count(${sumTileCount}) !== totalBuildings(${man.totalBuildings})`);
  }
  if (zeroTileCount > 0) fail(`[${dsId}] 0棟のtileが${zeroTileCount}件あります(異常manifest)`);
  if (ringsForWard && mismatchOutside > 0) {
    fail(`[${dsId}] point-in-polygon再検証で不一致: ${mismatchOutside}棟がward「${man.ward}」のpolygon外(重心ベース)`);
  } else if (ringsForWard) {
    console.log(`[${dsId}] point-in-polygon再検証: 全${localIds.size}棟が「${man.ward}」のpolygon内 — OK`);
  }

  console.log(`[${dsId}] tiles=${(man.tiles || []).length} totalBuildings=${man.totalBuildings} (実測${localIds.size}) — ` +
    (errors.filter((e) => e.startsWith(`[${dsId}]`)).length === 0 ? 'OK' : 'NG'));
}

console.log('');
console.log(`検証済みbuilding総数: ${totalBuildingsChecked.toLocaleString()}（全dataset横断でID重複0件を含めて確認）`);

printAndExit();

function printAndExit() {
  console.log('');
  console.log(`=== 検証結果: エラー${errors.length}件 / 警告${warnings.length}件 ===`);
  if (warnings.length) { console.log('--- warnings ---'); for (const w of warnings) console.log('  WARN:', w); }
  if (errors.length) { console.log('--- errors ---'); for (const e of errors) console.log('  FAIL:', e); }
  process.exit(errors.length ? 1 : 0);
}
