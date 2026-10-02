// tools/photos/rematch-photos-by-footprint.mjs
// [Mission 36A] 既にある写真索引の「建物への結び付け」を、距離ではなく
//   **footprint の内外（point-in-polygon）** でやり直す。
//
//   写真そのもの（Commons の URL・ライセンス・著者）は 35Z/36F が取得済みなので触らない。
//   ネットワークは使わない。やるのは対応付けの引き直しだけ。
//
//   実行: node --max-old-space-size=4096 tools/photos/rematch-photos-by-footprint.mjs
import fs from 'node:fs';
import path from 'node:path';
import { buildingsAt, toLocal, featureAreaM2, lookupStats } from './footprint-lookup.mjs';
import { classifyFootprintMatch, showsOnHover, normalizeName } from './lib/footprint-photo-matching.mjs';
import { pickPreferredPhoto, scorePhoto } from './lib/photo-preference.mjs';

const INDEX = 'public/map-data/osaka-city/derived/building-photo-index.json';
const MANUAL = 'data/photos/building-photo-manual.json';
// canonical 建物タイルの属性には **名前が無い**（usage / heightM / wardId などだけ）。
//   §6 の「名前が矛盾するなら採らない」を効かせるため、35O が作った
//   canonicalId → 実在する建物名 の対応をここで読み込む。
const BUILDING_NAMES = 'public/map-data/osaka-city/derived/building-name-labels.json';
const REPORT_DIR = 'data/reports/mission36a-footprint-photo-matching';

const idx = JSON.parse(fs.readFileSync(INDEX, 'utf-8'));
const nameById = new Map();
if (fs.existsSync(BUILDING_NAMES)) {
  for (const b of (JSON.parse(fs.readFileSync(BUILDING_NAMES, 'utf-8')).labels || [])) {
    if (b.id && b.name) nameById.set(b.id, b.name);
  }
}
console.log('[36A] 建物名を引ける canonicalId: ' + nameById.size.toLocaleString() + ' 件');
const manual = fs.existsSync(MANUAL) ? JSON.parse(fs.readFileSync(MANUAL, 'utf-8')) : { entries: [] };
const manualBy = new Map((manual.entries || []).map((e) => [e.wikidataId, e]));

const before = {
  records: idx.records.length,
  indexedByCanonicalId: Object.keys(idx.byCanonicalId || {}).length,
  byConfidence: {}, byMethod: {},
};
for (const r of idx.records) {
  before.byConfidence[r.matchConfidence] = (before.byConfidence[r.matchConfidence] || 0) + 1;
  const m = r.matchMethod || 'curated';
  before.byMethod[m] = (before.byMethod[m] || 0) + 1;
}

const stats = { VERY_HIGH: 0, HIGH: 0, AMBIGUOUS: 0, UNRESOLVED: 0 };
const byType = {};
const byWard = {};
const ambiguityReasons = {};
const nameEvidence = {};
let withPhoto = 0, insideAny = 0, changedFromBefore = 0, preferredApplied = 0, nameConflictRejected = 0;

