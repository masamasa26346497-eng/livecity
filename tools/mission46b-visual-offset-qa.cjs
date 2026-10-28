#!/usr/bin/env node
'use strict';
// Mission 46B: READ-ONLY "visual offset" QA. Separates three things that all look like "roads and buildings are shifted":
//   (1) geographic offset      -> edge-gap statistics between OSM centerlines and PLATEAU footprints (same local frame, no rendering involved)
//   (2) line width artefact    -> OSM centerlines are drawn as constant-PIXEL-width polylines; at a given camera range that is N metres on the ground.
//                                 We count road samples whose real gap to the nearest footprint is smaller than the drawn half-width: the line MUST touch/overlap the
//                                 footprint even with perfect registration.
//   (3) roof parallax          -> roofs of height h appear displaced from their ground footprint by h / tan(elevation) in an oblique view; compared with the road gap.
// Nothing is moved, converted, written inside inputs, or sent anywhere. Output = counts / percentages / metres only (no ids, no coordinates, no paths).
//   node tools/mission46b-visual-offset-qa.cjs --src <legacy osaka-city dir> [--wards a,b] [--out <new report.json>] [--step 8] [--serve]
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const L = require('./mission40g-build-ward-layers.cjs');

const SCHEMA = 'livecity.mission46b.visual-offset/1';
const CELL = 20;                 // spatial hash cell (m)
const CAP = 20;                  // nearest-edge search cap (m); samples farther than this are counted as "capped"
const FOV_DEG = 60, SCREEN_PX = 1080;   // Cesium default vertical field of view / typical screen height (assumptions, printed in the report)
const RANGES = [300, 800, 1500, 3000];  // camera range to target (m)
const PITCHES = [-35, -60, -90];        // camera pitch (deg); -90 = straight down
// pixel widths of the ward road style in public/mission37g-osaka-24ward-mvp.html (roadStyleWard): line width + casing
const DRAWN_PX = { major: 4.5 + 1.5, mid: 3.0 + 1.0, local: 1.8 };
const LIMITS = [
  'Edge-gap and overlap numbers describe geometry of the SOURCE data only. They do not prove that either dataset matches the real world.',
  'Real carriageway width is unknown (OSM has centerlines). Nothing here estimates or applies a road width, offset or rotation.',
  'Ground metres per pixel assumes a 60 degree vertical FOV and a 1080 px tall canvas; real screens differ. Perspective makes the value vary across the image.',
  'Parallax is the geometric roof shift of an ideal pinhole camera at the stated pitch; it is not measured from a rendering.',
  'Bridges, elevated roads and tunnels are excluded from the road samples (they legitimately cross footprints).'
];
const pct = (n, d) => (d ? Math.round((n / d) * 10000) / 100 : null);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const quant = (a, q) => { if (!a.length) return null; const s = Float64Array.from(a).sort(); return r2(s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]); };
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function ptSegDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
function pip(r, x, z) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (((r[i][1] > z) !== (r[j][1] > z)) && (x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) c = !c;
  }
  return c;
}
/** footprints: [{fp:[[x,z]...], h}] -> spatial index answering inside(x,z) and nearestEdge(x,z,cap). */
function buildIndex(blds) {
  const segs = new Map(), boxes = new Map();
  const key = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  const add = (m, cx, cz, v) => { const k = key(cx, cz); let a = m.get(k); if (!a) m.set(k, a = []); a.push(v); };
  blds.forEach((b, bi) => {
    const r = b.fp; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], c = r[(i + 1) % r.length];
      x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[0]); z0 = Math.min(z0, a[1]); z1 = Math.max(z1, a[1]);
      const sx0 = Math.floor(Math.min(a[0], c[0]) / CELL), sx1 = Math.floor(Math.max(a[0], c[0]) / CELL);
      const sz0 = Math.floor(Math.min(a[1], c[1]) / CELL), sz1 = Math.floor(Math.max(a[1], c[1]) / CELL);
      for (let cx = sx0; cx <= sx1; cx++) for (let cz = sz0; cz <= sz1; cz++) add(segs, cx, cz, [a[0], a[1], c[0], c[1]]);
    }
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) add(boxes, cx, cz, bi);
  });
  return {
    inside(x, z) {
      const a = boxes.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!a) return -1;
      for (const bi of a) if (pip(blds[bi].fp, x, z)) return bi;
      return -1;
    },
    nearestEdge(x, z) {
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      let best = Infinity;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const a = segs.get(key(cx + i, cz + j));
        if (a) for (const s of a) { const d = ptSegDist(x, z, s[0], s[1], s[2], s[3]); if (d < best) best = d; }
      }
      return best;   // Infinity when nothing within ~CELL (treated as capped)
    }
  };
}
function loadFootprints(src, wardId) {
  const dir = path.join(src, 'buildings', 'osaka-' + wardId);
  if (!fs.existsSync(dir)) return null;
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    for (const b of rj(path.join(dir, f)).buildings || []) {
      if (!Array.isArray(b.fp) || b.fp.length < 3) continue;
      if (b.fp.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) continue;
      out.push({ fp: b.fp, h: b.h > 0 && b.h <= 400 ? b.h : null });
    }
  }
  return out;
}
const groundPerPx = (range) => (2 * range * Math.tan((FOV_DEG / 2) * Math.PI / 180)) / SCREEN_PX;

