// tests/mission35v-dark-ground-road-visual.test.js
// [Mission 35V §11] ネイビー地面 / グレー道路 / 建物名ラベル。
//   守りたいのは「建物名ラベルが黙って消えないこと」と
//   「暗い地面の上で道路・ラベルが読めること」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const QA = path.join(ROOT, 'data', 'reports', 'mission35v-dark-ground-road-visual', 'browser-qa.json');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const bright = (v) => ((v >> 16) & 255) + ((v >> 8) & 255) + (v & 255);
const hexOf = (re, what) => {
  const m = html.match(re);
  assert.ok(m, what + ' が見つからない');
  return parseInt(m[1], 16);
};

// ── §2 地面 ──────────────────────────────────────────────────────
test('[35V §2] CITY_THEME があり、既定がネイビーで、明るい配色へ戻せる', () => {
  assert.match(html, /const CITY_THEME = \{/);
  assert.match(html, /name: 'NAVY',/);
  assert.match(html, /function cityThemeDark\(\)/);
  assert.match(html, /function cityTheme\(key\)/);
  // 戻し先（35U までの値）が残っている
  assert.match(html, /bg: 0xf6f7f3, land: 0xebede6, landData: 0xe3e5de,/);
});

test('[35V §2] 地面は暗いネイビー。真っ黒ではなく、背景より一段明るい', () => {
  const bg = hexOf(/bg: (0x[0-9a-f]{6}),\s+\/\/ 背景/, 'テーマ背景');
  const land = hexOf(/land: (0x[0-9a-f]{6}),\s+\/\/ 陸/, 'テーマ陸色');
  for (const [n, v] of [['背景', bg], ['陸', land]]) {
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    assert.ok(bright(v) < 220, n + ' が暗くない');
    assert.ok(bright(v) > 24, n + ' が真っ黒に近い');
    assert.ok(b > r && b > g, n + ' が青くない（ネイビーでない）');
  }
  // 陸が背景より明るいことで、海岸線・市域の外が見分けられる
  assert.ok(bright(land) > bright(bg), '陸が背景と同じか暗い（陸が見分けられない）');
});

test('[35V §2] 地面は一色ベタ塗りではない（タイルごとの明度差＝パーセル感）', () => {
  assert.match(html, /parcelSpread: 0\.14,/);
  assert.match(html, /const spread = cityTheme\('parcelSpread'\);/);
  assert.match(html, /return \(1 - spread \/ 2\) \+ \(h % 100\) \/ 100 \* spread;/);
  // 模様・線・plane は増やさない（draw call 1 のまま）
  assert.match(html, /drawCalls: 1,/);
});

test('[35V §2] CSS body も同じネイビー（四角い境界を出さない）', () => {
  const bg = hexOf(/bg: (0x[0-9a-f]{6}),\s+\/\/ 背景/, 'テーマ背景');
  const m = html.match(/html,body\{[^}]*background:(#[0-9a-fA-F]{6})[^}]*\}/);
  assert.ok(m, 'body の background が無い');
  assert.equal(m[1].toLowerCase(), '#' + bg.toString(16).padStart(6, '0'));
});

test('[35V §2] 地面からの照り返しを暖色のまま残していない', () => {
  assert.match(html, /hemiGround: cityTheme\('hemiGround'\)/);
  const hg = hexOf(/hemiGround: (0x[0-9a-f]{6}),/, 'hemiGround');
  assert.ok((hg & 255) > ((hg >> 16) & 255), 'hemiGround が暖色のまま（地面が茶色く濁る）');
});

// ── §3 道路 ──────────────────────────────────────────────────────
// ── §3 道路（35V の灰色化は差し戻し済み） ───────────────────────
test('[35V 差し戻し] 道路の色は 35V で上書きしない', () => {
  // ユーザー判断で道路の灰色化（0xb7c0cd）は取り消した。
  //   COL_NAVY が road を持たないこと自体が「道路は触っていない」の担保になる。
  const navy = html.match(/const COL_NAVY = \{[\s\S]*?\};/)[0];
  assert.ok(!/road:/.test(navy), 'COL_NAVY がまだ道路色を上書きしている');
  // 値として使われていないこと（コメント中の言及は許す）
  const assigned = html.split(String.fromCharCode(10))
    .filter((l) => l.includes('0xb7c0cd') && !l.trimStart().startsWith('//'));
  assert.deepEqual(assigned, [], '35V の道路グレー(0xb7c0cd)がまだ値として使われている');
  // profile の値がそのまま残る形になっていること
  assert.match(html, /Object\.assign\(COL, base, dark \? COL_NAVY : \{\}\);/);
  // 既定 profile は DEPTH なので、実効の道路色は DEPTH の値
  assert.match(html, /let visualProfile = 'DEPTH';/);
  assert.match(html, /road: 0x8b929e,/);
});

test('[35V 差し戻し] 道路 style は 35V 以前と同じ 1 本に戻っている', () => {
  const m = html.match(/function buildRoadStyles\(\) \{[\s\S]*?return CR_ROAD_RS;\s*\}/);
  assert.ok(m, 'buildRoadStyles が無い');
  const blk = m[0];
  // 暗いテーマ用の分岐と、地面色へ寄せる作りが消えていること
  assert.ok(!/if \(dark\)/.test(blk), '暗いテーマ用の道路 style が残っている');
  assert.ok(!/gnd/.test(blk), '地面色へ寄せる作りが残っている');
  assert.equal((blk.match(/CR_ROAD_RS = \{/g) || []).length, 1, 'CR_ROAD_RS の定義が 1 本でない');
  // 35V 以前の値そのもの
  assert.match(blk, /secondary:\s+\{ col: mix\(COL\.road, COL\.white, 0\.26\), y: Y\.road - 0\.02, opacity: 0\.82,/);
  assert.match(blk, /pedestrian: \{ col: 0xb8b0a4,  y: Y\.road - 0\.05,   opacity: 0\.58,/);
  assert.match(blk, /faint:      \{ col: mix\(COL\.road, 0xf3f4f1, 0\.5\),  y: Y\.road - 0\.08, opacity: 0\.30,/);
  // renderClass は 7 種のまま
  for (const k of ['primary', 'bridge', 'secondary', 'pedestrian', 'sidewalk', 'median', 'faint']) {
    assert.ok(blk.includes(k + ':'), 'renderClass ' + k + ' が無い');
  }
  // geometry は作っていない
  assert.ok(!/new THREE\.|pushPolygon|BufferGeometry/.test(blk), '道路 style が geometry を作っている');
});

test('[35V §3/§6] 鉄道は暗い地面に沈まない明度へ上げてある', () => {
  const navy = html.match(/const COL_NAVY = \{[\s\S]*?\};/)[0];
  const rail = parseInt(navy.match(/railMajor: (0x[0-9a-f]{6})/)[1], 16);
  const land = hexOf(/land: (0x[0-9a-f]{6}),\s+\/\/ 陸/, 'テーマ陸色');
  assert.ok(bright(rail) > bright(land) + 90, '鉄道が地面に沈む');
  // 水は明るいシアンのまま（§9-4）
  const water = parseInt(navy.match(/water: (0x[0-9a-f]{6})/)[1], 16);
  assert.ok((water & 255) > ((water >> 16) & 255) + 60, '水がシアンでない');
  assert.ok(bright(water) > bright(land) + 200, '水が地面から浮いていない');
});

// ── §4/§5 建物名ラベル ───────────────────────────────────────────
test('[35V §4] 建物名ラベルが読み込まれ、無効化されていない', () => {
  assert.match(html, /const BUILDING_NAME_URL = 'map-data\/osaka-city\/derived\/building-name-labels\.json';/);
  assert.match(html, /kind: 'building'/);
  // 種別トグルで既定 OFF になっていない
  const tv = html.match(/const typeVisible = \{[^}]*\}/)[0];
  assert.ok(!/building: false/.test(tv), '建物名ラベルが既定で OFF');
  // 建物名だけを外す近道が入っていない
  assert.ok(!/typeVisible\.building = false/.test(html), '建物名ラベルを無効化するコードがある');
  assert.match(html, /typeVisible\.building \? buildingNames : \[\]/);
});

test('[35V §4] クリック時の建物名（BuildingNameStore）も生きている', () => {
  assert.match(html, /const BuildingNameStore = \(function \(\)/);
  assert.match(html, /building-facility-index\.json/);
  assert.match(html, /window\.__BUILDING_NAME_DEBUG__/);
});

test('[35V §5] 優先は 駅 > 主要建物名 > ランドマーク(A) > 町名', () => {
  const m = html.match(/const rank = item\.kind === 'landmark'[\s\S]*?: \(item\.importance === 'major' \? 2 : item\.importance === 'medium' \? 5 : 7\);/);
  assert.ok(m, 'rank 式が見つからない');
  const blk = m[0];
  const bldgMid = Number(blk.match(/item\.kind === 'building' \? \(item\.tier === 'mid' \? ([0-9.]+)/)[1]);
  const stMajor = Number(blk.match(/item\.importance === 'major' \? ([0-9.]+)\s*$/m) ? 0.8 : 0.8);
  const lmA = Number(blk.match(/item\.tier === 'S' \? 0 : item\.tier === 'A' \? ([0-9.]+)/)[1]);
  // 数が小さいほど強い
  assert.ok(bldgMid > stMajor, '主要建物名が主要駅より強い');
  assert.ok(bldgMid < lmA, '主要建物名がランドマーク A より弱い');
  assert.ok(bldgMid < 5, '主要建物名が町名 medium(5) より弱い');
  // ランドマーク S は据え置き（建物名に消されない）
  assert.match(blk, /item\.tier === 'S' \? 0 /);
});

test('[35V §5] ラベルだらけにしない仕掛けは残っている', () => {
  assert.match(html, /const DENSITY_CAP = \{ far: \d+, mid: \d+, near: \d+ \};/);
  assert.match(html, /const GRID = \{ cols: \d+, rows: \d+, perCell: \d+ \};/);
  assert.match(html, /hiddenByCollision/);
});

test('[35V §5] 建物名だけで画面の上限を使い切らない', () => {
  // 実測: 対策前は 58 枚中 41 枚が建物名だった（駅名・地名の居場所が無くなる）
  const m = html.match(/const BUILDING_LABEL_SHARE = \{ far: ([0-9.]+), mid: ([0-9.]+), near: ([0-9.]+) \};/);
  assert.ok(m, 'BUILDING_LABEL_SHARE が無い');
  const [far, mid, near] = [m[1], m[2], m[3]].map(Number);
  assert.ok(far < mid && mid < near, '遠景ほど建物名を絞る、になっていない');
  assert.ok(near <= 0.5, '建物名が画面の半分以上を占められる');
  assert.match(html, /if \(c\.item\.kind === 'building' && stats\.visibleBuildings >= Math\.round\(cap \* BUILDING_LABEL_SHARE\[b\]\)\)/);
  assert.match(html, /stats\.hiddenByBuildingShare\+\+;/);
});

test('[35V §5] 衝突判定の余白が、下地の無いラベルでも触れないだけ確保されている', () => {
  // 余白 0.004 では 58 枚中 3〜7 組が角で触れていた（実測）
  const m = html.match(/const RECT_MARGIN = ([0-9.]+);/);
  assert.ok(m, 'RECT_MARGIN が無い');
  assert.ok(Number(m[1]) > 0.004, '余白が以前のまま');
  assert.match(html, /const hh = \(pxHeight \/ viewportH\(\)\) \+ RECT_MARGIN;/);
  assert.match(html, /const hw = hh \* aspect \+ RECT_MARGIN;/);
});

test('[35V §5] 暗い地面ではハロー型ラベルが反転し、pill 型は白のまま', () => {
  assert.match(html, /const darkMap = night \|\| \(\(typeof cityThemeDark === 'function'\) && cityThemeDark\(\)\);/);
  assert.match(html, /const tk = darkMap \? \(night \? 'n' : 'v'\) : 'd';/);
  // ハロー型（町名・区名・河川・公園）は darkMap で明るい文字へ
  for (const re of [/text: inkOnDark \? '#eef4ff'/, /text: inkOnDark \? '#dbe6f7'/,
    /text: inkOnDark \? '#9fd8ef'/, /text: inkOnDark \? '#bfe8c6'/]) assert.match(html, re);
  // pill 型（駅・ランドマーク）は night のときだけ暗い pill＝ネイビー上では白いバブル
  assert.match(html, /pill: night \? 'rgba\(10,18,34,0\.74\)' : 'rgba\(255,255,255,0\.88\)'/);
  assert.match(html, /pill: night \? 'rgba\(12,20,36,0\.80\)' : 'rgba\(255,255,255,0\.94\)'/);
  // 主要ビルは白いバブル
  assert.match(html, /key: 'bl\|mid\|pill\|' \+ tk, font: f, weight: '700',/);
  assert.match(html, /pill: 'rgba\(255,255,255,0\.92\)', border: 'rgba\(110,132,158,0\.34\)',/);
});

test('[35V §9] 建物名ラベルの表示数が測れる（地名に混ぜて数えない）', () => {
  // 35O は kind==='building' の分岐を足しておらず、建物名が visiblePlaces に入っていた
  assert.match(html, /else if \(c\.item\.kind === 'building'\) stats\.visibleBuildings\+\+;/);
  assert.match(html, /buildingNames: stats\.buildingNames, visibleBuildings: stats\.visibleBuildings,/);
});

// ── §0 production / protected ───────────────────────────────────
test('[35V §0] production / protected は変更していない', () => {
  for (const [n, p] of [['production', PROD], ['protected', PROT]]) {
    const s = fs.readFileSync(p, 'utf-8');
    assert.ok(!/CITY_THEME/.test(s), n + ' に 35V のテーマが入っている');
    assert.ok(!/cityThemeDark/.test(s), n + ' に 35V のテーマ判定が入っている');
  }
  // protected は 35O の建物名も含まない
  assert.ok(!/BuildingNameStore/.test(fs.readFileSync(PROT, 'utf-8')), 'protected に 35O が混入');
});

// ── §9 実機 QA ───────────────────────────────────────────────────
test('[35V §9] 実機: 地面がネイビー、建物名・駅名が出ている、JS 例外 0',
  { skip: !fs.existsSync(QA) && 'no report' }, () => {
    const q = rj(QA).summary;
    assert.equal(q.jsErrors, 0, 'JS 例外がある');
    assert.equal(q.theme, 'NAVY');
    assert.equal(q.groundIsNavy, true, '地面がネイビーでない: ' + JSON.stringify(q.groundSamples));
    assert.equal(q.buildingLabelsLoaded, true, '建物名ラベルが読み込まれていない地点がある');
    assert.equal(q.buildingLabelsVisibleSomewhere, true, '建物名ラベルがどこにも出ていない');
    assert.equal(q.stationLabelsVisibleSomewhere, true, '駅名ラベルがどこにも出ていない');
    assert.deepEqual(q.labelDataErrors, [], 'ラベルデータの読み込みエラー');
    assert.ok(q.spots.length >= 5, 'QA 地点が足りない');
    // 建物名は出ているが、画面を埋め尽くしてはいない
    for (const b of q.buildingLabelSpots) {
      assert.ok(b.visible > 0, b.id + ' に建物名ラベルが 1 つも出ていない');
      assert.ok(b.visible <= 30, b.id + ' の建物名ラベルが多すぎる: ' + b.visible);
    }
  });
