// tests/river-layer-v2.test.js
// [河川再導入] ward-ux-v1.html 配線検証: 旧河川描画の無効化維持 + RiverLayerV2（旧CleanWaterLayerを
//   本ラウンドでリネーム）の独立モジュール化・第一段階(主要7河川のみ)・岸線描画。
//   純粋ロジック(centerline+width ribbon生成・幅推定・validator)は
//   tests/river-width.test.js / tests/river-ribbon.test.js / tests/river-ribbon-validator.test.js /
//   tests/river-ribbon-regression.test.js でカバー済み。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

test('[河川再導入] WATER_LAYER_ENABLED は既定 false のまま（旧河川は復活させない）', () => {
  assert.ok(/let WATER_LAYER_ENABLED = false;/.test(html), 'WATER_LAYER_ENABLED の既定値が false でない');
});

test('[河川再導入] 旧CleanWaterLayerという名称は残っていない（RiverLayerV2へ統一）', () => {
  assert.ok(!/CleanWaterLayer/.test(html), 'CleanWaterLayer という古い名称が残っている');
});

test('[河川再導入] RiverLayerV2: 独立モジュールとして init/load/show/hide/dispose/updateByCamera を公開', () => {
  const startIdx = html.indexOf('const RiverLayerV2 = (function () {');
  assert.ok(startIdx >= 0, 'RiverLayerV2 未定義');
  const endIdx = html.indexOf('RiverLayerV2.init();', startIdx);
  assert.ok(endIdx > startIdx, 'RiverLayerV2 の初期化呼び出しが見つからない');
  const body = html.slice(startIdx, endIdx);
  for (const fn of ['init', 'load', 'show', 'hide', 'dispose', 'updateByCamera']) {
    assert.ok(new RegExp(`\\b${fn}\\b`).test(body), `RiverLayerV2 が ${fn} を公開/定義していない`);
  }
  assert.ok(!/buildWaterMeshes|ShapeUtils\.triangulateShape/.test(body), 'RiverLayerV2 が旧WaterLayerのロジックを混在させている');
});

test('[河川再導入] 主要7河川は常時表示tier扱い（実測幅が小さくても遠景で消えない）', () => {
  assert.ok(/const MAJOR_RIVER_NAMES = new Set\(\['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川'\]\);/.test(html),
    '主要7河川リストが無い');
});

test('[河川再導入] 主要7河川の実機承認後: 既定nameFilterは null（全河川。canal・小河川も含む）', () => {
  assert.ok(/let nameFilter = null;/.test(html), 'nameFilterの既定値がnull（全河川表示）になっていない');
});

test('[河川再導入] validator ERROR が付いたriverは描画から除外する', () => {
  const startIdx = html.indexOf('const RiverLayerV2 = (function () {');
  const body = html.slice(startIdx, startIdx + 9000); // [Mission28] micro tier 追加で IIFE が伸びたため窓を拡大
  assert.ok(/if \(r\.validationErrors && r\.validationErrors\.length\) \{ skippedError\+\+; continue; \}/.test(body),
    'validationErrors を持つriverをスキップしていない');
});

test('[河川再導入] 岸線(shoreline)を細いLineSegmentsとして描画する（指示書6節）', () => {
  const startIdx = html.indexOf('const RiverLayerV2 = (function () {');
  const endIdx = html.indexOf('RiverLayerV2.init();', startIdx);
  const body = html.slice(startIdx, endIdx);
  assert.ok(/function appendShorelineSegments\(positions, edge\)/.test(body), '岸線生成関数が無い');
  assert.ok(/new THREE\.LineSegments\(geom, mat\)/.test(body), '岸線をLineSegmentsで描画していない');
  assert.ok(/shoreColor: 0x6fafc4/.test(html), '岸線色が定義されていない');
});

