// tests/station-town-navigation.test.js
// [Mission 35K] 駅表示と町名ナビゲーション
//   - 事業者の分類は operator / network / 路線名の文字列から（駅名の一覧を持たない）
//   - 同一駅の統合（名前が違えば別駅）
//   - 町名ラベル → 範囲 の対応（町丁目が無い区は区界へ落とす。推測しない）
//   - bbox から距離を決める
//   - クリックの優先順位・ドラッグ保護
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPERATORS, UNKNOWN_OPERATOR, classifyOperator, resolveOperator, learnLineOperators,
  dedupeStations, markTransfers, stationImportance, DEDUPE_M, TRANSFER_M, JOIN_M, LINE_RADIUS_M,
} from '../tools/build-station-index.js';
import {
  baseTownName, splitTownKey, bboxOfRings, bboxInfo, readTownPolygons,
} from '../tools/build-area-boundaries.js';
import {
  BUILDING_COUNT, DEV_ONLY_IDS, TOWN_BOUNDARY_WARDS, FPS_DROP_BUDGET_PCT,
} from '../tools/validate/station-town-navigation.js';
import { STATION_SITES, TOWN_SITES, worldOf } from '../tools/audit/station-town-navigation-qa.js';
import { devUiIsGated } from '../tools/lib/production-invariants.js';
import { classifyPointToWard } from '../tools/lib/point-in-polygon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');
const M = (...s) => path.join(ROOT, 'public', 'map-data', 'osaka-city', ...s);

// ── §6 事業者の分類 ─────────────────────────────────────────────────────
test('35K 事業者は operator / network / 路線名の文字列から決める', () => {
  assert.equal(classifyOperator('大阪市高速電気軌道').id, 'metro');
  assert.equal(classifyOperator('Osaka Metro御堂筋線').id, 'metro');
  assert.equal(classifyOperator('大阪市営地下鉄谷町線').id, 'metro');
  assert.equal(classifyOperator('西日本旅客鉄道').id, 'jr');
  assert.equal(classifyOperator('JR阪和線').id, 'jr');
  assert.equal(classifyOperator('阪急電鉄').id, 'hankyu');
  assert.equal(classifyOperator('阪神電気鉄道').id, 'hanshin');
  assert.equal(classifyOperator('近畿日本鉄道').id, 'kintetsu');
  assert.equal(classifyOperator('南海電気鉄道').id, 'nankai');
  assert.equal(classifyOperator('京阪電気鉄道').id, 'keihan');
  // §2 が挙げた 7 社すべてに id がある
  const ids = OPERATORS.map((o) => o.id);
  for (const need of ['metro', 'jr', 'hankyu', 'hanshin', 'kintetsu', 'nankai', 'keihan']) {
    assert.ok(ids.includes(need), need + ' が無い');
  }
  // 分からなければ unknown（推測しない）
  assert.equal(classifyOperator('まったく知らない鉄道'), null);
  assert.equal(classifyOperator(null), null);
});

test('35K 事業者は駅名では決めない', () => {
  // 駅名を渡しても当たらない＝分類が駅名に依存していない
  for (const n of ['梅田', '大阪', 'なんば', '天王寺', '京橋', '新大阪']) {
    assert.equal(classifyOperator(n), null, n + ' が駅名で分類されている');
  }
  // 索引を作るコードに駅名が直書きされていない
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'build-station-index.js'), 'utf-8');
  for (const n of ['梅田', 'なんば', '天王寺', '新大阪', '淀屋橋']) {
    assert.ok(!src.includes("'" + n + "'"), n + ' を直書きしている');
  }
});

test('35K タグ → 周辺路線 の順で決める', () => {
  const byTag = resolveOperator({ tags: { operator: '阪急電鉄' }, nearbyLineNames: ['JR東海道本線'] });
  assert.equal(byTag.id, 'hankyu', 'タグより路線名が優先されている');
  assert.equal(byTag.source, 'operator');
  const byLine = resolveOperator({ tags: {}, nearbyLineNames: ['Osaka Metro御堂筋線'] });
  assert.equal(byLine.id, 'metro');
  assert.equal(byLine.source, 'nearby-line');
  const none = resolveOperator({ tags: {}, nearbyLineNames: [] });
  assert.equal(none.id, UNKNOWN_OPERATOR.id);
  assert.equal(none.source, null);
});

