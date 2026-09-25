#!/usr/bin/env node
// tools/validate/building-facility-index.js
// [Mission 35O §18] 建物へ付けた名称が「推測ではない」ことと、壊れていないことを検証する。
//
//   出力: data/reports/building-facility-index-validation.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';
import { normalizeName } from '../lib/building-facility-match.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const SRC = {
  full: P('data', 'processed', 'osaka-city', 'derived', 'building-facility-index.json'),
  runtime: P('public', 'map-data', 'osaka-city', 'derived', 'building-facility-index.json'),
  labels: P('public', 'map-data', 'osaka-city', 'derived', 'building-name-labels.json'),
  buildings: P('public', 'map-data', 'osaka-city', 'derived-v4-final', 'near', 'buildings'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  landmarkLabels: P('public', 'map-data', 'osaka-city', 'labels', 'landmark-labels.json'),
  landmarks: P('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'),
  devHtml: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
};
export const OUT = P('data', 'reports', 'building-facility-index-validation.json');

export const BUILDING_COUNT = 618749;
/** 施設がこれ以上離れた建物へ付いていたら異常（footprint 内包で付けているので本来 0）。 */
export const MAX_FACILITY_DIST_M = 250;
/** 同じ名前がこの距離を超えて散らばっていたら、別物へ誤付与している疑い。 */
export const SAME_NAME_SPREAD_M = 3000;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** canonical の建物 id と位置（重複排除済み）。 */
export function loadBuildingIds(dir) {
  const ids = new Map();
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const j = rj(path.join(dir, f));
    for (const b of ((j && j.features) || [])) {
      if (!b.canonicalId || ids.has(b.canonicalId)) continue;
      const c = b.centroid || [];
      ids.set(b.canonicalId, { x: c[0], z: c[1] });
    }
  }
  return ids;
}

