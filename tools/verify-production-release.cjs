#!/usr/bin/env node
'use strict';
/* verify-production-release.cjs — STEP7: temp内で完成させた release を、元の本番入力と突き合わせて全数検証。
 * 全項目PASSのときのみ RELEASE_READY.json（releaseId/BUILD_ID/規約/件数/各SHA256/検証日時/結果）を release 直下へ生成。
 * production-cutover.ps1 は check-release-ready.cjs 経由で READY と実ファイルハッシュの一致を必須とする。
 *
 * メモリ方針: 584,490棟の全属性を二重展開しない。
 *   PassA(旧タイル): id → { attrHash=sha1(JSON(fpを除く全属性)), coordHash=sha1(JSON(negClosedRing(fp))) } を構築
 *   PassB(新タイル): 被覆(欠落/余剰/重複=0)・attrHash一致(=deepEqual)・coordHash一致(=全頂点 newX===oldX/newZ===-oldZ
 *   かつreverse対応の完全一致)・タイル所属(centroid/500)・per-tile count を検証。ヒープ使用量を報告する。
 *
 * release ディレクトリ構成（temp/prod-znegate/release/<releaseId>/）:
 *   osaka_3d_buildings.html
 *   buildings/<dataset>/tile_*.json + manifest.json    buildings/manifest.json (root)
 *   overlays/<dataset>.json
 *
 * usage: node tools/verify-production-release.cjs --project-root <dir> --dataset <id> \
 *   --release-dir <temp release root> --orig-buildings-dir <dir> --orig-overlays <json> \
 *   --release-id <id> --build-id <id> [--expect-total N] [--tile-size 500]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./lib/znegate-core.cjs');
const G = require('./lib/io-guard.cjs');
const { computeTilesDigest } = require('./lib/tiles-digest.cjs');
const A = G.parseArgs(process.argv.slice(2));
const ROOT = G.requireProjectRoot(A);
for (const k of ['dataset', 'release-dir', 'orig-buildings-dir', 'orig-overlays', 'release-id', 'build-id']) {
  if (!A[k] || A[k] === true) { console.error('missing --' + k); process.exit(1); }
}
const DATASET = A.dataset, RELDIR = path.resolve(A['release-dir']);
const ORIG_B = path.resolve(A['orig-buildings-dir']);
const ORIG_OV = path.resolve(A['orig-overlays']);
const RELEASE_ID = A['release-id'], BUILD_ID = A['build-id'];
const TILE = parseInt(A['tile-size'] || '500', 10);
const CONV = 'znorth-neg-v1';
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const NEW_DS_DIR = path.join(RELDIR, 'buildings', DATASET);
const NEW_MANIFEST_P = path.join(NEW_DS_DIR, 'manifest.json');
const NEW_ROOT_P = path.join(RELDIR, 'buildings', 'manifest.json');
const NEW_OV_P = path.join(RELDIR, 'overlays', DATASET + '.json');
const NEW_HTML_P = path.join(RELDIR, 'osaka_3d_buildings.html');
for (const p of [NEW_MANIFEST_P, NEW_ROOT_P, NEW_OV_P, NEW_HTML_P, path.join(ORIG_B, 'manifest.json'), ORIG_OV]) {
  if (!fs.existsSync(p)) { console.error('[stop] 必須ファイルが無い:', p); process.exit(1); }
}
const checks = []; const C = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); };

// ============ 建物: PassA（旧） ============
const origManifest = JSON.parse(fs.readFileSync(path.join(ORIG_B, 'manifest.json'), 'utf8'));
const EXPECTED = A['expect-total'] ? parseInt(A['expect-total'], 10) : origManifest.totalBuildings;
const origFiles = fs.readdirSync(ORIG_B).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f));
const idMap = new Map();  // id -> {a,c,seen}
let origCount = 0, origInvalid = 0, origDup = 0, peakMB = 0;
const oB = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
for (const f of origFiles) {
  const t = JSON.parse(fs.readFileSync(path.join(ORIG_B, f), 'utf8'));
  for (const b of (t.buildings || [])) {
    origCount++;
    const bad = !b || !b.id || !Array.isArray(b.fp) || b.fp.length < 3 || b.fp.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]));
    if (bad) { origInvalid++; continue; }
    if (idMap.has(b.id)) { origDup++; continue; }
    for (const p of b.fp) { if (p[0] < oB.minX) oB.minX = p[0]; if (p[0] > oB.maxX) oB.maxX = p[0]; if (p[1] < oB.minZ) oB.minZ = p[1]; if (p[1] > oB.maxZ) oB.maxZ = p[1]; }
    idMap.set(b.id, { a: sha1(JSON.stringify(core.omit(b, 'fp'))), c: sha1(JSON.stringify(core.negClosedRing(b.fp))), s: false });
  }
  const h = G.memMB(); if (h > peakMB) peakMB = h;
}
C('旧remote: 件数=期待値(' + EXPECTED + ')', origCount === EXPECTED, origCount);
C('旧remote: invalid=0', origInvalid === 0, origInvalid);
C('旧remote: 重複=0', origDup === 0, origDup);

// ============ 建物: PassB（新） ============
const newManifest = JSON.parse(fs.readFileSync(NEW_MANIFEST_P, 'utf8'));
const newFiles = fs.readdirSync(NEW_DS_DIR).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f)).sort();
const manEntries = new Map((newManifest.tiles || []).map((t) => [t.file, t]));
const onlyActual = newFiles.filter((f) => !manEntries.has(f));
const onlyManifest = [...manEntries.keys()].filter((f) => !newFiles.includes(f));
let newCount = 0, newDup = 0, newInvalid = 0, extraIds = 0, attrMis = 0, coordMis = 0, tileMis = 0, perTileMis = 0, sumEntryCount = 0;
const nB = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
for (const f of newFiles) {
  const m = f.match(/^tile_(-?\d+)_(-?\d+)\.json$/);
  const ftx = parseInt(m[1], 10), ftz = parseInt(m[2], 10);
  const t = JSON.parse(fs.readFileSync(path.join(NEW_DS_DIR, f), 'utf8'));
  const entry = manEntries.get(f);
  const blds = t.buildings || [];
  if (entry) sumEntryCount += entry.count;
  if (!(t.tx === ftx && t.tz === ftz && t.count === blds.length && entry && entry.tx === ftx && entry.tz === ftz && entry.count === blds.length)) perTileMis++;
  for (const b of blds) {
    newCount++;
    const bad = !b || !b.id || !Array.isArray(b.fp) || b.fp.length < 3 || b.fp.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]));
    if (bad) { newInvalid++; continue; }
    const e = idMap.get(b.id);
    if (!e) { extraIds++; continue; }
    if (e.s) { newDup++; continue; }
    e.s = true;
    if (sha1(JSON.stringify(core.omit(b, 'fp'))) !== e.a) attrMis++;
    if (sha1(JSON.stringify(b.fp)) !== e.c) coordMis++;
    let sx = 0, sz = 0; for (const p of b.fp) { sx += p[0]; sz += p[1]; if (p[0] < nB.minX) nB.minX = p[0]; if (p[0] > nB.maxX) nB.maxX = p[0]; if (p[1] < nB.minZ) nB.minZ = p[1]; if (p[1] > nB.maxZ) nB.maxZ = p[1]; }
    if (Math.floor((sx / b.fp.length) / TILE) !== ftx || Math.floor((sz / b.fp.length) / TILE) !== ftz) tileMis++;
  }
  const h = G.memMB(); if (h > peakMB) peakMB = h;
}
let missing = 0; for (const e of idMap.values()) if (!e.s) missing++;
C('新remote: 件数=期待値', newCount === EXPECTED, newCount);
C('新remote: manifest.totalBuildings=期待値', newManifest.totalBuildings === EXPECTED, newManifest.totalBuildings);
C('ID集合: 欠落=0', missing === 0, missing);
C('ID集合: 余剰=0', extraIds === 0, extraIds);
C('ID集合: 重複=0', newDup === 0, newDup);
C('新remote: invalid=0', newInvalid === 0, newInvalid);
C('全属性deepEqual(座標以外)', attrMis === 0, 'mismatch=' + attrMis);
C('全頂点 newX===oldX / newZ===-oldZ (reverse対応の完全一致)', coordMis === 0, 'mismatch=' + coordMis);
C('1建物1タイル(centroid/500=所属タイル)', tileMis === 0, tileMis);
C('per-tile: 名前tx/tz=本体=manifest, count一致', perTileMis === 0, perTileMis);
C('manifest.tiles↔実ファイル 完全一致', onlyActual.length === 0 && onlyManifest.length === 0 && newFiles.length === newManifest.tileCount,
  `実${newFiles.length}/manifest${manEntries.size}/tileCount${newManifest.tileCount}`);
C('Σmanifest.count=期待値', sumEntryCount === EXPECTED, sumEntryCount);
const near = (a, b) => Math.abs(a - b) < 1e-9;
C('bounds: 数学的一致(minZ=-旧maxZ, maxZ=-旧minZ, X不変)',
  near(newManifest.bounds.minX, oB.minX) && near(newManifest.bounds.maxX, oB.maxX) && near(newManifest.bounds.minZ, -oB.maxZ) && near(newManifest.bounds.maxZ, -oB.minZ),
  JSON.stringify(newManifest.bounds));
C('bounds: manifest=実データ再計算', near(newManifest.bounds.minX, nB.minX) && near(newManifest.bounds.maxX, nB.maxX) && near(newManifest.bounds.minZ, nB.minZ) && near(newManifest.bounds.maxZ, nB.maxZ));
C('新manifest: coordinateConvention', newManifest.coordinateConvention === CONV, newManifest.coordinateConvention);
const newRoot = JSON.parse(fs.readFileSync(NEW_ROOT_P, 'utf8'));
C('新root manifest: coordinateConvention', newRoot.coordinateConvention === CONV, newRoot.coordinateConvention);
const rootEntry = (newRoot.datasets || []).find((d) => d.id === DATASET);
C('新root manifest: dataset記録一致', rootEntry && (rootEntry.buildings == null || rootEntry.buildings === EXPECTED) && (rootEntry.tiles == null || rootEntry.tiles === newManifest.tileCount), JSON.stringify(rootEntry || null));

// ============ embedded（HTML内BLDGS） ============
const html = fs.readFileSync(NEW_HTML_P, 'utf8');
function grabConst(name) {
  const re = new RegExp('\\bconst\\s+' + name + '\\s*=\\s*'); const m = re.exec(html); if (!m) return null;
  const j = m.index + m[0].length; const oc = html[j], cc = oc === '[' ? ']' : '}'; let d = 0, inStr = false, q = '';
  for (let k = j; k < html.length; k++) { const c = html[k]; if (inStr) { if (c === q && html[k - 1] !== '\\') inStr = false; continue; } if (c === '"' || c === "'") { inStr = true; q = c; continue; } if (c === oc) d++; else if (c === cc) { d--; if (d === 0) return JSON.parse(html.slice(j, k + 1)); } }
  return null;
}
const emb = grabConst('BLDGS') || [];
// embedded⊆remoteは「IDが存在する」だけでなく、同一IDのfpが完全一致(新規約)・fp以外の属性がdeepEqual・
// embedded内重複=0 を全棟検証する。これにより「IDは同じだがembeddedだけ旧座標」の混在を検出する。
let embInternalDup = 0, embNotInRemote = 0, embFpMismatch = 0, embAttrMismatch = 0;
const embIds = new Set();
for (const b of emb) {
  if (embIds.has(b.id)) { embInternalDup++; continue; }
  embIds.add(b.id);
  const e = idMap.get(b.id);
  if (!e) { embNotInRemote++; continue; }
  if (sha1(JSON.stringify(b.fp)) !== e.c) embFpMismatch++;               // 新規約fpと完全一致か（旧座標混在を検出）
  if (sha1(JSON.stringify(core.omit(b, 'fp'))) !== e.a) embAttrMismatch++; // fp以外の属性がdeepEqualか
}
C('embedded: BLDGS抽出', emb.length > 0, emb.length + '棟');
C('embedded: 内部重複=0', embInternalDup === 0, embInternalDup);
C('embedded⊆remote (全棟ID存在)', embNotInRemote === 0, embNotInRemote);
C('embedded: 全棟fp完全一致(新規約, 旧座標混在なし)', embFpMismatch === 0, embFpMismatch);
C('embedded: 全棟属性deepEqual(fp以外)', embAttrMismatch === 0, embAttrMismatch);
C('union ユニークID=期待値(' + EXPECTED + ')', embNotInRemote === 0 && missing === 0 && extraIds === 0 && newDup === 0, '部分集合ゆえ union=remote全体');

// ============ overlay（必須レイヤーの件数・属性・座標変換） ============
const LAYERS = { roads: ['p', 'polyline'], water: ['p', 'ring'], parks: ['p', 'ring'], cemetery: ['p', 'ring'], parking: ['polygons', 'poly-holes'], labels: ['p', 'point'], schools: ['p', 'auto'], temples: ['p', 'auto'] };
const ovOld = JSON.parse(fs.readFileSync(ORIG_OV, 'utf8'));
const ovNew = JSON.parse(fs.readFileSync(NEW_OV_P, 'utf8'));
let ovMis = 0, ovAuto = 0;
for (const [layer, [field, kind]] of Object.entries(LAYERS)) {
  const a = ovOld[layer], b = ovNew[layer];
  if (!Array.isArray(a) || !Array.isArray(b)) { C(`overlay:${layer} 存在`, false, 'missing'); continue; }
  C(`overlay:${layer} 件数一致`, a.length === b.length, `${a.length}→${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const rec = a[i]; let resolved = kind;
    if (kind === 'auto') {
      if (rec && Array.isArray(rec.polygons)) resolved = 'poly-holes';
      else if (rec && core.isPoint(rec[field])) resolved = 'point';
      else if (rec && core.isRing(rec[field])) resolved = 'ring';
      else { ovAuto++; continue; }
    }
    let expect;
    if (resolved === 'poly-holes') expect = { ...rec, polygons: rec.polygons.map(core.negPolyWithHoles) };
    else if (resolved === 'polyline') expect = { ...rec, [field]: core.negPolyline(rec[field]) };
    else if (resolved === 'ring') expect = { ...rec, [field]: core.negClosedRing(rec[field]) };
    else expect = { ...rec, [field]: core.negPoint(rec[field]) };
    if (!core.deepEqual(expect, b[i])) ovMis++;   // 座標(holes含む)+属性の完全一致
  }
}
C('overlay: 変換完全一致(座標+holes+属性 deepEqual)', ovMis === 0, 'mismatch=' + ovMis);
C('overlay: auto判定不能=0', ovAuto === 0, ovAuto);

// ============ HTML 文字列検査 ============
C('HTML: BUILD_ID 新値を積極一致', html.includes(`LIVE_CITY_BUILD_ID = '${BUILD_ID}'`), BUILD_ID);
C('HTML: 旧BUILD_ID 不在', !html.includes("LIVE_CITY_BUILD_ID = 'multiward-overlay-v1'"));
C('HTML: buildings releaseパス', html.includes(`basePath: 'data/buildings/releases/${RELEASE_ID}'`));
C('HTML: rootManifest releaseパス', html.includes(`rootManifest: 'data/buildings/releases/${RELEASE_ID}/manifest.json'`));
C('HTML: overlays releaseパス', html.includes(`basePath: 'data/overlays/releases/${RELEASE_ID}'`));
C('HTML: 旧buildingsパス不在', !html.includes("basePath: 'data/buildings',") && !html.includes("rootManifest: 'data/buildings/manifest.json'"));
C('HTML: 旧overlaysパス不在', !html.includes("basePath: 'data/overlays',"));
C('HTML: EXPECTED_COORDINATE_CONVENTION', html.includes(`EXPECTED_COORDINATE_CONVENTION = "${CONV}"`));
C('HTML: assertConvention ゲート配線', html.includes('assertConvention(d.manifest'));
C('HTML: geoToThree z反転', html.includes('-((lat - SEARCH_CLAT) * SEARCH_MPD)') && !html.includes('const z = (lat - SEARCH_CLAT) * SEARCH_MPD;'));

// ============ タイル本体の決定論的digest（全876タイル分、cutoverゲート対象） ============
const tilesDigestResult = computeTilesDigest(NEW_DS_DIR, DATASET);
C('タイルdigest: 列挙数=manifest.tileCount', tilesDigestResult.count === newManifest.tileCount,
  `${tilesDigestResult.count} vs ${newManifest.tileCount}`);
C('タイルdigest: 列挙数=実ファイル数', tilesDigestResult.count === newFiles.length, `${tilesDigestResult.count} vs ${newFiles.length}`);

// ============ 判定・READY生成 ============
const allOk = checks.every((c) => c.ok);
console.log('=== verify-production-release ===');
for (const c of checks) console.log(`  [${c.ok ? 'OK ' : 'NG '}] ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
console.log(`  heapピーク ~${peakMB}MB (idMap=${idMap.size}件)`);
console.log('総合:', allOk ? '全項目PASS' : 'NG=' + checks.filter((c) => !c.ok).length);
if (allOk) {
  const readyPath = path.join(RELDIR, 'RELEASE_READY.json');
  const ready = {
    schema: 'release-ready/v2', releaseId: RELEASE_ID, buildId: BUILD_ID, coordinateConvention: CONV,
    dataset: DATASET, buildings: EXPECTED, tileCount: newManifest.tileCount,
    files: {
      'osaka_3d_buildings.html': sha256File(NEW_HTML_P),
      ['buildings/' + DATASET + '/manifest.json']: sha256File(NEW_MANIFEST_P),
      'buildings/manifest.json': sha256File(NEW_ROOT_P),
      ['overlays/' + DATASET + '.json']: sha256File(NEW_OV_P),
    },
    // 全タイル本体(tile_*.json)のrelativePath+sha256から決定論的に算出した全体digest。
    // cutoverゲートは tileCount一致だけでなく、この digest の一致を必須とする（1タイルの改ざん/差替も検出）。
    tilesDigest: tilesDigestResult.tilesDigest,
    tileFiles: tilesDigestResult.tileFiles,
    verifiedAt: new Date().toISOString(),
    results: { total: checks.length, pass: checks.length },
  };
  G.assertSafeOutput(ROOT, ORIG_B, readyPath);
  G.writeNoOverwrite(readyPath, JSON.stringify(ready, null, 2));
  console.log('RELEASE_READY.json 生成:', readyPath);
}
process.exit(allOk ? 0 : 1);
