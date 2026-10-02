#!/usr/bin/env node
// tools/audit/north-road-coverage.js
// [Mission 35E §3/§6/§7/§11] 旧 OSM road source と広域 PBF から取り直した source を比べる。
//
//   35D で建物について分かったこと: osaka-latest.osm.pbf は lat 34.73 で切れている。
//   道路でも同じかを緯度ヒストグラムで確かめ、区ごとに ways / 総延長 / 被覆率を出す。
//
//   §7 同じ OSM way ID は一意。新旧で二重にならないことを確かめる。
//   ここでは judge するだけで canonical も tile も書かない。
//   出力: data/reports/north-road-coverage.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const R = {
  oldSource: P('data', 'raw', 'osaka-city', 'roads-osm.osaka-latest-backup.json'),
  newSource: P('data', 'raw', 'osaka-city-wide', 'roads-osm.json'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  out: P('data', 'reports', 'north-road-coverage.json'),
};
/** §3 北側の重点確認区。 */
export const NORTH_WARDS = ['higashiyodogawa', 'yodogawa', 'asahi', 'nishiyodogawa', 'kita'];
/** 被覆率を測るセルの大きさ。道路が 1 本でも通るセルを「覆われている」とする。 */
export const COVERAGE_CELL_M = 200;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** 緯度ヒストグラム（0.01 度刻み）。 */
export function latHistogram(elements) {
  const h = {};
  for (const e of elements) {
    if (!e.geometry || !e.geometry.length) continue;
    let s = 0;
    for (const g of e.geometry) s += g.lat;
    const k = (Math.floor((s / e.geometry.length) * 100) / 100).toFixed(2);
    h[k] = (h[k] || 0) + 1;
  }
  return h;
}
/**
 * 北側の崖を探す。南から北へ見て、急に 1/10 以下へ落ちる緯度。
 * 35D の建物と同じ判定を使う（同じ現象なので同じ物差しで測る）。
 */
export function latitudeCliff(hist, minBefore = 500, ratio = 10) {
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
  let cliff = null;
  for (let i = 1; i < keys.length; i++) {
    const prev = hist[keys[i - 1].toFixed(2)], cur = hist[keys[i].toFixed(2)];
    if (prev >= minBefore && cur > 0 && prev / cur >= ratio) {
      cliff = { atLat: keys[i], before: prev, after: cur, ratio: +(prev / cur).toFixed(1) };
    }
    if (prev >= minBefore && (cur === 0 || cur == null)) cliff = { atLat: keys[i], before: prev, after: 0, ratio: Infinity };
  }
  return cliff;
}

