#!/usr/bin/env node
'use strict';
// Mission 46D-R3: independent check of the TRACKED 37C road bundle (OSM-derived centrelines) against GSI RdEdg road edges.
//   node tools/mission46d-road-bundle-check.cjs --bundle public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json --ref-dir temp/gsi46d-r3/<label> --ward sumiyoshi [--out report.json]
// READ-ONLY, no network (fetch tiles first with mission46d-fetch-gsi-tiles.cjs --bbox ... --label ...). Aggregate numbers only (no coordinates, no ids).
// Method: ground-level centreline samples (every 10 m) inside the ward polygon are "supported" only when a GSI edge lies on BOTH sides, roughly
// PERPENDICULAR to the road direction (closest-point vector within 30 deg of the normal), and the edge-to-edge width is <= maxWidthM.
// Edges ahead/behind (junction ends), one-sided edges, and implausibly wide corridors do not count. A centreline is NOT expected to coincide with an edge.
// Partial area never yields a ward-level PASS: the verdict covers only the bundle area and ward status stays INSUFFICIENT_DATA unless coverage is complete.
const fs = require('fs');
const path = require('path');
const A = require('./mission46d-independent-accuracy.cjs');

const SCHEMA = 'livecity.mission46d.road-bundle-check/1';
const T = { bandM: 25, maxWidthM: 40, minSideM: 0.5, maxAlongCos: 0.5, stepM: 10, bracketedPctMin: 60, minBracketedSamples: 50, minSamples: 100, minWardAreaCoveragePct: 95 };
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const pct = (n, d) => (d ? Math.round((n / d) * 10000) / 100 : null);
const quant = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return r2(s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]); };

// ground = not bridge / tunnel / elevated or underground layer / covered
function classifyFeature(f) {
  if (f.bridge) return 'bridge';
  if (f.tunnel) return 'tunnel';
  const l = Number(f.layer); if (Number.isFinite(l) && l !== 0) return l > 0 ? 'elevated-layer' : 'underground-layer';
  if (f.covered === 'yes' || f.covered === true) return 'covered';
  return 'ground';
}
function inWard(ward, x, z) { return (ward.polygons || []).some((p) => A.pointInRing(x, z, p.outer) && !(p.holes || []).some((h) => A.pointInRing(x, z, h))); }

// nearest edge per side that is roughly perpendicular to the direction d
function bracket(edges, x, z, dx, dz) {
  const c = edges.cell, R = Math.ceil(T.bandM / c), cx = Math.floor(x / c), cz = Math.floor(z / c); let left = Infinity, right = Infinity;
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) { const l = edges.m.get((cx + i) + ',' + (cz + j)); if (!l) continue;
    for (const [a, b] of l) {
      const ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez; let t = l2 ? ((x - a[0]) * ex + (z - a[1]) * ez) / l2 : 0; t = Math.max(0, Math.min(1, t));
      const qx = a[0] + t * ex - x, qz = a[1] + t * ez - z, dist = Math.hypot(qx, qz); if (dist > T.bandM || dist < T.minSideM) continue;
      if (Math.abs(dx * qx + dz * qz) / dist > T.maxAlongCos) continue; // closest point is ahead/behind, not beside
      if (dx * qz - dz * qx > 0) { if (dist < left) left = dist; } else if (dist < right) right = dist;
    } }
  return { left, right };
}

// lines: [{pts, tier, highway}] ; returns aggregate counts
function measure(lines, edges, tileBounds, ward) {
  const out = { samples: 0, outsideWard: 0, outsideRefCoverage: 0, bracketed: 0, oneSided: 0, none: 0, half: [], width: [], byTier: {} };
  const inTiles = (x, z) => tileBounds.some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1);
  for (const ln of lines) {
    const bt = out.byTier[ln.tier || 'unknown'] || (out.byTier[ln.tier || 'unknown'] = { samples: 0, bracketed: 0, oneSided: 0, none: 0 });
    for (let i = 1; i < ln.pts.length; i++) {
      const a = ln.pts[i - 1], b = ln.pts[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!(len > 0)) continue;
      const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len, k = Math.max(1, Math.ceil(len / T.stepM));
      for (let s = 0; s <= k; s++) {
        const x = a[0] + (b[0] - a[0]) * (s / k), z = a[1] + (b[1] - a[1]) * (s / k);
        if (ward && !inWard(ward, x, z)) { out.outsideWard++; continue; }
        if (!inTiles(x, z)) { out.outsideRefCoverage++; continue; }
        out.samples++; bt.samples++;
        const { left, right } = bracket(edges, x, z, dx, dz);
        if (left !== Infinity && right !== Infinity && left + right <= T.maxWidthM) { out.bracketed++; bt.bracketed++; out.half.push(Math.min(left, right)); out.width.push(left + right); }
        else if (left !== Infinity || right !== Infinity) { out.oneSided++; bt.oneSided++; } else { out.none++; bt.none++; }
      }
    }
  }
  return out;
}

function areaCoverage(ward, bbox, tileBounds, cell = 50) { // share of the ward polygon area inside bundle bbox AND reference tiles
  let tot = 0, cov = 0;
  for (let x = ward.bbox.minX + cell / 2; x < ward.bbox.maxX; x += cell) for (let z = ward.bbox.minZ + cell / 2; z < ward.bbox.maxZ; z += cell) {
    if (!inWard(ward, x, z)) continue; tot++;
    if (x >= bbox.minX && x <= bbox.maxX && z >= bbox.minZ && z <= bbox.maxZ && tileBounds.some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1)) cov++;
  }
  return { wardCells: tot, coveredCells: cov, coveragePct: pct(cov, tot), cellM: cell };
}

