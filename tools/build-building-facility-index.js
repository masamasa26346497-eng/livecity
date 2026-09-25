#!/usr/bin/env node
// tools/build-building-facility-index.js
// [Mission 35O §2/§3/§4] 建物へ「実在する名称」を紐づける sidecar を作る。
//
//   §0 名称は推測しない。採るのは OSM に実在する name / name:ja だけ。
//   §3 建物 geometry は書き換えない。canonicalId をキーにした別ファイルにする。
//
//   突き合わせの優先順位（§4）:
//     A. 建物 way / relation 自身に name        → buildingName（high）
//     B. 名称つき施設 way が建物をほぼ覆う      → buildingName（high）
//     C. 施設 POI node が建物の中             → facilities（施設として紐づけるだけ）
//        ただし「建物全体がほぼその施設」と言える種別で、競合が無いときだけ
//        primaryFacilityName にする（§4-C）
//     単純な nearest では付けない（§5）
//
//   出力:
//     public/map-data/osaka-city/derived/building-facility-index.json
//     data/processed/osaka-city/derived/building-facility-index.json
//     data/reports/building-facility-index.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { pbfPrimitiveStream } from './lib/osm-pbf-stream.js';
import { latLonToLiveCityWorld } from './lib/livecity-coordinate-system.js';
import { classifyPointToWard } from './lib/point-in-polygon.js';
import {
  osmName, osmCategory, isBuildingTags, WHOLE_BUILDING_CATEGORIES,
  ringArea, ringBbox, ringCentroid, pointInRing, bboxOverlap, overlapRatio,
  MATCH, normalizeName, isSameAsLandmark, labelTier, categoryRank,
} from './lib/building-facility-match.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const SRC = {
  pbfWide: P('data', 'raw', 'osm', 'osaka-full-coverage.osm.pbf'),
  pbfOld: P('data', 'raw', 'osm', 'osaka-latest.osm.pbf'),
  buildings: P('public', 'map-data', 'osaka-city', 'derived-v4-final', 'near', 'buildings'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  // [Mission 35O §10] 重複判定は **ラベル層が実際に読むファイル** と突き合わせる。
  //   landmarks/landmarks.json（19 件）ではなく labels/landmark-labels.json（33 件・tier 付き）。
  //   こちらを見ないと、大阪中之島美術館のように landmark 側にしか無いものが二重表示になる。
  landmarkLabels: P('public', 'map-data', 'osaka-city', 'labels', 'landmark-labels.json'),
  landmarks: P('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'),
};
/** 配信用（軽量・runtime が fetch する）。 */
export const OUT_RUNTIME = P('public', 'map-data', 'osaka-city', 'derived', 'building-facility-index.json');
/** 全部入り（provenance 込み・validator が読む）。 */
export const OUT_FULL = P('data', 'processed', 'osaka-city', 'derived', 'building-facility-index.json');
/** ラベル用（軽量・起動時に読む）。 */
export const OUT_LABELS = P('public', 'map-data', 'osaka-city', 'derived', 'building-name-labels.json');
export const OUT_FILES = [OUT_LABELS, OUT_RUNTIME, OUT_FULL];
export const REPORT = P('data', 'reports', 'building-facility-index.json');

/** 空間索引の格子（m）。建物も OSM 要素も同じ格子に入れる。 */
export const CELL_M = 120;
/** 1 棟に保持する施設の上限（§6 データは持つが、極端な複合ビルで肥大させない）。 */
export const MAX_FACILITIES_PER_BUILDING = 60;
/** 同じ名前が敷地内の複数棟に付くとき（学校・神社・大型商業）に、ラベルを 1 つへまとめる距離。 */
export const SAME_NAME_CLUSTER_M = 450;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const cellKey = (x, z) => Math.floor(x / CELL_M) + ':' + Math.floor(z / CELL_M);

function cellsForBbox(b) {
  const out = [];
  for (let i = Math.floor(b.minX / CELL_M); i <= Math.floor(b.maxX / CELL_M); i++) {
    for (let j = Math.floor(b.minZ / CELL_M); j <= Math.floor(b.maxZ / CELL_M); j++) out.push(i + ':' + j);
  }
  return out;
}

