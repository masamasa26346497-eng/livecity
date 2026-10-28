#!/usr/bin/env node
'use strict';
// Mission 46A: READ-ONLY 24-ward alignment audit (ground footprint <-> roads, source <-> 45D tiles <-> 45I layers). Anonymous aggregates only.
//   node tools/mission46a-align-audit.cjs --src <legacy osaka-city dir (has buildings/ and roads/)> [--tiles-root <45D root>] [--layers-root <45I root>]
//        [--wards a,b,c] [--out <report.json>] [--serve [--port 8146]]
// Never moves anything: no shift / rotation is computed-and-applied. Never writes inside --src/--tiles-root/--layers-root. No network.
// Output holds counts, percentages and meters only (no building id, no coordinate, no path). --serve exposes ONLY that aggregate JSON on 127.0.0.1.
// What this can and cannot prove: see LIMITS below (also printed in the report).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const L = require('./mission40g-build-ward-layers.cjs');
const O = require('./lib/mission45o-overlap.cjs');
const loadGlobal = (p, g) => { const sb = {}; vm.runInNewContext(fs.readFileSync(path.join(ROOT, p), 'utf8'), sb); sb.globalThis = sb; return sb[g]; };
const V = loadGlobal('public/mission45i-vec.js', 'LC45I');
const G = loadGlobal('public/mission45y-gfp.js', 'LC45Y');

const SCHEMA = 'livecity.mission46a.align/1';
const CONST = { clat: 34.604208, clon: 135.525020, mpd: 111320 };
const TILE = 500;
const SENTINELS = new Set([29997, 29999, 30000]);
const LIMITS = [
  'Road-through-building fraction is NOT a proof of positional accuracy: bridges, elevated roads, tunnels, underpasses and data vintage differences legitimately cross footprints.',
  'OSM road centerlines are lines, not carriageway edges; a few metres of lateral difference from PLATEAU footprints is expected and is not a registration error.',
  'Only translation within the search radius is probed, and only as a REPORT. Rotation, scale and non-uniform error are not tested. Nothing is ever applied automatically.',
  'Checks that compare a stage with its own source (tiles vs source, layers vs source) prove no corruption in transport; they cannot prove the source itself is aligned to the real world.',
  'GLB vertex geometry is not read here (use tools/mission45m-verify-glb-geometry.cjs for that). tileset transforms are checked against the tile cell centre.'
];
const pct = (n, d) => (d ? Math.round((n / d) * 10000) / 100 : null);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const quant = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return r2(s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]); };

// ---- independent geodetic inversion (does not reuse the converter's functions) ----
const WA = 6378137, WE2 = 0.00669437999014, D2R = Math.PI / 180;
function ecefToGeodetic(x, y, z) {
  const lon = Math.atan2(y, x), p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WE2)), h = 0;
  for (let i = 0; i < 8; i++) { const s = Math.sin(lat), N = WA / Math.sqrt(1 - WE2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - (WE2 * N) / (N + h))); }
  return { lon: lon / D2R, lat: lat / D2R, h };
}
const toLocal = (lon, lat) => ({ x: (lon - CONST.clon) * Math.cos(CONST.clat * D2R) * CONST.mpd, z: -((lat - CONST.clat) * CONST.mpd) });
// column-major 4x4 rigid: abs = parent * child
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function srcRoot(src) {
  const s = path.resolve(src);
  const st = lst(s);
  if (!st || !st.isDirectory()) throw Object.assign(new Error('--src missing or not a directory'), { code: 2 });
  if (path.basename(s) === 'buildings') return path.dirname(s);
  return s;
}
function findTilesetDir(tilesRoot, ward) {
  if (!tilesRoot) return null;
  const cands = [path.join(tilesRoot, ward), path.join(tilesRoot, ward, ward)];
  for (const sub of ['pc23', '.']) {
    const base = path.join(tilesRoot, sub);
    if (!lst(base)) continue;
    for (const e of fs.readdirSync(base)) {
      if (new RegExp('^' + ward + '-a\\d+$').test(e)) { cands.push(path.join(base, e)); cands.push(path.join(base, e, ward)); }
    }
  }
  cands.sort().reverse();   // higher attempt number first
  return cands.find((d) => lst(path.join(d, 'tileset.json')) && lst(path.join(d, 'attrs'))) || null;
}

