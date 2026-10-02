// [Mission 36H follow-up] 言語違い（日本語名 ↔ 英語/ローマ字 displayName）の保守的マッチングのテスト。
// 実パイロット結果（VERIFIED 4 / UNRESOLVED 26）で報告された実例に基づく。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { classifyPilotMatch } from '../tools/google-places/lib/pilot-matching.mjs';
import { crossLanguageNameAgree, typesCompatible } from '../tools/google-places/lib/cross-language-name.mjs';
import { createPlacesClient } from '../tools/google-places/lib/places-client.mjs';

const PILOT_CANDIDATES = JSON.parse(fs.readFileSync(
  new URL('../data/photos/google-places-pilot-candidates.json', import.meta.url), 'utf-8')).candidates;
const pilotByName = (n) => PILOT_CANDIDATES.find((c) => c.name === n);
const near = (c, en, primaryType, extra = {}) => ({
  placeId: 'gp-' + en, displayName: en, lat: c.expectLat + 0.00004, lon: c.expectLon,
  primaryType, types: primaryType ? [primaryType] : [], formattedAddress: 'Osaka, Japan', ...extra,
});

const REAL_CASES = [
  ['あびこ病院', 'Abiko Hospital', 'hospital'],
  ['市立我孫子中学校', 'Abiko Junior High School', 'secondary_school'],
  ['城南学園中学校', 'Jonan Gakuen Junior High School', 'secondary_school'],
  ['大阪市立南住吉小学校', 'Minamisumiyoshi Elementary School', 'primary_school'],
  ['住吉区役所', 'Sumiyoshi Ward Office', 'local_government_office'],
  ['大阪市立住吉図書館', 'Sumiyoshi Library', 'library'],
  ['大阪市消防局東住吉消防署矢田出張所', 'Higashisumiyoshi Fire Station Yata Branch', 'fire_station'],
  ['東住吉警察署矢田駅前交番', 'Higashisumiyoshi Police Station Yata Ekimae Police Box', 'police'],
  ['住吉我孫子郵便局', 'Sumiyoshi Abiko Post Office', 'post_office'],
  ['スーパー玉出 アビコ店', 'Tamade Supermarket - Abiko', 'supermarket'],
  ['ライフ', 'Life Abiko', 'supermarket'],
  ['式内大社 中臣須牟地神社', 'Nakatomi Sumuchi Shrine', 'shinto_shrine'],
];

for (const [ja, en, type] of REAL_CASES) {
  test('[36H follow-up] 実例: ' + ja + ' → ' + en + ' は近傍1件・タイプ互換なら VERIFIED', () => {
    const c = pilotByName(ja);
    assert.ok(c, 'candidate exists: ' + ja);
    const r = classifyPilotMatch(c, [near(c, en, type)]);
    assert.equal(r.matchConfidence, 'VERIFIED', r.reason);
    assert.match(r.reason, /cross-language/);
  });
}

test('[36H follow-up] 負例: 名前は合うがタイプが非互換なら採らない', () => {
  const c = pilotByName('あびこ病院');
  const r = classifyPilotMatch(c, [near(c, 'Abiko Hospital', 'restaurant')]);
  assert.notEqual(r.matchConfidence, 'VERIFIED');
  assert.equal(r.googlePlaceId, null);
});

test('[36H follow-up] 負例: タイプ情報が無ければ（証拠不足）採らない', () => {
  const c = pilotByName('住吉区役所');
  assert.notEqual(classifyPilotMatch(c, [near(c, 'Sumiyoshi Ward Office', null)]).matchConfidence, 'VERIFIED');
});

