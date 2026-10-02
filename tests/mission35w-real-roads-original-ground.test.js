// tests/mission35w-real-roads-original-ground.test.js
// [Mission 35W §11] 地面は 35V 前へ戻し、道路は標示を足してリアル化した。
//   いちばん守りたいのは「地面が勝手にネイビーへ戻らない」ことと
//   「道路標示が道路 geometry を作り変えていない」こと。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const REPORT = path.join(ROOT, 'data', 'reports', 'mission35w-real-roads-original-ground');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
/** 35V 直前（= 地面の戻し先）の dev HTML。値を手で書かず、ここから引いて突き合わせる。 */
const BASE_REF = 'babae19';
let pre = null;
try { pre = execFileSync('git', ['show', BASE_REF + ':public/osaka_3d_buildings.ward-ux-v1.html'],
  { cwd: ROOT, maxBuffer: 1 << 28 }).toString('utf-8'); } catch { /* shallow clone 等 */ }
const preLine = (needle) => {
  const l = pre.split('\n').find((x) => x.includes(needle));
  assert.ok(l, BASE_REF + ' に無い: ' + needle);
  return l;
};

// ── §1 地面のロールバック ────────────────────────────────────────
test('[35W §1] 35V のネイビーテーマが dev から消えている', () => {
  for (const sym of ['CITY_THEME', 'cityThemeDark', 'cityTheme(', 'COL_NAVY']) {
    const used = html.split('\n').filter((l) => l.includes(sym) && !l.trimStart().startsWith('//'));
    assert.deepEqual(used, [], '35V のテーマ参照が残っている: ' + sym);
  }
  // ネイビーの実値そのものが残っていないこと
  for (const hex of ['0x0d1524', '0x18233c', '0x141d33', '0x1b2942', '#0d1524']) {
    const used = html.split('\n').filter((l) => l.includes(hex) && !l.trimStart().startsWith('//'));
    assert.deepEqual(used, [], 'ネイビーの値が残っている: ' + hex);
  }
});

test('[35W §1] 地面まわりが 35V 直前と 1 行ずつ一致する',
  { skip: !pre && 'git 履歴が引けない' }, () => {
    for (const needle of ['html,body{width:100%', '--lc-bg:', 'const MS_BG_NEUTRAL',
      'return 0.97 +', 'const LAND_COLOR_MODEL', 'const LAND_COLOR_DATA',
      'hemiSky: 0xbfd8f0, hemiGround:', 'function applyPalette()']) {
      const want = preLine(needle);
      assert.ok(html.includes(want), '35V 前と違う: ' + needle + '\n  期待: ' + want.trim());
    }
  });

