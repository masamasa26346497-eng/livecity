// tools/photos/audit-footprint-matches.mjs
// [Mission 36A §11] 自動採用した対応付けを 100 件以上監査する。
//   目標は「自動採用した HIGH / VERY_HIGH に wrong building が 0 件」。
//
//   独立した証拠として次を突き合わせる:
//     1. 名前の一致（35O の建物名 vs Wikidata ラベル）
//     2. 36F（距離方式）の結果と一致するか
//     3. 採用した建物の footprint に本当に点が入っているか（作り直して再確認）
//     4. 同じ点が 2 棟以上に入っていないか
//     5. Wikidata 座標から採用建物の重心までの距離
import fs from 'node:fs';
import path from 'node:path';
import { buildingsAt, toLocal, featureAreaM2 } from './footprint-lookup.mjs';
import { compareNames } from './lib/footprint-photo-matching.mjs';

const INDEX = 'public/map-data/osaka-city/derived/building-photo-index.json';
const PREV = process.env.PREV_INDEX
  || 'C:/Users/user/AppData/Local/Temp/claude/c--Users-user-OneDrive--------LiveCity-livecity-data-pipeline/4bbd7027-f769-48c2-8529-fefe15e7666d/scratchpad/photo-index-36F-backup.json';
const BUILDING_NAMES = 'public/map-data/osaka-city/derived/building-name-labels.json';
const OUT_DIR = 'data/reports/mission36a-footprint-photo-matching';
const N = Number(process.env.AUDIT_N || 120);

const idx = JSON.parse(fs.readFileSync(INDEX, 'utf-8'));
const nameById = new Map();
for (const b of (JSON.parse(fs.readFileSync(BUILDING_NAMES, 'utf-8')).labels || [])) {
  if (b.id && b.name) nameById.set(b.id, b.name);
}
const prevById = new Map();
if (fs.existsSync(PREV)) {
  for (const r of JSON.parse(fs.readFileSync(PREV, 'utf-8')).records || []) {
    if (r.wikidataId) prevById.set(r.wikidataId, r);
  }
}

// 自動採用したもの（hover に出るもの）だけを監査対象にする
const accepted = idx.records.filter((r) => r.canonicalId
  && (r.matchConfidence === 'HIGH' || r.matchConfidence === 'VERY_HIGH')
  && r.photos && r.photos.length);
console.log('[36A audit] 自動採用 ' + accepted.length + ' 件から ' + N + ' 件を抜き取る');

// 偏らないよう等間隔で抜く
const step = Math.max(1, Math.floor(accepted.length / N));
const sample = [];
for (let i = 0; i < accepted.length && sample.length < N; i += step) sample.push(accepted[i]);

const tally = { correct: 0, wrong: 0, ambiguous: 0, noMatch: 0 };
const evidence = { nameAgree: 0, landmark: 0, geometryOnly: 0 };
const agree36F = { same: 0, differ: 0, prevHadNone: 0 };
const problems = [];
const rows = [];

for (const r of sample) {
  const p = toLocal(r.lat, r.lon);
  const hits = buildingsAt(p.x, p.z).map((f) => ({
    canonicalId: f.canonicalId, areaM2: featureAreaM2(f),
    name: nameById.get(f.canonicalId) || null,
    centroid: f.centroid,
  }));
  const chosen = hits.find((h) => h.canonicalId === r.canonicalId) || null;
  const wdNames = [r.curatedName, r.wikidataLabel].filter(Boolean);
  const ev = chosen ? compareNames(wdNames, chosen.name) : 'none';
  const prev = prevById.get(r.wikidataId);
  const prevId = prev ? (prev.canonicalId || null) : null;
  if (!prevId) agree36F.prevHadNone++;
  else if (prevId === r.canonicalId) agree36F.same++;
  else agree36F.differ++;

  const dist = (chosen && chosen.centroid)
    ? +Math.hypot(chosen.centroid[0] - p.x, chosen.centroid[1] - p.z).toFixed(1) : null;

  // ── 判定 ───────────────────────────────────────────────────
  let verdict;
  if (!chosen) { verdict = 'noMatch'; problems.push({ q: r.wikidataId, why: '採用した建物に点が入っていない' }); }
  else if (ev === 'conflict') { verdict = 'wrong'; problems.push({ q: r.wikidataId, why: '名前が矛盾しているのに採用されている', got: chosen.name, want: wdNames[0] }); }
  else if (hits.length > 1 && ev !== 'agree') { verdict = 'ambiguous'; problems.push({ q: r.wikidataId, why: '点が ' + hits.length + ' 棟に入っているのに採用されている' }); }
  else verdict = 'correct';
  tally[verdict]++;

  if (ev === 'agree') evidence.nameAgree++;
  else if (r.landmarkId) evidence.landmark++;
  else evidence.geometryOnly++;

  rows.push({
    wikidataId: r.wikidataId, wikidataLabel: r.wikidataLabel, curatedName: r.curatedName,
    canonicalId: r.canonicalId, buildingName: chosen ? chosen.name : null,
    matchConfidence: r.matchConfidence, nameEvidence: ev, insideCount: hits.length,
    centroidDistanceM: dist, prev36F: prevId, agreesWith36F: prevId ? (prevId === r.canonicalId) : null,
    verdict,
  });
}

const out = {
  mission: '36A', generatedAt: new Date().toISOString(),
  acceptedTotal: accepted.length, audited: rows.length,
  tally,
  accuracy: +(tally.correct / rows.length * 100).toFixed(1),
  evidence,
  agreementWith36F: agree36F,
  problems,
  rows,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'match-audit.json'), JSON.stringify(out, null, 2));

console.log('== 監査 ' + rows.length + ' 件 ==');
console.log('  correct  ', tally.correct);
console.log('  wrong    ', tally.wrong);
console.log('  ambiguous', tally.ambiguous);
console.log('  no match ', tally.noMatch);
console.log('  accuracy ', out.accuracy + '%');
console.log('== 採用の根拠 ==', JSON.stringify(evidence));
console.log('== 36F(距離方式)との一致 ==', JSON.stringify(agree36F));
if (problems.length) { console.log('== 問題 =='); for (const p of problems.slice(0, 10)) console.log('  ', JSON.stringify(p)); }
console.log('out', path.join(OUT_DIR, 'match-audit.json'));
