// tests/mission36h-google-places-foundation.test.js
// [Mission 36H] Google Places写真の基盤。守りたいのは:
//   - APIキーが無ければ一切ネットワークへ出ない（no-key graceful fallback）
//   - 永続化してよいのは facilityId<->googlePlaceId の対応関係だけ（写真バイナリ・長期URLを書かない）
//   - 座標が近い/名前が似ているだけで確定しない（曖昧なら unresolved のまま）
//   - 同時リクエストの重複排除とレート上限が効く
//   - 表示するときは帰属（Google・著者）を必ず出す
//   - 既存の Wikimedia (BuildingPhoto / #pc-photo-section) を上書き・混線させない
//   - production / protected HTML には一切コードが漏れていない
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyRelevance, isRelevantFacility, RELEVANCE_CLASSES }
  from '../tools/google-places/lib/relevant-categories.mjs';
import { SEARCH_FIELD_MASK, DETAILS_FIELD_MASK, buildFieldMaskHeader, clampPhotoCount,
  MIN_PHOTOS_PER_PLACE, MAX_PHOTOS_PER_PLACE } from '../tools/google-places/lib/field-mask.mjs';
import { checkDurableRecordSafety, assertDurableRecordSafe, ALLOWED_DURABLE_FIELDS }
  from '../tools/google-places/lib/persistence-guard.mjs';
import { createRequestGuard, RateLimitExceededError } from '../tools/google-places/lib/rate-guard.mjs';
import { classifyPilotMatch, namesAgree, haversineMeters } from '../tools/google-places/lib/pilot-matching.mjs';
import { createPlacesClient } from '../tools/google-places/lib/places-client.mjs';
import { loadGooglePlacesApiKeyFromEnv } from '../tools/google-places/load-api-key.mjs';
import { runPilotMatch } from '../tools/google-places/match-pilot-places.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const CANDIDATES = path.join(ROOT, 'data', 'photos', 'google-places-pilot-candidates.json');
const FACILITIES = path.join(ROOT, 'data', 'processed', 'osaka-sumiyoshi', 'facilities', 'facilities.json');
const devHtml = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const gpLayer = () => devHtml.match(/const GooglePlacesPhoto = \(function \(\) \{[\s\S]*?\n\}\)\(\);/)[0];
const bpLayer = () => devHtml.match(/const BuildingPhoto = \(function \(\) \{[\s\S]*?\n\}\)\(\);/)[0];

// ── §7 no-key graceful fallback ─────────────────────────────────
test('[36H §7] APIキー無しでは places-client がネットワークへ出ない', async () => {
  let fetchCalled = false;
  const client = createPlacesClient({ apiKey: null, fetchImpl: async () => { fetchCalled = true; throw new Error('should not be called'); } });
  assert.equal(client.isEnabled(), false);
  const search = await client.searchText({ textQuery: 'x' });
  assert.deepEqual(search, { ok: false, reason: 'no-api-key', places: [] });
  const details = await client.getPlaceDetails('place123');
  assert.equal(details.ok, false);
  assert.equal(details.reason, 'no-api-key');
  const media = await client.getPhotoMediaUrl('places/x/photos/y');
  assert.equal(media.ok, false);
  assert.equal(media.reason, 'no-api-key');
  assert.equal(fetchCalled, false, 'キー無しなのにfetchが呼ばれた');
});

test('[36H §7] loadGooglePlacesApiKeyFromEnv は未設定なら例外を投げず null を返す', () => {
  assert.equal(loadGooglePlacesApiKeyFromEnv({}), null);
  assert.equal(loadGooglePlacesApiKeyFromEnv({ GOOGLE_PLACES_API_KEY: '  ' }), null);
  assert.equal(loadGooglePlacesApiKeyFromEnv({ GOOGLE_PLACES_API_KEY: 'abc' }), 'abc');
});

