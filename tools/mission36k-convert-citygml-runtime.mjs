#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const AREA_PATH = path.resolve(ROOT, 'config/areas/osaka-city.json');
const MAX_BUILDING_BYTES = 64 * 1024 * 1024;
const DEFAULT_HEIGHT = 3.0;
const DEFAULT_STOREY_HEIGHT = 3.0;

function parseArgs(argv) {
  const out = { input: null, output: null, wardHint: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--input=')) out.input = a.slice(8);
    else if (a === '--input') out.input = argv[++i];
    else if (a.startsWith('--output=')) out.output = a.slice(9);
    else if (a === '--output') out.output = argv[++i];
    else if (a.startsWith('--ward-hint=')) out.wardHint = a.slice(12);
    else if (a === '--ward-hint') out.wardHint = argv[++i];
  }
  if (!out.input || !out.output) throw new Error('usage: node tools/mission36k-convert-citygml-runtime.mjs --input <gml|dir> --output <jsonl> [--ward-hint sumiyoshi]');
  return out;
}

function findGmlFiles(input) {
  const abs = path.resolve(ROOT, input);
  const st = fs.statSync(abs);
  if (st.isFile()) return [abs];
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.gml$/i.test(ent.name)) out.push(p);
    }
  };
  walk(abs);
  return out.sort();
}

function projectLatLon(lat, lon, projection) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Non-finite geographic coordinate');
  const x = (lon - projection.centerLon) * Math.cos(projection.centerLat * Math.PI / 180) * projection.metersPerDegree;
  const z = -(lat - projection.centerLat) * projection.metersPerDegree;
  return [Math.round(x * 100) / 100, Math.round(z * 100) / 100];
}

function resolveLatLon(v1, v2) {
  // PLATEAU EPSG:6697 commonly serializes latitude then longitude. Detect instead of assuming.
  if (Math.abs(v1) <= 90 && Math.abs(v2) > 90 && Math.abs(v2) <= 180) return { lat: v1, lon: v2 };
  if (Math.abs(v2) <= 90 && Math.abs(v1) > 90 && Math.abs(v1) <= 180) return { lat: v2, lon: v1 };
  throw new Error(`Cannot infer geographic axis order from ${v1}, ${v2}`);
}

function parsePosList(text, projection) {
  const nums = text.trim().split(/\s+/).map(Number);
  if (nums.length < 6) return [];
  const dim = nums.length % 3 === 0 ? 3 : (nums.length % 2 === 0 ? 2 : 0);
  if (!dim) throw new Error(`Unexpected posList coordinate count: ${nums.length}`);
  const pts = [];
  for (let i = 0; i + dim - 1 < nums.length; i += dim) {
    const { lat, lon } = resolveLatLon(nums[i], nums[i + 1]);
    const [x, z] = projectLatLon(lat, lon, projection);
    const alt = dim === 3 ? nums[i + 2] : 0;
    pts.push([x, z, Number.isFinite(alt) ? alt : 0]);
  }
  return pts;
}

function firstMatch(xml, re) {
  const m = xml.match(re);
  return m ? m[1] : null;
}

function ringTextsIn(xml, sectionRe) {
  const sec = xml.match(sectionRe);
  if (!sec) return [];
  const rings = [];
  const re = /<gml:exterior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
  let m;
  while ((m = re.exec(sec[0]))) rings.push(m[1]);
  return rings;
}

function polygonArea(fp) {
  let a2 = 0;
  for (let i = 0; i < fp.length; i++) {
    const p = fp[i], q = fp[(i + 1) % fp.length];
    a2 += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a2) / 2;
}

function ccw(a,b,c) { return (c[1]-a[1])*(b[0]-a[0])-(b[1]-a[1])*(c[0]-a[0]); }
function segIntersect(p1,p2,p3,p4) {
  const d1=ccw(p3,p4,p1), d2=ccw(p3,p4,p2), d3=ccw(p1,p2,p3), d4=ccw(p1,p2,p4);
  return ((d1>0)!==(d2>0))&&((d3>0)!==(d4>0));
}
function selfIntersects(fp) {
  for (let i = 0; i < fp.length; i++) {
    for (let j = i + 2; j < fp.length; j++) {
      if (i === 0 && j === fp.length - 1) continue;
      if (segIntersect(fp[i], fp[(i+1)%fp.length], fp[j], fp[(j+1)%fp.length])) return true;
    }
  }
  return false;
}

