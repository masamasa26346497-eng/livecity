// tests/building-coverage-click-ux.test.js
// [Mission 34C] 建物 coverage の回復 と クリック意図の判定
//   - 欠落原因（候補フィルタ）の特定と、重複判定を変えずに回収していること
//   - 捏造していないこと（OSM footprint 由来・POI 押し出しなし）
//   - V2N を 1 件も変えていないこと
//   - pan / rotate / wheel では card が開かず、明確なクリックでだけ開くこと
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V2N_FEATURE_COUNT, CLICK_SPEC, CLICK_ACCEPT, compareV2ToV3, checkRecoveredProvenance } from '../tools/validate/building-coverage-click-ux.js';
import { SITES as CLICK_SITES, REPS, ACCEPT } from '../tools/audit/click-intent-qa.js';
import { MIN_FP_AREA_M2, MAX_FP_AREA_M2, EARLY_DUP } from '../tools/audit/building-coverage-citywide.js';
import { FIXTURES, ringArea, bboxOverlapRatio, pointInRing } from '../tools/audit/building-fixture-trace.js';
import { dedupeRecovered, recoveredFeature } from '../tools/build-osm-fallback-v3.js';
import { parseBuilding } from '../tools/audit/plateau-missing-audit.js';
import { devUiIsGated } from '../tools/lib/production-invariants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');
const dir = (...s) => path.join(ROOT, ...s);
const skipDir = (...s) => (!fs.existsSync(dir(...s)) && 'no data');

// ── 純粋関数 ──────────────────────────────────────────────────────────────
test('[34C §2] fixture の定義（Brillia Tower Dojima が先頭）', () => {
  assert.equal(FIXTURES[0].id, 'brillia-tower-dojima');
  for (const f of FIXTURES) {
    assert.ok(f.patterns.length >= 1, f.id + ' に検索パターンが無い');
    for (const p of f.patterns) assert.ok(p instanceof RegExp);
  }
  // §13 の fixture が揃っている
  for (const id of ['grand-green-osaka', 'osaka-station', 'nakanoshima', 'honmachi', 'namba', 'tennoji', 'shin-osaka']) {
    assert.ok(FIXTURES.some((f) => f.id === id), id + ' が無い');
  }
});

test('[34C §2] footprint の基本計算', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(ringArea(sq), 100);
  assert.ok(pointInRing(5, 5, sq));
  assert.ok(!pointInRing(15, 5, sq));
  const a = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  assert.equal(bboxOverlapRatio(a, a), 1);
  assert.equal(bboxOverlapRatio(a, { minX: 20, maxX: 30, minZ: 0, maxZ: 10 }), 0);
  assert.ok(Math.abs(bboxOverlapRatio(a, { minX: 5, maxX: 15, minZ: 0, maxZ: 10 }) - 0.5) < 1e-9);
});

test('[34C §9] 回収分どうしの重複を落とす（情報の多い方を残す）', () => {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const cands = [
    { canonicalId: 'cg_bldg_osm_1', wayId: 1, ring, areaM2: 100, tags: {} },
    { canonicalId: 'cg_bldg_osm_2', wayId: 2, ring: ring.map(([x, z]) => [x + 0.1, z]), areaM2: 100, tags: { name: 'タワー', 'building:levels': '30' } },
    { canonicalId: 'cg_bldg_osm_3', wayId: 3, ring: [[100, 100], [110, 100], [110, 110], [100, 110]], areaM2: 100, tags: {} },
  ];
  const r = dedupeRecovered(cands);
  assert.equal(r.kept.length, 2, '重複 1 件が落ちるはず');
  assert.ok(r.kept.some((c) => c.canonicalId === 'cg_bldg_osm_2'), '名前と階数を持つ方を残す');
  assert.ok(r.kept.some((c) => c.canonicalId === 'cg_bldg_osm_3'), '離れた棟は残す');
  assert.equal(r.droppedIds.length, 1);
});

