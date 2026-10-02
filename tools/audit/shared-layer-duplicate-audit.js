#!/usr/bin/env node
// tools/audit/shared-layer-duplicate-audit.js
// [Mission 35F §6/§7/§8/§10] 作り直した rail / water / parks について、
//   旧との件数差を区別に出し、**重複が増えていないか**を確かめる。
//
//   §10 の「duplicate = 0」は 2 つの意味で見る:
//     1. canonicalId の重複（同じ id が 2 回出てくる）
//     2. geometry の重複（別 id だが同じ形。source を混ぜたときに起きる）
//   source は丸ごと差し替えているので 1 は起きないはずだが、測って確かめる。
//
//   出力: data/reports/shared-layer-duplicate-audit.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';
import { NORTH_WARDS } from './osm-shared-source-coverage.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const D = {
  rail: P('data', 'processed', 'osaka-city', 'canonical', 'rail'),
  parks: P('data', 'processed', 'osaka-city', 'canonical', 'parks'),
  water: P('data', 'processed', 'osaka-city', 'canonical', 'water'),
  stations: P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'stations.json'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  baseline: P('data', 'reports', 'baselines', 'shared-layer-counts-35e.json'),
  out: P('data', 'reports', 'shared-layer-duplicate-audit.json'),
};
/** 35E 時点（＝旧 PBF 由来）の件数。35F の前後比較の基準。 */
export const BEFORE_35F = { rail: 2828, parks: 2954, water: 528, stations: 233 };
/** geometry が同じとみなす丸め（m）。 */
export const GEOM_ROUND_M = 0.1;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/**
 * canonical タイル群の feature を読む。
 *
 * **canonical のタイルは、複数タイルにまたがる feature を各タイルへ重複して載せる**
 * （1 本の鉄道路線が 8 タイルに出るのは仕様）。manifest の featureCount は
 * 一意な canonicalId の数なので、ここでも canonicalId で畳んでから数える。
 * 畳まずに数えると、正常なタイル跨ぎを「重複」と誤検出する（実際にそうなった）。
 */
export function loadFeatures(dir) {
  const byId = new Map();
  const raw = [];
  if (!fs.existsSync(dir)) return { features: [], tileRows: 0, spanningIds: 0 };
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    for (const ft of ((rj(path.join(dir, f)) || {}).features || [])) {
      raw.push(ft);
      const id = ft.canonicalId;
      if (id == null) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(ft);
    }
  }
  let spanning = 0;
  for (const arr of byId.values()) if (arr.length > 1) spanning++;
  return { features: [...byId.values()].map((a) => a[0]), byId, tileRows: raw.length, spanningIds: spanning };
}

/** feature の代表点。 */
export function repPoint(ft) {
  if (Array.isArray(ft.centroid) && ft.centroid.length >= 2) return ft.centroid;
  if (ft.bbox) return [(ft.bbox.minX + ft.bbox.maxX) / 2, (ft.bbox.minZ + ft.bbox.maxZ) / 2];
  return null;
}

/**
 * geometry の指紋。座標を丸めて並べたもの。
 * 同じ形が別 id で 2 つあれば二重表示になる。
 */
export function geomKey(ft) {
  const r = 1 / GEOM_ROUND_M;
  const flat = [];
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') { flat.push(Math.round(c[0] * r), Math.round(c[1] * r)); return; }
    for (const q of c) walk(q);
  };
  walk(ft.coordinates);
  if (!flat.length) return null;
  return ft.geometryType + '|' + flat.join(',');
}

/**
 * 重複を数える。**canonicalId で畳んだ後の feature 列**を渡すこと。
 * - duplicateIds: 同じ canonicalId が 2 回出てくる（畳んだ後なので本来 0）
 * - duplicateGeoms: **別の canonicalId なのに形がまったく同じ**（source を混ぜると起きる）
 * 数と見本は別に持つ。見本の配列長を数として報告すると、上限で頭打ちになる（実際にやった）。
 */
export function findDuplicates(features, sampleLimit = 20) {
  const seenId = new Set(), byGeom = new Map();
  let duplicateIds = 0, duplicateGeoms = 0;
  const idSamples = [], geomSamples = [];
  for (const ft of features) {
    const id = ft.canonicalId;
    if (id != null) {
      if (seenId.has(id)) { duplicateIds++; if (idSamples.length < sampleLimit) idSamples.push(id); }
      else seenId.add(id);
    }
    const g = geomKey(ft);
    if (!g) continue;
    if (byGeom.has(g)) {
      duplicateGeoms++;
      if (geomSamples.length < sampleLimit) geomSamples.push({ a: byGeom.get(g), b: id });
    } else byGeom.set(g, id);
  }
  return { total: features.length, distinctIds: seenId.size, distinctGeoms: byGeom.size,
    duplicateIds, duplicateGeoms, idSamples, geomSamples };
}

/** 同じ名前の点が近くにある組の数（乗換駅の検出。距離は m）。 */
export const INTERCHANGE_M = 150;
export function countNearSameName(pts, withinM = INTERCHANGE_M) {
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (!pts[i].name || pts[i].name !== pts[j].name) continue;
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z) < withinM) n++;
    }
  }
  return n;
}