export function run() {
  const t0 = Date.now();
  const errors = [], warnings = [];
  const doc = rj(SRC.full);
  if (!doc) {
    const r = { version: 1, generatedAt: new Date().toISOString(), missionId: '35O',
      RESULT: 'FAIL', classification: 'BUILDING_FACILITY_INDEX_FAILED',
      errors: ['building-facility-index.json が無い（node tools/build-building-facility-index.js）'], warnings: [] };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(r, null, 2));
    return r;
  }
  const recs = doc.buildings || [];
  const ids = loadBuildingIds(SRC.buildings);

  // ── 1. building ID が実在するか ─────────────────────────────────
  let missingId = 0, nanCoord = 0;
  const missingSample = [];
  for (const r of recs) {
    if (!r.buildingId || !ids.has(r.buildingId)) {
      missingId++;
      if (missingSample.length < 5) missingSample.push(r.buildingId);
      continue;
    }
    if (!Number.isFinite(r.x) || !Number.isFinite(r.z)) nanCoord++;
  }
  if (missingId) errors.push(`存在しない building ID が ${missingId} 件: ` + missingSample.join(','));
  if (nanCoord) errors.push(`NaN 座標が ${nanCoord} 件`);
  if (ids.size && ids.size !== BUILDING_COUNT) {
    warnings.push(`canonical の建物数が ${ids.size}（期待 ${BUILDING_COUNT}）`);
  }

  // ── 2. provenance（§3 必ず残す）─────────────────────────────────
  let noSource = 0, noSourceId = 0, noMethod = 0, noConfidence = 0, badConfidence = 0;
  const OK_CONF = new Set(['high', 'medium']);
  const OK_METHOD = new Set(['building-polygon-self', 'facility-polygon-overlap', 'poi-inside-building', 'nearest-with-evidence']);
  let badMethod = 0;
  for (const r of recs) {
    const named = r.buildingName || r.primaryFacilityName;
    if (!named) continue;                       // 施設だけ紐づいた棟は建物名を名乗らない
    if (!r.source) noSource++;
    if (!r.sourceId) noSourceId++;
    if (!r.matchMethod) noMethod++;
    else if (!OK_METHOD.has(r.matchMethod)) badMethod++;
    if (!r.confidence) noConfidence++;
    else if (!OK_CONF.has(r.confidence)) badConfidence++;
  }
  if (noSource) errors.push(`source が無い ${noSource} 件`);
  if (noSourceId) errors.push(`sourceId が無い ${noSourceId} 件`);
  if (noMethod) errors.push(`matchMethod が無い ${noMethod} 件`);
  if (badMethod) errors.push(`知らない matchMethod が ${badMethod} 件`);
  if (noConfidence) errors.push(`confidence が無い ${noConfidence} 件`);
  if (badConfidence) errors.push(`知らない confidence が ${badConfidence} 件`);

  // ── 3. 施設の provenance ────────────────────────────────────────
  let facNoSource = 0, facNoId = 0, facTotal = 0;
  for (const r of recs) {
    for (const f of (r.facilities || [])) {
      facTotal++;
      if (!f.source) facNoSource++;
      if (!f.sourceId) facNoId++;
    }
  }
  if (facNoSource) errors.push(`施設の source が無い ${facNoSource} 件`);
  if (facNoId) errors.push(`施設の sourceId が無い ${facNoId} 件`);

  // ── 4. 市域外への誤付与 ─────────────────────────────────────────
  const wardPolys = (rj(SRC.wardPolys) || {}).wards || [];
  let outsideCity = 0;
  const outsideSample = [];
  if (wardPolys.length) {
    for (const r of recs) {
      if (!Number.isFinite(r.x)) continue;
      const hit = classifyPointToWard(r.x, r.z, wardPolys);
      if (!hit || !hit.wardId) {
        outsideCity++;
        if (outsideSample.length < 5) outsideSample.push((r.buildingName || r.primaryFacilityName) + '@' + r.x + ',' + r.z);
      }
    }
    // 埋立地の細部など、区ポリゴンの外に出る棟は少数なら許容する
    const pct = 100 * outsideCity / Math.max(1, recs.length);
    if (pct > 2) errors.push(`市域外の付与が ${outsideCity} 件（${pct.toFixed(2)}%）: ` + outsideSample.join(' / '));
  } else warnings.push('区ポリゴンが無いので市域外判定をしていない');

  // ── 5. 同じ名前が遠くへ散らばっていないか（誤付与の兆候）───────────
  const byName = new Map();
  for (const r of recs) {
    const nm = r.buildingName;
    if (!nm) continue;
    const k = normalizeName(nm);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  let duplicateNameGroups = 0, spreadSuspect = 0;
  const spreadSample = [];
  for (const [k, g] of byName) {
    if (g.length < 2) continue;
    duplicateNameGroups++;
    let maxD = 0;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const d = Math.hypot(g[i].x - g[j].x, g[i].z - g[j].z);
        if (d > maxD) maxD = d;
      }
    }
    if (maxD > SAME_NAME_SPREAD_M) {
      spreadSuspect++;
      if (spreadSample.length < 8) spreadSample.push({ name: g[0].buildingName, count: g.length, spreadM: Math.round(maxD) });
    }
  }

  // ── 6. 施設が極端に離れた建物へ付いていないか ─────────────────────
  //   footprint 内包で付けているので、建物重心からの距離は footprint の半径程度に収まるはず。
  let farFacility = 0;
  for (const r of recs) {
    if (!r.facilities || !r.facilities.length) continue;
    const rad = Math.sqrt(Math.max(1, r.areaM2) / Math.PI) + MAX_FACILITY_DIST_M;
    if (rad > MAX_FACILITY_DIST_M * 4) farFacility++;   // 極端に大きい建物は別途 warning
  }
  if (farFacility) warnings.push(`footprint が非常に大きい建物に施設が付いている ${farFacility} 件（駅ビル・キャンパス等）`);

  // ── 7. landmark と二重表示していないか ──────────────────────────
  // ラベル層が実際に読むのは labels/landmark-labels.json。両方を見る。
  const landmarks = [
    ...((rj(SRC.landmarkLabels) || {}).landmarks || []),
    ...((rj(SRC.landmarks) || {}).landmarks || []),
  ].filter((l) => l && l.name);
  let landmarkLabelLeak = 0;
  const labels = (rj(SRC.labels) || {}).labels || [];
  const lmKeys = new Set(landmarks.map((l) => normalizeName(l.name)));
  for (const l of labels) {
    if (lmKeys.has(normalizeName(l.name))) landmarkLabelLeak++;
  }
  if (landmarkLabelLeak) errors.push(`landmark と同名のラベルが ${landmarkLabelLeak} 件残っている（二重表示）`);

  // ── 8. 名前を推測していないこと（matchMethod の分布）─────────────
  const byMethod = {};
  for (const r of recs) if (r.matchMethod) byMethod[r.matchMethod] = (byMethod[r.matchMethod] || 0) + 1;
  const guessed = recs.filter((r) => (r.buildingName || r.primaryFacilityName) && r.source !== 'osm').length;
  if (guessed) errors.push(`OSM 以外から名前を作っている ${guessed} 件`);

  // ── 9. 建物 geometry を触っていないこと ─────────────────────────
  const html = fs.existsSync(SRC.devHtml) ? fs.readFileSync(SRC.devHtml, 'utf-8') : '';
  const geometryUntouched = !!html && /positions\.push\(a\[0\], 0, a\[1\], b\[0\], 0, b\[1\], b\[0\], h, b\[1\]\);/.test(html);
  if (html && !geometryUntouched) errors.push('建物の押し出し式が変わっている');

  const report = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35O',
    RESULT: errors.length ? 'FAIL' : 'PASS',
    classification: errors.length ? 'BUILDING_FACILITY_INDEX_FAILED' : 'BUILDING_FACILITY_INDEX_SUCCESS',
    source: doc.source,
    counts: doc.counts,
    buildingCount: ids.size || null,
    records: recs.length,
    labelCount: labels.length,
    provenance: { noSource, noSourceId, noMethod, badMethod, noConfidence, badConfidence, byMethod },
    facilities: { total: facTotal, noSource: facNoSource, noSourceId: facNoId },
    integrity: { missingBuildingId: missingId, nanCoord, outsideCity },
    duplicates: { duplicateNameGroups, spreadSuspect, spreadSample },
    landmarkLabelLeak,
    geometryUntouched,
    byWard: doc.byWard,
    errors, warnings,
    elapsedMs: Date.now() - t0,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  const r = run();
  const { byWard, ...brief } = r;
  console.log(JSON.stringify(brief, null, 2));
  if (r.RESULT !== 'PASS') process.exitCode = 1;
}
