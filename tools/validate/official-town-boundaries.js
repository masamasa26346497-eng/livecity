#!/usr/bin/env node
// tools/validate/official-town-boundaries.js
// [Mission 35L §8] e-Stat 2020 小地域（町丁・字等）境界から作った 24 区の町丁目境界を検証する。
//
// 見るのは「作ったものが壊れていないか」だけ。境界そのものを推測で補完したり、
// 足りない区を埋めたりはしない（§5: 公式町丁目境界が取れない区だけ N03 区界へ落とす）。
//
//   - 大阪市 24 区すべてが対象になっているか
//   - polygon が 0 件の区が無いか
//   - ward 誤分類（町の位置が名乗っている区の外）が無いか
//   - MultiPolygon / hole が壊れていないか（ソースの構成と突き合わせる）
//   - DBF 属性と geometry の対応が崩れていないか
//   - znorth-neg-v1 へ変換した後も位置が正しいか（既存レイヤーと同じ枠に入るか）
//   - 異常に巨大な bbox や市域外の座標が無いか
//
// 出力: data/reports/official-town-boundaries-validation.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';

const P = (...s) => resolveProjectPath(path.join(...s));

export const SRC = {
  derived: P('public', 'map-data', 'osaka-city', 'derived', 'area-boundaries.json'),
  master: P('data', 'processed', 'osaka-city', 'boundaries', 'town-boundaries-2020.json'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  registry: P('config', 'wards', 'registry.json'),
  stations: P('public', 'map-data', 'osaka-city', 'derived', 'station-index.json'),
};
export const OUT = P('data', 'reports', 'official-town-boundaries-validation.json');

/** 大阪市 24 区。 */
export const EXPECTED_WARD_COUNT = 24;
/** 1 つの町丁目がこれより大きければ異常（大阪市の最長辺でも 25km 弱）。 */
export const MAX_TOWN_DIAG_M = 12000;
/** 市域 bbox からこれ以上はみ出したら異常。 */
export const CITY_BBOX_MARGIN_M = 500;
/** ward 誤分類の許容率（境界上の点や埋立地の細部で数件は起こりうる）。 */
export const WARD_MISMATCH_BUDGET_PCT = 2;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** リングの重心（面積重み無しの単純平均ではなく多角形重心）。 */
export function ringCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[i + 1];
    const cross = x1 * z2 - x2 * z1;
    a += cross; cx += (x1 + x2) * cross; cz += (z1 + z2) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) {
    const n = ring.length - 1 || 1;
    let sx = 0, sz = 0;
    for (let i = 0; i < n; i++) { sx += ring[i][0]; sz += ring[i][1]; }
    return [sx / n, sz / n];
  }
  return [cx / (6 * a), cz / (6 * a)];
}

