// tests/label-enrichment.test.js
// [Mission 33C] 地名（北部含む）・駅・ランドマーク・河川ラベルの拡充
//   - labels/ の派生データ（provenance 付き）
//   - ランドマークの採否ルール（案内板・別施設を拾わない）
//   - 河川ラベル（代表点・主軸・重要度）
//   - HTML 側の zoom band / 優先度 / 回転 / トグル
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  placeScore, normalizeLandmarkName, landmarkTier, principalAngle, buildLandmarks,
  LANDMARK_NAME_BLOCKLIST, TIER_ZOOM_BAND, PLACE_MAJOR_TOP_N,
} from '../tools/build-label-datasets.js';
import { baseTownName, createTownAggregator } from '../tools/build-plateau-place-labels.js';
import { CANONICAL_STATION_COUNT } from '../tools/lib/canonical-baseline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const label = (n) => rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'labels', n));
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');
const places = label('place-labels.json');
const landmarks = label('landmark-labels.json');
const rivers = label('river-labels.json');
const stations = label('station-labels.json');

test('[33C §3/§5] 北部の地名は PLATEAU の町丁目名称から作られている', { skip: !places && 'no place-labels' }, () => {
  assert.equal(baseTownName('東淡路一丁目'), '東淡路');
  assert.equal(baseTownName('上新庄3丁目'), '上新庄');
  // 集計器: 面積加重で代表点を出し、丁目数と建物数を数える
  const agg = createTownAggregator();
  agg.add({ town: '甲乙一丁目', ward: '北区', wardId: 'kita', x: 0, z: 0, areaM2: 100 });
  agg.add({ town: '甲乙二丁目', ward: '北区', wardId: 'kita', x: 100, z: 0, areaM2: 100 });
  const r = agg.result();
  assert.equal(r.length, 1);
  assert.equal(r[0].name, '甲乙');
  assert.equal(r[0].buildings, 2);
  assert.equal(r[0].chomeCount, 2);
  assert.equal(r[0].x, 50);

  // 実データ: 北緯 34.735 相当（z < -14550）より北に地名がある。
  //   33C の時点では OSM の place ノードが北部に存在しなかった（旧 PBF が緯度 34.73 で
  //   切れていたため）ので、北部は PLATEAU 町丁目由来に限られていた。
  //   [Mission 35F] source を広域 PBF へ入れ替えて OSM 側にも北部の地名が入った。
  //   守るべき性質は「北部に地名が出ること」と「出所が記録されていること」であって、
  //   出所が PLATEAU であること自体ではない。
  const north = places.places.filter((p) => p.z < -14550);
  assert.ok(north.length >= 5, `北部の地名 ${north.length} 件`);
  assert.ok(north.every((p) => p.source === 'plateau-town' || p.source === 'osm-place'),
    '北部の地名に出所不明のものがある');
  for (const n of ['淡路', '東三国', '上新庄']) {
    const p = places.places.find((q) => q.name === n);
    assert.ok(p, `${n} が無い`);
    assert.ok(p.source === 'plateau-town' || p.source === 'osm-place', `${n} の出所が不明`);
  }
  // provenance
  assert.ok(places.places.every((p) => p.source && Array.isArray(p.sources) && p.id));
  assert.equal(places.places.filter((p) => p.importance === 'major').length, PLACE_MAJOR_TOP_N);
});

test('[33C §5] 地名スコア: 規模 + 周辺駅数 + 広がり', () => {
  const osm = { source: 'osm-place', chomeCount: 5, spreadM: 400 };
  const plateau = { source: 'plateau-town', buildings: 1500, spreadM: 400 };
  assert.ok(placeScore(osm, 0) > 0);
  // 駅が多いほど高い
  assert.ok(placeScore(osm, 3) > placeScore(osm, 0));
  // source をまたいでも同じスケール（建物 1,500 棟 ≒ 丁目 10 相当で頭打ち）
  assert.ok(Math.abs(placeScore(plateau, 0) - placeScore({ source: 'osm-place', chomeCount: 10, spreadM: 400 }, 0)) < 0.01);
});

test('[33C §4] 駅は canonical rail をそのまま使う（ハードコード追加なし）', { skip: !stations && 'no station-labels' }, () => {
  assert.equal(stations.stations.length, CANONICAL_STATION_COUNT);
  assert.ok(stations.stations.every((s) => s.source === 'canonical-rail-stations'));
  // 33C の時点では北部（z < -14550）に駅が 1 つも無く、それは旧 PBF が緯度 34.73 で
  //   切れていたための「元データの制約」だった。
  //   [Mission 35F] 広域 PBF へ入れ替えて北部の駅が入った。ここで守るのは
  //   「canonical rail をそのまま使い、駅名を足していないこと」なので、
  //   件数の一致（上の行）と出所（この行）で見る。北部に出ることも確かめる。
  const north = stations.stations.filter((s) => s.z < -14550);
  assert.ok(north.length >= 10, `北部の駅 ${north.length} 件（35F 以降は出るはず）`);
  for (const n of ['東淀川', '淡路', '下新庄', '上新庄']) {
    assert.ok(north.some((s) => s.name === n), `${n} が無い`);
  }
});