function buildReport(bundle, ref, ward) {
  const counts = {}, lines = [];
  for (const f of bundle.features || []) {
    if (!Array.isArray(f.p) || f.p.length < 2) { counts.malformed = (counts.malformed || 0) + 1; continue; }
    const c = classifyFeature(f); counts[c] = (counts[c] || 0) + 1;
    if (c === 'ground') lines.push({ pts: f.p, tier: f.tier, highway: f.highway });
  }
  const edges = new A.SegIndex(); for (const l of ref.roadEdges) edges.addLine(l);
  const m = measure(lines, edges, ref.tileBounds, ward);
  // discrimination control: the same lines displaced by a known offset. If the metric cannot tell displaced lines from real ones it proves little.
  const shiftControl = {};
  for (const d of [10, 20, 40]) {
    const sh = lines.map((l) => ({ ...l, pts: l.pts.map(([x, z]) => [x + d * 0.7071, z + d * 0.7071]) }));
    const mm = measure(sh, edges, ref.tileBounds, null);
    shiftControl['shift' + d + 'm'] = { samples: mm.samples, bracketedPct: pct(mm.bracketed, mm.samples) };
  }
  const cov = areaCoverage(ward, bundle.bboxLocal, ref.tileBounds);
  const bracketedPct = pct(m.bracketed, m.samples);
  const reasons = [];
  let areaVerdict;
  if (!ref.tiles || !ref.roadEdges.length || m.samples < T.minSamples) { areaVerdict = 'INSUFFICIENT_DATA'; reasons.push('too few reference tiles/edges/samples'); }
  else if (m.bracketed < T.minBracketedSamples) { areaVerdict = 'INSUFFICIENT_DATA'; reasons.push('too few two-sided perpendicular samples'); }
  else if (bracketedPct < T.bracketedPctMin) { areaVerdict = 'FAIL'; reasons.push('bracketedPct ' + bracketedPct + ' < ' + T.bracketedPctMin); }
  else areaVerdict = 'PASS';
  const wardStatus = (areaVerdict === 'FAIL') ? 'FAIL' : (cov.coveragePct != null && cov.coveragePct >= T.minWardAreaCoveragePct && areaVerdict === 'PASS') ? 'PASS' : 'INSUFFICIENT_DATA';
  if (wardStatus === 'INSUFFICIENT_DATA' && areaVerdict !== 'INSUFFICIENT_DATA') reasons.push('verdict covers only ' + cov.coveragePct + '% of the ward area; ward-level PASS is not allowed');
  const tierOut = {}; for (const [k, v] of Object.entries(m.byTier)) tierOut[k] = { ...v, bracketedPct: pct(v.bracketed, v.samples) };
  return { schema: SCHEMA, generatedBy: 'tools/mission46d-road-bundle-check.cjs', wardId: ward.wardId, thresholds: T,
    inputs: { bundleSource: bundle.source, bundleGeneratedAt: bundle.sourceGeneratedAt, bundleFeatureCount: (bundle.features || []).length, bundleDeclaredCount: bundle.count, referenceTiles: ref.tiles, referenceTileErrors: ref.errors, referenceRoadEdgeLines: ref.roadEdges.length },
    independence: 'Live City roads: OSM-derived centrelines (37C bundle). Reference: GSI optimal_bvmap-v1 RdEdg. Different producers; GSI building layer is NOT used here.',
    featureClasses: counts, groundFeatures: lines.length,
    samples: { evaluated: m.samples, outsideWardPolygon: m.outsideWard, outsideReferenceCoverage: m.outsideRefCoverage, stepM: T.stepM },
    areaCoverage: cov,
    result: { bracketed: m.bracketed, bracketedPct, oneSidedOnlyPct: pct(m.oneSided, m.samples), noEdgeInBandPct: pct(m.none, m.samples),
      centerlineToNearestEdgeM: { median: quant(m.half, 0.5), p95: quant(m.half, 0.95), p99: quant(m.half, 0.99) }, edgeToEdgeWidthM: { median: quant(m.width, 0.5), p95: quant(m.width, 0.95), p99: quant(m.width, 0.99) }, byTier: tierOut },
    displacementControl: { note: 'same centrelines displaced diagonally by the stated distance (no ward clip); a useful metric must drop clearly', ...shiftControl },
    areaVerdict, wardStatus, reasons,
    limits: ['Only the bundle area (about 2.1 km square, 9 building tiles) is measured; the rest of the ward and the other 23 wards have no tracked road data.',
      'GSI RdEdg omits many narrow lanes, so noEdgeInBand is NOT proof that a road is off-road; it is a suspect indicator only.',
      'Centrelines are not expected to coincide with edges; support means a plausible corridor on both sides. Not a survey-grade accuracy claim.',
      'Thresholds are provisional and uncalibrated. Offsets are reported, never applied.',
      'Owner-PC GLB data (574,213 buildings) was not accessible; nothing here concerns buildings.'] };
}

function main() {
  const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const bundle = JSON.parse(fs.readFileSync(get('--bundle'), 'utf8')), refDir = get('--ref-dir'), wid = get('--ward'), out = get('--out');
  const ward = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards.find((w) => w.wardId === wid);
  if (!ward) { console.error('unknown --ward'); process.exit(2); }
  const rep = buildReport(bundle, A.loadReference(refDir), ward);
  const s = JSON.stringify(rep, null, 2);
  if (out) fs.writeFileSync(path.resolve(out), s + '\n'); else process.stdout.write(s + '\n');
  console.error('areaVerdict ' + rep.areaVerdict + ' wardStatus ' + rep.wardStatus + ' bracketedPct ' + rep.result.bracketedPct + ' samples ' + rep.samples.evaluated);
}
module.exports = { SCHEMA, T, classifyFeature, bracket, measure, areaCoverage, buildReport };
if (require.main === module) main();
