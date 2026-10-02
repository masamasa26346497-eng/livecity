#!/usr/bin/env node
// tools/build-map-label-anchors.js
// [Mission 33A] 区名ラベルと公園名ラベルのアンカーを、既存の canonical データから作る。
//   - 区: public/map-data/osaka-city/boundaries/ward-classification-polygons.json（N03 2026）の
//         面積加重セントロイド（海・河川へ落ちない位置）。tools/lib/label-engine.js の関数を再利用。
//   - 公園: data/processed/osaka-city/canonical/parks の名称付きポリゴン。大きい公園だけを残し、
//         同名は最大面積の 1 つへまとめる（中之島公園・大阪城公園など）。
//   geometry / 投影 / 建物には触れない。ラベルを置く座標を書き出すだけ。
//   出力: data/processed/osaka-city/derived/map-label-anchors.json
//         public/map-data/osaka-city/derived/map-label-anchors.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { multiRingCentroidXZ, polygonCentroidXZ } from './lib/label-engine.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const WARD_POLYGONS = P('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const PARKS = P('data', 'processed', 'osaka-city', 'canonical', 'parks');
const OUT = [
  P('data', 'processed', 'osaka-city', 'derived', 'map-label-anchors.json'),
  P('public', 'map-data', 'osaka-city', 'derived', 'map-label-anchors.json'),
];
const REPORT = P('data', 'reports', 'map-label-anchors.json');

// 公園ラベルの下限。小さな児童遊園まで出すと文字だらけになる。
export const PARK_MAJOR_M2 = 40000;   // 40,000m² 以上 = 広域から出す（大阪城公園・鶴見緑地など）
export const PARK_MIN_M2 = 12000;     // 12,000m² 未満はラベルにしない

export function wardAnchors(doc) {
  const out = [];
  for (const w of (doc.wards || [])) {
    const rings = (w.polygons || []).map((p) => p.outer).filter((r) => Array.isArray(r) && r.length >= 3);
    if (!rings.length) continue;
    const c = multiRingCentroidXZ(rings);
    if (!c) continue;
    out.push({ id: 'ward:' + w.wardId, name: w.wardName, wardId: w.wardId, x: Math.round(c.x * 100) / 100, z: Math.round(c.z * 100) / 100 });
  }
  return out.sort((a, b) => a.wardId.localeCompare(b.wardId));
}

/** 名称付き公園を集め、同名は最大面積の 1 つだけ残す */
export function parkAnchors(features) {
  const byName = new Map();
  for (const f of features) {
    const name = f.name;
    if (!name || !Number.isFinite(f.areaM2) || f.areaM2 < PARK_MIN_M2) continue;
    const cur = byName.get(name);
    if (!cur || f.areaM2 > cur.areaM2) byName.set(name, f);
  }
  return [...byName.values()]
    .map((f) => ({
      id: 'park:' + f.name, name: f.name, areaM2: Math.round(f.areaM2),
      importance: f.areaM2 >= PARK_MAJOR_M2 ? 'major' : 'medium',
      x: Math.round(f.x * 100) / 100, z: Math.round(f.z * 100) / 100,
    }))
    .sort((a, b) => b.areaM2 - a.areaM2);
}

function readParkFeatures() {
  const out = [];
  if (!fs.existsSync(PARKS)) return out;
  for (const file of fs.readdirSync(PARKS)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(file)) continue;
    const j = JSON.parse(fs.readFileSync(path.join(PARKS, file), 'utf-8'));
    for (const f of (j.features || [])) {
      const name = f.attributes && f.attributes.name;
      if (!name) continue;
      const rings = f.geometryType === 'Polygon' ? [f.coordinates[0]] : (f.coordinates || []).map((p) => p[0]);
      const valid = rings.filter((r) => Array.isArray(r) && r.length >= 3);
      if (!valid.length) continue;
      const area = valid.reduce((s, r) => s + polygonCentroidXZ(r).area, 0);
      const c = multiRingCentroidXZ(valid);
      if (!c || !Number.isFinite(area)) continue;
      out.push({ name: String(name), areaM2: area, x: c.x, z: c.z });
    }
  }
  return out;
}

async function main() {
  const wards = wardAnchors(JSON.parse(fs.readFileSync(WARD_POLYGONS, 'utf-8')));
  const rawParks = readParkFeatures();
  const parks = parkAnchors(rawParks);
  const doc = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '33A',
    coordinateConvention: 'znorth-neg-v1',
    source: { wards: 'public/map-data/osaka-city/boundaries/ward-classification-polygons.json（N03 2026）', parks: 'data/processed/osaka-city/canonical/parks' },
    thresholds: { parkMajorM2: PARK_MAJOR_M2, parkMinM2: PARK_MIN_M2 },
    counts: { wards: wards.length, parks: parks.length, parkMajor: parks.filter((p) => p.importance === 'major').length },
    wards, parks,
  };
  const text = JSON.stringify(doc);
  for (const f of OUT) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  fs.writeFileSync(REPORT, JSON.stringify({
    version: 1, generatedAt: doc.generatedAt, missionId: '33A', counts: doc.counts,
    namedParkFeatures: rawParks.length, topParks: parks.slice(0, 20).map((p) => `${p.name}(${p.areaM2}m²)`),
  }, null, 2));
  return doc;
}

if (isMainModule(import.meta.url)) {
  main().then((d) => {
    console.log('[label-anchors]', JSON.stringify(d.counts));
    console.log('[label-anchors] parks', d.parks.slice(0, 16).map((p) => p.name).join(' '));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