export function run() {
  const t0 = Date.now();
  const errors = [], warnings = [];
  const doc = rj(SRC.derived);
  if (!doc) { errors.push('area-boundaries.json が無い（node tools/build-official-town-boundaries.js）'); }
  const master = rj(SRC.master);
  const areas = (doc && doc.areas) || [];
  const towns = areas.filter((a) => a.kind === 'town');
  const groups = areas.filter((a) => a.kind === 'town-group');
  const wards = areas.filter((a) => a.kind === 'ward');

  // ── 1. 24 区すべてに町丁目があるか ───────────────────────────────
  const byWard = {};
  for (const t of towns) byWard[t.wardName] = (byWard[t.wardName] || 0) + 1;
  const wardNames = wards.map((w) => w.wardName);
  const wardsWithoutTowns = wardNames.filter((w) => !byWard[w]);
  if (wards.length !== EXPECTED_WARD_COUNT) {
    errors.push(`区界が ${wards.length} 件（${EXPECTED_WARD_COUNT} 件のはず）`);
  }
  if (Object.keys(byWard).length !== EXPECTED_WARD_COUNT) {
    errors.push(`町丁目を持つ区が ${Object.keys(byWard).length} 件（${EXPECTED_WARD_COUNT} 件のはず）: 欠け=${wardsWithoutTowns.join(',')}`);
  }
  if (wardsWithoutTowns.length) errors.push('町丁目 0 件の区: ' + wardsWithoutTowns.join(','));

  // ── 2. 市域 bbox と異常な大きさ ──────────────────────────────────
  let MINX = Infinity, MAXX = -Infinity, MINZ = Infinity, MAXZ = -Infinity;
  for (const w of wards) {
    MINX = Math.min(MINX, w.bbox.minX); MAXX = Math.max(MAXX, w.bbox.maxX);
    MINZ = Math.min(MINZ, w.bbox.minZ); MAXZ = Math.max(MAXZ, w.bbox.maxZ);
  }
  const outside = [], huge = [], degenerate = [];
  let ringTotal = 0, multiRing = 0, maxDiag = 0;
  for (const t of towns) {
    const b = t.bbox;
    if (!b) { degenerate.push(t.id + ':bbox無し'); continue; }
    if (b.minX < MINX - CITY_BBOX_MARGIN_M || b.maxX > MAXX + CITY_BBOX_MARGIN_M
      || b.minZ < MINZ - CITY_BBOX_MARGIN_M || b.maxZ > MAXZ + CITY_BBOX_MARGIN_M) {
      outside.push(`${t.wardName}${t.name}`);
    }
    if (t.diag > MAX_TOWN_DIAG_M) huge.push(`${t.wardName}${t.name}=${Math.round(t.diag)}m`);
    maxDiag = Math.max(maxDiag, t.diag || 0);
    const rings = t.rings || [];
    if (!rings.length) { degenerate.push(t.id + ':リング無し'); continue; }
    if (rings.length > 1) multiRing++;
    ringTotal += rings.length;
    for (const r of rings) if (!Array.isArray(r) || r.length < 4) degenerate.push(t.id + ':頂点<4');
  }
  if (outside.length) errors.push(`市域外の町丁目 ${outside.length} 件: ` + outside.slice(0, 5).join(','));
  if (huge.length) errors.push(`異常に大きい町丁目 ${huge.length} 件: ` + huge.slice(0, 5).join(','));
  if (degenerate.length) errors.push(`geometry が壊れている ${degenerate.length} 件: ` + degenerate.slice(0, 5).join(','));

  // ── 3. ward 誤分類（重心を正式な区ポリゴンで引き直す）──────────────
  const wardPolys = (rj(SRC.wardPolys) || {}).wards || [];
  const registry = rj(SRC.registry);
  const idToName = new Map();
  for (const w of (registry && (registry.wards || registry)) || []) {
    if (w && w.id) idToName.set(w.id, w.name || w.wardName);
  }
  for (const w of wards) if (w.wardId) idToName.set(w.wardId, w.wardName);
  let checked = 0, mismatch = 0;
  const mismatchSamples = [];
  if (wardPolys.length) {
    for (const t of towns) {
      const rings = t.rings || [];
      if (!rings.length) continue;
      const [cx, cz] = ringCentroid(rings[0]);
      const hit = classifyPointToWard(cx, cz, wardPolys);
      if (!hit || !hit.wardId) continue;          // 区界の外（埋立地の細部など）は判定しない
      checked++;
      const name = idToName.get(hit.wardId) || null;
      if (name && name !== t.wardName) {
        mismatch++;
        if (mismatchSamples.length < 10) {
          mismatchSamples.push({ town: t.name, declared: t.wardName, byPolygon: name });
        }
      }
    }
  } else {
    warnings.push('ward-classification-polygons.json が無いので ward 誤分類を確認できていない');
  }
  const mismatchPct = checked ? +((mismatch / checked) * 100).toFixed(2) : 0;
  if (mismatchPct > WARD_MISMATCH_BUDGET_PCT) {
    errors.push(`ward 誤分類が ${mismatch}/${checked} 件（${mismatchPct}%）`);
  }

  // ── 4. DBF 属性と geometry の対応 ───────────────────────────────
  //   master 側は 1 レコード = 1 町丁目。key（KEY_CODE）が重複していないこと、
  //   名前・区名・geometry がそろっていることを見る。
  const mRecords = (master && (master.towns || master.records)) || [];
  const keys = new Set();
  let dupKey = 0, missingAttr = 0, missingGeom = 0;
  for (const r of mRecords) {
    const k = r.keyCode || r.key || r.id;
    if (k) { if (keys.has(k)) dupKey++; else keys.add(k); }
    if (!r.name || !r.wardName) missingAttr++;
    if (!r.rings || !r.rings.length) missingGeom++;
  }
  if (dupKey) errors.push(`KEY_CODE が重複している ${dupKey} 件`);
  if (missingAttr) errors.push(`属性（名称 / 区名）が欠けている ${missingAttr} 件`);
  if (missingGeom) errors.push(`geometry が欠けている ${missingGeom} 件`);
  if (mRecords.length && mRecords.length !== towns.length) {
    warnings.push(`master ${mRecords.length} 件 と 配信 ${towns.length} 件 が一致しない`);
  }

  // ── 5. znorth-neg-v1 の確認（既存レイヤーと同じ枠か）────────────────
  //   駅（35K の station-index）は同じ座標系。各区の町の重心から最寄り駅までの距離が
  //   常識的な範囲（数 km 以内）に収まっていれば、符号・向きが崩れていない。
  const stationDoc = rj(SRC.stations);
  const stations = (stationDoc && stationDoc.stations) || [];
  let frameChecked = 0, frameFar = 0, worst = 0, worstName = null;
  if (stations.length) {
    for (const t of towns) {
      const rings = t.rings || [];
      if (!rings.length) continue;
      const [cx, cz] = ringCentroid(rings[0]);
      let best = Infinity;
      for (const s of stations) {
        const d = Math.hypot(s.x - cx, s.z - cz);
        if (d < best) best = d;
      }
      frameChecked++;
      if (best > worst) { worst = best; worstName = t.wardName + t.name; }
      if (best > 4000) frameFar++;               // 大阪市内で最寄り駅 4km 超は座標破綻を疑う
    }
    if (frameFar) errors.push(`最寄り駅が 4km 以上離れている町丁目 ${frameFar} 件（座標系のずれを疑う）`);
  } else {
    warnings.push('station-index.json が無いので座標系の突き合わせをしていない');
  }

  const coordinateConvention = (doc && doc.coordinateConvention) || null;
  if (coordinateConvention !== 'znorth-neg-v1') {
    errors.push(`coordinateConvention が znorth-neg-v1 でない: ${coordinateConvention}`);
  }

  // ── 6. fallback の使用状況（§5: 使ったら理由を残す）──────────────
  const labelMap = (doc && doc.labelMap) || {};
  const fallbackWards = {};
  for (const v of Object.values(labelMap)) {
    if (v && typeof v.areaId === 'string' && v.areaId.startsWith('ward:')) {
      const w = v.wardName || v.areaId;
      fallbackWards[w] = (fallbackWards[w] || 0) + 1;
    }
  }

  const report = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35L',
    RESULT: errors.length ? 'FAIL' : 'PASS',
    classification: errors.length ? 'OFFICIAL_TOWN_BOUNDARIES_FAILED' : 'OFFICIAL_TOWN_BOUNDARIES_SUCCESS',
    coordinateConvention,
    source: (doc && doc.source) || null,
    counts: {
      towns: towns.length, townGroups: groups.length, wards: wards.length,
      wardsWithTowns: Object.keys(byWard).length,
      ringTotal, townsWithMultipleRings: multiRing,
      labelsToTown: Object.values(labelMap).filter((v) => v && String(v.areaId).startsWith('town')).length,
      labelsToWardFallback: Object.values(labelMap).filter((v) => v && String(v.areaId).startsWith('ward:')).length,
    },
    townsPerWard: Object.fromEntries(Object.entries(byWard).sort((a, b) => b[1] - a[1])),
    wardsWithoutTowns,
    cityBbox: { minX: MINX, maxX: MAXX, minZ: MINZ, maxZ: MAXZ },
    geometry: { maxTownDiagM: +maxDiag.toFixed(1), outsideCityBbox: outside.length, hugeTowns: huge.length, degenerate: degenerate.length },
    wardClassification: { checked, mismatch, mismatchPct, samples: mismatchSamples },
    attributes: { masterRecords: mRecords.length, duplicateKeyCodes: dupKey, missingAttributes: missingAttr, missingGeometry: missingGeom },
    frameCheck: { stations: stations.length, townsChecked: frameChecked, farFromAnyStation: frameFar,
      worstDistanceM: +worst.toFixed(1), worstTown: worstName },
    wardFallbackUsage: fallbackWards,
    errors, warnings,
    elapsedMs: Date.now() - t0,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  const r = run();
  console.log(JSON.stringify(r, null, 2));
  if (r.RESULT !== 'PASS') process.exitCode = 1;
}
