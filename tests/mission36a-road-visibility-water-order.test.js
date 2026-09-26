// tests/mission36a-road-visibility-water-order.test.js
// [Mission 36A] 大阪市全域の道路視認性を 1 段階強くし、道路を水面より上に描く。
//   守りたいのは次の 3 つ:
//     1. 道路の塗りが水面より **下** に戻らないこと（32I→32K で起きた退行の再発防止）
//     2. depthTest を切って道路を無条件に最前面へ出す実装が入らないこと
//     3. 道路の色を強めても「鉄道 > 道路 > 地表」の明度順と、道路種別の描き分けが壊れないこと
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const REPORT = path.join(ROOT, 'data', 'reports', 'mission36a-road-visibility-water-order');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/**
 * `const <name> = { ... };` の右辺を実際に評価して値で検証する（文字列一致に依存しない）。
 *   `Y` / `REN` / `COL` は HTML 内に同名の別定義が多数あるので、CanonicalRuntime の
 *   パレット定義だけを取り違えずに拾えるよう `anchor`（右辺の先頭の一部）で絞る。
 */
function objLiteral(src, name, scope, anchor) {
  const head = anchor ? anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const m = new RegExp('const ' + name + ' = (\\{\\s*' + head + '[^;]*?\\});').exec(src);
  assert.ok(m, name + ' の定義が見つからない' + (anchor ? '（anchor: ' + anchor + '）' : ''));
  const keys = Object.keys(scope || {});
  // eslint-disable-next-line no-new-func
  return new Function(...keys, 'return (' + m[1] + ');')(...keys.map((k) => scope[k]));
}

const Y = objLiteral(html, 'Y', {}, 'water: 0.');
const REN = objLiteral(html, 'REN', {}, 'water: ');
const COL = objLiteral(html, 'COL', { MS_BUILDING_WHITE: 0xeef0ec }, 'water: 0x');
const ROAD_V3_Y = objLiteral(html, 'ROAD_V3_Y', { Y });
const COL_DEPTH = objLiteral(html, 'COL_DEPTH', { COL });

/** sRGB 相対輝度とコントラスト比（WCAG）。 */
const relLum = (hex) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f((hex >> 16) & 255) + 0.7152 * f((hex >> 8) & 255) + 0.0722 * f(hex & 255);
};
const contrast = (a, b) => {
  const [hi, lo] = [Math.max(relLum(a), relLum(b)), Math.min(relLum(a), relLum(b))];
  return (hi + 0.05) / (lo + 0.05);
};

// ── §2 道路 > 水面 の重なり順 ───────────────────────────────────
test('[36A §2] ROAD_V3 の塗りがすべて水面より上にある', () => {
  for (const k of ['base', 'carriageway', 'diff']) {
    assert.ok(typeof ROAD_V3_Y[k] === 'number', 'ROAD_V3_Y.' + k + ' が数値でない');
    assert.ok(ROAD_V3_Y[k] > Y.water,
      'ROAD_V3_Y.' + k + '(' + ROAD_V3_Y[k] + ') が水面 Y.water(' + Y.water + ') 以下。'
      + '不透明な車道面より後に描かれる水面が depthTest に勝ち、橋や河川際で道路が消える');
  }
  // 32I の値（0.087 / 0.099 / 0.101）へ戻っていないこと
  assert.ok(ROAD_V3_Y.carriageway >= Y.water + 0.05,
    '水面との間隔が 0.05m 未満。カメラ距離によっては水面が勝ちうる');
});

test('[36A §2] ROAD_V3 の Y は道路スタック（Y.road）から導出している', () => {
  const line = html.split('\n').find((l) => l.includes('const ROAD_V3_Y ='));
  assert.match(line, /Y\.road/, 'ROAD_V3_Y が Y.road ではなく固定値で書かれている（Y.road を動かすと再び水没する）');
  assert.equal(ROAD_V3_Y.carriageway, Y.road, '車道面は FIX13 の primary と同じ高さに揃える');
  assert.ok(ROAD_V3_Y.base < ROAD_V3_Y.carriageway, '道路区域(margin)は車道面より下に敷く');
  assert.ok(ROAD_V3_Y.diff >= ROAD_V3_Y.carriageway, 'DIFF は車道面以上');
});

test('[36A §2] 道路は鉄道・建物より下のままで、renderOrder も水面より後', () => {
  assert.ok(ROAD_V3_Y.diff < Y.rail, '道路が鉄道(Y.rail)より上に出ている');
  assert.ok(ROAD_V3_Y.diff < Y.roadBridge, '平面の道路が高架(Y.roadBridge)まで上がっている');
  assert.ok(REN.water < REN.road, 'renderOrder が 水面 < 道路 になっていない');
  assert.ok(REN.road < REN.rail && REN.rail < REN.building, 'レイヤー順（道路 < 鉄道 < 建物）が壊れている');
});

