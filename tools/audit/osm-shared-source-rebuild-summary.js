#!/usr/bin/env node
// tools/audit/osm-shared-source-rebuild-summary.js
// [Mission 35F §5] 「どのレイヤーを作り直し、どれを触らなかったか」を 1 か所にまとめる。
//
//   §1 の禁止事項（OSM 由来だから全部作り直す）を守ったことを、後から確かめられる形で残す。
//   判断の根拠は data/reports/osm-shared-source-coverage.json（北/南の差分）に置き、
//   ここではその結論と実際にやったことの対応だけを書く。
//
//   出力: data/reports/osm-shared-source-rebuild.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  coverage: P('data', 'reports', 'osm-shared-source-coverage.json'),
  inventory: P('data', 'reports', 'osm-source-dependency-inventory.json'),
  derived: P('data', 'reports', 'derived-shared-layers-build.json'),
  duplicates: P('data', 'reports', 'shared-layer-duplicate-audit.json'),
  labels: P('data', 'reports', 'label-datasets.json'),
  placeLabels: P('data', 'reports', 'place-labels.json'),
  out: P('data', 'reports', 'osm-shared-source-rebuild.json'),
};

/**
 * 監査した OSM の種別 → それを描いているレイヤー。
 * 種別が切断の影響を受けていたなら、対応するレイヤーを作り直す必要がある。
 */
export const KIND_TO_LAYER = {
  'railway-way': 'rail',
  'railway-platform': 'rail',
  'railway-yard': 'rail',
  'railway-station-node': 'stations',
  'public-transport': 'stations',
  'waterway-way': 'water',
  'natural-water': 'water',
  'park-leisure': 'parks',
  'landuse-grass': 'parks',
  'landuse-recreation': 'parks',
  'park-any': 'parks',
  'place-label': 'place-labels',
};

/** 今回作り直したもの。何をどこまでやったかを具体的に書く。 */
export const REBUILD_ACTIONS = {
  rail: 'raw（railways-osm.json）→ tiles → canonical/rail → derived{near,mid,far}/rail。表現方式（LineSegments / tier 別色）は変えていない',
  stations: 'canonical/rail/stations.json → derived/rail-stations.json → labels/station-labels.json。駅名のハードコードは足していない',
  water: 'raw（waterways-osm.json）→ tiles → rivers-v2 → canonical/water → derived{near,mid,far}/water。canonical water の作り方（rivers-v2 + 海面ラスタ）は変えていない',
  parks: 'raw（parks-osm.json）→ tiles → canonical/parks → derived{near,mid,far}/parks。ParkLayer の分類（real / green / grass）は変えていない',
  'place-labels': 'build-place-labels.js の source を広域 PBF へ差し替え → derived/place-labels.json → labels/place-labels.json',
};

/** 触らなかったものと、その理由。 */
export const UNTOUCHED = {
  roads: '35E で広域 PBF へ移行済み。derived は production と共有しているので rollback しない（§13）',
  buildings: 'PLATEAU + OSM fallback。35D/35E で V4 を作った。今回は cutover もしない（§13）',
  'water-surface': '海面ラスタ。OSM 非依存',
  'water-canonical-source': 'canonical water の生成規則そのもの。入力（rivers-v2）だけ新しくした',
};

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

export function affectedLayers(coverage) {
  const set = new Set();
  const byLayer = {};
  for (const k of (coverage && coverage.kinds) || []) {
    const layer = KIND_TO_LAYER[k.id];
    if (!layer) continue;
    if (!byLayer[layer]) byLayer[layer] = { kinds: [], affected: [] };
    byLayer[layer].kinds.push(k.id);
    if (k.truncatedInOldPbf) { set.add(layer); byLayer[layer].affected.push(k.id); }
  }
  return { layers: [...set].sort(), byLayer };
}

export function run() {
  const cov = rj(F.coverage);
  if (!cov) throw new Error('coverage 監査が無い。先に osm-shared-source-coverage.js を走らせる');
  const inv = rj(F.inventory), der = rj(F.derived), dup = rj(F.duplicates);
  const lab = rj(F.labels), pl = rj(F.placeLabels);

  const { layers: affected, byLayer } = affectedLayers(cov);
  const rebuilt = affected.filter((l) => REBUILD_ACTIONS[l]);
  const notRebuilt = affected.filter((l) => !REBUILD_ACTIONS[l]);

  const counts = {};
  if (der && der.derived) {
    for (const [l, r] of Object.entries(der.derived)) {
      counts[l] = { near: r.lod.near.featureCount, mid: r.lod.mid.featureCount, far: r.lod.far.featureCount };
    }
  }
  if (lab && lab.counts) {
    counts.stations = { labels: (lab.counts['station-labels.json'] || {}).total ?? null };
    counts['place-labels'] = { labels: (lab.counts['place-labels.json'] || {}).total ?? null,
      osmPlaces: pl && pl.counts ? pl.counts.total : null };
  }

  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35F',
    principle: '「OSM 由来だから全部作り直す」はしない。北/南の差分で切断の影響を確かめたレイヤーだけ作り直す（§1/§5）。',
    affectedLayers: affected,
    kindsByLayer: byLayer,
    rebuilt, rebuildActions: REBUILD_ACTIONS,
    untouched: Object.keys(UNTOUCHED), untouchedReasons: UNTOUCHED,
    notRebuilt,
    counts,
    duplicates: dup ? dup.duplicates : null,
    duplicateDetail: dup ? dup.layers : null,
    stillOnOldPbf: inv ? inv.stillOnOldPbf : null,
    elapsedMs: 0,
  };
  fs.mkdirSync(path.dirname(F.out), { recursive: true });
  fs.writeFileSync(F.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[rebuild] 影響あり', JSON.stringify(o.affectedLayers));
  console.log('[rebuild] 作り直した', JSON.stringify(o.rebuilt));
  console.log('[rebuild] 触らなかった', JSON.stringify(o.untouched));
  console.log('[rebuild] 旧 PBF のまま', JSON.stringify(o.stillOnOldPbf));
  console.log('[rebuild] 重複', JSON.stringify(o.duplicates));
  console.log('[rebuild] out', F.out);
}
