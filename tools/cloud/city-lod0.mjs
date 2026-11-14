// Mission 213 / Phase 1: 24区を一体で覆う「都市全体 LOD0(概略ブロック)」の決定的ビルダー(ネットワーク不使用)。
//
// 入力(いずれも公式 PLATEAU 2025 から Cloud ビルドが既に作った成果物。旧 45D / OSM は読まない):
//   - <extRoot>/<区>/attrs/t_*.json  … 補完 LOD1 の属性 byId:[h,usage,repX,repZ,z0] (repX/repZ は geoToThree 系ローカルm・全区共通)
//   - <lod2Dir>/footprints.json      … LOD2 棟の凸包(hull=[lon,lat]…。実データ footprints.json で確認。旧実装は [lat,lon] と誤認していた)。LOD2 化で補完 LOD1 から除いた棟を LOD0 の棟数・分布へ戻すために使う
// 方針:
//   - セルは「全区共通のグローバル格子」(区ごとの格子ではない)。区境をまたぐセルは 1 つに統合され、境界の二重化・穴を作らない。
//   - 元LOD1 全棟 = 補完LOD1 + LOD2 化した棟。LOD2 だけで構成されるセルが欠落しないよう LOD2 の重心も数える(高さは近傍LOD1の平均、無ければ既定値で flag)。
//   - 出力は空間分割した複数 GLB(1 巨大 GLB 禁止)。セルは模式ブロックで id は lod0_<cx>_<cz>(canonicalId bldg_ ではない)。クリック対象にしない(viewer 側 allowPicking:false)。
//   - 乱数・時刻を使わない。同じ入力は同じバイト列。座標/高さ基準は 37B と同一(CLAT/CLON/MPD 変更なし)。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const B = createRequire(import.meta.url)('../mission37b-build-3dtiles.cjs');
const D2R = Math.PI / 180;
// geoToThree 同一定数(37B と同じ。変更禁止)。LOD2 footprints(lat/lon) → ローカルm の逆変換に使う
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320, COS_CLAT = Math.cos(CLAT * D2R);
export const lonToLocal = (lon) => (lon - CLON) * COS_CLAT * MPD;
export const latToLocal = (lat) => (CLAT - lat) * MPD;

export const SCHEMA = 'livecity.mission213.city-lod0/1';
export const DEFAULTS = { cell: 200, minCount: 2, inset: 0.8, sentinelMax: 400, tileCells: 10, lod2DefaultH: 12 };

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const key = (cx, cz) => cx + '_' + cz;

