#!/usr/bin/env node
// tools/audit/osm-source-dependency-inventory.js
// [Mission 35F §2] 画面に出ているレイヤーが、どの source ファイルから来ているかを一覧にする。
//
//   「OSM 由来だから全部作り直す」を避けるために、まず依存を文書ではなく
//   **実ファイルの _meta / manifest から読み取って** 記録する。
//   どのレイヤーが旧 osaka-latest.osm.pbf を引いているのかを、推測ではなく事実で出す。
//
//   出力: data/reports/osm-source-dependency-inventory.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const OUT = P('data', 'reports', 'osm-source-dependency-inventory.json');
export const OLD_PBF = 'osaka-latest.osm.pbf';
export const NEW_PBF = 'osaka-full-coverage.osm.pbf';

/**
 * 画面に出るレイヤーの系譜。
 * raw → tiles → canonical → derived（配信）の順で、実ファイルから読み取れるものを並べる。
 * generationTool は「そのレイヤーを作り直すときに叩くもの」。
 */
export const LAYERS = [
  { id: 'roads', label: '道路', raw: 'data/raw/osaka-city/roads-osm.json',
    tiles: 'public/map-data/osaka-city/roads/manifest.json',
    canonical: 'data/processed/osaka-city/canonical/roads/manifest.json',
    derived: 'public/map-data/osaka-city/derived/near/roads/manifest.json',
    generationTool: 'osm-pbf-city.js --layer roads → build-city-layer-tiles.js → build-canonical-roads.js → build-derived-roads.js',
    sharedWithProduction: true },
  { id: 'rail', label: '鉄道', raw: 'data/raw/osaka-city/railways-osm.json',
    tiles: 'public/map-data/osaka-city/railways/manifest.json',
    canonical: 'data/processed/osaka-city/canonical/rail/manifest.json',
    derived: 'public/map-data/osaka-city/derived/near/rail/manifest.json',
    generationTool: 'osm-pbf-city.js --layer railways → build-city-layer-tiles.js → build-canonical-rail.js',
    sharedWithProduction: true },
  { id: 'stations', label: '駅', raw: 'data/raw/osaka-city/railways-osm.json',
    tiles: null,
    canonical: 'data/processed/osaka-city/canonical/rail/stations.json',
    derived: 'public/map-data/osaka-city/derived/rail-stations.json',
    generationTool: 'build-canonical-rail.js（railway=station node から）',
    sharedWithProduction: true },
  { id: 'waterways', label: '水系（OSM 由来の河川）', raw: 'data/raw/osaka-city/waterways-osm.json',
    tiles: 'public/map-data/osaka-city/waterways/manifest.json',
    canonical: 'data/processed/osaka-city/rivers-v2/rivers.json',
    derived: 'public/map-data/osaka-city/rivers-v2/rivers.json',
    generationTool: 'osm-pbf-city.js --layer waterways → build-city-layer-tiles.js → build-river-layer.js',
    sharedWithProduction: true },
  { id: 'water-canonical', label: '水域 canonical', raw: null,
    tiles: null,
    canonical: 'data/processed/osaka-city/canonical/water/manifest.json',
    derived: 'public/map-data/osaka-city/derived/near/water/manifest.json',
    generationTool: 'build-canonical-water.js（rivers-v2 + water-surface から）',
    sharedWithProduction: true },
  { id: 'water-surface', label: '海面ラスタ', raw: null, tiles: null,
    canonical: null,
    derived: 'public/map-data/osaka-city/water-surface/water-surface.json',
    generationTool: 'build-water-surface.js（SEA_MASK ∧ ¬区ポリゴン。OSM 非依存）',
    sharedWithProduction: true },
  { id: 'parks', label: '公園', raw: 'data/raw/osaka-city/parks-osm.json',
    tiles: 'public/map-data/osaka-city/parks/manifest.json',
    canonical: 'data/processed/osaka-city/canonical/parks/manifest.json',
    derived: 'public/map-data/osaka-city/derived/near/parks/manifest.json',
    generationTool: 'osm-pbf-city.js --layer parks → build-city-layer-tiles.js → build-canonical-parks.js',
    sharedWithProduction: true },
  { id: 'place-labels', label: '地名ラベル', raw: null, tiles: null, canonical: null,
    derived: 'public/map-data/osaka-city/derived/place-labels.json',
    // 生成物に raw が無いレイヤー。出力そのものが source を名乗っているので、そこから引く。
    pbfProbe: 'public/map-data/osaka-city/derived/place-labels.json',
    generationTool: 'build-place-labels.js（PBF の place ノードを直接読む）',
    sharedWithProduction: true },
  { id: 'station-labels', label: '駅ラベル', raw: null, tiles: null, canonical: null,
    derived: 'public/map-data/osaka-city/labels/station-labels.json',
    generationTool: 'build-label-datasets.js（derived/rail-stations.json をそのまま）',
    sharedWithProduction: true,
    note: 'CityLabelLayer が読むのは labels/station-labels.json であって derived/rail-stations.json ではない' },
  { id: 'buildings', label: '建物', raw: null, tiles: null,
    canonical: 'data/processed/osaka-city/canonical/buildings-v4-final/manifest.json',
    derived: 'public/map-data/osaka-city/derived-v4-final/building-placement/manifest.json',
    generationTool: 'PLATEAU CityGML + OSM fallback（build-final-buildings-v4.js）',
    sharedWithProduction: false,
    note: 'dev は derived-v4-final、production は derived-v2-osmv2。namespace が分かれている' },
];