test('[36H §7] runPilotMatch はキー未設定でも例外を投げず ok:false を返す（ネットワークに出ない）', async () => {
  let fetchCalled = false;
  const r = await runPilotMatch({ apiKey: null, fetchImpl: async () => { fetchCalled = true; }, dryRun: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-api-key');
  assert.equal(fetchCalled, false);
});

// ── §7 field mask 最小化・写真枚数の上限 ─────────────────────────
test('[36H §7] field mask は最小集合で、ワイルドカードを禁止する', () => {
  assert.ok(SEARCH_FIELD_MASK.length > 0 && SEARCH_FIELD_MASK.every((f) => !f.includes('*')));
  assert.ok(DETAILS_FIELD_MASK.length > 0);
  for (const forbidden of ['reviews', 'regularOpeningHours', 'priceLevel', 'rating']) {
    assert.ok(!SEARCH_FIELD_MASK.some((f) => f.includes(forbidden)));
    assert.ok(!DETAILS_FIELD_MASK.some((f) => f.includes(forbidden)), forbidden + ' が field mask に含まれている');
  }
  assert.equal(buildFieldMaskHeader(['a', 'b']), 'a,b');
  assert.throws(() => buildFieldMaskHeader(['*']));
  assert.throws(() => buildFieldMaskHeader([]));
});

test('[36H §7] 写真枚数は 3〜5 枚に丸められる', () => {
  assert.equal(clampPhotoCount(1), MIN_PHOTOS_PER_PLACE);
  assert.equal(clampPhotoCount(100), MAX_PHOTOS_PER_PLACE);
  assert.equal(clampPhotoCount(undefined), 4);
});

// ── §5 durable persistence guard ────────────────────────────────
test('[36H §5] 許可されたフィールドだけの record は安全', () => {
  const rec = { facilityId: 'osm-node-1', googlePlaceId: 'ChIJabc123', name: 'x',
    relevanceClass: 'school', matchConfidence: 'VERIFIED', matchReason: 'ok',
    distanceMeters: 10, verifiedAt: new Date().toISOString(), verifiedBy: 'automated-pilot-match' };
  const { ok, violations } = checkDurableRecordSafety(rec);
  assert.equal(ok, true, JSON.stringify(violations));
  assert.deepEqual(Object.keys(rec).sort(), [...ALLOWED_DURABLE_FIELDS].sort());
});

test('[36H §5] 写真バイナリ・長期URL・resource nameは永続化を拒否される', () => {
  const cases = [
    { facilityId: 'a', googlePlaceId: 'x', photoUri: 'https://lh3.googleusercontent.com/abc' },
    { facilityId: 'a', googlePlaceId: 'x', thumbnailUrl: 'https://places.googleapis.com/v1/places/x/photos/y/media' },
    { facilityId: 'a', googlePlaceId: 'x', imageDataBase64: 'iVBORw0...' },
    { facilityId: 'a', googlePlaceId: 'x', resourceName: 'places/x/photos/y' },
    { facilityId: 'a', googlePlaceId: 'https://places.googleapis.com/v1/places/x/photos/y/media?key=SECRET' },
  ];
  for (const c of cases) {
    const { ok } = checkDurableRecordSafety(c);
    assert.equal(ok, false, 'これは弾かれるべき: ' + JSON.stringify(c));
    assert.throws(() => assertDurableRecordSafe(c));
  }
});

// ── §6 dedup / rate guard ───────────────────────────────────────
test('[36H §6] 同時に同じキーで呼ぶと1回にまとめられる（de-dup）', async () => {
  const guard = createRequestGuard({ maxRequestsPerWindow: 10, windowMs: 60000 });
  let calls = 0;
  const fn = () => { calls++; return new Promise((r) => setTimeout(() => r('ok'), 5)); };
  const [a, b] = await Promise.all([guard.schedule('k', fn), guard.schedule('k', fn)]);
  assert.equal(calls, 1, '同じキーなのに2回実行された');
  assert.equal(a, 'ok'); assert.equal(b, 'ok');
  assert.equal(guard.getStats().deduped, 1);
});

test('[36H §6] ウィンドウ内のレート上限を超えると拒否される', async () => {
  const guard = createRequestGuard({ maxRequestsPerWindow: 2, windowMs: 60000 });
  await guard.schedule('a', async () => 1);
  await guard.schedule('b', async () => 1);
  await assert.rejects(() => guard.schedule('c', async () => 1), RateLimitExceededError);
});

test('[36H §6] セッション全体の上限を超えると拒否される', async () => {
  const guard = createRequestGuard({ maxRequestsPerWindow: 100, maxRequestsPerSession: 1, windowMs: 60000 });
  await guard.schedule('a', async () => 1);
  await assert.rejects(() => guard.schedule('b', async () => 1), RateLimitExceededError);
});

// ── §9 保守的マッチング（曖昧なら unresolved のまま）────────────
test('[36H §9] 座標も名前も一致すれば VERIFIED', () => {
  const candidate = { name: '住吉区役所', expectLat: 34.6041, expectLon: 135.5008 };
  const places = [{ placeId: 'p1', displayName: '住吉区役所', lat: 34.60415, lon: 135.50085 }];
  const r = classifyPilotMatch(candidate, places);
  assert.equal(r.matchConfidence, 'VERIFIED');
  assert.equal(r.googlePlaceId, 'p1');
});

test('[36H §9] 候補が無ければ UNRESOLVED（借りてこない）', () => {
  const r = classifyPilotMatch({ name: 'x', expectLat: 34.6, expectLon: 135.5 }, []);
  assert.equal(r.matchConfidence, 'UNRESOLVED');
  assert.equal(r.googlePlaceId, null);
});

test('[36H §9] 座標は近いが名前が矛盾するなら曖昧のまま採らない', () => {
  const candidate = { name: '住吉区役所', expectLat: 34.6041, expectLon: 135.5008 };
  const places = [{ placeId: 'p1', displayName: '全く別の店', lat: 34.60415, lon: 135.50085 }];
  const r = classifyPilotMatch(candidate, places);
  assert.equal(r.matchConfidence, 'AMBIGUOUS');
  assert.equal(r.googlePlaceId, null);
});

test('[36H §9] 座標が近く名前も一致する候補が複数あれば一意に決めない', () => {
  const candidate = { name: 'ライフ', expectLat: 34.6022, expectLon: 135.5126 };
  const places = [
    { placeId: 'p1', displayName: 'ライフ', lat: 34.6023, lon: 135.5127 },
    { placeId: 'p2', displayName: 'ライフ', lat: 34.6021, lon: 135.5125 },
  ];
  const r = classifyPilotMatch(candidate, places);
  assert.equal(r.matchConfidence, 'AMBIGUOUS');
  assert.equal(r.googlePlaceId, null);
});

test('[36H §9] 遠すぎる候補は無視される（近いというだけで採らない）', () => {
  const candidate = { name: 'x', expectLat: 34.6, expectLon: 135.5 };
  const far = classifyPilotMatch(candidate, [{ placeId: 'p1', displayName: 'x', lat: 35.0, lon: 136.0 }]);
  assert.equal(far.matchConfidence, 'UNRESOLVED');
});

test('[36H §9] haversineMeters / namesAgree の基本動作', () => {
  assert.ok(haversineMeters(34.6, 135.5, 34.6, 135.5) < 1);
  assert.ok(haversineMeters(34.6, 135.5, 34.61, 135.5) > 900);
  assert.equal(namesAgree('あびこ病院', 'あびこ病院'), true);
  assert.equal(namesAgree('あびこ病院', '全く関係ない店'), false);
  assert.equal(namesAgree('', 'x'), false);
});

// ── places-client: 実際のAPIレスポンス形に近いフェイクで一連の流れを検証 ──
test('[36H] places-client はフィールドマスクを送り、写真枚数を上限で切る', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts && opts.headers });
    if (url.includes(':searchText')) {
      return { ok: true, json: async () => ({ places: [{ id: 'p1', displayName: { text: 'x' },
        location: { latitude: 1, longitude: 2 }, formattedAddress: 'addr', primaryType: 'school' }] }) };
    }
    if (url.includes('/places/p1')) {
      return { ok: true, json: async () => ({ id: 'p1', displayName: { text: 'x' },
        location: { latitude: 1, longitude: 2 }, googleMapsUri: 'https://maps.google.com/?cid=1',
        photos: Array.from({ length: 8 }, (_, i) => ({ name: 'places/p1/photos/' + i, widthPx: 800, heightPx: 600,
          authorAttributions: [{ displayName: 'Someone', uri: 'https://x' }] })) }) };
    }
    if (url.includes('/media')) {
      return { ok: true, json: async () => ({ photoUri: 'https://example.com/photo.jpg' }) };
    }
    throw new Error('unexpected url ' + url);
  };
  const client = createPlacesClient({ apiKey: 'FAKE_KEY', fetchImpl, maxPhotosPerPlace: 4 });
  const search = await client.searchText({ textQuery: 'x' });
  assert.equal(search.ok, true);
  assert.equal(search.places.length, 1);
  assert.equal(calls[0].headers['X-Goog-FieldMask'], SEARCH_FIELD_MASK.join(','));
  assert.equal(calls[0].headers['X-Goog-Api-Key'], 'FAKE_KEY');

  const details = await client.getPlaceDetails('p1');
  assert.equal(details.ok, true);
  assert.equal(details.place.photos.length, 4, '写真枚数の上限で切られていない');
  // 著者アイコン画像URLは保持しない設計（§5: 恒久データにしない）
  assert.equal(details.place.photos[0].authorAttributions[0].photoUri, null);
});

