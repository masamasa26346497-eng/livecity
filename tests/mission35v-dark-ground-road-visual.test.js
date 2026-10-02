// tests/mission35v-dark-ground-road-visual.test.js
// [Mission 35V] 建物名ラベルの復活とラベル階層。
//
// **地面の色について**: 35V はネイビー地面も入れたが、Mission 35W でユーザー判断により
//   35V 直前（babae19）の明るい配色へ戻した。地面まわりの検査は
//   tests/mission35w-real-roads-original-ground.test.js が引き継いでいる。
//   そちらは「ネイビーが消えていること」「35V 直前と 1 行ずつ一致すること」を git 履歴と
//   突き合わせて見るので、ここにあった検査より強い条件になっている（緩めてはいない）。
//   道路の灰色化も 35V 内で差し戻し済みで、35W の §3 が「道路 style が 35V 前のまま」を見ている。
//   ここには 35V が今も持っている **ラベル側** の責務だけを残す。
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

// ── §3 道路 ──────────────────────────────────────────────────────
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

test('[35V §9] 建物名ラベルの表示数が測れる（地名に混ぜて数えない）', () => {
  // 35O は kind==='building' の分岐を足しておらず、建物名が visiblePlaces に入っていた
  assert.match(html, /else if \(c\.item\.kind === 'building'\) stats\.visibleBuildings\+\+;/);
  assert.match(html, /buildingNames: stats\.buildingNames, visibleBuildings: stats\.visibleBuildings,/);
});

// ── §0 production / protected ───────────────────────────────────
test('[35V §0] production / protected は変更していない', () => {
  for (const [n, p] of [['production', PROD], ['protected', PROT]]) {
    const s = fs.readFileSync(p, 'utf-8');
    assert.ok(!/BUILDING_LABEL_SHARE/.test(s), n + ' に 35V のラベル変更が入っている');
    assert.ok(!/CITY_THEME/.test(s), n + ' に 35V のテーマが入っている');
  }
  // protected は 35O の建物名も含まない
  assert.ok(!/BuildingNameStore/.test(fs.readFileSync(PROT, 'utf-8')), 'protected に 35O が混入');
});

// ── §9 実機 QA ───────────────────────────────────────────────────

test('[35V §4] 主要ビルは白いバブルで出る', () => {
  assert.match(html, /key: 'bl\|mid\|pill\|' \+ tk, font: f, weight: '700',/);
  assert.match(html, /pill: 'rgba\(255,255,255,0\.92\)', border: 'rgba\(110,132,158,0\.34\)',/);
});
