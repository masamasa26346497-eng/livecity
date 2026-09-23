#!/usr/bin/env node
// tools/build-label-datasets.js
// [Mission 33C §5/§6/§7/§10/§26] ラベル用の派生データを 1 か所（labels/）へ整理して生成する。
//   place   : OSM place（33A）+ PLATEAU 町丁目名称（33C・北部を含む全市）を統合。provenance 付き。
//   landmark: canonical landmarks.json + OSM で実在を確認できた施設。tier / zoomBand / provenance 付き。
//   river   : canonical water の名称付き feature（代表点 + 向き）。
//   station : canonical rail stations をそのまま（正本。ハードコード追加はしない）。
//   出力: public/map-data/osaka-city/labels/{place,landmark,river,station}-labels.json + manifest.json
//         data/processed/osaka-city/derived/labels/ にも同じものを置く
//         data/reports/label-datasets.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { readFileRetry } from './lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const SRC = {
  osmPlaces: P('public', 'map-data', 'osaka-city', 'derived', 'place-labels.json'),
  plateauTowns: P('data', 'processed', 'osaka-city', 'derived', 'plateau-place-labels.json'),
  stations: P('public', 'map-data', 'osaka-city', 'derived', 'rail-stations.json'),
  landmarks: P('public', 'map-data', 'osaka-city', 'landmarks', 'landmarks.json'),
  osmScan: P('data', 'reports', 'osm-label-source-scan.json'),
  water: P('data', 'processed', 'osaka-city', 'canonical', 'water'),
};
const OUT_DIRS = [
  P('public', 'map-data', 'osaka-city', 'labels'),
  P('data', 'processed', 'osaka-city', 'derived', 'labels'),
];
const REPORT = P('data', 'reports', 'label-datasets.json');
const rj = (p) => JSON.parse(readFileRetry(p));

// ── 地名の階層（33A と同じ考え方。上位を絞って広域だけ大きく出す） ──
export const PLACE_MAJOR_TOP_N = 60;
export const PLACE_MEDIUM_TOP_N = 220;

/** 地名スコア: 規模 + 周辺 600m の駅数（都市の中心性）+ 広がり。source をまたいで比較できるよう正規化する */
export function placeScore(entry, stationsWithin600m) {
  const size = entry.source === 'osm-place'
    ? Math.min(10, entry.chomeCount || 1)
    : Math.min(10, (entry.buildings || 0) / 150);
  return +(size + Math.min(stationsWithin600m, 4) * 3 + Math.min(entry.spreadM || 0, 1500) / 400).toFixed(2);
}

export function mergePlaces(osmDoc, plateauDoc, stations) {
  const stPts = (stations || []).map((s) => ({ x: s.point[0], z: s.point[1], name: String(s.name).replace(/駅$/, '') }));
  const near = (x, z, r) => stPts.filter((s) => Math.hypot(s.x - x, s.z - z) < r).length;
  const list = [];
  for (const p of (osmDoc.places || [])) {
    list.push({ id: 'place:osm:' + p.name, name: p.name, x: p.x, z: p.z, source: 'osm-place',
      sourceId: p.id, chomeCount: p.chomeCount, spreadM: p.spreadM, ward: null, sources: ['osm-place'] });
  }
  for (const t of (plateauDoc.towns || [])) {
    const dup = list.find((q) => q.name === t.name && Math.hypot(q.x - t.x, q.z - t.z) < 1200);
    if (dup) {
      // 同じ地名が両方にある: 位置は OSM（地名ノード）を優先し、PLATEAU の規模も記録する
      dup.sources.push('plateau-town');
      dup.buildings = t.buildings;
      dup.ward = t.ward || dup.ward;
      dup.spreadM = Math.max(dup.spreadM || 0, t.spreadM || 0);
      continue;
    }
    list.push({ id: 'place:plateau:' + (t.wardId || '') + ':' + t.name, name: t.name, x: t.x, z: t.z, source: 'plateau-town',
      sourceId: t.id, buildings: t.buildings, chomeCount: t.chomeCount, spreadM: t.spreadM, ward: t.ward, sources: ['plateau-town'] });
  }
  for (const e of list) {
    e.stationsWithin600m = near(e.x, e.z, 600);
    e.nearStation = stPts.some((s) => s.name === e.name && Math.hypot(s.x - e.x, s.z - e.z) < 1500);
    e.score = placeScore(e, e.stationsWithin600m) + (e.nearStation ? 4 : 0);
  }
  list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ja'));
  list.forEach((e, i) => {
    e.rank = i + 1;
    e.importance = i < PLACE_MAJOR_TOP_N ? 'major' : (i < PLACE_MAJOR_TOP_N + PLACE_MEDIUM_TOP_N ? 'medium' : 'local');
  });
  // 駅が無い区（大阪市北部は OSM 抽出に駅が無い）が不利になりすぎないよう、
  //   各区で建物数の多い上位 3 件は最低 medium に引き上げる（区ごとの実データ順位だけで決める）。
  const byWard = new Map();
  for (const e of list) {
    if (!e.ward) continue;
    const g = byWard.get(e.ward) || [];
    g.push(e); byWard.set(e.ward, g);
  }
  for (const [, g] of byWard) {
    g.sort((a, b) => (b.buildings || 0) - (a.buildings || 0));
    for (const e of g.slice(0, 3)) {
      if (e.importance === 'local') { e.importance = 'medium'; e.promotedByWard = true; }
    }
  }
  return list;
}

