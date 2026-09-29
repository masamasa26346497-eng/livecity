// [Mission 36H follow-up] 近傍に複数候補があるときの第二段階（保守的な曖昧さ解消）のテスト。
// 距離の近さだけでは採らない。名前・タイプ・所在地・座標の全証拠が唯一の候補に揃うときだけ VERIFIED。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { classifyPilotMatch } from '../tools/google-places/lib/pilot-matching.mjs';
import { coreName } from '../tools/google-places/lib/cross-language-name.mjs';
import { IDENTITY_FIELD_MASK } from '../tools/google-places/lib/field-mask.mjs';
import { createPlacesClient } from '../tools/google-places/lib/places-client.mjs';
import { assertDurableRecordSafe } from '../tools/google-places/lib/persistence-guard.mjs';
import { runPilotMatch } from '../tools/google-places/match-pilot-places.mjs';

const CANDIDATES = JSON.parse(fs.readFileSync(
  new URL('../data/photos/google-places-pilot-candidates.json', import.meta.url), 'utf-8')).candidates;
const cand = (n) => CANDIDATES.find((c) => c.name === n);
const ADDR = '日本、大阪府大阪市';
const place = (c, id, name, primaryType, extra = {}) => ({
  placeId: id, displayName: name, lat: c.expectLat + 0.00005, lon: c.expectLon,
  primaryType, types: primaryType ? [primaryType] : [], formattedAddress: ADDR, ...extra,
});

// 実パイロットの AMBIGUOUS（名前一致が複数）パターン。1件だけが名前・タイプ・所在地を満たし、
// もう1件は同名だがタイプが異なる（例: ATM・駐車場・別機能）。
const PATTERNS = [
  ['市立矢田小学校', '大阪市立矢田小学校', 'primary_school', 'sports_complex'],
  ['大阪府立東住吉支援学校', '大阪府立東住吉支援学校', 'school', 'bus_station'],
  ['住吉区民センター', '住吉区民センター', 'community_center', 'parking'],
  ['住吉郵便局', '住吉郵便局', 'post_office', 'atm'],
];

for (const [ja, googleName, type, otherType] of PATTERNS) {
  const otherName = googleName; // 名前だけでは区別できない（実データの「名前一致が複数」を再現）
  test('[36H 第二段階] ' + ja + ': 同名の複数近傍から、証拠が唯一揃う候補だけ VERIFIED', () => {
    const c = cand(ja);
    assert.ok(c);
    const target = place(c, 'target', googleName, type);
    const other = place(c, 'other', otherName, otherType, { lat: c.expectLat - 0.00003 });
    const r = classifyPilotMatch(c, [other, target]);
    assert.equal(r.matchConfidence, 'VERIFIED', r.reason);
    assert.equal(r.googlePlaceId, 'target');
    assert.match(r.reason, /disambiguated/);
  });

  test('[36H 第二段階] ' + ja + ': 同じ証拠を満たす候補が2件（同点）なら AMBIGUOUS のまま', () => {
    const c = cand(ja);
    const a = place(c, 'a', googleName, type);
    const b = place(c, 'b', googleName, type, { lat: c.expectLat - 0.00003 });
    const r = classifyPilotMatch(c, [a, b]);
    assert.equal(r.matchConfidence, 'AMBIGUOUS');
    assert.equal(r.googlePlaceId, null);
  });
}

test('[36H 第二段階] 負例: 最も近い候補でも名前が違えば採らない（距離だけで選ばない）', () => {
  const c = cand('住吉郵便局');
  const closest = place(c, 'closest', '別の郵便局', 'post_office', { lat: c.expectLat, lon: c.expectLon });
  const farther = place(c, 'farther', 'ゆうちょ銀行', 'bank', { lat: c.expectLat + 0.0004 });
  assert.notEqual(classifyPilotMatch(c, [closest, farther]).matchConfidence, 'VERIFIED');
});

