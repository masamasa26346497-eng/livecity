#!/usr/bin/env node
'use strict';
// Mission 46D: independent accuracy check of Live City footprints / roads against GSI vector tiles (optimal_bvmap-v1: BldA, RdEdg).
//   node tools/mission46d-independent-accuracy.cjs --src <legacy osaka-city dir> --ref-dir <dir with <wardId>/<z>_<x>_<y>.pbf> [--wards a,b] [--out report.json]
// READ-ONLY. No network (reference tiles must already be on disk). Never writes inside --src / --ref-dir. Output is aggregate numbers only.
// Status per ward: PASS | FAIL | INSUFFICIENT_DATA. Missing reference data is INSUFFICIENT_DATA, never PASS.
// A road CENTERLINE is never compared to an edge as if they should coincide: the test is that centerline samples lie inside the corridor
// bounded by the GSI road edges (distance to the nearest edge within a band), and that they are not ON an edge.
const fs = require('fs');
const path = require('path');
const M = require('./lib/mission46d-mvt.cjs');
const ROOT = path.resolve(__dirname, '..');

const SCHEMA = 'livecity.mission46d.independent-accuracy/1';
const DEFAULT_THRESHOLDS = {
  minBuildingsEvaluated: 30, minRoadSamples: 100,
  buildingMatchedPctMin: 80, buildingMedianVertexM: 3, buildingP95VertexM: 10,
  roadBandM: 30, roadBracketedPctMin: 60, minBracketedSamples: 50, minRingAreaM2: 1, sharedLineageMedianM: 0.5, sharedLineageP95M: 1.5, sharedLineageMinN: 500
};
const LIMITS = [
  'GSI optimal_bvmap BldA/RdEdg are generalised cartographic data (zoom-limited), not survey-grade; small residuals are expected.',
  'Only locations covered by supplied reference tiles are evaluated; coverage is reported and low coverage yields INSUFFICIENT_DATA.',
  'Road centerlines are not expected to coincide with road edges. A sample counts as inside a road corridor only if a GSI edge exists within the band on BOTH sides of the centerline (bracketed); one-sided proximity is reference-only and never yields PASS.',
  'GSI and Live City (PLATEAU/OSM) differ in survey date and in outline definition (roof vs footprint, generalisation); results are not a claim of accuracy better than the GSI nominal.',
  'Near-identical geometry (centimetre-level vertex distance over many vertices) is flagged suspectedSharedLineage and is INSUFFICIENT_DATA, never PASS: agreement with a source the data was built from proves nothing.',
  'Malformed MVT rings (too few points, non-finite, near-zero area) are excluded; interior rings are treated as holes, not buildings.',
  'Offsets are reported, never applied.'
];
const pct = (n, d) => (d ? Math.round((n / d) * 10000) / 100 : null);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const quant = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return r2(s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]); };

// ---- geometry ----
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function distPointSeg(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz));
}
function ringArea(r) { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return s / 2; }
function centroid(r) {
  const a = ringArea(r); if (Math.abs(a) < 1e-9) { const n = r.length; return [r.reduce((s, p) => s + p[0], 0) / n, r.reduce((s, p) => s + p[1], 0) / n]; }
  let cx = 0, cz = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]; cx += (r[j][0] + r[i][0]) * f; cz += (r[j][1] + r[i][1]) * f; }
  return [cx / (6 * a), cz / (6 * a)];
}
// spatial hash of segments
class SegIndex {
  constructor(cell = 50) { this.cell = cell; this.m = new Map(); this.n = 0; }
  addSeg(a, b) {
    const c = this.cell; const x0 = Math.floor(Math.min(a[0], b[0]) / c), x1 = Math.floor(Math.max(a[0], b[0]) / c), z0 = Math.floor(Math.min(a[1], b[1]) / c), z1 = Math.floor(Math.max(a[1], b[1]) / c);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = x + ',' + z; let l = this.m.get(k); if (!l) this.m.set(k, (l = [])); l.push([a, b]); }
    this.n++;
  }
  addLine(pts) { for (let i = 1; i < pts.length; i++) this.addSeg(pts[i - 1], pts[i]); }
  nearest(x, z, maxR) { // distance to nearest segment within maxR (Infinity if none)
    const c = this.cell, R = Math.ceil(maxR / c); const cx = Math.floor(x / c), cz = Math.floor(z / c); let best = Infinity;
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) { const l = this.m.get((cx + dx) + ',' + (cz + dz)); if (l) for (const [a, b] of l) { const d = distPointSeg(x, z, a, b); if (d < best) best = d; } }
    return best <= maxR ? best : Infinity;
  }
}
// nearest edge on each side of a directed centerline sample (d = unit direction); side = sign of cross(d, closest - p)
SegIndex.prototype.nearestBothSides = function (x, z, dx, dz, maxR) {
  const c = this.cell, R = Math.ceil(maxR / c), cx = Math.floor(x / c), cz = Math.floor(z / c); let left = Infinity, right = Infinity;
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) { const l = this.m.get((cx + i) + ',' + (cz + j)); if (!l) continue;
    for (const [a, b] of l) {
      const ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez; let t = l2 ? ((x - a[0]) * ex + (z - a[1]) * ez) / l2 : 0; t = Math.max(0, Math.min(1, t));
      const qx = a[0] + t * ex - x, qz = a[1] + t * ez - z, dist = Math.hypot(qx, qz); if (dist > maxR) continue;
      const cr = dx * qz - dz * qx; if (cr > 0) { if (dist < left) left = dist; } else if (dist < right) right = dist;
    } }
  return { left, right };
};
class PolyIndex {
  constructor(cell = 100) { this.cell = cell; this.m = new Map(); this.n = 0; }
  add(poly) {
    const c = this.cell; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const e = { poly, x0, x1, z0, z1 };
    for (let x = Math.floor(x0 / c); x <= Math.floor(x1 / c); x++) for (let z = Math.floor(z0 / c); z <= Math.floor(z1 / c); z++) { const k = x + ',' + z; let l = this.m.get(k); if (!l) this.m.set(k, (l = [])); l.push(e); }
    this.n++;
  }
  containing(x, z) { const l = this.m.get(Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell)); if (l) for (const e of l) if (x >= e.x0 && x <= e.x1 && z >= e.z0 && z <= e.z1 && pointInRing(x, z, e.poly) && !(e.poly.holes || []).some((h) => pointInRing(x, z, h))) return e.poly; return null; }
}

