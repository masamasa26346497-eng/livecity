#!/usr/bin/env node
// tools/photos/fetch-citywide-wikidata-candidates.mjs
// [Mission 36F 優先度C] 大阪市全域の「候補」を Wikidata から集めるだけのスクリプト。
//
//   §「候補生成と確定処理を分ける」: ここでやるのは候補集めだけ。
//     ・Wikidata の座標が大阪市の bbox 内
//     ・P18（画像）を持っている
//     ・建物 / ランドマーク的なクラス（Q41176 建物のサブクラス、Q811979 建築物）
//   これだけを条件に Wikidata Query Service（SPARQL）へ問い合わせて集める。
//
//   ここでは canonicalId への確定は一切しない（名前一致も座標検証もしない）。
//   確定は build-building-photo-index.mjs 側が、この候補ファイルを読んで
//   tools/photos/lib/citywide-photo-matching.mjs の resolveByNameAndCoordinate で
//   厳格に行う（正規化名の完全一致 + 座標が一意に近い場合のみ）。
//
//   【ローカルPC専用】Wikidata Query Service への問い合わせにネットワークが必要。
//     node tools/photos/fetch-citywide-wikidata-candidates.mjs
//
// Mission 36F follow-up:
//   WDQS が大きな JSON 応答を途中で壊すことがあるため、JSON parse 失敗時は bbox を
//   4分割して再取得する。LIMIT に達した場合も同様に分割し、取りこぼしを防ぐ。
//
// 出力: data/photos/citywide-candidate-pool.json
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const OUT = P('data', 'photos', 'citywide-candidate-pool.json');

// 大阪市域を覆う bbox（既存の znorth-neg-v1 投影の市域 bbox から逆算 + 余裕を持たせた値）。
export const CITY_LATLON_BBOX = { west: 135.34, south: 34.58, east: 135.61, north: 34.78 };

const UA = 'LiveCity-data-pipeline/0.2 (Mission 36F citywide photo candidate discovery; https://github.com/masamasa26346497-eng/livecity)';
const ENDPOINT = 'https://query.wikidata.org/sparql';
const QUERY_LIMIT = 5000;
const MAX_SPLIT_DEPTH = 3;

export function buildSparql(bbox) {
  return `
SELECT DISTINCT ?item ?itemLabel ?coord WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerWest "Point(${bbox.west} ${bbox.south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerEast "Point(${bbox.east} ${bbox.north})"^^geo:wktLiteral .
  }
  ?item wdt:P18 ?image .
  { ?item wdt:P31/wdt:P279* wd:Q41176 . }
  UNION
  { ?item wdt:P31/wdt:P279* wd:Q811979 . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". }
}
LIMIT ${QUERY_LIMIT}
`.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/sparql-results+json',
        'Accept-Encoding': 'identity',
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300) {
        reject(new Error('HTTP ' + res.statusCode + ' from ' + url.slice(0, 80)));
        res.resume();
        return;
      }
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.setTimeout(60000, () => req.destroy(new Error('WDQS request timeout')));
    req.on('error', reject);
  });
}

const POINT_RE = /Point\(([-\d.]+) ([-\d.]+)\)/;

export function parseSparqlResults(json) {
  const rows = (json && json.results && json.results.bindings) || [];
  const out = [];
  for (const r of rows) {
    const qid = r.item && r.item.value && r.item.value.split('/').pop();
    const coordLit = r.coord && r.coord.value;
    const m = coordLit && coordLit.match(POINT_RE);
    if (!qid || !m) continue;
    out.push({
      wikidataId: qid,
      name: (r.itemLabel && r.itemLabel.value) || null,
      lon: Number(m[1]), lat: Number(m[2]),
    });
  }
  return out;
}

function splitBbox(bbox) {
  const midLon = (bbox.west + bbox.east) / 2;
  const midLat = (bbox.south + bbox.north) / 2;
  return [
    { west: bbox.west, south: bbox.south, east: midLon, north: midLat },
    { west: midLon, south: bbox.south, east: bbox.east, north: midLat },
    { west: bbox.west, south: midLat, east: midLon, north: bbox.north },
    { west: midLon, south: midLat, east: bbox.east, north: bbox.north },
  ];
}

async function fetchOneBbox(bbox, label) {
  const query = buildSparql(bbox);
  const url = ENDPOINT + '?format=json&query=' + encodeURIComponent(query);
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const body = await httpGetText(url);
      const json = JSON.parse(body);
      return parseSparqlResults(json);
    } catch (e) {
      lastError = e;
      console.warn(`[36F] ${label} 取得失敗 (${attempt}/2): ${e.message}`);
      if (attempt < 2) await sleep(1000);
    }
  }

  throw lastError || new Error('WDQS unknown error');
}

async function collectCandidates(bbox, depth = 0, label = 'city') {
  try {
    const candidates = await fetchOneBbox(bbox, label);
    console.log(`[36F] ${label}: ${candidates.length} 件`);

    // LIMIT 到達時は結果が切れている可能性があるので、さらに分割して取り直す。
    if (candidates.length < QUERY_LIMIT || depth >= MAX_SPLIT_DEPTH) return candidates;
    console.warn(`[36F] ${label}: LIMIT ${QUERY_LIMIT} 到達のため bbox を4分割する`);
  } catch (e) {
    if (depth >= MAX_SPLIT_DEPTH) throw e;
    console.warn(`[36F] ${label}: 大きな応答を取得できないため bbox を4分割して再取得する`);
  }

  const parts = splitBbox(bbox);
  const all = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(300);
    const rows = await collectCandidates(parts[i], depth + 1, `${label}.${i + 1}`);
    all.push(...rows);
  }
  return all;
}

async function main() {
  console.log('[36F] Wikidata Query Service へ大阪市 bbox 内の候補を問い合わせる');
  const candidates = await collectCandidates(CITY_LATLON_BBOX);

  // qid の重複を除去（bbox境界や同じ座標が複数行で返ることがある）
  const seen = new Set();
  const deduped = candidates.filter((c) => (seen.has(c.wikidataId) ? false : (seen.add(c.wikidataId), true)));
  const doc = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'wikidata-query-service',
    bbox: CITY_LATLON_BBOX,
    note: 'ここでは候補を集めるだけで canonicalId への確定はしない。確定は build-building-photo-index.mjs 側。JSON破損またはLIMIT到達時はbbox分割で再取得する。',
    counts: { raw: candidates.length, deduped: deduped.length },
    candidates: deduped,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
  console.log('[36F] citywide 候補 ' + deduped.length + ' 件 → ' + OUT);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
