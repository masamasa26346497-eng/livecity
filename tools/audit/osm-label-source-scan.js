#!/usr/bin/env node
// tools/audit/osm-label-source-scan.js
// [Mission 33C §1/§2/§6/§10] ラベルに使える既存データを調べる（新規取得はしない）。
//   1) 駅: OSM PBF の railway=station/halt を全要素種別で集め、北部（lat > 34.735）の有無を確認する
//   2) ランドマーク候補: ミッションが挙げた施設名が実データに存在するかを名前一致で確認する
//      （way / relation は 2 パス目で構成ノードから重心を出す）
//   3) 河川: canonical water の名称付き feature を集計する
//   出力: data/reports/osm-label-source-scan.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const PBF = P('data', 'raw', 'osm', 'osaka-latest.osm.pbf');
const WATER = P('data', 'processed', 'osaka-city', 'canonical', 'water');
const OUT = P('data', 'reports', 'osm-label-source-scan.json');
export const PROJ = { lat0: 34.604208, lon0: 135.52502, mpd: 111320 };
export const toLocal = (lat, lon) => ({
  x: (lon - PROJ.lon0) * Math.cos(PROJ.lat0 * Math.PI / 180) * PROJ.mpd,
  z: -((lat - PROJ.lat0) * PROJ.mpd),
});
export const CITY_BBOX = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
export const NORTH_LIMIT_LAT = 34.735;   // これより北は OSM 抽出が薄いと分かっている境界

// §6 のランドマーク候補（この名前が実データにあるかどうかを調べるだけ。無ければ採用しない）
export const LANDMARK_CANDIDATES = [
  'グラングリーン大阪', 'うめきた公園', 'うめきた', '大阪駅', '大阪ステーションシティ', 'HEP FIVE', '梅田スカイビル',
  '大阪城', '大阪城公園', 'あべのハルカス', '通天閣', '京セラドーム大阪', '大阪市役所',
  '中之島美術館', '大阪中之島美術館', '国立国際美術館', '大阪市中央公会堂',
  'なんばパークス', 'なんばCITY', 'なんばこめじるし', '天王寺公園', 'てんしば', '天王寺動物園',
  '海遊館', '大阪港', '大阪府咲洲庁舎', 'インテックス大阪', '万博記念公園', '新大阪駅', '大阪梅田駅',
  'ユニバーサル・スタジオ・ジャパン', '大阪国際会議場', 'あべのキューズモール', '大丸心斎橋店',
];
// 施設として拾うタグ（名前一致に加えて、種別が施設であることの裏づけに使う）
const LANDMARKY_TAGS = (t) => t.tourism || t.leisure === 'park' || t.shop === 'mall' || t.amenity === 'townhall'
  || t.amenity === 'theatre' || t.amenity === 'conference_centre' || t.man_made === 'tower' || t.building === 'retail'
  || t.building === 'commercial' || t.building === 'public' || t.building === 'train_station' || t.railway === 'station'
  || t.historic || t.leisure === 'stadium' || t.landuse === 'retail';

const nameOf = (t) => (t && (t['name:ja'] || t.name)) || null;
const matchCandidate = (name) => LANDMARK_CANDIDATES.find((c) => name === c || name.includes(c));