function auditFootprints(src, ward, tester, others) {
  const dir = path.join(src, 'buildings', 'osaka-' + ward.wardId);
  if (!lst(dir)) return { status: 'source-missing' };
  const R = { status: 'ok', tiles: 0, buildings: 0, nonFiniteVertex: 0, degenerateRing: 0, repInsideOwnPct: null, repInsideOtherWardPct: null, repOutsideAllPct: null,
    tileCellMismatch: 0, tileEdgeStraddle: 0, heightSentinel: 0, heightOutOfRange: 0, z0NonZero: 0, otherWards: {} };
  let inOwn = 0, inOther = 0, none = 0, n = 0;
  const rings = [], rep = new Map();
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^tile_(-?\d+)_(-?\d+)\.json$/);
    if (!m) continue;
    R.tiles++;
    const j = rj(path.join(dir, f));
    for (const b of j.buildings || []) {
      R.buildings++;
      if (!Array.isArray(b.fp) || b.fp.length < 3) { R.degenerateRing++; continue; }
      let bad = false, sx = 0, sz = 0;
      for (const p of b.fp) { if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) { bad = true; break; } sx += p[0]; sz += p[1]; }
      if (bad) { R.nonFiniteVertex++; continue; }
      const cx = sx / b.fp.length, cz = sz / b.fp.length;
      n++;
      rings.push(b.fp);
      if (typeof b.id === 'string') rep.set(b.id, { cx, cz, rx: b.repX, rz: b.repZ, h: b.h });
      if (Math.floor(cx / TILE) !== +m[1] || Math.floor(cz / TILE) !== +m[2]) {
        const dx = Math.max(+m[1] * TILE - cx, cx - (+m[1] + 1) * TILE, 0), dz = Math.max(+m[2] * TILE - cz, cz - (+m[2] + 1) * TILE, 0);
        if (Math.hypot(dx, dz) > 50) R.tileCellMismatch++; else R.tileEdgeStraddle++;
      }
      if (SENTINELS.has(b.h)) R.heightSentinel++; else if (!(b.h > 0 && b.h <= 400)) R.heightOutOfRange++;
      if (b.z0) R.z0NonZero++;
      if (tester(cx, cz)) inOwn++;
      else { const hit = others.find((o) => o.t(cx, cz)); if (hit) { inOther++; R.otherWards[hit.wardId] = (R.otherWards[hit.wardId] || 0) + 1; } else none++; }
    }
  }
  R.repInsideOwnPct = pct(inOwn, n); R.repInsideOtherWardPct = pct(inOther, n); R.repOutsideAllPct = pct(none, n);
  return Object.assign(R, { _rings: rings, _rep: rep });
}