// wardAttrs: [{ wardCode, tiles: [ { fields, byId } ... ] }]  lod2Points: [{x,z,h?}]
export function aggregateCity({ wardAttrs, lod2Points = [], cell = DEFAULTS.cell, minCount = DEFAULTS.minCount, sentinelMax = DEFAULTS.sentinelMax, lod2DefaultH = DEFAULTS.lod2DefaultH }) {
  if (!(cell >= 100 && cell <= 250)) throw new Error('cell must be 100..250');
  const cells = new Map();
  const wardStats = [];
  const get = (cx, cz) => { const k = key(cx, cz); let c = cells.get(k); if (!c) { c = { cx, cz, n: 0, hs: 0, hn: 0, maxH: 0, lod2: 0, wards: new Map() }; cells.set(k, c); } return c; };
  for (const w of wardAttrs) {
    const st = { wardCode: w.wardCode, lod1Buildings: 0, badHeight: 0, noPosition: 0 };
    for (const t of w.tiles) {
      const f = t.fields || [], ih = f.indexOf('h'), ix = f.indexOf('repX'), iz = f.indexOf('repZ');
      if (ih < 0 || ix < 0 || iz < 0) throw new Error('attrs fields missing (h/repX/repZ): ' + w.wardCode);
      for (const id of Object.keys(t.byId).sort()) {
        const v = t.byId[id]; st.lod1Buildings++;
        if (!Number.isFinite(v[ix]) || !Number.isFinite(v[iz])) { st.noPosition++; continue; }
        const c = get(Math.floor(v[ix] / cell), Math.floor(v[iz] / cell));
        c.n++; c.wards.set(w.wardCode, (c.wards.get(w.wardCode) || 0) + 1);
        const h = v[ih];
        if (Number.isFinite(h) && h > 0 && h <= sentinelMax) { c.hs += h; c.hn++; if (h > c.maxH) c.maxH = h; } else st.badHeight++;
      }
    }
    wardStats.push(st);
  }
  let lod2Counted = 0;
  for (const p of lod2Points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const c = get(Math.floor(p.x / cell), Math.floor(p.z / cell));
    c.n++; c.lod2++; lod2Counted++;
    if (Number.isFinite(p.h) && p.h > 0 && p.h <= sentinelMax) { c.hs += p.h; c.hn++; if (p.h > c.maxH) c.maxH = p.h; }
  }
  const out = [];
  let lod2OnlyDefaultH = 0, dropped = 0, droppedBuildings = 0;
  for (const c of [...cells.values()].sort((a, b) => a.cx - b.cx || a.cz - b.cz)) {
    if (c.n < minCount) { dropped++; droppedBuildings += c.n; continue; }
    let meanH;
    if (c.hn > 0) meanH = c.hs / c.hn; else { meanH = lod2DefaultH; lod2OnlyDefaultH++; }
    // 区別内訳は最多の区を代表区にする(同数は区コード昇順)=決定的
    let dom = null; for (const [k, n] of [...c.wards.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) { dom = k; break; }
    out.push({ cx: c.cx, cz: c.cz, n: c.n, lod2: c.lod2, meanH: Math.max(3, +meanH.toFixed(1)), maxH: +c.maxH.toFixed(1), ward: dom });
  }
  return { cells: out, wardStats, stats: { cellsAll: cells.size, cellsEmitted: out.length, cellsDroppedBelowMin: dropped, buildingsInDroppedCells: droppedBuildings, lod2Counted, lod2OnlyCellsDefaultHeight: lod2OnlyDefaultH } };
}

// 空間分割: tileCells×tileCells セルごとに 1 タイル。戻り: [{tx,tz,cells}]
export function partition(cells, tileCells = DEFAULTS.tileCells) {
  const m = new Map();
  for (const c of cells) { const tx = Math.floor(c.cx / tileCells), tz = Math.floor(c.cz / tileCells), k = key(tx, tz); let t = m.get(k); if (!t) { t = { tx, tz, cells: [] }; m.set(k, t); } t.cells.push(c); }
  return [...m.values()].sort((a, b) => a.tx - b.tx || a.tz - b.tz);
}

function tileGlb(t, cell, inset) {
  const side = cell * inset, pad = (cell - side) / 2;
  const feats = t.cells.map((c) => {
    const x0 = c.cx * cell + pad, z0 = c.cz * cell + pad;
    return { id: 'lod0_' + c.cx + '_' + c.cz, fp: [[x0, z0], [x0 + side, z0], [x0 + side, z0 + side], [x0, z0 + side]], z0: 0, top: c.meanH, h: c.meanH };
  });
  const minX = Math.min(...t.cells.map((c) => c.cx)) * cell, maxX = (Math.max(...t.cells.map((c) => c.cx)) + 1) * cell;
  const minZ = Math.min(...t.cells.map((c) => c.cz)) * cell, maxZ = (Math.max(...t.cells.map((c) => c.cz)) + 1) * cell;
  const frame = B.makeFrame(B.localToLon((minX + maxX) / 2), B.localToLat((minZ + maxZ) / 2));
  return { r: B.buildGlb(feats, frame), frame };
}

// 書き出し。tileset: root(ADD・無内容)→ 各タイル(REPLACE 葉)。ge は遠景でも消えない大きさ(セル×8)。
export function writeCityLod0(outDir, agg, opts = {}) {
  const cell = opts.cell || DEFAULTS.cell, inset = DEFAULTS.inset, tileCells = opts.tileCells || DEFAULTS.tileCells;
  const tiles = partition(agg.cells, tileCells);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'tiles'), { recursive: true });
  const children = []; const ext = { w: Infinity, e: -Infinity, s: Infinity, n: -Infinity, minH: Infinity, maxH: -Infinity };
  let glbBytes = 0, skipped = 0, tileFiles = 0;
  for (const t of tiles) {
    const { r, frame } = tileGlb(t, cell, inset);
    if (!r) { skipped += t.cells.length; continue; }
    const name = `l0_${t.tx}_${t.tz}.glb`;
    fs.writeFileSync(path.join(outDir, 'tiles', name), r.glb); glbBytes += r.glb.length; tileFiles++;
    ext.w = Math.min(ext.w, r.ext.w); ext.e = Math.max(ext.e, r.ext.e); ext.s = Math.min(ext.s, r.ext.s); ext.n = Math.max(ext.n, r.ext.n);
    ext.minH = Math.min(ext.minH, r.ext.minH); ext.maxH = Math.max(ext.maxH, r.ext.maxH);
    const region = [r.ext.w * D2R, r.ext.s * D2R, r.ext.e * D2R, r.ext.n * D2R, Math.floor(r.ext.minH), Math.ceil(r.ext.maxH)];
    children.push({ boundingVolume: { region }, geometricError: cell * 2, refine: 'REPLACE', transform: B.frameMatrix(frame), content: { uri: 'tiles/' + name } });
  }
  if (!children.length) throw new Error('LOD0 tile が 0 件(全区データ欠落)');
  const ge = cell * 40;
  const tileset = {
    asset: { version: '1.1', tilesetVersion: 'mission213-city-lod0' }, geometricError: ge,
    root: { boundingVolume: { region: [ext.w * D2R, ext.s * D2R, ext.e * D2R, ext.n * D2R, Math.floor(ext.minH), Math.ceil(ext.maxH)] }, geometricError: ge, refine: 'ADD', children },
    extras: { schema: SCHEMA, kind: 'schematic-density-blocks', notRealBuildings: true, clickable: false, cellM: cell, tileCells, tiles: tileFiles, cells: agg.cells.length },
  };
  fs.writeFileSync(path.join(outDir, 'tileset.json'), JSON.stringify(tileset));
  return { tiles: tileFiles, glbBytes, skippedCells: skipped, tilesetBytes: JSON.stringify(tileset).length };
}

