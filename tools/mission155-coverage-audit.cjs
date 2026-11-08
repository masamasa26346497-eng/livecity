#!/usr/bin/env node
'use strict';
// Mission 155: 24区の建物「網羅性」監査（READ-ONLY。--out 以外は何も書かない。ネットワーク・アップロードなし）。
//   node tools/mission155-coverage-audit.cjs [--src <旧 buildings dir>] [--converted <変換出力 root>] [--rendered <browser diag json>]
//        [--auto] [--out <json>] [--root <repo root>]
//   --auto : 既知の PC 上の場所（C:\lc141, %LOCALAPPDATA%\LiveCity-3DTiles-Out-24, ..\livecity-data-pipeline\...）を「存在すれば」読む。
// 区ごと・500m tile ごとに 5 つの段を突合し、「変換済み」と「描画済み」を混同しない:
//   declared  = public/map-data/osaka-city/buildings/manifest.json の宣言棟数（記録値。実体ではない）
//   source    = 旧タイル <src>/osaka-<区>/tile_*.json の実 id 数（アクセスできた場合のみ。無ければ null=「アクセス不可」）
//   converted = 変換出力の ids/t_*.json の実 id 数 + tileset.json が tiles/t_*.glb を参照 + GLB が実在
//   published = Git 追跡の公開 tileset（37H/38E/40J/37B）の棟数
//   rendered  = ブラウザ診断 JSON（?diag=1 の __mission37g.stats.diag155）の読込済み leaf 棟数（--rendered があれば）
// 原因分類（tile 単位）: C1 真の空地(ソースにも無い) / C2 ソース欠落の疑い / C3 変換で脱落(id 欠け) / C4 3D Tiles・GLB 欠落
//   C5 配信・HTTP・未接続 / C6 表示側(LOD・カリング・区切替)。C1 と C2 はソース側だけでは区別できないので「要確認」に残す（推測で断定しない）。
// 出力は集計値と tile キー(t_x_z)のみ。建物 ID・個人情報・パスの中身は出さない（パスは "accessible: true/false" のみ）。
const fs = require('fs');
const path = require('path');

const SCHEMA = 'livecity.mission155.coverage/1';
const TILE = 500;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const listDir = (p) => { try { return fs.readdirSync(p); } catch (e) { return []; } };
const keyOf = (x, z) => 't_' + x + '_' + z;

// ── 点が区ポリゴン内か（outer の ray casting、holes 除外） ──
function inRing(x, z, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function inWard(x, z, polygons) {
  for (const p of polygons || []) {
    if (!inRing(x, z, p.outer)) continue;
    if ((p.holes || []).some((h) => inRing(x, z, h))) continue;
    return true;
  }
  return false;
}
// tile セル（500m）が区ポリゴンと重なるか: 4 隅 + 中心 + セル内サンプル 5x5 のどれかが区内
function cellTouchesWard(tx, tz, polygons) {
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
    if (inWard((tx + i / 4) * TILE, (tz + j / 4) * TILE, polygons)) return true;
  }
  return false;
}

// ── 入力の自動検出（存在するものだけ読む。作らない・書かない） ──
function autoCandidates(root) {
  const c = { src: [], converted: [] };
  const win = process.platform === 'win32';
  const add = (k, p) => { if (p) c[k].push(path.resolve(p)); };
  add('src', path.join(root, '..', 'livecity-data-pipeline', 'public', 'map-data', 'osaka-city', 'buildings'));
  add('src', path.join(root, 'public', 'map-data', 'osaka-city', 'buildings'));
  add('converted', path.join(root, '..', 'livecity-3dtiles-out'));
  if (win) {
    add('src', 'C:\\lc141\\buildings');
    add('src', 'C:\\lc141');
    add('src', 'C:\\lc141\\livecity-data-pipeline\\public\\map-data\\osaka-city\\buildings');
    if (process.env.LOCALAPPDATA) add('converted', path.join(process.env.LOCALAPPDATA, 'LiveCity-3DTiles-Out-24'));
    add('converted', 'C:\\lc141\\out');
  }
  return c;
}
function pickSrc(list) {
  for (const p of list) if (isDir(p) && listDir(p).some((n) => /^osaka-[a-z-]+$/.test(n) && isDir(path.join(p, n)))) return p;
  return null;
}

// ── source: 旧タイル ──
function readSource(src, wardId) {
  if (!src) return null;
  const d = path.join(src, 'osaka-' + wardId);
  if (!isDir(d)) return { present: false, tiles: {}, total: 0 };
  const tiles = {};
  let total = 0;
  for (const f of listDir(d)) {
    const m = f.match(/^tile_(-?\d+)_(-?\d+)\.json$/);
    if (!m) continue;
    let n = 0;
    try { n = (readJson(path.join(d, f)).buildings || []).length; } catch (e) { n = -1; }
    tiles[keyOf(m[1], m[2])] = n;
    if (n > 0) total += n;
  }
  return { present: true, tiles, total };
}

