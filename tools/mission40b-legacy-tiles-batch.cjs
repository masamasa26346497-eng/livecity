#!/usr/bin/env node
// Mission 40B: 旧 Three.js 版が読む「建物タイル」(public/map-data/osaka-city/buildings/osaka-<ward>/tile_*.json)
// を、再ダウンロードなしで Cesium 用 3D Tiles に一括変換するバッチ。
//
//   旧タイルは 37B 変換器の入力形式そのもの（id=CityGML gml:id, fp, z0, dz, h, usage, repX, repZ）なので、
//   37B の build() を srcDir 指定で呼ぶだけで済む。canonicalId は新規採番せず、そのまま保持する。
//
//   node tools/mission40b-legacy-tiles-batch.cjs --inventory
//       棚卸し: 24 区ごとに root manifest の件数 / ローカルの旧タイル実在 / 既存 3D Tiles の有無 を
//       data/reports/mission40b-legacy-reuse/inventory.json に出す（読み取りのみ）。
//   node tools/mission40b-legacy-tiles-batch.cjs --ward <wardId> [--tiles tx_tz,tx_tz,...] [--out <dir>] [--force]
//       1 区を変換。既定の出力は temp/mission40b/<ward>/（gitignore 済み）。既に 37B/37H/38E で
//       tileset がある区は --force が無ければ再生成しない。
//   共通: --src <旧 buildings ディレクトリ> （コピー不要・読み取り専用）。--validate で 24 区の整合性検証。
//   node tools/mission40b-legacy-tiles-batch.cjs --all-available
//       旧タイルがローカルに完全に揃っていて、未変換の区だけを順に変換する。
//   node tools/mission40b-legacy-tiles-batch.cjs --verify <wardId> --against <dir>
//       変換結果 (ids/*.json) と既存 tileset の canonicalId を突き合わせる。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('./mission37b-build-3dtiles.cjs');

const ROOT = path.join(__dirname, '..');
const REPO_BLD = path.join(ROOT, 'public/map-data/osaka-city/buildings');
// 入力ルート。既定はリポジトリ内。--src <dir> または環境変数 LIVECITY_LEGACY_BUILDINGS で、コピーせずに
// 外部（例: 旧 livecity-data-pipeline の buildings/）を読み取り専用で直接指定できる。
let BLD = REPO_BLD;
function setSource(dir) { BLD = path.resolve(dir); }
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const r1 = (v) => Math.round(v * 10) / 10;

// 既に完成している tileset（再生成しない）。dir は public 配下、wardId は区。
function existingTilesets() {
  const out = [];
  const scan = (base, re) => {
    const abs = path.join(ROOT, 'public', base);
    if (!fs.existsSync(abs)) return;
    for (const d of fs.readdirSync(abs)) {
      const m = d.match(re);
      const rep = path.join(abs, d, 'build-report.json');
      if (!m || !fs.existsSync(rep)) continue;
      const r = readJson(rep);
      out.push({ dir: `${base}/${d}`, wardId: (r.dataset || '').replace(/^osaka-/, ''), tiles: r.selectedTiles, buildings: r.totals.buildings });
    }
  };
  scan('mission37b-3dtiles', /^osaka-sumiyoshi-9tile$/);
  scan('mission37h-3dtiles', /-sample$/);
  scan('mission38e-3dtiles', /^naniwa/);
  return out;
}