/** Core: road lines + footprints -> aggregate numbers. Pure; used by tests with synthetic data. */
function analyze(blds, lines, step) {
  const idx = buildIndex(blds);
  const gaps = { major: [], mid: [], local: [] };
  const R = { samples: 0, insideFootprint: 0, capped: 0 };
  for (const ln of lines) {
    const tier = gaps[ln.tier] ? ln.tier : 'local', p = ln.p;
    for (let i = 0; i + 1 < p.length; i++) {
      const ax = p[i][0], az = p[i][1], bx = p[i + 1][0], bz = p[i + 1][1], len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.floor(len / step));
      for (let k = 0; k < n; k++) {
        const x = ax + (bx - ax) * (k / n), z = az + (bz - az) * (k / n);
        R.samples++;
        if (idx.inside(x, z) >= 0) { R.insideFootprint++; continue; }
        const d = idx.nearestEdge(x, z);
        if (!Number.isFinite(d) || d > CAP) { R.capped++; continue; }
        gaps[tier].push(d);
      }
    }
  }
  const outside = gaps.major.length + gaps.mid.length + gaps.local.length;
  const all = [].concat(gaps.major, gaps.mid, gaps.local);
  const edgeGapM = { measured: outside, p5: quant(all, 0.05), p25: quant(all, 0.25), p50: quant(all, 0.5), p75: quant(all, 0.75) };
  // (2) drawn-width artefact: share of outside samples whose gap < drawn half-width at each range
  const widthArtefact = RANGES.map((range) => {
    const mpp = groundPerPx(range);
    let hit = 0, n = 0;
    for (const t of Object.keys(gaps)) { const half = (DRAWN_PX[t] * mpp) / 2; for (const d of gaps[t]) { n++; if (d < half) hit++; } }
    return { rangeM: range, groundMetresPerPixel: r2(mpp), drawnHalfWidthM: { major: r2(DRAWN_PX.major * mpp / 2), mid: r2(DRAWN_PX.mid * mpp / 2), local: r2(DRAWN_PX.local * mpp / 2) },
      pctOutsideSamplesTouchedByDrawnWidthAlone: pct(hit, n) };
  });
  // (3) roof parallax vs. road gap
  const hs = blds.map((b) => b.h).filter((h) => h != null);
  const parallax = PITCHES.map((pitch) => {
    const el = Math.abs(pitch) * Math.PI / 180, k = Math.abs(pitch) >= 89.5 ? 0 : 1 / Math.tan(el);
    const shifts = hs.map((h) => h * k);
    const med = quant(all, 0.5);
    return { pitchDeg: pitch, roofShiftM: { p50: quant(shifts, 0.5), p90: quant(shifts, 0.9), max: quant(shifts, 1) },
      pctBuildingsRoofShiftExceedsMedianRoadGap: med == null ? null : pct(shifts.filter((s) => s > med).length, shifts.length) };
  });
  return { roadSamples: R.samples, pctSamplesInsideFootprint: pct(R.insideFootprint, R.samples), pctSamplesFartherThanCap: pct(R.capped, R.samples), edgeGapM, widthArtefact, parallax };
}
function verdictOf(a) {
  const notes = [];
  const w = a.widthArtefact.find((x) => x.rangeM === 1500);
  if (a.pctSamplesInsideFootprint != null && a.pctSamplesInsideFootprint > 15) notes.push('many road samples inside footprints (bridges/elevated/vintage or real offset) - inspect with translation probe');
  if (w && w.pctOutsideSamplesTouchedByDrawnWidthAlone > 25) notes.push('at 1500 m a large share of road lines overlaps footprints from pixel width alone (not a registration error)');
  const p35 = a.parallax.find((x) => x.pitchDeg === -35);
  if (p35 && p35.roofShiftM.p50 != null && a.edgeGapM.p50 != null && p35.roofShiftM.p50 > a.edgeGapM.p50) notes.push('median roof parallax at pitch -35 exceeds the median road-to-footprint gap (roofs look shifted vs roads in oblique views)');
  return notes;
}
function run(opts) {
  const src = path.resolve(opts.src);
  const root = fs.existsSync(path.join(src, 'buildings')) ? src : path.dirname(src);
  const W = rj(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json')).wards;
  const want = opts.wards ? new Set(opts.wards) : null;
  const rows = [];
  for (const w of W) {
    if (want && !want.has(w.wardId)) continue;
    try {
      const blds = loadFootprints(root, w.wardId);
      if (!blds) { rows.push({ wardId: w.wardId, status: 'source-missing' }); continue; }
      const b = w.bbox, roads = L.readLayer(root, 'roads', { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
      if (roads.status !== 'ok') { rows.push({ wardId: w.wardId, status: 'roads-' + roads.status }); continue; }
      const lines = roads.features.filter((f) => f.kind !== 'area' && !f.bridge && !f.tunnel && !f.underground && !(f.layer < 0)).map((f) => ({ tier: f.tier || 'local', p: f.p }));
      const a = analyze(blds, lines, opts.step || 8);
      rows.push(Object.assign({ wardId: w.wardId, status: 'ok', buildings: blds.length, notes: verdictOf(a) }, a));
    } catch (e) { rows.push({ wardId: w.wardId, status: 'error', error: (e && e.name) || 'Error' }); }
  }
  return { schema: SCHEMA, scope: 'source-geometry statistics + ideal-camera geometry; no rendering, no network, nothing written inside inputs', assumptions: { fovDeg: FOV_DEG, screenPx: SCREEN_PX, drawnPx: DRAWN_PX, cellM: CELL, capM: CAP }, limits: LIMITS, wards: rows };
}
function parse(a) {
  const g = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const o = { src: g('src'), out: g('out'), step: g('step') ? Math.max(2, parseFloat(g('step'))) : 8, wards: g('wards') ? g('wards').split(',').filter((x) => /^[a-z0-9-]+$/.test(x)) : null, serve: a.includes('--serve') };
  if (!o.src) throw Object.assign(new Error('usage: --src <legacy osaka-city dir> [--wards a,b] [--step 8] [--out <new report.json>] [--serve]'), { code: 2 });
  return o;
}
module.exports = { analyze, buildIndex, run, parse, groundPerPx, SCHEMA, LIMITS, DRAWN_PX };
if (require.main === module) {
  try {
    const o = parse(process.argv.slice(2));
    if (o.out) {   // refuse to write inside the input tree or over an existing file
      const out = path.resolve(o.out), inDir = path.resolve(o.src);
      if (out.startsWith(inDir + path.sep) || fs.existsSync(out)) throw Object.assign(new Error('--out must be a new file outside --src'), { code: 2 });
    }
    const r = run(o);
    if (o.out) { fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true }); fs.writeFileSync(o.out, JSON.stringify(r, null, 1), { flag: 'wx' }); }
    for (const w of r.wards) {
      if (w.status !== 'ok') { console.log(w.wardId.padEnd(15), w.status); continue; }
      const w15 = w.widthArtefact.find((x) => x.rangeM === 1500);
      console.log(w.wardId.padEnd(15), 'gapP50=' + w.edgeGapM.p50 + 'm', 'inside=' + w.pctSamplesInsideFootprint + '%', 'widthTouch@1500m=' + w15.pctOutsideSamplesTouchedByDrawnWidthAlone + '%', 'roofShift@-35p50=' + w.parallax[0].roofShiftM.p50 + 'm', w.notes.length ? '| ' + w.notes.join('; ') : '');
    }
    console.log('LIMITS: ' + r.limits.join(' '));
  } catch (e) { console.error('ERROR: ' + (e && e.code === 2 ? e.message : 'unexpected failure: ' + ((e && e.name) || 'Error'))); process.exit(e && e.code === 2 ? 2 : 1); }
}
