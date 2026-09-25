#!/usr/bin/env node
// tools/audit/building-name-source-audit.js
// [Mission 35O §1] 「いま、どのデータから何件の名称が取れるか」を数える。
//
//   名称は **推測しない**（§0）。だからまず、実データに何があるかを確かめる。
//   数えるもの:
//     - OSM building way / relation の name / name:ja
//     - OSM の named facility way（建物と重なりうる面）
//     - OSM の施設 POI node の name
//     - PLATEAU 建物属性に名称があるか（canonical の attributes を全走査）
//     - landmarks.json
//     - 既存 facilities.json
//
//   出力: data/reports/building-name-source-audit.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const SRC = {
  pbfWide: P('data', 'raw', 'osm', 'osaka-full-coverage.osm.pbf'),
  pbfOld: P('data', 'raw', 'osm', 'osaka-latest.osm.pbf'),
  landmarks: P('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'),
  facilitiesSumiyoshi: P('public', 'map-data', 'osaka-sumiyoshi', 'facilities', 'facilities.json'),
  canonicalV4: P('public', 'map-data', 'osaka-city', 'derived-v4-final', 'near', 'buildings'),
};
export const OUT = P('data', 'reports', 'building-name-source-audit.json');

/** 建物 way / relation とみなすタグ。 */
export const isBuildingTags = (t) => !!(t && (t.building || t['building:part'] === 'yes'));

/**
 * 「建物全体がほぼその施設」と安全に言えるカテゴリ（§4-C）。
 * ここに無いものは POI node から建物名へ昇格させない。
 */
export const WHOLE_BUILDING_CATEGORIES = new Set([
  'school', 'college', 'university', 'kindergarten',
  'hospital', 'clinic',
  'place_of_worship', 'temple', 'shrine',
  'fire_station', 'police',
  'townhall', 'library', 'museum', 'theatre',
  'supermarket', 'department_store', 'mall',
  'hotel',
]);

/** POI node / way のカテゴリを OSM タグから読む（名前からは決めない）。 */
export function osmCategory(t) {
  if (!t) return null;
  if (t.amenity) return t.amenity;
  if (t.shop) return t.shop === 'yes' ? 'shop' : t.shop;
  if (t.tourism) return t.tourism;
  if (t.office) return t.office === 'yes' ? 'office' : t.office;
  if (t.leisure) return t.leisure;
  if (t.healthcare) return t.healthcare;
  if (t.historic) return t.historic;
  if (t.building && t.building !== 'yes') return 'building:' + t.building;
  return null;
}

/** 表示名。name:ja を優先し、無ければ name。どちらも無ければ null。 */
export function osmName(t) {
  if (!t) return null;
  const n = (t['name:ja'] || t.name || '').trim();
  return n || null;
}

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

export async function run({ pbf = null } = {}) {
  const t0 = Date.now();
  const file = pbf || (fs.existsSync(SRC.pbfWide) ? SRC.pbfWide : SRC.pbfOld);
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35O',
    pbf: path.basename(file),
    osm: {
      buildingWays: 0, buildingWaysNamed: 0,
      buildingRelations: 0, buildingRelationsNamed: 0,
      namedFacilityWays: 0,
      poiNodes: 0, poiNodesNamed: 0,
      poiNodesWholeBuildingCategory: 0,
    },
    osmBuildingNameByCategory: {},
    osmPoiByCategory: {},
    plateau: { checked: 0, withName: 0, attributeKeys: [] },
    landmarks: { count: 0, sample: [] },
    facilities: { sumiyoshiRecords: 0, categories: {} },
    notes: [],
  };

  // ── OSM ────────────────────────────────────────────────────────────
  for await (const it of pbfPrimitiveStream(file)) {
    const t = it.tags || {};
    if (it.type === 'way') {
      if (isBuildingTags(t)) {
        out.osm.buildingWays++;
        const n = osmName(t);
        if (n) {
          out.osm.buildingWaysNamed++;
          const c = osmCategory(t) || '(building only)';
          out.osmBuildingNameByCategory[c] = (out.osmBuildingNameByCategory[c] || 0) + 1;
        }
      } else if (osmName(t) && osmCategory(t)) {
        out.osm.namedFacilityWays++;
      }
    } else if (it.type === 'relation') {
      if (isBuildingTags(t)) {
        out.osm.buildingRelations++;
        if (osmName(t)) out.osm.buildingRelationsNamed++;
      }
    } else if (it.type === 'node') {
      const c = osmCategory(t);
      if (!c) continue;
      out.osm.poiNodes++;
      const n = osmName(t);
      if (n) {
        out.osm.poiNodesNamed++;
        out.osmPoiByCategory[c] = (out.osmPoiByCategory[c] || 0) + 1;
        if (WHOLE_BUILDING_CATEGORIES.has(c)) out.osm.poiNodesWholeBuildingCategory++;
      }
    }
  }

  // ── PLATEAU（canonical の建物属性に名称があるか）──────────────────
  if (fs.existsSync(SRC.canonicalV4)) {
    const files = fs.readdirSync(SRC.canonicalV4).filter((f) => /^tile_/.test(f));
    const keys = new Set();
    for (const f of files.slice(0, 200)) {
      const j = rj(path.join(SRC.canonicalV4, f));
      for (const b of ((j && j.features) || [])) {
        const a = b.attributes || {};
        out.plateau.checked++;
        for (const k of Object.keys(a)) keys.add(k);
        if (a.name || a.buildingName || a['name:ja']) out.plateau.withName++;
      }
    }
    out.plateau.attributeKeys = [...keys].sort();
  }

  // ── 既存の派生データ ───────────────────────────────────────────────
  const lm = rj(SRC.landmarks);
  if (lm) {
    out.landmarks.count = (lm.landmarks || []).length;
    out.landmarks.sample = (lm.landmarks || []).slice(0, 8).map((x) => x.name);
  }
  const fac = rj(SRC.facilitiesSumiyoshi);
  if (fac) {
    out.facilities.sumiyoshiRecords = (fac.records || []).length;
    out.facilities.categories = fac.categoryCounts || {};
    out.notes.push('facilities.json は osaka-sumiyoshi（3 区）ぶんだけ。24 区ぶんは存在しない。');
  }

  out.elapsedMs = Date.now() - t0;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => {
    console.log('[35O-audit] OSM building way', o.osm.buildingWays, '/ うち名称あり', o.osm.buildingWaysNamed);
    console.log('[35O-audit] OSM building relation', o.osm.buildingRelations, '/ うち名称あり', o.osm.buildingRelationsNamed);
    console.log('[35O-audit] 名称つき施設 way', o.osm.namedFacilityWays);
    console.log('[35O-audit] 施設 POI node', o.osm.poiNodes, '/ 名称あり', o.osm.poiNodesNamed,
      '/ 建物全体とみなせる種別', o.osm.poiNodesWholeBuildingCategory);
    console.log('[35O-audit] PLATEAU 属性に名称', o.plateau.withName, '/', o.plateau.checked);
    console.log('[35O-audit] landmarks', o.landmarks.count);
    console.log('[35O-audit] out', OUT);
  }).catch((e) => { console.error(e); process.exitCode = 1; });
}
