#!/usr/bin/env node
// tools/build-canonical-roads.js
// [Mission 31C] Canonical Roads 正式化。
//   道路区域 polygon を canonical geometry として採用する方針だが、現時点で polygon source
//   （公的道路区域 / PLATEAU tran:Road / OSM area:highway）は 1 件も取得できていないため、
//   全 feature が OSM centerline + 幅推定の ribbon fallback になる（§18。架空の道路区域は生成しない §0）。
//
//   ※ RoadLayer / CityTileLayer の描画は不変。projection / znorth-neg-v1 / Mission26 road LOD 意味も不変。
//   ※ 出力は data/processed/osaka-city/canonical/roads/ 配下のみ（tile prototype。§16）。
//
// source priority（canonical-geometry-schema SOURCE_PRIORITY.roads）:
//   1 公的道路区域 polygon（未取得）/ 2 PLATEAU tran:Road 面（未取得）/ 3 OSM area:highway（0 件）
//   / 4 OSM centerline + width|lanes / 5 OSM centerline + class default width
//
// 出力:
//   data/processed/osaka-city/canonical/roads/manifest.json + tile_*.json （canonical 本体・full precision）
//   data/reports/canonical-road-build.json
//   data/reports/canonical-road-major.json
//   data/reports/canonical-road-intersection-qa.json
//   data/reports/canonical-road-preview.geojson （major + 名前付きのみ・サイズ抑制）
//
// 実行: node tools/build-canonical-roads.js
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { resolveRoadWidth, polylineLengthXZ } from './lib/road-network.js';
import { classifyRoadLod } from './lib/road-lod.js';
import { buildRoadRibbon } from './lib/road-ribbon.js';
import {
  COORDINATE_CONVENTION, CONFIDENCE, SOURCE_PRIORITY, makeProvenance, makeCanonicalFeature,
  validateCanonicalFeature, polygonAreaM2, ringAreaM2, bboxOf,
} from './lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AREA = P('config', 'areas', 'osaka-city.json');
const ROADS_DIR = P('public', 'map-data', 'osaka-city', 'roads');
const OUT_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const REPORT = P('data', 'reports', 'canonical-road-build.json');
const MAJOR_REPORT = P('data', 'reports', 'canonical-road-major.json');
const INTERSECTION_QA = P('data', 'reports', 'canonical-road-intersection-qa.json');
const PREVIEW = P('data', 'reports', 'canonical-road-preview.geojson');

const GROUND_EXTENT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const CITY_MARGIN = 1600;
const TILE_SIZE = 2000;
const MIN_AREA_M2 = 2;
const GIANT_AREA_M2 = 400_000;   // 単一道路 feature でこれ超は異常
const GIANT_EDGE_M = 300;
// [§8/§22] 重点確認道路。alias で OSM 名の揺れ（線 / (Route N) / 別名）を吸収。
const MAJOR_ROADS = [
  { name: '御堂筋', aliases: ['御堂筋'] },
  { name: '新御堂筋', aliases: ['新御堂筋'] },
  { name: '中央大通', aliases: ['中央大通'] },
  { name: '長居公園通', aliases: ['長居公園通'] },
  { name: '国道1号', aliases: ['国道1号', '京阪国道'], borderRoad: true },
  { name: '国道25号', aliases: ['国道25号'] },
  { name: '国道43号', aliases: ['国道43号'] },
  { name: '阪神高速', aliases: ['阪神高速'] },
];

function makeProjector(area) {
  const { centerLat, centerLon, metersPerDegree } = area.projection;
  const cosf = Math.cos((centerLat * Math.PI) / 180);
  return { toLatLon: (x, z) => [centerLat - z / metersPerDegree, centerLon + x / (cosf * metersPerDegree)] };
}
function ringBbox(ring) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const [x, z] of ring) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
  return { minX: a, maxX: b, minZ: c, maxZ: d };
}
function segIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function ringSelfIntersects(ring) {
  const n = ring.length;
  if (n < 4 || n > 400) return false;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segIntersect(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
  }
  return false;
}
function maxEdge(ring) {
  let m = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; const e = Math.hypot(a[0] - b[0], a[1] - b[1]); if (e > m) m = e; }
  return m;
}
function pointInRing(x, z, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) ins = !ins;
  }
  return ins;
}
function distToRing(px, pz, ring) {
  let m = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    let t = l2 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz));
    if (d < m) m = d;
  }
  return m;
}
const rnd = (v) => Math.round(v * 100) / 100;

// ribbon → geometry。まず単一 Polygon（left + reversed right）。自己交差なら区間ごとの四角 MultiPolygon。
function ribbonGeometry(left, right) {
  const single = left.concat(right.slice().reverse()).map(([x, z]) => [rnd(x), rnd(z)]);
  if (single.length >= 4 && !ringSelfIntersects(single) && ringAreaM2(single) >= MIN_AREA_M2) {
    return { gt: 'Polygon', coords: [single], parts: 1 };
  }
  const quads = [];
  const n = Math.min(left.length, right.length);
  for (let i = 0; i + 1 < n; i++) {
    const q = [
      [rnd(left[i][0]), rnd(left[i][1])], [rnd(left[i + 1][0]), rnd(left[i + 1][1])],
      [rnd(right[i + 1][0]), rnd(right[i + 1][1])], [rnd(right[i][0]), rnd(right[i][1])],
    ];
    if (ringAreaM2(q) >= 0.5 && !ringSelfIntersects(q)) quads.push([q]);
  }
  if (!quads.length) return null;
  return quads.length === 1 ? { gt: 'Polygon', coords: quads[0], parts: 1 } : { gt: 'MultiPolygon', coords: quads, parts: quads.length };
}

