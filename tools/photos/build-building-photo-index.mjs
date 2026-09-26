// tools/photos/build-building-photo-index.mjs
// [Mission 35Z §7] 建物写真インデックスを **事前生成** する。
//
//   §2 遵守: 使うのは Wikidata（P18）と Wikimedia Commons だけ。
//     任意サイトのスクレイピングも、検索結果 URL の利用もしない。
//     hover のたびにネットを引かないよう、ここで 1 枚の JSON に固めておく。
//
//   §3 遵守: 建物 → 写真の対応は **推測で作らない**。
//     Q-id は data/photos/building-photo-curated.json に手で確認して固定してあり、
//     さらにビルド時に「Wikidata の座標」と「こちらの建物データの座標」を突き合わせる。
//     名前も座標も合ったものだけ high。座標しか合わなければ medium。
//     どちらも合わなければ unresolved（写真を付けない）。
//
//   §10 遵守: ライセンスが読めない画像は落とす。
//
//   実行: node tools/photos/build-building-photo-index.mjs
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const CURATED = 'data/photos/building-photo-curated.json';
const MANUAL = 'data/photos/building-photo-manual.json';     // §2-4 任意。あれば読む
const BUILDING_LABELS = 'public/map-data/osaka-city/derived/building-name-labels.json';
const LANDMARK_LABELS = 'public/map-data/osaka-city/labels/landmark-labels.json';
const OUT = 'public/map-data/osaka-city/derived/building-photo-index.json';
const REPORT_DIR = 'data/reports/mission35z-building-photo-preview';

// 既存レイヤーと同じ投影（znorth-neg-v1）。ここを変えてはいけない。
const CLAT = 34.604208, CLON = 135.52502, MPD = 111320;
const toLocal = (lat, lon) => ({
  x: (lon - CLON) * Math.cos(CLAT * Math.PI / 180) * MPD,
  z: -((lat - CLAT) * MPD),
});

// 名前の表記ゆれを吸収（全角半角・中黒・空白）。同一視しすぎないよう最小限。
const norm = (s) => String(s || '')
  .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[\s　・･]/g, '')
  .toLowerCase();

const UA = 'LiveCity-data-pipeline/0.2 (build-time building photo index; https://github.com/masamasa26346497-eng/livecity)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raw = (u) => new Promise((res, rej) => {
  https.get(u, { headers: { 'User-Agent': UA } }, (r) => {
    let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b));
  }).on('error', rej);
});
/** 429 などは待って何度か試す（API へ優しく）。 */
async function getJson(u) {
  for (let i = 0; i < 5; i++) {
    const b = await raw(u);
    try { return JSON.parse(b); } catch (e) { await sleep(2500 * (i + 1)); }
  }
  throw new Error('API から JSON を得られない: ' + u.slice(0, 90));
}

/** Commons の extmetadata からライセンス・著者・出典を取り出す。読めなければ null。 */
function licenseOf(meta) {
  const v = (k) => (meta && meta[k] && typeof meta[k].value === 'string') ? meta[k].value : null;
  const strip = (s) => (s ? String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : null);
  const license = v('LicenseShortName') || v('License');
  if (!license || /^unknown$/i.test(license)) return null;      // §10 不明なら使わない
  return {
    license,
    licenseUrl: v('LicenseUrl') || null,
    author: strip(v('Artist')) || null,
    attribution: strip(v('Attribution')) || strip(v('Credit')) || strip(v('Artist')) || null,
    usageTerms: strip(v('UsageTerms')) || null,
  };
}

async function commonsPhoto(fileName) {
  const title = 'File:' + fileName;
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo'
    + '&iiprop=url%7Cextmetadata%7Csize&iiurlwidth=320&titles=' + encodeURIComponent(title);
  const j = await getJson(u);
  const pages = (j.query && j.query.pages) || {};
  const page = Object.values(pages)[0];
  if (!page || !page.imageinfo || !page.imageinfo[0]) return null;
  const ii = page.imageinfo[0];
  const lic = licenseOf(ii.extmetadata);
  if (!lic) return null;                                         // §10
  return {
    thumbnailUrl: ii.thumburl || null,
    imageUrl: ii.url || null,
    width: ii.thumbwidth || null, height: ii.thumbheight || null,
    source: 'wikimedia-commons',
    title: page.title,
    sourcePageUrl: ii.descriptionurl || ('https://commons.wikimedia.org/wiki/' + encodeURIComponent(title)),
    ...lic,
  };
}