// ── ランドマーク ──
// tier は「都市の目印としての認識度」。S = 引き画面でも出す / A = 中距離 / B = 近景。
export const LANDMARK_TIERS = {
  S: ['大阪城', 'あべのハルカス', '通天閣', '京セラドーム大阪', 'グラングリーン大阪', 'ユニバーサル・スタジオ・ジャパン'],
  A: ['大阪市役所', '梅田スカイビル', '海遊館', 'なんばパークス', '大阪駅・大阪ステーションシティ', 'うめきた公園',
    '大阪中之島美術館', '大阪府咲洲庁舎（コスモタワー）', 'グランフロント大阪', 'てんしば', '天王寺動物園', 'インテックス大阪'],
};
export const TIER_ZOOM_BAND = { S: 'far', A: 'mid', B: 'near' };
export function landmarkTier(name) {
  if (LANDMARK_TIERS.S.includes(name)) return 'S';
  if (LANDMARK_TIERS.A.includes(name)) return 'A';
  return 'B';
}
// OSM 側から採用してよい種別（案内板・ホテル・記念碑などは除外する）
const OSM_LANDMARK_OK = (tags) => !!(tags.tourism && ['museum', 'zoo', 'aquarium', 'theme_park', 'attraction', 'viewpoint', 'gallery'].includes(tags.tourism))
  || tags.leisure === 'park' || tags.leisure === 'stadium' || tags.shop === 'mall' || tags.amenity === 'townhall'
  || tags.amenity === 'conference_centre' || tags.man_made === 'tower'
  || (tags.historic === 'building' || tags.historic === 'castle')
  || (tags.building && ['retail', 'commercial', 'public', 'train_station'].includes(tags.building));
// 名前が候補そのもの（または「◯◯ 北館」のような部分）であるものだけ採用する
// 「◯◯ 北館」「◯◯ ノースパーク」など建物の別館表記だけを代表名へ寄せる。
//   「万博記念公園 鶴見緑地」のように別施設を指す名前は採用しない。
const PART_SUFFIX = /^[\s　]*(北館|南館|東館|西館|本館|新館|別館|タワー|ノースパーク|サウスパーク|北街区|南街区)$/;
export function normalizeLandmarkName(raw, matched) {
  const n = String(raw).trim();
  if (n === matched) return matched;
  if (n.startsWith(matched) && PART_SUFFIX.test(n.slice(matched.length))) return matched;
  // 「大阪中之島美術館」のように正式名称へ接頭辞が付くだけのものは、正式名称の方を採用する
  if (n.endsWith(matched) && n.length - matched.length <= 3) return n;
  return null;
}

// 名前が一般的すぎて別施設を拾ってしまう候補は使わない（施設としての実体が別にあるものだけ残す）。
//   例: 「うめきた」= 地区名 / 「大阪駅」= 駅（大阪駅・大阪ステーションシティが正）/「大阪港」= 港湾一帯
//       「万博記念公園」= 吹田市の公園（市内の同名 way は鶴見緑地の別名）
export const LANDMARK_NAME_BLOCKLIST = ['うめきた', '大阪駅', '大阪港', '万博記念公園', '大阪梅田駅', '新大阪駅'];