// ---- reference tiles -> local geometry ----
function parseTileName(f) { const m = /^(\d+)[_\-](\d+)[_\-](\d+)\.(?:pbf|mvt)$/.exec(f); return m ? { z: +m[1], x: +m[2], y: +m[3] } : null; }
function loadReference(dir) { // dir: *.pbf files named z_x_y.pbf
  const ref = { buildings: [], roadEdges: [], tileBounds: [], tiles: 0, errors: 0 };
  if (!dir || !fs.existsSync(dir)) return ref;
  for (const f of fs.readdirSync(dir)) {
    const t = parseTileName(f); if (!t) continue;
    try {
      const layers = M.decodeMvt(fs.readFileSync(path.join(dir, f)));
      if (layers.BldA) for (const ft of M.layerToLocal(layers.BldA, t.z, t.x, t.y)) if (ft.type === 3) addPolygonFeature(ref, ft.rings);
      if (layers.RdEdg) for (const ft of M.layerToLocal(layers.RdEdg, t.z, t.x, t.y)) for (const r of ft.rings) if (r.length >= 2) ref.roadEdges.push(r);
      const a = M.tilePointToLonLat(t.z, t.x, t.y, 1, 0, 0), b = M.tilePointToLonLat(t.z, t.x, t.y, 1, 1, 1);
      const p = M.lonLatToLocal(a.lon, a.lat), q = M.lonLatToLocal(b.lon, b.lat);
      ref.tileBounds.push({ x0: Math.min(p.x, q.x), x1: Math.max(p.x, q.x), z0: Math.min(p.z, q.z), z1: Math.max(p.z, q.z) });
      ref.tiles++;
    } catch (e) { ref.errors++; }
  }
  return ref;
}
const validRing = (r) => Array.isArray(r) && r.length >= 3 && r.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) && Math.abs(ringArea(r)) >= DEFAULT_THRESHOLDS.minRingAreaM2;
// MVT: first ring is exterior; later rings with the same winding are further exteriors, opposite winding are holes of the latest exterior.
function addPolygonFeature(ref, rings) {
  let cur = null, sign = 0;
  for (const r of rings) {
    if (!validRing(r)) { ref.invalidRings = (ref.invalidRings || 0) + 1; continue; }
    const sg = Math.sign(ringArea(r));
    if (!sign) sign = sg;
    if (sg === sign || !cur) { cur = r.slice(); cur.holes = []; ref.buildings.push(cur); } else cur.holes.push(r);
  }
}
const inTiles = (tb, x, z) => tb.some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1);