test('35K 貨物線は旅客駅の事業者にしない', () => {
  // 同じ場所に旅客線と貨物線が並ぶ。旅客線があるならそちらを採る。
  const r = resolveOperator({ tags: {}, nearbyLineNames: ['北方貨物線', 'JR東海道本線'] });
  assert.equal(r.id, 'jr', '貨物線を採ってしまっている');
  // 貨物線しか無ければ貨物として扱う
  const f = resolveOperator({ tags: {}, nearbyLineNames: ['JR城東貨物線'] });
  assert.equal(f.id, 'jr-freight');
});

test('35K 路線名の対応をデータから学習する', () => {
  // 「JR大阪環状線」から「大阪環状線」を学ぶ。線名の一覧はコードに持たない。
  const learned = learnLineOperators(['JR大阪環状線', 'Osaka Metro御堂筋線', '南海電気鉄道南海本線']);
  assert.equal(learned.get('大阪環状線').id, 'jr');
  assert.equal(learned.get('御堂筋線').id, 'metro');
  // 学習した対応が実際に効く
  const r = resolveOperator({ tags: {}, nearbyLineNames: ['大阪環状線'], learned });
  assert.equal(r.id, 'jr');
  // 学習していない名前は当たらない
  assert.equal(resolveOperator({ tags: {}, nearbyLineNames: ['知らない線'], learned }).id, UNKNOWN_OPERATOR.id);
});

// ── §4 同一駅の統合 ─────────────────────────────────────────────────────
test('35K 名前が違えば別駅（大阪 / 梅田 / 東梅田 / 西梅田）', () => {
  const mk = (name, op, x, z) => ({ stationId: name + x, name, x, z, operator: { id: op } });
  const list = [mk('大阪', 'jr', 0, 0), mk('梅田', 'metro', 60, 40),
    mk('東梅田', 'metro', 180, 30), mk('西梅田', 'metro', -150, 60)];
  const { stations, merged } = dedupeStations(list);
  assert.equal(stations.length, 4, '別名の駅が畳まれている');
  assert.equal(merged.length, 0);
});

test('35K 同じ名前・同じ事業者・近いものだけ畳む', () => {
  const mk = (name, op, x, z) => ({ stationId: name + x + z, name, x, z, operator: { id: op } });
  const list = [mk('なんば', 'metro', 0, 0), mk('なんば', 'metro', 300, 80), mk('なんば', 'nankai', 20, 20)];
  const { stations, merged } = dedupeStations(list);
  assert.equal(stations.length, 2, '事業者が違うのに畳んでいる');
  assert.equal(merged.length, 1);
  assert.equal(stations[0].mergedIds.length, 1);
  // 遠ければ畳まない
  const far = dedupeStations([mk('X', 'metro', 0, 0), mk('X', 'metro', 2000, 0)]);
  assert.equal(far.stations.length, 2);
  // 地下鉄の大きな駅（ホームが数百 m 離れる）を畳める距離であること
  assert.ok(DEDUPE_M >= 300 && DEDUPE_M <= 600, 'DEDUPE_M = ' + DEDUPE_M);
});

test('35K 乗換は「近くに別事業者があるか」で決める', () => {
  const mk = (name, op, x, z) => ({ name, x, z, operator: { id: op } });
  const list = [mk('A', 'jr', 0, 0), mk('B', 'metro', 100, 0), mk('C', 'hankyu', 150, 0), mk('D', 'nankai', 5000, 0)];
  markTransfers(list);
  assert.equal(list[0].isTransfer, true);
  assert.deepEqual([...list[0].transferWith].sort(), ['hankyu', 'metro']);
  assert.equal(list[3].isTransfer, false, '遠い駅を乗換にしている');
  // §7 重要度は乗換の数で決まる（駅名の一覧は使わない）
  assert.equal(stationImportance({ transferWith: ['a', 'b', 'c'] }), 'major');
  assert.equal(stationImportance({ transferWith: ['a'] }), 'transfer');
  assert.equal(stationImportance({ transferWith: [] }), 'local');
  assert.ok(TRANSFER_M > DEDUPE_M / 2);
});