const rj = (p) => { try { return JSON.parse(fs.readFileSync(resolveProjectPath(p), 'utf-8')); } catch { return null; } };
const exists = (p) => (p ? fs.existsSync(resolveProjectPath(p)) : false);

/** raw ファイルの _meta から、どの PBF から作られたかを読む。 */
/**
 * その生成物がどの PBF から作られたか。
 * osm-pbf-city.js の出力は `_meta.input`、build-place-labels.js のように
 * 出力へ直接 `source` を書くものもある。**片方だけを見ると依存を見落とす**
 * （実際に place-labels を「OSM 非依存」と誤って分類した）。
 */
export function pbfOf(rawPath) {
  if (!rawPath) return null;
  const j = rj(rawPath);
  if (!j) return null;
  const cand = [j._meta && j._meta.input, j._meta && j._meta.source, j.source, j.sourceFile];
  for (const c of cand) {
    if (typeof c !== 'string') continue;
    const m = c.match(/([A-Za-z0-9_.-]+\.osm\.pbf)/);
    if (m) return m[1];
  }
  return null;
}
/** そのレイヤーがまだ旧 PBF を引いているか。 */
export function dependsOnOldPbf(rawPath) {
  const p = pbfOf(rawPath);
  return p === OLD_PBF;
}

export function run() {
  const t0 = Date.now();
  const rows = LAYERS.map((L) => {
    const raw = L.raw ? rj(L.raw) : null;
    const pbf = pbfOf(L.raw) || pbfOf(L.pbfProbe);
    const counts = {};
    for (const [k, p] of [['tiles', L.tiles], ['canonical', L.canonical], ['derived', L.derived]]) {
      if (!p) { counts[k] = null; continue; }
      const m = rj(p);
      counts[k] = m ? (m.featureCount ?? m.count ?? m.riverCount ?? (Array.isArray(m.features) ? m.features.length : null)) : null;
    }
    return {
      id: L.id, label: L.label,
      sourceFile: L.raw || L.pbfProbe || null,
      sourceType: (L.raw || L.pbfProbe) ? 'osm-pbf-extract' : (L.id === 'water-surface' ? 'raster(非 OSM)' : 'derived/複合'),
      sourcePbf: pbf, dependsOnOldPbf: pbf === OLD_PBF,
      dependsOnWidePbf: pbf === NEW_PBF,
      rawElements: raw && raw.elements ? raw.elements.length : null,
      rawGeneratedAt: raw && raw._meta ? raw._meta.generatedAt : null,
      generationTool: L.generationTool,
      tiles: L.tiles, canonical: L.canonical, derived: L.derived,
      counts,
      filesPresent: { raw: exists(L.raw), tiles: exists(L.tiles), canonical: exists(L.canonical), derived: exists(L.derived) },
      sharedWithProduction: L.sharedWithProduction,
      note: L.note || null,
    };
  });
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35F',
    oldPbf: OLD_PBF, newPbf: NEW_PBF,
    layers: rows,
    stillOnOldPbf: rows.filter((r) => r.dependsOnOldPbf).map((r) => r.id),
    alreadyOnWidePbf: rows.filter((r) => r.dependsOnWidePbf).map((r) => r.id),
    notOsmDependent: rows.filter((r) => !r.sourcePbf && r.sourceType !== 'osm-pbf-extract').map((r) => r.id),
    sharedWithProduction: rows.filter((r) => r.sharedWithProduction).map((r) => r.id),
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[inv] レイヤー'.padEnd(6), 'source PBF'.padEnd(30), 'raw'.padStart(7), 'canonical'.padStart(10), 'prod共有');
  for (const r of o.layers) {
    console.log('  ' + r.id.padEnd(16) + String(r.sourcePbf || '(非 OSM)').padEnd(30)
      + String(r.rawElements ?? '-').padStart(7) + String(r.counts.canonical ?? '-').padStart(10)
      + '   ' + (r.sharedWithProduction ? 'yes' : 'no'));
  }
  console.log('[inv] 旧 PBF のまま:', JSON.stringify(o.stillOnOldPbf));
  console.log('[inv] 広域 PBF 済み:', JSON.stringify(o.alreadyOnWidePbf));
  console.log('[inv] out', OUT);
}
