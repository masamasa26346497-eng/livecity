// tests/city-labels-production-cutover.test.js
// [Mission 33B] ラベル + 明るい配色の production cutover
//   production は dev から生成した成果物であり、33A で確定したラベル規則・配色が
//   そのまま入っていること（production だけ件数やしきい値を変えていないこと）を守る。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PALETTE_33A, LABEL_RULES_33A } from '../tools/validate/city-labels-production-cutover.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const prod = fs.readFileSync(PROD, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('[33B §1/§2] production は dev から生成したビルド成果物（profile だけが違う）', () => {
  const build = rpt('production-cutover-build.json');
  assert.ok(build && build.productionSha256, 'ビルド記録が無い');
  assert.equal(sha(PROD), build.productionSha256);
  assert.match(prod, /const LIVECITY_BUILD_PROFILE = 'production';/);
  // 次のミッションで dev が先行することはある（33C）。その間は「production = 最後のビルド成果物」だけを守る。
  if (sha(DEV) === build.devSha256) {
    const a = fs.readFileSync(DEV, 'utf-8').split(/\r?\n/), b = prod.split(/\r?\n/);
    assert.equal(a.length, b.length);
    assert.equal(a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null).length, 1);
  }
});

test('[33B §5/§6/§7] 33A のラベル規則が production でそのまま使われている', () => {
  for (const re of LABEL_RULES_33A) assert.match(prod, re, String(re));
  // ラベル層とデータ源
  assert.match(prod, /const CityLabelLayer = \(function \(\) \{/);
  // [Mission 33C] ラベルのデータ源は labels/ へ整理された（33A の規則自体は不変）。
  //   [Mission 35G] cutover で production にも反映された。
  assert.match(prod, /const PLACE_URL = 'map-data\/osaka-city\/labels\/place-labels\.json';/);
  assert.match(prod, /const ANCHOR_URL = 'map-data\/osaka-city\/derived\/map-label-anchors\.json';/);
  assert.match(prod, /const STATION_URL = 'map-data\/osaka-city\/labels\/station-labels\.json';/);
  assert.match(prod, /CityLabelLayer\.show\(\);   \/\/ 通常表示に統合/);
  // [33B] カメラ行列を更新してから投影する（別地点のラベルが残る不具合の回帰）
  assert.match(prod, /camera\.updateMatrixWorld\(\);[\s\S]{0,200}前回の配置をいったん全部消す/);
});

test('[33B §8] 33A の配色が production でそのまま使われている', () => {
  for (const re of PALETTE_33A) assert.match(prod, re, String(re));
});

test('[33B §4] 旧 StationLabelLayer はコードを残し、通常表示では使わない', () => {
  assert.match(prod, /const StationLabelLayer = \(function \(\) \{/);
  assert.match(prod, /window\.__STATION_LABEL_DEBUG__/);
  assert.match(prod, /function clusterStations\(stations, radiusM, groupMergeM, sameNameMergeM\)/);
  assert.doesNotMatch(prod, /^StationLabelLayer\.show\(\);/m);
  // [33B] rebuild() が scene へ戻さない / update() が休止する（駅 tile 更新のたびに旧ラベルが復活していた）
  assert.match(prod, /if \(allowShow\) scene\.add\(group\);/);
  assert.match(prod, /if \(!allowShow\) return;   \/\/ \[Mission 33B\]/);
  assert.match(prod, /show\(\) \{ allowShow = true;/);
});

test('[33B §12] production では開発用 UI が隠れ、通常 UI は残る', () => {
  for (const id of ['canonical-runtime-status', 'ward-diag', 'perf-hud', 'fps']) {
    assert.match(prod, new RegExp(`html\\[data-livecity-build="production"\\] #${id}`), id);
  }
  assert.match(prod, /\{ key: 'placeLabels', label: '地名', checked: true \}/);
  assert.match(prod, /\{ key: 'landmarkLabels', label: '施設名', checked: true \}/);
});

test('[33B §24] protected は不変', () => {
  const baseline = rpt('baselines/prod-protected-hashes.json');
  assert.ok(baseline && baseline.prot);
  assert.equal(sha(PROT), baseline.prot);
});

test('[33B §18/§19/§23] 実ブラウザ QA（production）', { skip: skip('city-labels-production-qa.json') }, () => {
  const qa = rpt('city-labels-production-qa.json');
  const after = qa.phases.after;
  assert.ok(after, 'phase=after が無い');
  assert.equal(after.sites.length, 6);
  for (const s of after.sites) {
    assert.ok(s.labels.city && s.labels.city.loaded, `${s.site}: ラベルデータ未読込`);
    assert.equal(s.labels.severeOverlaps, 0, `${s.site}: 完全重複`);
    assert.ok(s.labels.overlapPairs <= 2, `${s.site}: 重なり ${s.labels.overlapPairs} 組`);
    assert.equal(s.residual, 0, s.site);
    assert.equal(s.labels.stationLayerInScene, false, `${s.site}: 旧 StationLabelLayer が scene に入っている`);
    assert.ok(!s.labels.labelPx || s.labels.labelPx.min >= 8, `${s.site}: 読めない大きさのラベルがある`);
    // §19 ラベルがクリック・hover を妨げない
    assert.ok(s.picking, `${s.site}: picking 記録が無い`);
    assert.equal(s.picking.hover, 'block', `${s.site}: hover しない`);
    assert.equal(s.picking.pickedExpected, true, `${s.site}: 狙った建物を選べない`);
    assert.equal(s.picking.cardDisplay, 'block', `${s.site}: card が出ない`);
    assert.deepEqual(s.picking.fakeValues, [], `${s.site}: card に仮値`);
  }
  // 駅名 + 地名/施設が揃う地点（北部はデータが無い）
  const rich = after.sites.filter((s) => s.labels.city.visibleStations >= 1
    && (s.labels.city.visiblePlaces + s.labels.city.visibleLandmarks) >= 1);
  assert.ok(rich.length >= 5, `駅名 + 地名/施設が出た地点 ${rich.length}/6`);
  // §16 City Mode
  assert.equal(after.cityMode.labels.severeOverlaps, 0, 'City Mode に完全重複');
  assert.equal(after.cityMode.labels.stationLayerInScene, false);
  assert.ok(after.cityMode.labels.labelPx.min >= 8, 'City Mode に読めない大きさのラベル');
  // §19 検索
  assert.equal(after.search.msgShown, false);
  assert.ok(after.search.distanceM <= 50);
  // §23 fetch 監査
  for (const f of after.fetchAudit.forbidden) assert.equal(f.count, 0, f.id);
  assert.ok(after.fetchAudit.v2nBuildingRequests > 0);
  assert.ok(after.fetchAudit.labelDataRequests > 0);
  // §22 runtime 構成
  assert.equal(after.finalSelfCheck.buildingMode, 'V2_NEW_OSM');
  assert.equal(after.finalSelfCheck.roadMode, 'ROAD_V3');
  assert.equal(after.finalSelfCheck.rawGsiEdge, false);
  assert.equal(after.finalSelfCheck.buildingCount, 600764);
  assert.deepEqual(after.errors, []);
  // §17 性能 4 条件
  assert.equal(after.performance.length, 4);
});

test('[33B §25] validator が PASS', { skip: skip('city-labels-production-cutover-validation.json') }, () => {
  const v = rpt('city-labels-production-cutover-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.classification, 'CITY_LABELS_PALETTE_PRODUCTION_SUCCESS');
  assert.equal(v.productionIsGeneratedFromDev, true);
  assert.equal(v.productionLabelsActive, true);
  assert.equal(v.labelSevereOverlaps, 0);
  assert.equal(v.labelToggleWorks, true);
  assert.equal(v.labelRulesSame, true);
  assert.equal(v.productionPalette, true);
  assert.equal(v.pickingRegression, false);
  assert.equal(v.searchRegression, false);
  assert.equal(v.fakeValuesInCard, 0);
  assert.equal(v.v1ProductionFetch, 0);
  assert.equal(v.oldOsmProductionFetch, 0);
  assert.equal(v.legacyResidual, 0);
  assert.equal(v.protectedModified, false);
  assert.equal(v.buildingGeometryMutation, 0);
  assert.equal(v.roadV3Mutation, 0);
  assert.equal(v.projectionMutation, 0);
});
