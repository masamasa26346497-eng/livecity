#!/usr/bin/env node
'use strict';
// Mission 145: 24-ward station layer (name / operator / lines) for the canonical Cesium page.
//
//   node tools/mission145-build-stations.cjs [--src <old osaka-city map-data dir>] [--osm-raw <railways-osm.json>] [--out public/mission145-data/stations-24.json]
//
// Inputs (read-only, all free / already licensed):
//   - public/map-data/osaka-city/facilities/wards/*.json   OSM station nodes (category transport / subcategory station), ODbL
//   - optional --src   old Live City railway tiles (<src>/railways/tile_*.json): OSM line names, used ONLY to look up an operator
//   - optional --osm-raw  the pipeline's raw Overpass dump: node tags `operator` / `network` (joined by OSM node id)
// Operator rules (nothing is guessed):
//   1. OSM `operator` tag (basis 'osm-operator-tag'), 2. OSM `network` tag (basis 'osm-network-tag' -- never treated as the operator
//   silently: the basis is kept so the UI can say so), 3. a line passing within 220 m whose OSM name carries an operator
//   (basis 'nearby-line-name'). Otherwise the station has NO operator: the UI shows 「不明」 (or 「未取得」 if no rail data was given).
// Stations with the same name within 450 m are one marker; several operators are listed on that one marker (transfer stations).
// Output is written fresh (never overwrites unless --force).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FAC_DIR = path.join(ROOT, 'public/map-data/osaka-city/facilities');
const MERGE_M = 450;
const LINE_RADIUS_M = 220;
const RAIL_TAGS = new Set(['rail', 'subway', 'light_rail', 'monorail', 'tram', 'narrow_gauge', 'funicular']);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const r1 = (v) => Math.round(v * 10) / 10;
const normName = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '').replace(/駅$/, '');

function segDist(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz));
}

function loadLines(src) {
  const dir = path.join(src, 'railways');
  if (!fs.existsSync(dir)) return null;
  const seen = new Set(), lines = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    for (const ft of readJson(path.join(dir, f)).features || []) {
      if (!ft || seen.has(ft.id) || typeof ft.name !== 'string' || !ft.name.trim() || !Array.isArray(ft.p) || ft.p.length < 2) continue;
      if (ft.railway && !RAIL_TAGS.has(ft.railway)) continue;
      seen.add(ft.id); lines.push({ name: ft.name.trim(), p: ft.p });
    }
  }
  return lines;
}
/** Lines passing within radius of (x,z): Map name -> distance. */
function nearbyLines(lines, x, z, radius) {
  const m = new Map();
  for (const L of lines) {
    let d = Infinity;
    for (let i = 0; i + 1 < L.p.length; i++) { const q = segDist(x, z, L.p[i], L.p[i + 1]); if (q < d) d = q; }
    if (d <= radius && (!m.has(L.name) || m.get(L.name) > d)) m.set(L.name, d);
  }
  return m;
}
function loadRawTags(file) {
  const raw = readJson(file), m = new Map();
  for (const e of raw.elements || []) if (e.tags && /^(node|way|relation)$/.test(e.type)) m.set(e.type + '/' + e.id, e.tags);
  return m;
}

