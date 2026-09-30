// tests/mission36h-city-label-facility-bridge.test.js
// [Mission 36H] 地図に見えている CityLabel（建物名・ランドマーク名）をクリックしたとき、
// 新施設データ（FacilityDataStore）に対応が「ちょうど1件」定まるなら
// showExtendedFacilityCard(record, null) を開く。0件・複数件なら従来どおり。
//
// 判定は window.__FACILITY_LABEL_DECIDE__(label, records) で
// FacilityDataStore の状態から切り離して呼べるので、実データと合成データの両方で走らせる。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInlineScript } from './_ward-ux-v1-smoke-harness.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'public/osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML, 'utf-8');
const FACILITIES = path.join(ROOT, 'public/map-data/osaka-sumiyoshi/facilities/facilities.json');
const BUILDING_LABELS = path.join(ROOT, 'public/map-data/osaka-city/derived/building-name-labels.json');

const bldgLabel = (name, x, z) => ({ id: 'bldg:' + name, kind: 'building', name, x, z });
/** facilities.json と同じ現行 runtime 形式（znorth-neg-v1 / 北=-Z）。 */
function facility(id, name, lat, lon) {
  const CLAT = 34.604208, CLON = 135.525020, MPD = 111320;
  return {
    id, name, category: 'shopping', latitude: lat, longitude: lon,
    localX: (lon - CLON) * Math.cos((CLAT * Math.PI) / 180) * MPD,
    localZ: -(lat - CLAT) * MPD,
  };
}

let boot = null;
function win() {
  if (!boot) {
    boot = runInlineScript(HTML, { fetchRoot: path.join(ROOT, 'public') });
    assert.ok(boot.ok, boot.error && boot.error.message);
  }
  return boot.window;
}
const decide = (label, records) => win().__FACILITY_LABEL_DECIDE__(label, records);

// ── 実データでの検証（ミッションの指定確認対象） ───────────────────────────
test('[36H] 実データ: スーパー玉出 アビコ店 が osm-node-750515219 に解決する', () => {
  const records = JSON.parse(fs.readFileSync(FACILITIES, 'utf-8')).records;
  const labels = JSON.parse(fs.readFileSync(BUILDING_LABELS, 'utf-8')).labels;
  const hit = labels.filter((l) => l.name === 'スーパー玉出 アビコ店');
  assert.equal(hit.length, 1, '建物名ラベルが 1 件だけ存在すること');
  const d = decide(bldgLabel(hit[0].name, hit[0].x, hit[0].z), records);
  assert.equal(d.route, 'extended', d.reason + ' / candidates=' + JSON.stringify(d.candidates));
  assert.equal(d.reason, 'unique-match');
  assert.equal(d.candidateCount, 1);
  assert.equal(d.record.id, 'osm-node-750515219');
  assert.ok(d.candidates[0].distanceM < 50, '距離 ' + d.candidates[0].distanceM + 'm');
});

test('[36H] 実データ: 同名の別店舗（鶴見橋店・支店名なし）を巻き込まない', () => {
  const records = JSON.parse(fs.readFileSync(FACILITIES, 'utf-8')).records;
  const labels = JSON.parse(fs.readFileSync(BUILDING_LABELS, 'utf-8')).labels;
  // 支店名のない「スーパー玉出」ラベルは、住吉の施設データに同名レコードが無いので解決しない
  const plain = labels.filter((l) => l.name === 'スーパー玉出');
  assert.ok(plain.length > 1, '同名ラベルが複数あること（' + plain.length + '件）');
  for (const l of plain.slice(0, 5)) {
    assert.equal(decide(bldgLabel(l.name, l.x, l.z), records).route, 'unchanged');
  }
});

test('[36H2] 実データ: 施設座標は znorth-neg-v1 で緯度経度から再投影済み', () => {
  const dataset = JSON.parse(fs.readFileSync(FACILITIES, 'utf-8'));
  const records = dataset.records;
  const CLAT = 34.604208, MPD = 111320;
  assert.equal(dataset.coordinateConvention, 'znorth-neg-v1');
  for (const r of records) {
    const expectedZ = Math.round((-(r.latitude - CLAT) * MPD) * 100) / 100;
    assert.ok(Math.abs(expectedZ - r.localZ) < 0.001,
      `${r.id}: localZ=${r.localZ}, expected=${expectedZ}`);
  }
  const t = records.find((r) => r.id === 'osm-node-750515219');
  assert.equal(t.localX, -1591.3);
  assert.equal(t.localZ, 373.31);
  const labels = JSON.parse(fs.readFileSync(BUILDING_LABELS, 'utf-8')).labels;
  const l = labels.find((x) => x.name === 'スーパー玉出 アビコ店');
  assert.ok(Math.hypot(t.localX - l.x, t.localZ - l.z) < 50,
    'FacilityLayer の実座標と建物ラベルが同じ場所に揃うこと');
});

