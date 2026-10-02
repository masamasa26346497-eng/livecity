import fs from 'node:fs';
import path from 'node:path';

const DISCOVERY = path.resolve('data/reports/mission36k-building-source-discovery.json');
const OUT = path.resolve('data/reports/mission36k-citygml-zip-probe.json');
const discovery = JSON.parse(fs.readFileSync(DISCOVERY, 'utf8'));
const source = discovery.citygmlCandidates?.[0];
if (!source?.url) throw new Error('No CityGML candidate URL found');
const url = source.url;

const selectedHeaders = (h) => Object.fromEntries([
  'content-length','content-type','accept-ranges','etag','last-modified','content-range'
].map((k) => [k, h.get(k)]));

async function rangeFetch(range, timeout = 120000) {
  const res = await fetch(url, {
    headers: { range, 'accept-encoding': 'identity', 'user-agent': 'LiveCity-Mission36K/1.0' },
    signal: AbortSignal.timeout(timeout),
  });
  const headers = selectedHeaders(res.headers);
  if (res.status !== 206) {
    try { await res.body?.cancel(); } catch {}
    throw new Error(`Range request failed ${res.status} ${range}`);
  }
  return { status: res.status, headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

const headRes = await fetch(url, { method: 'HEAD', headers: { 'user-agent': 'LiveCity-Mission36K/1.0' }, signal: AbortSignal.timeout(120000) });
const contentLength = Number(headRes.headers.get('content-length') || 0);
if (!(contentLength > 0)) throw new Error('CityGML content-length unavailable');

const tailSize = Math.min(contentLength, 4 * 1024 * 1024);
const tailStart = contentLength - tailSize;
const tail = await rangeFetch(`bytes=${tailStart}-${contentLength - 1}`);
let eocd = -1;
for (let i = tail.bytes.length - 22; i >= 0; i--) {
  if (tail.bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('EOCD not found in CityGML ZIP tail');
let entries = tail.bytes.readUInt16LE(eocd + 10);
let cdSize = tail.bytes.readUInt32LE(eocd + 12);
let cdOffset = tail.bytes.readUInt32LE(eocd + 16);
const zip64 = entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
if (zip64) throw new Error('Zip64 CityGML archive not yet supported by this probe');
if (!(cdSize > 0 && cdSize < 256 * 1024 * 1024)) throw new Error(`Unexpected central directory size ${cdSize}`);
const cd = await rangeFetch(`bytes=${cdOffset}-${cdOffset + cdSize - 1}`);

const parsed = [];
let p = 0;
while (p + 46 <= cd.bytes.length && cd.bytes.readUInt32LE(p) === 0x02014b50) {
  const method = cd.bytes.readUInt16LE(p + 10);
  const compSize = cd.bytes.readUInt32LE(p + 20);
  const uncompSize = cd.bytes.readUInt32LE(p + 24);
  const nameLen = cd.bytes.readUInt16LE(p + 28);
  const extraLen = cd.bytes.readUInt16LE(p + 30);
  const commentLen = cd.bytes.readUInt16LE(p + 32);
  const localOffset = cd.bytes.readUInt32LE(p + 42);
  const name = cd.bytes.subarray(p + 46, p + 46 + nameLen).toString('utf8');
  parsed.push({ name, method, compSize, uncompSize, localOffset });
  p += 46 + nameLen + extraLen + commentLen;
}

const files = parsed.filter((e) => !e.name.endsWith('/'));
const gml = files.filter((e) => /\.gml$/i.test(e.name));
const bldg = gml.filter((e) => /(^|[_/.-])bldg([_/.-]|$)|building|建築/i.test(e.name));
const allBldg = bldg.length ? bldg : gml;
const baseNames = allBldg.map((e) => path.basename(e.name));
const meshLike = baseNames.map((n) => (n.match(/(^|[^0-9])(\d{8})(?=[^0-9]|$)/) || [])[2]).filter(Boolean);
const uniqueMeshes = [...new Set(meshLike)].sort();
const extensions = Object.entries(files.reduce((a, e) => {
  const ext = path.extname(e.name).toLowerCase() || '(none)';
  a[ext] = (a[ext] || 0) + 1; return a;
}, {})).sort((a,b) => b[1]-a[1]);

const report = {
  mission: '36K-citygml-poc',
  generatedAt: new Date().toISOString(),
  source: { id: source.id, name: source.name, url },
  head: { status: headRes.status, headers: selectedHeaders(headRes.headers) },
  zip: {
    rangeSupported: true,
    contentLength,
    zip64,
    entriesDeclared: entries,
    entriesParsed: parsed.length,
    centralDirectoryOffset: cdOffset,
    centralDirectorySize: cdSize,
    fileCount: files.length,
    gmlCount: gml.length,
    buildingGmlCount: allBldg.length,
    meshCodeCount: uniqueMeshes.length,
    meshCodes: uniqueMeshes,
    extensions: extensions.slice(0, 30),
    buildingEntries: allBldg.map((e) => ({
      name: e.name,
      method: e.method,
      compressedBytes: e.compSize,
      uncompressedBytes: e.uncompSize,
      localOffset: e.localOffset,
    })),
  },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  contentLength,
  entries: parsed.length,
  gml: gml.length,
  buildingGml: allBldg.length,
  meshCodes: uniqueMeshes.length,
  firstBuildingEntries: report.zip.buildingEntries.slice(0, 20),
  extensions: report.zip.extensions,
}, null, 2));
