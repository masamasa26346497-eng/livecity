// tests/landmark-hd-poc.test.js
// [Mission 33E] Landmark High Detail Layer（PoC: 大阪城）
//   - 専用レイヤーが独立していること（通常建物の経路を変えていない）
//   - 設定ファイルの必須項目と出所（どこまで実データか）
//   - 幾何生成（純関数）の性質
//   - 実ブラウザ QA / validator の結果
//   - production / protected は未変更
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CASTLE_STYLE, MATERIALS, dedupeRing, centroidOf, scaleRing, ringIsCCW,
  createMeshBuilder, pruneDegenerate,
} from '../tools/build-landmark-models.js';
import { REQUIRED_CONFIG_FIELDS, LOD1_TRIANGLE_BASELINE, MIN_DETAIL_RATIO } from '../tools/validate/landmark-hd-poc.js';
import { SCAN_RADIUS_M, KEEP_MATCH, ringArea, ringCentroid, toLocal } from '../tools/audit/osaka-castle-source-scan.js';
import { productionMatchesBuildRecord, devUiIsGated } from '../tools/lib/production-invariants.js';
import { skipIfMissingRel } from './_generated-data.mjs';
// [Mission 35L] cutover の記録 / baseline hash はコミットされないので、無いときだけ skip
const BASELINE_SKIP = skipIfMissingRel('data/reports/baselines');
// [Mission 35L] 検証対象の生成物が無いときだけ skip（生成済みなら従来どおり全部検証する）
const MODEL_SKIP = skipIfMissingRel('public/map-data/osaka-city/landmarks/landmark-models.json');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const models = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'landmarks', 'landmark-models.json'));