console.log('[36A] ' + idx.records.length + ' 件を footprint で引き直す（ネットワークは使わない）');
const t0 = Date.now();
let n = 0;
for (const r of idx.records) {
  n++;
  if (n % 400 === 0) process.stdout.write('\r  ' + n + ' / ' + idx.records.length
    + '  (' + Math.round((Date.now() - t0) / 1000) + 's)');
  const hadPhoto = !!(r.photos && r.photos.length);
  if (hadPhoto) withPhoto++;

  // §9 写真の並べ替え（全景が分かる 1 枚を先頭へ）。指定があればそれを最優先。
  if (hadPhoto) {
    const man = manualBy.get(r.wikidataId);
    const picked = pickPreferredPhoto(r.photos, man);
    if (picked.appliedManual) preferredApplied++;
    r.photos = picked.photos;
    r.photoScores = picked.scores;
    r.preferredFrom = picked.appliedManual ? 'manual' : 'score';
  }

  const beforeId = r.canonicalId || null;

  if (r.lat == null || r.lon == null) {
    r.matchMethod = 'footprint';
    r.matchConfidence = 'UNRESOLVED';
    r.matchType = 'unresolved';
    r.insideFootprint = false;
    r.footprintCanonicalId = null;
    r.canonicalId = null;
    r.matchReason = 'Wikidata に座標が無い';
    stats.UNRESOLVED++;
    continue;
  }

  const p = toLocal(r.lat, r.lon);
  const hits = buildingsAt(p.x, p.z).map((f) => ({
    canonicalId: f.canonicalId,
    // タイル属性に名前は無いので 35O の索引から引く
    name: nameById.get(f.canonicalId)
      || (f.attributes && (f.attributes.name || f.attributes.buildingName)) || null,
    areaM2: featureAreaM2(f),
    wardId: (f.attributes && f.attributes.wardId) || null,
  }));
  if (hits.length) insideAny++;

  // **Wikidata 側の呼び名だけ**を使う。r.buildingName は前回の対応付けで入った
  //   「建物側の名前」なので、これを混ぜると名前が矛盾していても自分自身と一致してしまう
  //   （監査で 120 件中 6 件がこれで誤って採用されていた）。
  const names = [r.curatedName, r.wikidataLabel].filter(Boolean);
  const cls = classifyFootprintMatch(hits, names, {
    landmarkId: r.landmarkId || null,
    osmId: r.osmId || null,
    instanceLabels: r.instanceLabels || [],
  });

  r.matchMethod = 'footprint';
  r.matchConfidence = cls.matchConfidence;
  r.matchType = cls.matchType;
  r.nameEvidence = cls.nameEvidence;
  r.ambiguityReason = cls.ambiguityReason;
  r.matchReason = cls.reason;
  r.insideFootprint = hits.length > 0;
  r.insideFootprintCount = hits.length;
  r.footprintCanonicalId = cls.canonicalId;
  r.footprintCandidates = cls.candidates.slice(0, 6);
  r.wikidataCoordinate = { lat: r.lat, lon: r.lon, x: +p.x.toFixed(2), z: +p.z.toFixed(2) };
  r.canonicalId = cls.canonicalId;
  // 建物名は「結び付いた建物の名前」ではなく、写真の対象名を出す（hover の見出し用）
  if (cls.canonicalId) {
    const hit = hits.find((h) => h.canonicalId === cls.canonicalId);
    r.footprintBuildingName = hit ? hit.name : null;
    r.ward = hit ? hit.wardId : null;
    if (hit && hit.wardId) byWard[hit.wardId] = (byWard[hit.wardId] || 0) + 1;
  } else { r.footprintBuildingName = null; r.ward = null; }

  if (cls.nameEvidence === 'conflict') nameConflictRejected++;
  stats[cls.matchConfidence]++;
  byType[cls.matchType] = (byType[cls.matchType] || 0) + 1;
  if (cls.matchConfidence !== 'UNRESOLVED' || cls.nameEvidence !== 'none') {
    nameEvidence[cls.nameEvidence] = (nameEvidence[cls.nameEvidence] || 0) + 1;
  }
  if (cls.ambiguityReason) ambiguityReasons[cls.ambiguityReason] = (ambiguityReasons[cls.ambiguityReason] || 0) + 1;
  if ((beforeId || null) !== (cls.canonicalId || null)) changedFromBefore++;
}
process.stdout.write('\n');

// ── 同じ建物を複数の記録が主張したら 1 つに絞る ────────────────
//   索引には curated / direct-id / citywide の 3 経路が入っているので、同じ Wikidata item が
//   重複していることがある。また「あべのハルカス」と「あべのハルカス美術館」のように、
//   別の item が同じ建物を指すこともある。hover は 1 棟 1 枚なので、
//   いちばん根拠の強いものだけを残し、残りは AMBIGUOUS へ落とす（消しはしない）。
const RANK = { VERY_HIGH: 3, HIGH: 2, AMBIGUOUS: 1, UNRESOLVED: 0 };
const EV_RANK = { 'osm-id': 4, name: 3, landmark: 2, 'no-name': 1, none: 0 };
const claimants = new Map();
for (const r of idx.records) {
  // 写真の有無に関わらず、1 棟を主張できるのは 1 件だけにする
  //   （写真なしの主張も残しておくと、あとで写真が付いたときに衝突が復活する）
  if (!r.canonicalId) continue;
  if (!showsOnHover(r.matchConfidence)) continue;
  if (!claimants.has(r.canonicalId)) claimants.set(r.canonicalId, []);
  claimants.get(r.canonicalId).push(r);
}
let sharedDemoted = 0, duplicateQidDropped = 0;
for (const [cid, list] of claimants) {
  if (list.length < 2) continue;
  // 同じ Wikidata item の重複は「同じもの」なので、1 件だけ残す
  const seenQid = new Set();
  const uniq = [];
  for (const r of list) {
    if (r.wikidataId && seenQid.has(r.wikidataId)) {
      r.canonicalId = null; r.matchConfidence = 'AMBIGUOUS';
      r.ambiguityReason = 'duplicate-record';
      r.matchReason = '同じ Wikidata item の重複した記録';
      duplicateQidDropped++;
      continue;
    }
    if (r.wikidataId) seenQid.add(r.wikidataId);
    uniq.push(r);
  }
  if (uniq.length < 2) continue;
  const hasPhoto = (r) => (r.photos && r.photos.length) ? 1 : 0;
  uniq.sort((a, b) => (hasPhoto(b) - hasPhoto(a))
    || (RANK[b.matchConfidence] - RANK[a.matchConfidence])
    || ((EV_RANK[b.nameEvidence] || 0) - (EV_RANK[a.nameEvidence] || 0)));
  for (const r of uniq.slice(1)) {
    r.canonicalId = null;
    r.matchConfidence = 'AMBIGUOUS';
    r.ambiguityReason = 'shared-building';
    r.matchReason = '同じ建物を「' + (uniq[0].wikidataLabel || uniq[0].curatedName)
      + '」と取り合ったため、根拠の弱いほうを採らない';
    sharedDemoted++;
  }
}
// 落としたぶんを数え直す
stats.VERY_HIGH = 0; stats.HIGH = 0; stats.AMBIGUOUS = 0; stats.UNRESOLVED = 0;
for (const r of idx.records) stats[r.matchConfidence] = (stats[r.matchConfidence] || 0) + 1;

