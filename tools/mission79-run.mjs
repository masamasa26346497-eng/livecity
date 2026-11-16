#!/usr/bin/env node
// Mission 79 orchestrator: PLATEAU 2025 (v5) original -> ward 3D Tiles, non-destructive, resumable.
//   node tools/mission79-run.mjs --ward nishi [--limit-meshes 2] [--work <dir>] [--legacy <tilesetDir>] [--max-mb 400] [--dry-run]
// Stages: (0) source lock must exist (tools/mission79-plateau2025-source.mjs)  (1) select meshes whose bbox intersects the
// N03 ward bbox  (2) fetch bldg+tran by HTTP Range (sha256 manifest, resume)  (3) CityGML->JSONL (tools/mission36k-convert-citygml-runtime.mjs,
// unchanged)  (4) classify by N03 + 500m tiles + 3D Tiles + crosswalk + alignment (tools/mission79-build-ward-2025.cjs).
// Never writes outside --work (default temp/mission79/<ward>); refuses a non-empty final output dir. Stops at first failure.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const T = (f) => path.join(ROOT, 'tools', f);

export function mesh3Bounds(code) {
  const s = String(code);
  if (!/^\d{8}$/.test(s)) throw new Error('bad mesh ' + code);
  const south = Number(s.slice(0, 2)) / 1.5 + Number(s[4]) * (5 / 60) + Number(s[6]) * (30 / 3600);
  const west = Number(s.slice(2, 4)) + 100 + Number(s[5]) * (7.5 / 60) + Number(s[7]) * (45 / 3600);
  return { south, west, north: south + 30 / 3600, east: west + 45 / 3600 };
}
export function runtimeToGeo(x, z, p) {
  return { lat: p.centerLat - z / p.metersPerDegree, lon: x / (Math.cos(p.centerLat * Math.PI / 180) * p.metersPerDegree) + p.centerLon };
}
export function selectMeshes(lock, ward, projection) {
  const bb = ward.bbox;
  const c = [runtimeToGeo(bb.minX, bb.minZ, projection), runtimeToGeo(bb.maxX, bb.maxZ, projection), runtimeToGeo(bb.minX, bb.maxZ, projection), runtimeToGeo(bb.maxX, bb.minZ, projection)];
  const g = { south: Math.min(...c.map((p) => p.lat)), north: Math.max(...c.map((p) => p.lat)), west: Math.min(...c.map((p) => p.lon)), east: Math.max(...c.map((p) => p.lon)) };
  const hit = (m) => { const b = mesh3Bounds(m); return !(b.east < g.west || b.west > g.east || b.north < g.south || b.south > g.north); };
  const meshes = [...new Set(lock.entries.filter((e) => e.kind === 'bldg' && e.mesh && hit(e.mesh)).map((e) => e.mesh))].sort();
  return { geoBbox: g, meshes };
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const wardId = opt('ward');
  if (!wardId) throw new Error('--ward required');
  const lock = JSON.parse(fs.readFileSync('data/reports/mission79/source-lock.json', 'utf8'));
  const area = JSON.parse(fs.readFileSync('config/areas/osaka-city.json', 'utf8'));
  const polys = JSON.parse(fs.readFileSync('data/processed/osaka-city/boundaries/ward-classification-polygons.json', 'utf8'));
  const ward = polys.wards.find((w) => w.wardId === wardId);
  if (!ward) throw new Error('unknown ward ' + wardId);
  const sel = selectMeshes(lock, ward, area.projection);
  let meshes = sel.meshes;
  if (opt('meshes')) meshes = opt('meshes').split(',');
  if (opt('limit-meshes')) meshes = meshes.slice(0, Number(opt('limit-meshes')));
  const ents = lock.entries.filter((e) => meshes.includes(e.mesh));
  const comp = ents.reduce((n, e) => n + e.compressedBytes, 0) / 1048576, infl = ents.reduce((n, e) => n + e.uncompressedBytes, 0) / 1048576;
  const plan = { ward: wardId, wardCode: ward.wardCode, meshes: meshes.length, files: ents.length, compressedMB: +comp.toFixed(1), inflatedMB: +infl.toFixed(1), meshList: meshes };
  console.log('[79 run] plan ' + JSON.stringify(plan));
  if (a.includes('--dry-run')) return;
  const maxMb = Number(opt('max-mb', 400));
  if (infl > maxMb) throw new Error('inflated ' + infl.toFixed(0) + 'MB exceeds --max-mb ' + maxMb);
  const work = path.resolve(opt('work', path.join('temp', 'mission79', wardId + '-work')));
  const final = path.resolve(opt('final', path.join('temp', 'mission79', wardId + '-2025')));
  if (fs.existsSync(final) && fs.readdirSync(final).length) throw new Error('final output exists and is non-empty: ' + final);
  const node = process.execPath;
  const run = (args) => execFileSync(node, args, { stdio: 'inherit', cwd: ROOT, maxBuffer: 1 << 28 });
  const csv = meshes.join(',');
  run([T('mission79-plateau2025-fetch.mjs'), '--meshes', csv, '--kinds', 'bldg', '--out', path.join(work, 'bldg'), '--max-mb', String(maxMb)]);
  run([T('mission79-plateau2025-fetch.mjs'), '--meshes', csv, '--kinds', 'tran', '--out', path.join(work, 'tran'), '--max-mb', String(maxMb)]);
  const jsonl = path.join(work, wardId + '.jsonl');
  run([T('mission36k-convert-citygml-runtime.mjs'), '--input', path.join(work, 'bldg'), '--output', jsonl, '--ward-hint', wardId]);
  const b = [T('mission79-build-ward-2025.cjs'), '--ward', wardId, '--jsonl', jsonl, '--tran', path.join(work, 'tran'), '--out', final];
  if (opt('legacy')) b.push('--legacy', opt('legacy'));
  run(b);
}
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); }
}