test('[36H follow-up] 負例: 近くにあるが別名の施設（地名/種別が違う）は採らない', () => {
  const c = pilotByName('住吉区役所');
  assert.notEqual(classifyPilotMatch(c, [near(c, 'Sumiyoshi Library', 'local_government_office')]).matchConfidence, 'VERIFIED');
  assert.notEqual(classifyPilotMatch(c, [near(c, 'Hirano Ward Office', 'local_government_office')]).matchConfidence, 'VERIFIED');
  const s = pilotByName('城南学園高等学校');
  assert.notEqual(classifyPilotMatch(s, [near(s, 'Jonan Gakuen Junior High School', 'secondary_school')]).matchConfidence, 'VERIFIED');
  const h = pilotByName('あびこ病院');
  assert.notEqual(classifyPilotMatch(h, [near(h, 'Sumiyoshi Hospital', 'hospital')]).matchConfidence, 'VERIFIED');
});

test('[36H follow-up] 負例: 語彙で説明できない固有名（未登録）は言語違いでも採らない', () => {
  const c = pilotByName('錦秀会阪和病院');
  assert.notEqual(classifyPilotMatch(c, [near(c, 'Kinshukai Hanwa Hospital', 'hospital')]).matchConfidence, 'VERIFIED');
});

test('[36H follow-up] 近傍に複数候補があれば AMBIGUOUS のまま', () => {
  const c = pilotByName('あびこ病院');
  const r = classifyPilotMatch(c, [near(c, 'Abiko Hospital', 'hospital'),
    { ...near(c, 'Abiko Hospital Annex', 'hospital'), placeId: 'gp-2' }]);
  assert.equal(r.matchConfidence, 'AMBIGUOUS');
  assert.equal(r.googlePlaceId, null);
});

test('[36H follow-up] 遠い結果（矢田駅・のぞみ信用組合相当）は UNRESOLVED のまま', () => {
  const st = pilotByName('矢田');
  const far1 = { ...near(st, 'Yata Station', 'train_station'), lat: st.expectLat + 0.0049 };
  assert.equal(classifyPilotMatch(st, [far1]).matchConfidence, 'UNRESOLVED');
  const b = pilotByName('のぞみ信用組合');
  const far2 = { ...near(b, 'Nozomi Shinyo Kumiai', 'bank'), lat: b.expectLat + 0.0206 };
  assert.equal(classifyPilotMatch(b, [far2]).matchConfidence, 'UNRESOLVED');
});

test('[36H follow-up] 120m の閾値は不変（約130m離れた一致は採らない）', () => {
  const c = pilotByName('あびこ病院');
  const p = { ...near(c, 'Abiko Hospital', 'hospital'), lat: c.expectLat + 0.00117 };
  assert.equal(classifyPilotMatch(c, [p]).matchConfidence, 'UNRESOLVED');
});

test('[36H follow-up] 所在地が大阪でなければ採らない / ヘルパーの基本動作', () => {
  const c = pilotByName('あびこ病院');
  assert.notEqual(classifyPilotMatch(c, [near(c, 'Abiko Hospital', 'hospital', { formattedAddress: 'Chiba, Japan' })]).matchConfidence, 'VERIFIED');
  assert.equal(typesCompatible('hospital', { primaryType: 'hospital' }), true);
  assert.equal(typesCompatible('hospital', { primaryType: 'restaurant', types: [] }), false);
  assert.equal(crossLanguageNameAgree('あびこ病院', 'Abiko Hospital').ok, true);
});

test('[36H follow-up] searchText は languageCode=ja を要求し types を保持する', async () => {
  let sent = null;
  const fetchImpl = async (u, o) => {
    sent = JSON.parse(o.body);
    return { ok: true, json: async () => ({ places: [{ id: 'p', displayName: { text: 'x' },
      location: { latitude: 1, longitude: 2 }, primaryType: 'hospital', types: ['hospital', 'health'] }] }) };
  };
  const client = createPlacesClient({ apiKey: 'FAKE_KEY', fetchImpl });
  const r = await client.searchText({ textQuery: 'あびこ病院', lat: 1, lon: 2 });
  assert.equal(sent.languageCode, 'ja');
  assert.deepEqual(r.places[0].types, ['hospital', 'health']);
});
