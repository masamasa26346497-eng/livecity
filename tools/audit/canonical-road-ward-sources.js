#!/usr/bin/env node
// tools/audit/canonical-road-ward-sources.js
// [Mission 31C2 §20/§21] 区ごとに canonical roads の source 状況を再評価する。
//   これまで東淀川区・淀川区・旭区は「道路 SOURCE_MISSING」だったが、その実体は
//   「OSM PBF が lat≈34.735 以北で切れている」ことによる OSM 属性の欠測であり、
//   geometry（道路区域面）は PLATEAU tran から取得できる。両者を混同すると
//   「道路が無い区」と「名前が付かない区」を取り違える。分けて報告する。
//
// 実行: node tools/audit/canonical-road-ward-sources.js
// 出力: data/reports/canonical-road-ward-sources.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { polygonAreaM2 } from '../lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DIR = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const WARDS = P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const OUT = P('data', 'reports', 'canonical-road-ward-sources.json');

function pip(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > pt[1]) !== (zj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function inWard(pt, w) {
  for (const p of w.polygons) {
    if (!pip(pt, p.outer)) continue;
    let hole = false;
    for (const h of (p.holes || [])) if (pip(pt, h)) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

async function main() {
  if (!fs.existsSync(path.join(DIR, 'manifest.json'))) { console.error('canonical roads が無い'); process.exit(1); }
  const wards = JSON.parse(fs.readFileSync(WARDS, 'utf-8')).wards;
  const acc = new Map();
  for (const w of wards) acc.set(w.wardName, {
    wardName: w.wardName, wardId: w.wardId, wardCode: w.wardCode,
    featureCount: 0, polygonCount: 0, ribbonCount: 0,
    withOsmAttributes: 0, attributesSourceMissing: 0, named: 0,
    areaM2: 0, confidenceSum: 0,
  });
  let outside = 0;

  const seen = new Set();
  for (const tf of fs.readdirSync(DIR).filter((f) => /^tile_.*\.json$/.test(f))) {
    const t = JSON.parse(fs.readFileSync(path.join(DIR, tf), 'utf-8'));
    for (const f of (t.features || [])) {
      if (seen.has(f.canonicalId)) continue;
      seen.add(f.canonicalId);
      const c = f.centroid;
      let hit = null;
      for (const w of wards) {
        const b = w.bbox;
        if (c[0] < b.minX || c[0] > b.maxX || c[1] < b.minZ || c[1] > b.maxZ) continue;
        if (inWard(c, w)) { hit = w.wardName; break; }
      }
      if (!hit) { outside++; continue; }
      const a = acc.get(hit);
      a.featureCount++;
      a.areaM2 += polygonAreaM2(f.geometryType, f.coordinates);
      a.confidenceSum += f.source.confidence;
      if (f.source.geometrySource === 'plateau-tran-road') a.polygonCount++; else a.ribbonCount++;
      if ((f.qaFlags || []).includes('attributes-source-missing')) a.attributesSourceMissing++;
      else a.withOsmAttributes++;
      if (f.attributes && f.attributes.name) a.named++;
    }
  }

  const rows = [...acc.values()].map((a) => ({
    ...a,
    areaM2: Math.round(a.areaM2),
    confidenceMean: a.featureCount ? +(a.confidenceSum / a.featureCount).toFixed(3) : null,
    // geometry と attributes を混同しない（§21 の核心）
    geometryStatus: a.polygonCount > 0 ? 'PASS (PLATEAU tran polygon)' : (a.ribbonCount > 0 ? 'FALLBACK (OSM ribbon)' : 'SOURCE_MISSING'),
    attributeStatus: a.withOsmAttributes === 0 ? 'SOURCE_MISSING (OSM 欠測)'
      : (a.attributesSourceMissing / Math.max(1, a.featureCount) > 0.9 ? 'MOSTLY_MISSING (OSM 欠測が大半)' : 'PARTIAL/OK'),
    osmAttributeCoverage: a.featureCount ? +(a.withOsmAttributes / a.featureCount).toFixed(3) : 0,
    confidenceSum: undefined,
  })).sort((x, y) => x.osmAttributeCoverage - y.osmAttributeCoverage);

  const geometryMissing = rows.filter((r) => r.geometryStatus === 'SOURCE_MISSING').map((r) => r.wardName);
  const attributeMissing = rows.filter((r) => r.attributeStatus.startsWith('SOURCE_MISSING') || r.attributeStatus.startsWith('MOSTLY_MISSING')).map((r) => r.wardName);

  const report = {
    generatedAt: new Date().toISOString(),
    dir: toProjectRelativePath(DIR),
    featureCount: seen.size,
    featuresOutsideAllWards: outside,
    principle: 'geometry（道路区域面）と attributes（名称・車線数等）の source を分けて評価する。'
      + 'PLATEAU tran により geometry は 24 区すべてで取得済み。OSM 欠測域では attributes だけが SOURCE_MISSING。',
    wardsWithGeometryMissing: geometryMissing,
    wardsWithAttributesMissing: attributeMissing,
    knownCause: 'osaka-latest.osm.pbf は lat≈34.735 で bbox clip されており、東淀川区・淀川区・旭区の北側に OSM 道路が存在しない。'
      + 'これは取り込みバグではなく source 側の範囲制約。31C2 以前はこれが「道路 SOURCE_MISSING」と同一視されていた。',
    byWard: rows,
    RESULT: geometryMissing.length === 0 ? 'GEOMETRY-COMPLETE' : 'GEOMETRY-INCOMPLETE',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await writeJson(OUT, report);
  console.log('[ward-sources] feature ' + seen.size + ' / 区外 ' + outside);
  console.log('  geometry SOURCE_MISSING の区: ' + (geometryMissing.length ? geometryMissing.join(', ') : 'なし'));
  console.log('  OSM attributes が欠測の区: ' + (attributeMissing.length ? attributeMissing.join(', ') : 'なし'));
  for (const r of rows.slice(0, 6)) console.log('  ' + r.wardName + ' feat ' + r.featureCount + ' / polygon ' + r.polygonCount + ' / OSM属性率 ' + r.osmAttributeCoverage + ' / ' + r.geometryStatus);
  console.log('保存: ' + toProjectRelativePath(OUT) + '  RESULT: ' + report.RESULT);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[ward-sources] 失敗:', e && e.stack || e); process.exit(1); });