/** 大阪市の bbox（区ポリゴンから）。PBF は市域より広いので、ここで絞る。 */
function cityBbox(wardPolys) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const w of wardPolys) {
    const b = w.bbox;
    if (b && Number.isFinite(b.minX)) {
      if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX;
      if (b.minZ < minZ) minZ = b.minZ; if (b.maxZ > maxZ) maxZ = b.maxZ;
    }
  }
  if (!Number.isFinite(minX)) throw new Error('区ポリゴンから市域 bbox を作れない');
  return { minX: minX - 300, maxX: maxX + 300, minZ: minZ - 300, maxZ: maxZ + 300 };
}

/** OSM から名称つきの要素だけを取り出す（2 パス: 1) tags/refs 2) node 座標）。 */
export async function collectOsmNamed(file, bbox) {
  const inBox = (x, z) => x >= bbox.minX && x <= bbox.maxX && z >= bbox.minZ && z <= bbox.maxZ;
  // ── pass1: 名前つき way（建物 / 施設）と、名前つき POI node ────────
  const wants = new Map();      // wayId → { kind, tags, refs }
  const need = new Set();
  const pois = [];
  for await (const it of pbfPrimitiveStream(file)) {
    const t = it.tags || {};
    if (it.type === 'way') {
      const n = osmName(t);
      if (!n) continue;
      const isB = isBuildingTags(t);
      const cat = osmCategory(t);
      if (!isB && !cat) continue;
      wants.set(it.id, { kind: isB ? 'building' : 'facility', tags: t, refs: it.refs || [] });
      for (const r of (it.refs || [])) need.add(r);
    } else if (it.type === 'node') {
      const n = osmName(t);
      if (!n) continue;
      const cat = osmCategory(t);
      if (!cat) continue;
      if (it.lat == null || it.lon == null) continue;
      const w = latLonToLiveCityWorld(it.lat, it.lon);
      if (!inBox(w.x, w.z)) continue;
      pois.push({ osmId: 'node/' + it.id, name: n, category: cat, x: +w.x.toFixed(2), z: +w.z.toFixed(2), tags: t });
    }
  }
  // ── pass2: way を構成する node の座標 ─────────────────────────────
  const coord = new Map();
  for await (const it of pbfPrimitiveStream(file)) {
    if (it.type !== 'node') continue;
    if (!need.has(it.id)) continue;
    if (it.lat == null || it.lon == null) continue;
    coord.set(it.id, [it.lat, it.lon]);
  }
  const ways = [];
  for (const [id, v] of wants) {
    const ring = [];
    for (const r of v.refs) {
      const ll = coord.get(r);
      if (!ll) continue;
      const w = latLonToLiveCityWorld(ll[0], ll[1]);
      ring.push([+w.x.toFixed(2), +w.z.toFixed(2)]);
    }
    if (ring.length < 3) continue;
    const bb = ringBbox(ring);
    const c = ringCentroid(ring);
    if (!inBox(c[0], c[1])) continue;
    ways.push({
      osmId: 'way/' + id, kind: v.kind, name: osmName(v.tags), category: osmCategory(v.tags),
      ring, bbox: bb, cx: +c[0].toFixed(2), cz: +c[1].toFixed(2),
      areaM2: Math.abs(ringArea(ring)),
    });
  }
  return { ways, pois };
}