function checkQuality(gt, coords) {
  const polys = gt === 'Polygon' ? [coords] : coords;
  let area = 0;
  for (const poly of polys) {
    const outer = poly[0];
    if (!outer || outer.length < 3) return { ok: false, reason: 'degenerate-ring' };
    for (const p of outer) if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return { ok: false, reason: 'non-finite' };
    const oa = ringAreaM2(outer);
    if (oa < MIN_AREA_M2) return { ok: false, reason: 'zero-area' };
    if (oa > GIANT_AREA_M2) return { ok: false, reason: 'giant-polygon' };
    if (maxEdge(outer) > GIANT_EDGE_M) return { ok: false, reason: 'giant-edge' };
    if (ringSelfIntersects(outer)) return { ok: false, reason: 'self-intersection' };
    area += oa;
  }
  const bb = bboxOf(coords);
  if (bb.maxX < GROUND_EXTENT.minX - CITY_MARGIN || bb.minX > GROUND_EXTENT.maxX + CITY_MARGIN
    || bb.maxZ < GROUND_EXTENT.minZ - CITY_MARGIN || bb.minZ > GROUND_EXTENT.maxZ + CITY_MARGIN) return { ok: false, reason: 'city-bbox-violation' };
  return { ok: true, area };
}

function loadRoadFeatures() {
  const byId = new Map();
  for (const f of fs.readdirSync(ROADS_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(ROADS_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (ft.kind !== 'line' || !Array.isArray(ft.p) || ft.p.length < 2) continue;
      if (!byId.has(ft.id)) byId.set(ft.id, ft);
    }
  }
  return [...byId.values()];
}

// [Mission 31C2] PLATEAU tran road-surface polygon（あれば）を読み、centerline を空間 match する。
const TRAN_POLYGONS = P('data', 'processed', 'osaka-city', 'canonical', 'roads-tran', 'polygons.json');
const HASH_M = 80;
function loadTranRoadPolygons() {
  if (!fs.existsSync(TRAN_POLYGONS)) return null;
  const doc = JSON.parse(fs.readFileSync(TRAN_POLYGONS, 'utf-8'));
  const polys = (doc.polygons || []).filter((p) => p.surfaceKind === 'roadSurface');
  const hash = new Map();
  for (let i = 0; i < polys.length; i++) {
    const bb = polys[i].bbox;
    for (let cx = Math.floor(bb.minX / HASH_M); cx <= Math.floor(bb.maxX / HASH_M); cx++)
      for (let cz = Math.floor(bb.minZ / HASH_M); cz <= Math.floor(bb.maxZ / HASH_M); cz++) {
        const k = cx + ',' + cz; if (!hash.has(k)) hash.set(k, []); hash.get(k).push(i);
      }
  }
  return { doc, polys, hash };
}
function polyOuterRings(p) { return p.geometryType === 'Polygon' ? [p.coordinates[0]] : (p.coordinates || []).map((x) => x[0]).filter(Boolean); }
// centerline を覆う tran roadSurface polygon 群を返す（§9/§10）。
function matchTranPolygons(centerline, tran) {
  if (!tran) return null;
  const clbb = { minX: Math.min(...centerline.map((p) => p[0])), maxX: Math.max(...centerline.map((p) => p[0])), minZ: Math.min(...centerline.map((p) => p[1])), maxZ: Math.max(...centerline.map((p) => p[1])) };
  const cand = new Set();
  for (let cx = Math.floor(clbb.minX / HASH_M); cx <= Math.floor(clbb.maxX / HASH_M); cx++)
    for (let cz = Math.floor(clbb.minZ / HASH_M); cz <= Math.floor(clbb.maxZ / HASH_M); cz++)
      for (const i of (tran.hash.get(cx + ',' + cz) || [])) cand.add(i);
  if (!cand.size) return null;
  // 頂点ごとに「どの polygon に入ったか」を数える。1 頂点が複数 polygon に入りうるので、
  // 被覆率は延べ数ではなく「いずれかに入った頂点数 / 全頂点」で測る（重なり polygon で 1 を超えないため）。
  const insideCount = new Map();
  let covered = 0;
  for (const [x, z] of centerline) {
    let any = false;
    for (const i of cand) {
      if (!polyOuterRings(tran.polys[i]).some((rg) => pointInRing(x, z, rg))) continue;
      insideCount.set(i, (insideCount.get(i) || 0) + 1);
      any = true;
    }
    if (any) covered++;
  }
  if (!insideCount.size) return null;
  const hits = [...insideCount.entries()].map(([i, inside]) => ({ i, inside })).sort((a, b) => b.inside - a.inside);
  const insideRatio = covered / centerline.length;
  const quality = insideRatio >= 0.85 ? 'STRONG' : insideRatio >= 0.5 ? 'MEDIUM' : insideRatio >= 0.25 ? 'WEAK' : 'UNMATCHED';
  return { polyIdxs: hits.map((h) => h.i), hits, insideRatio: +insideRatio.toFixed(3), quality };
}

async function main() {
  const generatedAt = new Date().toISOString();
  const area = JSON.parse(fs.readFileSync(AREA, 'utf-8'));
  const proj = makeProjector(area);
  const roads = loadRoadFeatures();
  const tran = loadTranRoadPolygons();

  const out = [];
  const stats = {
    polygonCanonicalCount: 0, ribbonFallbackCount: 0,
    widthTagCount: 0, lanesCount: 0, defaultWidthCount: 0,
    byLodClass: { major: 0, mid: 0, local: 0 }, byHighway: {},
    bridge: 0, tunnel: 0, underground: 0,
    tranMatch: { STRONG: 0, MEDIUM: 0, WEAK: 0, UNMATCHED: 0, none: 0 },
    orphanTranCount: 0, orphanByAdminClass: {}, tranRejectReason: {},
    polygonWithOsmAttrs: 0, byStructure: {},
    rejected: { 'degenerate-ring': 0, 'zero-area': 0, 'giant-polygon': 0, 'giant-edge': 0, 'self-intersection': 0, 'non-finite': 0, 'city-bbox-violation': 0, 'ribbon-failed': 0, 'tran-polygon-invalid': 0 },
    schemaErrors: 0,
  };
  const tranAvailable = !!(tran && tran.polys.length);
  const intersectionQa = { sharpMiter: 0, tinyGapCandidates: 0, ribbonSelfCross: 0,
    tranPolygonsLoaded: tran ? tran.polys.length : 0,
    note: tranAvailable
      ? 'PLATEAU tran road-surface polygon を polygon-first source として採用。centerline match で geometry を polygon へ置換。'
      : 'polygon source が無いため交差点は centerline ribbon の重ね合わせ（団子状膨張・鋭角 miter・穴が残る）。PLATEAU tran 取得後に polygon-first で解消（31C2）。',
  };

  // ── pass A（§14 二重計上防止の要）: centerline ごとの match を先に全部計算し、
  //   「polygon → その polygon を通る centerline 群」の索引を作る。
  //   canonical geometry は polygon 起点に 1 枚 = 1 feature で出す（後段 pass B）。road 起点に出すと、
  //   交差点の面を複数の道路が同時に採用して道路面積が水増しされる（§18/§19 の conflict 計数まで狂う）。
  const tmByRoad = new Array(roads.length).fill(null);
  const polyOwners = new Map(); // polyIdx -> [{ ri, inside }]
  const roadCoveredByPolygon = new Set(); // polygon 側で geometry 表現済みの road（ribbon を出さない）
  if (tranAvailable) {
    for (let ri = 0; ri < roads.length; ri++) {
      const tm = matchTranPolygons(roads[ri].p, tran);
      tmByRoad[ri] = tm;
      if (tm) stats.tranMatch[tm.quality]++; else stats.tranMatch.none++;
      if (!tm || (tm.quality !== 'STRONG' && tm.quality !== 'MEDIUM')) continue;
      for (const h of tm.hits) {
        let a = polyOwners.get(h.i); if (!a) polyOwners.set(h.i, a = []);
        a.push({ ri, inside: h.inside });
      }
      roadCoveredByPolygon.add(ri);
      if ((ri + 1) % 5000 === 0) console.log('  [pass A] centerline match ' + (ri + 1) + '/' + roads.length);
    }
    console.log('  [pass A] polygon に対応がついた centerline: ' + roadCoveredByPolygon.size + '/' + roads.length
      + ' / 属性が付く polygon: ' + polyOwners.size + '/' + tran.polys.length);
  }

  for (let ri = 0; ri < roads.length; ri++) {
    const r = roads[ri];
    const tags = {
      highway: r.highway, width: r.width, lanes: r.lanes,
      service: r.service, tracktype: r.tracktype,
    };
    const wr = resolveRoadWidth(tags);
    const method = wr.source; // 'width' | 'lanes' | 'class-default'

    // ── polygon-first（§11）: この道路の区域は pass B で polygon feature として出力済み。
    //   ここで ribbon を重ねると同じ路面が二重に載るので出さない（§14）。
    if (roadCoveredByPolygon.has(ri)) continue;

    // ── ribbon fallback（§18。対応する tran polygon が無い / match WEAK 以下）──
    const rib = buildRoadRibbon(r.p, wr.width);
    if (!rib || !rib.ok || !rib.left || rib.left.length < 2) { stats.rejected['ribbon-failed']++; continue; }
    if ((rib.maxTriangleEdge || 0) > GIANT_EDGE_M) intersectionQa.sharpMiter++;

    const geom = ribbonGeometry(rib.left, rib.right);
    if (!geom) { stats.rejected['ribbon-failed']++; continue; }
    if (geom.parts > 1) intersectionQa.ribbonSelfCross++;
    const q = checkQuality(geom.gt, geom.coords);
    if (!q.ok) { stats.rejected[q.reason] = (stats.rejected[q.reason] || 0) + 1; continue; }

    // 幅推定の内訳は「実際に emit した ribbon feature」だけを数える（品質ゲートで落ちた分は含めない）。
    if (method === 'width') stats.widthTagCount++;
    else if (method === 'lanes') stats.lanesCount++;
    else stats.defaultWidthCount++;

    const lod = classifyRoadLod(r.highway);
    stats.byLodClass[lod]++;
    stats.byHighway[r.highway] = (stats.byHighway[r.highway] || 0) + 1;
    const isBridge = !!r.bridge, isTunnel = !!r.tunnel, isUnderground = !!r.underground;
    if (isBridge) stats.bridge++;
    if (isTunnel) stats.tunnel++;
    if (isUnderground) stats.underground++;

    // confidence: width タグ 0.80 / lanes 0.75 / class-default 0.65
    const confidence = method === 'width' ? CONFIDENCE.OSM_CENTERLINE_WIDTH_TAG
      : method === 'lanes' ? 0.75
        : CONFIDENCE.OSM_CENTERLINE_CLASS_DEFAULT_WIDTH;

    // centerline 整合
    const rings = geom.gt === 'Polygon' ? geom.coords : geom.coords.flat();
    let inside = 0, sum = 0, mx = 0;
    for (const [x, z] of r.p) {
      if (rings.some((rg) => pointInRing(x, z, rg))) inside++;
      let dmin = Infinity; for (const rg of rings) { const d = distToRing(x, z, rg); if (d < dmin) dmin = d; }
      sum += dmin; if (dmin > mx) mx = dmin;
    }
    const insideRatio = r.p.length ? +(inside / r.p.length).toFixed(3) : 0;

    const qaFlags = [];
    if (isBridge) qaFlags.push('bridge');
    if (isTunnel) qaFlags.push('tunnel');
    if (isUnderground) qaFlags.push('underground');
    if (geom.parts > 1) qaFlags.push('ribbon-self-cross-split');
    if (method === 'class-default') qaFlags.push('width-class-default-low-confidence');
    if (insideRatio < 0.7) qaFlags.push('centerline-partly-outside-ribbon');

    const method2 = method === 'class-default' ? 'osm-centerline-default-width' : 'osm-centerline-width';
    const prov = makeProvenance({
      geometrySource: 'osm-road-centerline',
      attributeSources: ['osm-road-centerline', r.name ? 'osm-name' : null].filter(Boolean),
      confidence: +confidence.toFixed(2),
      sourceIds: [r.source && r.source.id ? `way/${r.source.id}` : r.id],
      generatedAt,
      notes: `polygon source なし。centerline + 幅推定（${wr.source}=${wr.width.toFixed(1)}m）で ribbon 生成。fallbackKind=${method2}`,
    });
    const f = makeCanonicalFeature({
      canonicalId: `cg_road_${r.id}`,
      layer: 'roads', geometryType: geom.gt, coordinates: geom.coords,
      provenance: prov,
      attributes: {
        name: r.name || null,
        highway: r.highway,
        lodClass: lod,          // Mission26 の major/mid/local（LOD 意味は不変）
        detail: r.detail || null,
        lanes: r.lanes != null ? +r.lanes || r.lanes : null,
        width: r.width != null ? +r.width || r.width : null,
        surface: r.surface || null,
        bridge: isBridge || null,
        tunnel: isTunnel || null,
        underground: isUnderground || null,
        layer: r.layer != null ? +r.layer || r.layer : null,
        oneway: r.oneway || null,
        service: r.service || null,
        tracktype: r.tracktype || null,
        access: r.access || null,
      },
      qaFlags,
      centerlineRef: {
        sourceIds: [r.source && r.source.id ? `way/${r.source.id}` : r.id],
        coordinates: r.p.map(([x, z]) => [rnd(x), rnd(z)]),
        lengthM: Math.round(polylineLengthXZ(r.p)),
        centerlineInsideRatio: insideRatio,
        meanCenterlineToRoadAreaDistance: +(sum / (r.p.length || 1)).toFixed(2),
        maxCenterlineToRoadAreaDistance: +mx.toFixed(2),
      },
      widthProfile: {
        method: method2,
        widthM: +wr.width.toFixed(2),
        source: wr.source,
        laneWidthM: 3.25,
        areaM2: Math.round(polygonAreaM2(geom.gt, geom.coords)),
      },
    });
    const v = validateCanonicalFeature(f);
    if (!v.ok) { stats.schemaErrors++; f.qaFlags.push('schema-error:' + v.errors[0]); }
    out.push(f);
    stats.ribbonFallbackCount++;
  }

  // ── pass B（§11/§13/§14/§20/§21）: PLATEAU tran 道路区域面を 1 枚 = 1 feature で canonical 化 ──
  //   polygon 起点なので同じ路面が 2 度出ることは構造的に起きない（無制限 union もしない）。
  //   属性は pass A で対応がついた OSM centerline から join する。対応が無い面（OSM PBF が
  //   lat≈34.735 以北で切れているため東淀川区・淀川区・旭区にはそもそも centerline が無い）は
  //   geometry だけ採用し、OSM 属性は SOURCE_MISSING として明示する。架空生成ではない（§0）。
  if (tranAvailable) {
    for (let i = 0; i < tran.polys.length; i++) {
      const p = tran.polys[i];
      const polys = p.geometryType === 'Polygon' ? [p.coordinates] : p.coordinates;
      const parts = [];
      let lastReason = 'unknown';
      for (const poly of polys) { const q1 = checkQuality('Polygon', poly); if (q1.ok) parts.push(poly); else lastReason = q1.reason; }
      if (!parts.length) {
        stats.rejected['tran-polygon-invalid']++;
        stats.tranRejectReason[lastReason] = (stats.tranRejectReason[lastReason] || 0) + 1;
        continue;
      }
      const gtP = parts.length === 1 ? 'Polygon' : 'MultiPolygon';
      const coordsP = gtP === 'Polygon' ? parts[0] : parts;

      // 対応 centerline（内包頂点数の多い順）。先頭を属性の primary とする。
      const owners = (polyOwners.get(i) || []).slice().sort((a, b) => b.inside - a.inside);
      const primary = owners.length ? roads[owners[0].ri] : null;
      const ptm = owners.length ? tmByRoad[owners[0].ri] : null;

      const structQf = [];
      if (p.structure === 'elevated') structQf.push('elevated');
      if (p.structure === 'bridge') structQf.push('bridge');
      if (p.structure === 'intersection') structQf.push('intersection');
      if (p.structure === 'underpass') structQf.push('underpass');
      const plateauAttrs = {
        plateauAdminClass: p.adminClass, plateauFunctionCode: p.functionCode,
        plateauFunctionLabel: p.functionLabel, plateauStructure: p.structure,
      };

      let f;
      if (primary) {
        // 属性は OSM centerline から。Mission26 の lodClass は従来どおり OSM highway で決める。
        const lod = classifyRoadLod(primary.highway);
        stats.byLodClass[lod]++;
        stats.byHighway[primary.highway] = (stats.byHighway[primary.highway] || 0) + 1;
        const isBr = !!primary.bridge, isTn = !!primary.tunnel, isUg = !!primary.underground;
        if (isBr) stats.bridge++; if (isTn) stats.tunnel++; if (isUg) stats.underground++;
        const geomConf = ptm.quality === 'STRONG' ? CONFIDENCE.PLATEAU_ROAD_POLYGON_VERIFIED : CONFIDENCE.PLATEAU_ROAD_POLYGON_PARTIAL;
        const qf = ['geometry=plateau-tran-road', 'osm-match=' + ptm.quality, ...structQf];
        if (isBr) qf.push('bridge'); if (isTn) qf.push('tunnel'); if (isUg) qf.push('underground');
        if (owners.length > 1) qf.push('multi-centerline-' + owners.length);
        stats.polygonWithOsmAttrs++;
        f = makeCanonicalFeature({
          canonicalId: 'cg_road_tran_' + String(p.roadId || p.tranId || i).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60),
          layer: 'roads', geometryType: gtP, coordinates: coordsP,
          provenance: makeProvenance({
            geometrySource: 'plateau-tran-road',
            attributeSources: ['osm-road-centerline', primary.name ? 'osm-name' : null].filter(Boolean),
            confidence: geomConf,
            sourceIds: ['plateau-tran/' + (p.roadId || p.tranId || i), ...owners.slice(0, 8).map((o) => {
              const rr = roads[o.ri]; return rr.source && rr.source.id ? 'way/' + rr.source.id : rr.id;
            })],
            generatedAt,
            notes: `PLATEAU tran 道路区域面 1 枚。属性は OSM centerline ${owners.length} 本のうち最も内包の大きい 1 本から join（match=${ptm.quality}, insideRatio ${ptm.insideRatio}）。geometryConfidence ${geomConf}。`,
          }),
          attributes: {
            name: primary.name || null, highway: primary.highway, lodClass: lod, detail: primary.detail || null,
            lanes: primary.lanes != null ? (+primary.lanes || primary.lanes) : null,
            width: primary.width != null ? (+primary.width || primary.width) : null,
            surface: primary.surface || null, bridge: isBr || null, tunnel: isTn || null, underground: isUg || null,
            layer: primary.layer != null ? (+primary.layer || primary.layer) : null,
            oneway: primary.oneway || null, service: primary.service || null,
            tracktype: primary.tracktype || null, access: primary.access || null,
            ...plateauAttrs,
          },
          qaFlags: qf,
          centerlineRef: {
            sourceIds: owners.slice(0, 8).map((o) => { const rr = roads[o.ri]; return rr.source && rr.source.id ? 'way/' + rr.source.id : rr.id; }),
            coordinates: primary.p.map(([x, z]) => [rnd(x), rnd(z)]),
            lengthM: Math.round(polylineLengthXZ(primary.p)),
            centerlineInsideRatio: ptm.insideRatio,
            osmMatchQuality: ptm.quality,
            centerlineCount: owners.length,
            names: [...new Set(owners.map((o) => roads[o.ri].name).filter(Boolean))].slice(0, 8),
          },
          widthProfile: { method: 'plateau-tran-polygon', widthM: null, source: 'plateau-tran', areaM2: Math.round(polygonAreaM2(gtP, coordsP)) },
        });
      } else {
        // Mission26 の major/mid/local の意味は変えない。OSM highway が無いので
        // PLATEAU の行政種別から同じ意味のバンドへ割り当て、由来を qaFlag で明示する。
        const lod = (p.adminClass === 'expressway' || p.adminClass === 'national') ? 'major'
          : p.adminClass === 'prefectural' ? 'mid' : 'local';
        stats.byLodClass[lod]++;
        stats.orphanTranCount++;
        stats.orphanByAdminClass[p.adminClass] = (stats.orphanByAdminClass[p.adminClass] || 0) + 1;
        f = makeCanonicalFeature({
          canonicalId: 'cg_road_tran_' + String(p.roadId || p.tranId || i).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60),
          layer: 'roads', geometryType: gtP, coordinates: coordsP,
          provenance: makeProvenance({
            geometrySource: 'plateau-tran-road',
            attributeSources: ['plateau-tran-road'],
            confidence: CONFIDENCE.PLATEAU_ROAD_POLYGON_UNVERIFIED,
            sourceIds: ['plateau-tran/' + (p.roadId || p.tranId || i)],
            generatedAt,
            notes: `対応する OSM centerline なし。PLATEAU tran 道路区域面をそのまま採用し、名称・車線数・bridge/tunnel 等の OSM 属性は SOURCE_MISSING。行政種別=${p.functionLabel || p.adminClass} / 構造=${p.structure}。`,
          }),
          attributes: {
            name: null, highway: null, lodClass: lod, detail: null,
            lanes: null, width: null, surface: null,
            bridge: p.structure === 'bridge' || null, tunnel: null, underground: null,
            layer: null, oneway: null, service: null, tracktype: null, access: null,
            ...plateauAttrs,
          },
          qaFlags: ['geometry=plateau-tran-road', 'osm-match=none', 'attributes-source-missing', 'lod-from-plateau-admin-class', ...structQf],
          centerlineRef: null,
          widthProfile: { method: 'plateau-tran-polygon', widthM: null, source: 'plateau-tran', areaM2: Math.round(polygonAreaM2(gtP, coordsP)) },
        });
      }
      const v = validateCanonicalFeature(f);
      if (!v.ok) { stats.schemaErrors++; f.qaFlags.push('schema-error:' + v.errors[0]); }
      out.push(f);
      stats.polygonCanonicalCount++;
      stats.byStructure[p.structure] = (stats.byStructure[p.structure] || 0) + 1;
      if ((i + 1) % 50000 === 0) console.log('  [pass B] polygon ' + (i + 1) + '/' + tran.polys.length);
    }
    console.log('  [pass B] polygon feature ' + stats.polygonCanonicalCount
      + '（OSM 属性あり ' + stats.polygonWithOsmAttrs + ' / 属性 SOURCE_MISSING ' + stats.orphanTranCount + '）');
  }

  // ── tile 化（§16）──
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tileMap = new Map();
  for (const f of out) {
    if (!f.bbox) continue;
    for (let tx = Math.floor(f.bbox.minX / TILE_SIZE); tx <= Math.floor(f.bbox.maxX / TILE_SIZE); tx++)
      for (let tz = Math.floor(f.bbox.minZ / TILE_SIZE); tz <= Math.floor(f.bbox.maxZ / TILE_SIZE); tz++) {
        const k = tx + '_' + tz;
        if (!tileMap.has(k)) tileMap.set(k, []);
        tileMap.get(k).push(f);
      }
  }
  const tiles = [];
  for (const [k, feats] of [...tileMap.entries()].sort()) {
    const [tx, tz] = k.split('_').map(Number);
    fs.writeFileSync(path.join(OUT_DIR, `tile_${tx}_${tz}.json`), JSON.stringify({ tx, tz, tileSize: TILE_SIZE, coordinateConvention: COORDINATE_CONVENTION, count: feats.length, features: feats }));
    tiles.push({ tx, tz, file: `tile_${tx}_${tz}.json`, count: feats.length });
  }
  const bbox = bboxOf(out.map((f) => f.coordinates));
  // §23 polygon coverage: feature 比 / 道路延長比 / 面積比。
  const polyFeats = out.filter((f) => f.source.geometrySource === 'plateau-tran-road');
  const totLenM = out.reduce((s, f) => s + ((f.centerlineRef && f.centerlineRef.lengthM) || 0), 0);
  const polyLenM = polyFeats.reduce((s, f) => s + ((f.centerlineRef && f.centerlineRef.lengthM) || 0), 0);
  const totAreaM2 = out.reduce((s, f) => s + polygonAreaM2(f.geometryType, f.coordinates), 0);
  const polyAreaM2v = polyFeats.reduce((s, f) => s + polygonAreaM2(f.geometryType, f.coordinates), 0);
  const covByFeature = out.length ? +(polyFeats.length / out.length).toFixed(4) : 0;
  const covByLength = totLenM ? +(polyLenM / totLenM).toFixed(4) : 0;
  const covByArea = totAreaM2 ? +(polyAreaM2v / totAreaM2).toFixed(4) : 0;
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({
    version: 1, layer: 'roads', kind: 'canonical-geometry', coordinateConvention: COORDINATE_CONVENTION,
    generatedAt, tileSize: TILE_SIZE, featureCount: out.length, bbox,
    sourcePriority: SOURCE_PRIORITY.roads,
    polygonCoverageRatio: covByFeature,
    polygonCoverageRatioByFeature: covByFeature,
    polygonCoverageRatioByLength: covByLength,
    polygonCoverageRatioByArea: covByArea,
    tranMatch: stats.tranMatch,
    fallbackNote: tranAvailable
      ? 'PLATEAU tran road-surface polygon を polygon-first 採用。match STRONG/MEDIUM は polygon、WEAK 以下は ribbon fallback。'
      : 'polygon source（公的道路区域 / PLATEAU tran:Road / OSM area:highway）が未取得のため全 feature が ribbon fallback（§18・§0: 架空生成しない）。取得手順: MISSION31C2_RUNBOOK.md。',
    simplification: 'none。LOD simplify は 31F derived band で（Mission26 の major/mid/local 意味を維持）。',
    tiles,
  }, null, 2));

  // ── major road comparison（§8/§22）──
  const majorRows = MAJOR_ROADS.map((mr) => {
    // polygon 起点になったため、名前は attributes.name（primary centerline）だけでなく
    // centerlineRef.names（その面を通る全 centerline）も見る。交差点の面を取りこぼさないため。
    const namesOf = (f) => [f.attributes.name, ...((f.centerlineRef && f.centerlineRef.names) || [])].filter(Boolean);
    const use = out.filter((f) => namesOf(f).some((n) => mr.aliases.some((a) => n.includes(a))));
    const area = use.reduce((s, f) => s + polygonAreaM2(f.geometryType, f.coordinates), 0);
    const clLen = use.reduce((s, f) => s + ((f.centerlineRef && f.centerlineRef.lengthM) || 0), 0);
    const widths = use.map((f) => f.widthProfile.widthM).filter(Number.isFinite);
    return {
      name: mr.name,
      aliasesMatched: [...new Set(use.flatMap(namesOf))].slice(0, 8),
      featureCount: use.length,
      borderRoad: !!mr.borderRoad,
      polygonSourceAvailable: tranAvailable,
      polygonFeatures: use.filter((f) => f.source.geometrySource === 'plateau-tran-road').length,
      ribbonFeatures: use.filter((f) => f.source.geometrySource === 'osm-road-centerline').length,
      geometrySource: use.length
        ? (use.some((f) => f.source.geometrySource === 'plateau-tran-road') ? 'plateau-tran-road (polygon-first) + osm ribbon fallback' : 'osm-road-centerline (ribbon fallback)')
        : '(not found — 24区外/未マップ)',
      ribbonAreaM2: Math.round(use.filter((f) => f.source.geometrySource === 'osm-road-centerline').reduce((s, f) => s + polygonAreaM2(f.geometryType, f.coordinates), 0)),
      polygonAreaM2: Math.round(use.filter((f) => f.source.geometrySource === 'plateau-tran-road').reduce((s, f) => s + polygonAreaM2(f.geometryType, f.coordinates), 0)),
      totalAreaM2: Math.round(area),
      centerlineLengthM: clLen,
      widthM: widths.length ? +(widths.reduce((a, b) => a + b, 0) / widths.length).toFixed(1) : null,
      confidence: use.length ? use.reduce((a, f) => Math.max(a, f.source.confidence), 0) : null,
      bridgeFeatures: use.filter((f) => f.attributes.bridge).length,
      tunnelFeatures: use.filter((f) => f.attributes.tunnel).length,
    };
  });
  await writeJson(MAJOR_REPORT, {
    generatedAt,
    note: tranAvailable
      ? '§16 主要道路 QA。polygon = PLATEAU tran 道路区域面、ribbon = OSM centerline+幅推定の fallback。ribbonAreaM2 は polygon が取れなかった区間の面積。'
      : 'canonical road（ribbon fallback）vs 現行 RoadLayer ribbon。polygon source が無いため polygon 比較は 31D 以降。',
    roads: majorRows,
  });

  await writeJson(INTERSECTION_QA, {
    generatedAt,
    method: 'ribbon の maxTriangleEdge / 自己交差で交差点品質の代理指標を取る。',
    ...intersectionQa,
    conclusion: tranAvailable
      ? 'polygon source（PLATEAU tran:Road 道路区域面）を 31C2 で取得・採用したため、交差点は実測の一体面で表現される。ribbon 特有の団子状膨張・鋭角 miter は polygon feature には発生しない。残る ribbon は tran と対応の取れない少数区間のみ。定量比較は canonical-road-intersection-compare.json（§15）。'
      : 'polygon source（公的道路区域 or PLATEAU tran:Road）が無い限り、交差点の一体面・鋭角 miter・団子状膨張は根本解決しない。現状の ribbon を canonical fallback として正式登録し、polygon source 取得を後続の課題として明示する。',
  });

  // ── preview（major LOD = 幹線骨格のみ。mid/local は除外してサイズ抑制。§23 は外部 GIS 確認用）──
  const previewFeats = out.filter((f) => f.attributes.lodClass === 'major');
  const gj = {
    type: 'FeatureCollection', name: 'canonical-roads-osaka-city (major LOD only)',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features: previewFeats.map((f) => {
      const toGeo = (ring) => ring.map(([x, z]) => { const [lat, lon] = proj.toLatLon(x, z); return [+lon.toFixed(6), +lat.toFixed(6)]; });
      const closeRing = (rg) => (rg.length && (rg[0][0] !== rg[rg.length - 1][0] || rg[0][1] !== rg[rg.length - 1][1]) ? [...rg, rg[0]] : rg);
      const geometry = f.geometryType === 'Polygon'
        ? { type: 'Polygon', coordinates: f.coordinates.map((rg) => closeRing(toGeo(rg))) }
        : { type: 'MultiPolygon', coordinates: f.coordinates.map((poly) => poly.map((rg) => closeRing(toGeo(rg)))) };
      return {
        type: 'Feature', geometry,
        properties: {
          canonicalId: f.canonicalId, name: f.attributes.name, highway: f.attributes.highway,
          lodClass: f.attributes.lodClass, geometrySource: f.source.geometrySource, confidence: f.source.confidence,
          widthM: f.widthProfile.widthM, bridge: f.attributes.bridge, tunnel: f.attributes.tunnel,
          qaFlags: f.qaFlags.join(','),
        },
      };
    }),
  };
  fs.writeFileSync(PREVIEW, JSON.stringify(gj));

  const confList = out.map((f) => f.source.confidence);
  const report = {
    generatedAt,
    tileDir: toProjectRelativePath(OUT_DIR),
    roadFeaturesInput: roads.length,
    featureCount: out.length,
    plateauTranAvailable: tranAvailable,
    tranPolygonsLoaded: tran ? tran.polys.length : 0,
    tranMatch: stats.tranMatch,
    polygonCanonicalCount: stats.polygonCanonicalCount,
    polygonWithOsmAttributes: stats.polygonWithOsmAttrs,
    orphanTranCount: stats.orphanTranCount,
    orphanByAdminClass: stats.orphanByAdminClass,
    tranRejectReason: stats.tranRejectReason,
    byPlateauStructure: stats.byStructure,
    widthResolutionNote: 'width 推定は ribbon fallback だけに適用される（polygon feature は実測面なので幅推定を使わない）。',
    ribbonFallbackCount: stats.ribbonFallbackCount,
    defaultWidthFallbackCount: stats.defaultWidthCount,
    polygonCoverageRatioByFeature: covByFeature,
    polygonCoverageRatioByLength: covByLength,
    polygonCoverageRatioByArea: covByArea,
    polygonCoverageRatio: covByFeature,
    widthResolution: { widthTag: stats.widthTagCount, lanes: stats.lanesCount, classDefault: stats.defaultWidthCount },
    byLodClass: stats.byLodClass,
    byHighway: stats.byHighway,
    bridgeTunnel: { bridge: stats.bridge, tunnel: stats.tunnel, underground: stats.underground },
    rejected: stats.rejected,
    schemaErrors: stats.schemaErrors,
    // 16 万件規模なので spread（Math.min(...arr)）はスタックを溢れさせる。reduce で畳む。
    confidence: {
      mean: +(confList.reduce((s, c) => s + c, 0) / (confList.length || 1)).toFixed(3),
      min: confList.reduce((a, c) => (c < a ? c : a), Infinity),
      max: confList.reduce((a, c) => (c > a ? c : a), -Infinity),
    },
    intersectionQa,
    tiles: tiles.length,
    bbox,
    RESULT: (out.length > 10000 && stats.schemaErrors === 0) ? 'PASS' : (stats.schemaErrors > 0 ? 'SCHEMA-FAIL' : 'EMPTY'),
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[canonical-roads] features=' + out.length + (tranAvailable ? (' (polygon ' + stats.polygonCanonicalCount + ' / ribbon ' + stats.ribbonFallbackCount + ')') : ' (all ribbon fallback。PLATEAU tran 未取得)'));
  console.log('  width resolution: width-tag ' + stats.widthTagCount + ' / lanes ' + stats.lanesCount + ' / class-default ' + stats.defaultWidthCount);
  console.log('  byLodClass: ' + JSON.stringify(stats.byLodClass));
  console.log('  bridge ' + stats.bridge + ' / tunnel ' + stats.tunnel + ' / underground ' + stats.underground);
  console.log('  rejected: ' + JSON.stringify(stats.rejected));
  console.log('  confidence mean=' + report.confidence.mean + '  schemaErrors=' + stats.schemaErrors + '  tiles=' + tiles.length);
  console.log('  intersection QA: ' + JSON.stringify(intersectionQa));
  console.log('保存: ' + toProjectRelativePath(OUT_DIR) + ' / reports / preview  RESULT: ' + report.RESULT);
  if (report.RESULT !== 'PASS') process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[canonical-roads] 失敗:', e && e.stack || e); process.exit(1); });