function allPosLists(section, projection) {
  const out = [];
  const re = /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
  let m;
  while ((m = re.exec(section || ''))) out.push(...parsePosList(m[1], projection));
  return out;
}

function convertBuildingXml(id, xml, projection, meta) {
  let ringTexts = ringTextsIn(xml, /<bldg:lod0FootPrint>[\s\S]*?<\/bldg:lod0FootPrint>/);
  let footprintSource = 'lod0FootPrint';
  if (!ringTexts.length) {
    ringTexts = ringTextsIn(xml, /<bldg:GroundSurface\b[\s\S]*?<\/bldg:GroundSurface>/);
    footprintSource = 'GroundSurface';
  }

  let ring = null;
  if (ringTexts.length) {
    let bestArea = -1;
    for (const text of ringTexts) {
      const pts = parsePosList(text, projection);
      const fp = pts.map((p) => [p[0], p[1]]);
      const area = fp.length >= 3 ? polygonArea(fp) : -1;
      if (area > bestArea) { bestArea = area; ring = pts; }
    }
  }

  const lod1 = xml.match(/<bldg:lod1Solid>[\s\S]*?<\/bldg:lod1Solid>/)?.[0] || '';
  const lod1Points = allPosLists(lod1, projection);
  if (!ring && lod1) {
    const re = /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
    let m, best = null, bestAlt = Infinity;
    while ((m = re.exec(lod1))) {
      const pts = parsePosList(m[1], projection);
      if (pts.length < 3) continue;
      const avgAlt = pts.reduce((n,p) => n + p[2], 0) / pts.length;
      if (avgAlt < bestAlt) { bestAlt = avgAlt; best = pts; }
    }
    ring = best;
    footprintSource = 'lod1-lowest-ring';
  }
  if (!ring || ring.length < 3) return { skip: 'no-footprint' };

  let fp = ring.map((p) => [p[0], p[1]]);
  if (fp.length >= 2 && fp[0][0] === fp[fp.length-1][0] && fp[0][1] === fp[fp.length-1][1]) fp = fp.slice(0, -1);
  if (fp.length < 3 || fp.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return { skip: 'invalid-footprint' };
  if (selfIntersects(fp)) return { skip: 'self-intersection' };

  const measured = Number(firstMatch(xml, /<bldg:measuredHeight[^>]*>([\d.]+)<\/bldg:measuredHeight>/));
  const storeys = Number(firstMatch(xml, /<bldg:storeysAboveGround>(\d+)<\/bldg:storeysAboveGround>/));
  let h = 0, heightSource = '';
  if (measured > 0) { h = measured; heightSource = 'measuredHeight'; }
  else if (lod1Points.length) {
    const alts = lod1Points.map((p) => p[2]).filter(Number.isFinite);
    const dz = alts.length ? Math.max(...alts) - Math.min(...alts) : 0;
    if (dz > 0.5) { h = dz; heightSource = 'lod1-zRange'; }
  }
  if (!(h > 0) && storeys > 0) { h = storeys * DEFAULT_STOREY_HEIGHT; heightSource = 'storeys'; }
  if (!(h > 0)) { h = DEFAULT_HEIGHT; heightSource = 'default'; }
  h = Math.round(h * 10) / 10;

  const usage = firstMatch(xml, /<bldg:usage[^>]*>([^<]+)<\/bldg:usage>/) || '';
  const rec = {
    id,
    fp,
    z0: 0,
    dz: h,
    h,
    usage,
    ulabel: '',
    ward: meta.wardHint || '',
    sourceMesh: meta.mesh || null,
    sourceFile: meta.sourceFile,
    footprintSource,
    heightSource,
    coordinateConvention: 'znorth-neg-v1',
  };
  return { rec };
}

async function streamBuildings(file, onBuilding) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let buf = '';
  let inside = false;
  for await (const chunk of stream) {
    buf += chunk;
    while (true) {
      if (!inside) {
        const re = /<bldg:Building(?=[\s/>])/;
        const m = re.exec(buf);
        if (!m) {
          if (buf.length > 64) buf = buf.slice(-64);
          break;
        }
        buf = buf.slice(m.index);
        inside = true;
      }
      const tokRe = /<(\/?)bldg:Building(Part)?(?=[\s/>])/g;
      tokRe.lastIndex = 1;
      let depth = 1, t, closeEnd = -1;
      while ((t = tokRe.exec(buf))) {
        if (t[1] === '/') {
          depth--;
          if (depth === 0) { closeEnd = tokRe.lastIndex; break; }
        } else depth++;
      }
      if (closeEnd < 0) {
        if (buf.length > MAX_BUILDING_BYTES) throw new Error(`Building exceeds ${MAX_BUILDING_BYTES} bytes: ${path.basename(file)}`);
        break;
      }
      const gt = buf.indexOf('>', closeEnd - 1);
      const end = gt >= 0 ? gt + 1 : closeEnd;
      const xml = buf.slice(0, end);
      const id = (xml.match(/^<bldg:Building[^>]*\sgml:id="([^"]+)"/) || xml.match(/gml:id="([^"]+)"/))?.[1] || `noid-${Date.now()}-${Math.random()}`;
      await onBuilding(id, xml);
      buf = buf.slice(end);
      inside = false;
    }
  }
  if (inside) throw new Error(`Unclosed Building element in ${path.basename(file)}`);
}