function inventory() {
  const rootPath = fs.existsSync(path.join(BLD, 'manifest.json')) ? path.join(BLD, 'manifest.json') : path.join(REPO_BLD, 'manifest.json');
  const root = readJson(rootPath);
  const built = existingTilesets();
  const wards = root.datasets.map((d) => {
    const dir = path.join(BLD, d.id);
    const mf = path.join(dir, 'manifest.json');
    let local = { present: false, tileFiles: 0, buildings: 0, complete: false };
    if (fs.existsSync(mf)) {
      const m = readJson(mf);
      const files = (m.tiles || []).filter((t) => fs.existsSync(path.join(dir, t.file || `tile_${t.tx}_${t.tz}.json`)));
      local = { present: true, tileFiles: files.length, buildings: files.reduce((n, t) => n + (t.count || 0), 0), complete: files.length === d.tiles };
    }
    const b = built.filter((x) => x.wardId === d.wardId);
    return {
      wardId: d.wardId, ward: d.ward, wardCode: d.wardCode,
      manifestBuildings: d.buildings, manifestTiles: d.tiles,
      legacyTilesLocal: local,
      cesium3dTiles: { tilesets: b.map((x) => x.dir), tiles: b.reduce((n, x) => n + x.tiles, 0), buildings: b.reduce((n, x) => n + x.buildings, 0) },
      action: local.complete ? (b.length ? 'converted-partial-or-full: use --force to rebuild' : 'convert-now (--ward)') : 'legacy tiles not in this checkout: needs owner-local tiles or PLATEAU re-fetch',
    };
  });
  const sum = (f) => wards.reduce((n, w) => n + f(w), 0);
  const rep = {
    generatedAt: new Date().toISOString(),
    sourceRoot: BLD === REPO_BLD ? 'repo' : BLD,
    rootManifest: { buildingCount: root.buildingCount, tileCount: root.tileCount, wardCount: root.wardCount, note: 'manifest の件数は記録値。タイル実体の有無は legacyTilesLocal を見ること' },
    totals: {
      wardsWithLegacyTilesLocal: wards.filter((w) => w.legacyTilesLocal.complete).length,
      legacyBuildingsLocal: sum((w) => w.legacyTilesLocal.buildings),
      wardsWithCesium3dTiles: wards.filter((w) => w.cesium3dTiles.buildings > 0).length,
      cesiumBuildings: sum((w) => w.cesium3dTiles.buildings),
      manifestBuildingsWithoutLocalTiles: sum((w) => (w.legacyTilesLocal.complete ? 0 : w.manifestBuildings)),
    },
    wards,
  };
  const out = path.join(ROOT, 'data/reports/mission40b-legacy-reuse', BLD === REPO_BLD ? 'inventory.json' : 'inventory-external.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rep, null, 1));
  return rep;
}

function convertWard(wardId, opts) {
  const dataset = 'osaka-' + wardId;
  const dir = path.join(BLD, dataset);
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error(`legacy tiles not found: ${path.relative(ROOT, dir)}`);
  const prior = existingTilesets().filter((x) => x.wardId === wardId);
  if (prior.length && !opts.force) return { ward: wardId, skipped: 'tileset exists (' + prior.map((p) => p.dir).join(', ') + '); use --force' };
  const out = path.resolve(opts.out || path.join(ROOT, 'temp/mission40b', wardId));
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const sel = manifest.tiles;
  if (!sel.length) throw new Error('no tiles');
  const t0 = Date.now();
  const rep = build({ dataset, srcDir: dir, out, all: true, group: 4, coarseError: 40, coarseMinArea: 100 });
  return finishWard(wardId, dir, out, sel, rep, Date.now() - t0);
}

function finishWard(wardId, dir, out, sel, rep, ms) {
  fs.mkdirSync(path.join(out, 'attrs'), { recursive: true });
  let attrBytes = 0;
  for (const t of sel) {
    const tile = readJson(path.join(dir, t.file || `tile_${t.tx}_${t.tz}.json`));
    const byId = {};
    for (const b of tile.buildings) byId[b.id] = [b.h, b.usage || null, b.repX, b.repZ, b.z0 || 0];
    const s = JSON.stringify({ tx: t.tx, tz: t.tz, count: tile.buildings.length, fields: ['h', 'usage', 'repX', 'repZ', 'z0'], byId });
    attrBytes += s.length;
    fs.writeFileSync(path.join(out, 'attrs', `t_${t.tx}_${t.tz}.json`), s);
  }
  const total = fs.readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .reduce((n, e) => n + fs.statSync(path.join(e.parentPath || e.path, e.name)).size, 0);
  const manifest = readJson(path.join(dir, 'manifest.json'));
  fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify({
    mission: '40B', wardId, wardCode: manifest.wardCode, generatedAt: new Date().toISOString(),
    source: '旧 Live City 建物タイル public/map-data/osaka-city/buildings/' + path.basename(dir) + '（PLATEAU 大阪市 2024 LOD1 由来。再ダウンロードなし）',
    canonicalId: '旧タイルの id（CityGML gml:id）をそのまま使用。新規採番なし',
    counts: { tiles: sel.length, buildings: rep.totals.buildings, skipped: rep.totals.skipped },
    licenseNote: '出典: 国土交通省 Project PLATEAU。利用条件の最終確認はリポジトリ内に記録なし（公開前に要確認）。',
  }, null, 1));
  return { ward: wardId, tiles: sel.length, buildings: rep.totals.buildings, uniqueIds: rep.totals.uniqueCanonicalIds, skipped: rep.totals.skipped, fallbacks: rep.totals.fallbacks,
    glbBytes: rep.totals.glbBytes, attrBytes, totalBytes: total, ms, out: path.relative(ROOT, out) };
}

