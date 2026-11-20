#!/usr/bin/env node
'use strict';
// Mission 45G: 遠景 LOD0（建物密度の概略ブロック）を、既存の 45D 変換物の attrs から決定的に作る LOCAL 専用ツール。
//   node tools/mission45g-build-lod0.cjs --src <45D 出力ルート（読み取りのみ）> --out <新しい出力フォルダ> [--cell 200] [--min-count 2] [--plan]
// - 入力は 45D 出力の <ward>/attrs/t_*.json（byId: [h, usage, repX, repZ, z0]）と source.json（wardCode）だけ。旧データ・GLB・ids は読まない。書かない。
// - 出力は 45D ルートの「外」の別フォルダ（マーカー .livecity-45g-lod0.json 付き）。45D の不変ルール（許可名だけのルート）を壊さないため、45D ルート内には作らない。
//   リポジトリ内・public/・OneDrive 同期フォルダ・入力の内側は拒否。既存の空でないフォルダ（マーカー無し）にも書かない。--plan は何も書かない。
// - 作るのは 100〜250m セルごとの「概略ブロック」（平均高さの角柱）。実棟ではない。ID は lod0_<区コード>_<cx>_<cz> で、canonicalId（bldg_）とは別。
//   セルの棟数が --min-count 未満のものは出さない（1 棟を街区ブロックに見せない）。高さの欠損値(>400m)は平均から除き、件数をレポートに残す。
// - 乱数・時刻を使わない。同じ入力は同じバイト列になる。
const fs = require('fs');
const path = require('path');
const B = require('./mission37b-build-3dtiles.cjs');

const MARKER = '.livecity-45g-lod0.json';
const SCHEMA = 'livecity.mission45g.lod0/1';
const D2R = Math.PI / 180;
const err = (m, code) => Object.assign(new Error(m), { code });
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function syncRoots() {
  const r = [];
  for (const v of [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]) if (v) r.push(v);
  if (process.env.USERPROFILE) r.push(path.join(process.env.USERPROFILE, 'OneDrive'));
  return r.map((x) => path.resolve(x).toLowerCase() + path.sep);
}
const inside = (child, parent) => { const c = path.resolve(child) + path.sep, p = path.resolve(parent) + path.sep; return c.toLowerCase().startsWith(p.toLowerCase()); };

// <src> 以下（深さ 4 まで）で attrs/ と source.json を持つ区ディレクトリを集める。シンボリックリンクは辿らない。
function findWardDirs(src) {
  const out = [];
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    if (ents.some((e) => e.name === 'source.json' && e.isFile()) && ents.some((e) => e.name === 'attrs' && e.isDirectory())) { out.push(d); return; }
    if (depth >= 4) return;
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(d, e.name), depth + 1);
  };
  walk(src, 0);
  return out;
}

function checkOut(src, out) {
  const o = path.resolve(out);
  if (inside(o, src) || inside(src, o)) throw err('output must be separate from the input', 4);
  const repo = path.resolve(__dirname, '..');
  if (inside(o, repo)) throw err('output must be outside the repository', 4);
  if (syncRoots().some((s) => (o + path.sep).toLowerCase().startsWith(s))) throw err('output is inside a OneDrive sync root; refusing', 4);
  if (fs.existsSync(o)) {
    const ents = fs.readdirSync(o);
    if (ents.length) {
      let m = null; try { m = readJson(path.join(o, MARKER)); } catch (e) { /* foreign */ }
      if (!m || m.schema !== SCHEMA) throw err('output exists and is not empty/foreign; refusing', 4);
    }
  }
  return o;
}

// 1 区ぶんの集約。戻り: { cells: [{cx,cz,n,meanH,maxH}], stats }
function aggregateWard(dir, cell, minCount, sentinelMax) {
  const attrDir = path.join(dir, 'attrs');
  const cells = new Map();
  const st = { sourceBuildings: 0, usedBuildings: 0, badHeight: 0, cellsAll: 0, cellsEmitted: 0, buildingsInEmittedCells: 0 };
  for (const f of fs.readdirSync(attrDir).filter((n) => /^t_-?\d+_-?\d+\.json$/.test(n)).sort()) {
    const j = readJson(path.join(attrDir, f));
    const fields = j.fields || [];
    const ih = fields.indexOf('h'), ix = fields.indexOf('repX'), iz = fields.indexOf('repZ');
    if (ih < 0 || ix < 0 || iz < 0) throw err('attrs fields missing (h/repX/repZ)', 3);
    for (const id of Object.keys(j.byId).sort()) {
      const v = j.byId[id]; st.sourceBuildings++;
      const x = v[ix], z = v[iz];
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const cx = Math.floor(x / cell), cz = Math.floor(z / cell), k = cx + '_' + cz;
      let c = cells.get(k); if (!c) { c = { cx, cz, n: 0, hs: 0, hn: 0, maxH: 0 }; cells.set(k, c); }
      c.n++;
      const h = v[ih];
      if (Number.isFinite(h) && h > 0 && h <= sentinelMax) { c.hs += h; c.hn++; if (h > c.maxH) c.maxH = h; } else st.badHeight++;
      st.usedBuildings++;
    }
  }
  st.cellsAll = cells.size;
  const list = [];
  for (const c of [...cells.values()].sort((a, b) => a.cx - b.cx || a.cz - b.cz)) {
    if (c.n < minCount || c.hn === 0) continue;
    list.push({ cx: c.cx, cz: c.cz, n: c.n, meanH: Math.max(3, +(c.hs / c.hn).toFixed(1)), maxH: +c.maxH.toFixed(1) });
    st.buildingsInEmittedCells += c.n;
  }
  st.cellsEmitted = list.length;
  return { cells: list, stats: st };
}

