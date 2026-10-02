#!/usr/bin/env node
// tools/audit/osaka-castle-source-scan.js
// [Mission 33E §2/§4] 大阪城の高精細モデルに使える「実データ」がリポジトリ内にあるかを調べる。
//   新規のネットワーク取得はしない。調べるのは次の 3 つ。
//   1) canonical V2N の建物: 天守閣に相当する棟（anchor 近傍 / 高さ一致）を特定し、実 footprint を取る
//   2) OSM PBF: 天守（way/34619038）、石垣（barrier=city_wall 等）、城域（historic=castle）の有無と形状
//   3) canonical water / parks: 内堀・外堀・城公園（既に描画済みのもの）
//   出力: data/reports/osaka-castle-source-scan.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const PBF = P('data', 'raw', 'osm', 'osaka-latest.osm.pbf');
const NEAR_BLD = P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'near', 'buildings');
const WATER = P('data', 'processed', 'osaka-city', 'canonical', 'water');
const OUT = P('data', 'reports', 'osaka-castle-source-scan.json');

export const PROJ = { lat0: 34.604208, lon0: 135.52502, mpd: 111320 };
export const toLocal = (lat, lon) => ({
  x: (lon - PROJ.lon0) * Math.cos(PROJ.lat0 * Math.PI / 180) * PROJ.mpd,
  z: -((lat - PROJ.lat0) * PROJ.mpd),
});
// landmarks.json（= canonical landmark registry）が持つ大阪城の anchor。ここでは名前をハードコードせず
//   registry から読む。スキャン範囲だけこの周辺に限定する。
export const SCAN_RADIUS_M = 700;
export const KEEP_MATCH = { radiusM: 40, minHeightM: 40 };   // 天守閣候補の条件（anchor 近傍 × 高層）

export function ringBbox(ring) {
  const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}
export function ringCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cz += (ring[j][1] + ring[i][1]) * f;
  }
  if (!a) return [ring[0][0], ring[0][1]];
  return [cx / (3 * a), cz / (3 * a)];
}

// 1) canonical V2N から anchor 周辺の建物を集める（tile は 500m 刻み）
export function scanCanonicalBuildings(anchor, radiusM = SCAN_RADIUS_M) {
  const out = [];
  const t0x = Math.floor((anchor.x - radiusM) / 500), t1x = Math.floor((anchor.x + radiusM) / 500);
  const t0z = Math.floor((anchor.z - radiusM) / 500), t1z = Math.floor((anchor.z + radiusM) / 500);
  const seen = new Set();
  for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
    const p = path.join(NEAR_BLD, `tile_${tx}_${tz}.json`);
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    for (const f of (j.features || [])) {
      if (!f.centroid || seen.has(f.canonicalId)) continue;
      const d = Math.hypot(f.centroid[0] - anchor.x, f.centroid[1] - anchor.z);
      if (d > radiusM) continue;
      seen.add(f.canonicalId);
      const ring = f.geometryType === 'Polygon' ? f.coordinates[0] : (f.coordinates[0] && f.coordinates[0][0]);
      const a = f.attributes || {};
      out.push({ canonicalId: f.canonicalId, distanceM: +d.toFixed(1), heightM: a.heightM ?? null,
        usageLabel: a.usageLabel || null, source: a.source || null, centroid: f.centroid,
        ring: ring || null, areaM2: ring ? +ringArea(ring).toFixed(0) : null,
        bbox: ring ? ringBbox(ring) : null });
    }
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out;
}

// 2) OSM PBF: 城に関係するタグを持つ way / node を anchor 周辺から集める
const CASTLE_TAGS = (t) => !!(t.historic === 'castle' || t.historic === 'castle_wall' || t.historic === 'fort'
  || t.barrier === 'city_wall' || t.man_made === 'embankment' || t.building === 'castle'
  || t.historic === 'ruins' || t.historic === 'city_gate' || t.barrier === 'wall');
const nameOf = (t) => (t && (t['name:ja'] || t.name)) || null;

export async function scanPbfCastle(anchor, pbfPath = PBF, radiusM = SCAN_RADIUS_M) {
  const ways = [];                  // {id, tags, refs}
  const nodes = [];                 // 城タグを持つ単独ノード
  const needed = new Set();
  const stat = { nodes: 0, ways: 0, castleWays: 0, castleNodes: 0 };
  const inRange = (lat, lon) => {
    const p = toLocal(lat, lon);
    return Math.hypot(p.x - anchor.x, p.z - anchor.z) <= radiusM;
  };

  // 1 パス目: 城タグの way を拾う（座標は 2 パス目）。ノードは即判定できる。
  for await (const it of pbfPrimitiveStream(pbfPath)) {
    if (it.type === 'node') {
      stat.nodes++;
      const t = it.tags || {};
      if ((CASTLE_TAGS(t) || (nameOf(t) || '').includes('大阪城')) && inRange(it.lat, it.lon)) {
        stat.castleNodes++;
        nodes.push({ id: it.id, name: nameOf(t), tags: t, ...toLocal(it.lat, it.lon) });
      }
    } else if (it.type === 'way') {
      stat.ways++;
      const t = it.tags || {};
      if (CASTLE_TAGS(t) || (nameOf(t) || '').includes('大阪城') || String(it.id) === '34619038') {
        ways.push({ id: it.id, name: nameOf(t), tags: t, refs: it.refs || [] });
        for (const r of (it.refs || [])) needed.add(r);
      }
    }
  }
  // 2 パス目: way の構成ノード座標
  const coord = new Map();
  if (needed.size) {
    for await (const it of pbfPrimitiveStream(pbfPath)) {
      if (it.type !== 'node') continue;
      if (needed.has(it.id)) coord.set(it.id, toLocal(it.lat, it.lon));
    }
  }
  const resolved = [];
  for (const w of ways) {
    const ring = w.refs.map((r) => coord.get(r)).filter(Boolean).map((p) => [p.x, p.z]);
    if (ring.length < 3) continue;
    const c = ringCentroid(ring);
    const d = Math.hypot(c[0] - anchor.x, c[1] - anchor.z);
    if (d > radiusM) continue;
    stat.castleWays++;
    const closed = w.refs.length > 2 && w.refs[0] === w.refs[w.refs.length - 1];
    resolved.push({ id: 'way/' + w.id, name: w.name, tags: w.tags, closed,
      vertices: ring.length, distanceM: +d.toFixed(1), centroid: [+c[0].toFixed(2), +c[1].toFixed(2)],
      areaM2: closed ? +ringArea(ring).toFixed(0) : null, bbox: ringBbox(ring),
      ring: ring.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]) });
  }
  resolved.sort((a, b) => a.distanceM - b.distanceM);
  return { stat, ways: resolved, nodes };
}

