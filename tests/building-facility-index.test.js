// tests/building-facility-index.test.js
// [Mission 35O §23] 建物への名称付与。
//   いちばん大事なのは §0「名前を推測しない」。テストもそこを中心に置く。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  osmName, osmCategory, isBuildingTags, WHOLE_BUILDING_CATEGORIES,
  ringArea, ringBbox, ringCentroid, pointInRing, bboxOverlap, overlapRatio,
  MATCH, normalizeName, isSameAsLandmark, labelTier, categoryRank,
} from '../tools/lib/building-facility-match.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

const sq = (x, z, s) => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];

// ── 名称の読み取り（推測しない）─────────────────────────────────────
test('[35O §0] 名称は name:ja / name からしか取らない', () => {
  assert.equal(osmName({ 'name:ja': 'あべのハルカス', name: 'Abeno Harukas' }), 'あべのハルカス');
  assert.equal(osmName({ name: 'ダイビル本館' }), 'ダイビル本館');
  // 住所・ブランド・運営者から名前を作らない
  assert.equal(osmName({ 'addr:housenumber': '1-1', operator: 'セブン-イレブン' }), null);
  assert.equal(osmName({ building: 'yes' }), null);
  assert.equal(osmName(null), null);
  assert.equal(osmName({ name: '   ' }), null);
});

test('[35O §0] 種別はタグから決め、名前から推測しない', () => {
  assert.equal(osmCategory({ amenity: 'hospital' }), 'hospital');
  assert.equal(osmCategory({ shop: 'supermarket' }), 'supermarket');
  assert.equal(osmCategory({ shop: 'yes' }), 'shop');
  assert.equal(osmCategory({ tourism: 'hotel' }), 'hotel');
  assert.equal(osmCategory({ office: 'yes' }), 'office');
  // 名前に「病院」と入っていても、タグが無ければ種別は決めない
  assert.equal(osmCategory({ name: '○○総合病院' }), null);
  assert.equal(osmCategory({}), null);
});

// ── ポリゴンの重なり ────────────────────────────────────────────────
test('[35O §4-A/B] 重なりの割合を測る', () => {
  const a = sq(0, 0, 10);
  assert.ok(overlapRatio(a, sq(0, 0, 10)).ratioOfA > 0.95, '同じ形なら ほぼ 1');
  assert.equal(overlapRatio(a, sq(100, 100, 10)).ratioOfA, 0, '離れていれば 0');
  // 建物が施設の一部に収まっている（= 施設が建物を覆う）
  const big = sq(-5, -5, 30);
  assert.ok(overlapRatio(a, big).ratioOfA > 0.95, '大きい施設が建物を覆えば 1 に近い');
  // 半分だけ重なる
  const half = overlapRatio(a, sq(5, 0, 10)).ratioOfA;
  assert.ok(half > 0.3 && half < 0.7, '半分重なりは 0.5 付近: ' + half);
});

test('[35O §4] しきい値は「ほぼ同じ形」を要求する', () => {
  assert.ok(MATCH.BUILDING_SELF_OVERLAP >= 0.5, '建物自身の一致が緩すぎる');
  assert.ok(MATCH.FACILITY_COVERS_BUILDING >= 0.5, '施設の覆いが緩すぎる');
  // 半分しか重ならない相手は採らない
  assert.ok(overlapRatio(sq(0, 0, 10), sq(6, 0, 10)).ratioOfA < MATCH.BUILDING_SELF_OVERLAP);
});

test('[35O §4-C] POI が建物の中にあるか', () => {
  const b = sq(0, 0, 10);
  assert.equal(pointInRing(5, 5, b), true);
  assert.equal(pointInRing(15, 5, b), false);
  assert.equal(pointInRing(-1, 5, b), false);
});

test('[35O §4-C] 建物全体とみなせる種別だけを主要施設名にできる', () => {
  for (const c of ['school', 'hospital', 'police', 'fire_station', 'museum', 'hotel', 'supermarket']) {
    assert.ok(WHOLE_BUILDING_CATEGORIES.has(c), c + ' が入っていない');
  }
  // 小さなテナントは建物名にしない
  for (const c of ['cafe', 'restaurant', 'convenience', 'bank', 'pharmacy', 'fast_food', 'shop']) {
    assert.ok(!WHOLE_BUILDING_CATEGORIES.has(c), c + ' を建物全体扱いしている');
  }
});