// coverage matrix: 期待区(registry)ごとの元棟数・セル数。0 件/欠落は ok:false(fail closed)。
export function coverageReport(agg, expectedWards, outInfo, params) {
  const cellsByWard = new Map(); for (const c of agg.cells) cellsByWard.set(c.ward, (cellsByWard.get(c.ward) || 0) + 1);
  const rows = expectedWards.map((w) => {
    const s = agg.wardStats.find((x) => x.wardCode === w.code);
    const lod1 = s ? s.lod1Buildings : 0, cells = cellsByWard.get(w.code) || 0;
    return { ward: w.id, wardCode: w.code, lod1Buildings: lod1, dominantCells: cells, ok: lod1 > 0 && cells > 0 };
  });
  const missing = rows.filter((r) => !r.ok).map((r) => r.ward);
  return { schema: SCHEMA, notRealBuildings: true, params, wards: rows, missingWards: missing, ok: missing.length === 0, totals: { wards: rows.length, lod1Buildings: rows.reduce((n, r) => n + r.lod1Buildings, 0), ...agg.stats, ...outInfo } };
}

export function loadWardAttrs(extRoot, wardCode, wardId) {
  const dir = path.join(extRoot, wardId, 'attrs');
  if (!fs.existsSync(dir)) return { wardCode, tiles: [] };
  return { wardCode, tiles: fs.readdirSync(dir).filter((n) => /^t_-?\d+_-?\d+\.json$/.test(n)).sort().map((n) => readJson(path.join(dir, n))) };
}

