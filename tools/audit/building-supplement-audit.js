#!/usr/bin/env node
// tools/audit/building-supplement-audit.js  [Issue #65]
// 補完候補(GeoJSON/Overture CSV 抽出)を既存建物 footprint と比較し、一致/新規候補/保留に分類する差分監査 CLI。
//   node tools/audit/building-supplement-audit.js --candidates c.geojson --existing e.geojson \
//        --source overture --source-version 2026-10-21.0 [--license ODbL-1.0] [--acquired-at ISO] --out out.json
//   入力 GeoJSON は WGS84 の Polygon/MultiPolygon(内周・複数パート保持)。
//   properties: id,height,levels|num_floors,heightSource,heightEstimated,heightAccuracy,surveyDate,sources[]
//   データを書き換えない・公開配信へ出さない（出力は --out のみ）。
import fs from 'node:fs';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';
import { auditCandidates } from '../lib/building-supplement-diff.js';
import { isMainModule } from '../lib/paths.js';

const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : undefined; };
/** GeoJSON Polygon/MultiPolygon → polys[][][]（内周・複数パートを保持。座標は world {x,z}）。 */
export function toPolys(f) {
  const g = f.geometry; if (!g) return [];
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.map((p) => p.map((r) => r.map(([lon, lat]) => { const w = latLonToLiveCityWorld(lat, lon); return [w.x, w.z]; })));
}
export function loadFeatures(file, prefix) {
  const fc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return fc.features.map((f, i) => {
    const p = f.properties || {}, id = String(p.id ?? f.id ?? `${prefix}${i}`);
    return {
      id, polys: toPolys(f),
      height: num(p.height),
      levels: num(p.levels ?? p.num_floors ?? p.numFloors ?? p['building:levels']), // Overture num_floors 対応
      heightSource: p.heightSource, heightEstimated: p.heightEstimated, heightAccuracy: p.heightAccuracy,
      surveyDate: p.surveyDate, buildingPartOf: p.buildingPartOf,
      sourceDatasets: (p.sources || []).map((s) => (typeof s === 'string' ? s : s?.dataset)).filter(Boolean),
    };
  });
}
export function run(argv) {
  const a = {}; for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['candidates', 'existing', 'source', 'source-version', 'out']) if (!a[k]) throw new Error(`--${k} required`);
  const res = auditCandidates(loadFeatures(a.candidates, 'c'), loadFeatures(a.existing, 'e'),
    { source: a.source, sourceVersion: a['source-version'], license: a.license, acquiredAt: a['acquired-at'] });
  const s = res.summary, n = s.byDecision.NEW_CANDIDATE || 0;
  const out = { schema: 'livecity-supplement-audit-v1', note: '参照データに対する照合結果。網羅率ではない。', summary: { ...s, heightUnverifiedRate: n ? +(s.heightUnverified / n).toFixed(3) : null, heightEstimatedRate: n ? +(s.heightEstimated / n).toFixed(3) : null, heightUnknownRate: n ? +(s.heightUnknown / n).toFixed(3) : null }, records: res.records };
  fs.writeFileSync(a.out, JSON.stringify(out, null, 1));
  return out;
}
if (isMainModule(import.meta.url)) { const o = run(process.argv.slice(2)); console.log(JSON.stringify(o.summary, null, 1)); }