function buildWardGlb(code, cells, cell, inset) {
  const side = cell * inset, pad = (cell - side) / 2;
  const feats = cells.map((c) => {
    const x0 = c.cx * cell + pad, z0 = c.cz * cell + pad;
    return { id: 'lod0_' + code + '_' + c.cx + '_' + c.cz, fp: [[x0, z0], [x0 + side, z0], [x0 + side, z0 + side], [x0, z0 + side]], z0: 0, top: c.meanH, h: c.meanH };
  });
  const minX = Math.min(...cells.map((c) => c.cx)) * cell, maxX = (Math.max(...cells.map((c) => c.cx)) + 1) * cell;
  const minZ = Math.min(...cells.map((c) => c.cz)) * cell, maxZ = (Math.max(...cells.map((c) => c.cz)) + 1) * cell;
  const frame = B.makeFrame(B.localToLon((minX + maxX) / 2), B.localToLat((minZ + maxZ) / 2));
  const r = B.buildGlb(feats, frame);
  return { r, frame, feats };
}

function run(opts) {
  if (!opts.src) throw err('--src required', 2);
  const src = path.resolve(opts.src);
  const cell = opts.cell || 200, minCount = opts.minCount == null ? 2 : opts.minCount, inset = 0.8, sentinelMax = 400;
  if (!(cell >= 100 && cell <= 250)) throw err('--cell must be 100..250', 2);
  const dirs = findWardDirs(src);
  if (!dirs.length) throw err('no ward tileset dirs (attrs/ + source.json) found under --src', 3);
  const wards = [];
  for (const d of dirs) {
    const s = readJson(path.join(d, 'source.json'));
    const code = String(s.wardCode || '');
    if (!/^[0-9]{5}$/.test(code)) throw err('source.json without a valid wardCode', 3);
    if (wards.some((w) => w.code === code)) throw err('duplicate ward ' + code + ' under --src', 3);
    wards.push({ code, dir: d });
  }
  wards.sort((a, b) => (a.code < b.code ? -1 : 1));
  const results = wards.map((w) => Object.assign({ code: w.code }, aggregateWard(w.dir, cell, minCount, sentinelMax)));
  const report = { schema: SCHEMA, kind: 'schematic-density-blocks', notRealBuildings: true, cellM: cell, insetRatio: inset, minCount, heightSentinelMax: sentinelMax,
    note: 'Representative blocks (mean height) for far view only. Not real buildings; ids are lod0_*, never canonicalId.',
    wards: [], totals: { wards: results.length, sourceBuildings: 0, cellsEmitted: 0, buildingsInEmittedCells: 0, glbBytes: 0 } };
  const o = opts.plan ? null : checkOut(src, opts.out);
  if (o) { fs.mkdirSync(o, { recursive: true }); if (!fs.existsSync(path.join(o, MARKER))) fs.writeFileSync(path.join(o, MARKER), JSON.stringify({ schema: SCHEMA, note: 'Local LOD0 density blocks. Not for Git/public/OneDrive.' }), { flag: 'wx' }); }
  for (const w of results) {
    const row = Object.assign({ wardCode: w.code }, w.stats, { coveredPct: w.stats.usedBuildings ? +(100 * w.stats.buildingsInEmittedCells / w.stats.usedBuildings).toFixed(1) : 0, glbBytes: 0 });
    if (w.cells.length) {
      const { r, frame } = buildWardGlb(w.code, w.cells, cell, inset);
      if (r) {
        row.glbBytes = r.glb.length; report.totals.glbBytes += r.glb.length;
        if (o) {
          const wd = path.join(o, w.code);
          fs.mkdirSync(path.join(wd, 'tiles'), { recursive: true });
          fs.writeFileSync(path.join(wd, 'tiles', 'lod0.glb'), r.glb);
          const reg = [r.ext.w * D2R, r.ext.s * D2R, r.ext.e * D2R, r.ext.n * D2R, Math.floor(r.ext.minH), Math.ceil(r.ext.maxH)];
          const ge = cell * 8;
          fs.writeFileSync(path.join(wd, 'tileset.json'), JSON.stringify({
            asset: { version: '1.1', tilesetVersion: 'mission45g-lod0-' + w.code }, geometricError: ge,
            root: { boundingVolume: { region: reg }, geometricError: ge, refine: 'REPLACE', transform: B.frameMatrix(frame), content: { uri: 'tiles/lod0.glb' } },
            extras: { kind: 'schematic-density-blocks', notRealBuildings: true, cellM: cell, cells: w.cells.length } }));
        }
      }
    }
    report.wards.push(row);
    report.totals.sourceBuildings += w.stats.sourceBuildings; report.totals.cellsEmitted += w.stats.cellsEmitted; report.totals.buildingsInEmittedCells += w.stats.buildingsInEmittedCells;
  }
  if (o) fs.writeFileSync(path.join(o, 'lod0-report.json'), JSON.stringify(report, null, 1));
  return report;
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const r = run({ src: opt('src'), out: opt('out'), cell: opt('cell') ? +opt('cell') : undefined, minCount: opt('min-count') != null ? +opt('min-count') : undefined, plan: a.includes('--plan') });
    console.log(JSON.stringify({ mode: a.includes('--plan') ? 'plan (nothing written)' : 'written', totals: r.totals }, null, 1));
  } catch (e) {
    console.error(Number.isInteger(e.code) ? e.message : 'error: operation failed (details suppressed)');
    process.exit(Number.isInteger(e.code) ? e.code : 1);
  }
}
module.exports = { run, aggregateWard, findWardDirs, checkOut, MARKER, SCHEMA };
if (require.main === module) main();