// ── 分岐の確認（合成データ） ─────────────────────────────────────────
test('[36H] 一意に対応するとき拡張カードへ回る', () => {
  const only = facility('f-only', 'テスト商店', 34.6008545, 135.5076528);
  const label = bldgLabel('テスト商店', -1591.0, 383.0);
  const d = decide(label, [only, facility('f-far', 'べつの店', 34.62, 135.52)]);
  assert.equal(d.route, 'extended');
  assert.equal(d.record.id, 'f-only');
});

test('[36H] 対応が無いときは既存の挙動のまま', () => {
  const label = bldgLabel('テスト商店', -1591.0, 383.0);
  // 名前は合うが遠い（約 1.1km 北）／近いが名前が違う
  const far = facility('f-far', 'テスト商店', 34.6108545, 135.5076528);
  const near = facility('f-near', 'テスト商店2号', 34.6008545, 135.5076528);
  const d = decide(label, [far, near]);
  assert.equal(d.route, 'unchanged');
  assert.equal(d.reason, 'no-match');
  assert.equal(d.record, null);
});

test('[36H] 対応が複数あるときは選ばず既存の挙動のまま', () => {
  const label = bldgLabel('テスト商店', -1591.0, 383.0);
  const a = facility('f-a', 'テスト商店', 34.6008545, 135.5076528);
  const b = facility('f-b', 'テスト商店', 34.6011000, 135.5078000);
  const d = decide(label, [a, b]);
  assert.equal(d.route, 'unchanged', 'あいまいなときに片方を選んではいけない');
  assert.equal(d.reason, 'ambiguous');
  assert.equal(d.candidateCount, 2);
  assert.equal(d.record, null);
});

test('[36H] station / place / ward / park / river は橋渡しの対象外', () => {
  const rec = facility('f-only', 'テスト商店', 34.6008545, 135.5076528);
  for (const kind of ['station', 'place', 'ward', 'park', 'river']) {
    const d = decide({ id: kind + ':1', kind, name: 'テスト商店', x: -1591.0, z: 383.0 }, [rec]);
    assert.equal(d.route, 'unchanged', kind + ' が橋渡しされている');
    assert.equal(d.reason, 'kind-not-bridged');
  }
  // ランドマーク名は建物名と同じく対象
  assert.equal(decide({ id: 'lm:1', kind: 'landmark', name: 'テスト商店', x: -1591.0, z: 383.0 }, [rec]).route, 'extended');
});

test('[36H] あいまい一致はしない（部分一致・前方一致で拾わない）', () => {
  const label = bldgLabel('スーパー玉出', -1591.0, 383.0);
  const rec = facility('f-branch', 'スーパー玉出 アビコ店', 34.6008545, 135.5076528);
  assert.equal(decide(label, [rec]).route, 'unchanged', '支店名つきを支店名なしラベルに当ててはいけない');
  assert.equal(decide(bldgLabel('スーパー玉出 アビコ', -1591.0, 383.0), [rec]).route, 'unchanged');
});

test('[36H] 名前・座標が欠けているラベルは解決しない', () => {
  const rec = facility('f-only', 'テスト商店', 34.6008545, 135.5076528);
  assert.equal(decide(bldgLabel('', -1591.0, 383.0), [rec]).reason, 'no-name');
  assert.equal(decide({ id: 'b', kind: 'building', name: 'テスト商店' }, [rec]).reason, 'no-position');
  assert.equal(decide(null, [rec]).reason, 'no-label');
});

test('[36H] 100m のしきい値は既存の同値判定と同じ', () => {
  assert.match(html, /const FACILITY_LABEL_MATCH_RADIUS_M = 100;/);
  const CLAT = 34.604208, MPD = 111320;
  // ラベルの真南 99m / 101m に置いて境界を確かめる（znorth-neg-v1 では南が +Z）
  const label = bldgLabel('テスト商店', 0, 0);
  const at = (m) => facility('f', 'テスト商店', CLAT - m / MPD, 135.525020);
  assert.equal(decide(label, [at(99)]).route, 'extended');
  assert.equal(decide(label, [at(101)]).route, 'unchanged');
});

