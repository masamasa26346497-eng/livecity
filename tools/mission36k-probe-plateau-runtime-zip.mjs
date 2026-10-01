import fs from 'node:fs';
import path from 'node:path';

const REPORT = path.resolve('data/reports/mission36k-building-source-discovery.json');
const OUT = path.resolve('data/reports/mission36k-runtime-zip-probe.json');
const discovery = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
const source = discovery.lighterRuntimeCandidates?.[0];
if (!source?.url) throw new Error('No lighter runtime candidate URL found');

const url = source.url;
const headersForReport = (headers) => Object.fromEntries([
  'content-length','content-type','accept-ranges','etag','last-modified','content-range'
].map((k) => [k, headers.get(k)]));

const headRes = await fetch(url, {
  method: 'HEAD',
  headers: { 'user-agent': 'LiveCity-Mission36K/1.0' },
  signal: AbortSignal.timeout(120000),
});
const head = {
  status: headRes.status,
  ok: headRes.ok,
  headers: headersForReport(headRes.headers),
};

async function rangeFetch(range) {
  const res = await fetch(url, {
    headers: {
      range,
      'user-agent': 'LiveCity-Mission36K/1.0',
      'accept-encoding': 'identity',
    },
    signal: AbortSignal.timeout(120000),
  });
  if (res.status !== 206) {
    try { await res.body?.cancel(); } catch {}
    return { status: res.status, headers: headersForReport(res.headers), bytes: null };
  }
  return {
    status: res.status,
    headers: headersForReport(res.headers),
    bytes: Buffer.from(await res.arrayBuffer()),
  };
}

const tail = await rangeFetch('bytes=-262144');
let zip = {
  rangeSupported: tail.status === 206,
  tailStatus: tail.status,
  tailHeaders: tail.headers,
  eocdFound: false,
  zip64: false,
  entries: null,
  centralDirectoryOffset: null,
  centralDirectorySize: null,
  sampleNames: [],
  inferredRoots: [],
  buildingPaths: [],
  mvtPaths: [],
  tilesetPaths: [],
};

if (tail.bytes) {
  const b = tail.bytes;
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd >= 0) {
    zip.eocdFound = true;
    const entries = b.readUInt16LE(eocd + 10);
    const cdSize = b.readUInt32LE(eocd + 12);
    const cdOffset = b.readUInt32LE(eocd + 16);
    zip.zip64 = entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
    zip.entries = entries;
    zip.centralDirectorySize = cdSize;
    zip.centralDirectoryOffset = cdOffset;

    if (!zip.zip64 && cdSize > 0 && cdSize <= 128 * 1024 * 1024) {
      const cdEnd = cdOffset + cdSize - 1;
      const cd = await rangeFetch(`bytes=${cdOffset}-${cdEnd}`);
      zip.centralDirectoryStatus = cd.status;
      zip.centralDirectoryHeaders = cd.headers;
      if (cd.bytes) {
        const names = [];
        let p = 0;
        while (p + 46 <= cd.bytes.length && cd.bytes.readUInt32LE(p) === 0x02014b50) {
          const nameLen = cd.bytes.readUInt16LE(p + 28);
          const extraLen = cd.bytes.readUInt16LE(p + 30);
          const commentLen = cd.bytes.readUInt16LE(p + 32);
          const name = cd.bytes.subarray(p + 46, p + 46 + nameLen).toString('utf8');
          names.push(name);
          p += 46 + nameLen + extraLen + commentLen;
        }
        zip.parsedCentralDirectoryEntries = names.length;
        zip.sampleNames = names.slice(0, 250);
        zip.inferredRoots = [...new Set(names.map((n) => n.split('/')[0]).filter(Boolean))].slice(0, 100);
        zip.tilesetPaths = names.filter((n) => /(^|\/)tileset\.json$/i.test(n)).slice(0, 200);
        zip.mvtPaths = names.filter((n) => /\.mvt$/i.test(n) || /(^|\/)mvt(\/|$)/i.test(n)).slice(0, 200);
        zip.buildingPaths = names.filter((n) => /(^|\/)(bldg|building|buildings)(\/|$)/i.test(n)).slice(0, 300);
        zip.extensions = Object.entries(names.reduce((acc, n) => {
          const base = n.split('/').pop() || '';
          const idx = base.lastIndexOf('.');
          const ext = idx >= 0 ? base.slice(idx).toLowerCase() : '(none)';
          acc[ext] = (acc[ext] || 0) + 1;
          return acc;
        }, {})).sort((a,b) => b[1]-a[1]).slice(0,30);
      }
    }
  }
}

const report = {
  mission: '36K',
  generatedAt: new Date().toISOString(),
  source: { id: source.id, name: source.name, format: source.format, url: source.url },
  head,
  zip,
  decisionHints: {
    canInspectRemotely: zip.rangeSupported && zip.eocdFound,
    has3dTiles: zip.tilesetPaths.length > 0,
    hasMvt: zip.mvtPaths.length > 0,
    hasBuildingScopedPaths: zip.buildingPaths.length > 0,
  },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  head,
  zip: {
    rangeSupported: zip.rangeSupported,
    eocdFound: zip.eocdFound,
    zip64: zip.zip64,
    entries: zip.entries,
    centralDirectorySize: zip.centralDirectorySize,
    parsedCentralDirectoryEntries: zip.parsedCentralDirectoryEntries,
    roots: zip.inferredRoots.slice(0, 20),
    tilesets: zip.tilesetPaths.slice(0, 20),
    mvtExamples: zip.mvtPaths.slice(0, 20),
    buildingExamples: zip.buildingPaths.slice(0, 20),
    extensions: zip.extensions,
  },
}, null, 2));