async function wikidataEntity(qid) {
  const u = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json'
    + '&props=labels%7Cclaims%7Csitelinks&languages=ja%7Cen&ids=' + encodeURIComponent(qid);
  const j = await getJson(u);
  const e = j.entities && j.entities[qid];
  if (!e) return null;
  const c = e.claims || {};
  const claimVals = (p) => (c[p] || []).map((x) => x.mainsnak && x.mainsnak.datavalue && x.mainsnak.datavalue.value).filter(Boolean);
  const coord = claimVals('P625')[0] || null;
  return {
    qid,
    labelJa: (e.labels && e.labels.ja && e.labels.ja.value) || null,
    labelEn: (e.labels && e.labels.en && e.labels.en.value) || null,
    images: claimVals('P18').filter((x) => typeof x === 'string'),
    lat: coord ? coord.latitude : null,
    lon: coord ? coord.longitude : null,
    wikipediaJa: (e.sitelinks && e.sitelinks.jawiki)
      ? 'https://ja.wikipedia.org/wiki/' + encodeURIComponent(e.sitelinks.jawiki.title) : null,
  };
}

// ══ 建物データを読む ══════════════════════════════════════════
const curated = JSON.parse(fs.readFileSync(CURATED, 'utf-8'));
const manual = fs.existsSync(MANUAL) ? JSON.parse(fs.readFileSync(MANUAL, 'utf-8')) : { entries: [] };
const bLabels = JSON.parse(fs.readFileSync(BUILDING_LABELS, 'utf-8')).labels || [];
const lmRaw = JSON.parse(fs.readFileSync(LANDMARK_LABELS, 'utf-8'));
const landmarks = lmRaw.landmarks || lmRaw.labels || lmRaw;

// 名前 → 建物（複数ありうる）
const byName = new Map();
for (const b of bLabels) {
  const k = norm(b.name);
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(b);
}

const NAME_RADIUS_M = 400;     // 名前が一致していれば少し広めに許す
const COORD_RADIUS_M = 120;    // 記録用（この距離で建物を決めることはしない）

/** Wikidata の座標と名前から canonicalId を決める。推測はしない。 */
function resolveBuilding(entryName, wd) {
  const out = { canonicalId: null, matchedName: null, distanceM: null, confidence: 'unresolved', reason: null };
  if (wd.lat == null || wd.lon == null) { out.reason = 'Wikidata に座標が無い'; return out; }
  const p = toLocal(wd.lat, wd.lon);
  const names = [entryName, wd.labelJa, wd.labelEn].filter(Boolean).map(norm);

  // A: 名前が一致する建物のうち、Wikidata 座標に最も近いもの
  let best = null;
  for (const n of new Set(names)) {
    for (const b of (byName.get(n) || [])) {
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (!best || d < best.d) best = { b, d };
    }
  }
  if (best && best.d <= NAME_RADIUS_M) {
    out.canonicalId = best.b.id; out.matchedName = best.b.name;
    out.distanceM = +best.d.toFixed(1); out.confidence = 'high';
    out.reason = '名前が一致し、Wikidata 座標から ' + out.distanceM + 'm';
    return out;
  }
  if (best) { out.distanceM = +best.d.toFixed(1); out.matchedName = best.b.name; }

  // B: 「近いから」で建物を決めない。
  //   実測すると、近さだけで選んだ候補は **全部ちがう建物** だった:
  //     あべのハルカス → 新宿ごちそうビル(75m) / 大阪市役所 → 大阪府立中之島図書館(106m)
  //     グラングリーン大阪 → うめきたグリーンプレイス(37m) / 通天閣 → 新世界ニューハイツ(42m)
  //   §3「推測で別建物画像を付けない」に従い、この経路は使わない。近傍は記録だけする。
  let near = null;
  for (const b of bLabels) {
    const d = Math.hypot(b.x - p.x, b.z - p.z);
    if (!near || d < near.d) near = { b, d };
  }
  if (near) { out.nearestName = near.b.name; out.nearestDistanceM = +near.d.toFixed(1); }
  out.reason = '建物名が一致しないので建物へは結び付けない'
    + (near ? '（最寄りは ' + out.nearestDistanceM + 'm の「' + near.b.name + '」だが、近いだけでは根拠にならない）' : '');
  return out;
}

/** ランドマークラベル側の対応（建物に当たらなくても、ランドマークとしては出せる）。 */
function resolveLandmark(entryName, wd) {
  const names = new Set([entryName, wd.labelJa, wd.labelEn].filter(Boolean).map(norm));
  for (const l of landmarks) if (names.has(norm(l.name))) return { landmarkId: l.id, landmarkName: l.name };
  return null;
}

// ══ 生成 ══════════════════════════════════════════════════════
const entries = [...curated.entries, ...(manual.entries || [])];
const records = [];
const stats = { requested: entries.length, withPhoto: 0, noPhoto: 0, noLicense: 0,
  high: 0, medium: 0, unresolved: 0, wikidataMissing: 0, landmarkLinked: 0 };

