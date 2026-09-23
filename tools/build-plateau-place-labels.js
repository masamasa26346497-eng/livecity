#!/usr/bin/env node
// tools/build-plateau-place-labels.js
// [Mission 33C §2/§3/§5] 北部を含む大阪市全域の地名を、PLATEAU の生 CityGML から作る。
//   OSM 抽出は北緯 34.735° より北に place/station ノードが無い（33A/33B で確認済み）。
//   一方 PLATEAU の建物には全市で gen:stringAttribute name="町丁目名称" と "区名" が入っている。
//   これを gml:id 単位で拾い、canonical V2N の建物重心と突き合わせて町丁目の代表点を出す。
//   geometry / 投影 / 建物データには触れない（ラベル位置を読むだけ）。
//   出力: data/processed/osaka-city/derived/plateau-place-labels.json
//         data/reports/plateau-place-labels.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { readZipEntries, extractEntry } from './lib/zip-reader.js';
import { readFileRetry } from './lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const RAW_DIR = P('data', 'raw', 'osaka-higashisumiyoshi');
const RAW_ZIP = P('data', 'raw', 'osaka-sumiyoshi', 'plateau', 'buildings-lod2', '2024', 'archive', 'CityGML_v4.zip');
const CANON = P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2');
const OUT = P('data', 'processed', 'osaka-city', 'derived', 'plateau-place-labels.json');
const REPORT = P('data', 'reports', 'plateau-place-labels.json');
const START = '<bldg:Building';

/** 「◯丁目」を落とした基準地名（OSM 側の集約と同じ規則） */
export function baseTownName(name) {
  return String(name).replace(/(?:[一二三四五六七八九十百]+|[0-9０-９]+)\s*(?:丁目|丁|条)$/, '').trim();
}
export function parseBuildingChunk(seg) {
  const idm = /gml:id="([^"]+)"/.exec(seg);
  if (!idm) return null;
  const town = /<gen:stringAttribute name="町丁目名称">\s*<gen:value>([^<]+)<\/gen:value>/.exec(seg);
  const ward = /<gen:stringAttribute name="区名">\s*<gen:value>([^<]+)<\/gen:value>/.exec(seg);
  if (!town) return null;
  return { id: idm[1], town: town[1].trim(), ward: ward ? ward[1].trim() : null };
}
function buildingStarts(text) {
  const out = [];
  for (let i = text.indexOf(START); i >= 0; i = text.indexOf(START, i + 1)) {
    const c = text[i + START.length];
    if (c === ' ' || c === '>' || c === '\n' || c === '\r' || c === '\t') out.push(i);
  }
  return out;
}
function scanText(text, sink) {
  const starts = buildingStarts(text);
  for (let i = 0; i < starts.length; i++) sink(parseBuildingChunk(text.slice(starts[i], starts[i + 1] ?? text.length)));
}
async function scanFile(file, sink) {
  return new Promise((resolve, reject) => {
    let carry = '';
    const rs = fs.createReadStream(file, { encoding: 'utf-8', highWaterMark: 8 * 1024 * 1024 });
    rs.on('data', (chunk) => {
      carry += chunk;
      const starts = buildingStarts(carry);
      if (starts.length < 2) return;
      for (let i = 0; i + 1 < starts.length; i++) sink(parseBuildingChunk(carry.slice(starts[i], starts[i + 1])));
      carry = carry.slice(starts[starts.length - 1]);
    });
    rs.on('end', () => { scanText(carry, sink); resolve(); });
    rs.on('error', reject);
  });
}

/** canonical V2N の PLATEAU 建物の重心（canonicalId → [x, z]） */
export function canonicalCentroids() {
  const map = new Map();
  for (const f of fs.readdirSync(CANON)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    const t = JSON.parse(readFileRetry(path.join(CANON, f)));
    const a = JSON.parse(readFileRetry(path.join(CANON, 'attributes', f))).attributes;
    for (const ft of t.features) {
      const at = a[ft.canonicalId];
      if (!at || at.source !== 'plateau-building' || !ft.centroid) continue;
      map.set(ft.canonicalId, { x: ft.centroid[0], z: ft.centroid[1], wardId: at.wardId || null, areaM2: ft.areaM2 || 0 });
    }
  }
  return map;
}