export function loadLod2Points(footprintsPath) {
  if (!footprintsPath || !fs.existsSync(footprintsPath)) return [];
  const j = readJson(footprintsPath); const pts = []; let badHull = 0;
  for (const f of j.footprints || []) {
    const hull = f.hull || []; if (!hull.length) continue;
    // 実データの hull は [lon,lat]。順序は値域で判定(大阪: lon≈135 > 90 > lat≈34)し、どちらの並びでも同じ点になる。判定不能なら除外(誤配置より欠落を数える)。
    const a0 = hull.reduce((s, p) => s + p[0], 0) / hull.length, a1 = hull.reduce((s, p) => s + p[1], 0) / hull.length;
    let lat, lon; if (a0 > 90 && a1 <= 90) { lon = a0; lat = a1; } else if (a1 > 90 && a0 <= 90) { lat = a0; lon = a1; } else { badHull++; continue; }
    pts.push({ x: lonToLocal(lon), z: latToLocal(lat), h: Number.isFinite(f.h) ? f.h : undefined });
  }
  if (badHull) throw new Error('LOD2 footprints の hull 座標順序を判定できません: ' + badHull + ' 件(fail closed)');
  return pts;
}

// 一括: extRoot 配下の区 attrs → <extRoot>/_city-lod0 へ出力し、index.json に cityLod0 を追記(既存キーは触らない)。
export function buildCityLod0({ extRoot, lod2Footprints, wards, cell = DEFAULTS.cell, minCount = DEFAULTS.minCount, tileCells = DEFAULTS.tileCells, plan = false }) {
  const wardAttrs = wards.map((w) => loadWardAttrs(extRoot, w.code, w.id));
  const agg = aggregateCity({ wardAttrs, lod2Points: loadLod2Points(lod2Footprints), cell, minCount });
  const params = { cell, minCount, tileCells };
  if (plan) return coverageReport(agg, wards, { planOnly: true }, params);
  const outDir = path.join(extRoot, '_city-lod0');
  const info = writeCityLod0(outDir, agg, { cell, tileCells });
  const rep = coverageReport(agg, wards, info, params);
  fs.writeFileSync(path.join(outDir, 'coverage-report.json'), JSON.stringify(rep, null, 1));
  if (!rep.ok) throw new Error('LOD0 coverage 欠落区: ' + rep.missingWards.join(','));
  const ip = path.join(extRoot, 'index.json');
  if (fs.existsSync(ip)) {
    const idx = readJson(ip);
    idx.cityLod0 = { uri: '_city-lod0/tileset.json', schematic: true, clickable: false, cellM: cell, tiles: info.tiles, cells: agg.cells.length, glbBytes: info.glbBytes, wards: wards.length };
    fs.writeFileSync(ip, JSON.stringify(idx));
  }
  return rep;
}

// CLI: node tools/cloud/city-lod0.mjs --ext-root <dir> [--lod2 <footprints.json>] [--cell 200] [--min-count 2] [--tile-cells 10] [--plan]
if (import.meta.url === 'file://' + process.argv[1]) {
  const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const reg = readJson(path.join(ROOT, 'config/wards/registry.json')).wards;
  const rep = buildCityLod0({ extRoot: path.resolve(opt('ext-root')), lod2Footprints: opt('lod2') && path.resolve(opt('lod2')), wards: reg, cell: +opt('cell', DEFAULTS.cell), minCount: +opt('min-count', DEFAULTS.minCount), tileCells: +opt('tile-cells', DEFAULTS.tileCells), plan: a.includes('--plan') });
  console.log(JSON.stringify(rep.totals));
  if (!rep.ok) { console.error('missing wards:', rep.missingWards.join(',')); process.exit(3); }
}