const args = parseArgs(process.argv.slice(2));
const area = JSON.parse(fs.readFileSync(AREA_PATH, 'utf8'));
const projection = area.projection;
if (!projection || area.id !== 'osaka-city') throw new Error('Osaka runtime projection missing');
const files = findGmlFiles(args.input);
if (!files.length) throw new Error('No GML files found');
const output = path.resolve(ROOT, args.output);
fs.mkdirSync(path.dirname(output), { recursive: true });
const ws = fs.createWriteStream(output, { encoding: 'utf8' });
const seen = new Set();
const stats = { files: files.length, buildingElements: 0, converted: 0, duplicateIds: 0, skipped: {}, footprintSources: {}, heightSources: {} };

for (const file of files) {
  const mesh = (path.basename(file).match(/(^|[^0-9])(\d{8})(?=[^0-9]|$)/) || [])[2] || null;
  await streamBuildings(file, async (id, xml) => {
    stats.buildingElements++;
    if (seen.has(id)) { stats.duplicateIds++; return; }
    seen.add(id);
    const r = convertBuildingXml(id, xml, projection, { wardHint: args.wardHint, mesh, sourceFile: path.basename(file) });
    if (!r.rec) { stats.skipped[r.skip] = (stats.skipped[r.skip] || 0) + 1; return; }
    stats.converted++;
    stats.footprintSources[r.rec.footprintSource] = (stats.footprintSources[r.rec.footprintSource] || 0) + 1;
    stats.heightSources[r.rec.heightSource] = (stats.heightSources[r.rec.heightSource] || 0) + 1;
    if (!ws.write(JSON.stringify(r.rec) + '\n')) await new Promise((resolve) => ws.once('drain', resolve));
  });
  console.log(`[36K runtime-convert] ${path.basename(file)} converted=${stats.converted}`);
}
await new Promise((resolve, reject) => ws.end((err) => err ? reject(err) : resolve()));

const reportPath = output.replace(/\.jsonl$/i, '') + '.report.json';
fs.writeFileSync(reportPath, JSON.stringify({
  mission: '36K-citygml-runtime-conversion',
  generatedAt: new Date().toISOString(),
  input: args.input,
  output: args.output,
  wardHint: args.wardHint,
  coordinateConvention: 'znorth-neg-v1',
  projection,
  stats,
}, null, 2) + '\n');
console.log(JSON.stringify({ output, reportPath, coordinateConvention: 'znorth-neg-v1', stats }, null, 2));
