#!/usr/bin/env node
'use strict';
// Mission 45I: build per-ward road / waterway / park / railway layers (+ searchable street / rail names) for ALL 24 wards from the
// OLD Live City tiled OSM layers (read-only), into a SEPARATE private layers root. Reuses the 40G reader (nothing is invented).
//
//   node tools/mission45i-build-layers-24.cjs --src <...\livecity-data-pipeline\public\map-data\osaka-city> --layers-root <dir> [--wards a,b] [--margin 0] [--plan]
//
//   reads : <src>/{roads,waterways,parks,railways}/{manifest.json,tile_*.json}            -- never written
//   writes: <layers-root>/.livecity-45i-layers.json (marker), coverage.json,
//           <layers-root>/<wardId>/layers/{roads,waterways,parks,railways}.json, labels.json, layers-report.json   -- NEW files only
// Refuses: a layers root inside the repo, inside the source, inside a OneDrive sync root, or one that holds a 45D marker.
// An existing ward layers/ dir is skipped (never overwritten). --plan only reports what would be built (writes nothing).
// Coverage stages (honest): sourceAvailable -> generated. "served" / "browserRendered" can NOT be known here and are always false.
const fs = require('fs');
const path = require('path');
const L = require('./mission40g-build-ward-layers.cjs');
const A = require('./lib/mission45j-align.cjs');
const VEC = (() => { const m = require('../public/mission45i-vec.js'); return m && m.makeInsideTester ? m : globalThis.LC45I; })();   // package.json が type:module のため .js は ESM 扱い → globalThis.LC45I

const ROOT = path.resolve(__dirname, '..');
const MARKER = '.livecity-45i-layers.json';
const SCHEMA = 'livecity.mission45i.layers/1';
const LAYERS = ['roads', 'waterways', 'parks', 'railways'];
const NAME_CAP = { road: 600, rail: 200 };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };
const r1 = (v) => Math.round(v * 10) / 10;

function syncRoots() {
  const r = [];
  for (const v of [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]) if (v) r.push(v);
  if (process.env.USERPROFILE) r.push(path.join(process.env.USERPROFILE, 'OneDrive'));
  return r.map((x) => path.resolve(x));
}
const inside = (child, parent) => { const c = path.resolve(child).toLowerCase() + path.sep, p = path.resolve(parent).toLowerCase() + path.sep; return c.startsWith(p); };

/** Throws a coded error when the root is not a safe private place for generated layers. */
function checkRoot(layersRoot, src) {
  if (!layersRoot) throw Object.assign(new Error('--layers-root required'), { code: 2 });
  const o = path.resolve(layersRoot);
  if (inside(o, ROOT)) throw Object.assign(new Error('layers root must be outside the repository (Git / Vercel)'), { code: 4 });
  if (src && (inside(o, src) || inside(src, o))) throw Object.assign(new Error('layers root must be separate from the source folder'), { code: 4 });
  if (syncRoots().some((s) => inside(o, s))) throw Object.assign(new Error('layers root is inside a OneDrive sync root; refusing'), { code: 4 });
  const st = lst(o);
  if (st) {
    if (!st.isDirectory() || st.isSymbolicLink()) throw Object.assign(new Error('layers root is not a real directory'), { code: 4 });
    if (lst(path.join(o, '.livecity-45d-root.json'))) throw Object.assign(new Error('this is a 45D root; layers are never written into it'), { code: 4 });
    const entries = fs.readdirSync(o);
    if (entries.length && !lst(path.join(o, MARKER))) throw Object.assign(new Error('layers root is not empty and has no 45I marker; refusing'), { code: 4 });
  }
  return o;
}

