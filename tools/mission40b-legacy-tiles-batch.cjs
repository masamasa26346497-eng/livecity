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
//   node tools/mission40b-legacy-tiles-batch.cjs --all-available
//       旧タイルがローカルに完全に揃っていて、未変換の区だけを順に変換する。
//   node tools/mission40b-legacy-tiles-batch.cjs --verify <wardId> --against <dir>
//       変換結果 (ids/*.json) と既存 tileset の canonicalId を突き合わせる。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('./mission37b-build-3dtiles.cjs');

const ROOT = path.join(__dirname, '..');
const BLD = path.join(ROOT, 'public/map-data/osaka-city/buildings');
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
  const root = readJson(path.join(BLD, 'manifest.json'));
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
  const out = path.join(ROOT, 'data/reports/mission40b-legacy-reuse/inventory.json');
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

function main() {
  const args = process.argv.slice(2);
  const has = (k) => args.includes('--' + k);
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  if (has('inventory')) { console.log(JSON.stringify(inventory().totals, null, 1)); return; }
  if (has('verify')) { console.log(JSON.stringify(verify(opt('against'), opt('verify')), null, 1)); return; }
  if (has('all-available')) {
    const inv = inventory();
    for (const w of inv.wards) {
      if (!w.legacyTilesLocal.complete || w.cesium3dTiles.buildings > 0) continue;
      console.log(JSON.stringify(convertWard(w.wardId, { force: has('force') })));
    }
    return;
  }
  const ward = opt('ward');
  if (!ward) { console.error('usage: --inventory | --ward <id> [--tiles tx_tz,...] [--out dir] [--force] | --all-available | --verify <dir> --against <dir>'); process.exit(2); }
  const tiles = opt('tiles') ? opt('tiles').split(',') : null;
  if (tiles) {
    console.log(JSON.stringify(convertSubset(ward, tiles, opt('out', path.join(ROOT, 'temp/mission40b', ward))), null, 1));
  } else {
    console.log(JSON.stringify(convertWard(ward, { out: opt('out'), force: has('force') }), null, 1));
  }
}

module.exports = { inventory, convertWard, convertSubset, verify, idSet, existingTilesets };
if (require.main === module) main();