// ── converted/tracked tileset: ids + tileset.json の参照 + GLB の実在 ──
function readTileset(dir) {
  if (!dir || !isDir(dir)) return null;
  const out = { ids: {}, referenced: new Set(), glb: new Set(), total: 0, hasTileset: exists(path.join(dir, 'tileset.json')) };
  for (const f of listDir(path.join(dir, 'ids'))) {
    const m = f.match(/^(t_-?\d+_-?\d+)\.json$/);
    if (!m) continue;
    try { const a = readJson(path.join(dir, 'ids', f)); const n = (Array.isArray(a) ? a : a.ids || []).length; out.ids[m[1]] = n; out.total += n; } catch (e) { out.ids[m[1]] = -1; }
  }
  for (const f of listDir(path.join(dir, 'tiles'))) { const m = f.match(/^(t_-?\d+_-?\d+)\.glb$/); if (m) out.glb.add(m[1]); }
  if (out.hasTileset) {
    try {
      const txt = fs.readFileSync(path.join(dir, 'tileset.json'), 'utf8');
      for (const m of txt.matchAll(/tiles\/(t_-?\d+_-?\d+)\.glb/g)) out.referenced.add(m[1]);
    } catch (e) { out.hasTileset = false; }
  }
  return out;
}
function findConvertedDir(root, wardId) {
  if (!root) return null;
  const cands = [path.join(root, wardId), path.join(root, 'ext-3dtiles', wardId)];
  for (const base of [root, path.join(root, 'pc23')]) {
    const names = listDir(base).filter((n) => n === wardId + '-a' + n.slice((wardId + '-a').length) && /^[a-z-]+-a\d+$/.test(n) && n.startsWith(wardId + '-a'));
    names.sort((a, b) => parseInt(b.replace(/.*-a/, ''), 10) - parseInt(a.replace(/.*-a/, ''), 10));
    for (const n of names) { cands.push(path.join(base, n, wardId)); cands.push(path.join(base, n)); }
  }
  for (const c of cands) if (isDir(path.join(c, 'ids'))) return c;
  return null;
}
function trackedTilesets(root) {
  const byCode = {};
  for (const top of ['public/mission37h-3dtiles', 'public/mission38e-3dtiles', 'public/mission40j-3dtiles', 'public/mission37b-3dtiles']) {
    for (const d of listDir(path.join(root, top))) {
      const dir = path.join(root, top, d);
      if (!isDir(path.join(dir, 'ids'))) continue;
      let sj = {}; try { sj = readJson(path.join(dir, 'source.json')); } catch (e) { /* 37B の住吉 9 tile には source.json が無い */ }
      const code = String(sj.wardCode || (d === 'osaka-sumiyoshi-9tile' ? '27120' : ''));
      if (!code) continue;
      (byCode[code] = byCode[code] || []).push({ rel: path.relative(root, dir).split(path.sep).join('/'), ts: readTileset(dir) });
    }
  }
  return byCode;
}

