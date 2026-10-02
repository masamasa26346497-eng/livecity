// tests/building-color-palette.test.js
// [Mission 35N §7-§12] 灰色だった「用途不明」の建物に、高さから決まる色を付ける。
//   - 既に用途色がある建物は上書きしない
//   - 色は決定論（同じ建物は毎回同じ色）
//   - material は共有し、建物 1 棟ごとに new しない
//   - geometry / 建物数は変更しない
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

test('[35N §7] 灰色の正体は usageCategory が付かない建物（other）', () => {
  // 'other' が既定のニュートラルグレーだったこと自体は残す（CURRENT プロファイル用）
  assert.match(html, /other:\s+0xb2bac0,/);
  // null / 未知コードは 'other' へ寄せる、という既存の分類は変えていない
  assert.match(html, /function crUsageCategory\(a\) \{/);
  assert.match(html, /return \(typeof c === 'string' && CR_USAGE_COLOR\[c\]\) \? c : 'other';/);
});

test('[35N §8] 既に用途色がある建物は上書きしない', () => {
  // 高さで色を変えるのは cat === 'other' のときだけ
  assert.match(html, /const hc = \(cat === 'other' && ![\s\S]{0,120}crOtherHeightClass\(h\) : null;/);
  assert.match(html, /const base = \(cat === 'other' && depthEnabled\(\)\)/);
  // 既存の用途色テーブルは 1 つも消していない
  for (const k of ['residential_low', 'residential_mid', 'commercial', 'office', 'industrial',
    'public', 'school', 'medical', 'hotel', 'other']) {
    assert.match(html, new RegExp(k + ':[ ]+0x[0-9a-f]{6},'), k + ' の用途色が消えている');
  }
  // ランドマークの別レイヤーは触っていない
  assert.match(html, /const LandmarkHDLayer = \(function \(\) \{/);
});

test('[35N §9/§10] 高さクラスは決定論で、乱数を使わない', () => {
  const m = html.match(/function crOtherHeightClass\(h\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'crOtherHeightClass が無い');
  assert.ok(!/Math\.random/.test(m[0]), '色決めに乱数を使っている');
  const cls = html.match(/const CR_OTHER_HEIGHT_CLASSES = \[[\s\S]*?\n  \];/);
  assert.ok(cls, 'パレットが無い');
  assert.ok(!/Math\.random/.test(cls[0]), 'パレットに乱数が混ざっている');

  // 実際に評価して、高さ → クラスが安定していることを確かめる
  const ctx = { Math, isFinite, Object };
  vm.createContext(ctx);
  vm.runInContext(cls[0] + '\n' + m[0] + '\n; this.f = crOtherHeightClass;', ctx);
  const f = ctx.f;
  assert.equal(f(3), 'low');
  assert.equal(f(7), 'midLow');
  assert.equal(f(11), 'mid');
  assert.equal(f(25), 'midHigh');
  assert.equal(f(45), 'high');
  assert.equal(f(120), 'veryHigh');
  // 同じ入力は同じ結果（決定論）
  for (const h of [0, 1, 5.9, 6, 9, 13, 30, 60, 1000]) assert.equal(f(h), f(h));
  // PLATEAU の外れ値（9999 など）でも壊れない
  assert.equal(f(9999), f(400));
  assert.equal(f(-1), 'low');
  assert.equal(f(null), 'low');
});

test('[35N §9] パレットは彩度を抑えた色で、原色を使わない', () => {
  const cls = html.match(/const CR_OTHER_HEIGHT_CLASSES = \[[\s\S]*?\n  \];/)[0];
  const cols = [...cls.matchAll(/color:\s*0x([0-9a-f]{6})/g)].map((x) => parseInt(x[1], 16));
  assert.ok(cols.length >= 5, '高さクラスが少なすぎる: ' + cols.length);
  for (const c of cols) {
    const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx ? (mx - mn) / mx : 0;
    assert.ok(sat <= 0.45, '彩度が高すぎる（原色っぽい）: #' + c.toString(16));
    assert.ok(mx >= 140, '暗すぎる: #' + c.toString(16));
  }
  // 全クラスで色が違う（高さが読める）
  assert.equal(new Set(cols).size, cols.length, '同じ色のクラスがある');
});

test('[35N §12] material は共有し、建物ごとに new しない', () => {
  // material は (用途 × band × profile) をキーにしたキャッシュから取る
  assert.match(html, /let m = crBuildingMats\.get\(key\);/);
  assert.match(html, /crBuildingMats\.set\(key, m\);/);
  // DEPTH では 'other' の束ねを分けない = mesh も draw call も増やさない
  assert.match(html, /const splitByHeight = hc && !depthEnabled\(\);/);
  assert.match(html, /色みは頂点カラーで付ける/);
  // 色みは頂点カラー（既に焼いている配列）へ掛ける
  assert.match(html, /function pushExtrude\(positions, geometryType, coordinates, h, colors, tint\)/);
  assert.match(html, /const CR_OTHER_TINT = Object\.fromEntries/);
});

test('[35N §11] 建物の geometry / 件数を変えていない', () => {
  // 押し出しの座標の積み方は変更していない（色の配列だけ別に積む）
  assert.match(html, /positions\.push\(a\[0\], 0, a\[1\], b\[0\], 0, b\[1\], b\[0\], h, b\[1\]\);/);
  assert.match(html, /positions\.push\(a\[0\], 0, a\[1\], b\[0\], h, b\[1\], a\[0\], h, a\[1\]\);/);
  assert.match(html, /positions\.push\(v\.x, h, v\.y\);/);
  // canonical の件数は baseline のまま
  const man = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'buildings-v4-final', 'manifest.json'));
  if (man) assert.equal(man.featureCount, 618749, 'V4 の建物数が変わっている');
  const v1 = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'));
  if (v1) assert.equal(v1.featureCount, 615617, 'canonical V1 の建物数が変わっている');
});

test('[35N] 実測: 灰色一色ではなくなり、draw call を増やしていない',
  { skip: !rj(path.join(ROOT, 'data', 'reports', 'building-color-palette-qa.json')) && 'no report' }, () => {
    const q = rj(path.join(ROOT, 'data', 'reports', 'building-color-palette-qa.json'));
    assert.ok(q.otherHueRatios.length >= 4, '用途不明の建物が 1 色のまま: ' + q.otherHueRatios.length);
    assert.equal(q.drawCallsDelta <= 0, true, 'draw call が増えている: ' + q.drawCallsDelta);
    assert.equal(q.buildingCount, 618749);
  });