/** canonical の建物を読む（geometry は読むだけ・書き換えない）。 */
export function loadBuildings(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^tile_.*\.json$/.test(f));
  const out = [];
  // タイル境界をまたぐ建物は複数タイルに入るので canonicalId で重複を落とす
  //   （落とさないと母数が 647,746 になり、区ごとの coverage が狂う）
  const seen = new Set();
  for (const f of files) {
    const j = rj(path.join(dir, f));
    for (const b of ((j && j.features) || [])) {
      if (!b.canonicalId || seen.has(b.canonicalId)) continue;
      seen.add(b.canonicalId);
      const coords = b.coordinates;
      if (!coords) continue;
      const ring = (b.geometryType === 'Polygon') ? coords[0] : (coords[0] && coords[0][0]);
      if (!Array.isArray(ring) || ring.length < 3) continue;
      const a = b.attributes || {};
      out.push({
        id: b.canonicalId,
        ring,
        bbox: b.bbox || ringBbox(ring),
        cx: b.centroid ? b.centroid[0] : ringCentroid(ring)[0],
        cz: b.centroid ? b.centroid[1] : ringCentroid(ring)[1],
        h: (typeof a.heightM === 'number' && a.heightM > 0) ? a.heightM : null,
        areaM2: Math.abs(ringArea(ring)),
        wardId: a.wardId || null,
        usageCategory: a.usageCategory || null,
        source: a.source || null,
      });
    }
  }
  return out;
}

export function run() {
  throw new Error('run() は async。runAsync() を使う');
}