function auditRoads(src, ward, rings) {
  const b = ward.bbox, box = { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
  const roads = L.readLayer(src, 'roads', box);
  if (roads.status !== 'ok') return { status: roads.status };
  const lines = roads.features.filter((f) => f.kind !== 'area');
  const surface = [], all = [], tags = { bridge: 0, tunnel: 0, underground: 0, negLayer: 0 };
  for (const f of lines) {
    if (f.bridge) tags.bridge++; if (f.tunnel) tags.tunnel++; if (f.underground) tags.underground++; if (f.layer < 0) tags.negLayer++;
    all.push(f.p);
    if (!f.bridge && !f.tunnel && !f.underground && !(f.layer < 0)) surface.push(f.p);
  }
  const R = { status: 'ok', convention: (roads.manifest && roads.manifest.coordinateConvention) || null, features: lines.length, taggedFeatures: tags, _all: all };
  if (!rings || !rings.length || !all.length) { R.overlap = 'not-computed (no footprints or no roads)'; return R; }
  const fa = G.roadInsideFraction(all, rings), fs_ = G.roadInsideFraction(surface, rings);
  R.throughFraction = { allRoads: r2(fa.fraction * 100), surfaceOnly: r2(fs_.fraction * 100), samples: fa.samples };
  // translation probe: REPORT ONLY (never applied)
  const so = { radius: 15, offsetStep: 2.5, sampleStep: 5 };
  const whole = O.scan(rings, all, so);
  const midX = (b.minX + b.maxX) / 2, midZ = (b.minZ + b.maxZ) / 2;
  const half = (ax, low) => {
    const sel = (p) => (low ? p[ax] < (ax === 0 ? midX : midZ) : p[ax] >= (ax === 0 ? midX : midZ));
    const ls = all.filter((l) => sel(l[0])), ps = rings.filter((p) => sel(p[0]));
    return ls.length && ps.length ? O.scan(ps, ls, so) : { samples: 0 };
  };
  const v = O.verdict(whole, [half(0, true), half(0, false), half(1, true), half(1, false)], { radius: 15 });
  R.translationProbe = { verdict: v.verdict, relativeGainAtBest: v.relativeGainAtBest == null ? null : v.relativeGainAtBest, zeroOffsetFractionPct: whole.zero == null ? null : r2(whole.zero * 100),
    bestOffsetM: whole.best ? { dxEast: whole.best.dx, dzSouth: whole.best.dz } : null, applied: false, searchedRadiusM: 15 };
  return R;
}

function auditTiles(dir, ward, srcRep) {
  const R = { status: 'ok' };
  let sj = null, ts = null;
  try { sj = rj(path.join(dir, 'source.json')); } catch (e) { R.sourceJson = 'missing/unreadable'; }
  try { ts = rj(path.join(dir, 'tileset.json')); } catch (e) { return { status: 'tileset-unreadable' }; }
  if (sj) { R.wardCodeMatches = sj.wardCode === undefined ? 'absent' : String(sj.wardCode) === String(ward.wardCode); R.idPolicy = sj.idPolicy ? 'present' : 'absent'; }
  // attrs vs source
  const ad = path.join(dir, 'attrs');
  let n = 0, matched = 0, unmatched = 0, hDiff = 0, tileMis = 0;
  const dRep = [], dCen = [];
  for (const f of fs.readdirSync(ad)) {
    const m = f.match(/^t_(-?\d+)_(-?\d+)\.json$/);
    if (!m) continue;
    const a = rj(path.join(ad, f));
    for (const [id, v] of Object.entries(a.byId || {})) {
      n++;
      if (Math.floor(v[2] / TILE) !== +m[1] || Math.floor(v[3] / TILE) !== +m[2]) { if (Math.hypot(Math.max(+m[1] * TILE - v[2], v[2] - (+m[1] + 1) * TILE, 0), Math.max(+m[2] * TILE - v[3], v[3] - (+m[2] + 1) * TILE, 0)) > 50) tileMis++; }
      const s = srcRep && srcRep.get(id);
      if (!s) { unmatched++; continue; }
      matched++;
      if (Number.isFinite(s.rx) && Number.isFinite(s.rz)) dRep.push(Math.hypot(v[2] - s.rx, v[3] - s.rz));
      dCen.push(Math.hypot(v[2] - s.cx, v[3] - s.cz));
      if (Number.isFinite(s.h) && !SENTINELS.has(s.h) && Math.abs(v[0] - s.h) > 0.05) hDiff++;
    }
  }
  R.attrs = { buildings: n, matchedToSourceById: matched, notInSource: unmatched, tileCellMismatch: tileMis, heightDiffersFromSource: hDiff,
    repVsSourceRepM: { n: dRep.length, p50: quant(dRep, 0.5), p95: quant(dRep, 0.95), max: quant(dRep, 1) },
    repVsFootprintCentroidM: { n: dCen.length, p50: quant(dCen, 0.5), p95: quant(dCen, 0.95), max: quant(dCen, 1) } };
  // tileset transform chain vs tile cell centre (independent ECEF -> geodetic -> local)
  const offs = [];
  let nodes = 0, noTransform = 0;
  const walk = (node, parent) => {
    nodes++;
    const m = node.transform ? mul(parent, node.transform) : parent;
    const uri = node.content && (node.content.uri || node.content.url);
    const mm = uri && /t_(-?\d+)_(-?\d+)\.glb$/.exec(uri);
    if (mm) {
      if (!node.transform && parent === IDENT) noTransform++;
      const g = ecefToGeodetic(m[12], m[13], m[14]), l = toLocal(g.lon, g.lat);
      offs.push({ d: Math.hypot(l.x - (+mm[1] + 0.5) * TILE, l.z - (+mm[2] + 0.5) * TILE), h: g.h });
    }
    for (const c of node.children || []) walk(c, m);
  };
  try { walk(ts.root, IDENT); } catch (e) { R.transformWalk = 'failed'; }
  R.tileFrame = { leafTiles: offs.length, originOffsetFromCellCentreM: { p50: quant(offs.map((o) => o.d), 0.5), max: quant(offs.map((o) => o.d), 1) }, ellipsoidHeightM: { min: offs.length ? r2(Math.min(...offs.map((o) => o.h))) : null, max: offs.length ? r2(Math.max(...offs.map((o) => o.h))) : null }, leafWithoutTransform: noTransform };
  return R;
}

function auditLayers(root, ward, srcRoads) {
  const ld = path.join(root, ward.wardId, 'layers');
  if (!lst(ld)) return { status: 'not-delivered' };
  const R = { status: 'ok', files: {} };
  let rep = null;
  try { rep = rj(path.join(ld, 'layers-report.json')); } catch (e) { R.report = 'missing/unreadable'; }
  if (rep) { R.wardCodeMatches = rep.wardCode === undefined ? 'absent' : String(rep.wardCode) === String(ward.wardCode); R.generated = rep.generatedAt || rep.generated || null; R.reportConvention = rep.coordinateConvention || null; }
  const b = ward.bbox, MARGIN = 400;
  for (const name of ['roads', 'waterways', 'parks', 'railways']) {
    let j; try { j = rj(path.join(ld, name + '.json')); } catch (e) { R.files[name] = 'missing'; continue; }
    const fe = Array.isArray(j.features) ? j.features : [];
    let nv = 0, nonFinite = 0, outside = 0;
    for (const f of fe) for (const p of f.p || []) { nv++; if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) { nonFinite++; continue; } if (p[0] < b.minX - MARGIN || p[0] > b.maxX + MARGIN || p[1] < b.minZ - MARGIN || p[1] > b.maxZ + MARGIN) outside++; }
    R.files[name] = { features: fe.length, vertices: nv, nonFinite, outsideWardBboxPlus400mPct: pct(outside, nv), convention: j.coordinateConvention || null };
    if (name === 'roads' && srcRoads && srcRoads.length) {
      // vertex-level transport check: every sampled 45I road vertex should coincide (<=0.3 m) with a source road vertex
      const cell = new Map(), key = (x, z) => Math.floor(x) + '_' + Math.floor(z);
      for (const l of srcRoads) for (const p of l) { const k = key(p[0], p[1]); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(p); }
      let tot = 0, hit = 0;
      const step = Math.max(1, Math.floor(nv / 5000));
      let i = 0;
      for (const f of fe) for (const p of f.p || []) {
        if (i++ % step) continue;
        tot++;
        let ok = false;
        for (let a = -1; a <= 1 && !ok; a++) for (let c = -1; c <= 1 && !ok; c++) { const arr = cell.get(key(p[0] + a, p[1] + c)); if (arr && arr.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= 0.3)) ok = true; }
        if (ok) hit++;
      }
      R.files[name].vertexMatchesSourceRoadsPct = pct(hit, tot);
      R.files[name].sampled = tot;
    }
  }
  return R;
}