/** Longest-segment midpoint of a polyline — a point that is actually ON the street. */
function anchor(p) {
  let best = -1, at = null;
  for (let i = 0; i + 1 < p.length; i++) {
    const d = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
    if (d > best) { best = d; at = [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2]; }
  }
  return at ? [r1(at[0]), r1(at[1])] : null;
}
/** One search item per distinct (kind, name) per ward: the longest feature wins. Only names present in the source; nothing is guessed. */
function namedItems(kind, features) {
  const byName = new Map();
  for (const f of features) {
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (!name || !Array.isArray(f.p) || f.p.length < 2) continue;
    let len = 0; for (let i = 0; i + 1 < f.p.length; i++) len += Math.hypot(f.p[i + 1][0] - f.p[i][0], f.p[i + 1][1] - f.p[i][1]);
    const cur = byName.get(name);
    if (!cur || len > cur.len) byName.set(name, { len, f });
  }
  const rank = { major: 0, mid: 1, local: 2 };
  return [...byName.entries()]
    .sort((a, b) => ((rank[a[1].f.tier] ?? 2) - (rank[b[1].f.tier] ?? 2)) || b[1].len - a[1].len)
    .slice(0, NAME_CAP[kind] || 200)
    .map(([name, v]) => { const at = anchor(v.f.p); return at ? { kind, name, x: at[0], z: at[1], tier: v.f.tier || null } : null; })
    .filter(Boolean);
}
function tierCounts(features) {
  const c = { major: 0, mid: 0, local: 0, other: 0 };
  for (const f of features) { const t = f.tier; if (t === 'major' || t === 'mid' || t === 'local') c[t]++; else c.other++; }
  return c;
}

function buildWard(ward, src, layersRoot, margin, planOnly) {
  const b = ward.bbox, box = { minX: b.minX - margin, maxX: b.maxX + margin, minZ: b.minZ - margin, maxZ: b.maxZ + margin };
  const outDir = path.join(layersRoot, ward.wardId, 'layers');
  const res = { ward: ward.wardId, wardCode: ward.wardCode, stage: 'sourceAvailable', layers: {} };
  if (!planOnly && lst(outDir)) { res.stage = 'skipped-exists'; res.note = 'layers dir already exists; not overwritten'; return res; }
  const data = {}; let anyOk = false; const manifests = {};
  for (const l of LAYERS) {
    const r = L.readLayer(src, l, box);
    data[l] = r.features; if (r.manifest) manifests[l] = r.manifest;
    res.layers[l] = r.status === 'ok' ? { status: 'ok', features: r.features.length, vertices: r.stats.vertices, sourceTiles: r.stats.sourceTiles, missingTiles: r.stats.missingTiles, tiers: l === 'roads' ? tierCounts(r.features) : undefined } : { status: r.status };
    if (r.status === 'ok' && r.features.length) anyOk = true;
  }
  if (!anyOk) { res.stage = 'no-source-data'; return res; }
  // 45J: 座標規約の検証。manifest の宣言 + N03 区ポリゴンとの突き合わせ（8 通りの軸/符号）。合致しなければ書き出さない（偽の規約を埋め込まない）
  const evidence = { manifests: {}, probe: null };
  const problems = [];
  for (const l of Object.keys(manifests)) { const v = A.validateSourceManifest(manifests[l]); evidence.manifests[l] = v; if (!v.ok) problems.push(l + ': ' + v.problems.join('; ')); }
  if (ward.polygons && data.roads.length) {
    const pts = []; for (const f of data.roads) for (const p of f.p) { if (pts.length < 20000) pts.push(p); }
    evidence.probe = A.probeConvention(pts, ward.polygons);
    if (evidence.probe.verdict === 'alternative-fits-better') problems.push('N03 probe: an axis/sign transform fits the ward polygon better than identity');
  }
  res.alignment = { verdict: evidence.probe ? evidence.probe.verdict : 'no-probe', problems };
  if (problems.length) { res.stage = 'convention-mismatch'; res.note = problems.join(' | '); return res; }
  const convention = (manifests.roads || manifests[Object.keys(manifests)[0]] || {}).coordinateConvention;
  // 45J: 区ポリゴンでの切り出しをビルド時に 1 回だけ行う（ビューアは clipped:'ward-polygon' を見て再 clip しない）
  let clippedKind = 'bbox';
  if (ward.polygons) {
    const inside = VEC.makeInsideTester(ward.polygons, 64);
    for (const l of ['roads', 'railways', 'waterways']) {
      const out = [];
      for (const f of data[l]) {
        if (f.kind === 'area') { out.push(f); continue; }
        const runs = VEC.clipRuns(f.p, inside);
        runs.forEach((run, i) => { if (run.length >= 2) out.push(Object.assign({}, f, { id: runs.length > 1 ? f.id + '~' + i : f.id, p: run })); });
      }
      data[l] = out; if (res.layers[l] && res.layers[l].status === 'ok') { res.layers[l].features = out.length; res.layers[l].vertices = out.reduce((a, f) => a + f.p.length, 0); }
    }
    clippedKind = 'ward-polygon';
  }
  const items = [].concat(namedItems('road', data.roads), namedItems('rail', data.railways));
  res.labels = { roads: items.filter((i) => i.kind === 'road').length, rails: items.filter((i) => i.kind === 'rail').length };
  if (planOnly) return res;
  fs.mkdirSync(outDir, { recursive: true });
  for (const l of LAYERS) {
    if (res.layers[l].status !== 'ok') continue;
    const file = path.join(outDir, l + '.json');
    fs.writeFileSync(file, JSON.stringify({ layer: l, mission: '45I', ward: ward.wardId, coordinateConvention: convention, coordinateSystem: 'local-meters', clipped: clippedKind, bboxLocal: box, count: data[l].length, features: data[l] }), { flag: 'wx' });
    res.layers[l].bytes = fs.statSync(file).size;
  }
  fs.writeFileSync(path.join(outDir, 'labels.json'), JSON.stringify({ schema: SCHEMA, ward: ward.wardId, wardCode: ward.wardCode, source: 'OSM names carried by the old Live City road / railway tiles', items }), { flag: 'wx' });
  fs.writeFileSync(path.join(outDir, 'layers-report.json'), JSON.stringify({ schema: SCHEMA, mission: '45I', ward: ward.wardId, wardCode: ward.wardCode, generatedAt: new Date().toISOString(), marginM: margin, clipBoxLocal: box, layers: res.layers, labels: res.labels, license: 'OpenStreetMap contributors (ODbL) via the old Live City tiles', alignment: res.alignment, alignmentEvidence: evidence, clipped: clippedKind }, null, 1), { flag: 'wx' });
  res.stage = 'generated';
  return res;
}