/** 区別の件数。 */
export function compareStationInterchange() {
  const load = (p) => {
    const j = rj(p);
    if (!j || !j.elements) return null;
    return j.elements.filter((e) => e.type === 'node' && e.tags && e.tags.railway === 'station'
      && Number.isFinite(e.lat) && Number.isFinite(e.lon));
  };
  const oldEls = load(P('data', 'raw', 'osaka-city', 'railways-osm.osaka-latest-backup.json'));
  const newEls = load(P('data', 'raw', 'osaka-city', 'railways-osm.json'));
  if (!oldEls || !newEls) return null;
  const toPts = (els) => els.map((e) => {
    const w = latLonToLiveCityWorld(e.lat, e.lon);
    return { name: (e.tags && e.tags.name) || '', x: w.x, z: w.z };
  });
  const o = toPts(oldEls), n = toPts(newEls);
  const oPairs = countNearSameName(o), nPairs = countNearSameName(n);
  const oRate = o.length ? (oPairs / o.length) * 100 : 0;
  const nRate = n.length ? (nPairs / n.length) * 100 : 0;
  return { oldStations: o.length, newStations: n.length,
    oldPairs: oPairs, newPairs: nPairs,
    oldRatePct: +oRate.toFixed(1), newRatePct: +nRate.toFixed(1),
    rateIncreased: nRate > oRate + 1,
    note: '同名近接は乗換駅（JR / 私鉄 / 地下鉄が別 node）。率が上がっていなければ 35F が重複を増やしていない。' };
}

export function countByWard(features, wards) {
  const by = {};
  for (const ft of features) {
    const p = repPoint(ft);
    if (!p) continue;
    const w = classifyPointToWard(p[0], p[1], wards);
    const k = (w && w.wardId) || '(outside)';
    by[k] = (by[k] || 0) + 1;
  }
  return by;
}

export function run() {
  const t0 = Date.now();
  const wards = (rj(D.wardPolys) || {}).wards || [];
  const layers = {};
  for (const [id, dir] of [['rail', D.rail], ['parks', D.parks], ['water', D.water]]) {
    const loaded = loadFeatures(dir);
    const feats = loaded.features;
    const dup = findDuplicates(feats);
    const byWard = countByWard(feats, wards);
    const northTotal = NORTH_WARDS.reduce((a, w) => a + (byWard[w] || 0), 0);
    const southTotal = Object.entries(byWard)
      .filter(([k]) => k !== '(outside)' && !NORTH_WARDS.includes(k))
      .reduce((a, [, v]) => a + v, 0);
    layers[id] = { before35F: BEFORE_35F[id], after: feats.length,
      added: feats.length - BEFORE_35F[id],
      tileRows: loaded.tileRows, spanningIds: loaded.spanningIds,
      ...dup, byWard, northTotal, southTotal };
    console.log('[dup]', id.padEnd(6), BEFORE_35F[id], '→', feats.length,
      '（タイル行 ' + loaded.tileRows + ' / 跨ぎ ' + loaded.spanningIds + '）',
      '| id 重複', dup.duplicateIds, '| 形の重複', dup.duplicateGeoms,
      '| 北', northTotal, '/ 南', southTotal);
  }
  // 駅
  const st = rj(D.stations);
  const stations = st ? (st.stations || []) : [];
  const stIds = new Set(stations.map((s) => s.stationId));
  // 同じ名前の駅が近くに複数あるのは **乗換駅**（JR / 近鉄 / 地下鉄が別 node）で、
  //   OSM の元々の性質。絶対数で「重複」と判定してはいけない。
  //   35F が増やしたかどうかは **旧 source との率の比較** で見る（下の stationInterchange）。
  const stDupName = countNearSameName(stations.map((s) => ({ name: s.name, x: s.point[0], z: s.point[1] })));
  const stByWard = {};
  for (const s of stations) {
    const w = classifyPointToWard(s.point[0], s.point[1], wards);
    const k = (w && w.wardId) || '(outside)';
    stByWard[k] = (stByWard[k] || 0) + 1;
  }
  // 旧 source（バックアップ）の駅 node と比べて、乗換駅の割合が増えていないか
  const interchange = compareStationInterchange();
  layers.stations = { before35F: BEFORE_35F.stations, after: stations.length,
    added: stations.length - BEFORE_35F.stations,
    total: stations.length, distinctIds: stIds.size,
    duplicateIds: stations.length - stIds.size,
    nearSameNamePairs: stDupName,
    interchange,
    byWard: stByWard,
    northTotal: NORTH_WARDS.reduce((a, w) => a + (stByWard[w] || 0), 0) };
  console.log('[dup] 駅    ', BEFORE_35F.stations, '→', stations.length,
    '| id 重複', layers.stations.duplicateIds,
    '| 同名近接', stDupName, '（乗換駅。旧比率', interchange ? (interchange.oldRatePct + '% → ' + interchange.newRatePct + '%') : '-', '）');

  const duplicates = { rail: layers.rail.duplicateIds + layers.rail.duplicateGeoms,
    water: layers.water.duplicateIds + layers.water.duplicateGeoms,
    parks: layers.parks.duplicateIds + layers.parks.duplicateGeoms,
    // 駅は「同名近接の率が上がっていないか」で見る。絶対数は乗換駅ぶん元々ある。
    stations: (stations.length - stIds.size) + (interchange && interchange.rateIncreased ? 1 : 0) };

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35F',
    geomRoundM: GEOM_ROUND_M, northWards: NORTH_WARDS,
    before35F: BEFORE_35F, layers, duplicates,
    allClean: Object.values(duplicates).every((v) => v === 0),
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(D.out), { recursive: true });
  fs.writeFileSync(D.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[dup] 重複合計', JSON.stringify(o.duplicates), '| すべて 0:', o.allClean);
  console.log('[dup] out', D.out);
}