// ── 1 区の監査 ──
function auditWard(ctx, ds) {
  const w = ctx.wardsByCode[ds.wardCode] || {};
  const polygons = w.polygons || [];
  const srcInfo = ctx.src ? readSource(ctx.src, ds.wardId) : null;
  const convDir = findConvertedDir(ctx.converted, ds.wardId);
  const conv = convDir ? readTileset(convDir) : null;
  const tracked = ctx.tracked[ds.wardCode] || [];
  const pubKeys = new Set(); let pubTotal = 0;
  for (const t of tracked) { for (const k of Object.keys(t.ts.ids)) pubKeys.add(k); pubTotal += t.ts.total; }
  const rendered = ctx.rendered && ctx.rendered.wards ? ctx.rendered.wards[ds.wardId] || ctx.rendered.wards[ds.wardCode] || null : null;

  const sourceTiles = srcInfo && srcInfo.present ? Object.keys(srcInfo.tiles) : null;
  const tileKeys = new Set([...(sourceTiles || []), ...(conv ? Object.keys(conv.ids) : []), ...pubKeys]);
  const cause = { C2_sourceGapSuspect: 0, C3_droppedIds: 0, C4_glbOrTilesetMissing: 0, C5_notDeliveredOrUnreferenced: 0, C6_viewerSide: 0 };
  const tilesDetail = [];
  for (const k of [...tileKeys].sort()) {
    const s = srcInfo && srcInfo.present ? (k in srcInfo.tiles ? srcInfo.tiles[k] : null) : undefined;   // undefined = アクセス不可
    const c = conv ? (k in conv.ids ? conv.ids[k] : null) : undefined;
    const row = { tile: k, source: s, converted: c };
    if (conv) {
      row.tilesetRefs = conv.referenced.has(k); row.glb = conv.glb.has(k);
      if (typeof c === 'number' && c > 0 && (!row.tilesetRefs || !row.glb)) { row.cause = 'C4'; cause.C4_glbOrTilesetMissing++; }
      else if (typeof s === 'number' && s > 0 && (c == null || c < s)) { row.cause = 'C3'; cause.C3_droppedIds += (s - Math.max(0, c || 0)); }
    } else if (typeof s === 'number' && s > 0 && !pubKeys.has(k)) { row.cause = 'C5'; cause.C5_notDeliveredOrUnreferenced++; }
    if (rendered && rendered.leafLoaded && typeof c === 'number' && c > 0 && !rendered.leafLoaded.includes(k) && !rendered.leafFailed) { /* 視点依存: 診断のみ */ }
    if (rendered && rendered.leafFailed && rendered.leafFailed.includes(k)) { row.cause = 'C5'; row.failed = true; cause.C5_notDeliveredOrUnreferenced++; }
    if (row.cause || row.failed) tilesDetail.push(row);
  }

  // 空白セル（区ポリゴンに触れるのに、どの段にも tile が無い 500m セル）: C1(真の空地) か C2(ソース欠落) か。ここでは断定しない。
  const gap = { cells: 0, sample: [] };
  const b = w.bbox || ds.bounds;
  if (b && polygons.length) {
    const x0 = Math.floor((b.minX ?? b.x0) / TILE), x1 = Math.floor((b.maxX ?? b.x1) / TILE), z0 = Math.floor((b.minZ ?? b.z0) / TILE), z1 = Math.floor((b.maxZ ?? b.z1) / TILE);
    const have = new Set(srcInfo && srcInfo.present ? Object.keys(srcInfo.tiles) : []);   // ソース優先。ソースが無ければ declared bounds 内のみで判定不能
    if (srcInfo && srcInfo.present) {
      for (let tx = x0; tx <= x1; tx++) for (let tz = z0; tz <= z1; tz++) {
        if (have.has(keyOf(tx, tz))) continue;
        if (!cellTouchesWard(tx, tz, polygons)) continue;
        gap.cells++; if (gap.sample.length < 12) gap.sample.push(keyOf(tx, tz));
      }
    } else gap.cells = null;
  }

  const sourceTotal = srcInfo && srcInfo.present ? srcInfo.total : null;
  const row = {
    wardId: ds.wardId, wardCode: ds.wardCode, ward: ds.ward,
    declared: { buildings: ds.buildings, tiles: ds.tiles },
    source: { accessible: !!(srcInfo && srcInfo.present), buildings: sourceTotal, tiles: sourceTiles ? sourceTiles.length : null },
    convertedLocal: conv ? { found: true, buildings: conv.total, tiles: Object.keys(conv.ids).length, tilesetJson: conv.hasTileset, referencedTiles: conv.referenced.size, glbTiles: conv.glb.size } : { found: false },
    publishedGit: { tilesets: tracked.map((t) => t.rel), buildings: pubTotal, tiles: pubKeys.size },
    rendered: rendered ? { buildings: rendered.leafBuildings ?? null, leafLoaded: (rendered.leafLoaded || []).length, leafFailed: (rendered.leafFailed || []).length } : null,
    declaredVsSource: sourceTotal == null ? null : sourceTotal - ds.buildings,
    coverage: {},
    causes: cause,
    gapCellsNoSourceTile: gap.cells, gapSample: gap.sample,
    tileIssues: tilesDetail.slice(0, 60), tileIssueCount: tilesDetail.length,
  };
  const pct = (n, d) => (d ? Math.round((n / d) * 10000) / 100 : null);
  const base = sourceTotal != null ? sourceTotal : ds.buildings;
  row.coverage = {
    baseline: sourceTotal != null ? 'source' : 'declared(manifest,unverified)',
    convertedPct: conv ? pct(conv.total, base) : null,
    publishedGitPct: pct(pubTotal, base),
    renderedPct: rendered && rendered.leafBuildings != null ? pct(rendered.leafBuildings, base) : null,
  };
  row.status = !conv && pubTotal === 0 ? 'not-delivered' : (conv ? (conv.total >= base && cause.C3_droppedIds === 0 && cause.C4_glbOrTilesetMissing === 0 ? 'converted-full' : 'converted-partial') : (pubTotal >= base ? 'published-full' : 'published-partial'));
  // 修復計画: ソースがあり変換に無い/欠けた tile だけ（既存 40B の subset 変換。既存 tileset は変更しない＝別 out に出す）
  const missing = tilesDetail.filter((t) => t.cause === 'C3' && typeof t.source === 'number' && t.source > 0).map((t) => t.tile.replace(/^t_/, ''));
  row.repairPlan = missing.length ? { tiles: missing.length, command: 'node tools/mission40b-legacy-tiles-batch.cjs --src <旧 buildings> --ward ' + ds.wardId + ' --tiles ' + missing.slice(0, 200).join(',') + ' --out <新しい空フォルダ>' } : null;
  return row;
}