test('[34C §6/§10] 回収 feature は OSM footprint 由来で provenance を持つ', () => {
  const c = { canonicalId: 'cg_bldg_osm_12345', wayId: 12345, wardId: 'kita', areaM2: 2412,
    ring: [[0, 0], [40, 0], [40, 60], [0, 60]], tags: { building: 'hotel', 'building:levels': '49' },
    cls: 'VALID_FALLBACK', rule: 'no-overlap', metrics: { coveredFraction: 0 } };
  const { feature, attrs } = recoveredFeature(c, '2026-09-23T00:00:00.000Z');
  assert.equal(feature.source.geometrySource, 'osm-building');
  assert.deepEqual(feature.source.sourceIds, ['way/12345']);
  assert.equal(feature.coordinates[0].length, 4, 'footprint の頂点をそのまま使う');
  assert.ok(feature.qaFlags.includes('recovered:34C'));
  assert.equal(attrs.recoveredBy, 'mission-34C');
  assert.equal(attrs.levels, 49, 'OSM の階数を落とさない');
  assert.ok(attrs.overlapMetrics, '何を根拠に足したかを残す');
  assert.equal(feature.coordinateConvention, 'znorth-neg-v1');
});

test('[34C §6] POI / 施設 / 住所点から建物を作らない', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'build-osm-fallback-v3.js'), 'utf-8');
  // コード側に point → 建物 の経路が無い
  assert.doesNotMatch(src, /amenity|facilit|addr:|extrudePoint/i);
  // 入力は必ず ring
  assert.match(src, /toFallbackRecord\(c\.wayId, c\.ring, c\.tags/);
});

test('[34C §7] CityGML の 1 建物から gml:id と footprint の重心を取る', () => {
  // 正方形。重心は中央（頂点 1 点だと輪郭線上になり、内外判定が安定しない）
  const seg = '<bldg:Building gml:id="bldg_abc-123">'
    + '<gml:posList>34.6 135.5 0 34.6 135.5005 0 34.6005 135.5005 0 34.6005 135.5 0 34.6 135.5 0</gml:posList></bldg:Building>';
  const b = parseBuilding(seg);
  assert.equal(b.id, 'bldg_abc-123');
  assert.equal(b.ringPoints, 4, '閉じ点を落として 4 頂点');
  assert.ok(Math.abs(b.lat - 34.60025) < 1e-9, '緯度・経度の順を取り違えない（重心）');
  assert.ok(Math.abs(b.lon - 135.50025) < 1e-9);
  // 座標が無くても id は返す
  assert.equal(parseBuilding('<bldg:Building gml:id="x">').id, 'x');
  assert.equal(parseBuilding('<bldg:Building>'), null);
});

test('[34C §8] 監査の footprint 有効範囲は 32O と同じ', () => {
  assert.equal(MIN_FP_AREA_M2, 8);
  assert.equal(MAX_FP_AREA_M2, 60000);
  assert.equal(EARLY_DUP.bboxIoU, 0.5);
  // 早期判定は「重複側」へ倒す（欠落を多く数えない）
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'audit', 'building-coverage-citywide.js'), 'utf-8');
  assert.match(src, /centroidIn && maxIoU >= EARLY_DUP\.bboxIoU/);
  // 重複判定そのものは 32O のライブラリをそのまま使う（新しい基準を作らない §9）
  assert.match(src, /from '\.\.\/lib\/osm-fallback-v2-classify\.js'/);
});

