#!/usr/bin/env node
// tools/audit/max-lod-coverage-matrix.js
// [Mission 34D §31/§32/§33] 24 区の coverage matrix / 主要エリア別 coverage /
//   高 LOD 密度の上位 20 エリア（visual QA 地点の自動抽出）。
//   既に出来ている監査結果とビルド成果物を突き合わせるだけ（raw は読まない）。
//   出力: data/reports/max-lod-coverage-matrix.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { WARDS_24, WARD_JA } from './max-lod-reaudit.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  reaudit: P('data', 'reports', 'max-lod-reaudit.json'),
  build: P('data', 'reports', 'plateau-high-lod-build.json'),
  highDir: P('data', 'processed', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high'),
  index: P('data', 'processed', 'osaka-city', 'canonical', 'max-lod-index.json'),
  out: P('data', 'reports', 'max-lod-coverage-matrix.json'),
};
// §32 個別に coverage を出す主要エリア（world 座標・半径 m）
export const AREAS = [
  { id: 'umeda', name: '梅田', x: -2668, z: -10942, r: 700 },
  { id: 'dojima', name: '堂島', x: -2607, z: -10386, r: 600 },
  { id: 'nakanoshima', name: '中之島', x: -2620, z: -9942, r: 700 },
  { id: 'honmachi', name: '本町', x: -2073, z: -8693, r: 700 },
  { id: 'namba', name: '難波', x: -1360, z: -6890, r: 700 },
  { id: 'osakacastle', name: '大阪城', x: 76, z: -9258, r: 800 },
  { id: 'kyobashi', name: '京橋', x: 1050, z: -10480, r: 700 },
  { id: 'tennoji', name: '天王寺', x: -1020, z: -4900, r: 700 },
  { id: 'shinosaka', name: '新大阪', x: -2110, z: -14380, r: 800 },
  { id: 'awaji', name: '淡路', x: -260, z: -14700, r: 800 },
  { id: 'abeno', name: '阿倍野', x: -1130, z: -5230, r: 700 },
  { id: 'sumiyoshi', name: '住吉', x: -1600, z: -1200, r: 800 },
  { id: 'osakaport', name: '大阪港', x: -7300, z: -8100, r: 900 },
];
export const DENSITY_CELL_M = 500;   // §33 密度は 500m グリッドで数える
export const TOP_N = 20;
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** 高 LOD タイルから、採用済み建物の位置と等級を読む。 */
export function loadAdopted() {
  const out = [];
  for (const f of fs.readdirSync(F.highDir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    const doc = rj(path.join(F.highDir, f));
    for (const b of ((doc && doc.buildings) || [])) {
      const c = b.centroid || [0, 0];
      out.push({ canonicalId: b.canonicalId, x: c[0], z: c[1], lod: b.lod, tier: b.tier || null,
        roofLevels: b.roofLevels ?? null, roofPolys: b.roofPolys ?? null, triangles: b.triangles || 0 });
    }
  }
  return out;
}

export function run() {
  const ra = rj(F.reaudit), build = rj(F.build), idx = rj(F.index);
  if (!ra || !build) throw new Error('先に max-lod-reaudit.js と build-plateau-high-lod.js を実行する');
  const adopted = loadAdopted();
  console.log('[matrix] 採用済み高 LOD', adopted.length);

  // 採用済みを区へ割り当て（再監査 index の wardId を使う）
  const wardByCid = new Map();
  for (const b of ((idx && idx.buildings) || [])) {
    if (b.wardId) wardByCid.set('cg_bldg_' + b.gmlId, b.wardId);
  }
  // ── §31 24 区 matrix ──────────────────────────────────────────────────
  const wards = [];
  for (const w of WARDS_24) {
    const src = ra.byWard[w] || {};
    const mine = adopted.filter((a) => wardByCid.get(a.canonicalId) === w);
    const canon = src.canonicalPlateau || 0;
    const a2 = mine.filter((m) => m.lod === 2).length, a3 = mine.filter((m) => m.lod === 3).length;
    wards.push({
      wardId: w, wardJa: WARD_JA[w],
      canonicalPlateau: canon,
      lod1: canon - (a2 + a3),
      lod2Available: src.lod2Available || 0, lod2Adopted: a2,
      lod3Available: src.lod3Available || 0, lod3Adopted: a3,
      rejected: (src.lod2Available || 0) + (src.lod3Available || 0) - (a2 + a3),
      highLodPct: canon ? +(100 * (a2 + a3) / canon).toFixed(2) : 0,
      tiers: mine.reduce((acc, m) => { if (m.tier) acc[m.tier] = (acc[m.tier] || 0) + 1; return acc; }, {}),
      note: (src.lod2Available || 0) + (src.lod3Available || 0) === 0 ? 'NO_HIGH_LOD_IN_SOURCE' : null,
    });
  }

  // ── §32 主要エリア ───────────────────────────────────────────────────
  const areas = AREAS.map((a) => {
    const inR = adopted.filter((b) => Math.hypot(b.x - a.x, b.z - a.z) <= a.r);
    return { ...a, highLod: inR.length, lod2: inR.filter((b) => b.lod === 2).length, lod3: inR.filter((b) => b.lod === 3).length,
      tiers: inR.reduce((acc, m) => { if (m.tier) acc[m.tier] = (acc[m.tier] || 0) + 1; return acc; }, {}),
      triangles: inR.reduce((s, b) => s + b.triangles, 0),
      meanRoofLevels: inR.length ? +(inR.reduce((s, b) => s + (b.roofLevels || 0), 0) / inR.length).toFixed(2) : null };
  });

  // ── §33 密度上位 20 ──────────────────────────────────────────────────
  const cells = new Map();
  for (const b of adopted) {
    const k = Math.floor(b.x / DENSITY_CELL_M) + '_' + Math.floor(b.z / DENSITY_CELL_M);
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { k, n: 0, lod3: 0, tierA: 0, tri: 0, sx: 0, sz: 0 }));
    c.n++; if (b.lod === 3) c.lod3++; if (b.tier === 'LOD2-A') c.tierA++;
    c.tri += b.triangles; c.sx += b.x; c.sz += b.z;
  }
  const top = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, TOP_N).map((c, i) => ({
    rank: i + 1, cell: c.k, buildings: c.n, lod3: c.lod3, tierA: c.tierA, triangles: c.tri,
    centerX: Math.round(c.sx / c.n), centerZ: Math.round(c.sz / c.n),
    wardId: null,
  }));
  // 上位セルの区を、そのセル内の建物から決める
  for (const t of top) {
    const [cx, cz] = t.cell.split('_').map(Number);
    const counts = {};
    for (const b of adopted) {
      if (Math.floor(b.x / DENSITY_CELL_M) !== cx || Math.floor(b.z / DENSITY_CELL_M) !== cz) continue;
      const w = wardByCid.get(b.canonicalId);
      if (w) counts[w] = (counts[w] || 0) + 1;
    }
    t.wardId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    t.wardJa = t.wardId ? WARD_JA[t.wardId] : null;
  }

  const totals = {
    canonicalPlateau: wards.reduce((s, w) => s + w.canonicalPlateau, 0),
    lod2Available: wards.reduce((s, w) => s + w.lod2Available, 0),
    lod3Available: wards.reduce((s, w) => s + w.lod3Available, 0),
    lod2Adopted: wards.reduce((s, w) => s + w.lod2Adopted, 0),
    lod3Adopted: wards.reduce((s, w) => s + w.lod3Adopted, 0),
    adoptedTotal: adopted.length,
    wardsWithHighLod: wards.filter((w) => w.lod2Available + w.lod3Available > 0).length,
    wardsWithoutHighLod: wards.filter((w) => w.lod2Available + w.lod3Available === 0).map((w) => w.wardJa),
    tiers: build.qualityTiers || {},
  };
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34D',
    densityCellM: DENSITY_CELL_M, totals, wards, areas, topDensity: top,
    previous: { lod2: 10208, lod3: 15, total: 10223 },
    current: { lod2: build.adoptedLod2, lod3: build.adoptedLod3, total: build.adopted },
    delta: { lod2: build.adoptedLod2 - 10208, lod3: build.adoptedLod3 - 15, total: build.adopted - 10223 } };
  fs.mkdirSync(path.dirname(F.out), { recursive: true });
  fs.writeFileSync(F.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[matrix] totals', JSON.stringify(o.totals));
  console.log('[matrix] delta', JSON.stringify(o.delta));
  console.log('[matrix] 上位密度');
  for (const t of o.topDensity.slice(0, 20)) console.log('  ', String(t.rank).padStart(2), (t.wardJa || '?').padEnd(6), 'n=' + String(t.buildings).padStart(4), 'LOD3=' + t.lod3, 'A級=' + String(t.tierA).padStart(4), '@(' + t.centerX + ',' + t.centerZ + ')');
  console.log('[matrix] out', F.out);
}