function run(opts) {
  const root = path.resolve(opts.root || path.join(__dirname, '..'));
  const man = readJson(path.join(root, 'public/map-data/osaka-city/buildings/manifest.json'));
  const wardsDoc = readJson(path.join(root, 'public/mission37g-data/osaka-24-wards.json'));
  const wardsByCode = {}; for (const w of wardsDoc.wards) wardsByCode[w.wardCode] = w;
  const auto = opts.auto ? autoCandidates(root) : { src: [], converted: [] };
  const srcList = [opts.src, ...auto.src, path.join(root, 'public', 'map-data', 'osaka-city', 'buildings')].filter(Boolean).map((p) => path.resolve(p));
  const src = pickSrc(srcList);
  const convList = [opts.converted, ...auto.converted].filter(Boolean).map((p) => path.resolve(p));
  const converted = convList.find((p) => isDir(p)) || null;
  let rendered = null;
  if (opts.rendered) { try { rendered = readJson(opts.rendered); } catch (e) { rendered = null; } }
  const ctx = { src, converted, wardsByCode, tracked: trackedTilesets(root), rendered };
  const wards = man.datasets.map((ds) => auditWard(ctx, ds));
  const sum = (f) => wards.reduce((a, w) => a + (f(w) || 0), 0);
  return {
    schema: SCHEMA, kind: 'audit', readOnly: true, uploaded: false,
    inputs: { sourceAccessible: !!src, convertedRootAccessible: !!converted, renderedProvided: !!rendered, autoDetect: !!opts.auto, candidatesChecked: { src: srcList.length, converted: convList.length } },
    manifest: { wards: man.wardCount, declaredBuildings: man.buildingCount, declaredTiles: man.tileCount, sumOfWardDeclared: sum((w) => w.declared.buildings) },
    totals: {
      sourceBuildings: sum((w) => w.source.buildings),
      sourceWardsAccessible: wards.filter((w) => w.source.accessible).length,
      convertedLocalBuildings: converted ? sum((w) => w.convertedLocal.buildings) : null,
      publishedGitBuildings: sum((w) => w.publishedGit.buildings),
      renderedBuildings: rendered ? sum((w) => (w.rendered && w.rendered.buildings) || 0) : null,
      wardsNotDelivered: wards.filter((w) => w.status === 'not-delivered').length,
      wardsWithTileIssues: wards.filter((w) => w.tileIssueCount > 0).length,
      droppedIds: sum((w) => w.causes.C3_droppedIds),
    },
    wards,
    note: 'converted(変換済み) と rendered(描画済み) は別。source にアクセスできない場合 source=null で、declared(manifest 記録値)は実体の証拠ではない。',
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auto') o.auto = true;
    else if (['--src', '--converted', '--rendered', '--out', '--root'].includes(a)) o[a.slice(2)] = argv[++i];
  }
  return o;
}
function main() {
  const o = parseArgs(process.argv.slice(2));
  const r = run(o);
  if (o.out) { fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true }); fs.writeFileSync(o.out, JSON.stringify(r, null, 1)); }
  const t = r.totals;
  console.log('Mission 155 coverage audit (read-only)');
  console.log('source accessible: ' + r.inputs.sourceAccessible + ' | converted root accessible: ' + r.inputs.convertedRootAccessible + ' | rendered json: ' + r.inputs.renderedProvided);
  console.log('manifest declared: ' + r.manifest.declaredBuildings + ' bldgs / ' + r.manifest.declaredTiles + ' tiles (record only)');
  console.log('source wards accessible=' + t.sourceWardsAccessible + '/24 | source=' + t.sourceBuildings + ' convertedLocal=' + t.convertedLocalBuildings + ' publishedGit=' + t.publishedGitBuildings + ' rendered=' + t.renderedBuildings);
  for (const w of r.wards) console.log(w.wardId.padEnd(16) + w.status.padEnd(20) + ' declared=' + w.declared.buildings + ' source=' + w.source.buildings + ' conv=' + (w.convertedLocal.found ? w.convertedLocal.buildings : '-') + ' git=' + w.publishedGit.buildings + ' issues=' + w.tileIssueCount + ' dropped=' + w.causes.C3_droppedIds);
  if (o.out) console.log('wrote ' + o.out);
}
if (require.main === module) main();
module.exports = { run, auditWard, inWard, cellTouchesWard, findConvertedDir, readTileset, SCHEMA };