export async function scanPbf(pbfPath = PBF) {
  const stations = [];             // {name, type, lat, lon, refs}
  const candidates = [];           // {name, matched, type, id, tags, lat, lon, refs}
  const neededRefs = new Set();    // 2 パス目で座標を取るノード
  const stat = { nodes: 0, ways: 0, relations: 0, stationElements: 0, stationNodes: 0, stationNorth: 0, candidateElements: 0 };

  for await (const it of pbfPrimitiveStream(pbfPath)) {
    const t = it.tags || {};
    if (it.type === 'node') stat.nodes++; else if (it.type === 'way') stat.ways++; else stat.relations++;
    const name = nameOf(t);
    const isStation = t.railway === 'station' || t.railway === 'halt';
    if (isStation) {
      stat.stationElements++;
      if (it.type === 'node') stat.stationNodes++;
      const rec = { name, type: it.type, id: it.id, lat: it.lat, lon: it.lon, refs: it.type === 'way' ? (it.refs || []).slice(0, 40) : null };
      if (it.type === 'way') for (const r of rec.refs) neededRefs.add(r);
      stations.push(rec);
      if (it.lat && it.lat > NORTH_LIMIT_LAT) stat.stationNorth++;
    } else if (name) {
      const matched = matchCandidate(name);
      if (matched && LANDMARKY_TAGS(t)) {
        stat.candidateElements++;
        const rec = { name, matched, type: it.type, id: it.id, lat: it.lat, lon: it.lon,
          tags: Object.fromEntries(Object.entries(t).filter(([k]) => ['tourism', 'leisure', 'shop', 'amenity', 'building', 'man_made', 'historic', 'railway', 'landuse', 'operator', 'wikidata'].includes(k))),
          refs: it.type === 'way' ? (it.refs || []).slice(0, 400) : null };
        if (it.type === 'way') for (const r of rec.refs) neededRefs.add(r);
        candidates.push(rec);
      }
    }
  }
  // 2 パス目: way の構成ノード座標 → 重心
  const coords = new Map();
  if (neededRefs.size) {
    for await (const it of pbfPrimitiveStream(pbfPath)) {
      if (it.type !== 'node') continue;
      if (neededRefs.has(it.id)) coords.set(it.id, [it.lat, it.lon]);
    }
  }
  const centroidOf = (rec) => {
    if (Number.isFinite(rec.lat) && Number.isFinite(rec.lon)) return { lat: rec.lat, lon: rec.lon };
    const pts = (rec.refs || []).map((r) => coords.get(r)).filter(Boolean);
    if (!pts.length) return null;
    return { lat: pts.reduce((s, p) => s + p[0], 0) / pts.length, lon: pts.reduce((s, p) => s + p[1], 0) / pts.length };
  };
  for (const rec of stations.concat(candidates)) {
    const c = centroidOf(rec);
    if (!c) { rec.resolved = false; continue; }
    const l = toLocal(c.lat, c.lon);
    rec.resolved = true; rec.lat = c.lat; rec.lon = c.lon; rec.x = Math.round(l.x * 100) / 100; rec.z = Math.round(l.z * 100) / 100;
    rec.inCity = l.x >= CITY_BBOX.minX && l.x <= CITY_BBOX.maxX && l.z >= CITY_BBOX.minZ && l.z <= CITY_BBOX.maxZ;
    delete rec.refs;
  }
  return { stations, candidates, stat };
}

export function scanWaterNames() {
  const byName = new Map();
  if (!fs.existsSync(WATER)) return [];
  for (const f of fs.readdirSync(WATER)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    const j = JSON.parse(fs.readFileSync(path.join(WATER, f), 'utf-8'));
    for (const ft of (j.features || [])) {
      const a = ft.attributes || {};
      if (!a.name) continue;
      const rec = byName.get(a.name) || { name: a.name, tiles: 0, waterClass: a.waterClass, waterwayTag: a.waterwayTag, sampleCentroid: ft.centroid || null, features: 0 };
      rec.features++; rec.tiles++;
      byName.set(a.name, rec);
    }
  }
  return [...byName.values()].sort((a, b) => b.features - a.features);
}

async function main() {
  const water = scanWaterNames();
  const { stations, candidates, stat } = await scanPbf();
  const northStations = stations.filter((s) => s.resolved && s.lat > NORTH_LIMIT_LAT);
  const byCandidate = {};
  for (const c of candidates) {
    if (!c.resolved || !c.inCity) continue;
    (byCandidate[c.matched] = byCandidate[c.matched] || []).push({ name: c.name, type: c.type, id: c.id, x: c.x, z: c.z, tags: c.tags });
  }
  const doc = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '33C',
    source: 'data/raw/osm/osaka-latest.osm.pbf（既存）+ canonical water',
    stat,
    stationSummary: {
      total: stations.length, resolved: stations.filter((s) => s.resolved).length,
      inCity: stations.filter((s) => s.resolved && s.inCity).length,
      northOfLimit: northStations.length, northLimitLat: NORTH_LIMIT_LAT,
      maxLat: stations.reduce((m, s) => (s.lat && s.lat > m ? s.lat : m), 0),
      northNames: northStations.map((s) => s.name).filter(Boolean).slice(0, 40),
    },
    landmarkCandidates: Object.fromEntries(Object.entries(byCandidate).map(([k, v]) => [k, v.slice(0, 6)])),
    landmarkCandidatesMissing: LANDMARK_CANDIDATES.filter((c) => !byCandidate[c]),
    waterNames: water.slice(0, 60),
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  return doc;
}

if (isMainModule(import.meta.url)) {
  main().then((d) => {
    console.log('[label-source] stations', JSON.stringify(d.stationSummary).slice(0, 400));
    console.log('[label-source] landmark hits', Object.keys(d.landmarkCandidates).join(' '));
    console.log('[label-source] landmark missing', d.landmarkCandidatesMissing.join(' '));
    console.log('[label-source] water', d.waterNames.slice(0, 24).map((w) => w.name).join(' '));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
