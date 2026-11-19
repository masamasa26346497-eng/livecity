'use strict';
// Mission 144: pure helpers shared by the water-surface tool, the acceptance E2E and the tests. No I/O, no network.
// Projection constants are the SAME as geoToThree() / 37G PROJ (znorth-neg-v1: x east, z south-positive, metres). Never changed here.
const PROJ = { clat: 34.604208, clon: 135.52502, mpd: 111320 };
const COS = Math.cos(PROJ.clat * Math.PI / 180);
const toLon = (x) => PROJ.clon + x / (COS * PROJ.mpd);
const toLat = (z) => PROJ.clat - z / PROJ.mpd;
const toLocal = (lon, lat) => ({ x: (lon - PROJ.clon) * COS * PROJ.mpd, z: -((lat - PROJ.clat) * PROJ.mpd) });

/** Metres between two lon/lat points (equirectangular at the local latitude; fine below ~10 km). */
function lonLatDiffM(a, b) {
  const dx = (a.lon - b.lon) * COS * PROJ.mpd, dz = (a.lat - b.lat) * PROJ.mpd;
  return Math.hypot(dx, dz);
}

/** Per-ward data classification. counts[file] = { parsed, features, lines, areas }. Rendering is NEVER claimed here. */
function classifyWard(counts) {
  counts = counts || {};
  const feat = (f) => (counts[f] && counts[f].parsed ? counts[f].features : 0);
  const w = counts.waterways || {};
  const waterLines = w.parsed ? (w.lines || 0) : 0, waterAreas = w.parsed ? (w.areas || 0) : 0;
  const surface = feat('water-surface');
  return {
    roads: feat('roads') > 0 ? 'roads ready' : 'roads absent',
    waterways: feat('waterways') > 0 ? 'waterways ready' : 'waterways absent',
    waterLines, waterAreas,
    // "water-surface" = separate sea/bay triangle file. Water POLYGONS inside waterways.json (kind:'area') are reported on their own.
    waterSurface: surface > 0 ? 'water-surface ready' : 'water-surface absent',
    waterPolygons: waterAreas > 0 ? 'water polygons in waterways.json: ' + waterAreas : 'no water polygons in waterways.json',
    browser: 'browser rendered unverified',
  };
}
const classLine = (c) => [c.roads, c.waterways, c.waterSurface, c.browser].join(' / ');

/** Distance (m) from point to a polyline in local metres. */
function pointToPolylineM(px, pz, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
    let t = L ? ((px - ax) * dx + (pz - az) * dz) / L : 0; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), pz - (az + t * dz)));
  }
  return best;
}
/**
 * Building representative points vs road centrelines. A consistent frame has few building points ON a road (carriageway half width ~ <2 m for
 * 'local' tier); a shifted frame puts many there. Reports a ratio, never a verdict about one building. Samples to keep it cheap.
 * roads: [{p:[[x,z]...]}], pts: [[x,z]...]
 */
function roadBuildingOverlap(roads, pts, opt) {
  opt = opt || {}; const lim = opt.onRoadM == null ? 1.5 : opt.onRoadM, maxPts = opt.maxPts || 3000;
  const step = Math.max(1, Math.floor(pts.length / maxPts)), lines = roads.filter((r) => r.p && r.p.length > 1);
  let n = 0, on = 0;
  for (let i = 0; i < pts.length; i += step) {
    const [x, z] = pts[i]; let hit = false;
    for (const r of lines) {
      if (!r.bb) { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const q of r.p) { if (q[0] < a) a = q[0]; if (q[0] > b) b = q[0]; if (q[1] < c) c = q[1]; if (q[1] > d) d = q[1]; } r.bb = [a, b, c, d]; }
      if (x < r.bb[0] - lim || x > r.bb[1] + lim || z < r.bb[2] - lim || z > r.bb[3] + lim) continue;   // cheap reject by polyline bbox
      if (pointToPolylineM(x, z, r.p) <= lim) { hit = true; break; }
    }
    n++; if (hit) on++;
  }
  return { sampled: n, onRoad: on, onRoadRatio: n ? +(on / n).toFixed(4) : null, thresholdM: lim };
}

/** Evenly spaced deterministic sample of ward ids (always includes first and last). */
function sampleWards(ids, n) {
  if (!n || n >= ids.length) return ids.slice();
  const out = []; for (let i = 0; i < n; i++) out.push(ids[Math.round((i * (ids.length - 1)) / Math.max(1, n - 1))]);
  return [...new Set(out)];
}

/** Count line / area features of a parsed waterways-style file. */
function featureKinds(j) {
  let lines = 0, areas = 0; for (const f of (j && j.features) || []) { if (f.kind === 'area') areas++; else lines++; }
  return { features: lines + areas, lines, areas };
}

/**
 * Slice a CITYWIDE water-surface payload (tools/build-water-surface.js: flat [x,z] triangle positions) to one ward's clip box.
 * Keeps triangles whose three vertices all lie inside the box (nothing is clipped, bent or invented). Returns viewer 'area' features.
 */
function sliceWaterSurface(payload, box) {
  if (!payload || payload.emitted === false || !Array.isArray(payload.positions)) return { features: [], reason: 'source-not-emitted' };
  const P = payload.positions, feats = [];
  const inb = (x, z) => x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ;
  for (let i = 0; i + 5 < P.length; i += 6) {
    if (inb(P[i], P[i + 1]) && inb(P[i + 2], P[i + 3]) && inb(P[i + 4], P[i + 5])) {
      feats.push({ id: 'ws_' + feats.length, kind: 'area', name: null, p: [[P[i], P[i + 1]], [P[i + 2], P[i + 3]], [P[i + 4], P[i + 5]]] });
    }
  }
  return { features: feats, reason: feats.length ? 'ok' : 'no-triangles-in-ward-box' };
}

module.exports = { PROJ, toLon, toLat, toLocal, lonLatDiffM, classifyWard, classLine, pointToPolylineM, roadBuildingOverlap, sampleWards, featureKinds, sliceWaterSurface };
