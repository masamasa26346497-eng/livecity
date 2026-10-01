#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const PROBE_PATH = path.resolve(ROOT, 'data/reports/mission36k-citygml-zip-probe.json');
const AREA_PATH = path.resolve(ROOT, 'config/areas/osaka-city.json');
const RUNTIME_MANIFEST_PATH = path.resolve(ROOT, 'public/map-data/osaka-city/buildings/manifest.json');
const REGISTRY_PATH = path.resolve(ROOT, 'config/wards/registry.json');

function parseArgs(argv) {
  const out = { ward: 'sumiyoshi', output: '/tmp/mission36k-citygml-ward', maxFiles: Infinity, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--ward=')) out.ward = arg.slice(7);
    else if (arg === '--ward') out.ward = argv[++i];
    else if (arg.startsWith('--out=')) out.output = arg.slice(6);
    else if (arg === '--out') out.output = argv[++i];
    else if (arg.startsWith('--max-files=')) out.maxFiles = Number(arg.slice(12));
    else if (arg === '--max-files') out.maxFiles = Number(argv[++i]);
  }
  if (!Number.isFinite(out.maxFiles) || out.maxFiles <= 0) out.maxFiles = Infinity;
  return out;
}

function mesh3Bounds(code) {
  const s = String(code);
  if (!/^\d{8}$/.test(s)) throw new Error(`Invalid third-level mesh code: ${code}`);
  const p = Number(s.slice(0, 2));
  const q = Number(s.slice(2, 4));
  const r = Number(s[4]);
  const u = Number(s[5]);
  const v = Number(s[6]);
  const w = Number(s[7]);
  const south = p / 1.5 + r * (5 / 60) + v * (30 / 3600);
  const west = q + 100 + u * (7.5 / 60) + w * (45 / 3600);
  return { south, west, north: south + 30 / 3600, east: west + 45 / 3600 };
}

function runtimeToGeo(x, z, projection) {
  const { centerLat, centerLon, metersPerDegree } = projection;
  const lat = centerLat - z / metersPerDegree;
  const lon = x / (Math.cos(centerLat * Math.PI / 180) * metersPerDegree) + centerLon;
  return { lat, lon };
}

function bboxIntersects(a, b) {
  return !(a.east < b.west || a.west > b.east || a.north < b.south || a.south > b.north);
}