// ── 配線・非回帰 ────────────────────────────────────────────────
test('[36H] クリック処理が station/place/ward の後で橋渡しを試す', () => {
  const i = html.indexOf("if (labelHit.kind === 'station') { selectStationLabel(labelHit); return; }");
  assert.ok(i > 0, 'station の分岐が見つからない');
  const j = html.indexOf('} catch (err)', i);
  assert.ok(j > i, 'ラベル判定ブロックの終端が見つからない');
  const body = html.slice(i, j);
  const posStation = body.indexOf('selectStationLabel');
  const posWard = body.indexOf('AreaSelectionLayer.selectFromLabel');
  const posBridge = body.indexOf('resolveFacilityRecordForCityLabel');
  assert.ok(posBridge > posWard && posWard > posStation, '橋渡しは station/place/ward の後であること');
  assert.match(body, /showExtendedFacilityCard\(labelFacilityRecord, null\)/);
});

test('[36H] 36H の旧 LabelLayer 側の防御的ルーティングは残っている', () => {
  assert.match(html, /LabelLayer\.resolveEquivalentFacilityRecord/);
  assert.match(html, /showExtendedFacilityCard\(equivalentRecord, null\)/);
  assert.match(html, /showFacilityCard\(facilityHit\)/);
});

test('[36H] 見えていない FacilityLayer スプライトはクリックできるようにしていない', () => {
  const i = html.indexOf('const FacilityLayer = (function');
  assert.ok(i > 0);
  const j = html.indexOf('\nconst LabelLayer = (function', i);
  assert.ok(j > i);
  const body = html.slice(i, j);
  // pickHit は visible なスプライトだけを raycast 対象にしている（従来どおり）
  assert.match(body, /sprites\s*\n?\s*\.?filter\(\s*\(?item\)?\s*=>\s*item\.sprite\.visible\s*\)/);
});

test('[36H] Google Places の 120m マッチング規則・Wikimedia 側は変えていない', () => {
  assert.match(html, /GooglePlacesPhoto\.fillFacilityCard\(/);
  const g = path.join(ROOT, 'tools/google-places/lib');
  if (fs.existsSync(g)) {
    const src = fs.readdirSync(g).filter((f) => f.endsWith('.mjs'))
      .map((f) => fs.readFileSync(path.join(g, f), 'utf-8')).join('\n');
    assert.match(src, /120/, 'Google Places 側の 120m しきい値が見つからない');
  }
});

test('[36H] 診断ヘルパーが dev HTML にある', () => {
  assert.match(html, /window\.__FACILITY_LABEL_DIAG__/);
  assert.match(html, /window\.__FACILITY_LABEL_DECIDE__/);
  assert.equal(typeof win().__FACILITY_LABEL_DIAG__, 'function');
});

// ラベルデータ・施設データの読み込みを待って、実際に走らせた結果を見る。
test('[36H] 診断: 読み込み済みのデータで スーパー玉出 アビコ店 → osm-node-750515219', async () => {
  const w = win();
  const diag = () => w.__FACILITY_LABEL_DIAG__('スーパー玉出 アビコ店');
  for (let i = 0; i < 200; i++) {
    const d = diag();
    if (d.facilityStoreState === 'ready' && d.labelsFound > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const d = diag();
  assert.equal(d.facilityStoreState, 'ready', '施設データが読み込めていない');
  assert.equal(d.recordCount, 149);
  assert.equal(d.labelsFound, 1, 'ラベルが ' + d.labelsFound + ' 件');
  assert.equal(d.results[0].kind, 'building');
  assert.equal(d.results[0].route, 'extended');
  assert.equal(d.results[0].resolvedId, 'osm-node-750515219');
  assert.ok(d.results[0].candidates[0].distanceM < 50, '距離 ' + d.results[0].candidates[0].distanceM + 'm');
});

test('[36H] production / protected HTML には橋渡しを入れていない', () => {
  for (const f of ['public/osaka_3d_buildings.html', 'public/osaka_3d_buildings.fullward-v3.html']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf-8');
    assert.ok(!src.includes('resolveFacilityRecordForCityLabel'), f + ' が変更されている');
  }
});
