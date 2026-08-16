#!/usr/bin/env node
'use strict';
/* build-ward-poc-data.cjs — Ward Mode PoC専用データセット生成ツール。
 *
 * 【重要な制約の明記】
 * このツールは汎用的に設計されており、--source-jsonl（建物データのJSONL、znorth-neg-v1変換済み）
 * を入力として受け取る。本ツールの開発・動作確認を行ったサンドボックス環境には、
 * 実際の本番remote 584,490棟のタイル本体が存在しない（876タイルはユーザーのローカル環境にのみ実在）。
 * そのため、このツール自体を実際に584,490棟へ適用する実行は、ユーザーの実機で行う必要がある。
 *
 * 【分類方法（v2）】STEP1
 *   行政区ポリゴン（TOWN_POLYGONS実データ、住吉区101町丁目・東住吉区100町丁目）による
 *   座標判定のみを正本とする。building.ward属性は一切、分類の拒否条件・ルーティング条件に
 *   使用しない（診断記録専用）。
 *
 *   1. footprint重心が住吉区polygon内のみ         → sumiyoshi
 *   2. footprint重心が東住吉区polygon内のみ       → higashisumiyoshi
 *   3. footprint重心が両区のpolygonに同時ヒット   → ambiguous
 *   4. footprint重心がどちらのpolygonにもヒットしない → outsideTarget
 *      （不正データ: fp欠落・頂点数<3等で重心を計算できない建物も、
 *       行政区を確認しようがないため outsideTarget に算入する。件数は別途内訳表示する）
 *   5. 重心がsumiyoshi/higashisumiyoshiに解決した場合、footprint全頂点についても
 *      同じ判定を行い、頂点のいずれかが重心と異なる区分類になれば
 *      → boundaryStraddle（区境界をfootprintがまたぐ。PoCからは除外）
 *
 *   building.ward / building.town は診断専用。座標分類との一致・不一致を
 *   wardAttrMatch / wardAttrMismatch として記録するのみで、不一致でも
 *   分類（sumiyoshi/higashisumiyoshi/ambiguous/outsideTarget/boundaryStraddle）には一切影響しない。
 *
 *   恒等式: sumiyoshi + higashisumiyoshi + outsideTarget + boundaryStraddle + ambiguous = 入力総数
 *
 * 【高速化】
 *   各行政区（住吉区・東住吉区）のpolygon群のbbox(minX,maxX,minZ,maxZ)を事前計算し、
 *   判定対象の点がbbox外であればpoint-in-polygon（pointInRingのO(頂点数)ループ）を
 *   一切実行しない（bboxの矩形判定4回のみで済ませる）。
 *
 * 【出力先の安全制約】
 *   public/__test__/ward-poc/ 配下、または temp/ 配下にのみ書き込みを許可する。
 *   production releases (public/data/buildings/releases/znorth-neg-v1/等)へは
 *   絶対に書き込めない（ハードコードされた拒否リストで二重に保護）。
 *
 * usage:
 *   node tools/build-ward-poc-data.cjs \
 *     --project-root <dir> \
 *     --source-jsonl <znorth-neg-v1建物JSONL> \
 *     --town-polygons <TOWN_POLYGONS.json (znorth-neg-v1変換済み、同一jsonファイル)> \
 *     --out public/__test__/ward-poc/buildings \
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

if (!A['project-root'] || !A['source-jsonl'] || !A['town-polygons'] || !A.out) {
  console.error('usage: --project-root <dir> --source-jsonl <file> --town-polygons <file> --out <dir> [--dry-run|--apply]');
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

// ── TOWN_POLYGONSから対象2区分だけを抽出（新規座標データは作らず、既存データの分類のみ） ──
// 【重要】分類対象は住吉区・東住吉区の2区のみ。平野区等は「outsideTarget」に含まれるため、
// 個別のポリゴン保持は不要（分類ロジック上は住吉区/東住吉区の2ポリゴン群だけで十分）。
const townPolygons = JSON.parse(fs.readFileSync(path.resolve(A['town-polygons']), 'utf8'));
const WARD_DEFS = [
  { id: 'sumiyoshi', name: '住吉区', townPrefix: '住吉区' },
  { id: 'higashisumiyoshi', name: '東住吉区', townPrefix: '東住吉区' },
];
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
  console.log(`[build-ward-poc-data] ${w.name}: town数=${Object.keys(townPolygons).filter((k) => k.indexOf(w.townPrefix) === 0).length} ring数=${wardRings[w.id].length} bbox=${JSON.stringify(bbox)}`);
}
// bbox外はpoint-in-polygonを一切実行しない（高速化）
function pointInWard(x, z, wardId) {
  const bbox = wardBBox[wardId];
  if (x < bbox.minX || x > bbox.maxX || z < bbox.minZ || z > bbox.maxZ) return false; // bbox即時棄却
  for (const ring of wardRings[wardId]) { if (pointInRing(x, z, ring)) return true; }
  return false;
}
// 点(x,z)が住吉区/東住吉区どちらの判定になるか('sumiyoshi'|'higashisumiyoshi'|'ambiguous'|'outsideTarget')
function classifyPoint(x, z) {
  const sumi = pointInWard(x, z, 'sumiyoshi');
  const higa = pointInWard(x, z, 'higashisumiyoshi');
  if (sumi && higa) return 'ambiguous';
  if (sumi) return 'sumiyoshi';
  if (higa) return 'higashisumiyoshi';
  return 'outsideTarget';
}

// ── building.ward属性 → 診断専用の対象区マッピング（分類には一切使用しない） ──
function attrImpliesTarget(wardStr) {
  if (wardStr === '住吉区') return 'sumiyoshi';
  if (wardStr === '東住吉区') return 'higashisumiyoshi';
  return null; // 平野区・その他・未定義は「対象2区ではない」= null
}

// ── STEP1: 分類本体 ──
async function classifyAll() {
  const buckets = { sumiyoshi: [], higashisumiyoshi: [], outsideTarget: [], boundaryStraddle: [], ambiguous: [] };
  let total = 0, invalidCountedAsOutsideTarget = 0;
  let hasWardAttr = 0, wardAttrMatch = 0, wardAttrMismatch = 0;
  const mismatchSamples = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path.resolve(A['source-jsonl']), { encoding: 'utf8' }) });
  for await (const line of rl) {
    const s = line.trim(); if (!s) continue;
    const b = JSON.parse(s);
    total++;

    // 不正データ(fp欠落・頂点数<3等)は行政区を判定しようがないため outsideTarget へ算入する
    // （恒等式 sumiyoshi+higashisumiyoshi+outsideTarget+boundaryStraddle+ambiguous=総数 を
    //   常に満たすため。件数は invalidCountedAsOutsideTarget として別途内訳表示する）。
    if (!b || !Array.isArray(b.fp) || b.fp.length < 3) {
      buckets.outsideTarget.push(b);
      invalidCountedAsOutsideTarget++;
      continue;
    }

    const { cx, cz } = polyAreaCentroid(b.fp);
    let bucket = classifyPoint(cx, cz);

    // 重心がsumiyoshi/higashisumiyoshiに解決した場合のみ、footprint全頂点の境界またぎを検証
    if (bucket === 'sumiyoshi' || bucket === 'higashisumiyoshi') {
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
      const attrTarget = attrImpliesTarget(b.ward); // 'sumiyoshi'|'higashisumiyoshi'|null
      const coordTarget = (bucket === 'sumiyoshi' || bucket === 'higashisumiyoshi') ? bucket : null;
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

async function main() {
  const t0 = Date.now();
  const { buckets, total, invalidCountedAsOutsideTarget, hasWardAttr, wardAttrMatch, wardAttrMismatch, mismatchSamples } = await classifyAll();
  const elapsedMs = Date.now() - t0;

  const sumiyoshi = buckets.sumiyoshi.length;
  const higashisumiyoshi = buckets.higashisumiyoshi.length;
  const outsideTarget = buckets.outsideTarget.length;
  const boundaryStraddle = buckets.boundaryStraddle.length;
  const ambiguous = buckets.ambiguous.length;
  const classificationSum = sumiyoshi + higashisumiyoshi + outsideTarget + boundaryStraddle + ambiguous;

  console.log('total:', total);
  console.log('sumiyoshi:', sumiyoshi);
  console.log('higashisumiyoshi:', higashisumiyoshi);
  console.log('outsideTarget:', outsideTarget, `(うち不正データ算入分=${invalidCountedAsOutsideTarget})`);
  console.log('boundaryStraddle:', boundaryStraddle, '(PoCから除外)');
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
  console.log(`sumiyoshi > 0: ${sumiyoshi > 0 ? 'OK' : 'NG'}`);
  console.log(`higashisumiyoshi > 0: ${higashisumiyoshi > 0 ? 'OK' : 'NG'}`);
  console.log(`分類処理時間: ${elapsedMs}ms（bbox事前フィルタ適用済み）`);

  if (MODE === 'apply') {
    // 【安全チェック】--apply時のみ必須。満たさなければ書き込みを一切行わない。
    const invariantOk = classificationSum === total && sumiyoshi > 0 && higashisumiyoshi > 0;
    if (!invariantOk) {
      console.error('[stop] 安全チェック不成立(classificationSum===total / sumiyoshi>0 / higashisumiyoshi>0)。PoCデータは生成しません。');
      process.exit(4);
    }
    console.log('=== STEP2 PoCデータ生成 ===');
    const sumiMan = buildDataset('osaka-sumiyoshi', '住吉区', null, buckets.sumiyoshi, OUT);
    const higaMan = buildDataset('osaka-higashisumiyoshi', '東住吉区', '27121', buckets.higashisumiyoshi, OUT);
    console.log('  osaka-sumiyoshi:', sumiMan.totalBuildings, '棟', sumiMan.tileCount, 'タイル bounds=', JSON.stringify(sumiMan.bounds));
    console.log('  osaka-higashisumiyoshi:', higaMan.totalBuildings, '棟', higaMan.tileCount, 'タイル bounds=', JSON.stringify(higaMan.bounds));

    const rootManifest = {
      version: 1, city: 'osaka-ward-poc', coordinateSystem: 'meters-local', coordinateConvention: 'znorth-neg-v1',
      tileSize: TILE_SIZE, origin: null,
      datasets: [
        { id: 'osaka-sumiyoshi', ward: '住吉区', wardCode: null, manifest: './osaka-sumiyoshi/manifest.json', enabled: true, buildings: sumiMan.totalBuildings, tiles: sumiMan.tileCount },
        { id: 'osaka-higashisumiyoshi', ward: '東住吉区', wardCode: '27121', manifest: './osaka-higashisumiyoshi/manifest.json', enabled: true, buildings: higaMan.totalBuildings, tiles: higaMan.tileCount },
      ],
    };
    const rmp = path.join(OUT, 'manifest.json');
    if (fs.existsSync(rmp)) { console.error('[stop] 既存ファイルへの上書きは拒否:', rmp); process.exit(3); }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(rmp, JSON.stringify(rootManifest, null, 2));
    console.log('  root manifest:', rmp);

    // outsideTarget/boundaryStraddle/ambiguousは参考用に別途保存（本番データには一切影響しない）
    const diagPath = path.join(OUT, 'CLASSIFICATION_REPORT.json');
    fs.writeFileSync(diagPath, JSON.stringify({
      total, invalidCountedAsOutsideTarget, hasWardAttr, wardAttrMatch, wardAttrMismatch, mismatchSamples,
      counts: { sumiyoshi, higashisumiyoshi, outsideTarget, boundaryStraddle, ambiguous },
      boundaryStraddleSampleIds: buckets.boundaryStraddle.slice(0, 50).map((b) => b.id),
      ambiguousSampleIds: buckets.ambiguous.slice(0, 50).map((b) => b.id),
    }, null, 2));
    console.log('  分類レポート:', diagPath);
  } else {
    console.log('[dry-run] --apply を付けると public/__test__/ward-poc/buildings/ 配下へ書き出します。');
  }
  process.exit(0);
}
main().catch((e) => { console.error('[stop]', e.message); process.exit(1); });
