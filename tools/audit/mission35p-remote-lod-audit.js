#!/usr/bin/env node
// Mission 35P: latest Osaka City PLATEAU remote LOD2/LOD3 audit.
// Uses HTTP Range requests so GitHub Actions does not download textures/other layers.
// It reads only building CityGML entries from the official CityGML ZIP and reuses
// Mission 34D's building-level completeness judgement (roof + wall + ground/closure).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildingStarts } from './plateau-source-inventory.js';
import { judgeBuilding } from './max-lod-reaudit.js';

const OUT_DIR = path.resolve('data/reports/mission35p');
const JSON_OUT = path.join(OUT_DIR, 'lod-audit.json');
const MD_OUT = path.join(OUT_DIR, 'SUMMARY.md');
const CKAN = process.env.PLATEAU_CKAN_BASE || 'https://www.geospatial.jp/ckan/api/3/action';
const MAX_BLDG_MB = Number(process.env.MISSION35P_MAX_BLDG_MB || 2500);
const UA = 'LiveCity-Mission35P/1.0';

const TARGETS = [
  ['梅田', 34.7025, 135.4959],
  ['新大阪', 34.7335, 135.5001],
  ['十三', 34.7202, 135.4820],
  ['本町', 34.6814, 135.5007],
  ['難波', 34.6659, 135.5013],
  ['天王寺', 34.6473, 135.5141],
  ['中之島', 34.6913, 135.4927],
  ['住吉', 34.6120, 135.4920],
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtMB = (n) => Math.round(n / 1024 / 1024 * 10) / 10;
const yearOf = (s) => Math.max(0, ...((String(s).match(/20(?:2[0-9]|1[0-9])/g) || []).map(Number)));

async function jget(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

async function discover() {
  const queries = ['3D都市モデル 大阪市', 'PLATEAU 大阪市', '27100 CityGML', '27100'];
  const packages = new Map();
  for (const q of queries) {
    const j = await jget(`${CKAN}/package_search?q=${encodeURIComponent(q)}&rows=100`);
    for (const p of (j.result?.results || [])) packages.set(p.id || p.name, p);
  }
  const eligible = [];
  for (const p of packages.values()) {
    const blob = [p.title, p.name, p.notes, ...(p.resources || []).flatMap(r => [r.name, r.url, r.description])].join(' ');
    if (!/PLATEAU|3D都市モデル/i.test(blob)) continue;
    if (!/27100|大阪市/.test(blob)) continue;
    const py = yearOf(blob);
    for (const r of (p.resources || [])) {
      const h = `${r.name || ''} ${r.description || ''} ${r.url || ''} ${r.format || ''}`;
      if (!/\.zip(?:\?|$)/i.test(r.url || '')) continue;
      if (!/citygml|city\s*gml|[_-]gml[_-]|建築物/i.test(h)) continue;
      if (/shape|shp|3d.?tiles|obj|geojson|las|texture/i.test(h)) continue;
      const ry = yearOf(h) || py;
      let score = ry * 100;
      if (/citygml/i.test(h)) score += 30;
      if (/27100/i.test(h)) score += 20;
      if (/大阪市/.test(h)) score += 10;
      eligible.push({ pkg: p, r, year: ry, score });
    }
  }
  eligible.sort((a, b) => b.score - a.score || Number(b.r.size || 0) - Number(a.r.size || 0));
  if (!eligible.length) throw new Error('大阪市PLATEAU CityGML ZIPをCKANから特定できませんでした');
  const x = eligible[0];
  return {
    packageId: x.pkg.name || x.pkg.id,
    packageTitle: x.pkg.title || x.pkg.name,
    packageYear: x.year,
    resourceName: x.r.name || '',
    resourceUrl: x.r.url,
    resourceSize: Number(x.r.size || 0),
    candidates: eligible.slice(0, 10).map(e => ({ title: e.pkg.title, year: e.year, name: e.r.name, url: e.r.url, size: e.r.size || 0 }))
  };
}

async function headInfo(url) {
  const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HEAD ${r.status}`);
  return { length: Number(r.headers.get('content-length') || 0), ranges: r.headers.get('accept-ranges') || '' };
}

async function range(url, start, end, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Range: `bytes=${start}-${end}` } });
      if (r.status !== 206) throw new Error(`Range要求が206で返らない (HTTP ${r.status})`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; if (i < tries) await sleep(1500 * i); }
  }
  throw last;
}

function findEOCD(tail) {
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

async function centralDirectory(url, length) {
  const tailSize = Math.min(length, 5 * 1024 * 1024);
  const tailStart = length - tailSize;
  const tail = await range(url, tailStart, length - 1);
  const e = findEOCD(tail);
  if (e < 0) throw new Error('ZIP EOCDが見つかりません');
  let count = tail.readUInt16LE(e + 10);
  let cdSize = tail.readUInt32LE(e + 12);
  let cdOffset = tail.readUInt32LE(e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    let loc = -1;
    for (let i = e - 20; i >= 0; i--) if (tail.readUInt32LE(i) === 0x07064b50) { loc = i; break; }
    if (loc < 0) throw new Error('Zip64 locatorが見つかりません');
    const z64Off = Number(tail.readBigUInt64LE(loc + 8));
    const z64 = await range(url, z64Off, z64Off + 55);
    if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('Zip64 EOCD不正');
    count = Number(z64.readBigUInt64LE(32));
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOffset = Number(z64.readBigUInt64LE(48));
  }
  let cd;
  if (cdOffset >= tailStart && cdOffset + cdSize <= length) cd = tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize);
  else cd = await range(url, cdOffset, cdOffset + cdSize - 1);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20), uncompSize = cd.readUInt32LE(p + 24), localOffset = cd.readUInt32LE(p + 42);
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      let q = p + 46 + nameLen, end = q + extraLen;
      while (q + 4 <= end) {
        const id = cd.readUInt16LE(q), sz = cd.readUInt16LE(q + 2);
        if (id === 1) {
          let z = q + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(z)); z += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(z)); z += 8; }
          if (localOffset === 0xffffffff) localOffset = Number(cd.readBigUInt64LE(z));
          break;
        }
        q += 4 + sz;
      }
    }
    entries.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function entryText(url, e) {
  const lh = await range(url, e.localOffset, e.localOffset + 29);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`local header不正: ${e.name}`);
  const nameLen = lh.readUInt16LE(26), extraLen = lh.readUInt16LE(28);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const comp = await range(url, start, start + e.compSize - 1);
  if (e.method === 0) return comp.toString('utf8');
  if (e.method === 8) return zlib.inflateRawSync(comp).toString('utf8');
  throw new Error(`未対応ZIP圧縮 method=${e.method}: ${e.name}`);
}

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, p = Math.PI / 180;
  const a = Math.sin((lat2-lat1)*p/2)**2 + Math.cos(lat1*p)*Math.cos(lat2*p)*Math.sin((lon2-lon1)*p/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function initWard() { return { buildings: 0, lod2Present: 0, lod2Complete: 0, lod3Present: 0, lod3Complete: 0, chosenLod2: 0, chosenLod3: 0 }; }
function inc(o, j) {
  o.buildings++;
  if (j.lod2?.present) o.lod2Present++;
  if (j.lod2?.complete) o.lod2Complete++;
  if (j.lod3?.present) o.lod3Present++;
  if (j.lod3?.complete) o.lod3Complete++;
  if (j.chosen === 2) o.chosenLod2++;
  if (j.chosen === 3) o.chosenLod3++;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const source = await discover();
  const hi = await headInfo(source.resourceUrl);
  if (!hi.length) throw new Error('CityGML ZIPのContent-Lengthを取得できません');
  const entries = await centralDirectory(source.resourceUrl, hi.length);
  const bldg = entries.filter(e => /\.gml$/i.test(e.name) && /(^|[/_\-])bldg([/_\-.]|$)|building/i.test(e.name));
  if (!bldg.length) throw new Error('ZIP内にbuilding GMLが見つかりません');
  const compressedBytes = bldg.reduce((s, e) => s + e.compSize, 0);
  if (compressedBytes > MAX_BLDG_MB * 1024 * 1024) throw new Error(`building GML圧縮合計 ${fmtMB(compressedBytes)}MB > 安全上限 ${MAX_BLDG_MB}MB`);

  const total = initWard(), wards = {}, high = [];
  let invalid = 0, segments = 0;
  const files = [];
  for (let fi = 0; fi < bldg.length; fi++) {
    const e = bldg[fi];
    console.log(`[35P] ${fi+1}/${bldg.length} ${e.name} (${fmtMB(e.compSize)}MB compressed)`);
    const text = await entryText(source.resourceUrl, e);
    const starts = buildingStarts(text);
    const fc = initWard();
    for (let k = 0; k < starts.length; k++) {
      const seg = text.slice(starts[k], k + 1 < starts.length ? starts[k+1] : text.length);
      segments++;
      const j = judgeBuilding(seg);
      if (!j) { invalid++; continue; }
      inc(total, j); inc(fc, j);
      const w = j.ward || '(ward-unknown)';
      wards[w] ||= initWard(); inc(wards[w], j);
      if (j.chosen >= 2 && Number.isFinite(j.lat) && Number.isFinite(j.lon)) high.push({ id: j.id, lat: j.lat, lon: j.lon, lod: j.chosen, ward: j.ward });
    }
    files.push({ name: e.name, compressedMB: fmtMB(e.compSize), uncompressedMB: fmtMB(e.uncompSize), ...fc });
  }

  const targets = TARGETS.map(([name, lat, lon]) => {
    let nearest = null, nd = Infinity, within500 = 0, within1000 = 0, lod3within1000 = 0;
    for (const b of high) {
      const d = distanceM(lat, lon, b.lat, b.lon);
      if (d < nd) { nd = d; nearest = b; }
      if (d <= 500) within500++;
      if (d <= 1000) { within1000++; if (b.lod === 3) lod3within1000++; }
    }
    return { name, lat, lon, highLodWithin500m: within500, highLodWithin1000m: within1000, lod3Within1000m: lod3within1000,
      nearestHighLodMeters: nearest ? Math.round(nd) : null, nearestHighLod: nearest };
  });

  const report = {
    mission: '35P', auditedAt: new Date().toISOString(), source: { ...source, headContentLength: hi.length, acceptRanges: hi.ranges },
    zip: { entries: entries.length, buildingGmlEntries: bldg.length, buildingCompressedMB: fmtMB(compressedBytes) },
    total, segments, invalidBuildings: invalid, wardBreakdown: wards, representativeAreas: targets, files,
    policy: { completeness: 'Mission34D judgeBuilding: Roof + Wall + Ground/Closure + minimum polygons/posLists', paidExternalService: false, productionChanged: false }
  };
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));

  const pct = (n, d) => d ? (100*n/d).toFixed(2) + '%' : '0%';
  const lines = [
    '# Mission 35P — Osaka PLATEAU LOD2/LOD3 remote audit', '',
    `- Dataset: **${source.packageTitle}** (${source.packageYear || 'year unknown'})`,
    `- Resource: ${source.resourceName}`,
    `- ZIP size: ${fmtMB(hi.length)} MB / building GML compressed: ${fmtMB(compressedBytes)} MB`,
    `- Building GML files: ${bldg.length}`,
    `- Buildings: **${total.buildings.toLocaleString()}**`,
    `- LOD2 present: **${total.lod2Present.toLocaleString()}** (${pct(total.lod2Present,total.buildings)})`,
    `- LOD2 complete: **${total.lod2Complete.toLocaleString()}** (${pct(total.lod2Complete,total.buildings)})`,
    `- LOD3 present: **${total.lod3Present.toLocaleString()}** (${pct(total.lod3Present,total.buildings)})`,
    `- LOD3 complete: **${total.lod3Complete.toLocaleString()}** (${pct(total.lod3Complete,total.buildings)})`, '',
    '## Representative areas', '',
    '| Area | high LOD <=500m | high LOD <=1km | LOD3 <=1km | nearest high LOD |', '|---|---:|---:|---:|---:|',
    ...targets.map(t => `| ${t.name} | ${t.highLodWithin500m} | ${t.highLodWithin1000m} | ${t.lod3Within1000m} | ${t.nearestHighLodMeters ?? '-'}m |`), '',
    '## Ward values from source attributes', '',
    '| Ward | buildings | LOD2 complete | LOD3 complete |', '|---|---:|---:|---:|',
    ...Object.entries(wards).sort((a,b)=>a[0].localeCompare(b[0],'ja')).map(([w,v]) => `| ${w} | ${v.buildings} | ${v.lod2Complete} | ${v.lod3Complete} |`), '',
    '> This audit uses only official public PLATEAU data and GitHub Actions. No paid external LOD creation service is used.'
  ];
  fs.writeFileSync(MD_OUT, lines.join('\n'));
  console.log(lines.join('\n'));
}

main().catch(e => { console.error('[Mission35P] FAIL:', e.stack || e.message); process.exit(1); });