test('[36A §2] depthTest を切って道路を最前面へ出していない', () => {
  // 道路 mesh を作る 3 か所（FIX13 bucket / ROAD_V3 / RoadDetail）に depthTest:false が無いこと
  const offenders = html.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /depthTest\s*:\s*false/.test(l) && !l.trimStart().startsWith('//'))
    .filter(([, l]) => /Road|road/.test(l));
  assert.deepEqual(offenders, [],
    '道路に depthTest:false が入っている（建物の上まで道路が透けて見える）');
});

// ── §1 道路の視認性 ─────────────────────────────────────────────
test('[36A §1] 既定パレット(DEPTH)の道路が地表に対して 3:1 以上のコントラストを持つ', () => {
  const land = parseInt(html.match(/const LAND_COLOR_MODEL = (0x[0-9a-f]{6});/)[1], 16);
  const c = contrast(COL_DEPTH.road, land);
  assert.ok(c >= 3.0, '道路と地表のコントラスト比が ' + c.toFixed(2) + ' で 3:1 未満（背景に埋もれる）');
  // 36A 以前（0x8b929e = 2.91）へ戻っていないこと
  assert.ok(c > contrast(0x8b929e, land),
    '36A 前の道路色より弱い（' + c.toFixed(2) + ' ≤ ' + contrast(0x8b929e, land).toFixed(2) + '）');
});

test('[36A §1] 道路を濃くしても「鉄道は道路より濃い」関係を壊していない', () => {
  for (const k of ['railMajor', 'railUrban', 'railLocal']) {
    assert.ok(relLum(COL_DEPTH[k]) < relLum(COL_DEPTH.road),
      COL_DEPTH[k].toString(16) + '(' + k + ') が道路より明るい。道路と鉄道が見分けられない');
  }
  // 無彩色寄りの blue-gray のまま（原色へ振っていない）
  const r = (COL_DEPTH.road >> 16) & 255, g = (COL_DEPTH.road >> 8) & 255, b = COL_DEPTH.road & 255;
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 40, '道路色の彩度が上がりすぎ（無彩色寄りを維持する）');
  assert.ok(b >= r, '道路色が blue-gray でなくなっている');
});

