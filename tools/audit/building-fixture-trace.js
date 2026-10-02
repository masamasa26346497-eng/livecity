#!/usr/bin/env node
// tools/audit/building-fixture-trace.js
// [Mission 34C §2/§13] 「実在するのに画面に出ていない建物」を 1 棟ずつ追跡する。
//   OSM PBF → raw PLATEAU CityGML → canonical V2 → derived tile → placement → ward index
//   のどこで落ちたのかを特定する（§3 の A〜H 分類の材料）。
//   出力: data/reports/building-fixture-trace.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';
import { representativePoint } from '../lib/building-representative-point.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const F = {
  pbf: P('data', 'raw', 'osm', 'osaka-latest.osm.pbf'),
  canonDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  v2Dir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-corrected'),
  fallbackDir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osm-fallback'),
  derivedNear: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'near', 'buildings'),
  derivedMid: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'mid', 'buildings'),
  derivedFar: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'far', 'buildings'),
  placement: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement'),
  wardIndex: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-ward-index.json'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  candidates: P('data', 'processed', 'osaka-city', 'osm-fallback-v2', 'candidates.json'),
  plateauDir: P('data', 'raw', 'plateau'),
  out: P('data', 'reports', 'building-fixture-trace.json'),
};
const TILE = 500;

// §2/§13 追跡する建物。name は OSM / PLATEAU の表記ゆれを拾えるよう複数パターン。
export const FIXTURES = [
  { id: 'brillia-tower-dojima', label: 'ブリリアタワー堂島', patterns: [/ブリリア.*堂島/, /Brillia.*Dojima/i] },
  { id: 'grand-green-osaka', label: 'グラングリーン大阪', patterns: [/グラングリーン/, /Grand\s*Green/i] },
  { id: 'osaka-station', label: '大阪駅周辺', patterns: [/大阪ステーションシティ/, /ノースゲート/, /JPタワー大阪/] },
  { id: 'nakanoshima', label: '中之島', patterns: [/中之島フェスティバルタワー/, /中之島三井ビルディング/] },
  { id: 'honmachi', label: '本町', patterns: [/本町ガーデンシティ/, /御堂筋ダイビル/] },
  { id: 'namba', label: '難波', patterns: [/なんばパークス/, /なんばスカイオ/, /なんばCITY/] },
  { id: 'tennoji', label: '天王寺', patterns: [/あべのハルカス/, /あべのキューズモール/] },
  { id: 'shin-osaka', label: '新大阪', patterns: [/新大阪駅/, /新大阪セントラルタワー/] },
];
// 名前で引っかからない場合に備えて、地点まわりの OSM 建物も見る（§13）
export const FIXTURE_ANCHORS = [
  { id: 'brillia-tower-dojima', lat: 34.69466, lon: 135.49236, radiusM: 260 },
];

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const r2 = (v) => Math.round(v * 100) / 100;
export function ringBbox(ring) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of ring) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
  return { minX: x0, maxX: x1, minZ: z0, maxZ: z1 };
}
export function ringArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) { const a = ring[i], b = ring[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
export function ringCentroid(ring) {
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return [x / ring.length, z / ring.length];
}
export function bboxOverlapRatio(a, b) {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const areaA = (a.maxX - a.minX) * (a.maxZ - a.minZ);
  const areaB = (b.maxX - b.minX) * (b.maxZ - b.minZ);
  return inter / Math.min(areaA || 1, areaB || 1);
}
export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

// ── OSM: 名前 / 位置で fixture を探す ───────────────────────────────────────
async function scanOsm() {
  const pats = FIXTURES.flatMap((f) => f.patterns.map((p) => ({ fixture: f.id, label: f.label, p })));
  const hitWays = new Map();      // wayId → {tags, refs, matched:[]}
  const hitNodes = [];            // name 付き node（POI。geometry には使わない §6）
  const anchorWays = new Map();   // 位置で拾う候補（refs だけ先に保持）
  const anchorNeed = new Set();
  // pass 1: way の tags を見る。位置で拾う候補は refs を全部持つとメモリを食うので
  //   「建物 way の refs」を一旦全部持たず、まず name 一致だけ確定させる。
  for await (const p of pbfPrimitiveStream(F.pbf)) {
    const t = p.tags || {};
    const nm = t.name || t['name:ja'] || t['name:en'] || '';
    if (p.type === 'way') {
      if (!t.building && !t['building:part'] && !nm) continue;
      if (nm) {
        const matched = pats.filter((q) => q.p.test(nm));
        if (matched.length) hitWays.set(p.id, { tags: t, refs: p.refs, matched: [...new Set(matched.map((m) => m.fixture))] });
      }
      if (t.building) anchorWays.set(p.id, p.refs);
    } else if (p.type === 'node' && nm) {
      const matched = pats.filter((q) => q.p.test(nm));
      if (matched.length && Number.isFinite(p.lat)) {
        hitNodes.push({ nodeId: p.id, name: nm, lat: p.lat, lon: p.lon, tags: t, matched: [...new Set(matched.map((m) => m.fixture))] });
      }
    }
  }
  // 名前一致 way の座標を解決
  const need = new Set();
  for (const v of hitWays.values()) for (const r of v.refs) need.add(r);
  // anchor 周辺は「最初の ref だけ」でおおまかに絞る（全建物の全 ref を持つとメモリが厳しい）
  for (const [wid, refs] of anchorWays) if (refs && refs.length) { anchorNeed.add(refs[0]); }
  const coord = new Map(), anchorFirst = new Map();
  for await (const p of pbfPrimitiveStream(F.pbf)) {
    if (p.type !== 'node') continue;
    if (need.has(p.id) && Number.isFinite(p.lat)) coord.set(p.id, [p.lat, p.lon]);
    if (anchorNeed.has(p.id) && Number.isFinite(p.lat)) anchorFirst.set(p.id, [p.lat, p.lon]);
  }
  // anchor 半径内の建物 way を確定し、その refs の座標だけ追加で引く
  const nearAnchor = new Map();
  for (const a of FIXTURE_ANCHORS) {
    const aw = latLonToLiveCityWorld(a.lat, a.lon);
    for (const [wid, refs] of anchorWays) {
      if (!refs || !refs.length) continue;
      const ll = anchorFirst.get(refs[0]);
      if (!ll) continue;
      const w = latLonToLiveCityWorld(ll[0], ll[1]);
      if (Math.hypot(w.x - aw.x, w.z - aw.z) > a.radiusM) continue;
      nearAnchor.set(wid, { refs, fixture: a.id });
    }
  }
  const need2 = new Set();
  for (const v of nearAnchor.values()) for (const r of v.refs) if (!coord.has(r)) need2.add(r);
  if (need2.size) {
    for await (const p of pbfPrimitiveStream(F.pbf)) {
      if (p.type !== 'node' || !need2.has(p.id)) continue;
      if (Number.isFinite(p.lat)) coord.set(p.id, [p.lat, p.lon]);
    }
  }
  // tags をもう一度引く（nearAnchor は refs しか持っていない）
  const nearTags = new Map();
  if (nearAnchor.size) {
    for await (const p of pbfPrimitiveStream(F.pbf)) {
      if (p.type !== 'way' || !nearAnchor.has(p.id)) continue;
      nearTags.set(p.id, p.tags || {});
    }
  }
  const toRing = (refs) => {
    const ring = [];
    for (const r of refs) { const ll = coord.get(r); if (ll) { const w = latLonToLiveCityWorld(ll[0], ll[1]); ring.push([r2(w.x), r2(w.z)]); } }
    if (ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    return ring;
  };
  const named = [];
  for (const [wid, v] of hitWays) {
    const ring = toRing(v.refs);
    if (ring.length < 3) { named.push({ wayId: wid, name: v.tags.name, matched: v.matched, tags: v.tags, ring: null, note: 'refs の座標が解決できない（multipolygon の outer が別 way 等）' }); continue; }
    named.push({ wayId: wid, name: v.tags.name, matched: v.matched, tags: v.tags, ring,
      centroid: ringCentroid(ring).map(r2), bbox: ringBbox(ring), areaM2: Math.round(ringArea(ring)) });
  }
  const anchors = [];
  for (const [wid, v] of nearAnchor) {
    const ring = toRing(v.refs);
    if (ring.length < 3) continue;
    const tags = nearTags.get(wid) || {};
    anchors.push({ wayId: wid, fixture: v.fixture, name: tags.name || null, tags,
      centroid: ringCentroid(ring).map(r2), bbox: ringBbox(ring), areaM2: Math.round(ringArea(ring)), ring });
  }
  return { named, nodes: hitNodes, anchors };
}

// ── canonical / derived / placement を引く ────────────────────────────────
function tileKeyFor(x, z) { return Math.floor(x / TILE) + '_' + Math.floor(z / TILE); }
function loadCanonicalNear(x, z, reach = TILE) {
  const out = [];
  const t0x = Math.floor((x - reach) / TILE), t1x = Math.floor((x + reach) / TILE);
  const t0z = Math.floor((z - reach) / TILE), t1z = Math.floor((z + reach) / TILE);
  for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
    const doc = rj(path.join(F.canonDir, `tile_${tx}_${tz}.json`));
    if (!doc) continue;
    for (const ft of (doc.features || [])) {
      const ring = ft.coordinates && ft.coordinates[0];
      if (!ring || ring.length < 3) continue;
      const bb = ringBbox(ring);
      if (bb.maxX < x - reach || bb.minX > x + reach || bb.maxZ < z - reach || bb.minZ > z + reach) continue;
      out.push({ canonicalId: ft.canonicalId, ring, bbox: bb, areaM2: ft.areaM2,
        source: ft.source && ft.source.geometrySource, sourceId: ft.source && ft.source.sourceId,
        tile: `${tx}_${tz}` });
    }
  }
  return out;
}
function loadDerivedNear(dir, x, z, reach = TILE) {
  const out = [];
  const t0x = Math.floor((x - reach) / TILE), t1x = Math.floor((x + reach) / TILE);
  const t0z = Math.floor((z - reach) / TILE), t1z = Math.floor((z + reach) / TILE);
  for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
    const doc = rj(path.join(dir, `tile_${tx}_${tz}.json`));
    if (!doc) continue;
    for (const ft of (doc.features || [])) {
      const ring = ft.coordinates && (ft.geometryType === 'Polygon' ? ft.coordinates[0] : (ft.coordinates[0] && ft.coordinates[0][0]));
      if (!ring || ring.length < 3) continue;
      const bb = ringBbox(ring);
      if (bb.maxX < x - reach || bb.minX > x + reach || bb.maxZ < z - reach || bb.minZ > z + reach) continue;
      out.push({ canonicalId: ft.canonicalId, bbox: bb, ring, tile: `${tx}_${tz}`,
        heightM: ft.attributes && ft.attributes.heightM, wardId: ft.attributes && ft.attributes.wardId });
    }
  }
  return out;
}
function placementFor(ids, x, z) {
  const res = {};
  const seen = new Set();
  for (let tx = Math.floor((x - TILE) / TILE); tx <= Math.floor((x + TILE) / TILE); tx++) {
    for (let tz = Math.floor((z - TILE) / TILE); tz <= Math.floor((z + TILE) / TILE); tz++) {
      const doc = rj(path.join(F.placement, `tile_${tx}_${tz}.json`));
      if (!doc) continue;
      // placement タイルは { policies: { canonicalId: {policy, reason, …} } }。
      //   収録されているのは非 DISPLAY のものだけ（DISPLAY が既定）。
      for (const [cid, e] of Object.entries(doc.policies || {})) {
        if (!ids.has(cid)) continue;
        res[cid] = { policy: e.policy, reason: e.reason, waterOverlapRatio: e.waterOverlapRatio, roadOverlapRatio: e.roadOverlapRatio };
        seen.add(cid);
      }
    }
  }
  for (const id of ids) if (!seen.has(id)) res[id] = { policy: 'DISPLAY', reason: 'not-listed(=DISPLAY 既定)' };
  return res;
}

// PBF の走査は 4 パス × 数分かかるので結果を置いておく（--rescan で取り直す）
const OSM_CACHE = P('data', 'processed', 'osaka-city', 'osm-fallback-v2', 'fixture-osm-scan.json');
export async function run() {
  const t0 = Date.now();
  let osm = null;
  if (!process.argv.includes('--rescan')) osm = rj(OSM_CACHE);
  if (osm) console.log('[fixture-trace] OSM 走査結果を再利用', OSM_CACHE);
  else {
    console.log('[fixture-trace] OSM PBF 走査…');
    osm = await scanOsm();
    fs.mkdirSync(path.dirname(OSM_CACHE), { recursive: true });
    fs.writeFileSync(OSM_CACHE, JSON.stringify(osm));
  }
  console.log('[fixture-trace] OSM 名前一致', osm.named.length, '/ node', osm.nodes.length, '/ anchor 近傍', osm.anchors.length);

  const wards = (rj(F.wardPolys) || {}).wards || [];
  const wardIndex = rj(F.wardIndex) || {};
  const cand = rj(F.candidates);
  const candByWay = new Map();
  if (cand) for (const c of cand.candidates || []) candByWay.set(c.wayId, c);

  const traces = [];
  const targets = [...osm.named.filter((n) => n.ring), ...osm.anchors];
  for (const t of targets) {
    const [cx, cz] = t.centroid;
    const canon = loadCanonicalNear(cx, cz, 220);
    // 同じ建物か: bbox の重なり率 + 重心が相手の footprint の中
    const matches = canon.map((c) => ({ c, ov: bboxOverlapRatio(t.bbox, c.bbox), inside: pointInRing(cx, cz, c.ring) }))
      .filter((m) => m.ov > 0.25 || m.inside)
      .sort((a, b) => (b.ov + (b.inside ? 1 : 0)) - (a.ov + (a.inside ? 1 : 0)));
    const best = matches[0] || null;
    const ids = new Set(matches.slice(0, 5).map((m) => m.c.canonicalId));
    const near = { near: loadDerivedNear(F.derivedNear, cx, cz, 220), mid: loadDerivedNear(F.derivedMid, cx, cz, 220), far: loadDerivedNear(F.derivedFar, cx, cz, 220) };
    const inDerived = {};
    for (const [band, arr] of Object.entries(near)) {
      inDerived[band] = best ? arr.some((d) => d.canonicalId === best.c.canonicalId) : false;
    }
    const rp = representativePoint(t.ring);
    const wr = rp.valid ? classifyPointToWard(rp.x, rp.z, wards) : { wardId: null, status: 'no-representative-point' };
    const tk = tileKeyFor(cx, cz);
    const wi = wr.wardId && wardIndex.wards ? wardIndex.wards[wr.wardId] : null;
    traces.push({
      fixture: t.fixture || (t.matched && t.matched[0]) || null,
      osm: { wayId: t.wayId, name: t.name, tags: t.tags, centroid: t.centroid, areaM2: t.areaM2, bbox: t.bbox },
      osmFallbackCandidate: candByWay.has(t.wayId)
        ? { area: candByWay.get(t.wayId).area, gapReason: candByWay.get(t.wayId).gapReason, cls: candByWay.get(t.wayId).cls, rule: candByWay.get(t.wayId).rule }
        : null,
      ward: { wardId: wr.wardId, status: wr.status },
      canonicalNearby: canon.length,
      canonicalMatch: best ? { canonicalId: best.c.canonicalId, source: best.c.source, sourceId: best.c.sourceId,
        areaM2: best.c.areaM2, bboxOverlap: +best.ov.toFixed(3), centroidInside: best.inside, tile: best.c.tile } : null,
      canonicalMatchCount: matches.length,
      derived: inDerived,
      placement: best ? placementFor(new Set([best.c.canonicalId]), cx, cz)[best.c.canonicalId] : null,
      tileKey: tk,
      wardIndexHasTile: wi ? (wi.tiles || []).includes(tk) : null,
    });
  }

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34C',
    osmNamedHits: osm.named.map((n) => ({ wayId: n.wayId, name: n.name, matched: n.matched, areaM2: n.areaM2 || null, hasRing: !!n.ring, note: n.note || null })),
    osmNamedNodes: osm.nodes.map((n) => ({ nodeId: n.nodeId, name: n.name, lat: n.lat, lon: n.lon, matched: n.matched })),
    anchorBuildings: osm.anchors.length,
    traces, elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(F.out), { recursive: true });
  fs.writeFileSync(F.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => {
    for (const t of o.traces) {
      console.log([t.fixture, t.osm.name || '(no name)', 'way=' + t.osm.wayId, 'ward=' + t.ward.wardId,
        'canonical=' + (t.canonicalMatch ? t.canonicalMatch.canonicalId + '/' + t.canonicalMatch.source : 'NONE'),
        'derived=' + JSON.stringify(t.derived), 'placement=' + (t.placement ? t.placement.policy : '-')].join(' | '));
    }
    console.log('[fixture-trace] out', F.out);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
