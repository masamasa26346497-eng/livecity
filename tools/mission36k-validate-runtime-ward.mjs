#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = { ward: null, dir: null, resultDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--ward=')) out.ward = arg.slice(7);
    else if (arg === '--ward') out.ward = argv[++i];
    else if (arg.startsWith('--dir=')) out.dir = arg.slice(6);
    else if (arg === '--dir') out.dir = argv[++i];
    else if (arg.startsWith('--result-dir=')) out.resultDir = arg.slice(13);
    else if (arg === '--result-dir') out.resultDir = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.ward) throw new Error('--ward is required');
if (!args.dir) throw new Error('--dir is required');

const manifestPath = path.join(args.dir, 'manifest.json');
if (!fs.existsSync(manifestPath)) throw new Error(`manifest missing: ${manifestPath}`);
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (m.id !== `osaka-${args.ward}`) throw new Error(`dataset id=${m.id}`);
if (m.coordinateConvention !== 'znorth-neg-v1') throw new Error(`coordinate=${m.coordinateConvention}`);
if (m.layout !== 'flat' || m.tileSize !== 500) throw new Error(`runtime layout mismatch: ${m.layout}/${m.tileSize}`);
if (!(m.totalBuildings > 1000)) throw new Error(`suspiciously low building count=${m.totalBuildings}`);
if (!(m.tileCount > 0)) throw new Error(`invalid tileCount=${m.tileCount}`);
if (!Array.isArray(m.tiles) || m.tiles.length !== m.tileCount) throw new Error('tile list mismatch');

let counted = 0;
for (const t of m.tiles) {
  const file = path.join(args.dir, t.file);
  if (!fs.existsSync(file)) throw new Error(`missing tile ${file}`);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (j.count !== j.buildings?.length) throw new Error(`tile count mismatch ${t.file}`);
  counted += j.count;
}
if (counted !== m.totalBuildings) throw new Error(`manifest total ${m.totalBuildings} != tile total ${counted}`);

const result = {
  wardId: args.ward,
  totalBuildings: m.totalBuildings,
  tileCount: m.tileCount,
  bounds: m.bounds,
};
if (args.resultDir) {
  fs.mkdirSync(args.resultDir, { recursive: true });
  fs.writeFileSync(path.join(args.resultDir, `${args.ward}.json`), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result));
