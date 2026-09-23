#!/usr/bin/env node
// tools/audit/production-cutover-snapshot.js
// [Mission 35G §3/§12] cutover の前後で production の状態を同じ形で記録する。
//   --phase=pre  → data/reports/production-cutover-snapshot-pre.json
//   --phase=post → data/reports/production-cutover-snapshot-post.json
//
//   「何が変わって何が変わらなかったか」を後から差分で示せるようにするのが目的なので、
//   **前後で同じ関数が同じ項目を読む**こと（片方だけ手で書かない）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const M = (...s) => P('public', 'map-data', 'osaka-city', ...s);
const F = {
  prod: P('public', 'osaka_3d_buildings.html'),
  prot: P('public', 'osaka_3d_buildings.fullward-v3.html'),
  dev: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
};
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const tiles = (d) => { try { return fs.readdirSync(d).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f)).length; } catch { return 0; } };

/** HTML から読み取る production の設定。 */
export function htmlState(file) {
  let h; try { h = fs.readFileSync(file, 'utf-8'); } catch { return null; }
  const one = (re) => { const m = h.match(re); return m ? m[1] : null; };
  // [Mission 35J] visual の既定も記録する。cutover の前後で「何が変わって何が変わらなかったか」を
  //   建物データだけでなく見た目についても差分で示せるようにするため。
  const tuning = one(/let depthTuning = '([0-9A-Z]+)';/);
  const light = (() => {
    if (!tuning) return null;
    const blk = h.match(new RegExp(`'${tuning}': \\{[\\s\\S]*?STANDARD: \\{ exposure: ([\\d.]+), hemi: ([\\d.]+), sun: ([\\d.]+), fill: ([\\d.]+) \\}`));
    return blk ? { exposure: +blk[1], hemi: +blk[2], sun: +blk[3], fill: +blk[4] } : null;
  })();
  const walls = (() => {
    if (!tuning) return null;
    const m = h.match(new RegExp(`'${tuning}': \\{ wallLit: ([\\d.]+), wallDark: ([\\d.]+), baseDarken: ([\\d.]+), massDarken: ([\\d.]+)`));
    return m ? { wallLit: +m[1], wallDark: +m[2], baseDarken: +m[3], massDarken: +m[4] } : null;
  })();
  return {
    buildingsVersion: one(/let buildingsVersion = '([A-Z0-9]+)';/),
    buildProfile: one(/const LIVECITY_BUILD_PROFILE = '(\w+)';/),
    visualProfile: one(/let visualProfile = '([A-Z]+)';/),
    depthTuning: tuning,
    lightLevel: one(/let lightLevel = '([A-Z]+)';/),
    visualLight: light,
    visualWalls: walls,
    fillColorDepth: one(/const CR_FILL_COLOR_DEPTH = (0x[0-9a-f]{6});/),
    hasVisualDepth: /CR_DEPTH|DEPTH_TUNINGS/.test(h),
    roadRenderMode: one(/let roadRenderMode = '([A-Z0-9_]+)'/),
    stationUrl: one(/STATION_URL = '([^']+)'/),
    placeUrl: one(/PLACE_URL = '([^']+)'/),
    hasHighLod: /derived-v2-osmv2\/building-lod-high/.test(h),
    hasLabelDatasets: /labels\/station-labels\.json/.test(h),
    bytes: Buffer.byteLength(h),
    sha256: sha(file),
  };
}

/** production HTML が実際に読む配信データの件数。 */
export function dataState(buildingsVersion) {
  const nsBase = { V2N: 'derived-v2-osmv2', V3: 'derived-v2-osmv3', V4: 'derived-v4-final' }[buildingsVersion] || 'derived';
  const g = (p, k) => { const j = rj(M(...p.split('/'))); return j ? (j[k] ?? null) : null; };
  const arr = (p, k) => { const j = rj(M(...p.split('/'))); return j && Array.isArray(j[k]) ? j[k].length : null; };
  return {
    buildingNamespace: nsBase,
    buildingCount: g(`${nsBase}/building-placement/manifest.json`, 'canonicalBuildingCount'),
    buildingPolicyCounts: (rj(M(nsBase, 'building-placement', 'manifest.json')) || {}).policyCounts || null,
    buildingFactsTiles: tiles(M(nsBase, 'building-facts')),
    roads: g('derived/near/roads/manifest.json', 'featureCount'),
    rail: g('derived/near/rail/manifest.json', 'featureCount'),
    stations: g('derived/rail-stations.json', 'count'),
    water: g('derived/near/water/manifest.json', 'featureCount'),
    parks: g('derived/near/parks/manifest.json', 'featureCount'),
    placeLabels: arr('derived/place-labels.json', 'places'),
    stationLabels: arr('labels/station-labels.json', 'stations'),
    riverLabels: arr('labels/river-labels.json', 'rivers'),
    highLodBuildings: g('derived-v2-osmv2/building-lod-high/manifest.json', 'buildingCount'),
    refinedRoadSurface: (rj(P('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json')) || {}).indexedCount ?? null,
  };
}

export function snapshot() {
  const prod = htmlState(F.prod);
  return {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35G',
    production: prod,
    productionData: prod ? dataState(prod.buildingsVersion) : null,
    dev: htmlState(F.dev),
    protectedHtml: { sha256: sha(F.prot), bytes: (() => { try { return fs.statSync(F.prot).size; } catch { return null; } })() },
  };
}

if (isMainModule(import.meta.url)) {
  const phase = (process.argv.find((a) => a.startsWith('--phase=')) || '--phase=pre').slice(8);
  if (!['pre', 'post'].includes(phase)) { console.error('--phase=pre|post'); process.exit(1); }
  // [Mission 35J] cutover ごとにミッション名を付けて残す。
  //   `production-cutover-snapshot-{pre,post}.json` は「直近の cutover」の 1 枠しかないので、
  //   次の cutover が上書きすると過去のミッションの検査が参照先を失う（実際に 35G の検査が落ちた）。
  const mission = (process.argv.find((a) => a.startsWith('--mission=')) || '').slice(10) || null;
  const out = snapshot();
  out.phase = phase;
  out.snapshotMissionId = mission;
  const dests = [P('data', 'reports', `production-cutover-snapshot-${phase}.json`)];
  if (mission) dests.push(P('data', 'reports', `production-cutover-snapshot-${mission.toLowerCase()}-${phase}.json`));
  fs.mkdirSync(path.dirname(dests[0]), { recursive: true });
  for (const dest of dests) fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  const dest = dests[0];
  console.log('[snapshot]', phase, 'production 建物', out.production.buildingsVersion,
    out.productionData.buildingCount, '| profile', out.production.buildProfile);
  console.log('[snapshot] data', JSON.stringify(out.productionData));
  console.log('[snapshot] protected sha', out.protectedHtml.sha256 && out.protectedHtml.sha256.slice(0, 16));
  console.log('[snapshot] out', dest);
}