test('[Mission05] fill色は淡い水色 #9ed6e6・MeshBasicMaterial/FrontSide/depthWrite=false（重shader無し）', () => {
  assert.ok(/fillColor: 0x9ed6e6/.test(html), 'fill色が #9ed6e6 でない');
  const startIdx = html.indexOf('const RiverLayerV2 = (function () {');
  const body = html.slice(startIdx, startIdx + 3500);
  assert.ok(/new THREE\.MeshBasicMaterial\(\{ color: STYLE\.fillColor, transparent: true, opacity, side: THREE\.FrontSide, depthWrite: false \}\)/.test(body),
    'material設定（MeshBasicMaterial/FrontSide/depthWrite=false/transparent）が仕様と一致しない');
});

test('[Mission05] 岸線色 #6fafc4（強い線に見せない）', () => {
  assert.ok(/shoreColor: 0x6fafc4/.test(html), '岸線色が #6fafc4 でない');
});

test('[Mission05] opacity は NEAR/MID/FAR の3バンド × major/minor で整理されている（指示書2節の範囲内）', () => {
  const startIdx = html.indexOf('const DEFAULT_STYLE = Object.freeze({');
  const body = html.slice(startIdx, startIdx + 900);
  const num = (key) => { const m = body.match(new RegExp(key + ':\\s*([0-9.]+)')); return m ? parseFloat(m[1]) : null; };
  // major: NEAR 0.68〜0.75 / MID 0.50〜0.60 / FAR 0.35〜0.45
  assert.ok(num('majorOpacity') >= 0.68 && num('majorOpacity') <= 0.75, `majorOpacity=${num('majorOpacity')}`);
  assert.ok(num('majorOpacityMid') >= 0.50 && num('majorOpacityMid') <= 0.60, `majorOpacityMid=${num('majorOpacityMid')}`);
  assert.ok(num('majorOpacityFar') >= 0.35 && num('majorOpacityFar') <= 0.45, `majorOpacityFar=${num('majorOpacityFar')}`);
  // minor: NEAR 0.58〜0.68 / MID 0.38〜0.50 / FAR 0.15〜0.30
  assert.ok(num('minorOpacity') >= 0.58 && num('minorOpacity') <= 0.68, `minorOpacity=${num('minorOpacity')}`);
  assert.ok(num('minorOpacityMid') >= 0.38 && num('minorOpacityMid') <= 0.50, `minorOpacityMid=${num('minorOpacityMid')}`);
  assert.ok(num('minorOpacityFar') >= 0.15 && num('minorOpacityFar') <= 0.30, `minorOpacityFar=${num('minorOpacityFar')}`);
  // shoreline: NEAR 0.45〜0.55 / MID 0.35〜0.45 / FAR 0.20〜0.32
  assert.ok(num('shoreOpacity') >= 0.45 && num('shoreOpacity') <= 0.55, `shoreOpacity=${num('shoreOpacity')}`);
  assert.ok(num('shoreOpacityMid') >= 0.35 && num('shoreOpacityMid') <= 0.45, `shoreOpacityMid=${num('shoreOpacityMid')}`);
  assert.ok(num('shoreOpacityFar') >= 0.20 && num('shoreOpacityFar') <= 0.32, `shoreOpacityFar=${num('shoreOpacityFar')}`);
  // major FAR > minor FAR（遠景で major の方が主張＝主要水系が読み取れる）
  assert.ok(num('majorOpacityFar') > num('minorOpacityFar'), 'major FAR が minor FAR 以下（主要河川が遠景で消える）');
});

test('[Mission05] updateByCamera が band3(距離)で opacity を確定する（NEAR/MID/FAR 補間）', () => {
  assert.ok(/function band3\(d, near, mid, far\)/.test(html), 'band3 補間関数が無い');
  assert.ok(/majorMesh\.material\.opacity = band3\(distance, STYLE\.majorOpacity, STYLE\.majorOpacityMid, STYLE\.majorOpacityFar\)/.test(html),
    'major opacity が band3 で計算されていない');
  assert.ok(/shoreMesh\.material\.opacity = band3\(distance, STYLE\.shoreOpacity, STYLE\.shoreOpacityMid, STYLE\.shoreOpacityFar\)/.test(html),
    'shore opacity が band3 で計算されていない');
});

