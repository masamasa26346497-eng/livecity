#!/usr/bin/env node
// tools/audit/production-shared-data-inventory.js
// [Mission 35G §2] cutover の前に、development と production が **同じ配信データを読んでいるか**
//   を機械的に一覧化する。
//
//   production HTML は dev から「ビルドプロファイル 1 行だけ」変えて作られる（32U）。
//   つまり **配信データのパスは HTML に書かれたリテラル** で決まり、
//   同じリテラルを持つ 2 つの HTML は同じファイルを読む。
//   ここで確かめたいのは「どのレイヤーが既に共有で、どれが分かれているか」。
//
//   **重要**: 35E / 35F で作り直した derived は production と共有なので、
//   production は cutover 前から新しいデータを読んでいる。これを「未変更」と書かない。
//
//   出力: data/reports/production-shared-data-inventory.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  prod: P('public', 'osaka_3d_buildings.html'),
  mapData: P('public', 'map-data', 'osaka-city'),
  out: P('data', 'reports', 'production-shared-data-inventory.json'),
};

/**
 * §2 が名指しした項目。`probe` はその配信データの実体（件数を読むファイル）。
 * `pathRe` は HTML の中でそのレイヤーを指しているリテラルの形。
 */
export const ITEMS = [
  { id: 'buildings', label: '建物',
    pathRe: /derived-v4-final|derived-v2-osmv2\/(?!building-lod-high)|derived-v2-osmv3|derived-v2-corrected/,
    versioned: true,
    probes: { V2N: 'derived-v2-osmv2/building-placement/manifest.json',
      V4: 'derived-v4-final/building-placement/manifest.json' },
    countKey: 'canonicalBuildingCount' },
  { id: 'roads', label: '道路（ROAD V3 の入力）', pathRe: /derived\/(near|mid|far)\/roads|\/derived'/,
    versioned: false, probe: 'derived/near/roads/manifest.json', countKey: 'featureCount' },
  { id: 'rail', label: '鉄道', pathRe: /derived\/(near|mid|far)\/rail|\/derived'/,
    versioned: false, probe: 'derived/near/rail/manifest.json', countKey: 'featureCount' },
  { id: 'stations', label: '駅', pathRe: /derived\/rail-stations\.json/,
    versioned: false, probe: 'derived/rail-stations.json', countKey: 'count' },
  { id: 'water', label: '水域', pathRe: /derived\/(near|mid|far)\/water|\/derived'/,
    versioned: false, probe: 'derived/near/water/manifest.json', countKey: 'featureCount' },
  { id: 'parks', label: '公園', pathRe: /derived\/(near|mid|far)\/parks|\/derived'/,
    versioned: false, probe: 'derived/near/parks/manifest.json', countKey: 'featureCount' },
  { id: 'place-labels', label: '地名ラベル', pathRe: /derived\/place-labels\.json/,
    versioned: false, probe: 'derived/place-labels.json', countArray: 'places' },
  { id: 'label-datasets', label: 'ラベル一式（33C の labels/）', pathRe: /labels\/(place|station|river|landmark)-labels\.json/,
    versioned: false, probe: 'labels/station-labels.json', countArray: 'stations' },
  // facts は manifest を持たず tile だけなので tile 数で見る。
  //   [35G] V4 namespace には facts が無く、cutover すると property card の高さ・階数が
  //   全棟で消える。見落とさないよう **namespace ごとに実在を数える**。
  { id: 'building-facts', label: 'building facts（高さの根拠）', pathRe: /building-facts/,
    versioned: true, countTiles: true,
    probes: { V2N: 'derived-v2-osmv2/building-facts', V4: 'derived-v4-final/building-facts' } },
  { id: 'placement', label: 'placement policy', pathRe: /building-placement/,
    versioned: true,
    probes: { V2N: 'derived-v2-osmv2/building-placement/manifest.json',
      V4: 'derived-v4-final/building-placement/manifest.json' },
    countKey: 'canonicalBuildingCount' },
  { id: 'highLOD', label: '高 LOD（実 LOD2/LOD3）', pathRe: /derived-v2-osmv2\/building-lod-high/,
    versioned: false, probe: 'derived-v2-osmv2/building-lod-high/manifest.json', countKey: 'buildingCount' },
];

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const countOf = (rel, item) => {
  if (item.countTiles) {
    const d = path.join(F.mapData, rel);
    if (!fs.existsSync(d)) return 0;
    return fs.readdirSync(d).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f)).length;
  }
  const j = rj(path.join(F.mapData, rel));
  if (!j) return null;
  if (item.countArray) return Array.isArray(j[item.countArray]) ? j[item.countArray].length : null;
  return j[item.countKey] ?? j.featureCount ?? j.count ?? null;
};