// ── click intent（コード）──────────────────────────────────────────────────
test('[34C §17] 旧ガードが効いていなかったことを実装で直している', () => {
  // 旧: window の 'click' で `if(cs.drag) return;` → mouseup が先に走るので常に false
  assert.doesNotMatch(html, /window\.addEventListener\('click',e=>\{\n  \/\/ ドラッグ終了直後のクリックは無視\n  if\(cs\.drag\) return;/);
  assert.match(html, /if \(!clickIntentAllows\(\)\) return;/);
});

test('[34C §18/§19] gesture を押下〜離上で判定する', () => {
  assert.match(html, /const CLICK_INTENT = \{/);
  assert.match(html, /function clickIntentDown\(x, y, pointerType, button\)/);
  assert.match(html, /function clickIntentMove\(x, y\)/);
  assert.match(html, /function clickIntentUp\(\)/);
  assert.match(html, /function clickIntentAllows\(\)/);
  // 押下・移動・離上が実際に繋がっている
  assert.match(html, /clickIntentDown\(e\.clientX, e\.clientY, 'mouse', e\.button\)/);
  assert.match(html, /clickIntentMove\(e\.clientX, e\.clientY\)/);
  // DPI と pointer type でしきい値を変える
  assert.match(html, /function clickMoveThreshold\(\)/);
  assert.match(html, /devicePixelRatio/);
});

test('[34C §19/§21] しきい値が仕様の範囲内', () => {
  const num = (re) => Number((html.match(re) || [])[1]);
  const movePx = num(/MOVE_PX: (\d+(?:\.\d+)?),/);
  const touchPx = num(/TOUCH_MOVE_PX: (\d+(?:\.\d+)?),/);
  const wheelMs = num(/WHEEL_BLOCK_MS: (\d+),/);
  assert.ok(movePx >= CLICK_SPEC.movePx[0] && movePx <= CLICK_SPEC.movePx[1], 'movePx ' + movePx);
  assert.ok(touchPx >= CLICK_SPEC.touchMovePx[0] && touchPx <= CLICK_SPEC.touchMovePx[1], 'touchMovePx ' + touchPx);
  assert.ok(wheelMs >= CLICK_SPEC.wheelBlockMs[0] && wheelMs <= CLICK_SPEC.wheelBlockMs[1], 'wheelBlockMs ' + wheelMs);
  assert.ok(touchPx > movePx, 'touch のほうを緩くする');
});

test('[34C §20] カメラが動いたかは camUpd の呼び出しではなく値で見る', () => {
  // camUpd はタイル整定やリサイズからも呼ばれるので、呼ばれた＝操作した ではない
  assert.match(html, /function clickIntentCameraMoved\(\)/);
  assert.match(html, /CLICK_INTENT\.camAt = \{ x: cs\.tgt\.x, z: cs\.tgt\.z, r: cs\.r, th: cs\.th, ph: cs\.ph \};/);
  assert.match(html, /CLICK_INTENT\.camMoved = CLICK_INTENT\.forceGesture \|\| clickIntentCameraMoved\(\);/);
  assert.doesNotMatch(html, /if \(CLICK_INTENT\.active\) CLICK_INTENT\.camMoved = true;/);
});

test('[34C §21] ホイール直後は building click を抑制する', () => {
  assert.match(html, /CLICK_INTENT\.lastWheelT = \(typeof performance/);
  assert.match(html, /if \(now - CLICK_INTENT\.lastWheelT < CLICK_INTENT\.WHEEL_BLOCK_MS\) \{ CLICK_INTENT\.stats\.suppressedWheel\+\+; return false; \}/);
});

test('[34C §26] touch は tap だけ通す（swipe / pinch では開かない）', () => {
  assert.match(html, /clickIntentDown\(e\.touches\[0\]\.clientX, e\.touches\[0\]\.clientY, 'touch', 0\)/);
  assert.match(html, /addEventListener\('touchend',\(\)=>\{ clickIntentUp\(\); \}/);
  assert.match(html, /addEventListener\('touchcancel',\(\)=>\{ clickIntentUp\(\); \}/);
  assert.match(html, /if \(CLICK_INTENT\.active\) \{ CLICK_INTENT\.forceGesture = true; \}/);
  assert.match(html, /clickIntentMove\(e\.touches\[0\]\.clientX, e\.touches\[0\]\.clientY\)/);
});

test('[34C §24/§25] card の開閉経路', () => {
  // card を開くのは selectBuilding だけ（gesture 判定を通った click からしか来ない）
  const openCalls = (html.match(/^\s*showPropertyCard\(/gm) || []).length;
  assert.ok(openCalls <= 2, 'showPropertyCard の呼び出しが増えている: ' + openCalls);
  // Escape で閉じる
  assert.match(html, /if \(e\.key !== 'Escape'\) return;/);
  // 何も無いところを明確にクリックしたら閉じる（drag 後には閉じない）
  assert.match(html, /CLICK_INTENT\.stats\.cardClosedByEmptyClick\+\+/);
});

test('[34C §11] runtime に V3 namespace が入り、V2N はそのまま', () => {
  assert.match(html, /const BASE_V3_OSMV3 = BASE\.replace\(\/\\\/derived\$\/, '\/derived-v2-osmv3'\);/);
  assert.match(html, /V3: BASE_V3_OSMV3/);
  assert.match(html, /V2N: BASE_V2_OSMV2/);
  assert.match(html, /\['V3', 'V3 \+ RECOVERED'/);
  // fetch の namespace 集計にも V3 を足す
  assert.match(html, /u\.includes\('\/derived-v2-osmv3\/'\) \? 'V3'/);
});

test('[34C §15] COVERAGE QA は dev だけ', () => {
  assert.match(html, /const CoverageQaLayer = \(function \(\) \{/);
  assert.match(html, /window\.__COVERAGE_QA__/);
  assert.match(html, /coverageQaBtn\.id = 'coverage-qa-toggle';/);
  // [Mission 35G] 入口は production のバイトにも入るが、トグルは非表示の箱の中。
  assert.deepEqual(devUiIsGated(['coverage-qa-toggle']), { ok: true });
});

// ── 実データ（あるときだけ）────────────────────────────────────────────────
test('[34C §2/§3] Brillia Tower Dojima の欠落原因', { skip: skip('building-fixture-trace.json') }, () => {
  const t = rpt('building-fixture-trace.json');
  const miss = t.traces.filter((x) => !x.canonicalMatch);
  assert.ok(miss.length >= 1, '欠落建物が 1 件も見つかっていない');
  const b = miss.find((x) => x.fixture === 'brillia-tower-dojima');
  assert.ok(b, '堂島の欠落建物が無い');
  assert.equal(b.canonicalMatch, null, 'canonical に無いこと');
  assert.equal(b.derived.near, false);
  assert.equal(b.derived.mid, false);
  assert.equal(b.derived.far, false);
  // §3 分類: OSM にはあるが canonical に無い（＝候補フィルタで落ちた）
  assert.equal(b.osmFallbackCandidate, null, '候補にすらなっていないことが原因');
  assert.ok(b.canonicalNearby > 0, '周辺に canonical はある（＝データ欠損ではなく選定の問題）');
});

test('[34C §4/§12] 市内全域の監査と回収数', { skip: skip('building-coverage-citywide.json') }, () => {
  const c = rpt('building-coverage-citywide.json');
  assert.equal(c.canonical.total, V2N_FEATURE_COUNT);
  assert.ok(c.osmScan.inCity > 400000, '市内 OSM 建物が少なすぎる: ' + c.osmScan.inCity);
  // 会計が合う
  const k = c.counts;
  assert.equal(k.CLEAR_DUPLICATE + k.LIKELY_DUPLICATE + k.AMBIGUOUS + k.VALID_FALLBACK, k.total);
  assert.equal(k.earlyDuplicate + k.noCandidate + k.measured, k.total);
  assert.equal(k.newlyRecoverable, k.AMBIGUOUS + k.VALID_FALLBACK - k.alreadyDisplayedFallback);
  assert.ok(k.newlyRecoverable > 0, '欠落建物が 0 件');
});

test('[34C §12] V3 = V2N + 回収分（V2N は 1 件も変えない）', { skip: skip('osm-fallback-v3-build.json') }, () => {
  const b = rpt('osm-fallback-v3-build.json');
  assert.ok(b.canonical, 'canonical stage が無い');
  assert.equal(b.canonical.baseFeatureCount, V2N_FEATURE_COUNT);
  assert.equal(b.canonical.mergedFeatureCount, b.canonical.baseFeatureCount + b.canonical.recovered);
  assert.ok(Object.keys(b.canonical.byWard).length >= 20, '回収が一部の区に偏っている');
});

test('[34C §1] V2N の建物は V3 でも同じ座標', { skip: skipDir('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv3') }, () => {
  const r = compareV2ToV3(20);
  assert.ok(r.featuresCompared > 1000, '照合できた建物が少ない: ' + r.featuresCompared);
  assert.equal(r.missingInV3, 0, 'V3 で消えた建物がある');
  assert.equal(r.geometryChanged, 0, 'V3 で座標が変わった建物がある');
});

test('[34C §6] 回収分はすべて OSM footprint 由来', { skip: skipDir('data', 'processed', 'osaka-city', 'canonical', 'buildings-v3-recovered') }, () => {
  const p = checkRecoveredProvenance();
  assert.ok(p.checked > 0);
  assert.equal(p.notOsmBuilding, 0);
  assert.equal(p.noSourceId, 0);
  assert.equal(p.sourceIdMismatch, 0);
  assert.equal(p.ringMismatch, 0, 'OSM の footprint と違う形が入っている');
  assert.equal(p.fromPoint, 0, 'point から作った建物がある');
});

test('[34C §7] raw PLATEAU との差の内訳', { skip: skip('plateau-missing-audit.json') }, () => {
  const a = rpt('plateau-missing-audit.json');
  const k = a.counts;
  assert.equal(k.inCanonical + k.notInCanonical, k.rawUniqueIds);
  assert.equal(k.noPosition + k.outsideCity + (k.reEditionOfExisting || 0) + k.insideCityMissing, k.notInCanonical);
  assert.ok(k.rawUniqueIds > 600000, 'raw の走査数が少ない: ' + k.rawUniqueIds);
  // canonical の PLATEAU は全件 raw の中に見つかる（id の突き合わせが壊れていない）
  assert.equal(k.inCanonical, a.canonicalPlateauIds);
});

test('[34C §27] pan / rotate / wheel では card が開かない', { skip: skip('click-intent-qa.json') }, () => {
  const q = rpt('click-intent-qa.json');
  assert.equal(q.sites.length, CLICK_SITES.length);
  assert.equal(q.reps, REPS);
  assert.equal(q.totals.panFalseOpen, ACCEPT.panFalseOpen);
  assert.equal(q.totals.rotateFalseOpen, ACCEPT.rotateFalseOpen);
  assert.equal(q.totals.wheelFalseOpen, ACCEPT.wheelFalseOpen);
  // gesture が空振りしていない（本当に camera が動いている）
  assert.ok(q.totals.panMoved >= q.sites.length * REPS * 0.9, 'pan で camera が動いていない');
  assert.ok(q.totals.rotateMoved >= q.sites.length * REPS * 0.9, 'rotate で camera が動いていない');
  assert.ok(q.totals.wheelMoved >= q.sites.length * REPS * 0.9, 'wheel で camera が動いていない');
});

test('[34C §27] 明確なクリックでは card が開く', { skip: skip('click-intent-qa.json') }, () => {
  const q = rpt('click-intent-qa.json');
  assert.ok(q.totals.singleClickSuccessPct >= CLICK_ACCEPT.singleClickSuccessPct,
    'single click 成功率 ' + q.totals.singleClickSuccessPct + '%');
});

test('[34C §24] camera 操作で card が切り替わらない', { skip: skip('click-intent-qa.json') }, () => {
  const q = rpt('click-intent-qa.json');
  assert.equal(q.totals.persistenceOk, true);
  for (const s of q.sites) {
    assert.equal(s.persistence.stayedOpen, true, s.site + ' で card が閉じた');
    assert.equal(s.persistence.sameBuilding, true, s.site + ' で別建物へ切り替わった');
  }
});

test('[34C §32] validator が通っている', { skip: skip('building-coverage-click-ux-validation.json') }, () => {
  const r = rpt('building-coverage-click-ux-validation.json');
  assert.equal(r.brilliaTowerDojimaInvestigated, true);
  assert.equal(r.validMissingBuildingsRecovered, true);
  assert.equal(r.fabricatedBuildingCount, 0);
  assert.equal(r.duplicateIncrease, 0);
  assert.equal(r.buildingPositionMutation, 0);
  assert.equal(r.projectionMutation, 0);
  assert.equal(r.dragOpensCard, false);
  assert.equal(r.rotateOpensCard, false);
  assert.equal(r.wheelOpensCard, false);
  assert.equal(r.explicitClickOpensCard, true);
  assert.equal(r.productionModified, false);
  assert.equal(r.protectedModified, false);
  assert.equal(r.classification, 'BUILDING_COVERAGE_CLICK_UX_SUCCESS');
});
