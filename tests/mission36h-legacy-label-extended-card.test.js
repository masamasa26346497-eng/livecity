// tests/mission36h-legacy-label-extended-card.test.js
// [Mission 36H] 旧 LabelLayer のラベルをクリックしたとき、新データ側に対応が
// 「ちょうど1件」定まるなら showExtendedFacilityCard(record, null) へ回す。
// 定まらない(0件 / 複数件)ときは従来の showFacilityCard(facilityHit) のまま。
//
// 判定そのものは window.__LEGACY_LABEL_ROUTE__(item, records) で
// FacilityDataStore の状態から切り離して呼べるようにしてあるので、
// 合成レコードで 3 つの分岐を実際に走らせて確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInlineScript } from './_ward-ux-v1-smoke-harness.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'public/osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML, 'utf-8');

/** 旧ラベル(OSM_LABELS 形状: p:[x, z])。pickHit が返すのはこの形。 */
const legacyLabel = { name: '住吉大社', category: 'park', priority: 1, p: [120, -340] };
/** 新データ側レコード(FacilityDataStore 形状)。 */
const rec = (name, x, z, id) => ({ id, name, category: 'tourism', localX: x, localZ: z });

let boot = null;
function route(item, records) {
  if (!boot) {
    boot = runInlineScript(HTML, { fetchRoot: path.join(ROOT, 'public') });
    assert.ok(boot.ok, boot.error && boot.error.message);
  }
  return boot.window.__LEGACY_LABEL_ROUTE__(item, records);
}

test('[36H] 対応が一意なら拡張カード側へ回る', () => {
  const only = rec('住吉大社', 150, -360, 'f1');
  const r = route(legacyLabel, [only, rec('阿倍野防災センター', 900, 900, 'f2')]);
  assert.equal(r.route, 'extended');
  assert.equal(r.candidateCount, 1);
  assert.equal(r.record, only);
});

test('[36H] 対応が無ければ従来の旧カードへ落ちる', () => {
  // 名前は合うが 100m を超えて離れている + 近いが名前が違う → どちらも同値ではない
  const far = rec('住吉大社', 120 + 140, -340, 'f3');
  const near = rec('住吉公園', 125, -345, 'f4');
  assert.ok(Math.hypot(far.localX - 120, far.localZ + 340) > 100, '遠い方が 100m 超であること');
  const r = route(legacyLabel, [far, near]);
  assert.equal(r.route, 'legacy');
  assert.equal(r.candidateCount, 0);
  assert.equal(r.record, null);
});

test('[36H] 同値候補が複数なら選ばずに旧カードへ落ちる', () => {
  const a = rec('住吉大社', 130, -350, 'f5');
  const b = rec('住吉大社', 100, -320, 'f6');
  const r = route(legacyLabel, [a, b]);
  assert.equal(r.route, 'legacy', 'あいまいなときに片方を選んではいけない');
  assert.equal(r.candidateCount, 2);
  assert.equal(r.record, null);
});

test('[36H] 判定は既存の同値規則(正規化名の完全一致 + 100m)のまま', () => {
  // ちょうど 100m は同値、わずかに超えると非同値(既存の <= 100 と同じ境界)
  const at100 = rec('住吉大社', 120 + 100, -340, 'f7');
  assert.equal(route(legacyLabel, [at100]).route, 'extended');
  const over = rec('住吉大社', 120 + 100.5, -340, 'f8');
  assert.equal(route(legacyLabel, [over]).route, 'legacy');
  // 表記ゆれは normalizeTownName に委ねる。部分一致・あいまい一致は採らない。
  assert.equal(route(legacyLabel, [rec('住吉大社本殿', 130, -350, 'f9')]).route, 'legacy');
  // 名前が空の旧ラベルは何にも対応させない
  assert.equal(route({ name: '', p: [120, -340] }, [rec('', 120, -340, 'f10')]).route, 'legacy');
});

test('[36H] sprites 形状({x, z})でも同じ判定が効く', () => {
  const spriteItem = { name: '住吉大社', category: 'park', priority: 1, x: 120, z: -340 };
  const r = route(spriteItem, [rec('住吉大社', 150, -360, 'f11')]);
  assert.equal(r.route, 'extended');
});

test('[36H] クリック処理が LabelLayer の解決結果で分岐している', () => {
  const i = html.indexOf('const facilityHit = LabelLayer.pickHit(mx, my, camera);');
  assert.ok(i > 0, 'LabelLayer のクリック判定が見つからない');
  const block = html.slice(i, i + 900);
  const end = block.indexOf('\n  }');
  assert.ok(end > 0, 'クリック分岐の終端が見つからない');
  const body = block.slice(0, end);
  assert.match(body, /LabelLayer\.resolveEquivalentFacilityRecord/);
  assert.match(body, /showExtendedFacilityCard\(equivalentRecord, null\)/);
  assert.match(body, /showFacilityCard\(facilityHit\)/, '従来のフォールバックが残っていること');
});

test('[36H] 拡張カード経路から Google Places の写真差し込みが呼ばれる', () => {
  const i = html.indexOf('function showExtendedFacilityCard(record, distanceInfo) {');
  assert.ok(i > 0);
  const j = html.indexOf('\nfunction ', i + 10);
  assert.ok(j > i, '関数の終端が見つからない');
  assert.match(html.slice(i, j), /GooglePlacesPhoto\.fillFacilityCard\(/);
});

test('[36H] 二重表示防止(旧ラベルを隠す判定)の意味は変えていない', () => {
  const i = html.indexOf('function hasEquivalentInFacilityLayer(item) {');
  assert.ok(i > 0);
  const body = html.slice(i, i + 500);
  // 1 件でも該当すれば隠す、という従来の挙動のまま
  assert.match(body, /collectEquivalentFacilityRecords\(item, FacilityDataStore\.getAllRecords\(\)\)\.length > 0/);
  assert.match(body, /FacilityDataStore\.getState\(\) !== 'ready'\) return false/);
});

test('[36H] production / protected HTML には手を入れていない', () => {
  for (const f of ['public/osaka_3d_buildings.html', 'public/osaka_3d_buildings.fullward-v3.html']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf-8');
    assert.ok(!src.includes('resolveEquivalentFacilityRecord'), f + ' が変更されている');
  }
});