/** その HTML が現在どの建物 namespace を既定にしているか。 */
export function buildingsVersionOf(html) {
  const m = html.match(/let buildingsVersion = '([A-Z0-9]+)';/);
  return m ? m[1] : null;
}
/** その HTML に出てくる map-data のパスリテラル（tile 名は落とす）。 */
export function mapDataPaths(html) {
  const out = new Set();
  for (const m of html.matchAll(/map-data\/osaka-city\/[A-Za-z0-9_.\/-]*/g)) {
    out.add(m[0].replace(/\/tile_.*$/, ''));
  }
  return [...out].sort();
}

export function run() {
  const dev = fs.readFileSync(F.dev, 'utf-8');
  const prod = fs.readFileSync(F.prod, 'utf-8');
  const devPaths = mapDataPaths(dev), prodPaths = mapDataPaths(prod);
  const devV = buildingsVersionOf(dev), prodV = buildingsVersionOf(prod);

  const rows = ITEMS.map((it) => {
    const inDev = devPaths.some((p) => it.pathRe.test(p)) || it.pathRe.test(dev);
    const inProd = prodPaths.some((p) => it.pathRe.test(p)) || it.pathRe.test(prod);
    let sharing, devCount = null, prodCount = null, file = it.probe || null;
    if (it.versioned) {
      // 同じファイル群の中で、HTML の定数がどちらの namespace を指すかで分かれる
      devCount = devV && it.probes[devV] ? countOf(it.probes[devV], it) : null;
      prodCount = prodV && it.probes[prodV] ? countOf(it.probes[prodV], it) : null;
      sharing = !inProd ? 'dev-only' : (devV === prodV ? 'shared' : 'separate(namespace)');
      file = { dev: devV && it.probes[devV], production: prodV && it.probes[prodV] };
    } else {
      const c = it.probe ? countOf(it.probe, it) : null;
      devCount = inDev ? c : null;
      prodCount = inProd ? c : null;
      sharing = inDev && inProd ? 'shared' : (inDev ? 'dev-only' : (inProd ? 'production-only' : 'unused'));
    }
    return { id: it.id, label: it.label, sharing, file,
      inDev, inProduction: inProd, devCount, productionCount: prodCount };
  });

  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35G',
    devBuildingsVersion: devV, productionBuildingsVersion: prodV,
    items: rows,
    shared: rows.filter((r) => r.sharing === 'shared').map((r) => r.id),
    separate: rows.filter((r) => r.sharing.startsWith('separate')).map((r) => r.id),
    devOnly: rows.filter((r) => r.sharing === 'dev-only').map((r) => r.id),
    productionOnly: rows.filter((r) => r.sharing === 'production-only').map((r) => r.id),
    devOnlyPaths: devPaths.filter((p) => !prodPaths.includes(p)),
    productionOnlyPaths: prodPaths.filter((p) => !devPaths.includes(p)),
    note: '35E / 35F で作り直した derived は production と共有パス。'
      + 'production は cutover 前から新しいデータを読んでいる（未変更ではない）。',
  };
  fs.mkdirSync(path.dirname(F.out), { recursive: true });
  fs.writeFileSync(F.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[shared] dev 建物', o.devBuildingsVersion, '/ production 建物', o.productionBuildingsVersion);
  for (const r of o.items) {
    console.log('  ', r.id.padEnd(16), r.sharing.padEnd(20),
      'dev', String(r.devCount ?? '-').padStart(8), '| prod', String(r.productionCount ?? '-').padStart(8));
  }
  console.log('[shared] dev にだけあるパス', JSON.stringify(o.devOnlyPaths));
  console.log('[shared] production にだけあるパス', JSON.stringify(o.productionOnlyPaths));
  console.log('[shared] out', F.out);
}