export async function runAsync({ pbf = null } = {}) {
  const t0 = Date.now();
  const wardPolys = (rj(SRC.wardPolys) || {}).wards || [];
  const bbox = cityBbox(wardPolys);
  const file = pbf || (fs.existsSync(SRC.pbfWide) ? SRC.pbfWide : SRC.pbfOld);
  const landmarks = [
    ...((rj(SRC.landmarkLabels) || {}).landmarks || []),
    ...((rj(SRC.landmarks) || {}).landmarks || []),
  ].filter((l) => l && l.name && Number.isFinite(l.x)).map((l) => ({ name: l.name, x: l.x, z: l.z }));

  console.log('[35O] OSM から名称つき要素を集める…');
  const { ways, pois } = await collectOsmNamed(file, bbox);
  const namedBuildingWays = ways.filter((w) => w.kind === 'building');
  const namedFacilityWays = ways.filter((w) => w.kind === 'facility');
  console.log('[35O]   建物 way(名称あり)', namedBuildingWays.length,
    '/ 施設 way(名称あり)', namedFacilityWays.length, '/ POI node(名称あり)', pois.length);

  console.log('[35O] canonical 建物を読む…');
  const buildings = loadBuildings(SRC.buildings);
  console.log('[35O]   建物', buildings.length);

  // ── 空間索引 ─────────────────────────────────────────────────────
  const gridWay = new Map(), gridPoi = new Map();
  const push = (g, k, v) => { if (!g.has(k)) g.set(k, []); g.get(k).push(v); };
  for (const w of ways) for (const k of cellsForBbox(w.bbox)) push(gridWay, k, w);
  for (const p of pois) push(gridPoi, cellKey(p.x, p.z), p);

  const records = new Map();    // canonicalId → record
  const stats = {
    buildingsTotal: buildings.length,
    matchedBuildingSelf: 0, matchedFacilityCover: 0,
    poiInsideBuilding: 0, primaryFromPoi: 0,
    facilityLinks: 0, unmatchedFacilities: 0,
    competingBuildingRejected: 0, landmarkDeduped: 0, labelSuppressed: 0,
    nearestWithEvidence: 0,
  };
  const usedWayIds = new Set(), usedPoiIds = new Set();

  const rec = (b) => {
    let r = records.get(b.id);
    if (!r) {
      r = {
        buildingId: b.id, buildingName: null, primaryFacilityName: null,
        facilities: [], source: null, sourceId: null, matchMethod: null, confidence: null,
        x: +b.cx.toFixed(2), z: +b.cz.toFixed(2), h: b.h, wardId: b.wardId,
        areaM2: Math.round(b.areaM2), labelTier: null, isLandmark: false,
      };
      records.set(b.id, r);
    }
    return r;
  };

  // ── A/B: 名称つき way ↔ 建物ポリゴンの重なり ────────────────────
  console.log('[35O] A/B: ポリゴンの重なりで建物名を決める…');
  for (const b of buildings) {
    const cand = new Map();
    for (const k of cellsForBbox(b.bbox)) for (const w of (gridWay.get(k) || [])) cand.set(w.osmId, w);
    if (!cand.size) continue;
    let best = null;
    for (const w of cand.values()) {
      if (!bboxOverlap(w.bbox, b.bbox)) continue;
      const o = overlapRatio(b.ring, w.ring);
      if (!o.samples) continue;
      if (w.kind === 'building') {
        // A: 建物 way 自身の名称。建物同士がほぼ同じ形のときだけ。
        if (o.ratioOfA >= MATCH.BUILDING_SELF_OVERLAP) {
          const score = o.ratioOfA + 0.5;   // A は B より優先
          if (!best || score > best.score) best = { w, o, score, method: 'building-polygon-self' };
        }
      } else {
        // B: 施設 way が建物をほぼ覆っている。建物の方が大きい（敷地の一区画）ときは採らない。
        if (o.ratioOfA >= MATCH.FACILITY_COVERS_BUILDING && w.areaM2 >= b.areaM2 * 0.5) {
          const score = o.ratioOfA;
          if (!best || score > best.score) best = { w, o, score, method: 'facility-polygon-overlap' };
        }
      }
    }
    if (!best) continue;
    const r = rec(b);
    r.buildingName = best.w.name;
    r.source = 'osm';
    r.sourceId = best.w.osmId;
    r.matchMethod = best.method;
    r.confidence = 'high';
    r.overlapRatio = +best.o.ratioOfA.toFixed(3);
    if (best.w.category) r.buildingCategory = best.w.category;
    usedWayIds.add(best.w.osmId);
    if (best.method === 'building-polygon-self') stats.matchedBuildingSelf++;
    else stats.matchedFacilityCover++;
  }

  // ── C: POI node が建物の中 ──────────────────────────────────────
  console.log('[35O] C: 建物の中にある施設 POI を紐づける…');
  const poiBuilding = new Map();     // poiId → [building...]
  for (const b of buildings) {
    const cand = [];
    for (const k of cellsForBbox(b.bbox)) for (const p of (gridPoi.get(k) || [])) cand.push(p);
    if (!cand.length) continue;
    for (const p of cand) {
      if (p.x < b.bbox.minX || p.x > b.bbox.maxX || p.z < b.bbox.minZ || p.z > b.bbox.maxZ) continue;
      if (!pointInRing(p.x, p.z, b.ring)) continue;
      if (!poiBuilding.has(p.osmId)) poiBuilding.set(p.osmId, []);
      poiBuilding.get(p.osmId).push(b);
    }
  }
  const byId = new Map(buildings.map((b) => [b.id, b]));
  for (const p of pois) {
    const hits = poiBuilding.get(p.osmId) || [];
    if (!hits.length) { stats.unmatchedFacilities++; continue; }
    if (hits.length > 1) stats.competingBuildingRejected++;
    // 複数の建物に入ってしまう（建物が重なっている）ときは、最も小さい建物を採る
    const b = hits.slice().sort((x, y) => x.areaM2 - y.areaM2)[0];
    const r = rec(b);
    stats.poiInsideBuilding++;
    if (r.facilities.length < MAX_FACILITIES_PER_BUILDING) {
      r.facilities.push({ name: p.name, category: p.category, source: 'osm', sourceId: p.osmId });
      stats.facilityLinks++;
    }
    usedPoiIds.add(p.osmId);
  }

  // ── C の続き: 建物全体がほぼその施設 → primaryFacilityName ──────
  for (const r of records.values()) {
    if (r.primaryFacilityName || !r.facilities.length) continue;
    const whole = r.facilities.filter((f) => WHOLE_BUILDING_CATEGORIES.has(f.category));
    // 競合しないこと: その種別の施設が 1 つだけ、かつ他の施設が無い
    if (whole.length === 1 && r.facilities.length === 1) {
      r.primaryFacilityName = whole[0].name;
      stats.primaryFromPoi++;
      if (!r.source) {
        r.source = 'osm'; r.sourceId = whole[0].sourceId;
        r.matchMethod = 'poi-inside-building'; r.confidence = 'medium';
      }
    }
  }

  // ── §10 既存 landmark との重複を外す ─────────────────────────────
  for (const r of records.values()) {
    const nm = r.buildingName || r.primaryFacilityName;
    if (!nm) continue;
    const lm = isSameAsLandmark(nm, r.x, r.z, landmarks);
    if (lm) { r.isLandmark = true; r.landmarkName = lm.name; stats.landmarkDeduped++; }
  }

  // ── §9 ラベルの zoom 帯 ─────────────────────────────────────────
  for (const r of records.values()) {
    const b = byId.get(r.buildingId);
    const cat = r.buildingCategory || (r.facilities[0] && r.facilities[0].category) || null;
    r.labelTier = labelTier({
      height: r.h, category: cat,
      isPrimaryFacility: !!r.primaryFacilityName,
      footprintAreaM2: b ? b.areaM2 : 0,
    });
    // 施設は種別の優先度で並べておく（近景で上から出すため）
    r.facilities.sort((a, c) => categoryRank(a.category) - categoryRank(c.category));
    r.facilityCount = r.facilities.length;
  }

  // ── §10/§15 同じ名前が同じ場所に何度も出ないようにする ───────────────
  //   1 つの OSM 名が PLATEAU の複数の building part に当たることがある
  //   （グランフロント大阪 = 3 棟など）。データは全部残し、**ラベルを出す 1 棟だけ**を選ぶ。
  //   選ぶのは「一番大きい（高い・広い）棟」。
  {
    // 同じ名前のものを集め、**距離でまとめる**（格子で切ると境界で分かれてしまう）。
    //   学校・神社・大型商業は敷地内の複数棟に同じ名前が付くので、150m では足りない。
    const byName = new Map();
    for (const r of records.values()) {
      const nm = r.buildingName || r.primaryFacilityName;
      if (!nm) continue;
      const n = normalizeName(nm);
      if (!n) continue;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(r);
    }
    for (const g of byName.values()) {
      if (g.length < 2) continue;
      // 大きい順に見て、SAME_NAME_CLUSTER_M 以内の同名は同じ施設とみなしてラベルを 1 つに絞る
      g.sort((a, b) => ((b.h || 0) - (a.h || 0)) || (b.areaM2 - a.areaM2));
      const anchors = [];
      for (const r of g) {
        const near = anchors.find((a) => Math.hypot(a.x - r.x, a.z - r.z) <= SAME_NAME_CLUSTER_M);
        if (near) { r.labelSuppressed = true; r.labelClusterOf = near.buildingId; stats.labelSuppressed++; }
        else anchors.push(r);
      }
    }
  }
  // 既存 landmark と同じものはラベルを出さない（landmark 側を優先・§10）
  for (const r of records.values()) if (r.isLandmark) r.labelSuppressed = true;

  const list = [...records.values()].filter((r) => r.buildingName || r.primaryFacilityName || r.facilities.length);
  const withBuildingName = list.filter((r) => r.buildingName);
  const byWard = {};
  for (const b of buildings) {
    const w = b.wardId || '(none)';
    byWard[w] = byWard[w] || { buildings: 0, named: 0 };
    byWard[w].buildings++;
  }
  for (const r of withBuildingName) {
    const w = r.wardId || '(none)';
    if (byWard[w]) byWard[w].named++;
  }
  for (const w of Object.keys(byWard)) {
    byWard[w].coveragePct = +(100 * byWard[w].named / Math.max(1, byWard[w].buildings)).toFixed(2);
  }

  const doc = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35O',
    coordinateConvention: 'znorth-neg-v1',
    source: 'OpenStreetMap（building way/relation の name・name:ja、名称つき施設 way、施設 POI node）',
    note: '名称は推測していない。OSM に実在する name / name:ja だけを、ポリゴンの重なり '
      + 'または footprint 内包で紐づけている。近さだけでの付与はしていない。',
    thresholds: { ...MATCH, cellM: CELL_M, maxFacilitiesPerBuilding: MAX_FACILITIES_PER_BUILDING },
    counts: {
      buildingsTotal: buildings.length,
      buildingsWithAnyName: list.length,
      buildingName: withBuildingName.length,
      primaryFacilityName: list.filter((r) => r.primaryFacilityName).length,
      facilityLinks: stats.facilityLinks,
      high: list.filter((r) => r.confidence === 'high').length,
      medium: list.filter((r) => r.confidence === 'medium').length,
      unmatchedFacilities: stats.unmatchedFacilities,
      competingBuildings: stats.competingBuildingRejected,
      landmarkDuplicates: stats.landmarkDeduped,
      labelSuppressed: stats.labelSuppressed,
      nearestWithEvidence: stats.nearestWithEvidence,
      osmNamedBuildingWays: namedBuildingWays.length,
      osmNamedFacilityWays: namedFacilityWays.length,
      osmNamedPois: pois.length,
    },
    byTier: list.reduce((a, r) => { a[r.labelTier] = (a[r.labelTier] || 0) + 1; return a; }, {}),
    byWard,
    buildings: list,
  };

  // 全部入り（provenance 込み。validator が読む）
  fs.mkdirSync(path.dirname(OUT_FULL), { recursive: true });
  fs.writeFileSync(OUT_FULL, JSON.stringify(doc));
  // 配信用は 2 つに分ける。21MB を起動時に読ませない（§20）。
  //   1) ラベル用: 画面に出す 1 棟ぶんだけ。名前・位置・高さ・zoom 帯。
  //   2) 詳細用: 建物クリックで引く。施設名と provenance を持つ（遅延 fetch）。
  const named = list.filter((r) => r.buildingName || r.primaryFacilityName);
  const labels = {
    version: doc.version, generatedAt: doc.generatedAt, missionId: '35O',
    coordinateConvention: doc.coordinateConvention, source: doc.source,
    counts: doc.counts, byTier: doc.byTier,
    // id, 名前, x, z, 高さ, zoom 帯, 施設数
    labels: named.filter((r) => !r.labelSuppressed).map((r) => ({
      id: r.buildingId,
      name: r.buildingName || r.primaryFacilityName,
      x: r.x, z: r.z, h: r.h || 0, t: r.labelTier, n: r.facilityCount,
    })),
  };
  fs.mkdirSync(path.dirname(OUT_LABELS), { recursive: true });
  fs.writeFileSync(OUT_LABELS, JSON.stringify(labels));

  const runtime = {
    version: doc.version, generatedAt: doc.generatedAt, missionId: '35O',
    coordinateConvention: doc.coordinateConvention, source: doc.source, note: doc.note,
    counts: doc.counts,
    buildings: named.map((r) => ({
      buildingId: r.buildingId,
      buildingName: r.buildingName || null,
      primaryFacilityName: r.primaryFacilityName || null,
      n: r.facilityCount,
      f: r.facilities.slice(0, 6).map((f) => f.name),
      source: r.source, matchMethod: r.matchMethod, confidence: r.confidence,
    })),
  };
  fs.mkdirSync(path.dirname(OUT_RUNTIME), { recursive: true });
  fs.writeFileSync(OUT_RUNTIME, JSON.stringify(runtime));
  doc.runtimeCount = runtime.buildings.length;
  doc.labelCount = labels.labels.length;
  const { buildings: _b, ...report } = doc;
  report.elapsedMs = Date.now() - t0;
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  return doc;
}

if (isMainModule(import.meta.url)) {
  runAsync().then((d) => {
    const c = d.counts;
    console.log('[35O] 建物名', c.buildingName, '/ 主要施設名', c.primaryFacilityName,
      '/ 施設リンク', c.facilityLinks);
    console.log('[35O] high', c.high, '/ medium', c.medium, '/ 未紐付け施設', c.unmatchedFacilities);
    console.log('[35O] out', OUT_FILES[0]);
  }).catch((e) => { console.error(e); process.exitCode = 1; });
}
