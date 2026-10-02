#!/usr/bin/env node
// tools/build-derived-preview.js
// [Mission 31F §27] 代表地点の resolved / derived preview GeoJSON（LOD 別）。
//   外部 GIS で「Canonical → Derived の LOD 別 geometry」を目視確認するため。
//   出力: data/reports/derived-preview-<location>.geojson（LOD 別 layer）
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DERIVED = P('data', 'processed', 'osaka-city', 'derived');
const AREA = P('config', 'areas', 'osaka-city.json');
const OUT_DIR = P('data', 'reports', 'derived-preview');

const LOCATIONS = [
  { name: 'umeda', x: -250, z: -9600, r: 900 },
  { name: 'nakanoshima', x: -450, z: -8600, r: 900 },
  { name: 'okawa', x: -600, z: -11000, r: 1600 },
  { name: 'anjigawa', x: -6500, z: -7200, r: 2200 },
  { name: 'namba', x: -250, z: -6300, r: 900 },
  { name: 'tennoji', x: 350, z: -4600, r: 900 },
  { name: 'juso', x: -1450, z: -12400, r: 900 },
  { name: 'sumiyoshi', x: -250, z: -300, r: 1100 },
  { name: 'yumeshima', x: -13500, z: -8000, r: 2200 },
  { name: 'nanko', x: -9500, z: -3500, r: 2200 },
];
const LODS = ['far', 'mid', 'near', 'ultra-near'];
const LAYERS = ['water', 'roads', 'buildings', 'parks', 'rail'];

function projFromArea() {
  const p = JSON.parse(fs.readFileSync(AREA, 'utf-8')).projection;
  const cosf = Math.cos((p.centerLat * Math.PI) / 180);
  return (x, z) => [
    +(p.centerLon + x / (cosf * p.metersPerDegree)).toFixed(6),
    +(p.centerLat - z / p.metersPerDegree).toFixed(6),
  ];
}
function closeRing(rg) { return (rg.length && (rg[0][0] !== rg[rg.length - 1][0] || rg[0][1] !== rg[rg.length - 1][1])) ? [...rg, rg[0]] : rg; }

function tileRange(loc, size) {
  return {
    tx0: Math.floor((loc.x - loc.r) / size), tx1: Math.floor((loc.x + loc.r) / size),
    tz0: Math.floor((loc.z - loc.r) / size), tz1: Math.floor((loc.z + loc.r) / size),
  };
}

function main() {
  const toGeo = projFromArea();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const summary = [];

  for (const loc of LOCATIONS) {
    const feats = [];
    const counts = {};
    for (const layer of LAYERS) {
      for (const lod of LODS) {
        const mp = path.join(DERIVED, lod, layer, 'manifest.json');
        if (!fs.existsSync(mp)) continue;
        const size = JSON.parse(fs.readFileSync(mp, 'utf-8')).tileSize;
        const R = tileRange(loc, size);
        const seen = new Set();
        for (let tx = R.tx0; tx <= R.tx1; tx++) for (let tz = R.tz0; tz <= R.tz1; tz++) {
          const tp = path.join(DERIVED, lod, layer, `tile_${tx}_${tz}.json`);
          if (!fs.existsSync(tp)) continue;
          const t = JSON.parse(fs.readFileSync(tp, 'utf-8'));
          for (const d of (t.features || [])) {
            if (seen.has(d.canonicalId)) continue;
            const c = d.centroid || [d.bbox.minX, d.bbox.minZ];
            if (Math.hypot(c[0] - loc.x, c[1] - loc.z) > loc.r) continue;
            seen.add(d.canonicalId);
            // preview はサイズ抑制のため layer/lod ごと 300 件まで
            if ((counts[`${layer}/${lod}`] || 0) >= 300) continue;
            let geometry;
            if (d.geometryType === 'Polygon') geometry = { type: 'Polygon', coordinates: d.coordinates.map((rg) => closeRing(rg.map(([x, z]) => toGeo(x, z)))) };
            else if (d.geometryType === 'MultiPolygon') geometry = { type: 'MultiPolygon', coordinates: d.coordinates.map((poly) => poly.map((rg) => closeRing(rg.map(([x, z]) => toGeo(x, z))))) };
            else if (d.geometryType === 'LineString') geometry = { type: 'LineString', coordinates: d.coordinates.map(([x, z]) => toGeo(x, z)) };
            else if (d.geometryType === 'MultiLineString') geometry = { type: 'MultiLineString', coordinates: d.coordinates.map((l) => l.map(([x, z]) => toGeo(x, z))) };
            else continue;
            feats.push({
              type: 'Feature', geometry,
              properties: {
                canonicalId: d.canonicalId, layer, lod,
                toleranceM: d.simplificationToleranceM,
                sourceConfidence: d.sourceConfidence,
                correctionIds: (d.correctionIds || []).join(','),
                ...(d.attributes || {}),
              },
            });
            counts[`${layer}/${lod}`] = (counts[`${layer}/${lod}`] || 0) + 1;
          }
        }
      }
    }
    const gj = {
      type: 'FeatureCollection', name: `derived-preview-${loc.name}`,
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
      note: 'derived LOD 別 geometry。properties.lod で far/mid/near/ultra-near を切替表示。properties.toleranceM が simplify 量。',
      features: feats,
    };
    fs.writeFileSync(path.join(OUT_DIR, `${loc.name}.geojson`), JSON.stringify(gj));
    summary.push({ location: loc.name, featureCount: feats.length, byLayerLod: counts });
    console.log('  ' + loc.name.padEnd(12) + ' features ' + feats.length);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: '代表 10 地点 × 5 layer × 4 LOD の derived geometry preview。QGIS 等で properties.lod / properties.layer でフィルタ。',
    locations: summary,
  }, null, 2));
  console.log('保存: ' + toProjectRelativePath(OUT_DIR) + '/*.geojson');
}

if (isMainModule(import.meta.url)) main();