// ── §11/§12 町名と町丁目 ────────────────────────────────────────────────
test('35K 町丁目名から基準地名を作る', () => {
  assert.equal(baseTownName('梅田一丁目'), '梅田');
  assert.equal(baseTownName('我孫子4丁目'), '我孫子');
  assert.equal(baseTownName('中之島'), '中之島');
  const sp = splitTownKey('住吉区我孫子4丁目');
  assert.deepEqual(sp, { ward: '住吉区', town: '我孫子4丁目', base: '我孫子' });
  assert.equal(splitTownKey('区の無い名前'), null);
});

test('35K bbox と距離の計算', () => {
  const rings = [[[0, 0], [100, 0], [100, 50], [0, 50]]];
  const b = bboxOfRings(rings);
  assert.deepEqual(b, { minX: 0, maxX: 100, minZ: 0, maxZ: 50 });
  const i = bboxInfo(b);
  assert.equal(i.cx, 50); assert.equal(i.cz, 25);
  assert.equal(i.w, 100); assert.equal(i.h, 50);
  assert.equal(bboxOfRings([[]]), null);
  assert.equal(bboxInfo(null), null);
});

test('35K TOWN_POLYGONS を HTML から読める（新しい座標は作らない）', () => {
  const o = readTownPolygons(html);
  const keys = Object.keys(o);
  assert.ok(keys.length > 300, '町丁目が ' + keys.length + ' 件しか読めない');
  // 3 区ぶんしか無い（§12 のとおり）
  const wards = new Set(keys.map((k) => (splitTownKey(k) || {}).ward).filter(Boolean));
  assert.deepEqual([...wards].sort(), [...TOWN_BOUNDARY_WARDS].sort());
  // リングは座標の配列
  const first = o[keys[0]];
  assert.ok(Array.isArray(first) && Array.isArray(first[0]) && first[0].length > 3);
});

test('35K 実データ: 町丁目が無い区は区界へ落ちる（推測の町界は作らない）', () => {
  const ab = rj(M('derived', 'area-boundaries.json'));
  if (!ab) return;
  assert.deepEqual([...ab.townWards].sort(), [...TOWN_BOUNDARY_WARDS].sort());
  assert.equal(ab.counts.wards, 24, '区界が 24 件でない');
  // 出所は 2 種類だけ
  const sources = new Set(ab.areas.map((a) => a.boundarySource));
  assert.deepEqual([...sources].sort(), ['legacy-unverified', 'n03-official']);
  // 町丁目は 3 区の区名しか持たない
  for (const a of ab.areas) {
    if (a.boundaryGranularity !== 'chochome' && a.boundaryGranularity !== 'chochome-union') continue;
    assert.ok(TOWN_BOUNDARY_WARDS.includes(a.wardName), a.wardName + ' の町丁目が作られている');
  }
});

test('35K 実データ: 駅索引が事業者で分類できている', () => {
  const si = rj(M('derived', 'station-index.json'));
  if (!si) return;
  assert.ok(si.count > 200, '駅が ' + si.count + ' 件しかない');
  assert.equal(si.canonicalCount, 253, 'canonical の駅数が変わっている');
  for (const need of ['metro', 'jr', 'private']) {
    assert.ok(si.byGroup[need] > 0, need + ' の駅が 1 つも無い');
  }
  for (const need of ['metro', 'jr', 'hankyu', 'hanshin', 'kintetsu', 'nankai', 'keihan']) {
    assert.ok(si.byOperator[need] > 0, need + ' が分類できていない');
  }
  // 不明はごく少数
  assert.ok((si.byOperator.unknown || 0) <= 10, '不明が多すぎる: ' + si.byOperator.unknown);
  // §4 別名の駅が残っている
  for (const n of ['大阪', '梅田', '東梅田', '西梅田']) {
    assert.ok(si.stations.some((s) => s.name === n), n + ' が消えている');
  }
  // §25 北部の駅
  for (const n of ['新大阪', '東淀川', '淡路', '上新庄', '十三']) {
    assert.ok(si.stations.some((s) => s.name === n), n + ' が無い');
  }
});