test('[36A §1] 道路種別の描き分け（mix による階段）は変えていない', () => {
  const m = /function buildRoadStyles\(\) \{[\s\S]*?\n  \}/.exec(html);
  assert.ok(m, 'buildRoadStyles が見つからない');
  const blk = m[0];
  for (const k of ['primary', 'bridge', 'secondary', 'pedestrian', 'sidewalk', 'median', 'faint']) {
    assert.ok(blk.includes(k + ':'), 'renderClass の style が欠けている: ' + k);
  }
  // 主要/一般の差は COL.road と COL.white の mix で作る（個別の固定色へ置き換えていない）
  assert.match(blk, /secondary:\s*\{\s*col: mix\(COL\.road, COL\.white, [0-9.]+\)/);
  assert.match(blk, /primary:\s*\{\s*col: COL\.road,/);
});

test('[36A §1] 道路区域(margin/uncertain)は色を変えず opacity だけ上げている', () => {
  const c = objLiteral(html, 'ROAD_V3_COLOR', { COL: { road: COL_DEPTH.road } });
  assert.equal(c.margin, 0xc4b99e, 'margin の色を変えている（§11 dark paint rule: 濃い色は車道面だけ）');
  assert.equal(c.uncertain, 0xb0a488, 'uncertain の色を変えている');
  const lines = html.split('\n');
  const op = (name) => {
    const l = lines.find((x) => x.includes("['" + name + "',"));
    assert.ok(l, name + ' の mesh spec が無い');
    const m2 = /opacity: ([0-9.]+)/.exec(l);
    assert.ok(m2, name + ' に opacity 指定が無い');
    return parseFloat(m2[1]);
  };
  assert.ok(op('RoadV3_Margin') > 0.45, 'margin の opacity が 36A 前(0.45)から上がっていない');
  assert.ok(op('RoadV3_Uncertain') > 0.55, 'uncertain の opacity が 36A 前(0.55)から上がっていない');
  assert.ok(op('RoadV3_Margin') <= 0.75 && op('RoadV3_Uncertain') <= 0.8, '道路区域が車道面より目立つほど濃い');
  // depthWrite:false のまま（重なり順へ影響させない）
  for (const n of ['RoadV3_Margin', 'RoadV3_Uncertain']) {
    assert.match(lines.find((x) => x.includes("['" + n + "',")), /depthWrite: false/);
  }
});

// ── §3 データは作り変えていない ─────────────────────────────────
test('[36A §3] 道路・水面の geometry / 取得元は変えていない', () => {
  assert.ok(html.includes("const ROAD_V3_BASE = BASE + '/road-visual-v3';"), 'ROAD_V3 の取得元が変わっている');
  // 座標はデータのまま使い、Y だけを与えている（clip / offset をしていない）
  assert.match(html, /pushPolygon\(posCarriageway, 'Polygon', \[q\], ROAD_V3_Y\.carriageway\);/);
  assert.match(html, /pushPolygon\(posMargin, f\.envelope\.geometryType, f\.envelope\.coordinates, ROAD_V3_Y\.base\);/);
  // 水面も従来どおり Y.water に置いたまま（下げて逃げていない）
  assert.match(html, /pushPolygon\(pos, f\.geometryType, f\.coordinates, Y\.water\);/);
  assert.equal(Y.water, 0.14, '水面の高さを動かして解決している（水面形状は変えない方針）');
});

// ── §0 production / protected ───────────────────────────────────
test('[36A §0] production / protected には 36A を入れていない', () => {
  for (const [n, p] of [['production', PROD], ['protected', PROT]]) {
    const s = fs.readFileSync(p, 'utf-8');
    assert.ok(!/Mission 36A/.test(s), n + ' に 36A が混入している（cutover は別ミッション）');
  }
});

// ── 実機 QA（レポートがある時だけ）────────────────────────────────
const after = rj(path.join(REPORT, 'after.json'));
const before = rj(path.join(REPORT, 'before.json'));

test('[36A QA] 実機: 可視の道路 mesh がすべて水面より上にある',
  { skip: !after && '実機 QA レポートが無い' }, () => {
    let minRoad = Infinity, maxWater = -Infinity, checked = 0;
    for (const s of after.spots) {
      for (const r of s.stack) {
        if (r.kind === 'road') { minRoad = Math.min(minRoad, r.y); checked++; }
        if (r.kind === 'water') maxWater = Math.max(maxWater, r.y);
      }
    }
    assert.ok(checked > 0, '道路 mesh が 1 つも観測できていない');
    assert.ok(maxWater > -Infinity, '水面 mesh が 1 つも観測できていない');
    assert.ok(minRoad > maxWater,
      '実機で道路(' + minRoad + ') が水面(' + maxWater + ') より下にある');
  });

test('[36A QA] 実機: 道路 material に depthTest:false が無い',
  { skip: !after && '実機 QA レポートが無い' }, () => {
    const bad = [];
    for (const s of after.spots) for (const r of s.stack) if (r.kind === 'road' && r.depthTest !== true) bad.push(s.file + '/' + r.name);
    assert.deepEqual(bad, [], '道路が depthTest なしで描かれている');
  });

test('[36A QA] 実機: 全地点で道路のコントラストが 36A 前より上がっている',
  { skip: !(after && before) && '前後の実機 QA レポートが揃っていない' }, () => {
    const worse = [];
    for (const a of after.spots) {
      const b = before.spots.find((x) => x.file === a.file);
      if (!b) continue;
      if (!(a.pixels.roadContrast > b.pixels.roadContrast)) {
        worse.push(a.file + ': ' + b.pixels.roadContrast + ' → ' + a.pixels.roadContrast);
      }
    }
    assert.deepEqual(worse, [], '道路が前より見えにくくなった地点がある');
  });

test('[36A QA] 実機: JS エラーを増やしていない',
  { skip: !(after && before) && '前後の実機 QA レポートが揃っていない' }, () => {
    const norm = (a) => a.map((s) => s.split('\n')[0]).sort();
    assert.deepEqual(norm(after.consoleErrors), norm(before.consoleErrors),
      '36A で console エラーが増減している');
  });

test('[36A QA] 実機: 既定表示の構成（ROAD_V3 / raw GSI edge OFF）を変えていない',
  { skip: !after && '実機 QA レポートが無い' }, () => {
    assert.equal(after.display.normalViewRoadMode, 'ROAD_V3');
    assert.equal(after.display.normalViewRawGsiEdge, false);
    assert.equal(after.display.preset, 'SEMANTIC');
    for (const k of ['buildings', 'roads', 'water', 'parks', 'rail']) {
      assert.equal(after.display.layers[k], true, k + ' レイヤーが消えている');
    }
  });