test('[36H 第二段階] 負例: 唯一の一致候補でも、タイプ情報なしの同名競合が居れば採らない（証拠不足）', () => {
  const c = cand('住吉郵便局');
  const good = place(c, 'good', '住吉郵便局', 'post_office');
  const unknown = place(c, 'unknown', '住吉郵便局', null); // 同名でタイプ不明 → 別施設の可能性を排除できない
  assert.equal(classifyPilotMatch(c, [good, unknown]).matchConfidence, 'AMBIGUOUS');
});

test('[36H 第二段階] 負例: 所在地が無い／大阪でない候補は唯一でも採らない', () => {
  const c = cand('住吉区民センター');
  const mk = (id, address) => place(c, id, '住吉区民センター', 'community_center', { formattedAddress: address });
  assert.equal(classifyPilotMatch(c, [mk('x', null), mk('y', null)]).matchConfidence, 'AMBIGUOUS');
  assert.equal(classifyPilotMatch(c, [mk('x', '千葉県'), mk('y', '千葉県')]).matchConfidence, 'AMBIGUOUS');
});

test('[36H 第二段階] 120m の閾値は不変: 範囲外の唯一一致は第二段階でも採らない', () => {
  const c = cand('住吉郵便局');
  const far = place(c, 'far', '住吉郵便局', 'post_office', { lat: c.expectLat + 0.0013 });
  const near2 = place(c, 'near2', '別施設A', 'parking');
  const near3 = place(c, 'near3', '別施設B', 'parking');
  assert.notEqual(classifyPilotMatch(c, [far, near2, near3]).matchConfidence, 'VERIFIED');
});

test('[36H 第二段階] 名前が一致しない複数近傍は needsDetailsFor を返し、Details 後に唯一一致なら VERIFIED', () => {
  const c = cand('錦秀会阪和住吉総合病院');
  const a = place(c, 'a', 'Hanwa Sumiyoshi General Hospital', 'hospital');
  const b = place(c, 'b', 'Some Clinic', 'doctor');
  const first = classifyPilotMatch(c, [a, b]);
  assert.equal(first.matchConfidence, 'AMBIGUOUS');
  assert.deepEqual(first.needsDetailsFor, ['a', 'b']);
  const second = classifyPilotMatch(c, [a, b], { detailsByPlaceId: {
    a: { placeId: 'a', displayName: '阪和住吉総合病院', formattedAddress: ADDR, lat: a.lat, lon: a.lon, types: ['hospital'] },
    b: { placeId: 'b', displayName: 'Some Clinic', formattedAddress: ADDR, lat: b.lat, lon: b.lon, types: ['doctor'] },
  } });
  // 「阪和住吉総合病院」は核名（運営接頭辞「錦秀会」除去後）と完全一致する
  assert.equal(coreName('錦秀会阪和住吉総合病院'), coreName('阪和住吉総合病院'));
  assert.equal(second.matchConfidence, 'VERIFIED', second.reason);
  assert.equal(second.googlePlaceId, 'a');
  assert.equal(second.needsDetailsFor, undefined);
});

test('[36H 第二段階] 負例: Details 後も名前が合う候補が無ければ AMBIGUOUS のまま（四恩学園診療所）', () => {
  const c = cand('四恩学園診療所');
  const a = place(c, 'a', 'Shion Clinic', 'doctor');
  const b = place(c, 'b', 'Other Clinic', 'doctor');
  const r = classifyPilotMatch(c, [a, b], { detailsByPlaceId: {
    a: { placeId: 'a', displayName: 'Shion Clinic', formattedAddress: ADDR, lat: a.lat, lon: a.lon, types: ['doctor'] },
    b: { placeId: 'b', displayName: 'Other Clinic', formattedAddress: ADDR, lat: b.lat, lon: b.lon, types: ['doctor'] },
  } });
  assert.equal(r.matchConfidence, 'AMBIGUOUS');
  assert.equal(r.googlePlaceId, null);
});