export function buildLandmarks(canonDoc, scanDoc) {
  const out = [];
  const push = (rec) => {
    const dup = out.find((q) => q.name === rec.name || (Math.hypot(q.x - rec.x, q.z - rec.z) < 400 && (q.name.includes(rec.name) || rec.name.includes(q.name))));
    if (dup) { dup.sources = [...new Set([...(dup.sources || []), ...(rec.sources || [])])]; return; }
    out.push(rec);
  };
  for (const l of (canonDoc.landmarks || [])) {
    if (!Number.isFinite(l.x) || !Number.isFinite(l.z) || !l.name) continue;
    push({ id: 'lm:' + l.id, name: l.name, category: l.category || 'LANDMARK', x: l.x, z: l.z,
      source: 'canonical-landmark-registry', sourceId: (l.source && l.source.osm) || l.id,
      tier: landmarkTier(l.name), sources: ['canonical-landmark-registry'] });
  }
  for (const [matched, hits] of Object.entries(scanDoc.landmarkCandidates || {})) {
    if (LANDMARK_NAME_BLOCKLIST.includes(matched)) continue;
    for (const h of hits) {
      if (!OSM_LANDMARK_OK(h.tags || {})) continue;
      const name = normalizeLandmarkName(h.name, matched);
      if (!name) continue;
      const category = (h.tags.tourism === 'museum' || h.tags.tourism === 'gallery') ? 'MUSEUM'
        : h.tags.tourism === 'zoo' ? 'ZOO' : h.tags.tourism === 'aquarium' ? 'AQUARIUM'
          : h.tags.leisure === 'park' ? 'PARK' : h.tags.leisure === 'stadium' ? 'STADIUM'
            : h.tags.shop === 'mall' ? 'COMMERCIAL' : h.tags.amenity === 'townhall' ? 'CIVIC'
              : h.tags.man_made === 'tower' ? 'TOWER' : h.tags.historic ? 'HISTORIC'
                : h.tags.amenity === 'conference_centre' ? 'CONVENTION' : 'LANDMARK';
      push({ id: 'lm:osm:' + h.type + '/' + h.id, name, category, x: h.x, z: h.z,
        source: 'osm', sourceId: h.type + '/' + h.id, tier: landmarkTier(name), sources: ['osm'] });
    }
  }
  for (const l of out) {
    l.tier = landmarkTier(l.name);
    l.zoomBand = TIER_ZOOM_BAND[l.tier];
    l.priority = l.tier === 'S' ? 0 : (l.tier === 'A' ? 1 : 2);
  }
  return out.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, 'ja'));
}

