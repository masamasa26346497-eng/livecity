import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'public/map-data/osaka-city/facilities/facilities.json');
const OUT_DIR = path.join(ROOT, 'public/map-data/osaka-city/facilities/wards');
const MANIFEST = path.join(ROOT, 'public/map-data/osaka-city/facilities/ward-manifest.json');

const full = JSON.parse(fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, ''));
const records = Array.isArray(full) ? full : (full.records || []);
if (!records.length) throw new Error('facility dataset empty');

fs.mkdirSync(OUT_DIR, { recursive: true });
const byWard = new Map();
for (const r of records) {
  const wardId = String(r.wardId || '').trim();
  if (!wardId) continue;
  if (!byWard.has(wardId)) byWard.set(wardId, []);
  byWard.get(wardId).push(r);
}
if (byWard.size !== 24) throw new Error(`expected 24 wards, got ${byWard.size}`);

const manifest = {
  areaId: full.areaId || 'osaka-city',
  generatedAt: new Date().toISOString(),
  sourceRecordCount: records.length,
  wardCount: byWard.size,
  coordinateConvention: full.coordinateConvention || 'znorth-neg-v1',
  wards: [],
};

for (const [wardId, list] of [...byWard.entries()].sort(([a],[b]) => a.localeCompare(b))) {
  const wardName = list.find((x) => x.wardName)?.wardName || wardId;
  list.sort((a,b) => String(a.id || '').localeCompare(String(b.id || '')));
  const fileName = `${wardId}.json`;
  const payload = {
    areaId: manifest.areaId,
    wardId,
    wardName,
    generatedAt: manifest.generatedAt,
    coordinateConvention: manifest.coordinateConvention,
    recordCount: list.length,
    records: list,
  };
  fs.writeFileSync(path.join(OUT_DIR, fileName), JSON.stringify(payload) + '\n', 'utf8');
  manifest.wards.push({ wardId, wardName, recordCount: list.length, url: `wards/${fileName}` });
}

const sum = manifest.wards.reduce((n,w) => n + w.recordCount, 0);
if (sum !== records.length) throw new Error(`shard count mismatch: ${sum} != ${records.length}`);
fs.writeFileSync(MANIFEST, JSON.stringify(manifest) + '\n', 'utf8');
console.log(JSON.stringify({ sourceRecordCount: records.length, wardCount: byWard.size, shardRecordCount: sum }));