test('[36H 第二段階] 負例: Details の座標が閾値外なら（検索結果と矛盾）採らない', () => {
  const c = cand('錦秀会阪和住吉総合病院');
  const a = place(c, 'a', 'x', 'hospital');
  const b = place(c, 'b', 'y', 'doctor');
  const r = classifyPilotMatch(c, [a, b], { detailsByPlaceId: {
    a: { placeId: 'a', displayName: '阪和住吉総合病院', formattedAddress: ADDR, lat: c.expectLat + 0.01, lon: c.expectLon, types: ['hospital'] },
  } });
  assert.notEqual(r.matchConfidence, 'VERIFIED');
});

test('[36H 第二段階] 距離の遠い2件（矢田・のぞみ信用組合）は Details 対象にもならず UNRESOLVED', () => {
  for (const [name, type] of [['矢田', 'train_station'], ['のぞみ信用組合', 'bank']]) {
    const c = cand(name);
    const far = place(c, 'far', name, type, { lat: c.expectLat + 0.005 });
    const r = classifyPilotMatch(c, [far]);
    assert.equal(r.matchConfidence, 'UNRESOLVED');
    assert.equal(r.needsDetailsFor, undefined);
  }
});

test('[36H 第二段階] getPlaceIdentity は photos を含まないマスクで、写真情報を返さない', async () => {
  assert.ok(!IDENTITY_FIELD_MASK.some((f) => /photo/i.test(f)));
  let hdr = null;
  const fetchImpl = async (u, o) => {
    hdr = o.headers['X-Goog-FieldMask'];
    return { ok: true, json: async () => ({ id: 'p', displayName: { text: '住吉郵便局' },
      location: { latitude: 1, longitude: 2 }, types: ['post_office'], photos: [{ name: 'places/p/photos/x' }] }) };
  };
  const client = createPlacesClient({ apiKey: 'FAKE_KEY', fetchImpl });
  const r = await client.getPlaceIdentity('p');
  assert.ok(r.ok);
  assert.ok(!/photo/i.test(hdr));
  assert.equal(JSON.stringify(r).includes('photos'), false);
});

test('[36H 第二段階] runPilotMatch: Details は AMBIGUOUS の候補にだけ、上限付きで呼ぶ', async () => {
  let searches = 0; let identities = 0;
  const fetchImpl = async (url, opts) => {
    if (String(url).includes(':searchText')) {
      searches++;
      const q = JSON.parse(opts.body).textQuery;
      const c = CANDIDATES.find((x) => x.name === q);
      const mk = (id, name, t) => ({ id, displayName: { text: name }, formattedAddress: ADDR,
        location: { latitude: c.expectLat + 0.00003, longitude: c.expectLon }, primaryType: t, types: [t] });
      if (q === '住吉郵便局') {
        return { ok: true, json: async () => ({ places: [mk('p1', '住吉郵便局', 'post_office'), mk('p2', '住吉郵便局 ATM', 'atm')] }) };
      }
      return { ok: true, json: async () => ({ places: [] }) };
    }
    identities++;
    return { ok: true, json: async () => ({ id: 'p1', displayName: { text: '住吉郵便局' }, types: ['post_office'] }) };
  };
  const r = await runPilotMatch({ apiKey: 'FAKE_KEY', fetchImpl, dryRun: true,
    rateGuard: { maxRequestsPerWindow: 200, maxRequestsPerSession: 200 } });
  assert.equal(searches, 30);
  // 住吉郵便局は Text Search 段階の第二段階で決着するため、Details は不要（0件）
  assert.equal(identities, 0);
  const rec = r.mapping.entries.find((e) => e.name === '住吉郵便局');
  assert.equal(rec.googlePlaceId, 'p1');
  assert.doesNotThrow(() => assertDurableRecordSafe(rec));
  assert.ok(!/photo/i.test(JSON.stringify(r.mapping.entries)));
});