function verdictOf(row) {
  const issues = [], notes = [];
  const f = row.footprints;
  if (!f || f.status !== 'ok') return { status: 'unverified-no-source', issues, notes: ['legacy footprint source not found for this ward'] };
  if (f.nonFiniteVertex || f.degenerateRing) issues.push('footprints with non-finite/degenerate geometry');
  if (f.tileCellMismatch) issues.push('footprint centroid outside its tile cell by >50 m');
  if (f.repInsideOwnPct != null && f.repInsideOwnPct < 95) issues.push('less than 95% of footprint centroids inside own N03 ward polygon (check origin/axis/ward assignment)');
  if (f.heightSentinel) notes.push('height sentinel values present (viewer shows fallback; not a coordinate matter)');
  if (f.z0NonZero) notes.push('footprints with z0 != 0 (base height not on ellipsoid 0)');
  const t = row.tiles;
  if (t && t.status === 'ok' && t.attrs) {
    if (t.wardCodeMatches === false) issues.push('45D source.json wardCode mismatch');
    if (t.attrs.repVsSourceRepM.max != null && t.attrs.repVsSourceRepM.max > 0.5) issues.push('45D attrs representative points differ from source by >0.5 m');
    if (t.attrs.notInSource > 0) notes.push(t.attrs.notInSource + ' attrs ids not in this source (ids reused/other version)');
    if (t.tileFrame.originOffsetFromCellCentreM.max != null && t.tileFrame.originOffsetFromCellCentreM.max > 1) issues.push('tileset frame origin differs from tile cell centre by >1 m (axis/origin/scale mismatch)');
    if (t.tileFrame.leafTiles === 0) notes.push('no leaf transforms found');
    if (t.tileFrame.ellipsoidHeightM.max != null && Math.abs(t.tileFrame.ellipsoidHeightM.max) > 5) issues.push('tileset frame ellipsoid height not ~0');
  } else notes.push('45D tiles not checked (not provided / not found)');
  const l = row.layers;
  if (l && l.status === 'ok') {
    if (l.wardCodeMatches === false) issues.push('45I layers-report wardCode mismatch');
    for (const [n, v] of Object.entries(l.files)) {
      if (typeof v !== 'object') continue;
      if (v.nonFinite) issues.push('45I ' + n + ' has non-finite coordinates');
      if (v.convention && v.convention !== 'znorth-neg-v1') issues.push('45I ' + n + ' convention ' + v.convention);
      if (v.vertexMatchesSourceRoadsPct != null && v.vertexMatchesSourceRoadsPct < 95) issues.push('45I roads vertices do not coincide with source roads (' + v.vertexMatchesSourceRoadsPct + '%): transformed or other source version');
    }
  } else notes.push('45I layers not checked (not provided / not delivered)');
  const r = row.roads;
  if (r && r.status === 'ok' && r.translationProbe && r.translationProbe.verdict === 'consistent-shift-candidate') notes.push('translation probe reports a consistent shift CANDIDATE (not applied; confirm on a 2D diagnostic before any source fix)');
  if (r && r.status !== 'ok') notes.push('roads source ' + r.status);
  return { status: issues.length ? 'issues' : 'no-inconsistency-found', issues, notes };
}

