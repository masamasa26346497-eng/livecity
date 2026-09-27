#!/usr/bin/env node
// tools/photos/extract-osm-wikidata-tags.mjs
// [Mission 36F 優先度A] 大阪市全域の OSM データから wikidata=Q... タグが直接付いている
// 要素（建物 / 施設）を集め、build-building-photo-index.mjs の direct-id 経路が読む
// 候補ファイル（CITYWIDE_DIRECT_ID）を作る。
//
//   ここでは「名前で検索」しない。OSM に既に付いている ID をそのまま拾うだけなので、
//   35Z/36F の §3「推測で建物と写真を結ばない」に抵触しない（それでも build 側は
//   Wikidata 自身の座標で独立に検証してから canonicalId に固定する。二重チェック）。
//
//   【ローカルPC専用】このスクリプトは data/raw/osm/*.osm.pbf を読む。
//   data/raw/ は .gitignore 対象で、このリポジトリのCIサンドボックスには存在しない。
//   ローカルPC（大阪市域のPBFを取得済みの環境）で実行すること:
//     node tools/photos/extract-osm-wikidata-tags.mjs
//
// 出力: data/photos/citywide-direct-id-candidates.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';

const P = (...s) => resolveProjectPath(path.join(...s));
// [Mission 35O と同じ優先順位] 全域カバレッジ版があればそれを使う。無ければ旧ファイルへ。
const PBF_CANDIDATES = [
  P('data', 'raw', 'osm', 'osaka-full-coverage.osm.pbf'),
  P('data', 'raw', 'osm', 'osaka-latest.osm.pbf'),
];
export const OUT = P('data', 'photos', 'citywide-direct-id-candidates.json');

const WIKIDATA_ID_RE = /^Q\d+$/;

// fetch-citywide-wikidata-candidates.mjs と同じ大阪市域 bbox。
// PBF 自体は大阪市外（京都・滋賀・兵庫等）の要素も含み得るため、direct-id 側でも必ず切る。
export const CITY_LATLON_BBOX = { west: 135.34, south: 34.58, east: 135.61, north: 34.78 };

// 建物そのもの以外でも、建物内施設として写真対象になり得る OSM feature だけを許可する。
// place=city / boundary=administrative のような自治体・地名は候補にしない。
const FACILITY_KEYS = [
  'amenity', 'tourism', 'shop', 'office', 'leisure', 'historic',
  'man_made', 'railway', 'public_transport', 'aeroway', 'healthcare',
];

export function isInCityBbox(lat, lon, bbox = CITY_LATLON_BBOX) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lon >= bbox.west && lon <= bbox.east
    && lat >= bbox.south && lat <= bbox.north;
}

/** wikidata タグを持ち、建物または施設と分かる要素だけを候補にする。 */
export function isCandidateTags(t) {
  if (!t || !WIKIDATA_ID_RE.test(t.wikidata || '')) return false;

  // 自治体・行政界・町名・都市名などは「物件写真」の候補ではない。
  if (t.boundary || t.admin_level || t.place) return false;

  if (t.building && t.building !== 'no') return true;
  return FACILITY_KEYS.some((k) => t[k] && t[k] !== 'no');
}

export function nameOf(t) {
  return (t && (t['name:ja'] || t.name)) || null;
}

/** PBF 全体を1回スキャンし、wikidata= が直接付いた要素を集める（2パス: タグ→座標）。 */
export async function scanDirectIdCandidates(pbfPath) {
  const found = [];       // { osmType, osmId, wikidataId, name, refs? }
  const neededRefs = new Set();
  let scanned = 0;
  for await (const it of pbfPrimitiveStream(pbfPath)) {
    scanned++;
    const t = it.tags || {};
    if (!isCandidateTags(t)) continue;
    const rec = {
      osmType: it.type, osmId: it.id, wikidataId: t.wikidata, name: nameOf(t),
      lat: it.lat ?? null, lon: it.lon ?? null,
      refs: it.type === 'way' ? (it.refs || []).slice(0, 800) : null,
    };
    if (it.type === 'way') for (const r of rec.refs) neededRefs.add(r);
    found.push(rec);
  }

  // 2パス目: way の構成ノード座標 → 重心（中心点があれば十分。厳密な重心でなくてよい）
  if (neededRefs.size) {
    const coords = new Map();
    for await (const it of pbfPrimitiveStream(pbfPath)) {
      if (it.type !== 'node' || !neededRefs.has(it.id)) continue;
      coords.set(it.id, [it.lat, it.lon]);
      if (coords.size === neededRefs.size) break;
    }
    for (const rec of found) {
      if (rec.lat != null && rec.lon != null) continue;
      const pts = (rec.refs || []).map((r) => coords.get(r)).filter(Boolean);
      if (!pts.length) continue;
      rec.lat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      rec.lon = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    }
  }

  for (const rec of found) delete rec.refs;
  const inCity = found.filter((r) => isInCityBbox(r.lat, r.lon));
  return { candidates: inCity, scanned, taggedBuildingOrFacility: found.length };
}

async function main() {
  const pbf = PBF_CANDIDATES.find((p) => fs.existsSync(p));
  if (!pbf) {
    console.error('[36F] OSM PBF が見つからない。以下のいずれかをローカルPCで用意してから実行してください:');
    for (const p of PBF_CANDIDATES) console.error('  ' + p);
    process.exitCode = 1;
    return;
  }
  console.log('[36F] ' + pbf + ' から wikidata= タグを走査する');
  const { candidates, scanned, taggedBuildingOrFacility } = await scanDirectIdCandidates(pbf);

  // 同じ wikidataId が複数 OSM 要素に付いていることがある（重複タグ付け）。1件目だけ残す。
  const seen = new Set();
  const deduped = candidates.filter((c) => (seen.has(c.wikidataId) ? false : (seen.add(c.wikidataId), true)));
  const doc = {
    version: 2, generatedAt: new Date().toISOString(), source: pbf,
    bbox: CITY_LATLON_BBOX,
    note: 'OSM に直接ついている wikidata= タグのうち、大阪市bbox内の建物/施設だけ。自治体・行政界・地名は除外。名前検索での推測は含まない。',
    counts: {
      scanned,
      taggedBuildingOrFacility,
      inCity: candidates.length,
      deduped: deduped.length,
    },
    candidates: deduped,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
  console.log('[36F] direct-id 候補 ' + deduped.length + ' 件（建物/施設タグ ' + taggedBuildingOrFacility
    + ' 件 → 大阪市bbox ' + candidates.length + ' 件 / 走査 ' + scanned + ' 要素）→ ' + OUT);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
