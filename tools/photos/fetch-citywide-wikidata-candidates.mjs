#!/usr/bin/env node
// tools/photos/fetch-citywide-wikidata-candidates.mjs
// [Mission 36F 優先度C] 大阪市全域の「候補」を Wikidata から集めるだけのスクリプト。
//
//   §「候補生成と確定処理を分ける」: ここでやるのは候補集めだけ。
//     ・Wikidata の座標が大阪市の bbox 内
//     ・P18（画像）を持っている
//     ・建物 / ランドマーク的なクラス（Q41176 建物のサブクラス、Q811979 建築物）
//   これだけを条件に Wikidata Query Service（SPARQL）へ1回問い合わせて集める。
//
//   ここでは canonicalId への確定は一切しない（名前一致も座標検証もしない）。
//   確定は build-building-photo-index.mjs 側が、この候補ファイルを読んで
//   tools/photos/lib/citywide-photo-matching.mjs の resolveByNameAndCoordinate で
//   厳格に行う（正規化名の完全一致 + 座標が一意に近い場合のみ）。
//   つまりこのスクリプトが多少広く候補を拾っても、誤った建物に写真が付くことはない
//   ——確定側が「近いだけ」「同名競合」を全部 unresolved に落とすため。
//
//   【ローカルPC専用】Wikidata Query Service への問い合わせにネットワークが必要。
//     node tools/photos/fetch-citywide-wikidata-candidates.mjs
//
// 出力: data/photos/citywide-candidate-pool.json
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const OUT = P('data', 'photos', 'citywide-candidate-pool.json');

// 大阪市域を覆う bbox（既存の znorth-neg-v1 投影の市域 bbox から逆算 + 余裕を持たせた値）。
// tools/audit/osm-label-source-scan.js の CITY_BBOX（ローカルXZ）と同じ市域を指す。
export const CITY_LATLON_BBOX = { west: 135.34, south: 34.58, east: 135.61, north: 34.78 };

const UA = 'LiveCity-data-pipeline/0.2 (Mission 36F citywide photo candidate discovery; https://github.com/masamasa26346497-eng/livecity)';
const ENDPOINT = 'https://query.wikidata.org/sparql';

export function buildSparql(bbox) {
  return `
SELECT DISTINCT ?item ?itemLabel ?coord WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerWest "Point(${bbox.west} ${bbox.south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerEast "Point(${bbox.east} ${bbox.north})"^^geo:wktLiteral .
  }
  ?item wdt:P18 ?image .
  { ?item wdt:P31/wdt:P279* wd:Q41176 . }     # 建物のサブクラス
  UNION
  { ?item wdt:P31/wdt:P279* wd:Q811979 . }    # 建築物一般
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". }
}
LIMIT 5000
`.trim();
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300) { reject(new Error('HTTP ' + res.statusCode + ' from ' + url.slice(0, 80))); res.resume(); return; }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
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

async function main() {
  const query = buildSparql(CITY_LATLON_BBOX);
  const url = ENDPOINT + '?format=json&query=' + encodeURIComponent(query);
  console.log('[36F] Wikidata Query Service へ大阪市 bbox 内の候補を問い合わせる');
  const json = await httpGetJson(url);
  const candidates = parseSparqlResults(json);
  // qid の重複を除去（同じ座標が複数行で返ることがある）
  const seen = new Set();
  const deduped = candidates.filter((c) => (seen.has(c.wikidataId) ? false : (seen.add(c.wikidataId), true)));
  const doc = {
    version: 1, generatedAt: new Date().toISOString(), source: 'wikidata-query-service',
    bbox: CITY_LATLON_BBOX,
    note: 'ここでは候補を集めるだけで canonicalId への確定はしない。確定は build-building-photo-index.mjs 側。',
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
