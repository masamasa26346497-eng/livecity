// tests/mission35x-urban-detail-layer.test.js
// [Mission 35X §16] 都市ディテール。
//   いちばん守りたいのは「実データ由来であること」と
//   「既存の道路 / 公園 / ラベルを壊していないこと」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const REPORT = path.join(ROOT, 'data', 'reports', 'mission35x-urban-detail-layer');
const DATA_DIR = path.join(ROOT, 'public', 'map-data', 'osaka-city', 'urban-detail');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const layer = () => html.match(/const UrbanDetail = \(function \(\) \{[\s\S]*?\n  \}\)\(\);/)[0];

// ── §2-§11 レイヤーがある ────────────────────────────────────────
test('[35X] UrbanDetailLayer がある', () => {
  assert.match(html, /const UrbanDetail = \(function \(\) \{/);
  assert.match(html, /group\.name = 'UrbanDetailLayer';/);
  assert.match(html, /window\.__URBAN_DETAIL_DEBUG__/);
  // canonical 側に属する（legacy の下だと隠されて見えなくなる）
  const blk = layer();
  assert.match(blk, /canonicalRoot\.add\(group\);/);
  assert.match(blk, /tagRuntimeOwnerRecursive\(group, RUNTIME_OWNER\.CANONICAL\);/);
});

test('[35X] 各要素が描かれている（歩道/横断歩道/分離帯/駐車場/広場/樹/信号/POI）', () => {
  const blk = layer();
  for (const n of ['UrbanSidewalk', 'UrbanCrosswalk', 'UrbanMedian', 'UrbanParking',
    'UrbanPlaza', 'UrbanTreeTrunk', 'UrbanTreeLeaf', 'UrbanSignalPole', 'UrbanSignalLamp',
    'UrbanPoiMarker']) {
    assert.ok(blk.includes("'" + n), n + ' が無い');
  }
});

// ── §1/§17 実データであること ───────────────────────────────────
test('[35X §1] このレイヤーは OSM 実データだけで、推定は無い', () => {
  const blk = layer();
  assert.match(blk, /allFromRealData: true, estimated: false,/);
  assert.match(blk, /const SRC = BASE\.replace\(\/\\\/derived\$\/, ''\) \+ '\/urban-detail';/);
  // 推定で位置を作っていないこと（35W の横断歩道推定のような作りが無い）
  assert.ok(!/ESTIMATED|推定で/.test(blk.replace(/推定で置いたものは無い|推定で位置/g, '')),
    '推定による生成が混ざっている');
});

test('[35X §1] 生成元は OSM から抽出していて、座標を作っていない', () => {
  const b = fs.readFileSync(path.join(ROOT, 'tools', 'build-urban-detail.js'), 'utf-8');
  assert.match(b, /pbfPrimitiveStream/);
  assert.match(b, /coordinateConvention: 'znorth-neg-v1'/);
  // 既存レイヤーと同じ投影定数（勝手に変えていない）
  assert.match(b, /const CLAT = 34\.604208, CLON = 135\.52502, MPD = 111320;/);
  assert.match(b, /推定で作った要素は無い/);
});

test('[35X] 抽出データが存在し、実件数が入っている',
  { skip: !fs.existsSync(path.join(DATA_DIR, 'manifest.json')) && 'no data' }, () => {
    const m = rj(path.join(DATA_DIR, 'manifest.json'));
    assert.equal(m.coordinateConvention, 'znorth-neg-v1');
    assert.equal(m.tileSize, 2000);
    assert.ok(m.tiles.length > 50, 'タイルが少なすぎる: ' + m.tiles.length);
    // 信号・街路樹・横断歩道はいずれも実在した（§1 の監査どおり）
    assert.ok(m.counts.points.S > 5000, '信号が少なすぎる: ' + m.counts.points.S);
    assert.ok(m.counts.points.T > 5000, '街路樹が少なすぎる: ' + m.counts.points.T);
    assert.ok(m.counts.points.X > 10000, '横断歩道ノードが少なすぎる: ' + m.counts.points.X);
    assert.ok(m.counts.ways.w > 5000, '歩道が少なすぎる: ' + m.counts.ways.w);
    assert.ok(m.counts.ways.P > 5000, '駐車場が少なすぎる: ' + m.counts.ways.P);
  });

// ── §12 zoom culling ───────────────────────────────────────────
test('[35X §12] ズームで出し分けている（遠景では何も出さない）', () => {
  const blk = layer();
  assert.match(blk, /const BANDS = \{ farM: \d+, midM: \d+, veryNearM: \d+ \};/);
  assert.match(blk, /function cfgFor\(r\) \{/);
  assert.match(blk, /if \(r > BANDS\.farM\) return null;/, '遠景で止めていない');
  // §12 近景（near = 800m 以内）から 横断歩道 / 信号 / POI marker
  //   mid では縞 1 本が 0.65px になって見えないので、あえて出していない（実測に基づく）。
  assert.match(blk, /crossings: near, markers: near, signals: near,/);
  assert.match(blk, /4\.6m のポールは r=800 で約 7px あり/);
  // 遠いタイルは作らない
  assert.match(blk, /reach: clamp\(r \* [0-9.]+, \d+, \d+\)/);
  // 連続ズームで作り直し続けない
  assert.match(blk, /const STEP_RATIO = [0-9.]+;/);
});

// ── §13 パフォーマンス ─────────────────────────────────────────
test('[35X §13] 点ものは InstancedMesh、線 / 面はまとめて 1 group', () => {
  const blk = layer();
  assert.match(blk, /new THREE\.InstancedMesh\(geo, mat, places\.length\)/);
  // 1 オブジェクト 1 mesh にしていない
  assert.ok(!/for \(const pt of[\s\S]{0,200}new THREE\.Mesh\(/.test(blk), '点ごとに Mesh を作っている');
  // タイルごとではなく、見えている範囲をまとめて作る
  assert.match(blk, /function udBuildAll\(cfg, keys\) \{/);
  assert.match(blk, /g\.name = 'UrbanDetailBatch';/);
  assert.match(html, /draw call をタイル数に依存させない/);   // 設計意図はヘッダのコメントにある
  // 共有 material / geometry
  assert.match(blk, /function udShared\(\) \{/);
  assert.match(blk, /共有 geometry \/ material は捨てない/);
});

// ── §16 既存を壊していない ─────────────────────────────────────
test('[35X] 35W の道路表現が無傷', () => {
  assert.match(html, /const RoadDetail = \(function \(\) \{/);
  assert.equal((html.match(/function buildTile\(tx, tz, cfg, step\)/g) || []).length, 1);
  assert.match(html, /group\.name = 'RoadDetailLayer';/);
  // 35W 差し戻し済みの道路 style が残っている
  assert.match(html, /secondary:\s+\{ col: mix\(COL\.road, COL\.white, 0\.26\), y: Y\.road - 0\.02, opacity: 0\.82,/);
});

test('[35X §7] 公園レイヤーを変形していない', () => {
  const blk = layer();
  // 公園 geometry には触らない（このレイヤーは parks を読まない）
  assert.ok(!/parks\//.test(blk), '公園データを書き換えている');
  assert.match(html, /const PARK_AREA_LARGE_M2 = 100000, PARK_AREA_MEDIUM_M2 = 10000;/);
});

test('[35X] 地面は 35W のまま（35V のネイビーが戻っていない）', () => {
  assert.match(html, /const MS_BG_NEUTRAL = 0xf6f7f3;/);
  assert.match(html, /const LAND_COLOR_MODEL = 0xebede6;/);
  for (const sym of ['CITY_THEME', 'cityThemeDark', 'COL_NAVY']) {
    const used = html.split('\n').filter((l) => l.includes(sym) && !l.trimStart().startsWith('//'));
    assert.deepEqual(used, [], '35V のテーマが戻っている: ' + sym);
  }
});

test('[35X §10] 建物名 / 駅名 / 町名 / 河川名ラベルが生きている', () => {
  assert.match(html, /const BUILDING_NAME_URL = 'map-data\/osaka-city\/derived\/building-name-labels\.json';/);
  assert.match(html, /typeVisible\.building \? buildingNames : \[\]/);
  const tv = html.match(/const typeVisible = \{[^}]*\}/)[0];
  assert.ok(!/building: false/.test(tv), '建物名ラベルが既定 OFF');
  for (const k of ['station', 'place', 'river']) {
    assert.ok(new RegExp("kind === '" + k + "'").test(html), k + ' ラベルが無い');
  }
  // ラベルだらけにしない仕掛けも維持（§10）
  assert.match(html, /const DENSITY_CAP = \{ far: \d+, mid: \d+, near: \d+ \};/);
  assert.match(html, /const BUILDING_LABEL_SHARE = \{/);
  assert.match(html, /hiddenByCollision/);
});

test('[35X] タイル取得のレースを直してある（35W にもあった取りこぼし）', () => {
  // ensureTile が「取得中」を早期 return すると、データの無い状態で組み立てて
  //   そのタイルを永久に空として確定してしまう（35X の実機で mid band が空になった）
  assert.ok(!/if \(data\.has\(key\) \|\| loading\.has\(key\)\) return;/.test(html),
    '早期 return のままのレイヤーが残っている');
  assert.match(html, /const inflight = loading\.get\(key\);/);
  assert.match(html, /const inflight = udLoading\.get\(key\);/);
  assert.match(html, /if \(!data\.has\(key\)\) return;          \/\/ \[Mission 35X\] まだ取得できていない。確定させない/);
});

// ── §0 production / protected ──────────────────────────────────
test('[35X §0] production / protected は変更していない', () => {
  for (const [n, p] of [['production', PROD], ['protected', PROT]]) {
    const s = fs.readFileSync(p, 'utf-8');
    assert.ok(!/UrbanDetailLayer/.test(s), n + ' に 35X が入っている');
    assert.ok(!/RoadDetailLayer/.test(s), n + ' に 35W が入っている');
  }
});

// ── §14/§17 実機 QA と前後比較 ─────────────────────────────────
test('[35X §14] 実機: 要素が出ていて、ラベルが残り、JS 例外 0',
  { skip: !fs.existsSync(path.join(REPORT, 'perf-after.json')) && 'no report' }, () => {
    const a = rj(path.join(REPORT, 'perf-after.json'));
    const s = a.summary;
    assert.equal(s.jsErrors, 0, 'JS 例外がある');
    assert.equal(s.buildingLabelsEverywhere, true, '建物名が出ていない地点がある');
    assert.equal(s.stationLabelsSomewhere, true, '駅名がどこにも出ていない');
    assert.deepEqual(s.labelDataErrors, [], 'ラベルデータのエラー');
    // 都市ディテールが実際に出ている地点がある
    const withUd = a.spots.filter((x) => x.roads && x.roads.urbanDetail && x.roads.urbanDetail.tiles > 0);
    assert.ok(withUd.length >= 4, '都市ディテールが出た地点が少なすぎる: ' + withUd.length);
    for (const x of withUd) {
      assert.equal(x.roads.urbanDetail.allFromRealData, true, '実データ由来と明示されていない');
      assert.equal(x.roads.urbanDetail.estimated, false, '推定が混ざっている');
      // §13 まとめて 1 group なので draw call はタイル数に依存しない
      assert.ok(x.roads.urbanDetail.drawCalls <= 12,
        x.id + ' の都市ディテール draw call が多すぎる: ' + x.roads.urbanDetail.drawCalls);
    }
    // 近景では信号・marker が出ている
    assert.ok(a.spots.some((x) => x.roads.urbanDetail && x.roads.urbanDetail.signals > 0), '信号がどこにも出ていない');
    assert.ok(a.spots.some((x) => x.roads.urbanDetail && x.roads.urbanDetail.trees > 0), '街路樹がどこにも出ていない');
  });

test('[35X §13] draw call / FPS が目標内',
  { skip: (!fs.existsSync(path.join(REPORT, 'perf-before.json'))
    || !fs.existsSync(path.join(REPORT, 'perf-after.json'))) && 'no before/after' }, () => {
    const b = rj(path.join(REPORT, 'perf-before.json')).summary;
    const a = rj(path.join(REPORT, 'perf-after.json')).summary;
    // §13 目標: draw call 増加 20% 以内 / FPS 低下 10% 以内
    const dcRatio = a.drawCallsAvg / b.drawCallsAvg;
    assert.ok(dcRatio <= 1.20, 'draw call が 20% 超で増えた: ' + b.drawCallsAvg + ' → ' + a.drawCallsAvg);
    assert.ok(a.fpsAvg >= b.fpsAvg * 0.90, 'FPS が 10% 超で落ちた: ' + b.fpsAvg + ' → ' + a.fpsAvg);
  });