test('[33C §6/§7/§8] ランドマーク: 実データで確認できたものだけ・tier と provenance 付き', { skip: !landmarks && 'no landmark-labels' }, () => {
  const names = landmarks.landmarks.map((l) => l.name);
  for (const n of ['グラングリーン大阪', 'うめきた公園', '大阪城', 'あべのハルカス', '通天閣', '京セラドーム大阪', '大阪中之島美術館', 'なんばパークス']) {
    assert.ok(names.includes(n), `${n} が無い`);
  }
  // 紛らわしい名前は採らない
  for (const n of LANDMARK_NAME_BLOCKLIST) assert.ok(!names.includes(n), `${n} を採用している`);
  assert.ok(!names.includes('万博記念公園'), '別施設（鶴見緑地）を万博記念公園として採用している');
  // provenance と階層
  for (const l of landmarks.landmarks) {
    assert.ok(l.source && l.sourceId, l.name);
    assert.ok(['S', 'A', 'B'].includes(l.tier), l.name);
    assert.equal(l.zoomBand, TIER_ZOOM_BAND[l.tier], l.name);
    assert.ok(Number.isFinite(l.x) && Number.isFinite(l.z));
  }
  assert.equal(landmarkTier('大阪城'), 'S');
  assert.equal(landmarkTier('海遊館'), 'A');
  assert.equal(landmarkTier('HEP FIVE'), 'B');
  // 名前の正規化（別館だけ代表名へ寄せる）
  assert.equal(normalizeLandmarkName('グラングリーン大阪 北館', 'グラングリーン大阪'), 'グラングリーン大阪');
  assert.equal(normalizeLandmarkName('うめきた公園 ノースパーク', 'うめきた公園'), 'うめきた公園');
  assert.equal(normalizeLandmarkName('万博記念公園 鶴見緑地', '万博記念公園'), null);
  assert.equal(normalizeLandmarkName('あべのハルカス美術館', 'あべのハルカス'), null);
});

test('[33C §6] buildLandmarks: 案内板・ホテル・記念碑は採らない', () => {
  const canon = { landmarks: [{ id: 'osaka-castle', name: '大阪城', x: 74, z: -9251, category: 'HISTORIC', source: { osm: 'way/1' } }] };
  const scan = { landmarkCandidates: {
    通天閣: [
      { name: '通天閣', type: 'way', id: 2, x: -1716, z: -5383, tags: { man_made: 'tower', tourism: 'viewpoint' } },
      { name: '通天閣本通商店街', type: 'way', id: 3, x: -1700, z: -5300, tags: { shop: 'mall' } },
    ],
    海遊館: [{ name: '海遊館前の案内板', type: 'node', id: 4, x: -8763, z: -5672, tags: { tourism: 'information' } }],
  } };
  const out = buildLandmarks(canon, scan);
  const names = out.map((l) => l.name);
  assert.ok(names.includes('大阪城') && names.includes('通天閣'));
  assert.ok(!names.includes('通天閣本通商店街'), '別施設を拾っている');
  assert.ok(!names.includes('海遊館前の案内板'), '案内板を拾っている');
  assert.equal(out.find((l) => l.name === '通天閣').tier, 'S');
});

test('[33C §10/§11] 河川ラベル: 名称付き水域から代表点と主軸', { skip: !rivers && 'no river-labels' }, () => {
  const names = rivers.rivers.map((r) => r.name);
  for (const n of ['淀川', '大川', '堂島川', '土佐堀川', '道頓堀川', '木津川', '安治川', '尻無川', '寝屋川', '平野川', '神崎川']) {
    assert.ok(names.includes(n), `${n} が無い`);
  }
  assert.ok(!names.includes('万代池'), '池を河川ラベルにしている');
  for (const r of rivers.rivers) {
    assert.ok(Number.isFinite(r.angle) && Math.abs(r.angle) <= Math.PI, r.name);
    assert.ok(['major', 'medium', 'local'].includes(r.importance), r.name);
    assert.equal(r.source, 'canonical-water');
  }
  assert.equal(rivers.rivers.find((r) => r.name === '淀川').importance, 'major');
  // 主軸: 東西に伸びる帯は角度 0 付近、南北に伸びる帯は ±π/2 付近
  const ew = principalAngle([[0, 0], [1000, 0], [1000, 50], [0, 50]]);
  const ns = principalAngle([[0, 0], [50, 0], [50, 1000], [0, 1000]]);
  assert.ok(Math.abs(ew) < 0.1, `東西 ${ew}`);
  assert.ok(Math.abs(Math.abs(ns) - Math.PI / 2) < 0.1, `南北 ${ns}`);
});

