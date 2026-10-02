// tests/mission08-building-edge.test.js
// [見た目改善 Mission08] 建物エッジ(輪郭線)を弱め、Mission09の陰影で形状を読ませる方向へ寄せる。
//   対象は ward-ux-v1.html の MODEL_STYLE=true 時の bldgEdges のみ。geometry / 用途色 / lighting は不変。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

test('[Mission08] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m08-${process.pid}.js`);
  fs.writeFileSync(f, m[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission08] BUILDING_EDGE_LOD モジュールが存在し、必要な API を返す', () => {
  assert.ok(/const BUILDING_EDGE_LOD = \(function \(\) \{/.test(html), 'BUILDING_EDGE_LOD 未定義');
  assert.ok(/return \{ apply, syncNew, reset, bandOf, getEdgeDebug, NEAR_M, MID_M, EDGE_COLOR, OP \};/.test(html),
    '公開 API が想定と異なる');
});

test('[Mission08] MODEL_STYLE時の em() は模型グレー + 弱い opacity（用途色の輪郭はやめる）', () => {
  const m = html.match(/if \(MODEL_STYLE\.on\) \{[\s\S]{0,400}?\n  \}/);
  assert.ok(m, 'em() の MODEL_STYLE ブランチが見つからない');
  assert.ok(/color: BUILDING_EDGE_LOD\.EDGE_COLOR/.test(m[0]), 'エッジ色が BUILDING_EDGE_LOD.EDGE_COLOR ではない');
  assert.ok(/opacity: BUILDING_EDGE_LOD\.OP\.near/.test(m[0]), '初期 opacity が near バンド相当ではない');
  assert.ok(!/0x8a9096/.test(m[0]), '旧エッジ色(0x8a9096)が残っている');
});

test('[Mission08] エッジ色は light neutral gray（黒・濃灰にしない）', () => {
  const hex = html.match(/const EDGE_COLOR = (0x[0-9a-f]{6});/);
  assert.ok(hex, 'EDGE_COLOR 未定義');
  const v = parseInt(hex[1], 16);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  assert.ok(r >= 150 && g >= 150 && b >= 150, `エッジ色が暗すぎる #${hex[1].slice(2)}`);
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 20, 'エッジ色に色味が強い（neutral gray でない）');
});

test('[Mission08] NEAR/MID/FAR opacity: NEAR最小限 / MIDかなり弱く / FAR非表示', () => {
  const op = html.match(/const OP = \{ near: ([0-9.]+), mid: ([0-9.]+), far: ([0-9.]+) \};/);
  assert.ok(op, 'OP テーブル未定義');
  const [near, mid, far] = [parseFloat(op[1]), parseFloat(op[2]), parseFloat(op[3])];
  assert.ok(near >= 0.10 && near <= 0.22, `NEAR opacity=${near}（近景で線画に見えない範囲）`);
  assert.ok(mid >= 0.04 && mid <= 0.13 && mid < near, `MID opacity=${mid}`);
  assert.ok(far <= 0.05, `FAR opacity=${far}（遠景で白いエッジノイズが出る）`);
});

test('[Mission08] 距離バンドしきい値が定義され、bandOf が near/mid/far を返す', () => {
  assert.ok(/const NEAR_M = \d+, MID_M = \d+;/.test(html), 'バンドしきい値未定義');
  assert.ok(/function bandOf\(d\) \{ return d <= NEAR_M \? 'near' : \(d <= MID_M \? 'mid' : 'far'\); \}/.test(html),
    'bandOf の実装が想定と異なる');
});

test('[Mission08] band 変化時のみ全 bldgEdges を走査（毎フレーム再代入しない）', () => {
  const m = html.match(/function apply\(d\) \{[\s\S]{0,700}?\n  \}/);
  assert.ok(m, 'apply() が見つからない');
  assert.ok(/if \(b === band && vis === lastVis && op === lastOp\) return;/.test(m[0]), 'band変化ガードが無い');
  assert.ok(/for \(const e of bldgEdges\) \{/.test(m[0]), 'bldgEdges 走査が無い');
});

test('[Mission08] camUpd から距離LODが呼ばれる', () => {
  assert.ok(/if \(typeof BUILDING_EDGE_LOD !== 'undefined'\) BUILDING_EDGE_LOD\.apply\(cs\.r\);/.test(html),
    'camUpd に BUILDING_EDGE_LOD.apply(cs.r) が無い');
});

test('[Mission08] legacy（MODEL_STYLE=false）副作用なし: 隠したエッジを元に戻して手を引く', () => {
  const m = html.match(/function apply\(d\) \{[\s\S]{0,700}?\n  \}/);
  assert.ok(/if \(!MODEL_STYLE\.on\) \{[\s\S]{0,200}?for \(const e of bldgEdges\) e\.visible = true; reset\(\);/.test(m[0]),
    'legacy 切替時にエッジ可視を復元していない');
  // em() の legacy ブランチ（壁色寄せブレンド）は温存
  assert.ok(/const blended = wallC\.clone\(\)\.lerp\(edgeC, 0\.35\);/.test(html), 'em() の legacy ブレンドが消えた');
});

test('[Mission08] 外観強調モード中は LOD が介入しない（toggleEmphasis が全非表示を管理）', () => {
  assert.ok(/function emphasisHiding\(\) \{ return typeof emphasisMode !== 'undefined' && emphasisMode; \}/.test(html),
    'emphasisHiding ガードが無い');
  const m = html.match(/function apply\(d\) \{[\s\S]{0,700}?\n  \}/);
  assert.ok(/if \(emphasisHiding\(\)\) return;/.test(m[0]), 'apply() が emphasis 中に return しない');
  // 解除時に距離LODへ戻す
  assert.ok(/for \(const e of bldgEdges\) e\.visible = true;\s*\/\/ \[Mission08\][\s\S]{0,180}?BUILDING_EDGE_LOD\.reset\(\); BUILDING_EDGE_LOD\.apply\(cs\.r\); \}/.test(html),
    'toggleEmphasis 解除で距離LODへ戻していない');
});

test('[Mission08] applyModelStyle がエッジ材質差し替え後に距離LODを再適用する', () => {
  assert.ok(/e\.material = em\(e\.userData\.usage\);\s*\/\/ \[Mission08\][\s\S]{0,200}?BUILDING_EDGE_LOD\.reset\(\); BUILDING_EDGE_LOD\.apply\(/.test(html),
    'applyModelStyle で BUILDING_EDGE_LOD 再適用が無い');
});

test('[Mission08] 遅延ロードタイルの新規エッジを現バンドへ同期', () => {
  assert.ok(/bldgEdges\.push\(eLine\);[\s\S]{0,120}?BUILDING_EDGE_LOD\.syncNew\(eLine\);/.test(html),
    'buildUsageTileMeshes で syncNew を呼んでいない');
});

test('[Mission08] CityBuildingLOD にはエッジを足さない（Mission01の軽量方針維持）', () => {
  const startIdx = html.indexOf('const CityBuildingLOD = (function () {');
  assert.ok(startIdx >= 0, 'CityBuildingLOD 定義が見つからない');
  // 完全一致の return 文字列は後続ミッション（Mission24/25/27 等）で戻り値フィールドが増えるたびに
  // 追随が必要で壊れやすいため、安定した prefix のみで終端を特定する（末尾フィールド増減に強くする）。
  const endIdx = html.indexOf('return { build, setCameraDistance, setVisible, getStats,', startIdx);
  assert.ok(endIdx > startIdx, 'CityBuildingLOD の return 文が見つからない（endIdx が -1 のまま検索範囲がファイル末尾まで暴走するのを防ぐ）');
  const body = html.slice(startIdx, endIdx);
  assert.ok(!/LineSegments|EdgesGeometry|bldgEdges|BUILDING_EDGE_LOD/.test(body),
    'CityBuildingLOD にエッジ関連コードが混入');
});

test('[Mission08] hover/select ハイライトは独立（弱めても強調表示は明確）', () => {
  assert.ok(/const hoverHL = makeHighlightSet\(0x00e5ff\);/.test(html), 'hoverHL が変わっている');
  assert.ok(/const selectHL = makeHighlightSet\(0xff8a00\);/.test(html), 'selectHL が変わっている');
  // makeHighlightSet の線は opacity 0.95 の別材質（bldgEdges とは無関係）
  assert.ok(/new THREE\.LineBasicMaterial\(\{ color, transparent: true, opacity: 0\.95, linewidth: 2 \}\)/.test(html),
    'ハイライト線材質が変わっている');
});

test('[Mission08] 高さで opacity を増やさない（高層は Mission09 の側面陰影に任せる）', () => {
  const m = html.match(/const BUILDING_EDGE_LOD = \(function \(\) \{[\s\S]*?\}\)\(\);/);
  assert.ok(m, 'BUILDING_EDGE_LOD ブロックが取れない');
  assert.ok(!/height|Height|dz|z0|floor|Floor/.test(m[0]), 'エッジLODが高さ依存の項を持っている');
});

test('[Mission08] 色・ライト・接地暗化(Mission05/09)を変更していない', () => {
  assert.ok(/fillColor: 0x9ed6e6/.test(html), '河川fill色が変わった');
  assert.ok(/const ROAD_RIBBON_COLOR = \{ major: 0xb8bdc3, mid: 0xc4c8cc, local: 0xd0d3d6 \};/.test(html), '道路tier色が変わった');
  assert.ok(/const MS_BUILDING_WHITE = 0xeef0ec;/.test(html), '建物白(壁)基準色が変わった');
  assert.ok(/const MS_ROOF_WHITE = 0xf6f7f3;/.test(html), 'roof白が変わった');
  assert.ok(/hemiLight\.intensity = modelDay \? 1\.0/.test(html), 'model-day hemi が変わった');
});

test('[Mission08] window.__BUILDING_EDGE_DEBUG__ が distance/edgeBand/opacity/visible/edgeObjectCount を返す', () => {
  assert.ok(/window\.__BUILDING_EDGE_DEBUG__ = \(\) => BUILDING_EDGE_LOD\.getEdgeDebug\(\);/.test(html), 'debug API 未配線');
  const m = html.match(/function getEdgeDebug\(\) \{[\s\S]*?\n  \}/);
  for (const k of ['distance', 'edgeBand', 'opacity', 'visible', 'edgeObjectCount']) {
    assert.ok(m[0].includes(k), `getEdgeDebug に ${k} が無い`);
  }
});

test('protected baseline fullward-v3.html は Mission08 の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/BUILDING_EDGE_LOD|__BUILDING_EDGE_DEBUG__/.test(fw), 'fullward-v3.html に Mission08 の変更が混入');
});

test('[Mission 32U] production osaka_3d_buildings.html は promoted build（Mission08 を含む）', () => {
  const prod = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.html'), 'utf-8');
  assert.ok(/BUILDING_EDGE_LOD/.test(prod), 'production HTML に Mission08 の内容が無い（32U cutover 後の production は ward-ux-v1 から生成した promoted build）');
});