// ── landmark 重複 ─────────────────────────────────────────────────
test('[35O §10] 既存 landmark と同じものを見分ける', () => {
  const lms = [{ name: 'あべのハルカス', x: 0, z: 0 }, { name: '大阪中之島美術館', x: 500, z: 500 }];
  assert.ok(isSameAsLandmark('あべのハルカス', 10, 10, lms), '同名・近距離が同一にならない');
  // 名前が完全に一致するときは距離を見ない。landmark の名前は固有名詞で、アンカーは
  //   施設の重心に置かれるため、天王寺公園のように同名の建物が 300m 以上離れることがある。
  assert.ok(isSameAsLandmark('あべのハルカス', 5000, 5000, lms), '完全一致を距離で切ってしまっている');
  assert.equal(isSameAsLandmark('別のビル', 10, 10, lms), null, '名前が違うのに同一にしている');
  // 部分一致は根拠が弱いので、近いときだけ同一とみなす
  assert.ok(isSameAsLandmark('あべのハルカス展望台', 10, 10, lms), '近い部分一致が拾えない');
  assert.equal(isSameAsLandmark('あべのハルカス展望台', 9000, 9000, lms), null, '遠い部分一致まで同一にしている');
  // 表記ゆれ（空白・記号）を吸収する
  assert.ok(isSameAsLandmark('あべの ハルカス', 10, 10, lms), '空白で一致しなくなる');
});

test('[35O §10] 名称の正規化', () => {
  assert.equal(normalizeName('グランフロント 大阪（北館）'), normalizeName('グランフロント大阪北館'));
  assert.equal(normalizeName('ＮＴＴ'), normalizeName('NTT'));
  assert.equal(normalizeName(null), '');
});

// ── zoom 帯 ───────────────────────────────────────────────────────
test('[35O §9] ズーム帯は高さ・広さ・種別で決める', () => {
  assert.equal(labelTier({ height: 170, category: 'office', footprintAreaM2: 5000 }), 'mid', '超高層が mid でない');
  assert.equal(labelTier({ height: 12, category: 'department_store', footprintAreaM2: 800 }), 'mid', '大型商業が mid でない');
  assert.equal(labelTier({ height: 40, category: 'office', footprintAreaM2: 900 }), 'near');
  assert.equal(labelTier({ height: 8, category: 'cafe', footprintAreaM2: 90 }), 'veryNear', '小さな店舗が veryNear でない');
  assert.equal(labelTier({ height: 8, category: 'cafe', footprintAreaM2: 90, isPrimaryFacility: true }), 'near');
  // 優先カテゴリのほうが先に出る
  assert.ok(categoryRank('museum') < categoryRank('cafe'));
  assert.ok(categoryRank('hospital') < categoryRank('convenience'));
});

// ── HTML 側 ───────────────────────────────────────────────────────
test('[35O §7/§8] 建物名ラベルが既存 LabelLayer に乗っている', () => {
  assert.match(html, /const BUILDING_NAME_URL = 'map-data\/osaka-city\/derived\/building-name-labels\.json';/);
  // 既存のラベル種別を消していない
  for (const k of ['PLACE_URL', 'LANDMARK_URL', 'STATION_URL', 'RIVER_URL', 'ANCHOR_URL']) {
    assert.match(html, new RegExp('const ' + k + ' ='), k + ' が消えている');
  }
  // 同じ優先度キューへ入れている（別レイヤーを作っていない）
  assert.match(html, /typeVisible\.building \? buildingNames : \[\]/);
  // §8 屋根の少し上
  assert.match(html, /item\.kind === 'building'[\s\S]{0,160}BUILDING_LABEL_Y_MARGIN/);
  assert.match(html, /const BUILDING_LABEL_Y_MAX = \d+;/);
});