// ── §5/§7/§8 ラベルの作り ──────────────────────────────────────────────
test('35K 駅ラベルは事業者バッジを持ち、町名より強い', () => {
  // バッジ（色 + 短い記号）を描く。公式ロゴは使わない。
  assert.match(html, /badge: op \? \{ text: op\.code, bg: hex, fg: '#ffffff' \} : null,/);
  assert.match(html, /if \(style\.badge\) \{/);
  // §5 駅のフォントが地名より小さくない
  const st = html.match(/const f = importance === 'major' \? 15 : \(importance === 'transfer'[^;]*;/);
  assert.ok(st, '駅のフォント指定が読めない');
  // §8 遠景=主要駅 / 中距離=乗換駅 / 近距離=全駅
  assert.match(html, /if \(item\.kind === 'station'\) \{\s*\n\s*if \(item\.importance === 'major'\) return true;/);
  // §7 ランドマーク S（rank 0）は駅より前のまま
  assert.match(html, /item\.tier === 'S' \? 0 :/);
  assert.match(html, /item\.importance === 'major' \? 0\.8/);
});

test('35K 駅はクラスタリングし直さない（別駅が消えるため）', () => {
  // station-index が既に §4 の統合をしてある。ラベル側で再度まとめない。
  const s = html.indexOf("const STATION_URL");
  const e = html.indexOf('if (rr && rr.ok)', s);
  const block = html.slice(s, e);
  assert.ok(!/clusterStations/.test(block), 'ラベル側で再クラスタリングしている');
  assert.match(html, /const STATION_URL = 'map-data\/osaka-city\/derived\/station-index\.json';/);
});

// ── §20/§21 クリック ───────────────────────────────────────────────────
test('35K クリックの優先順位（ラベル → 施設 → 建物）', () => {
  const labelAt = html.indexOf('CityLabelLayer.pickLabel(e.clientX, e.clientY)');
  const facilityAt = html.indexOf('const extendedFacilityHit = FacilityLayer.pickHit');
  const buildingAt = html.indexOf('const h = pickHit(e);', facilityAt);
  assert.ok(labelAt > 0, 'ラベル判定が無い');
  assert.ok(labelAt < facilityAt, 'ラベルが施設より後ろ');
  assert.ok(facilityAt < buildingAt || buildingAt < 0, '施設が建物より後ろ');
  // ラベルに当たったら return して建物カードへ進まない
  assert.match(html, /if \(labelHit\.kind === 'station'\) \{ selectStationLabel\(labelHit\); return; \}/);
});

test('35K ドラッグ保護は既存の clickIntent を使う', () => {
  // 既存の仕組みを使い、独自のドラッグ判定を作っていない
  assert.match(html, /if \(!clickIntentAllows\(\)\) return;/);
  const labelAt = html.indexOf('CityLabelLayer.pickLabel(e.clientX, e.clientY)');
  const guardAt = html.lastIndexOf('if (!clickIntentAllows()) return;', labelAt);
  assert.ok(guardAt > 0 && guardAt < labelAt, 'ラベル判定がドラッグ保護より前にある');
});

// ── §17/§18/§19 選択状態 ───────────────────────────────────────────────
test('35K 選択状態は将来の selectedArea の形で持つ', () => {
  // §19 { type, id, name, ward, bbox, polygon }
  for (const k of ['type:', 'id: area.id', 'name: area.name', 'ward: area.wardName', 'bbox: area.bbox', 'polygon: area.rings']) {
    assert.ok(html.includes(k), k + ' が無い');
  }
  // §17 3 つの解除経路
  assert.match(html, /clearSelection\(\)/);
  assert.match(html, /if \(selected && selected\.id === areaId\) return clearSelection\(\);/);   // 再クリック
  assert.match(html, /if \(e\.key !== 'Escape'\) return;/);                                      // ESC
  assert.match(html, /close\.id = 'area-selection-close'/);                                       // ✕
});

test('35K 境界の見た目（§13/§14）', () => {
  assert.match(html, /const COLOR = 0x40fff0;/);                 // §13 turquoise
  const m = html.match(/const FILL_OPACITY = ([\d.]+);/);
  assert.ok(m, '塗りの不透明度が読めない');
  assert.ok(+m[1] >= 0.04 && +m[1] <= 0.10, '§14 の 0.04〜0.10 の外: ' + m[1]);
  assert.match(html, /line\.renderOrder = 990;/);                // 道路・鉄道より上
});

test('35K ズームは bbox から決め、真上視点に強制しない（§15/§16）', () => {
  assert.match(html, /function fitRadius\(bbox\)/);
  assert.match(html, /const r = \(span \* FIT_MARGIN\) \/ \(2 \* Math\.tan\(\(fovDeg \* Math\.PI \/ 180\) \/ 2\)\);/);
  // ph（俯角）を書き換えていない＝斜め視点のまま
  const s = html.indexOf('function selectArea(areaId, opts = {})');
  const e = html.indexOf('function clearSelection()', s);
  const block = html.slice(s, e);
  assert.ok(!/cs\.ph\s*=/.test(block), '選択時に俯角を変えている');
  assert.match(block, /flyTo\(cx, cz, \{ r \}\)/);
  // §16 400〜800ms
  const a = html.match(/const ANIM_MS = (\d+);/);
  assert.ok(a && +a[1] >= 400 && +a[1] <= 800, 'ANIM_MS が範囲外');
});

// ── §30/§31 dev 限定 ───────────────────────────────────────────────────
test('35K dev の操作は production で隠れる / production に 35K が入っていない', () => {
  assert.deepEqual(devUiIsGated(DEV_ONLY_IDS, html), { ok: true });
  const prod = fs.readFileSync(PROD, 'utf-8');
  assert.ok(!/AreaSelectionLayer/.test(prod), 'production に 35K が入っている');
  assert.ok(!/station-index\.json/.test(prod));
  assert.match(prod, /let buildingsVersion = 'V4';/, 'production は 35J のまま');
});

// ── QA の作り ───────────────────────────────────────────────────────────
test('35K §23/§24 の確認地点が揃っている', () => {
  const ids = STATION_SITES.map((s) => s.id);
  for (const need of ['umeda', 'namba', 'tennoji', 'shin-osaka', 'kita-osaka', 'honmachi', 'kyobashi', 'yodoyabashi']) {
    assert.ok(ids.includes(need), need + ' が無い');
  }
  // §23 の必須駅が期待値に入っている
  const expected = STATION_SITES.flatMap((s) => s.expect);
  for (const n of ['大阪駅', '梅田駅', '東梅田駅', '西梅田駅', '新大阪駅', 'なんば駅', '大阪難波駅',
    '天王寺駅', '大阪阿部野橋駅', '京橋駅', '淡路駅', '上新庄駅', '本町駅', '心斎橋駅', '淀屋橋駅']) {
    assert.ok(expected.includes(n), n + ' を確認していない');
  }
  // §24 町丁目がある区と無い区の両方を見る
  const grans = new Set(TOWN_SITES.map((s) => s.expectGranularity));
  assert.ok(grans.has('chochome') && grans.has('ward'), '両方の粒度を見ていない');
  // 地点は区の中
  const wards = (rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'boundaries',
    'ward-classification-polygons.json')) || {}).wards;
  if (!wards) return;
  for (const s of [...STATION_SITES, ...TOWN_SITES]) {
    const w = worldOf(s);
    assert.ok(classifyPointToWard(w.x, w.z, wards).wardId, s.id + ' が区ポリゴンの外');
  }
});

// ── 実測 ────────────────────────────────────────────────────────────────
test('35K 実測: 駅が事業者つきで出ている', { skip: skip('station-town-navigation-qa.json') }, () => {
  const q = rpt('station-town-navigation-qa.json');
  const s = q.summary;
  assert.equal(s.stationSitesOk, true, '出ていない駅: ' + JSON.stringify(s.stationMissing));
  assert.equal(s.northStationsOk, true, '§25 北部の駅が欠けている');
  assert.ok(s.multiOperatorSites.length >= 2, '複数事業者が同時に出る地点が少ない');
  assert.ok(s.operatorsSeen.length >= 3, '見えた事業者が ' + s.operatorsSeen.join(','));
});

test('35K 実測: 町名クリックで境界・ズーム・解除が動く', { skip: skip('station-town-navigation-qa.json') }, () => {
  const q = rpt('station-town-navigation-qa.json');
  const s = q.summary;
  assert.equal(s.townSelectionShown, true, '境界が出ていない');
  assert.equal(s.townZoomApplied, true, 'ズームしていない');
  assert.equal(s.townClearOk, true, '解除で消えていない');
  assert.equal(s.stationClickOk, true, '駅クリックが効いていない');
  assert.equal(s.townSitesClicked, s.townSitesTotal, '§24 の町が全部クリックできていない');
  // §11 粒度は source のまま名乗る。町丁目のある 3 区は chochome / chochome-union、
  //   無い区は ward（N03 正式区界）。推測した町界へは落とさない（§12）。
  assert.equal(s.townGranularityOk, true, JSON.stringify(s.townGranularities));
});

test('35K 実測: クリックの衝突とドラッグ保護', { skip: skip('station-town-navigation-qa.json') }, () => {
  const q = rpt('station-town-navigation-qa.json');
  assert.equal(q.summary.clickConflictOk, true, JSON.stringify(q.clickConflict));
  assert.equal(q.summary.dragNoClickOk, true, JSON.stringify(q.dragNoClick));
});

test('35K 実測: 性能と回帰', { skip: skip('station-town-navigation-qa.json') }, () => {
  const q = rpt('station-town-navigation-qa.json');
  const s = q.summary;
  assert.equal(s.regressionOk, true, JSON.stringify(s.regression));
  assert.equal(s.jsErrors, 0);
  // §26 全駅を毎フレーム作り直していない（sprite 数が駅数を大きく超えない）
  for (const [id, p] of Object.entries(s.perf)) {
    assert.ok(p.sprites < 3000, id + ' の sprite が ' + p.sprites);
  }
  // §27 35K が増やした分の費用は **同一セッション・同一カメラの ON/OFF** で測る。
  //   35I の baseline をそのまま引き算すると、読み込まれていたタイルの違い（梅田の
  //   draw call 285 → 483）まで 35K の費用に化けてしまう（35H の City Mode と同じ罠）。
  const ab = s.perfAb;
  assert.ok(ab, '駅ラベル ON/OFF の A/B が無い');
  assert.equal(ab.id, 'umeda');
  assert.ok(ab.rounds >= 2, 'A/B が 1 往復しかしていない');
  assert.ok(ab.fpsDropPct <= FPS_DROP_BUDGET_PCT,
    `駅ラベルの FPS 低下が ${ab.fpsDropPct}%（ON ${ab.stationsOn.fps} / OFF ${ab.stationsOff.fps}）`);
  assert.ok(ab.stationsOn.labels > ab.stationsOff.labels, 'ON/OFF でラベル数が変わっていない（A/B が効いていない）');
  // 35I baseline は「参考値」として残す。同じ場面ではないので合否には使わない。
  const base = rpt('directional-balance-qa.json');
  if (base && base.summary.perf && s.perf.umeda) {
    assert.ok(Number.isFinite(base.summary.perf.new.fpsAverage));
  }
});

test('35K 実測: データが 1 つも動いていない', { skip: skip('station-town-navigation-validation.json') }, () => {
  const v = rpt('station-town-navigation-validation.json');
  assert.equal(v.buildingCount, BUILDING_COUNT);
  assert.equal(v.canonicalGeometryMutation, 0);
  assert.equal(v.canonicalIdMutation, 0);
  assert.equal(v.projectionMutation, 0);
  assert.equal(v.placementMutation, 0);
  assert.equal(v.roadMutation, 0);
  assert.equal(v.railMutation, 0);
  assert.equal(v.waterMutation, 0);
  assert.equal(v.parkMutation, 0);
  assert.equal(v.stationMutation, 0);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
  assert.equal(v.inventedBoundary, 0);
  assert.equal(v.townWardsOk, true);
  assert.equal(v.classification, 'STATION_AND_TOWN_NAVIGATION_SUCCESS', JSON.stringify(v.errors));
});