test('[33E §1] 高精細レイヤーは独立していて canonicalRoot 配下にある', () => {
  assert.match(html, /const LandmarkHDLayer = \(function \(\) \{/);
  assert.match(html, /group\.name = 'LandmarkHDLayer';/);
  assert.match(html, /if \(typeof canonicalRoot !== 'undefined'\) canonicalRoot\.add\(group\);/);
  assert.match(html, /tagRuntimeOwnerRecursive\(group, RUNTIME_OWNER\.CANONICAL\)/);
  // 旧 LandmarkLayer（Mission11B）は消さない
  assert.match(html, /const LandmarkLayer = \(function \(\) \{/);
  assert.match(html, /LandmarkLayer\.init\(\);/);
  // 共存レイヤー名（/^Landmark/ に合致）なので legacy residual に数えられない
  assert.match(html, /const COEXIST_NAME = \/\^\([^)]*Landmark[^)]*\)\/i;/);
});

test('[33E §2] 対象は設定ファイルが決める（HTML に名前や寸法を持たせない）', () => {
  const start = html.indexOf('const LandmarkHDLayer');
  // [Mission 34B] 終端は LandmarkHDLayer の直後に置く。'const CanonicalRuntime' までにすると
  //   あいだに入った別レイヤー（34A BuildingLODLayer / 34B の LOD VIEW preset）まで
  //   検査範囲に入ってしまい、この test の主旨（LandmarkHD が名前を持たない）とずれる。
  const end = html.indexOf('[Mission 34A] Building LOD Layer', start);
  assert.ok(end > start, 'レイヤー定義の範囲が取れない');
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /大阪城/);
  assert.doesNotMatch(block, /osaka-castle/);
  assert.doesNotMatch(block, /53\.2/);
  assert.match(block, /const URL_ = 'map-data\/osaka-city\/landmarks\/landmark-models\.json';/);
});

test('[33E §2] 設定ファイルに必須項目がそろっている', { skip: MODEL_SKIP }, () => {
  assert.ok(models, 'landmark-models.json が無い');
  assert.ok((models.landmarks || []).length >= 1);
  for (const l of models.landmarks) {
    for (const k of REQUIRED_CONFIG_FIELDS) assert.ok(l[k] !== undefined && l[k] !== null, `${l.landmarkId}: ${k} が無い`);
    assert.ok(Number.isFinite(l.anchor.x) && Number.isFinite(l.anchor.z));
    assert.ok(l.swapRadiusM > 0 && l.visibleDistanceM > l.swapRadiusM);
    assert.ok(Array.isArray(l.parts) && l.parts.length >= 1);
    for (const p of l.parts) {
      assert.ok(MATERIALS.includes(p.material), '未知の material: ' + p.material);
      assert.equal(p.indices.length % 3, 0);
      assert.equal(p.triangleCount, p.indices.length / 3);
      assert.equal(p.vertexCount, p.positions.length / 3);
      // index が範囲内
      assert.ok(Math.max(...p.indices) < p.vertexCount, p.material + ': index が範囲外');
    }
  }
});

test('[33E §4/§7] 大阪城: 実データと様式化の切り分けが設定に書かれている', { skip: MODEL_SKIP }, () => {
  const c = models.landmarks.find((l) => l.landmarkId === 'osaka-castle');
  assert.ok(c, '大阪城の設定が無い');
  // 平面形は OSM の実 footprint
  assert.equal(c.sources.footprint.source, 'osm');
  assert.equal(c.sources.footprint.id, 'way/34619038');
  // 全高は PLATEAU 実測。OSM の height タグとは別に記録して突き合わせできる
  assert.match(c.sources.totalHeightM.source, /plateau/i);
  assert.ok(c.sources.totalHeightM.canonicalId.startsWith('cg_bldg_'));
  assert.equal(c.heights.totalM, c.sources.totalHeightM.value);
  assert.ok(c.sources.totalHeightM.crossCheckOsmHeightM > 0);
  // 天守台 + 天守 = 全高
  assert.ok(Math.abs((c.heights.stoneBaseM + c.heights.towerM) - c.heights.totalM) < 0.05);
  // 様式化パラメータは note 付きで明示
  assert.ok(typeof c.sources.stylized.note === 'string' && c.sources.stylized.note.length > 10);
  assert.equal(c.sources.stylized.tiers, 5);
  // 城門は OSM の実 footprint
  assert.ok(c.sources.gates.length >= 3);
  for (const g of c.sources.gates) assert.match(g.source, /city_gate/);
});

test('[33E §検証] HD は LOD1 の箱より明確に高精細', { skip: MODEL_SKIP }, () => {
  const c = models.landmarks.find((l) => l.landmarkId === 'osaka-castle');
  const tri = c.parts.reduce((s, p) => s + p.triangleCount, 0);
  assert.ok(tri / LOD1_TRIANGLE_BASELINE >= MIN_DETAIL_RATIO, '比 ' + (tri / LOD1_TRIANGLE_BASELINE));
  // ただし PoC なので重すぎない（silhouette 重視）
  assert.ok(tri <= 20000, 'PoC としては三角形が多すぎる: ' + tri);
  // 屋根・壁・石垣・金飾りが別 material で分かれている（塗り分けできる）
  const mats = c.parts.map((p) => p.material);
  for (const m of ['stone', 'wall', 'roof', 'trim']) assert.ok(mats.includes(m), m + ' が無い');
});

test('[33E §3] 切替と抑制の設定が整合している', { skip: MODEL_SKIP }, () => {
  const c = models.landmarks.find((l) => l.landmarkId === 'osaka-castle');
  assert.ok(Array.isArray(c.suppressBuildingIds) && c.suppressBuildingIds.length === 1);
  assert.equal(c.suppressBuildingIds[0], c.pickCanonicalId, '抑制する棟と card に出す棟が違う');
  assert.ok(c.suppressExtent.maxX > c.suppressExtent.minX && c.suppressExtent.maxZ > c.suppressExtent.minZ);
  // 抑制範囲は天守の周りだけ（城域全体を消さない）
  const w = c.suppressExtent.maxX - c.suppressExtent.minX, h = c.suppressExtent.maxZ - c.suppressExtent.minZ;
  assert.ok(w < 120 && h < 120, '抑制範囲が広すぎる ' + w + 'x' + h);
});

test('[33E §3] 抑制は描画時だけ（canonical geometry / placement は触らない）', () => {
  assert.match(html, /if \(typeof LandmarkHDLayer !== 'undefined' && LandmarkHDLayer\.isSuppressedBuilding\(f\.canonicalId\)\) \{/);
  assert.match(html, /landmarkHdFp\.set\(f\.canonicalId/);      // card 用に footprint は残す
  assert.match(html, /function invalidateLandmarkHdTiles\(\) \{/);
  assert.match(html, /function buildingDataById\(canonicalId\) \{/);
  // placement policy の SUPPRESS ロジックはそのまま残っている
  assert.match(html, /if \(pp && pp\.policy === 'SUPPRESS'\) \{/);
});

test('[33E §5/§6] UI トグルと picking', () => {
  assert.match(html, /landmarkHdBtn\.id = 'landmark-hd-toggle';/);
  assert.match(html, /landmarkHdBtn\.textContent = '\[LANDMARK HD\] ON';/);
  assert.match(html, /L\.getActiveNames\(\)/);                   // 対象名を出す
  assert.match(html, /window\.__LANDMARK_HD_LAYER__\.pick\(ray\)/);
  assert.match(html, /CanonicalRuntime\.buildingDataById\(lm\.canonicalId\)/);
  // card はランドマーク名を出すが、用途や高さの中身は従来どおり
  assert.match(html, /const landmarkName = \(d && typeof d\.landmarkName === 'string' && d\.landmarkName\) \? d\.landmarkName : null;/);
  assert.match(html, /document\.getElementById\('pc-title'\)\.textContent = \(landmarkName \|\| usageDisplayName\(d\)\)/);
});

test('[33E §7] 近景でだけ読み込む / 遠景では出さない', () => {
  assert.match(html, /if \(!loaded\) \{ load\(\); return; \}/);
  assert.match(html, /return cs\.r <= cfg\.visibleDistanceM && d <= cfg\.visibleDistanceM \* LOAD_RADIUS_MUL;/);
  // camUpd から TDZ なしで呼ぶ
  assert.match(html, /if \(window\.__LANDMARK_HD_LAYER__\) window\.__LANDMARK_HD_LAYER__\.updateByCamera\(\);/);
});

test('[33E] 幾何ヘルパー: リング操作', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const r = dedupeRing(sq);
  assert.equal(r.length, 4, '閉じた重複頂点が落ちていない');
  const c = centroidOf(r);
  assert.ok(Math.abs(c[0] - 5) < 1e-6 && Math.abs(c[1] - 5) < 1e-6);
  const s = scaleRing(r, c, 2);
  assert.deepEqual(s[0].map((v) => +v.toFixed(3)), [-5, -5]);
  assert.equal(ringIsCCW(r), ringIsCCW(r), '向き判定が安定しない');
  // 面積・重心（scan 側のヘルパー）
  assert.equal(ringArea(r), 100);
  const rc = ringCentroid(r);
  assert.ok(Math.abs(rc[0] - 5) < 1e-6);
});

test('[33E] 幾何ヘルパー: prism / eave / hipRoof が妥当なメッシュを作る', () => {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const c = centroidOf(ring);
  const B = createMeshBuilder();
  B.prism('stone', ring, 0, 5, { cap: true });
  const stone = B.buf.stone;
  // 側面 4 辺 × 2 + 上面 4 = 12 三角形
  assert.equal(stone.indices.length / 3, 12);
  const ys = [];
  for (let i = 1; i < stone.positions.length; i += 3) ys.push(stone.positions[i]);
  assert.equal(Math.min(...ys), 0);
  assert.equal(Math.max(...ys), 5);
  // 軒は外へ広がる
  const outer = B.eave('roof', ring, c, 1.2, 5, 4.5, 0.3);
  assert.ok(Math.max(...outer.map((p) => p[0])) > 10, '軒が外へ出ていない');
  // 寄棟は頂部が上にある
  B.hipRoof('roof', ring, c, 5, 3);
  const ry = [];
  for (let i = 1; i < B.buf.roof.positions.length; i += 3) ry.push(B.buf.roof.positions[i]);
  assert.equal(Math.max(...ry), 8);
  // 退化三角形は除去される
  const before = B.buf.roof.indices.length;
  pruneDegenerate(B.buf);
  assert.ok(B.buf.roof.indices.length < before, '退化三角形が残っている');
  for (let i = 0; i < B.buf.roof.indices.length; i += 3) {
    const [a, b, d] = B.buf.roof.indices.slice(i, i + 3);
    assert.ok(a !== b && b !== d && a !== d);
  }
});

test('[33E] 様式化パラメータは「見て分かる」範囲に収まっている', () => {
  assert.equal(CASTLE_STYLE.tiers, 5);
  assert.ok(CASTLE_STYLE.baseRatio > 0.15 && CASTLE_STYLE.baseRatio < 0.4, '天守台の比率が極端');
  assert.ok(CASTLE_STYLE.tierTopScale > 0.3 && CASTLE_STYLE.tierTopScale < 0.8, '最上層の絞りが極端');
  assert.ok(CASTLE_STYLE.ridgeRise >= 0.1, '屋根が浅すぎると平板に見える');
  assert.ok(CASTLE_STYLE.eaveOut >= 0.15, '軒が浅いと段が読めない');
  // 城域ラインは構造物に見えない高さに保つ
  assert.ok(CASTLE_STYLE.outlineHeightM <= 0.5, '城域ラインが壁のように高い');
});

test('[33E] 調査ツールの定数', () => {
  assert.ok(SCAN_RADIUS_M >= 500);
  assert.ok(KEEP_MATCH.minHeightM >= 30 && KEEP_MATCH.radiusM <= 60);
  const p = toLocal(34.604208, 135.52502);
  assert.ok(Math.abs(p.x) < 1e-6 && Math.abs(p.z) < 1e-6, '原点が znorth-neg-v1 と違う');
});

test('[33E 検証] 実ブラウザ: 二重表示なし / 距離切替 / picking', { skip: skip('landmark-hd-qa.json') }, () => {
  const qa = rpt('landmark-hd-qa.json');
  assert.deepEqual(qa.errors, []);
  // HD ON: 天守の真上から撃った ray の最前面が HD モデル
  assert.match(qa.on.double.topDownHits[0].name, /^LandmarkHD_/);
  assert.equal(qa.on.double.topDownHits.filter((h) => h.root === 'CanonicalRuntimeRoot').length, 0, '通常建物と二重表示');
  assert.equal(qa.on.hd.suppressedBuildings.length, 1);
  // HD OFF: 元へ戻る
  assert.equal(qa.off.double.topDownHits.filter((h) => /^LandmarkHD_/.test(h.name)).length, 0);
  assert.equal(qa.off.hd.suppressedBuildings.length, 0);
  assert.ok(qa.on.pixels.distinctColors > qa.off.pixels.distinctColors, 'HD ON で見た目が変わっていない');
  assert.equal(qa.on.residual, 0);
  assert.equal(qa.off.residual, 0);
  // 距離切替
  const vis = models.landmarks[0].visibleDistanceM;
  for (const d of qa.distanceSwitch) assert.equal(d.hdVisible, d.cameraR <= vis, 'r=' + d.cameraR);
  for (const d of qa.distanceSwitch.filter((q) => q.cameraR > vis)) assert.equal(d.suppressed, 0, '遠景で抑制が残っている');
  // picking
  assert.equal(qa.pick.onScreen, true);
  assert.equal(qa.pick.hover, 'block');
  assert.equal(qa.pick.cardDisplay, 'block');
  assert.equal(qa.pick.matchesPickCanonicalId, true);
  assert.deepEqual(qa.pick.fakeValues, []);
  assert.ok(qa.pick.title.includes('大阪城'), 'card にランドマーク名が出ない: ' + qa.pick.title);
});

test('[33E §7] 実ブラウザ: 性能', { skip: skip('landmark-hd-qa.json') }, () => {
  const qa = rpt('landmark-hd-qa.json');
  for (const on of qa.performance.filter((p) => p.hd)) {
    const off = qa.performance.find((q) => !q.hd && q.site === on.site);
    assert.ok(off, on.site + ': HD OFF の計測が無い');
    assert.ok(on.fpsAverage >= off.fpsAverage * 0.9, `${on.site}: FPS ${off.fpsAverage} → ${on.fpsAverage}`);
    // HD 対象外の地点では描画コストが変わらない
    if (on.site !== 'osakacastle') {
      assert.equal(on.drawCallsAvg, off.drawCallsAvg, on.site + ': draw call が変わっている');
      assert.equal(on.trianglesAvg, off.trianglesAvg, on.site + ': 三角形数が変わっている');
    }
  }
  // 大阪城でも増分は小さい（PoC の予算内）
  const cOn = qa.performance.find((p) => p.hd && p.site === 'osakacastle');
  const cOff = qa.performance.find((p) => !p.hd && p.site === 'osakacastle');
  assert.ok(cOn.drawCallsAvg - cOff.drawCallsAvg <= 8, 'draw call の増分が大きい');
  assert.ok(cOn.trianglesAvg - cOff.trianglesAvg <= 20000, '三角形の増分が大きい');
});

test('[33E] validator が PASS', { skip: skip('landmark-hd-poc-validation.json') }, () => {
  const v = rpt('landmark-hd-poc-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.classification, 'LANDMARK_HD_POC_SUCCESS');
  assert.equal(v.layerSeparated, true);
  assert.equal(v.configComplete, true);
  assert.equal(v.provenanceOk, true);
  assert.equal(v.hdMoreDetailedThanLod1, true);
  assert.equal(v.doubleDisplayCount, 0);
  assert.equal(v.distanceSwitchWorks, true);
  assert.equal(v.pickingWorks, true);
  assert.equal(v.cardFakeValues, 0);
  assert.equal(v.buildingMutation, 0);
  assert.equal(v.roadMutation, 0);
  assert.equal(v.projectionMutation, 0);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
});

test('[33E] production / protected は変更していない', { skip: BASELINE_SKIP }, () => {
  const build = rpt('production-cutover-build.json');
  assert.ok(build && build.productionSha256);
  assert.equal(sha(PROD), build.productionSha256);
  const baseline = rpt('baselines/prod-protected-hashes.json');
  assert.ok(baseline && baseline.prot);
  assert.equal(sha(PROT), baseline.prot);
  // [Mission 35G] cutover 後は LandmarkHD のコードも production に入る。
  //   守るのは「勝手な差分が無いこと」と「開発用トグルが表示されないこと」。
  // [Mission 35H] dev だけを進めるミッションでは dev が production より先行する。
  //   常時成り立つのは「production が自分のビルド記録と一致していること」。
  assert.deepEqual(productionMatchesBuildRecord(build.productionSha256), { ok: true, now: sha(PROD), expected: build.productionSha256 });
  assert.deepEqual(devUiIsGated(['landmark-hd-toggle']), { ok: true });
});