function run(opts) {
  const src = opts.src && path.resolve(opts.src);
  if (!src || !lst(src)) throw Object.assign(new Error('--src (old osaka-city map-data dir) required and must exist'), { code: 2 });
  const layersRoot = checkRoot(opts.layersRoot, src);
  const all = readJson(opts.wardsFile || path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json')).wards;
  if (all.length !== 24 || new Set(all.map((w) => w.wardCode)).size !== 24) throw Object.assign(new Error('ward list is not 24 unique wards'), { code: 3 });
  const pick = opts.wards && opts.wards.length ? all.filter((w) => opts.wards.includes(w.wardId)) : all;
  if (opts.wards && opts.wards.length && pick.length !== opts.wards.length) throw Object.assign(new Error('unknown ward id in --wards'), { code: 2 });
  const planOnly = !!opts.plan;
  if (!planOnly) {
    fs.mkdirSync(layersRoot, { recursive: true });
    if (!lst(path.join(layersRoot, MARKER))) fs.writeFileSync(path.join(layersRoot, MARKER), JSON.stringify({ schema: SCHEMA, createdAt: new Date().toISOString() }), { flag: 'wx' });
  }
  const wards = pick.map((w) => buildWard(w, src, layersRoot, opts.margin == null ? 0 : opts.margin, planOnly));
  const cov = { schema: SCHEMA, generatedAt: new Date().toISOString(), plan: planOnly, totalWards: 24, requested: pick.length,
    stages: { sourceAvailable: wards.filter((w) => w.stage !== 'no-source-data').length, generated: wards.filter((w) => w.stage === 'generated').length, served: false, browserRendered: false },
    note: 'served / browserRendered are never set by the builder: run the preview with --layers-root and look at the page (stats.vec45i).', wards };
  if (!planOnly) {
    const cp = path.join(layersRoot, 'coverage.json');
    // coverage.json is a summary and may be refreshed; per-ward data above is never overwritten.
    fs.writeFileSync(cp, JSON.stringify(cov, null, 1));
  }
  return cov;
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const cov = run({ src: opt('src'), layersRoot: opt('layers-root'), wards: opt('wards') ? opt('wards').split(',') : null, margin: opt('margin') != null ? Number(opt('margin')) : null, plan: a.includes('--plan') });
    console.log(JSON.stringify(cov, null, 1));
    if (!cov.stages.generated && !cov.plan) process.exitCode = 2;
  } catch (e) { console.error(Number.isInteger(e.code) ? 'ERROR: ' + e.message : 'ERROR: operation failed: ' + e.message); process.exit(Number.isInteger(e.code) ? e.code : 1); }
}
module.exports = { run, checkRoot, namedItems, anchor, tierCounts, MARKER, SCHEMA };
if (require.main === module) main();