// ── §11 パイロット候補は実データのみ（捏造していない）───────────
test('[36H §9/§12] パイロット候補30件は実在する facilities.json のレコードそのもの', () => {
  const candidates = rj(CANDIDATES);
  assert.equal(candidates.candidates.length, 30);
  const ids = candidates.candidates.map((c) => c.facilityId);
  assert.equal(new Set(ids).size, 30, '重複 facilityId がある');
  for (const c of candidates.candidates) {
    assert.ok(RELEVANCE_CLASSES.includes(c.relevanceClass), c.relevanceClass + ' は既定クラスにない');
    // 大阪市住吉区周辺の緯度経度レンジに収まっているか（雑な捏造データでないことの確認）
    assert.ok(c.expectLat > 34.59 && c.expectLat < 34.62, c.name + ' の緯度が範囲外');
    assert.ok(c.expectLon > 135.49 && c.expectLon < 135.56, c.name + ' の経度が範囲外');
  }
  const facilities = rj(FACILITIES);
  const byId = new Map(facilities.records.map((r) => [r.id, r]));
  for (const c of candidates.candidates) {
    const real = byId.get(c.facilityId);
    assert.ok(real, c.facilityId + ' が facilities.json に存在しない（捏造の疑い）');
    assert.equal(real.name, c.name);
    assert.equal(real.latitude, c.expectLat);
    assert.equal(real.longitude, c.expectLon);
  }
});