/** 町丁目ごとの集計器（1 棟ずつ流し込む。全建物を配列に溜めない = メモリを使わない） */
export function createTownAggregator() {
  const byKey = new Map();
  return {
    add(r) {
      const base = baseTownName(r.town);
      if (!base || base.length < 2) return;
      const key = (r.wardId || r.ward || '') + '|' + base;
      let g = byKey.get(key);
      if (!g) {
        g = { name: base, ward: r.ward || null, wardId: r.wardId || null, buildings: 0, chome: new Set(),
          sx: 0, sz: 0, sw: 0, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
        byKey.set(key, g);
      }
      const w = Math.max(1, r.areaM2 || 1);
      g.buildings++;
      if (g.chome.size < 40) g.chome.add(r.town);
      g.sx += r.x * w; g.sz += r.z * w; g.sw += w;
      if (r.x < g.minX) g.minX = r.x; if (r.x > g.maxX) g.maxX = r.x;
      if (r.z < g.minZ) g.minZ = r.z; if (r.z > g.maxZ) g.maxZ = r.z;
    },
    result() {
      const out = [];
      for (const g of byKey.values()) {
        const x = g.sx / g.sw, z = g.sz / g.sw;
        const spread = Math.round(Math.hypot(g.maxX - g.minX, g.maxZ - g.minZ) / 2);
        out.push({
          id: 'plateau_town:' + (g.wardId || g.ward || '') + ':' + g.name,
          name: g.name, ward: g.ward, wardId: g.wardId,
          buildings: g.buildings, chomeCount: g.chome.size, spreadM: spread,
          x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100,
        });
      }
      return out.sort((p, q) => q.buildings - p.buildings);
    },
  };
}

async function main() {
  const centroids = canonicalCentroids();
  const agg = createTownAggregator();
  const stat = { sources: 0, buildingsScanned: 0, matchedCanonical: 0, unmatched: 0, duplicates: 0 };
  const files = fs.readdirSync(RAW_DIR).filter((f) => /_bldg_\d+_op\.gml$/.test(f)).sort()
    .map((f) => ({ name: f, scan: (sink) => scanFile(path.join(RAW_DIR, f), sink) }));
  const zipEntries = fs.existsSync(RAW_ZIP) ? readZipEntries(RAW_ZIP).filter((e) => /bldg\/\d{8}_bldg_\d+_op\.gml$/.test(e.name)) : [];
  const sources = files.concat(zipEntries.map((e) => ({ name: e.name, scan: async (sink) => scanText(extractEntry(RAW_ZIP, e).toString('utf-8'), sink) })));
  const seen = new Set();
  for (const src of sources) {
    await src.scan((r) => {
      if (!r) return;
      stat.buildingsScanned++;
      const cid = 'cg_bldg_' + r.id;
      const c = centroids.get(cid);
      if (!c) { stat.unmatched++; return; }
      if (seen.has(cid)) { stat.duplicates++; return; }
      seen.add(cid);
      stat.matchedCanonical++;
      agg.add({ town: r.town, ward: r.ward, wardId: c.wardId, x: c.x, z: c.z, areaM2: c.areaM2 });
    });
    if (++stat.sources % 40 === 0) console.log(`[plateau-place] ${stat.sources}/${sources.length} sources, matched ${stat.matchedCanonical}`);
  }
  const towns = agg.result();
  const doc = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '33C',
    source: 'PLATEAU CityGML の gen:stringAttribute「町丁目名称」「区名」× canonical buildings-v2-osmv2 の重心',
    coordinateConvention: 'znorth-neg-v1',
    note: '大阪市全域（OSM 抽出が届かない北部を含む）。丁目は基準地名へ集約し、面積加重で代表点を出している。',
    counts: { towns: towns.length, buildings: stat.matchedCanonical },
    towns,
  };
  fs.writeFileSync(OUT, JSON.stringify(doc));
  fs.writeFileSync(REPORT, JSON.stringify({
    version: 1, generatedAt: doc.generatedAt, missionId: '33C', stat, counts: doc.counts,
    northTowns: towns.filter((t) => t.z < -14000).slice(0, 40).map((t) => `${t.name}(${t.ward || '-'}/${t.buildings})`),
    top: towns.slice(0, 25).map((t) => `${t.name}(${t.buildings})`),
  }, null, 2));
  return { doc, stat };
}

if (isMainModule(import.meta.url)) {
  main().then(({ doc, stat }) => {
    console.log('[plateau-place]', JSON.stringify(stat));
    console.log('[plateau-place] towns', doc.counts.towns);
    console.log('[plateau-place] north sample', doc.towns.filter((t) => t.z < -14000).slice(0, 18).map((t) => t.name).join(' '));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