// ---- metrics (pure; unit-tested) ----
function buildingAccuracy(lcFootprints, ref) {
  const idx = new PolyIndex(), edges = new SegIndex();
  for (const p of ref.buildings) { idx.add(p); edges.addLine(p.concat([p[0]])); for (const h of p.holes || []) edges.addLine(h.concat([h[0]])); }
  let total = 0, evaluable = 0, matched = 0; const vd = [], co = []; let sdx = 0, sdz = 0;
  for (const fp of lcFootprints) {
    if (!fp || fp.length < 3) continue; total++;
    const c = centroid(fp); if (!ref.tileBounds.length || !inTiles(ref.tileBounds, c[0], c[1])) continue; evaluable++;
    const hit = idx.containing(c[0], c[1]); if (!hit) continue; matched++;
    const rc = centroid(hit); co.push(Math.hypot(rc[0] - c[0], rc[1] - c[1])); sdx += rc[0] - c[0]; sdz += rc[1] - c[1];
    for (const [x, z] of fp) { const d = edges.nearest(x, z, 50); if (d !== Infinity) vd.push(d); }
  }
  return { lcBuildings: total, evaluated: evaluable, coveragePct: pct(evaluable, total), matched, matchedPct: pct(matched, evaluable), refBuildings: ref.buildings.length, invalidRefRingsExcluded: ref.invalidRings || 0,
    vertexDistM: { median: quant(vd, 0.5), p95: quant(vd, 0.95), n: vd.length }, centroidOffsetM: { median: quant(co, 0.5), p95: quant(co, 0.95) },
    suspectedSharedLineage: vd.length >= DEFAULT_THRESHOLDS.sharedLineageMinN && quant(vd, 0.5) <= DEFAULT_THRESHOLDS.sharedLineageMedianM && quant(vd, 0.95) <= DEFAULT_THRESHOLDS.sharedLineageP95M,
    meanOffsetRefMinusLcM: matched ? { dx: r2(sdx / matched), dz: r2(sdz / matched), applied: false } : null };
}
function roadAccuracy(lcLines, ref, bandM, stepM = 10) {
  const edges = new SegIndex(); for (const l of ref.roadEdges) edges.addLine(l);
  let n = 0, bracketed = 0, oneSided = 0, none = 0, notEvaluable = 0; const hw = [];
  for (const line of lcLines) for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!(len > 0)) continue;
    const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len, k = Math.max(1, Math.ceil(len / stepM));
    for (let s = 0; s <= k; s++) {
      const t = s / k, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      if (!ref.tileBounds.length || !inTiles(ref.tileBounds, x, z)) { notEvaluable++; continue; }
      n++; const { left, right } = edges.nearestBothSides(x, z, dx, dz, bandM);
      if (left !== Infinity && right !== Infinity) { bracketed++; hw.push(left + right); } else if (left !== Infinity || right !== Infinity) oneSided++; else none++;
    }
  }
  return { samples: n, samplesOutsideRefCoverage: notEvaluable, bracketedSamples: bracketed, bracketedPct: pct(bracketed, n), oneSidedOnlyPct: pct(oneSided, n), noEdgeInBandPct: pct(none, n),
    bandM, edgeToEdgeWidthM: { median: quant(hw, 0.5), p95: quant(hw, 0.95) }, refEdgeLines: ref.roadEdges.length };
}
function classify(b, r, T = DEFAULT_THRESHOLDS) {
  const reasons = []; let insufficient = false, failed = false;
  if (!b || b.evaluated < T.minBuildingsEvaluated || b.refBuildings === 0) { insufficient = true; reasons.push('buildings: insufficient reference coverage'); }
  else if (b.suspectedSharedLineage) { insufficient = true; reasons.push('buildings: vertices coincide with GSI to centimetres (median ' + b.vertexDistM.median + ' m, p95 ' + b.vertexDistM.p95 + ' m) - Live City footprints are probably derived from the same GSI/Kiban lineage, so this is NOT an independent check'); }
  else {
    if (b.matchedPct < T.buildingMatchedPctMin) { failed = true; reasons.push('buildings: matchedPct ' + b.matchedPct + ' < ' + T.buildingMatchedPctMin); }
    if (b.vertexDistM.median == null || b.vertexDistM.median > T.buildingMedianVertexM) { failed = true; reasons.push('buildings: median vertex distance ' + b.vertexDistM.median + ' > ' + T.buildingMedianVertexM); }
    if (b.vertexDistM.p95 == null || b.vertexDistM.p95 > T.buildingP95VertexM) { failed = true; reasons.push('buildings: p95 vertex distance ' + b.vertexDistM.p95 + ' > ' + T.buildingP95VertexM); }
  }
  if (!r || r.samples < T.minRoadSamples || r.refEdgeLines === 0) { insufficient = true; reasons.push('roads: insufficient reference coverage'); }
  else if (r.bracketedSamples < T.minBracketedSamples) { insufficient = true; reasons.push('roads: too few two-sided (bracketed) samples; one-sided proximity is not evidence'); }
  else if (r.bracketedPct < T.roadBracketedPctMin) { failed = true; reasons.push('roads: bracketedPct ' + r.bracketedPct + ' < ' + T.roadBracketedPctMin); }
  return { status: failed ? 'FAIL' : insufficient ? 'INSUFFICIENT_DATA' : 'PASS', reasons };
}

