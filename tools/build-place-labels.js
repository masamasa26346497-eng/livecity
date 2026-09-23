#!/usr/bin/env node
// tools/build-place-labels.js
// [Mission 33A] 地名ラベル（梅田 / 中之島 / 北浜 / 心斎橋 …）のデータを、既存の OSM PBF から作る。
//   新しい外部取得はしない。data/raw/osm/osaka-latest.osm.pbf の place ノードだけを読み、
//   大阪市の bbox（canonical 建物と同じ znorth-neg-v1 ローカル座標）へ変換して出力する。
//   geometry / 投影 / 建物データには一切触れない（ラベルの位置情報のみ）。
//   出力: data/processed/osaka-city/derived/place-labels.json
//         public/map-data/osaka-city/derived/place-labels.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { pbfPrimitiveStream } from './lib/osm-pbf-stream.js';

const P = (...s) => resolveProjectPath(path.join(...s));
// [Mission 35F §3/§9] 旧 osaka-latest.osm.pbf は緯度 34.73 付近で切れており、
//   北部（東淀川・淀川・旭・西淀川・北区北部）の place ノードが入っていない。
//   広域 PBF があればそちらを使う。旧ファイルは消さない（フォールバック）。
export const OLD_PBF = P('data', 'raw', 'osm', 'osaka-latest.osm.pbf');
export const WIDE_PBF = P('data', 'raw', 'osm', 'osaka-full-coverage.osm.pbf');
export function resolvePbf(explicit) {
  if (explicit) return path.resolve(explicit);
  return fs.existsSync(WIDE_PBF) ? WIDE_PBF : OLD_PBF;
}
const PBF = resolvePbf();
const OUT = [
  P('data', 'processed', 'osaka-city', 'derived', 'place-labels.json'),
  P('public', 'map-data', 'osaka-city', 'derived', 'place-labels.json'),
];
const REPORT = P('data', 'reports', 'place-labels.json');
const STATIONS = P('public', 'map-data', 'osaka-city', 'derived', 'rail-stations.json');

// 投影は既存と同一（config/areas/osaka-city.json の local-equirectangular / znorth-neg-v1）
export const PROJ = { lat0: 34.604208, lon0: 135.52502, mpd: 111320 };
export const toLocal = (lat, lon) => ({
  x: (lon - PROJ.lon0) * Math.cos(PROJ.lat0 * Math.PI / 180) * PROJ.mpd,
  z: -((lat - PROJ.lat0) * PROJ.mpd),
});
// 大阪市 24 区の外接矩形（他の QA / validator と同じ値）
export const CITY_BBOX = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };

// place タグの扱い。大阪市の OSM は place=neighbourhood が「◯丁目」粒度で入っている（実測 2,880 件）。
//   そのままでは町丁目だらけになるので、「◯丁目」を落とした地名（梅田 / 中之島 / 難波 …）へ集約する。
export const PLACE_TYPES = ['suburb', 'quarter', 'neighbourhood'];
// 地名ラベルの階層。上位 60 = 広域地名（低ズームでも出す）、次の 200 = 中間、それ以外は近距離のみ
export const MAJOR_TOP_N = 60;
export const MEDIUM_TOP_N = 200;
const WARD_SUFFIX = /(区|市)$/;
// 「一丁目」「1丁目」「西二丁」などの丁目部分を落とした基準地名
export function baseName(name) {
  return String(name).replace(/(?:[一二三四五六七八九十百]+|[0-9０-９]+)\s*(?:丁目|丁|条)$/, '').trim();
}
export function classifyPlace(tags) {
  const place = tags && tags.place;
  if (!place || !PLACE_TYPES.includes(place)) return null;
  const name = tags['name:ja'] || tags.name;
  if (!name || WARD_SUFFIX.test(name)) return null;
  const base = baseName(name);
  if (!base || base.length < 2) return null;
  return { name: String(name), base, placeType: place };
}

/**
 * 町丁目を基準地名へ集約する。
 *   - 同じ基準地名の chome をまとめ、平均位置を label 位置にする
 *   - importance: 構成する丁目数と広がりで決める（多い / 広い ほど上位）
 *   - 同名の駅（「◯◯駅」の駅名から「駅」を除いたもの）が 1.5km 以内にあれば 1 段上げる
 *     （実データ同士の突き合わせ。ハードコードした地名リストは使わない）
 */
