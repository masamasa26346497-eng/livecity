#!/usr/bin/env node
// tools/audit/landmark-building-coverage.js
// [Mission 34C §14] landmarks registry にあるのに建物表現が無いものを洗い出す。
//   **registry の point から建物を作ることはしない**（§1/§6）。
//   「その場所に building geometry の source があるか」を調べるだけ。
//   出力: data/reports/landmark-building-coverage.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  landmarks: P('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'),
  v2Dir: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  recoveredIdx: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v3-recovered', 'recovered-index.json'),
  out: P('data', 'reports', 'landmark-building-coverage.json'),
};
const TILE = 500;
// landmark の位置は「代表点」なので、建物の中心と多少ずれる。半径 60m 以内に
//   建物があれば「表現あり」とみなす（registry の点から形を作るわけではない）。
export const NEAR_M = 60;
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function loadTilesAround(dir, x, z) {
  const out = [];
  for (let tx = Math.floor((x - TILE) / TILE); tx <= Math.floor((x + TILE) / TILE); tx++) {
    for (let tz = Math.floor((z - TILE) / TILE); tz <= Math.floor((z + TILE) / TILE); tz++) {
      const doc = rj(path.join(dir, `tile_${tx}_${tz}.json`));
      for (const ft of ((doc && doc.features) || [])) {
        const ring = ft.coordinates && ft.coordinates[0];
        if (!ring || ring.length < 3) continue;
        out.push({ id: ft.canonicalId, ring, centroid: ft.centroid, areaM2: ft.areaM2,
          source: ft.source && ft.source.geometrySource });
      }
    }
  }
  return out;
}

export function run() {
  const doc = rj(F.landmarks);
  if (!doc) throw new Error('landmarks.json が無い');
  const list = doc.landmarks || doc.features || [];
  const recovered = rj(F.recoveredIdx);
  const recoveredIds = new Set(((recovered && recovered.buildings) || []).map((b) => b.canonicalId));
  const rows = [];
  for (const l of list) {
    const x = l.x != null ? l.x : (l.localX != null ? l.localX : (l.position && l.position.x));
    const z = l.z != null ? l.z : (l.localZ != null ? l.localZ : (l.position && l.position.z));
    const name = l.name || l.title || l.landmarkId || l.id;
    if (!Number.isFinite(x) || !Number.isFinite(z)) { rows.push({ name, status: 'no-position' }); continue; }
    const near = loadTilesAround(F.v2Dir, x, z);
    let inside = null, nearest = null, nearestD = Infinity;
    for (const b of near) {
      if (!inside && pointInRing(x, z, b.ring)) inside = b;
      const c = b.centroid || [0, 0];
      const d = Math.hypot(c[0] - x, c[1] - z);
      if (d < nearestD) { nearestD = d; nearest = b; }
    }
    const hit = inside || (nearestD <= NEAR_M ? nearest : null);
    rows.push({ name, x: Math.round(x), z: Math.round(z),
      status: hit ? (inside ? 'inside-building' : 'near-building') : 'no-building',
      canonicalId: hit ? hit.id : null, source: hit ? hit.source : null,
      areaM2: hit ? Math.round(hit.areaM2 || 0) : null,
      nearestDistanceM: Number.isFinite(nearestD) ? +nearestD.toFixed(1) : null,
      recoveredBy34C: hit ? recoveredIds.has(hit.id) : false,
      buildingsWithin500m: near.length });
  }
  const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34C',
    nearM: NEAR_M, landmarks: rows.length, counts,
    unresolved: rows.filter((r) => r.status === 'no-building' || r.status === 'no-position'),
    recoveredByMission34C: rows.filter((r) => r.recoveredBy34C),
    rows };
  fs.mkdirSync(path.dirname(F.out), { recursive: true });
  fs.writeFileSync(F.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[landmark-cov]', JSON.stringify(o.counts), 'landmarks=' + o.landmarks);
  for (const r of o.unresolved.slice(0, 20)) console.log('  未解決:', r.name, r.status, 'nearest=' + r.nearestDistanceM + 'm');
  console.log('out', F.out);
}