// ── 河川 ──
/** 多角形の主軸（PCA）から向きを求める。ラベルを流路に沿わせるのに使う */
export function principalAngle(points) {
  const n = points.length;
  if (n < 3) return 0;
  let mx = 0, mz = 0;
  for (const p of points) { mx += p[0]; mz += p[1]; }
  mx /= n; mz /= n;
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of points) { const dx = p[0] - mx, dz = p[1] - mz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);   // 主軸の向き（ラジアン）
  return +angle.toFixed(4);
}
export function buildRivers(waterDir) {
  const byName = new Map();
  for (const f of fs.readdirSync(waterDir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    const j = JSON.parse(readFileRetry(path.join(waterDir, f)));
    for (const ft of (j.features || [])) {
      const a = ft.attributes || {};
      if (!a.name) continue;
      const rings = ft.geometryType === 'Polygon' ? [ft.coordinates[0]] : (ft.coordinates || []).map((c) => c[0]);
      const ring = (rings.filter(Boolean).sort((p, q) => (q ? q.length : 0) - (p ? p.length : 0)))[0];
      if (!ring || ring.length < 3) continue;
      let a2 = 0;
      for (let i = 0, j2 = ring.length - 1; i < ring.length; j2 = i++) a2 += ring[j2][0] * ring[i][1] - ring[i][0] * ring[j2][1];
      const area = Math.abs(a2 / 2);
      const rec = byName.get(a.name) || { name: a.name, waterClass: a.waterClass || null, waterwayTag: a.waterwayTag || null, areaM2: 0, parts: 0, best: null };
      rec.areaM2 += area; rec.parts++;
      if (!rec.best || area > rec.best.area) rec.best = { area, ring, centroid: ft.centroid || null };
      byName.set(a.name, rec);
    }
  }
  const rivers = [];
  for (const r of byName.values()) {
    if (!r.best) continue;
    const ring = r.best.ring;
    let cx = 0, cz = 0;
    for (const p of ring) { cx += p[0]; cz += p[1]; }
    cx /= ring.length; cz /= ring.length;
    const isWaterway = r.waterwayTag || /川|堀|運河|水路/.test(r.name);
    if (!isWaterway) continue;                      // 池・湖はここでは扱わない（公園ラベル側）
    rivers.push({
      id: 'river:' + r.name, name: r.name, x: Math.round(cx * 100) / 100, z: Math.round(cz * 100) / 100,
      angle: principalAngle(ring), areaM2: Math.round(r.areaM2), parts: r.parts,
      waterClass: r.waterClass, waterwayTag: r.waterwayTag,
      source: 'canonical-water', sourceId: r.name,
    });
  }
  rivers.sort((a, b) => b.areaM2 - a.areaM2);
  rivers.forEach((r, i) => {
    r.importance = r.areaM2 >= 150000 ? 'major' : (r.areaM2 >= 25000 ? 'medium' : 'local');
    r.rank = i + 1;
  });
  return rivers;
}

async function main() {
  const osmDoc = rj(SRC.osmPlaces);
  const plateauDoc = rj(SRC.plateauTowns);
  const stationsDoc = rj(SRC.stations);
  const landmarksDoc = rj(SRC.landmarks);
  const scanDoc = rj(SRC.osmScan);

  const places = mergePlaces(osmDoc, plateauDoc, stationsDoc.stations || []);
  const landmarks = buildLandmarks(landmarksDoc, scanDoc);
  const rivers = buildRivers(SRC.water);
  const stations = (stationsDoc.stations || []).map((s) => ({
    id: 'station:' + s.stationId, name: s.name, x: s.point[0], z: s.point[1],
    source: 'canonical-rail-stations', sourceId: s.stationId,
  }));

  const now = new Date().toISOString();
  const docs = {
    'place-labels.json': {
      version: 2, generatedAt: now, missionId: '33C', coordinateConvention: 'znorth-neg-v1',
      note: 'OSM place ノード（33A）と PLATEAU 町丁目名称（33C）の統合。source / sources に出所を記録。',
      counts: { total: places.length, byImportance: places.reduce((m, p) => ({ ...m, [p.importance]: (m[p.importance] || 0) + 1 }), {}),
        bySource: places.reduce((m, p) => ({ ...m, [p.source]: (m[p.source] || 0) + 1 }), {}) },
      places,
    },
    'landmark-labels.json': {
      version: 1, generatedAt: now, missionId: '33C', coordinateConvention: 'znorth-neg-v1',
      note: 'canonical landmark registry + OSM で実在を確認できた施設。tier S/A/B と zoomBand 付き。',
      counts: { total: landmarks.length, byTier: landmarks.reduce((m, l) => ({ ...m, [l.tier]: (m[l.tier] || 0) + 1 }), {}),
        bySource: landmarks.reduce((m, l) => ({ ...m, [l.source]: (m[l.source] || 0) + 1 }), {}) },
      landmarks,
    },
    'river-labels.json': {
      version: 1, generatedAt: now, missionId: '33C', coordinateConvention: 'znorth-neg-v1',
      note: 'canonical water の名称付き水域。代表点は最大 part の重心、angle は主軸（ラベルを流路に沿わせる）。',
      counts: { total: rivers.length, byImportance: rivers.reduce((m, r) => ({ ...m, [r.importance]: (m[r.importance] || 0) + 1 }), {}) },
      rivers,
    },
    'station-labels.json': {
      version: 1, generatedAt: now, missionId: '33C', coordinateConvention: 'znorth-neg-v1',
      // [Mission 35F §9] 旧 osaka-latest.osm.pbf は緯度 34.73 で切れており、北部の駅が
      //   元データに無かった。広域 PBF へ差し替えて canonical を作り直したので、その但し書きは消す。
      note: 'canonical rail stations をそのまま使う（正本）。ハードコードした駅名は足さない。',
      counts: { total: stations.length },
      stations,
    },
  };
  docs['manifest.json'] = {
    version: 1, generatedAt: now, missionId: '33C',
    datasets: Object.keys(docs).map((k) => ({ file: k, counts: docs[k].counts, source: docs[k].note })),
    otherLabelData: ['../derived/map-label-anchors.json（区名・公園名）'],
  };

  for (const dir of OUT_DIRS) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, doc] of Object.entries(docs)) fs.writeFileSync(path.join(dir, name), JSON.stringify(doc));
  }
  const report = {
    version: 1, generatedAt: now, missionId: '33C',
    counts: Object.fromEntries(Object.entries(docs).filter(([k]) => k !== 'manifest.json').map(([k, v]) => [k, v.counts])),
    northPlaces: places.filter((p) => p.z < -14000).slice(0, 30).map((p) => `${p.name}(${p.source}/${p.importance})`),
    landmarksByTier: { S: landmarks.filter((l) => l.tier === 'S').map((l) => l.name), A: landmarks.filter((l) => l.tier === 'A').map((l) => l.name), B: landmarks.filter((l) => l.tier === 'B').map((l) => l.name) },
    riversMajor: rivers.filter((r) => r.importance === 'major').map((r) => `${r.name}(${r.areaM2}m²)`),
    riversMedium: rivers.filter((r) => r.importance === 'medium').map((r) => r.name),
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  return { docs, report };
}

if (isMainModule(import.meta.url)) {
  main().then(({ report }) => {
    console.log('[labels]', JSON.stringify(report.counts));
    console.log('[labels] north places', report.northPlaces.slice(0, 16).join(' '));
    console.log('[labels] tier S', report.landmarksByTier.S.join(' '), '| A', report.landmarksByTier.A.join(' '));
    console.log('[labels] rivers major', report.riversMajor.join(' '));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