async function fetchRange(url, start, end) {
  const res = await fetch(url, {
    headers: {
      range: `bytes=${start}-${end}`,
      'accept-encoding': 'identity',
      'user-agent': 'LiveCity-Mission36K/1.0',
    },
    signal: AbortSignal.timeout(120000),
  });
  if (res.status !== 206) {
    try { await res.body?.cancel(); } catch {}
    throw new Error(`Range HTTP ${res.status}: ${start}-${end}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function extractEntry(url, entry, dest) {
  const header = await fetchRange(url, entry.localOffset, entry.localOffset + 29);
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`Invalid local ZIP header: ${entry.name}`);
  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const comp = await fetchRange(url, dataStart, dataStart + entry.compressedBytes - 1);
  let data;
  if (entry.method === 0) data = comp;
  else if (entry.method === 8) data = zlib.inflateRawSync(comp);
  else throw new Error(`Unsupported compression method ${entry.method}: ${entry.name}`);
  if (entry.uncompressedBytes && data.length !== entry.uncompressedBytes) {
    throw new Error(`Inflated size mismatch ${entry.name}: ${data.length} != ${entry.uncompressedBytes}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
  return data.length;
}

const args = parseArgs(process.argv.slice(2));
const probe = JSON.parse(fs.readFileSync(PROBE_PATH, 'utf8'));
const area = JSON.parse(fs.readFileSync(AREA_PATH, 'utf8'));
const runtimeManifest = JSON.parse(fs.readFileSync(RUNTIME_MANIFEST_PATH, 'utf8'));
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const ward = registry.wards.find((w) => w.id === args.ward);
if (!ward) throw new Error(`Unknown ward id: ${args.ward}`);
if (!Array.isArray(runtimeManifest.datasets) || runtimeManifest.datasets.length !== 24) {
  throw new Error(`Runtime building manifest must contain 24 datasets; got ${runtimeManifest.datasets?.length}`);
}
const runtimeDataset = runtimeManifest.datasets.find((d) => d.wardId === args.ward);
const wb = runtimeDataset?.bounds;
if (!wb || ![wb.minX, wb.maxX, wb.minZ, wb.maxZ].every(Number.isFinite)) {
  throw new Error(`No valid runtime ward bounds: ${args.ward}`);
}

const geoCorners = [
  runtimeToGeo(wb.minX, wb.minZ, area.projection),
  runtimeToGeo(wb.minX, wb.maxZ, area.projection),
  runtimeToGeo(wb.maxX, wb.minZ, area.projection),
  runtimeToGeo(wb.maxX, wb.maxZ, area.projection),
];
const wardGeoBbox = {
  south: Math.min(...geoCorners.map((p) => p.lat)),
  north: Math.max(...geoCorners.map((p) => p.lat)),
  west: Math.min(...geoCorners.map((p) => p.lon)),
  east: Math.max(...geoCorners.map((p) => p.lon)),
};

const entries = probe.zip?.buildingEntries || [];
const candidates = entries.map((entry) => {
  const mesh = (path.basename(entry.name).match(/(^|[^0-9])(\d{8})(?=[^0-9]|$)/) || [])[2] || null;
  return mesh ? { ...entry, mesh, meshBounds: mesh3Bounds(mesh) } : null;
}).filter(Boolean).filter((e) => bboxIntersects(e.meshBounds, wardGeoBbox));

const uniqueMeshes = [...new Set(candidates.map((e) => e.mesh))].sort();
const selected = candidates.slice(0, args.maxFiles);
const compressedBytes = candidates.reduce((n, e) => n + e.compressedBytes, 0);
const uncompressedBytes = candidates.reduce((n, e) => n + e.uncompressedBytes, 0);
const url = probe.source?.url;
if (!url) throw new Error('Probe report does not contain source URL');
if (!candidates.length) throw new Error(`No CityGML building meshes intersect runtime bounds for ward=${args.ward}`);

const extracted = [];
if (!args.dryRun) {
  fs.rmSync(args.output, { recursive: true, force: true });
  fs.mkdirSync(args.output, { recursive: true });
  for (const entry of selected) {
    const dest = path.join(args.output, path.basename(entry.name));
    const bytes = await extractEntry(url, entry, dest);
    extracted.push({ mesh: entry.mesh, file: dest, bytes });
    console.log(`[36K ward-range] ${entry.mesh} ${bytes} bytes -> ${dest}`);
  }
}

const report = {
  mission: '36K-citygml-ward-range',
  generatedAt: new Date().toISOString(),
  wardId: args.ward,
  wardName: ward.name,
  wardCode: ward.code,
  wardRuntimeBounds: wb,
  wardGeoBbox,
  runtimeManifestGeneratedAt: runtimeManifest.generatedAt || null,
  selectionMethod: 'third-level mesh bbox intersects 24-ward runtime manifest bounds; deliberate safe overfetch, final buildings are N03 point-in-polygon classified',
  candidateEntries: candidates.length,
  candidateMeshes: uniqueMeshes,
  compressedBytes,
  uncompressedBytes,
  dryRun: args.dryRun,
  maxFiles: Number.isFinite(args.maxFiles) ? args.maxFiles : null,
  extracted,
};
const reportPath = path.resolve(ROOT, `data/reports/mission36k-citygml-range-${args.ward}.json`);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  ward: args.ward,
  wardGeoBbox,
  candidateEntries: candidates.length,
  candidateMeshes: uniqueMeshes,
  compressedMB: +(compressedBytes / 1048576).toFixed(1),
  uncompressedMB: +(uncompressedBytes / 1048576).toFixed(1),
  extracted: extracted.length,
  output: args.output,
  reportPath,
}, null, 2));