test('[35O §9] 建物名の zoom 帯が実装されている', () => {
  assert.match(html, /if \(item\.kind === 'building'\) \{[\s\S]{0,260}BUILDING_VERY_NEAR_M/);
  // 遠景では建物名を出さない
  const m = html.match(/if \(item\.kind === 'building'\) \{([\s\S]{0,300}?)\n    \}/);
  assert.ok(m, '建物の lodVisible が読めない');
  assert.ok(!/return true;/.test(m[1]), '建物名が全 band で出てしまう');
});

test('[35O §19] 建物クリックで名称と施設を出す', () => {
  assert.match(html, /const BuildingNameStore = \(function \(\) \{/);
  assert.match(html, /id="pc-bldgname-row"/);
  assert.match(html, /id="pc-facility-row"/);
  assert.match(html, /function applyBuildingNameRows\(canonicalId\)/);
  // §20 起動時には読まない（クリックで遅延 fetch）
  assert.match(html, /BuildingNameStore\.ensure\(\);/);
  assert.ok(!/await fetch\(.*building-facility-index/.test(html), '索引を起動時に読んでいる');
  // 施設が多いときは件数で示す
  assert.match(html, /施設 ' \+ n \+ ' 件/);
});

test('[35O §11/§21] 建物 geometry を触っていない', () => {
  assert.match(html, /positions\.push\(a\[0\], 0, a\[1\], b\[0\], 0, b\[1\], b\[0\], h, b\[1\]\);/);
  assert.match(html, /positions\.push\(v\.x, h, v\.y\);/);
  const man = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-final', 'manifest.json'));
  if (man) assert.equal(man.featureCount, 618749, '建物数が変わっている');
});

// ── 実データ ──────────────────────────────────────────────────────
test('[35O] 実データ: provenance が 100%', { skip: skip('building-facility-index-validation.json') }, () => {
  const v = rpt('building-facility-index-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  const p = v.provenance;
  assert.equal(p.noSource, 0);
  assert.equal(p.noSourceId, 0);
  assert.equal(p.noMethod, 0);
  assert.equal(p.noConfidence, 0);
  assert.equal(p.badMethod, 0);
  assert.equal(p.badConfidence, 0);
  assert.equal(v.facilities.noSource, 0);
  assert.equal(v.facilities.noSourceId, 0);
  assert.equal(v.integrity.missingBuildingId, 0, '存在しない building ID がある');
  assert.equal(v.integrity.nanCoord, 0);
  assert.equal(v.geometryUntouched, true);
});

test('[35O §10] 実データ: landmark と二重表示していない', { skip: skip('building-facility-index-validation.json') }, () => {
  const v = rpt('building-facility-index-validation.json');
  assert.equal(v.landmarkLabelLeak, 0, 'landmark と同名のラベルが残っている');
});

test('[35O §5] 実データ: nearest だけで付けていない', { skip: skip('building-facility-index.json') }, () => {
  const r = rpt('building-facility-index.json');
  // nearest を使ったものは medium 以下で、かつ今回は 0 件
  assert.equal(r.counts.nearestWithEvidence, 0);
  // high はポリゴンの重なりだけ
  const v = rpt('building-facility-index-validation.json');
  if (v) {
    const m = v.provenance.byMethod;
    assert.ok(!m['nearest-with-evidence'], 'nearest を使っている');
    assert.ok(m['building-polygon-self'] > 0 && m['facility-polygon-overlap'] > 0);
  }
});

test('[35O §16] 実データ: 24 区の coverage が出ている', { skip: skip('building-facility-index.json') }, () => {
  const r = rpt('building-facility-index.json');
  const wards = Object.keys(r.byWard).filter((k) => k !== '(none)');
  assert.ok(wards.length >= 24, '区が ' + wards.length + ' しかない');
  for (const w of wards) {
    assert.ok(Number.isFinite(r.byWard[w].coveragePct), w + ' の coverage が数値でない');
  }
  assert.equal(r.counts.buildingsTotal, 618749);
});

test('[35O §17] 実データ: 誤付与監査', { skip: skip('building-name-misassignment-audit.json') }, () => {
  const a = rpt('building-name-misassignment-audit.json');
  assert.ok(a.sampled >= 50, '監査件数が ' + a.sampled + ' 件しかない');
  assert.equal(a.wrong, 0, JSON.stringify(a.samples.filter((s) => s.verdict === 'wrong').slice(0, 5)));
  // 重点箇所を全部見ている
  for (const f of ['tower', 'large-commercial', 'campus', 'hospital', 'worship', 'multi-tenant', 'station-building', 'dense']) {
    assert.ok(a.byFocus[f] && a.byFocus[f].n > 0, f + ' を見ていない');
  }
});

test('[35O §14/§15] 実データ: 代表 9 地点の実ブラウザ確認', { skip: skip('building-name-qa.json') }, () => {
  const q = rpt('building-name-qa.json');
  const s = q.summary;
  assert.equal(s.sitesTotal, 9);
  assert.equal(s.sitesWithBuildingLabels, 9, '建物名が出ていない地点がある');
  assert.equal(s.zoomIncreasesOk, true, 'ズームインで名称が増えていない');
  assert.equal(s.farNotCrowded, true, 'ズームアウトでラベルだらけになっている');
  assert.equal(s.clickOk, 9, '建物クリックが効かない地点がある');
  assert.equal(s.cardNameShownOk, 9, 'card に建物名が出ない地点がある');
  assert.equal(s.jsErrors, 0);
});