async function build(opts) {
  const SI = await import(path.join(ROOT, 'tools/build-station-index.js'));   // OPERATORS / classifyOperator (string patterns, no station names)
  const manifest = readJson(path.join(FAC_DIR, 'ward-manifest.json'));
  const lines = opts.src ? loadLines(path.resolve(opts.src)) : null;
  const rawTags = opts.osmRaw ? loadRawTags(path.resolve(opts.osmRaw)) : null;
  const nodes = [];
  for (const w of manifest.wards) {
    const d = readJson(path.join(FAC_DIR, 'wards', w.wardId + '.json'));
    for (const r of d.records || []) {
      if (r.category !== 'transport' || r.subcategory !== 'station' || !r.name) continue;
      if (!Number.isFinite(r.localX) || !Number.isFinite(r.localZ)) continue;
      nodes.push(r);
    }
  }
  nodes.sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)));
  const clusters = [];
  for (const n of nodes) {
    const key = normName(n.name);
    const hit = clusters.find((c) => c.key === key && Math.hypot(c.nodes[0].localX - n.localX, c.nodes[0].localZ - n.localZ) <= MERGE_M);
    if (hit) hit.nodes.push(n); else clusters.push({ key, nodes: [n] });
  }
  const stat = { rawNodes: nodes.length, markers: clusters.length, withOperator: 0, operatorUnknown: 0, operatorNotConnected: 0, byBasis: {} };
  const stations = clusters.map((c) => {
    const ops = new Map(), lineSet = new Map();
    const add = (o, basis, evidence) => { if (!ops.has(o.id)) ops.set(o.id, { id: o.id, label: o.label, group: o.group, basis, evidence }); };
    for (const n of c.nodes) {
      const tags = rawTags && rawTags.get(n.sourceId);
      if (tags) {
        const a = SI.classifyOperator(tags.operator) || SI.classifyOperator(tags['operator:en']);
        if (a) add(a, 'osm-operator-tag', tags.operator || tags['operator:en']);
        else if (tags.operator) add({ id: 'other:' + tags.operator, label: tags.operator, group: 'other' }, 'osm-operator-tag', tags.operator);
        else { const b = SI.classifyOperator(tags.network); if (b) add(b, 'osm-network-tag', tags.network); }
      }
      if (lines) {
        for (const [name, dist] of nearbyLines(lines, n.localX, n.localZ, LINE_RADIUS_M)) {
          const o = SI.classifyOperator(name);
          if (!o || o.id === 'jr-freight') continue;
          add(o, 'nearby-line-name', name);
          if (!lineSet.has(name) || lineSet.get(name) > dist) lineSet.set(name, dist);
        }
      }
    }
    // an operator confirmed by an OSM tag outranks one inferred from a nearby line: keep both, but list the stronger basis first
    const rank = { 'osm-operator-tag': 0, 'osm-network-tag': 1, 'nearby-line-name': 2 };
    const operators = [...ops.values()].sort((a, b) => rank[a.basis] - rank[b.basis] || a.label.localeCompare(b.label, 'ja'));
    const n0 = c.nodes[0];
    const x = r1(c.nodes.reduce((s, n) => s + n.localX, 0) / c.nodes.length), z = r1(c.nodes.reduce((s, n) => s + n.localZ, 0) / c.nodes.length);
    if (operators.length) { stat.withOperator++; for (const o of operators) stat.byBasis[o.basis] = (stat.byBasis[o.basis] || 0) + 1; }
    else if (lines || rawTags) stat.operatorUnknown++; else stat.operatorNotConnected++;
    return {
      id: 'st145_' + String(n0.sourceId).replace(/[^0-9a-z]+/gi, '_'),
      name: n0.name, x, z,
      lat: +(c.nodes.reduce((s, n) => s + n.latitude, 0) / c.nodes.length).toFixed(6),
      lon: +(c.nodes.reduce((s, n) => s + n.longitude, 0) / c.nodes.length).toFixed(6),
      wardId: n0.wardId, wardName: n0.wardName,
      operators,
      lines: [...lineSet.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]).slice(0, 8),
      osmIds: c.nodes.map((n) => n.sourceId),
    };
  }).sort((a, b) => a.wardId.localeCompare(b.wardId) || a.name.localeCompare(b.name, 'ja'));
  const byWard = {}; for (const s of stations) byWard[s.wardId] = (byWard[s.wardId] || 0) + 1;
  return {
    schema: 'livecity.mission145.stations/1', mission: '145', generatedAt: new Date().toISOString(),
    coordinateConvention: 'znorth-neg-v1',
    operatorData: lines || rawTags ? { connected: true, lineTiles: !!lines, osmRaw: !!rawTags } : { connected: false, note: 'no rail line / OSM tag source was given; operators are not resolved (shown as 未取得)' },
    source: 'OpenStreetMap contributors (ODbL 1.0) via public/map-data/osaka-city/facilities (station nodes)',
    attribution: '© OpenStreetMap contributors',
    counts: Object.assign({}, stat, { byWard }),
    stations,
  };
}

async function main() {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const out = path.resolve(opt('out') || path.join(ROOT, 'public/mission145-data/stations-24.json'));
  if (fs.existsSync(out) && !a.includes('--force')) { console.error('ERROR: ' + out + ' exists; pass --force to regenerate'); process.exit(2); }
  const j = await build({ src: opt('src'), osmRaw: opt('osm-raw') });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(j));
  console.log(JSON.stringify(Object.assign({ out }, j.counts, { operatorData: j.operatorData }), null, 1));
}
module.exports = { build, normName, nearbyLines, segDist, MERGE_M, LINE_RADIUS_M };
if (require.main === module) main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