// 選択タイルのみ変換する場合は、そのタイルだけを持つ一時ソースを作る（読み取り専用の元は触らない）
function convertSubset(wardId, tileKeys, outDir) {
  const os = require('node:os');
  const dir = path.join(BLD, 'osaka-' + wardId);
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const want = new Set(tileKeys);
  const sel = manifest.tiles.filter((t) => want.has(`${t.tx}_${t.tz}`));
  if (sel.length !== want.size) throw new Error('some tiles not found in manifest');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm40b-src-'));
  try {
    for (const t of sel) fs.copyFileSync(path.join(dir, t.file || `tile_${t.tx}_${t.tz}.json`), path.join(tmp, t.file || `tile_${t.tx}_${t.tz}.json`));
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({ ...manifest, tiles: sel }));
    const out = path.resolve(outDir);
    const t0 = Date.now();
    const rep = build({ dataset: 'osaka-' + wardId, srcDir: tmp, out, all: true, group: 4, coarseError: 40, coarseMinArea: 100 });
    return finishWard(wardId, dir, out, sel, rep, Date.now() - t0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// 変換結果 ids/*.json と比較対象 tileset の ids/*.json の canonicalId 集合を突き合わせる
function idSet(dir) {
  const s = new Set();
  const d = path.join(dir, 'ids');
  for (const f of fs.readdirSync(d)) {
    if (!f.startsWith('t_')) continue; // g_* は粗い LOD（同じ建物の簡略）
    for (const id of readJson(path.join(d, f))) s.add(id);
  }
  return s;
}
function verify(aDir, bDir) {
  const a = idSet(path.resolve(aDir)), b = idSet(path.resolve(bDir));
  let common = 0; for (const id of a) if (b.has(id)) common++;
  return { a: a.size, b: b.size, common, onlyA: a.size - common, onlyB: b.size - common, identical: common === a.size && common === b.size };
}

// ---- 40D: 重複 ID の診断ポリシー（元データは変更しない・建物は削除しない） ----
const crypto = require('node:crypto');
// footprint を 0.1m に丸め、頂点列を並べ替えて正規化（開始点・向きに依存しない）→ 短いハッシュ
function fpHash(fp, h) {
  const pts = (fp || []).map((q) => r1(q[0]) + ',' + r1(q[1]));
  if (pts.length > 1 && pts[0] === pts[pts.length - 1]) pts.pop();
  pts.sort();
  return crypto.createHash('md5').update(pts.join(';') + '|' + r1(h || 0)).digest('hex').slice(0, 12);
}
// 同一 ID が 2 区にあるとき: identical = 形状・高さが同じ（境界またぎの重複収録＝無害）、conflict = 同じ ID で形状が違う（真の衝突）
function classifyDup(a, b) { return a.hash === b.hash ? 'identical' : 'conflict'; }
function countTiles(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countTiles(p); else if (/^tile_.*\.json$/.test(e.name)) n++;
  }
  return n;
}
// タイル数のスコープ: 24 区ディレクトリ（root manifest の id）と、それ以外（osm-fallback / unclassified 等）を分けて集計
function tileScope(root) {
  const wardDirs = new Set(root.datasets.map((d) => d.id));
  const perWard = {}; const other = {}; let wardTotal = 0; let otherTotal = 0;
  for (const e of fs.readdirSync(BLD, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const n = countTiles(path.join(BLD, e.name));
    if (wardDirs.has(e.name)) { perWard[e.name] = n; wardTotal += n; } else { other[e.name] = n; otherTotal += n; }
  }
  return { wardDirTiles: wardTotal, otherDirTiles: otherTotal, otherDirs: other, totalRecursive: wardTotal + otherTotal, expectedFromManifest: root.tileCount, perWard };
}

// 24 区の整合性検証（読み取りのみ）: manifest 件数 vs 実ファイル、ID 一意・形式、座標・高さ・タイル帰属
function validate() {
  const root = readJson(fs.existsSync(path.join(BLD, 'manifest.json')) ? path.join(BLD, 'manifest.json') : path.join(REPO_BLD, 'manifest.json'));
  const seen = new Map(); // canonicalId -> {ward, hash, file, repX, repZ, h}（区間重複検出）
  const dupPairs = {}; // 'wardA|wardB' -> {identical, conflict}
  const dupSamples = []; // 区組・座標・footprint 比較（最大 60 件）
  const badHeightSamples = []; // 最大 50 件
  const wards = [];
  let problems = 0;
  for (const d of root.datasets) {
    const dir = path.join(BLD, d.id);
    const w = { wardId: d.wardId, ward: d.ward, manifestBuildings: d.buildings, manifestTiles: d.tiles, status: 'ok', tilesFound: 0, tilesMissing: [], buildings: 0,
      countMismatchTiles: 0, badId: 0, dupIdWithinWard: 0, dupIdAcrossWards: 0, dupIdAcrossWardsIdentical: 0, dupIdAcrossWardsConflict: 0, badFootprint: 0, badHeight: 0, outOfTile: 0, outOfBounds: 0, maxHeight: 0, issues: [] };
    const mf = path.join(dir, 'manifest.json');
    if (!fs.existsSync(mf)) { w.status = 'missing'; w.issues.push('ward manifest not found'); wards.push(w); problems++; continue; }
    const m = readJson(mf);
    const b = m.bounds, ts = m.tileSize || 500, tol = 1;
    const own = new Set();
    for (const t of m.tiles || []) {
      const f = path.join(dir, t.file || `tile_${t.tx}_${t.tz}.json`);
      if (!fs.existsSync(f)) { w.tilesMissing.push(path.basename(f)); continue; }
      w.tilesFound++;
      const tile = readJson(f);
      if (tile.buildings.length !== (t.count != null ? t.count : tile.count)) w.countMismatchTiles++;
      for (const x of tile.buildings) {
        w.buildings++;
        if (typeof x.id !== 'string' || !/^bldg_/.test(x.id)) w.badId++;
        if (own.has(x.id)) w.dupIdWithinWard++; else own.add(x.id);
        const cur = { ward: d.wardId, file: path.relative(BLD, f), hash: fpHash(x.fp, x.h), repX: x.repX, repZ: x.repZ, h: x.h };
        const prev = seen.get(x.id);
        if (prev && prev.ward !== d.wardId) {
          w.dupIdAcrossWards++;
          const kind = classifyDup(prev, cur);
          if (kind === 'identical') w.dupIdAcrossWardsIdentical++; else w.dupIdAcrossWardsConflict++;
          const key = prev.ward + '|' + d.wardId;
          (dupPairs[key] = dupPairs[key] || { identical: 0, conflict: 0 })[kind]++;
          if (dupSamples.length < 60 && (kind === 'conflict' || dupSamples.length < 30)) {
            dupSamples.push({ id: x.id, kind, first: prev, second: cur, distM: Number.isFinite(prev.repX) && Number.isFinite(x.repX) ? r1(Math.hypot(prev.repX - x.repX, prev.repZ - x.repZ)) : null, fpVertices: (x.fp || []).length });
          }
        } else if (!prev) seen.set(x.id, cur);
        const fp = x.fp;
        if (!Array.isArray(fp) || fp.length < 3 || !fp.every((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]))) w.badFootprint++;
        const h = x.h;
        if (!Number.isFinite(h) || h <= 0 || h > 400) {
          w.badHeight++;
          if (badHeightSamples.length < 50) badHeightSamples.push({ ward: d.wardId, id: x.id, h: Number.isFinite(h) ? h : String(h), file: path.relative(BLD, f), repX: x.repX, repZ: x.repZ, usage: x.usage || null });
        } else if (h > w.maxHeight) w.maxHeight = h;
        if (Number.isFinite(x.repX) && Number.isFinite(x.repZ)) {
          if (Math.floor(x.repX / ts) !== t.tx || Math.floor(x.repZ / ts) !== t.tz) w.outOfTile++;
          if (b && (x.repX < b.minX - tol || x.repX > b.maxX + tol || x.repZ < b.minZ - tol || x.repZ > b.maxZ + tol)) w.outOfBounds++;
        }
      }
    }
    if (w.tilesMissing.length) w.issues.push(w.tilesMissing.length + ' tile files missing');
    if (w.buildings !== d.buildings) w.issues.push(`buildings ${w.buildings} != root manifest ${d.buildings}`);
    if (w.tilesFound + w.tilesMissing.length !== d.tiles) w.issues.push(`tiles ${w.tilesFound + w.tilesMissing.length} != root manifest ${d.tiles}`);
    // 形状まで同一の区間重複は無害（境界またぎの重複収録）として notes 扱い。形状が違う ID 衝突だけを issue とする
    if (w.dupIdAcrossWardsIdentical) w.notes = ['dupIdAcrossWardsIdentical=' + w.dupIdAcrossWardsIdentical + ' (same geometry; benign, kept)'];
    for (const k of ['countMismatchTiles', 'badId', 'dupIdWithinWard', 'dupIdAcrossWardsConflict', 'badFootprint', 'badHeight', 'outOfTile', 'outOfBounds']) if (w[k]) w.issues.push(k + '=' + w[k]);
    if (w.issues.length) { w.status = 'issues'; problems++; }
    wards.push(w);
  }
  const rep = { generatedAt: new Date().toISOString(), sourceRoot: BLD === REPO_BLD ? 'repo' : BLD,
    tileScope: tileScope(root), dupPairs, dupSamples, badHeightSamples,
    policy: 'read-only; no building is removed; identical cross-ward duplicates are benign (ward tilesets are mounted one ward at a time); same-id/different-geometry is a conflict and that ward is excluded from --only-ok',
    totals: { wards: wards.length, ok: wards.filter((w) => w.status === 'ok').length, missing: wards.filter((w) => w.status === 'missing').length, withIssues: wards.filter((w) => w.status === 'issues').length,
      buildings: wards.reduce((n, w) => n + w.buildings, 0), manifestBuildings: root.buildingCount }, wards };
  const out = path.join(ROOT, 'data/reports/mission40b-legacy-reuse', BLD === REPO_BLD ? 'validate.json' : 'validate-external.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rep, null, 1));
  return rep;
}

function main() {
  const args = process.argv.slice(2);
  const has = (k) => args.includes('--' + k);
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const src = opt('src', process.env.LIVECITY_LEGACY_BUILDINGS);
  if (src) { if (!fs.existsSync(src)) { console.error('--src not found: ' + src); process.exit(2); } setSource(src); }
  if (has('validate')) { const r = validate(); console.log(JSON.stringify(r.totals, null, 1)); const sc = r.tileScope; console.log('tile scope: ward dirs=' + sc.wardDirTiles + ' (expected ' + sc.expectedFromManifest + '), other dirs=' + sc.otherDirTiles + ' ' + JSON.stringify(sc.otherDirs)); console.log('dup pairs: ' + JSON.stringify(r.dupPairs)); for (const b of r.badHeightSamples.slice(0, 10)) console.log('badHeight', JSON.stringify(b)); for (const w of r.wards) if (w.status !== 'ok') console.log(w.wardId, w.status, w.issues.join('; ')); process.exit(r.totals.ok === r.totals.wards ? 0 : 1); }
  if (has('inventory')) { console.log(JSON.stringify(inventory().totals, null, 1)); return; }
  if (has('verify')) { console.log(JSON.stringify(verify(opt('against'), opt('verify')), null, 1)); return; }
  if (has('all-available')) {
    const inv = inventory();
    const only = opt('wards') ? new Set(opt('wards').split(',')) : null; // 段階変換: 指定区のみ
    const okSet = has('only-ok') ? new Set(validate().wards.filter((x) => x.status === 'ok').map((x) => x.wardId)) : null; // 検証合格区のみ
    for (const w of inv.wards) {
      if (!w.legacyTilesLocal.complete || w.cesium3dTiles.buildings > 0) continue;
      if (only && !only.has(w.wardId)) continue;
      if (okSet && !okSet.has(w.wardId)) { console.log(JSON.stringify({ ward: w.wardId, skipped: 'not validated ok (--only-ok)' })); continue; }
      console.log(JSON.stringify(convertWard(w.wardId, { force: has('force'), out: opt('out-root') ? path.join(opt('out-root'), w.wardId) : undefined })));
    }
    return;
  }
  const ward = opt('ward');
  if (!ward) { console.error('usage: [--src <buildings dir>] --inventory | --validate | --ward <id> [--tiles tx_tz,...] [--out dir] [--force] | --all-available | --verify <dir> --against <dir>'); process.exit(2); }
  const tiles = opt('tiles') ? opt('tiles').split(',') : null;
  if (tiles) {
    console.log(JSON.stringify(convertSubset(ward, tiles, opt('out', path.join(ROOT, 'temp/mission40b', ward))), null, 1));
  } else {
    console.log(JSON.stringify(convertWard(ward, { out: opt('out'), force: has('force') }), null, 1));
  }
}

module.exports = { fpHash, classifyDup, countTiles, tileScope, setSource, validate, inventory, convertWard, convertSubset, verify, idSet, existingTilesets };
if (require.main === module) main();