// 3) canonical water: 城の堀（既に water レイヤーで描画されているもの）
export function scanCastleMoats(anchor, radiusM = SCAN_RADIUS_M) {
  const out = [];
  if (!fs.existsSync(WATER)) return out;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const q = path.join(dir, e.name);
      if (e.isDirectory()) { walk(q); continue; }
      if (!/\.json$/.test(e.name)) continue;
      let j; try { j = JSON.parse(fs.readFileSync(q, 'utf-8')); } catch { continue; }
      for (const f of (j.features || [])) {
        const nm = (f.attributes && (f.attributes.name || f.attributes.nameJa)) || null;
        if (!nm) continue;
        const rings = f.geometryType === 'Polygon' ? [f.coordinates[0]] : (f.coordinates || []).map((p) => p[0]);
        for (const ring of rings) {
          if (!ring || ring.length < 3) continue;
          const c = ringCentroid(ring);
          const d = Math.hypot(c[0] - anchor.x, c[1] - anchor.z);
          if (d > radiusM) continue;
          out.push({ name: nm, distanceM: +d.toFixed(1), areaM2: +ringArea(ring).toFixed(0) });
          break;
        }
      }
    }
  };
  walk(WATER);
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out;
}

export async function run() {
  const reg = JSON.parse(fs.readFileSync(P('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'), 'utf-8'));
  const lm = (reg.landmarks || []).find((l) => l.id === 'osaka-castle');
  if (!lm) throw new Error('landmarks.json に osaka-castle が無い');
  const anchor = { x: lm.x, z: lm.z };

  const buildings = scanCanonicalBuildings(anchor);
  // 天守閣候補: anchor 近傍 × 高さ（他の棟はすべて 25m 未満）
  const keepCandidates = buildings.filter((b) => b.distanceM <= KEEP_MATCH.radiusM && (b.heightM || 0) >= KEEP_MATCH.minHeightM);
  const pbf = fs.existsSync(PBF) ? await scanPbfCastle(anchor) : { stat: null, ways: [], nodes: [], missing: true };
  const moats = scanCastleMoats(anchor);

  const doc = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '33E',
    anchor: { ...anchor, source: 'landmarks.json / osaka-castle（OSM ' + (lm.source && lm.source.osm) + '）',
      registryHeightM: lm.osmHeight, registryFootprintBbox: lm.footprintBbox, registryResolved: lm.resolved },
    canonicalBuildings: { within: buildings.length, radiusM: SCAN_RADIUS_M,
      nearest10: buildings.slice(0, 10).map((b) => ({ canonicalId: b.canonicalId, distanceM: b.distanceM, heightM: b.heightM, usageLabel: b.usageLabel, areaM2: b.areaM2 })),
      keepCandidates, tallOver20m: buildings.filter((b) => (b.heightM || 0) >= 20).length },
    osm: { pbfPresent: !fs.existsSync(PBF) ? false : true, stat: pbf.stat,
      castleWays: pbf.ways.length, ways: pbf.ways, nodes: pbf.nodes.map((n) => ({ id: n.id, name: n.name, tags: n.tags, x: +n.x.toFixed(2), z: +n.z.toFixed(2) })) },
    moats,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  return doc;
}

if (isMainModule(import.meta.url)) {
  run().then((d) => {
    console.log('[castle-scan] anchor', JSON.stringify(d.anchor));
    console.log('[castle-scan] 天守閣候補', JSON.stringify(d.canonicalBuildings.keepCandidates.map((b) => ({ id: b.canonicalId, d: b.distanceM, h: b.heightM, area: b.areaM2, bbox: b.bbox }))));
    console.log('[castle-scan] OSM 城 way', d.osm.castleWays, JSON.stringify(d.osm.ways.map((w) => ({ id: w.id, name: w.name, tags: w.tags, closed: w.closed, v: w.vertices, area: w.areaM2, d: w.distanceM }))).slice(0, 2000));
    console.log('[castle-scan] 堀', JSON.stringify(d.moats));
    console.log('[castle-scan] out', OUT);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