test('[35W §1] 地面が明るい neutral に戻っている（背景 > 建物白）', () => {
  const bg = parseInt(html.match(/const MS_BG_NEUTRAL = (0x[0-9a-f]{6});/)[1], 16);
  const land = parseInt(html.match(/const LAND_COLOR_MODEL = (0x[0-9a-f]{6});/)[1], 16);
  const bright = (v) => ((v >> 16) & 255) + ((v >> 8) & 255) + (v & 255);
  assert.ok(bright(bg) > bright(0xeef0ec) - 6, '背景が建物白より暗い（ネイビーのまま？）');
  assert.ok(bright(land) > 600, '陸が暗い（ネイビーのまま？）');
  // body の CSS も同じ明るさ側
  const m = html.match(/html,body\{[^}]*background:(#[0-9a-fA-F]{6})[^}]*\}/);
  assert.ok(m && parseInt(m[1].slice(1), 16) > 0xd0d0d0, 'body 背景が暗い: ' + (m && m[1]));
});

test('[35W §1] ラベルの明暗反転は夜だけに戻っている', () => {
  assert.match(html, /const darkMap = night;/);
  assert.match(html, /const tk = darkMap \? 'n' : 'd';/);
});

// ── §8 35V のラベルは維持 ────────────────────────────────────────
test('[35W §8] 建物名ラベルが生きている', () => {
  assert.match(html, /const BUILDING_NAME_URL = 'map-data\/osaka-city\/derived\/building-name-labels\.json';/);
  assert.match(html, /kind: 'building'/);
  assert.match(html, /typeVisible\.building \? buildingNames : \[\]/);
  const tv = html.match(/const typeVisible = \{[^}]*\}/)[0];
  assert.ok(!/building: false/.test(tv), '建物名ラベルが既定 OFF');
  assert.match(html, /const BuildingNameStore = \(function \(\)/);
});

test('[35W §8] 駅名・町名・河川名も残っている', () => {
  for (const k of ['station', 'place', 'river', 'ward', 'park']) {
    assert.ok(new RegExp("kind === '" + k + "'").test(html), k + ' ラベルが無い');
  }
  assert.match(html, /const STATION_URL/);
  assert.match(html, /const RIVER_URL/);
});

test('[35W §8] 遠景/中景/近景の priority と collision が残っている', () => {
  assert.match(html, /const DENSITY_CAP = \{ far: \d+, mid: \d+, near: \d+ \};/);
  assert.match(html, /const BUILDING_LABEL_SHARE = \{ far: [0-9.]+, mid: [0-9.]+, near: [0-9.]+ \};/);
  assert.match(html, /const RECT_MARGIN = [0-9.]+;/);
  assert.match(html, /hiddenByCollision/);
  assert.match(html, /item\.kind === 'building' \? \(item\.tier === 'mid' \? 2\.4/);
});

// ── §2 道路のリアル化 ────────────────────────────────────────────
test('[35W §2] RoadDetailLayer がある', () => {
  assert.match(html, /const RoadDetail = \(function \(\) \{/);
  assert.match(html, /group\.name = 'RoadDetailLayer';/);
  assert.match(html, /window\.__ROAD_DETAIL_DEBUG__/);
  // canonical 側に属し、legacy の下に置いていない（legacy は隠されるので見えなくなる）
  assert.match(html, /canonicalRoot\.add\(group\);/);
  assert.match(html, /tagRuntimeOwnerRecursive\(group, RUNTIME_OWNER\.CANONICAL\);/);
});

test('[35W §2-A] 主道路と生活道路で幅が変わる', () => {
  const fn = html.match(/function halfWidth\(f\) \{[\s\S]*?\n    \}/)[0];
  assert.match(fn, /Number\(f\.lanes\)/, 'lanes を使っていない');
  for (const k of ['motorway', 'primary', 'residential', 'service']) {
    assert.ok(fn.includes(k), 'highway 種別 ' + k + ' が無い');
  }
  // 幹線のほうが広い
  const w = (k) => Number(fn.match(new RegExp("case '" + k + "':[^;]*return ([0-9.]+)"))[1]);
  assert.ok(w('primary') > w('residential'), '幹線が生活道路より狭い');
  assert.ok(w('residential') > w('service'), '生活道路が service より狭い');
});

test('[35W §2-B] 中央線・車線境界・外側線があり、一方通行には中央線を引かない', () => {
  const blk = html.match(/const RoadDetail = \(function \(\) \{[\s\S]*?\n  \}\)\(\);/)[0];
  assert.match(blk, /function dashedStrip\(/, '破線が無い');
  assert.match(blk, /if \(!f\.oneway\) \{/, '一方通行に中央線を引いてしまう');
  assert.match(blk, /const DASH = \{ on: \d+, off: \d+ \};/);
  assert.match(blk, /外側線/);
  assert.match(blk, /laneCount\(f\)/);
});

test('[35W §2-C] 交差点に停止線と（推定の）横断歩道がある', () => {
  const blk = html.match(/const RoadDetail = \(function \(\) \{[\s\S]*?\n  \}\)\(\);/)[0];
  assert.match(blk, /function junctions\(feats\)/);
  assert.match(blk, /function armsAt\(j\)/);
  assert.match(blk, /if \(e\.feats\.length >= 3\)/, '交差点の判定が無い');
  assert.match(blk, /STOP_LINE_W/);
});

test('[35W §6] 横断歩道は推定だと明記され、主要道路どうしに限っている', () => {
  const blk = html.match(/const RoadDetail = \(function \(\) \{[\s\S]*?\n  \}\)\(\);/)[0];
  assert.match(blk, /const CROSSWALK_ESTIMATED = true;/);
  assert.match(blk, /crosswalkIsEstimated: CROSSWALK_ESTIMATED/, 'debug に推定フラグが出ていない');
  assert.match(blk, /crosswalkNote:/, 'debug に推定の説明が無い');
  assert.match(blk, /crosswalkSource: 'ESTIMATED_FROM_JUNCTION_GEOMETRY'/);
  // 主要道路どうしの交差点だけ
  assert.match(blk, /majorArms\.length >= 3/);
  assert.match(blk, /const majorArms = arms\.filter\(\(a\) => a\.f\.tier === 'major'\);/);
});

test('[35W §2-D] 高架・橋は持ち上げて縁石も太くする', () => {
  const blk = html.match(/const RoadDetail = \(function \(\) \{[\s\S]*?\n  \}\)\(\);/)[0];
  assert.match(blk, /const BRIDGE_LIFT = Y\.roadBridge - Y\.road;/);
  assert.match(blk, /f\.bridge \? Y_MARK \+ BRIDGE_LIFT : Y_MARK/);
  assert.match(blk, /f\.bridge \? cfg\.edgeW \* 1\.9 : cfg\.edgeW/);
});

test('[35W §3] 道路 geometry を作り変えていない', () => {
  const blk = html.match(/const RoadDetail = \(function \(\) \{[\s\S]*?\n  \}\)\(\);/)[0];
  // centerline の座標をそのまま読むだけ。既存 road 面の生成には触らない
  assert.ok(!/pushPolygon|pushExtrude/.test(blk), '既存の道路面生成を呼んでいる');
  assert.ok(!/refined-road-surface|road-visual-v3/.test(blk), '既存の道路面データを書き換えている');
  assert.match(blk, /const SRC = BASE\.replace\(\/\\\/derived\$\/, ''\) \+ '\/roads';/);
  // 既存の道路 style は 35V 差し戻しのまま
  assert.match(html, /secondary:\s+\{ col: mix\(COL\.road, COL\.white, 0\.26\), y: Y\.road - 0\.02, opacity: 0\.82,/);
});

test('[35W §4] 1 道路 1 mesh にしていない（タイル単位で merge）', () => {
  const blk = html.match(/const RoadDetail = \(function \(\) \{[\s\S]*?\n  \}\)\(\);/)[0];
  // meshFromPositions の呼び出しは「縁石」と「白線」の 2 つだけ
  const calls = blk.match(/meshFromPositions\(/g) || [];
  assert.equal(calls.length, 2, 'タイルあたりの mesh が 2 つでない: ' + calls.length);
  assert.match(blk, /const posEdge = \[\], posMark = \[\];/, '配列へ集約していない');
  assert.match(blk, /g\.name = 'RoadDetailTile_' \+ key;/);
  // 使い終わった geometry / material を捨てている
  assert.match(blk, /o\.geometry\.dispose\(\); o\.material\.dispose\(\);/);
});

test('[35W §5] ズームで出し分けている', () => {
  const blk = html.match(/const RoadDetail = \(function \(\) \{[\s\S]*?\n  \}\)\(\);/)[0];
  assert.match(blk, /const BANDS = \{ farM: \d+, midM: \d+, veryNearM: \d+ \};/);
  assert.match(blk, /function cfgFor\(r\) \{/);
  assert.match(blk, /if \(r > BANDS\.farM\) return null;/, '遠景で標示を止めていない');
  // 遠景 < 中景 < 近景 の順に出すものが増える
  assert.match(blk, /markTiers: near \? \['major', 'mid'\] : \['major'\]/);
  assert.match(blk, /edgeTiers: veryNear \? \['major', 'mid', 'local'\]/);
  assert.match(blk, /lanes: near, junction: near,/);
  // 連続ズームで作り直し続けない
  assert.match(blk, /const STEP_RATIO = [0-9.]+;/);
  assert.match(blk, /const zoomStep = \(r\) =>/);
  // 画面から遠い所は作らない
  assert.match(blk, /reach: clamp\(r \* [0-9.]+, \d+, \d+\)/);
});

// ── §0 production / protected ───────────────────────────────────
test('[35W §0] production / protected は変更していない', () => {
  for (const [n, p] of [['production', PROD], ['protected', PROT]]) {
    const s = fs.readFileSync(p, 'utf-8');
    assert.ok(!/RoadDetailLayer/.test(s), n + ' に 35W の道路標示が入っている');
    assert.ok(!/CITY_THEME/.test(s), n + ' に 35V のテーマが入っている');
  }
  assert.ok(!/BuildingNameStore/.test(fs.readFileSync(PROT, 'utf-8')), 'protected に 35O が混入');
});

// ── §9/§12 実機 QA と前後比較 ───────────────────────────────────
test('[35W §9] 実機: 地面が明るく、道路標示が出て、ラベルが残り、JS 例外 0',
  { skip: !fs.existsSync(path.join(REPORT, 'perf-after.json')) && 'no report' }, () => {
    const a = rj(path.join(REPORT, 'perf-after.json'));
    const s = a.summary;
    assert.equal(s.jsErrors, 0, 'JS 例外がある');
    assert.equal(s.theme.theme, null, '35V のテーマがまだ生きている');
    // 背景が明るい
    const bg = s.theme.clearColor;
    assert.ok(parseInt(bg.slice(1), 16) > 0xd0d0d0, '背景が暗い: ' + bg);
    assert.ok(parseInt(s.theme.land.slice(1), 16) > 0xd0d0d0, '陸が暗い: ' + s.theme.land);
    // ラベル
    assert.equal(s.buildingLabelsEverywhere, true, '建物名が出ていない地点がある');
    assert.equal(s.stationLabelsSomewhere, true, '駅名がどこにも出ていない');
    assert.deepEqual(s.labelDataErrors, [], 'ラベルデータのエラー');
    // 道路標示が実際に出ている地点がある
    const withDetail = a.spots.filter((x) => x.roads && x.roads.roadDetail && x.roads.roadDetail.tiles > 0);
    assert.ok(withDetail.length >= 3, '道路標示が出た地点が少なすぎる: ' + withDetail.length);
    for (const x of withDetail) {
      assert.equal(x.roads.roadDetail.crosswalkIsEstimated, true, '横断歩道が推定と明示されていない');
    }
  });

test('[35W §4/§12] draw call / mesh が前後で爆増していない',
  { skip: (!fs.existsSync(path.join(REPORT, 'perf-before.json'))
    || !fs.existsSync(path.join(REPORT, 'perf-after.json'))) && 'no before/after', }, () => {
    const b = rj(path.join(REPORT, 'perf-before.json')).summary;
    const a = rj(path.join(REPORT, 'perf-after.json')).summary;
    // 道路標示はタイルあたり 2 mesh なので、増分は十数 draw call に収まるはず
    assert.ok(a.drawCallsAvg - b.drawCallsAvg <= 40,
      'draw call が増えすぎ: ' + b.drawCallsAvg + ' → ' + a.drawCallsAvg);
    assert.ok(a.trianglesAvg <= b.trianglesAvg * 1.35,
      '三角形が増えすぎ: ' + b.trianglesAvg + ' → ' + a.trianglesAvg);
    assert.ok(a.fpsAvg >= b.fpsAvg * 0.85,
      'FPS が落ちすぎ: ' + b.fpsAvg + ' → ' + a.fpsAvg);
  });