test('[36H] classifyRelevance / isRelevantFacility は対象外カテゴリを弾く', () => {
  assert.equal(classifyRelevance({ subcategory: 'hospital' }), 'hospital');
  assert.equal(classifyRelevance({ subcategory: 'parking' }), null);
  assert.equal(isRelevantFacility({ subcategory: 'parking' }), false);
  assert.equal(classifyRelevance({ name: '住吉大社' }), 'temple-shrine');
});

// ── §12 runPilotMatch: VERIFIED のみ永続化、AMBIGUOUS/UNRESOLVEDは書かない ──
test('[36H §5/§9/§12] runPilotMatch はVERIFIEDだけをdurable mappingへ書く', async () => {
  const candidates = rj(CANDIDATES);
  const byName = new Map(candidates.candidates.map((c) => [c.name, c]));
  const shrine = byName.get('式内大社 中臣須牟地神社');
  const hospital = byName.get('あびこ病院');
  // 検索クエリに応じて出し分ける実装（fetchImplは (url, opts) を受け取る）
  const fetchImpl2 = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.textQuery === shrine.name) {
      return { ok: true, json: async () => ({ places: [{ id: 'shrine-place-id',
        displayName: { text: shrine.name }, location: { latitude: shrine.expectLat, longitude: shrine.expectLon } }] }) };
    }
    if (body.textQuery === hospital.name) {
      // 名前が一致しない・遠い候補しか無い → unresolved のまま
      return { ok: true, json: async () => ({ places: [{ id: 'wrong-place',
        displayName: { text: '無関係の店' }, location: { latitude: hospital.expectLat + 0.01, longitude: hospital.expectLon } }] }) };
    }
    return { ok: true, json: async () => ({ places: [] }) };
  };
  const r = await runPilotMatch({ apiKey: 'FAKE_KEY', fetchImpl: fetchImpl2, dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.counts.total, 30);
  assert.ok(r.counts.verified >= 1, 'shrineが検証済みにならなかった');
  const hospitalResult = r.unresolved.find((u) => u.facilityId === hospital.facilityId);
  assert.ok(hospitalResult, 'あびこ病院はunresolvedに残るはず');
  assert.notEqual(hospitalResult.matchConfidence, 'VERIFIED');
});

