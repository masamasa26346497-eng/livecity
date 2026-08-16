#!/usr/bin/env node
'use strict';
/* build-ward-poc-data.cjs — Ward Mode PoC専用データセット生成ツール（v2: Ward Registry駆動）。
 *
 * 【v2での変更点】
 * v1は住吉区・東住吉区の2区をスクリプト内にハードコードしていたが、大阪市24区への拡張に伴い、
 * config/wards/registry.json（Ward Registry、24区分の id/name/kana/code/townPrefix/datasetId）を
 * 読み込んで対象区を決定する方式に変更した。スクリプト本体を区ごとに書き換える必要はなくなった。
 *
 * 【区が「生成対象」になる条件（自動判定・ハードコードなし）】
 *   1. Ward Registryに載っている
 *   2. --town-polygons のキーに、その区のtownPrefixで始まるものが1件以上ある
 *      （TOWN_POLYGONSに実際の町丁目境界データが無い区は、Registryに載っていても自動的に対象外＝
 *       「実データ・polygonが存在しない区を無理に生成しない」をコード側で保証する）
 *   さらに --only <id1,id2,...> を指定すると、上記の条件を満たす区のうち指定IDのみに絞り込む
 *   （既存datasetへ新しい区を追加する際、対象区を明示して誤爆を防ぐために使う）。
 *
 * 【分類方法】STEP1
 *   行政区ポリゴン（TOWN_POLYGONS実データ）による座標判定のみを正本とする。building.ward属性は
 *   一切、分類の拒否条件・ルーティング条件に使用しない（診断記録専用）。
 *
 *   1. footprint重心がちょうど1つの対象区polygon内            → その区
 *   2. footprint重心が複数の対象区polygonに同時ヒット          → ambiguous
 *   3. footprint重心がどの対象区polygonにもヒットしない        → outsideTarget
 *      （不正データ: fp欠落・頂点数<3等で重心を計算できない建物も、
 *       行政区を確認しようがないため outsideTarget に算入する。件数は別途内訳表示する）
 *   4. 重心がいずれかの区に解決した場合、footprint全頂点についても同じ判定を行い、
 *      頂点のいずれかが重心と異なる区分類になれば → boundaryStraddle（区境界をまたぐ。除外）
 *
 *   building.ward / building.town は診断専用。座標分類との一致・不一致を
 *   wardAttrMatch / wardAttrMismatch として記録するのみで、不一致でも分類には一切影響しない。
 *
 *   恒等式: Σ(各区の件数) + outsideTarget + boundaryStraddle + ambiguous = 入力総数
 *
 * 【高速化】
 *   各行政区のpolygon群のbbox(minX,maxX,minZ,maxZ)を事前計算し、判定対象の点がbbox外であれば
 *   point-in-polygon（pointInRingのO(頂点数)ループ）を一切実行しない。
 *
 * 【出力先の安全制約】
 *   public/__test__/ward-poc/ 配下、または temp/ 配下にのみ書き込みを許可する。
 *   production releases (public/data/buildings/releases/znorth-neg-v1/等)へは
 *   絶対に書き込めない（ハードコードされた拒否リストで二重に保護）。
 *
 * 【既存datasetの非破壊性】
 *   区単位のmanifest.json・tile_*.jsonは、既に存在するファイルへの上書きを常に拒否する
 *   （＝一度生成した区は、このツールの再実行では変更されない）。
 *   root manifest.json（datasets一覧）のみ、新規追加分だけをマージする特別扱いとする
 *   （既存datasetエントリの内容は一切変更せず、末尾に新しいdatasetを追記するだけ。
 *    追加しようとしたdatasetIdが既にroot manifestへ登録済みの場合は安全側に倒して停止する）。
 *
 * usage:
 *   node tools/build-ward-poc-data.cjs \
 *     --project-root <dir> \
 *     --source-jsonl <znorth-neg-v1建物JSONL> \
 *     --town-polygons <TOWN_POLYGONS.json (znorth-neg-v1変換済み、同一jsonファイル)> \
 *     --ward-registry config/wards/registry.json \
 *     --out public/__test__/ward-poc/buildings \
 *     [--only hirano,abeno] \
 *     [--dry-run|--apply]
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) { const key = k.slice(2); const v = argv[i + 1]; if (!v || v.startsWith('--')) a[key] = true; else { a[key] = v; i++; } }
  }
  return a;
}
const A = parseArgs(process.argv.slice(2));
const MODE = A.apply ? 'apply' : 'dry-run';

if (!A['project-root'] || !A['source-jsonl'] || !A['town-polygons'] || !A['ward-registry'] || !A.out) {
  console.error('usage: --project-root <dir> --source-jsonl <file> --town-polygons <file> --ward-registry <file> --out <dir> [--only id1,id2] [--dry-run|--apply]');
  process.exit(1);
}
const ROOT = path.resolve(A['project-root']);
if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) { console.error('[stop] --project-root が不正:', ROOT); process.exit(2); }

// ── 出力先の安全ガード（public/__test__/ward-poc/ または temp/ のみ許可。二重の拒否リストで保護） ──
const OUT = path.resolve(A.out);
const ALLOWED_ROOTS = [path.join(ROOT, 'public', '__test__', 'ward-poc'), path.join(ROOT, 'temp')];
const HARD_DENY = [
  path.join(ROOT, 'public', 'data', 'buildings', 'releases'),
  path.join(ROOT, 'public', 'data', 'overlays', 'releases'),
  path.join(ROOT, 'public', 'data', 'buildings'),
  path.join(ROOT, 'public', 'osaka_3d_buildings.html'),
];
function insideOrEqual(parent, child) { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }
for (const deny of HARD_DENY) {
  if (insideOrEqual(deny, OUT) || insideOrEqual(OUT, deny)) { console.error('[stop] 出力先がproduction領域と重なっています(拒否リスト):', deny); process.exit(2); }
}
if (!ALLOWED_ROOTS.some((r) => insideOrEqual(r, OUT))) {
  console.error('[stop] 出力先は public/__test__/ward-poc/ または temp/ 配下のみ許可:', OUT);
  console.error('  許可リスト:', ALLOWED_ROOTS.join(', '));
  process.exit(2);
}

// ── 幾何関数（既存コードと同一のアルゴリズム。新規発明なし） ──
function polyAreaCentroid(fp) {
  let a2 = 0, sx = 0, sz = 0;
  const n = fp.length;
  for (let i = 0; i < n; i++) { const p = fp[i], q = fp[(i + 1) % n]; a2 += p[0] * q[1] - q[0] * p[1]; sx += p[0]; sz += p[1]; }
  return { area: Math.abs(a2) / 2, cx: sx / n, cz: sz / n };
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

// ── Ward Registryを読み込み、TOWN_POLYGONSに実際に町丁目境界データがある区だけを対象にする ──
const townPolygons = JSON.parse(fs.readFileSync(path.resolve(A['town-polygons']), 'utf8'));
const registryRaw = JSON.parse(fs.readFileSync(path.resolve(A['ward-registry']), 'utf8'));
const registryWards = registryRaw.wards || [];
const onlyFilter = (typeof A.only === 'string') ? new Set(A.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;

const townKeysByPrefix = (prefix) => Object.keys(townPolygons).filter((k) => k.indexOf(prefix) === 0);

const WARD_DEFS = [];
const skippedNoPolygon = [];
const skippedNotInOnlyFilter = [];
for (const w of registryWards) {
  if (onlyFilter && !onlyFilter.has(w.id)) { skippedNotInOnlyFilter.push(w.id); continue; }
  const townKeys = townKeysByPrefix(w.townPrefix);
  if (townKeys.length === 0) { skippedNoPolygon.push(w.id); continue; }
  WARD_DEFS.push({ id: w.id, name: w.name, townPrefix: w.townPrefix, wardCode: w.code || null, datasetId: w.datasetId, townCount: townKeys.length });
}
console.log(`[build-ward-poc-data] Ward Registry: ${registryWards.length}区中、対象=${WARD_DEFS.length}区` +
  (skippedNoPolygon.length ? ` / TOWN_POLYGONS未整備でスキップ=${skippedNoPolygon.length}区(${skippedNoPolygon.join(',')})` : '') +
  (skippedNotInOnlyFilter.length ? ` / --onlyで除外=${skippedNotInOnlyFilter.length}区` : ''));
if (WARD_DEFS.length === 0) {
  console.error('[stop] 対象区が0件です（--onlyの指定、またはTOWN_POLYGONSのtownPrefix整備状況を確認してください）。');
  process.exit(2);
}

const wardRings = {};
const wardBBox = {}; // ── 高速化: 行政区ごとのbbox事前計算 ──
for (const w of WARD_DEFS) {
  wardRings[w.id] = [];
  for (const [name, rings] of Object.entries(townPolygons)) {
    if (name.indexOf(w.townPrefix) === 0) for (const ring of rings) wardRings[w.id].push(ring);
  }
  const bbox = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const ring of wardRings[w.id]) {
    for (const p of ring) {
      if (p[0] < bbox.minX) bbox.minX = p[0]; if (p[0] > bbox.maxX) bbox.maxX = p[0];
      if (p[1] < bbox.minZ) bbox.minZ = p[1]; if (p[1] > bbox.maxZ) bbox.maxZ = p[1];
    }
  }
  wardBBox[w.id] = bbox;
  console.log(`[build-ward-poc-data] ${w.name}: town数=${w.townCount} ring数=${wardRings[w.id].length} bbox=${JSON.stringify(bbox)}`);
}
// bbox外はpoint-in-polygonを一切実行しない（高速化）
function pointInWard(x, z, wardId) {
  const bbox = wardBBox[wardId];
  if (x < bbox.minX || x > bbox.maxX || z < bbox.minZ || z > bbox.maxZ) return false; // bbox即時棄却
  for (const ring of wardRings[wardId]) { if (pointInRing(x, z, ring)) return true; }
  return false;
}
// 点(x,z)がどの対象区に属するか('<wardId>'|'ambiguous'|'outsideTarget')。複数区に同時ヒットしたらambiguous。
function classifyPoint(x, z) {
  let hit = null, hitCount = 0;
  for (const w of WARD_DEFS) {
    if (pointInWard(x, z, w.id)) { hit = w.id; hitCount++; if (hitCount > 1) return 'ambiguous'; }
  }
  return hitCount === 1 ? hit : 'outsideTarget';
}

// ── building.ward属性 → 診断専用の対象区マッピング（分類には一切使用しない） ──
function attrImpliesTarget(wardStr) {
  const w = WARD_DEFS.find((d) => d.name === wardStr);
  return w ? w.id : null; // 対象区以外・未定義は「対象区ではない」= null
}

// ── STEP1: 分類本体 ──
async function classifyAll() {
  const buckets = { outsideTarget: [], boundaryStraddle: [], ambiguous: [] };
  for (const w of WARD_DEFS) buckets[w.id] = [];
  let total = 0, invalidCountedAsOutsideTarget = 0;
  let hasWardAttr = 0, wardAttrMatch = 0, wardAttrMismatch = 0;
  const mismatchSamples = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path.resolve(A['source-jsonl']), { encoding: 'utf8' }) });
  for await (const line of rl) {
    const s = line.trim(); if (!s) continue;
    const b = JSON.parse(s);
    total++;

    // 不正データ(fp欠落・頂点数<3等)は行政区を判定しようがないため outsideTarget へ算入する
    if (!b || !Array.isArray(b.fp) || b.fp.length < 3) {
      buckets.outsideTarget.push(b);
      invalidCountedAsOutsideTarget++;
      continue;
    }

    const { cx, cz } = polyAreaCentroid(b.fp);
    let bucket = classifyPoint(cx, cz);

    // 重心がいずれかの対象区に解決した場合のみ、footprint全頂点の境界またぎを検証
    if (bucket !== 'outsideTarget' && bucket !== 'ambiguous') {
      let straddles = false;
      for (const p of b.fp) {
        if (classifyPoint(p[0], p[1]) !== bucket) { straddles = true; break; }
      }
      if (straddles) bucket = 'boundaryStraddle';
    }

    buckets[bucket].push(b);

    // [診断専用] building.ward属性と座標判定の一致検査。不一致でも分類(bucket)には一切影響しない。
    if (Object.prototype.hasOwnProperty.call(b, 'ward')) {
      hasWardAttr++;
      const attrTarget = attrImpliesTarget(b.ward);
      const coordTarget = WARD_DEFS.some((w) => w.id === bucket) ? bucket : null;
      if (attrTarget === coordTarget) {
        wardAttrMatch++;
      } else {
        wardAttrMismatch++;
        if (mismatchSamples.length < 30) {
          mismatchSamples.push({ id: b.id, wardAttr: b.ward, town: b.town || null, coordBucket: bucket, cx, cz });
        }
      }
    }
  }
  return { buckets, total, invalidCountedAsOutsideTarget, hasWardAttr, wardAttrMatch, wardAttrMismatch, mismatchSamples };
}

// ── STEP2: タイル化＋manifest生成（split-building-tiles.jsと同一のclassify方式、tileSize=500） ──
const TILE_SIZE = 500;
function tileOf(b) {
  const { cx, cz } = polyAreaCentroid(b.fp);
  return { tx: Math.floor(cx / TILE_SIZE), tz: Math.floor(cz / TILE_SIZE) };
}
function buildDataset(datasetId, wardName, wardCode, buildings, outRoot) {
  const tileMap = new Map();
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const b of buildings) {
    const { tx, tz } = tileOf(b);
    const key = tx + '_' + tz;
    if (!tileMap.has(key)) tileMap.set(key, { tx, tz, buildings: [] });
    tileMap.get(key).buildings.push(b);
    for (const p of b.fp) { if (p[0] < bounds.minX) bounds.minX = p[0]; if (p[0] > bounds.maxX) bounds.maxX = p[0]; if (p[1] < bounds.minZ) bounds.minZ = p[1]; if (p[1] > bounds.maxZ) bounds.maxZ = p[1]; }
  }
  const dsDir = path.join(outRoot, datasetId);
  if (fs.existsSync(dsDir)) { console.error('[stop] dataset出力先が既に存在します(既存区の上書き防止):', dsDir); process.exit(3); }
  const tilesOut = [];
  for (const { tx, tz, buildings: tb } of tileMap.values()) {
    const fname = `tile_${tx}_${tz}.json`;
    if (MODE === 'apply') {
      fs.mkdirSync(dsDir, { recursive: true });
      const fp = path.join(dsDir, fname);
      if (fs.existsSync(fp)) { console.error('[stop] 既存ファイルへの上書きは拒否:', fp); process.exit(3); }
      fs.writeFileSync(fp, JSON.stringify({ tx, tz, tileSize: TILE_SIZE, lod: 1, count: tb.length, buildings: tb }));
    }
    tilesOut.push({ tx, tz, file: fname, count: tb.length });
  }
  const manifest = {
    version: 1, id: datasetId, ward: wardName, wardCode: wardCode,
    coordinateSystem: 'meters-local', coordinateConvention: 'znorth-neg-v1',
    origin: null, tileSize: TILE_SIZE, lod: 1,
    totalBuildings: buildings.length, tileCount: tilesOut.length,
    bounds, invalidSkipped: 0, duplicateSkipped: 0, tiles: tilesOut,
  };
  if (MODE === 'apply') {
    fs.mkdirSync(dsDir, { recursive: true });
    const mp = path.join(dsDir, 'manifest.json');
    if (fs.existsSync(mp)) { console.error('[stop] 既存ファイルへの上書きは拒否:', mp); process.exit(3); }
    fs.writeFileSync(mp, JSON.stringify(manifest, null, 2));
  }
  return manifest;
}

// ── root manifest.json: 既存datasetは一切変更せず、新規分だけを末尾に追記する ──
function mergeRootManifest(outRoot, newEntries) {
  const rmp = path.join(outRoot, 'manifest.json');
  let existing = null;
  if (fs.existsSync(rmp)) {
    existing = JSON.parse(fs.readFileSync(rmp, 'utf8'));
    const existingIds = new Set((existing.datasets || []).map((d) => d.id));
    for (const e of newEntries) {
      if (existingIds.has(e.id)) { console.error('[stop] root manifestに同一datasetIdが既に存在します(意図しない上書き防止):', e.id); process.exit(3); }
    }
  }
  const merged = existing
    ? { ...existing, datasets: [...existing.datasets, ...newEntries] }
    : {
        version: 1, city: 'osaka-ward-poc', coordinateSystem: 'meters-local', coordinateConvention: 'znorth-neg-v1',
        tileSize: TILE_SIZE, origin: null, datasets: newEntries,
      };
  if (MODE === 'apply') {
    fs.mkdirSync(outRoot, { recursive: true });
    fs.writeFileSync(rmp, JSON.stringify(merged, null, 2));
  }
  return { path: rmp, manifest: merged, wasExisting: !!existing };
}

async function main() {
  const t0 = Date.now();
  const { buckets, total, invalidCountedAsOutsideTarget, hasWardAttr, wardAttrMatch, wardAttrMismatch, mismatchSamples } = await classifyAll();
  const elapsedMs = Date.now() - t0;

  const outsideTarget = buckets.outsideTarget.length;
  const boundaryStraddle = buckets.boundaryStraddle.length;
  const ambiguous = buckets.ambiguous.length;
  let classificationSum = outsideTarget + boundaryStraddle + ambiguous;
  for (const w of WARD_DEFS) classificationSum += buckets[w.id].length;

  console.log('total:', total);
  for (const w of WARD_DEFS) console.log(`${w.id}(${w.name}):`, buckets[w.id].length);
  console.log('outsideTarget:', outsideTarget, `(うち不正データ算入分=${invalidCountedAsOutsideTarget})`);
  console.log('boundaryStraddle:', boundaryStraddle, '(除外)');
  console.log('ambiguous:', ambiguous);
  console.log('');
  console.log('wardAttrMatch:', wardAttrMatch);
  console.log('wardAttrMismatch:', wardAttrMismatch);
  if (mismatchSamples.length) {
    console.log('wardAttrMismatchサンプル(最大30件、診断専用・分類には無関係):');
    for (const m of mismatchSamples) console.log(`  id=${m.id} ward属性=${m.wardAttr}(town=${m.town}) 座標分類=${m.coordBucket} 重心=(${m.cx != null ? m.cx.toFixed(1) : '—'},${m.cz != null ? m.cz.toFixed(1) : '—'})`);
  }
  console.log('');
  console.log('classificationSum:', classificationSum);
  console.log('classificationSum === total:', classificationSum === total);
  console.log('');
  for (const w of WARD_DEFS) console.log(`${w.id} > 0: ${buckets[w.id].length > 0 ? 'OK' : 'NG'}`);
  console.log(`分類処理時間: ${elapsedMs}ms（bbox事前フィルタ適用済み）`);

  if (MODE === 'apply') {
    // 【安全チェック】--apply時のみ必須。満たさなければ書き込みを一切行わない。
    const invariantOk = classificationSum === total && WARD_DEFS.every((w) => buckets[w.id].length > 0);
    if (!invariantOk) {
      console.error('[stop] 安全チェック不成立(classificationSum===total / 全対象区でbuildings>0)。データは生成しません。');
      process.exit(4);
    }
    console.log('=== STEP2 データ生成 ===');
    const newEntries = [];
    for (const w of WARD_DEFS) {
      const man = buildDataset(w.datasetId, w.name, w.wardCode, buckets[w.id], OUT);
      console.log(`  ${w.datasetId}:`, man.totalBuildings, '棟', man.tileCount, 'タイル bounds=', JSON.stringify(man.bounds));
      newEntries.push({ id: w.datasetId, ward: w.name, wardCode: w.wardCode, manifest: `./${w.datasetId}/manifest.json`, enabled: true, buildings: man.totalBuildings, tiles: man.tileCount });
    }

    const { path: rmp, wasExisting } = mergeRootManifest(OUT, newEntries);
    console.log(`  root manifest(${wasExisting ? '既存へ追記' : '新規作成'}):`, rmp);

    // outsideTarget/boundaryStraddle/ambiguousは参考用に別途保存（本番データには一切影響しない）
    const diagPath = path.join(OUT, `CLASSIFICATION_REPORT.${WARD_DEFS.map((w) => w.id).join('-')}.json`);
    const counts = { outsideTarget, boundaryStraddle, ambiguous };
    for (const w of WARD_DEFS) counts[w.id] = buckets[w.id].length;
    fs.writeFileSync(diagPath, JSON.stringify({
      total, invalidCountedAsOutsideTarget, hasWardAttr, wardAttrMatch, wardAttrMismatch, mismatchSamples,
      counts,
      boundaryStraddleSampleIds: buckets.boundaryStraddle.slice(0, 50).map((b) => b.id),
      ambiguousSampleIds: buckets.ambiguous.slice(0, 50).map((b) => b.id),
    }, null, 2));
    console.log('  分類レポート:', diagPath);
  } else {
    console.log('[dry-run] --apply を付けると', OUT, '配下へ書き出します。');
  }
  process.exit(0);
}
main().catch((e) => { console.error('[stop]', e.message); process.exit(1); });