/** way の総延長 [m]（world 座標で測る）。 */
export function wayLengthM(geometry) {
  let L = 0;
  for (let i = 1; i < geometry.length; i++) {
    const a = latLonToLiveCityWorld(geometry[i - 1].lat, geometry[i - 1].lon);
    const b = latLonToLiveCityWorld(geometry[i].lat, geometry[i].lon);
    L += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return L;
}

/** way の代表点（中点）の区。 */
export function wayWard(geometry, wards) {
  const m = geometry[Math.floor(geometry.length / 2)];
  const w = latLonToLiveCityWorld(m.lat, m.lon);
  const r = classifyPointToWard(w.x, w.z, wards);
  return r && r.wardId ? r.wardId : null;
}

/** 区ごとの ways / 延長 / 被覆セル。 */
export function summarize(elements, wards, cellM = COVERAGE_CELL_M) {
  const byWard = {};
  const cells = new Map();          // wardId -> Set(cellKey)
  const ids = new Set();
  let noGeom = 0, outside = 0;
  for (const e of elements) {
    if (!e.geometry || e.geometry.length < 2) { noGeom++; continue; }
    ids.add(e.id);
    const wid = wayWard(e.geometry, wards);
    if (!wid) { outside++; continue; }
    const w = (byWard[wid] = byWard[wid] || { ways: 0, lengthM: 0 });
    w.ways++;
    w.lengthM += wayLengthM(e.geometry);
    if (!cells.has(wid)) cells.set(wid, new Set());
    const set = cells.get(wid);
    for (const g of e.geometry) {
      const p = latLonToLiveCityWorld(g.lat, g.lon);
      set.add(Math.floor(p.x / cellM) + ',' + Math.floor(p.z / cellM));
    }
  }
  for (const [wid, s] of cells) byWard[wid].coveredCells = s.size;
  for (const w of Object.values(byWard)) w.lengthM = Math.round(w.lengthM);
  return { byWard, ids, noGeom, outside, total: elements.length };
}

export function run() {
  const t0 = Date.now();
  const oldDoc = rj(R.oldSource);
  const newDoc = rj(R.newSource);
  if (!oldDoc) throw new Error('旧 road source が無い: ' + R.oldSource);
  const wards = (rj(R.wardPolys) || {}).wards || [];

  const oldHist = latHistogram(oldDoc.elements || []);
  const oldSum = summarize(oldDoc.elements || [], wards);
  console.log('[road] 旧 source', oldSum.total, 'ways');

  let newHist = null, newSum = null;
  if (newDoc) {
    newHist = latHistogram(newDoc.elements || []);
    newSum = summarize(newDoc.elements || [], wards);
    console.log('[road] 新 source', newSum.total, 'ways');
  }

  // §6 区別の新旧比較
  const wardIds = [...new Set([...Object.keys(oldSum.byWard), ...(newSum ? Object.keys(newSum.byWard) : [])])].sort();
  const byWard = wardIds.map((wid) => {
    const o = oldSum.byWard[wid] || { ways: 0, lengthM: 0, coveredCells: 0 };
    const n = newSum ? (newSum.byWard[wid] || { ways: 0, lengthM: 0, coveredCells: 0 }) : null;
    return { wardId: wid, north: NORTH_WARDS.includes(wid),
      oldWays: o.ways, newWays: n ? n.ways : null, addedWays: n ? n.ways - o.ways : null,
      oldLengthM: o.lengthM, newLengthM: n ? n.lengthM : null,
      lengthGainPct: (n && o.lengthM) ? +(((n.lengthM - o.lengthM) / o.lengthM) * 100).toFixed(1) : null,
      oldCoveredCells: o.coveredCells || 0, newCoveredCells: n ? (n.coveredCells || 0) : null,
      cellGainPct: (n && o.coveredCells) ? +((((n.coveredCells || 0) - o.coveredCells) / o.coveredCells) * 100).toFixed(1) : null };
  });

  // §7 同じ way ID が新旧で重複しないこと（ID は一意なので、新は旧の上位集合になるはず）
  let removedWayIds = [], addedWayCount = null, oldNotInNew = 0;
  if (newSum) {
    for (const id of oldSum.ids) if (!newSum.ids.has(id)) { oldNotInNew++; if (removedWayIds.length < 30) removedWayIds.push(id); }
    addedWayCount = newSum.ids.size - (oldSum.ids.size - oldNotInNew);
  }

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35E',
    coverageCellM: COVERAGE_CELL_M, northWards: NORTH_WARDS,
    oldSource: { path: oldDoc._meta && oldDoc._meta.input, ways: oldSum.total,
      uniqueWayIds: oldSum.ids.size, outsideWards: oldSum.outside, noGeometry: oldSum.noGeom,
      latitudeCliff: latitudeCliff(oldHist),
      latitudeHistogramTop: Object.fromEntries(Object.entries(oldHist).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 12)) },
    newSource: newSum ? { path: newDoc._meta && newDoc._meta.input, ways: newSum.total,
      uniqueWayIds: newSum.ids.size, outsideWards: newSum.outside, noGeometry: newSum.noGeom,
      latitudeCliff: latitudeCliff(newHist),
      latitudeHistogramTop: Object.fromEntries(Object.entries(newHist).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 12)) } : null,
    duplicateCheck: newSum ? { oldUnique: oldSum.ids.size, newUnique: newSum.ids.size,
      oldWayIdsMissingFromNew: oldNotInNew, sampleMissing: removedWayIds,
      newWayIdsAdded: addedWayCount,
      // way ID は一意。新が旧を包含していれば、同じ道路が二重に入ることはない
      newIsSupersetOfOld: oldNotInNew === 0 } : null,
    byWard,
    northSummary: byWard.filter((w) => w.north).map((w) => ({ wardId: w.wardId,
      ways: w.oldWays + ' → ' + w.newWays, lengthKm: (w.oldLengthM / 1000).toFixed(1) + ' → ' + (w.newLengthM != null ? (w.newLengthM / 1000).toFixed(1) : '-'),
      cellGainPct: w.cellGainPct })),
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(R.out), { recursive: true });
  fs.writeFileSync(R.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[road] 旧 緯度の崖', JSON.stringify(o.oldSource.latitudeCliff));
  if (o.newSource) console.log('[road] 新 緯度の崖', JSON.stringify(o.newSource.latitudeCliff));
  if (o.duplicateCheck) console.log('[road] 新は旧の上位集合か', o.duplicateCheck.newIsSupersetOfOld,
    '（旧のみ ' + o.duplicateCheck.oldWayIdsMissingFromNew + ' / 追加 ' + o.duplicateCheck.newWayIdsAdded + '）');
  console.log('[road] 北側の区:');
  for (const w of o.byWard.filter((x) => x.north)) {
    console.log('   ', w.wardId.padEnd(18), 'ways', String(w.oldWays).padStart(5), '→', String(w.newWays).padStart(5),
      '| 延長 km', (w.oldLengthM / 1000).toFixed(1).padStart(7), '→', w.newLengthM != null ? (w.newLengthM / 1000).toFixed(1).padStart(7) : '-',
      '| 被覆セル', String(w.oldCoveredCells).padStart(5), '→', String(w.newCoveredCells).padStart(5),
      w.cellGainPct != null ? ('(+' + w.cellGainPct + '%)') : '');
  }
  console.log('[road] out', R.out);
}