test('[Mission05] y位置(MAP_LAYER_Y.WATER)・geometry生成ロジックは Mission04 から不変', () => {
  const startIdx = html.indexOf('const RiverLayerV2 = (function () {');
  const body = html.slice(startIdx, startIdx + 500);
  assert.ok(/const Y = MAP_LAYER_Y\.WATER;/.test(body), 'Y座標がMAP_LAYER_Y.WATER基準でなくなっている（geometry変更の疑い）');
  assert.ok(/function appendRibbonTriangles\(positions, left, right\)/.test(html), 'ribbon三角形化ロジックが変更されている');
  assert.ok(/function pushTriangleUpFacing\(positions, p0, p1, p2\)/.test(html), '面法線winding判定ロジックが変更されている');
});

test('[Mission05・指示書11節] setStyle デバッグAPI: geometry不変・fillColor(旧color互換)・opacityは距離バンド再計算', () => {
  const startIdx = html.indexOf('const RiverLayerV2 = (function () {');
  const endIdx = html.indexOf('RiverLayerV2.init();', startIdx);
  const body = html.slice(startIdx, endIdx);
  assert.ok(/function setStyle\(overrides\) \{/.test(body), 'setStyle が定義されていない');
  assert.ok(/if \(o\.color != null && o\.fillColor == null\) o\.fillColor = o\.color;/.test(body), '旧 color キー互換が無い');
  assert.ok(/majorMesh\.material\.color\.setHex\(STYLE\.fillColor\)/.test(body), 'setStyle が fillColor を反映していない');
  assert.ok(/updateByCamera\(lastDistance != null \? lastDistance : OPACITY_NEAR_M\)/.test(body), 'setStyle が opacity を band 再計算していない');
  assert.ok(!/setStyle[\s\S]{0,400}geometry\.setAttribute/.test(body), 'setStyle がgeometryを再生成している疑い');
  assert.ok(/setStyle, getStyle, getDefaultStyle, getConflictDebug,/.test(html), 'setStyle/getStyle/getDefaultStyle が公開されていない');
});

test('[河川再導入] centerline+widthのribbon（left/right offset）を三角形化するだけで、area polygonを直接mesh化していない', () => {
  const startIdx = html.indexOf('const RiverLayerV2 = (function () {');
  const body = html.slice(startIdx, startIdx + 8000);
  assert.ok(/appendRibbonTriangles\(positions, r\.left, r\.right\)/.test(body), 'left/right offsetからribbonを組み立てていない');
  assert.ok(!/r\.p\b/.test(body), 'area feature の p(外周polygon) を直接参照している疑い');
});

test('[河川再導入] layer-toggle「河川」は RiverLayerV2.show/hide を呼ぶ', () => {
  const idx = html.indexOf("if (key === 'waterways') {");
  assert.ok(idx >= 0, 'waterways layer-toggle handler が見つからない');
  const block = html.slice(idx, idx + 500);
  assert.ok(/RiverLayerV2\.show\(\) : RiverLayerV2\.hide\(\)/.test(block), 'layer-toggle が RiverLayerV2 を操作していない');
});

test('[河川再導入] camUpd が毎フレーム RiverLayerV2.updateByCamera を呼ぶ', () => {
  assert.ok(/if \(typeof RiverLayerV2 !== 'undefined'\) RiverLayerV2\.updateByCamera\(cs\.r\);/.test(html),
    'camUpd が RiverLayerV2.updateByCamera を呼んでいない');
});

test('[河川再導入] RiverLayerV2 は起動時に自動初期化される（init()呼び出し）', () => {
  assert.ok(/RiverLayerV2\.init\(\); \/\/ \[河川再構築\]/.test(html), '起動時の RiverLayerV2.init() 呼び出しが無い');
});

test('protected baseline fullward-v3.html は本ラウンドの変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/RiverLayerV2|CleanWaterLayer/.test(fw), 'fullward-v3.html に RiverLayerV2 が混入');
  assert.ok(!/WATER_LAYER_ENABLED/.test(fw), 'fullward-v3.html に WATER_LAYER_ENABLED が混入');
});
