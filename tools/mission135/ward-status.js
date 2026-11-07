#!/usr/bin/env node
// Mission 135: 24区それぞれの 建物/道路/河川(線)/河川(面) を「未取得 / 生成済 / WebGL検証済」で表示する。
//   node tools/mission135/ward-status.js --buildings-root <dir> --layers-root <dir> [--real-report <e2e.json>]
// WebGL検証済 は dataKind:'real' の e2e レポートに載った区だけ。合成 fixture のレポートは決して数えない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wardIndex } from './server.js';

export const LABEL = { 'not-acquired': '未取得', generated: '生成済', 'webgl-verified': 'WebGL検証済' };

export function verifiedLayersFromReport(report) {
  const out = new Map();
  if (!report || report.dataKind !== 'real' || !report.wards) return out; // 合成/不明は無視
  for (const [id, w] of Object.entries(report.wards)) {
    const px = w.pixels || {}, ok = (k) => px[k] && px[k].diff >= 1000 && w.layers && w.layers[k] && w.layers[k].cls === 'ready';
    out.set(id, { buildings: !!ok('buildings'), roads: !!ok('roads'), waterLine: !!ok('waterLine'), waterArea: !!ok('waterArea') });
  }
  return out;
}

/** Mission136 の実データ E2E レポート（real-buildings-only / real-water-surface-only）から区別の検証済みレイヤーを得る。合成混在は数えない。 */
export function verifiedFromMission136(reports) {
  const out = new Map();
  for (const r of reports || []) {
    if (!r || !r.allPassed || !r.ward) continue;
    const v = out.get(r.ward) || {};
    if (r.dataKind === 'real-buildings-only' && r.realBuildingsVerified === true) v.buildings = true;
    if (r.dataKind === 'real-water-surface-only') v.waterArea = true;
    out.set(r.ward, v);
  }
  return out;
}

export function wardStates({ buildingsRoot, layersRoot, footprintsRoot, polygons, realReport, mission136Reports }) {
  const verified = verifiedLayersFromReport(realReport), v136 = verifiedFromMission136(mission136Reports);
  return wardIndex({ buildingsRoot, layersRoot, footprintsRoot, polygons }).map((w) => {
    const v = { ...(verified.get(w.wardId) || {}), ...(v136.get(w.wardId) || {}) };
    w = { ...w, available: { ...w.available, buildings: w.available.buildings || w.available.buildingFootprints } };
    const st = (have, vk) => (have ? (v[vk] ? 'webgl-verified' : 'generated') : 'not-acquired');
    const layers = { buildings: st(w.available.buildings, 'buildings'), roads: st(w.available.roads, 'roads'), waterLine: st(w.available.waterways, 'waterLine'), waterArea: st(w.available.waterways || w.available.waterSurface, 'waterArea') };
    return { wardId: w.wardId, wardName: w.wardName, layers, allWebglVerified: Object.values(layers).every((s) => s === 'webgl-verified') };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const rr = opt('real-report') ? JSON.parse(fs.readFileSync(opt('real-report'), 'utf8')) : null;
  const m136 = (opt('m136-reports') || '').split(',').filter(Boolean).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const rows = wardStates({ buildingsRoot: path.resolve(opt('buildings-root') || '.'), layersRoot: path.resolve(opt('layers-root') || '.'), footprintsRoot: opt('footprints-root') ? path.resolve(opt('footprints-root')) : null, realReport: rr, mission136Reports: m136 });
  console.log('| 区 | 建物 | 道路 | 河川(線) | 河川(面) |\n|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.wardName} | ${['buildings', 'roads', 'waterLine', 'waterArea'].map((k) => LABEL[r.layers[k]]).join(' | ')} |`);
  console.log(`\nWebGL検証済（4レイヤー全て）: ${rows.filter((r) => r.allWebglVerified).length}/${rows.length}`);
}