// ── §4/§8/§10 UI: source separation / attribution / regression ─────────
test('[36H §4] GooglePlacesPhoto は Wikimedia(#pc-photo-section / #bldg-photo-card)を触らない', () => {
  const g = gpLayer();
  assert.ok(!g.includes('pc-photo-section'), 'Google側がWikimedia用の建物カードに書き込んでいる');
  assert.ok(!g.includes('bldg-photo-card'), 'Google側がWikimedia用のhoverカードに書き込んでいる');
  assert.ok(g.includes('fc-google-photo-section'), '独自の表示先を持っていない');
});

test('[36H §5] GooglePlacesPhoto はどこにも永続化しない（localStorage/sessionStorage/indexedDBを使わない）', () => {
  const g = gpLayer();
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(g), '恒久ストレージAPIを使っている');
});

test('[36H §7] APIキーが無ければ節を非表示にするだけで例外を投げない', () => {
  const g = gpLayer();
  assert.match(g, /if \(!apiKey\(\)\) \{ stats\.hiddenNoKey\+\+; host\.style\.display = 'none'; updateDebugHud\(\); return; \}/);
});

test('[36H §8] 表示コードに Google 帰属バッジと著者・出典表示が含まれる', () => {
  const g = gpLayer();
  assert.ok(g.includes('gp-badge'), 'Googleバッジが無い');
  assert.ok(g.includes('authorUri') || g.includes('p.author'), '著者帰属を出していない');
  assert.ok(g.includes('googleMapsUri'), 'Googleマップへのリンクを出していない');
});

test('[36H] 施設カードを開いたら GooglePlacesPhoto.fillFacilityCard を呼ぶ（オンデマンド）', () => {
  const fn = devHtml.match(/function showExtendedFacilityCard\([\s\S]*?\n\}/)[0];
  assert.match(fn, /GooglePlacesPhoto\.fillFacilityCard\(record\)/);
});

test('[36H regression] 既存の Wikimedia BuildingPhoto ブロックは影響を受けていない', () => {
  const b = bpLayer();
  assert.ok(b.includes("URL_ = 'map-data/osaka-city/derived/building-photo-index.json'"));
  assert.ok(b.includes("matchConfidence !== 'high'"));
});

test('[36H] production / protected HTML には Google Places コードが一切ない', () => {
  const prod = fs.readFileSync(PROD, 'utf-8');
  const prot = fs.readFileSync(PROT, 'utf-8');
  assert.ok(!prod.includes('GooglePlacesPhoto'), 'production HTMLに漏れている');
  assert.ok(!prot.includes('GooglePlacesPhoto'), 'protected HTMLに漏れている');
  assert.ok(devHtml.includes('GooglePlacesPhoto'), 'dev HTMLに実装が無い');
});

test('[36H] local-config は雛形のみコミットされ、実ファイルは .gitignore されている', () => {
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8');
  assert.match(gitignore, /\/public\/local-config\.js/);
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'local-config.example.js')));
});