test('[33C §11/§13/§14] HTML: 河川ラベルの向き・zoom band・優先度', () => {
  assert.match(html, /const RIVER_URL = 'map-data\/osaka-city\/labels\/river-labels\.json';/);
  assert.match(html, /const PLACE_URL = 'map-data\/osaka-city\/labels\/place-labels\.json';/);
  assert.match(html, /const LANDMARK_URL = 'map-data\/osaka-city\/labels\/landmark-labels\.json';/);
  // [Mission 35K §2/§4] 駅は事業者つき・統合済みの derived/station-index.json へ移した
  //   （station-labels.json 自体は 33C のまま残っており、上のテストで検証している）。
  assert.match(html, /const STATION_URL = 'map-data\/osaka-city\/derived\/station-index\.json';/);
  // tier による band（S=遠景 / A=中景 / B=近景）
  assert.match(html, /if \(item\.kind === 'landmark'\) return item\.tier === 'S' \? true : \(item\.tier === 'A' \? b !== 'far' : b === 'near'\);/);
  // 河川の band と、引き画面での優先度アップ
  assert.match(html, /if \(item\.kind === 'river'\) return item\.importance === 'major'/);
  assert.match(html, /: item\.kind === 'river' \? \(item\.importance === 'major' \? \(b === 'far' \? 1\.2 : 3\.5\)/);
  // 流路に沿わせる（カメラを回しても追従）
  assert.match(html, /function screenAngleOf\(item\) \{/);
  assert.match(html, /if \(c\.item\.kind === 'river'\) rec\.sprite\.material\.rotation = screenAngleOf\(c\.item\);/);
  // §12 河川の色（青〜青緑・白ハロー）
  // [Mission 35V] 反転の条件が night から darkMap（夜 + ネイビー地面）へ広がった。
  //   河川名を「暗い地図では明るい青、明るい地図では濃い青緑」にする意図は変えていない。
  assert.match(html, /text: inkOnDark \? '#9fd8ef' : '#2f7f95',/);
  // §19 camera 行列の更新は維持
  assert.match(html, /camera\.updateMatrixWorld\(\);/);
  // §20 旧 StationLabelLayer は休止のまま
  assert.doesNotMatch(html, /^StationLabelLayer\.show\(\);/m);
});

test('[33C §25] 河川名トグルが通常パネルにある', () => {
  assert.match(html, /\{ key: 'riverLabels', label: '河川名', checked: true \}/);
  assert.match(html, /if \(key === 'riverLabels'\) \{ if \(typeof CityLabelLayer !== 'undefined'\) CityLabelLayer\.setTypeVisible\('river', on\); return; \}/);
});

test('[33C §28] 実ブラウザ QA: 11 地点 + City Mode', { skip: skip('label-enrichment-qa.json') }, () => {
  const qa = rpt('label-enrichment-qa.json');
  const after = qa.phases.after;
  assert.ok(after, 'phase=after が無い');
  assert.equal(after.sites.length, 11);
  for (const s of after.sites) {
    assert.ok(s.labels.city.visible >= 1, `${s.site}: ラベルが出ていない`);
    assert.equal(s.labels.overlapPairs, 0, `${s.site}: 重なり ${s.labels.overlapPairs}`);
    assert.equal(s.labels.severeOverlaps, 0, s.site);
    assert.equal(s.residual, 0, s.site);
  }
  // 北部で地名が出る
  for (const id of ['shinosaka', 'awaji']) {
    const s = after.sites.find((q) => q.site === id);
    assert.ok(s.labels.city.visiblePlaces >= 1, `${id}: 地名が出ていない`);
  }
  // 河川名がどこかで出ている
  assert.ok(after.sites.some((s) => (s.labels.city.visibleRivers || 0) >= 1), '河川名が 1 つも出ていない');
  assert.deepEqual(after.errors, []);
});

test('[33C §27] validator が PASS', { skip: skip('label-enrichment-validation.json') }, () => {
  const v = rpt('label-enrichment-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.classification, 'OSAKA_LABEL_ENRICHMENT_SUCCESS');
  for (const k of ['buildingMutation', 'roadMutation', 'waterMutation', 'projectionMutation', 'nearOverlapCount']) {
    assert.equal(v[k], 0, k);
  }
  assert.equal(v.cityLabelLayerActive, true);
  assert.equal(v.northStationCoverageImproved, true);
  assert.equal(v.landmarkCountIncreased, true);
  assert.equal(v.riverLabelsCreated, true);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
});