console.log('[35Z] ' + entries.length + ' 件を Wikidata / Commons から組み立てる');
for (const ent of entries) {
  let wd = null;
  try { wd = await wikidataEntity(ent.wikidataId); } catch (e) { /* noop */ }
  if (!wd) {
    stats.wikidataMissing++;
    console.log('  ' + ent.name.padEnd(22), 'Wikidata 取得できず');
    continue;
  }
  // curation 時に控えた座標と食い違うなら、別物を掴んでいる可能性があるので採用しない
  if (ent.expectLat != null && wd.lat != null) {
    const dLat = Math.abs(wd.lat - ent.expectLat), dLon = Math.abs(wd.lon - ent.expectLon);
    if (dLat > 0.01 || dLon > 0.01) {
      console.log('  ' + ent.name.padEnd(22), 'Wikidata の座標が curation と食い違う。採用しない');
      continue;
    }
  }

  const photos = [];
  for (const f of wd.images.slice(0, 3)) {
    try {
      const p = await commonsPhoto(f);
      if (p) photos.push(p); else stats.noLicense++;
    } catch (e) { /* noop */ }
    await sleep(900);
  }

  const m = resolveBuilding(ent.name, wd);
  const lm = resolveLandmark(ent.name, wd);
  if (lm) stats.landmarkLinked++;
  stats[m.confidence]++;
  if (photos.length) stats.withPhoto++; else stats.noPhoto++;

  records.push({
    canonicalId: m.canonicalId,
    buildingName: m.matchedName || ent.name,
    curatedName: ent.name,
    wikidataId: wd.qid,
    wikidataLabel: wd.labelJa || wd.labelEn || null,
    wikipediaUrl: wd.wikipediaJa,
    landmarkId: lm ? lm.landmarkId : null,
    lat: wd.lat, lon: wd.lon,
    matchConfidence: m.confidence,
    matchReason: m.reason,
    matchDistanceM: m.distanceM,
    photos,
  });
  console.log('  ' + ent.name.padEnd(22), m.confidence.padEnd(10),
    (photos.length + '枚').padStart(3), m.canonicalId ? m.canonicalId.slice(0, 26) : '(建物未特定)');
  await sleep(900);
}

// 同じ canonicalId を 2 件以上が主張したら、どちらかは必ず誤り。high だけ残す。
//   （実測で「大阪市役所 / 大阪市中央公会堂」「なんばパークス / パークスタワー」が衝突した）
const claim = new Map();
for (const r of records) {
  if (!r.canonicalId) continue;
  if (!claim.has(r.canonicalId)) claim.set(r.canonicalId, []);
  claim.get(r.canonicalId).push(r);
}
let collisions = 0;
for (const [cid, list] of claim) {
  if (list.length < 2) continue;
  const highs = list.filter((r) => r.matchConfidence === 'high');
  for (const r of list) {
    if (highs.length === 1 && r === highs[0]) continue;
    collisions++;
    r.canonicalId = null;
    r.matchConfidence = 'unresolved';
    r.matchReason = '同じ建物を複数の写真が主張したため採用しない（' + list.map((x) => x.curatedName).join(' / ') + '）';
  }
}
stats.collisionsDropped = collisions;
// 集計し直す（B 経路を外したので medium は出ない）
stats.high = 0; stats.medium = 0; stats.unresolved = 0;
for (const r of records) stats[r.matchConfidence]++;

// canonicalId を引けるように索引化。写真ゼロのものは載せない（no-photo は runtime の既定）。
const byCanonical = {};
const byLandmark = {};
for (const r of records) {
  if (!r.photos.length) continue;
  if (r.canonicalId) byCanonical[r.canonicalId] = r;
  if (r.landmarkId) byLandmark[r.landmarkId] = r;
}

const out = {
  version: 1, mission: '35Z', generatedAt: new Date().toISOString(),
  coordinateConvention: 'znorth-neg-v1',
  sources: ['wikidata', 'wikimedia-commons'],
  policy: {
    hoverShows: 'high',
    clickShows: ['high', 'medium'],
    rejectsWithoutLicense: true,
    noLiveLookup: '実行時にネットへ問い合わせない。この JSON だけを読む。',
  },
  counts: {
    ...stats,
    records: records.length,
    indexedByCanonicalId: Object.keys(byCanonical).length,
    indexedByLandmarkId: Object.keys(byLandmark).length,
  },
  byCanonicalId: byCanonical,
  byLandmarkId: byLandmark,
  records,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(path.join(REPORT_DIR, 'photo-index-build.json'), JSON.stringify({ counts: out.counts, records }, null, 2));

console.log('\n== 内訳 ==');
console.log('  high', stats.high, '/ medium', stats.medium, '/ unresolved', stats.unresolved);
console.log('  写真あり', stats.withPhoto, '/ 写真なし', stats.noPhoto, '/ ライセンス不明で落とした', stats.noLicense);
console.log('  canonicalId で引ける', Object.keys(byCanonical).length, '/ landmark で引ける', Object.keys(byLandmark).length);
console.log('out', OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + 'KB');