export function aggregatePlaces(raw, stations = []) {
  const byBase = new Map();
  for (const r of raw) {
    const g = byBase.get(r.base) || { base: r.base, members: [], types: new Set() };
    g.members.push(r); g.types.add(r.placeType);
    byBase.set(r.base, g);
  }
  const stationNames = stations.map((st) => ({ name: String(st.name).replace(/駅$/, ''), x: st.point ? st.point[0] : st.x, z: st.point ? st.point[1] : st.z }));
  const out = [];
  for (const g of byBase.values()) {
    const n = g.members.length;
    const x = g.members.reduce((a, m) => a + m.x, 0) / n;
    const z = g.members.reduce((a, m) => a + m.z, 0) / n;
    let spread = 0;
    for (const m of g.members) spread = Math.max(spread, Math.hypot(m.x - x, m.z - z));
    const st = stationNames.find((s2) => s2.name === g.base && Number.isFinite(s2.x) && Math.hypot(s2.x - x, s2.z - z) < 1500);
    // score: 地名としての広がり（丁目数・spread）+ 同名駅 + 周辺 600m の駅数（＝都市の中心性。実データ由来）
    const near = stationNames.filter((s2) => Number.isFinite(s2.x) && Math.hypot(s2.x - x, s2.z - z) < 600).length;
    const score = n + (st ? 4 : 0) + Math.min(near, 4) * 3 + Math.min(spread, 1500) / 400;
    out.push({
      id: 'place_' + g.base, name: g.base, score: Math.round(score * 100) / 100,
      placeType: g.types.has('suburb') ? 'suburb' : (g.types.has('quarter') ? 'quarter' : 'neighbourhood'),
      chomeCount: n, spreadM: Math.round(spread), nearStation: st ? st.name : null, stationsWithin600m: near,
      x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100,
    });
  }
  // 単独の町丁目（chome 1 個だけ = ただの町名）は地名ラベルにしない。ただし quarter/suburb は残す
  const kept = out.filter((p) => p.chomeCount >= 2 || p.placeType !== 'neighbourhood')
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ja'));
  // 上位から major / medium / local の 3 階層へ。上位層を絞って「広域地名だけが大きく出る」ようにする
  kept.forEach((p, i) => { p.importance = i < MAJOR_TOP_N ? 'major' : (i < MAJOR_TOP_N + MEDIUM_TOP_N ? 'medium' : 'local'); p.rank = i + 1; });
  return kept;
}

export async function collectPlaces(pbfPath = PBF) {
  const raw = [];
  const stat = { nodes: 0, placeNodes: 0, outsideBbox: 0, byType: {} };
  for await (const it of pbfPrimitiveStream(pbfPath)) {
    if (it.type !== 'node') continue;
    stat.nodes++;
    const c = classifyPlace(it.tags);
    if (!c) continue;
    stat.placeNodes++;
    const { x, z } = toLocal(it.lat, it.lon);
    if (x < CITY_BBOX.minX || x > CITY_BBOX.maxX || z < CITY_BBOX.minZ || z > CITY_BBOX.maxZ) { stat.outsideBbox++; continue; }
    stat.byType[c.placeType] = (stat.byType[c.placeType] || 0) + 1;
    raw.push({ ...c, x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, osm: 'node/' + it.id });
  }
  let stations = [];
  try { stations = JSON.parse(fs.readFileSync(STATIONS, 'utf-8')).stations || []; } catch (e) { /* 駅データが無くても集約はできる */ }
  const places = aggregatePlaces(raw, stations);
  stat.rawChome = raw.length;
  stat.aggregated = places.length;
  stat.stations = stations.length;
  return { places, stat };
}

async function main() {
  if (!fs.existsSync(PBF)) throw new Error('OSM PBF が無い: ' + PBF);
  const { places, stat } = await collectPlaces();
  const doc = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35F',
    source: 'data/raw/osm/' + path.basename(PBF) + '（既存。新規取得なし）',
    coordinateConvention: 'znorth-neg-v1', projection: PROJ, bbox: CITY_BBOX,
    note: 'OSM の place ノード（大阪市は丁目粒度）を基準地名へ集約したもの。区名・市名は除外（WardLabelLayer が担当）。'
      + '[35F] source を広域 PBF へ差し替え（旧 osaka-latest は緯度 34.73 で切れていた）。',
    counts: { total: places.length, byImportance: places.reduce((m, p) => ({ ...m, [p.importance]: (m[p.importance] || 0) + 1 }), {}) },
    places,
  };
  const text = JSON.stringify(doc);
  for (const f of OUT) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  fs.writeFileSync(REPORT, JSON.stringify({ version: 1, generatedAt: doc.generatedAt, missionId: '33A', stat, counts: doc.counts, sample: places.slice(0, 40).map((p) => p.name) }, null, 2));
  return { doc, stat };
}

if (isMainModule(import.meta.url)) {
  main().then(({ doc, stat }) => {
    console.log('[place-labels]', JSON.stringify({ ...stat, kept: doc.places.length }));
    console.log('[place-labels] sample', doc.places.slice(0, 30).map((p) => `${p.name}(${p.placeType})`).join(' '));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