// ── 索引を作り直す（hover に出すのは HIGH / VERY_HIGH かつ写真があるものだけ） ──
const byCanonical = {};
const byLandmark = {};
let hoverBuildings = 0;
for (const r of idx.records) {
  if (!r.photos || !r.photos.length) continue;
  if (r.canonicalId && showsOnHover(r.matchConfidence)) {
    // 同じ建物を複数の写真が主張したら、確度の高いほうを残す
    const cur = byCanonical[r.canonicalId];
    if (!cur || (cur.matchConfidence !== 'VERY_HIGH' && r.matchConfidence === 'VERY_HIGH')) {
      byCanonical[r.canonicalId] = r;
    }
  }
  if (r.landmarkId) byLandmark[r.landmarkId] = r;
}
hoverBuildings = Object.keys(byCanonical).length;

idx.byCanonicalId = byCanonical;
idx.byLandmarkId = byLandmark;
idx.mission = '36A';
idx.generatedAt = new Date().toISOString();
idx.policy = {
  ...(idx.policy || {}),
  hoverShows: ['VERY_HIGH', 'HIGH'],
  clickShows: ['VERY_HIGH', 'HIGH', 'AMBIGUOUS'],
  matching: 'point-in-polygon（Wikidata の座標が実 building footprint の中にあるか）',
  noDistanceFallback: '距離だけの nearest matching は使わない',
  rejectsWithoutLicense: true,
  noLiveLookup: '実行時にネットへ問い合わせない。この JSON だけを読む。',
};
idx.counts = {
  ...(idx.counts || {}),
  records: idx.records.length,
  withPhoto,
  insideAnyFootprint: insideAny,
  byConfidence: stats,
  byMatchType: byType,
  byNameEvidence: nameEvidence,
  ambiguityReasons,
  indexedByCanonicalId: hoverBuildings,
  indexedByLandmarkId: Object.keys(byLandmark).length,
  wardCoverage: byWard,
  changedFromPreviousMatching: changedFromBefore,
  preferredPhotoApplied: preferredApplied,
  nameConflictRejected,
  sharedBuildingDemoted: sharedDemoted,
  duplicateRecordsDropped: duplicateQidDropped,
};

fs.writeFileSync(INDEX, JSON.stringify(idx, null, 1));
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(path.join(REPORT_DIR, 'rematch-report.json'), JSON.stringify({
  before, after: idx.counts, lookup: lookupStats(),
  elapsedSec: Math.round((Date.now() - t0) / 1000),
}, null, 2));

console.log('== 判定 ==');
for (const k of ['VERY_HIGH', 'HIGH', 'AMBIGUOUS', 'UNRESOLVED']) console.log('  ' + k.padEnd(11), stats[k]);
console.log('== matchType ==', JSON.stringify(byType));
console.log('== 名前の裏付け ==', JSON.stringify(nameEvidence));
console.log('== あいまいの理由 ==', JSON.stringify(ambiguityReasons));
console.log('footprint の中にあった', insideAny, '/', idx.records.length);
console.log('hover 対応建物', before.indexedByCanonicalId, '→', hoverBuildings);
console.log('区の数', Object.keys(byWard).length, '/ preferred 指定の適用', preferredApplied);
console.log('名前が矛盾して採らなかった', nameConflictRejected);
console.log('同じ建物の取り合いで落とした', sharedDemoted, '/ 同一 item の重複', duplicateQidDropped);
console.log('lookup', JSON.stringify(lookupStats()));
console.log('out', INDEX);