function run(opts) {
  const src = srcRoot(opts.src);
  for (const root of [opts.tilesRoot, opts.layersRoot]) if (root && (!lst(root) || !lst(root).isDirectory())) throw Object.assign(new Error('input folder missing or not a directory'), { code: 2 });
  if (opts.out) {
    const o = path.resolve(opts.out);
    for (const root of [src, opts.tilesRoot, opts.layersRoot].filter(Boolean)) if ((o + path.sep).startsWith(path.resolve(root) + path.sep)) throw Object.assign(new Error('--out must not be inside an input folder'), { code: 2 });
    if (lst(o)) throw Object.assign(new Error('--out already exists; refusing to overwrite'), { code: 2 });
  }
  const W = rj(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json')).wards;
  const testers = W.map((w) => ({ wardId: w.wardId, t: V.makeInsideTester(w.polygons, 64) }));
  const want = opts.wards ? new Set(opts.wards) : null;
  const rows = [];
  for (const w of W) {
    if (want && !want.has(w.wardId)) continue;
    const row = { wardId: w.wardId, wardCode: w.wardCode };
    const own = testers.find((t) => t.wardId === w.wardId).t, others = testers.filter((t) => t.wardId !== w.wardId);
    try {
      const fp = auditFootprints(src, w, own, others);
      const rings = fp._rings, rep = fp._rep; delete fp._rings; delete fp._rep;
      row.footprints = fp;
      const rd = auditRoads(src, w, rings);
      const allRoads = rd._all; delete rd._all;
      row.roads = rd;
      const td = findTilesetDir(opts.tilesRoot, w.wardId);
      row.tiles = opts.tilesRoot ? (td ? auditTiles(td, w, rep) : { status: 'not-found' }) : { status: 'not-requested' };
      row.layers = opts.layersRoot ? auditLayers(opts.layersRoot, w, allRoads) : { status: 'not-requested' };
    } catch (e) { row.error = (e && e.code) || (e && e.name) || 'Error'; }
    row.verdict = row.error ? { status: 'audit-error', issues: [], notes: [row.error] } : verdictOf(row);
    rows.push(row);
  }
  const by = (s) => rows.filter((r) => r.verdict.status === s).length;
  const summary = { wards: rows.length, noInconsistencyFound: by('no-inconsistency-found'), withIssues: by('issues'), unverifiedNoSource: by('unverified-no-source'), errors: by('audit-error'),
    wardsWithIssues: rows.filter((r) => r.verdict.status === 'issues').map((r) => r.wardId) };
  return { schema: SCHEMA, readOnly: true, applied: 0, uploaded: 0, network: false, constants: CONST,
    scope: 'Consistency of origin/axis/unit/height/ward assignment across source -> 45D tiles -> 45I layers. Not a survey-grade accuracy proof. "no-inconsistency-found" is NOT "aligned".',
    limits: LIMITS, summary, wards: rows };
}

function parse(a) {
  const g = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const o = { src: g('src'), tilesRoot: g('tiles-root'), layersRoot: g('layers-root'), out: g('out'), wards: g('wards') ? g('wards').split(',').filter((x) => /^[a-z0-9-]+$/.test(x)) : null, serve: a.includes('--serve'), port: g('port') ? parseInt(g('port'), 10) : 8146 };
  if (!o.src) throw Object.assign(new Error('usage: --src <legacy osaka-city dir> [--tiles-root <45D root>] [--layers-root <45I root>] [--wards a,b] [--out <new report.json>] [--serve]'), { code: 2 });
  return o;
}
function serveSummary(report, port) {
  const body = Buffer.from(JSON.stringify(report));
  const okHost = (h) => { const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(h || ''); return !!m && +m[2] === port; };
  const server = http.createServer((req, res) => {
    const deny = (c) => { res.writeHead(c, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('denied'); };
    if (req.method !== 'GET') return deny(405);
    if (!okHost(req.headers.host)) return deny(403);
    if (req.headers.origin && !okHost(String(req.headers.origin).replace(/^https?:\/\//, ''))) return deny(403);
    if ((req.url || '').split('?')[0] !== '/align46a/summary.json') return deny(404);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)); });
}
module.exports = { run, parse, serveSummary, findTilesetDir, ecefToGeodetic, toLocal, mul, SCHEMA, LIMITS };
if (require.main === module) {
  (async () => {
    try {
      const o = parse(process.argv.slice(2));
      const r = run(o);
      if (o.out) { fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true }); fs.writeFileSync(o.out, JSON.stringify(r, null, 1), { flag: 'wx' }); }
      console.log(JSON.stringify(r.summary));
      for (const w of r.wards) console.log(w.wardId.padEnd(15), w.verdict.status, w.verdict.issues.join('; '), w.verdict.notes.length ? '| ' + w.verdict.notes.join('; ') : '');
      console.log('NOTE: ' + r.scope);
      console.log('LIMITS: ' + r.limits.join(' '));
      if (o.serve) { await serveSummary(r, o.port); console.log('serving aggregate summary only on http://127.0.0.1:' + o.port + '/align46a/summary.json (loopback, GET only; no footprints, no ids)'); }
      else process.exit(r.summary.withIssues || r.summary.errors ? 1 : 0);
    } catch (e) { console.error('ERROR: ' + (e && e.code === 2 ? e.message : 'unexpected failure (details withheld so no path or id is printed): ' + ((e && e.name) || 'Error'))); process.exit((e && e.code === 2) ? 2 : 1); }
  })();
}
