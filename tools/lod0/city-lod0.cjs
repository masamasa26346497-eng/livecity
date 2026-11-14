'use strict';
// Mission 213 Phase 1 試作: 24区一体の city-overview LOD0 を作る「純粋関数」モジュール(I/O・GLB・ネットワークなし)。
// 45G(tools/mission45g-build-lod0.cjs)の決定的セル集約を、(1) 区ごと1GLBではなく空間分割タイル + 単一 tileset index に拡張し、
// (2) 24区カバレッジ検証(0件/欠落=失敗)を加えたもの。GLB 化は呼び出し側が注入する(既存 37B の buildGlb を再利用予定)。
// LOD0 は模式ブロック: ID は lod0_*、canonicalId(bldg_) と混同しない・クリック対象外(extras で明示)。乱数/時刻なし。
const SCHEMA = 'livecity.mission213.city-lod0/1';
const err = (m, code) => Object.assign(new Error(m), { code });

// buildings: [{ x, z, h }] (区ローカル/共通ローカル座標 m)。LOD2 化した棟も必ず含めた「元LOD1全棟」を渡すこと(欠落防止)。
function aggregateCells(buildings, { cellM = 200, minCount = 2, sentinelMax = 400 } = {}) {
  if (!(cellM >= 100 && cellM <= 250)) throw err('cellM must be 100..250', 2);
  const cells = new Map();
  const st = { sourceBuildings: 0, usedBuildings: 0, badHeight: 0, cellsAll: 0, cellsEmitted: 0, buildingsInEmittedCells: 0 };
  for (const b of buildings) {
    st.sourceBuildings++;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
    const cx = Math.floor(b.x / cellM), cz = Math.floor(b.z / cellM), k = cx + '_' + cz;
    let c = cells.get(k); if (!c) { c = { cx, cz, n: 0, hs: 0, hn: 0, maxH: 0 }; cells.set(k, c); }
    c.n++; st.usedBuildings++;
    if (Number.isFinite(b.h) && b.h > 0 && b.h <= sentinelMax) { c.hs += b.h; c.hn++; if (b.h > c.maxH) c.maxH = b.h; } else st.badHeight++;
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

// 全区のセルを都市共通グリッドの空間タイル(tileCells x tileCells セル)へ分割。区境界で二重化しないよう、セルは共通グリッドで一意(同一セルは棟数/高さを合算)。
function mergeAndPartition(wardResults, { cellM = 200, tileCells = 16 } = {}) {
  const merged = new Map();
  for (const w of wardResults) for (const c of w.cells) {
    const k = c.cx + '_' + c.cz; const m = merged.get(k);
    if (!m) merged.set(k, { cx: c.cx, cz: c.cz, n: c.n, hsum: c.meanH * c.n, maxH: c.maxH, wards: [w.code] });
    else { m.n += c.n; m.hsum += c.meanH * c.n; m.maxH = Math.max(m.maxH, c.maxH); m.wards.push(w.code); }
  }
  const tiles = new Map();
  for (const m of [...merged.values()].sort((a, b) => a.cx - b.cx || a.cz - b.cz)) {
    const tx = Math.floor(m.cx / tileCells), tz = Math.floor(m.cz / tileCells), k = tx + '_' + tz;
    let t = tiles.get(k); if (!t) { t = { tx, tz, cells: [] }; tiles.set(k, t); }
    t.cells.push({ cx: m.cx, cz: m.cz, n: m.n, meanH: Math.max(3, +(m.hsum / m.n).toFixed(1)), maxH: m.maxH, wards: m.wards });
  }
  return [...tiles.values()].sort((a, b) => a.tx - b.tx || a.tz - b.tz);
}

// 24区カバレッジ。expected=[{code,name}]。セル0件・未提供・元棟数不一致はすべて failure(黙って通さない)。
function coverageReport(expected, wardResults, { lod1FullCounts = {} } = {}) {
  const by = new Map(wardResults.map((w) => [w.code, w]));
  const rows = [], failures = [];
  for (const e of expected) {
    const w = by.get(e.code);
    if (!w) { rows.push({ code: e.code, name: e.name, status: 'missing' }); failures.push(e.code + ' ' + e.name + ': 入力なし'); continue; }
    const s = w.stats;
    const row = { code: e.code, name: e.name, status: 'ok', sourceBuildings: s.sourceBuildings, cellsEmitted: s.cellsEmitted, coveredPct: s.usedBuildings ? +(100 * s.buildingsInEmittedCells / s.usedBuildings).toFixed(1) : 0 };
    if (s.cellsEmitted === 0) { row.status = 'empty'; failures.push(e.code + ' ' + e.name + ': セル0件'); }
    const full = lod1FullCounts[e.code];
    if (full != null && full !== s.sourceBuildings) { row.status = 'count-mismatch'; row.expectedSource = full; failures.push(e.code + ' ' + e.name + ': 元棟数 ' + s.sourceBuildings + ' != 元LOD1全棟 ' + full + '(LOD2化した棟の欠落疑い)'); }
    rows.push(row);
  }
  return { ok: failures.length === 0, wards: rows, failures };
}

// 単一 index tileset(refine=REPLACE 想定の LOD0 サブツリー)。toRegion(minCx,minCz,maxCx,maxCz,maxH)->[w,s,e,n,minH,maxH](rad) は呼び出し側が注入(座標系を勝手に仮定しない)。
function buildTilesetIndex(tiles, { cellM = 200, tileCells = 16, toRegion, uriFor = (t) => 'tiles/lod0_' + t.tx + '_' + t.tz + '.glb' } = {}) {
  if (typeof toRegion !== 'function') throw err('toRegion required', 2);
  const gTile = cellM * tileCells;          // タイル子の geometricError(遠景から読み込み開始)
  const children = tiles.map((t) => {
    const cxs = t.cells.map((c) => c.cx), czs = t.cells.map((c) => c.cz), mh = Math.max(...t.cells.map((c) => c.maxH));
    return { boundingVolume: { region: toRegion(Math.min(...cxs), Math.min(...czs), Math.max(...cxs) + 1, Math.max(...czs) + 1, mh) }, geometricError: cellM, content: { uri: uriFor(t) }, extras: { cells: t.cells.length } };
  });
  const all = children.map((c) => c.boundingVolume.region);
  const region = [Math.min(...all.map((r) => r[0])), Math.min(...all.map((r) => r[1])), Math.max(...all.map((r) => r[2])), Math.max(...all.map((r) => r[3])), Math.min(...all.map((r) => r[4])), Math.max(...all.map((r) => r[5]))];
  return { asset: { version: '1.1', tilesetVersion: 'mission213-city-lod0' }, geometricError: gTile * 4,
    root: { boundingVolume: { region }, geometricError: gTile * 4, refine: 'REPLACE', children },
    extras: { schema: SCHEMA, kind: 'schematic-density-blocks', notRealBuildings: true, clickable: false, idPrefix: 'lod0_', cellM, tileCells,
      note: '遠景の概略ブロック。実棟ではない。canonicalId(bldg_)とは別・クリック対象外。' } };
}

module.exports = { SCHEMA, aggregateCells, mergeAndPartition, coverageReport, buildTilesetIndex };