// ---- Live City side loaders (read-only) ----
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function loadLcBuildings(src, wardId) {
  const d = path.join(src, 'buildings', 'osaka-' + wardId), out = [];
  if (!fs.existsSync(d)) return null;
  for (const f of fs.readdirSync(d)) if (/^tile_.*\.json$/.test(f)) for (const b of rj(path.join(d, f)).buildings || []) if (Array.isArray(b.fp)) out.push(b.fp);
  return out;
}
function loadLcRoads(src, bbox) {
  const d = path.join(src, 'roads'), out = [];
  if (!fs.existsSync(d)) return null;
  for (const f of fs.readdirSync(d)) if (/^tile_.*\.json$/.test(f)) for (const ft of rj(path.join(d, f)).features || []) {
    const p = ft.p; if (!Array.isArray(p) || p.length < 2) continue;
    if (p.some(([x, z]) => x >= bbox.minX && x <= bbox.maxX && z >= bbox.minZ && z <= bbox.maxZ)) out.push(p);
  }
  return out;
}

function runWard(w, src, refDir, T) {
  const base = { wardId: w.wardId, wardCode: w.wardCode, referenceTiles: 0 };
  const wardRef = refDir ? path.join(refDir, w.wardId) : null;
  const ref = loadReference(wardRef);
  const lcB = src ? loadLcBuildings(src, w.wardId) : null, lcR = src ? loadLcRoads(src, w.bbox) : null;
  const noRoadSource = !lcR || !lcR.length;
  if (!ref.tiles || !lcB) return { ...base, referenceTiles: ref.tiles, tileErrors: ref.errors, liveCitySources: { buildings: !!lcB, roads: !noRoadSource }, buildings: null, roads: null, status: 'INSUFFICIENT_DATA', reasons: [!ref.tiles ? 'no GSI reference tiles for ward' : 'no Live City building tiles for ward'] };
  const b = buildingAccuracy(lcB, ref), r = noRoadSource ? null : roadAccuracy(lcR, ref, T.roadBandM);
  const c = classify(b, r, T); if (noRoadSource) c.reasons.push('roads: no Live City road source available (roads/ is not tracked in Git)');
  return { ...base, referenceTiles: ref.tiles, tileErrors: ref.errors, liveCitySources: { buildings: true, roads: !noRoadSource }, buildings: b, roads: r, ...c };
}
function buildReport(wards, src, refDir, only, T = DEFAULT_THRESHOLDS) {
  const list = wards.filter((w) => !only || only.includes(w.wardId));
  const results = list.map((w) => runWard(w, src, refDir, T));
  const count = (s) => results.filter((x) => x.status === s).length;
  return { schema: SCHEMA, generatedBy: 'tools/mission46d-independent-accuracy.cjs', reference: 'GSI vector tile optimal_bvmap-v1 (BldA, RdEdg)', thresholds: T, limits: LIMITS,
    summary: { wards: results.length, expectedWards: 24, PASS: count('PASS'), FAIL: count('FAIL'), INSUFFICIENT_DATA: count('INSUFFICIENT_DATA'), allWardsPass: results.length === 24 && count('PASS') === 24 }, wards: results };
}
function main() {
  const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const src = get('--src'), refDir = get('--ref-dir'), out = get('--out'), only = get('--wards') ? get('--wards').split(',') : null;
  const wards = rj(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json')).wards;
  const rep = buildReport(wards, src ? path.resolve(src) : null, refDir ? path.resolve(refDir) : null, only);
  const s = JSON.stringify(rep, null, 2);
  if (out) fs.writeFileSync(path.resolve(out), s + '\n'); else process.stdout.write(s + '\n');
  console.error('PASS ' + rep.summary.PASS + ' FAIL ' + rep.summary.FAIL + ' INSUFFICIENT_DATA ' + rep.summary.INSUFFICIENT_DATA + ' / ' + rep.summary.wards);
  process.exit(rep.summary.FAIL ? 1 : 0);
}
module.exports = { addPolygonFeature, SCHEMA, DEFAULT_THRESHOLDS, pointInRing, distPointSeg, centroid, SegIndex, PolyIndex, loadReference, buildingAccuracy, roadAccuracy, classify, buildReport };
if (require.main === module) main();
