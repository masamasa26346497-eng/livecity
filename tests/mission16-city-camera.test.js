// tests/mission16-city-camera.test.js
// [見た目改善 Mission16] City Mode（大阪市全域）の初期カメラを「3D都市模型」向けに最適化する。
//   - 斜め上視点（真上禁止）、aspect-aware fit、preset を1箇所へ集約。
//   - Mission18 fog / CityBuildingLOD / RiverLayerV2 / road ribbon / projection は変更しない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { cityCameraTarget, CITY_CAMERA_PRESET } from '../tools/lib/city-mode.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const EXT = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };

test('[Mission16] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const s = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m16-${process.pid}.js`);
  fs.writeFileSync(f, s[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission16] CITY_CAMERA_PRESET が1箇所に集約され、magic number を散らさない', () => {
  assert.ok(/const CITY_CAMERA_PRESET = \{/.test(html), 'HTML に CITY_CAMERA_PRESET が無い');
  assert.ok(/const WARD_FOV = 60;/.test(html), 'WARD_FOV 定数が無い');
  assert.ok(/new THREE\.PerspectiveCamera\(WARD_FOV,/.test(html), 'camera 生成が WARD_FOV を使っていない');
  for (const k of ['elevationDeg', 'azimuthDeg', 'fov', 'marginFactor', 'targetYOffset', 'minRadius', 'maxRadius']) {
    assert.ok(new RegExp(`${k}:`).test(html.match(/const CITY_CAMERA_PRESET = \{[\s\S]*?\};/)[0]), `preset に ${k} が無い`);
  }
});

test('[Mission16] elevation は斜め上（真上でも水平でもない）40〜50°', () => {
  assert.ok(CITY_CAMERA_PRESET.elevationDeg >= 38 && CITY_CAMERA_PRESET.elevationDeg <= 50,
    `elevationDeg=${CITY_CAMERA_PRESET.elevationDeg}`);
  // HTML の enter() が polar角 = 90 - 仰角 で cs.ph を設定
  assert.ok(/cs\.ph = \(90 - CITY_CAMERA_PRESET\.elevationDeg\) \* Math\.PI \/ 180;/.test(html),
    'enter() が仰角→polar角の変換で cs.ph を設定していない');
  // camUpd で City Mode 中は overheadFactor（真上寄せ）を無効化
  assert.ok(/const ov = cityActive \? 0 : overheadFactor\(cs\.r\);/.test(html),
    'City Mode 中に overheadFactor を無効化していない（真上視点のままになる）');
});

test('[Mission16] azimuth は北向き（既存「北向き」方針を維持）', () => {
  assert.equal(CITY_CAMERA_PRESET.azimuthDeg, 0, 'City canonical azimuth が北(0)でない');
  assert.ok(/cs\.th = CITY_CAMERA_PRESET\.azimuthDeg \* Math\.PI \/ 180;/.test(html), 'enter() が azimuth を設定していない');
  // cs.th の初期値は 0 のまま（camera-north-up.test.js と整合）
  const csBlock = html.slice(html.indexOf('const cs = {'), html.indexOf('const cs = {') + 700);
  assert.ok(/th: 0,/.test(csBlock), 'cs.th 初期値が 0 でない');
});

test('[Mission16] FOV は City Mode 中のみ preset へ（Ward は WARD_FOV=60、change-only、自動復帰）', () => {
  assert.ok(CITY_CAMERA_PRESET.fov >= 40 && CITY_CAMERA_PRESET.fov <= 55, `city fov=${CITY_CAMERA_PRESET.fov}`);
  // [Mission 31G-FIX25] Ward側は WARD_FOV 固定から CAMERA_MODE_FOV[cameraMode] 経由へ拡張されたが、
  //   既定 cameraMode='current' では CAMERA_MODE_FOV.current === WARD_FOV のため実質的な挙動は不変。
  assert.ok(/const wantFov = cityActive \? CITY_CAMERA_PRESET\.fov : \(CAMERA_MODE_FOV\[cameraMode\] \|\| WARD_FOV\);/.test(html), 'camUpd の fov 切替が無い');
  assert.ok(/current: WARD_FOV,/.test(html), 'CAMERA_MODE_FOV.current が WARD_FOV でない');
  assert.ok(/if \(Math\.abs\(camera\.fov - wantFov\) > 0\.01\) \{ camera\.fov = wantFov; camera\.updateProjectionMatrix\(\); \}/.test(html),
    'fov 切替が change-only になっていない');
});

test('[Mission16] aspect-aware fit: landscape で bbox が収まり radius が maxR 内', () => {
  for (const [w, h] of [[1920, 1080], [1440, 900], [2560, 1440], [1366, 768]]) {
    const t = cityCameraTarget(EXT, { aspect: w / h, minR: 6000, maxR: 24000 });
    assert.equal(t.fitMode, 'aspect');
    assert.ok(t.radius >= 6000 && t.radius <= 24000, `${w}x${h} radius=${t.radius}`);
    // fit は横 fit / 縦 fit の大きい方 * margin
    assert.ok(Math.abs(t.fitDistance - Math.max(t.fitDistanceX, t.fitDistanceY) * t.margin) < 1,
      'fit が max(X,Y)*margin でない');
  }
});

test('[Mission16] portrait: 縦（南北）は必ず収まる。横（東西）は溢れてよいが radius は maxR でクランプ', () => {
  for (const [w, h] of [[390, 844], [430, 932]]) {
    const t = cityCameraTarget(EXT, { aspect: w / h, minR: 6000, maxR: 24000 });
    // 縦 fit 距離は maxR 以内（南北が画面外に切れない）
    assert.ok(t.fitDistanceY <= 24000, `portrait fitY=${t.fitDistanceY} > maxR`);
    // 横 fit は portrait では溢れるため fitX > fitY
    assert.ok(t.fitDistanceX > t.fitDistanceY, 'portrait で横 fit が縦 fit 以下（想定外）');
    assert.equal(t.radius, 24000, `portrait radius がクランプされていない: ${t.radius}`);
  }
});

test('[Mission16] margin は 1.06〜1.12（大阪市が画面の ~75〜90% を占める）', () => {
  assert.ok(CITY_CAMERA_PRESET.marginFactor >= 1.05 && CITY_CAMERA_PRESET.marginFactor <= 1.14,
    `margin=${CITY_CAMERA_PRESET.marginFactor}`);
});

test('[Mission16] targetYOffset は 0〜100m（地表全体が下へずれない程度）', () => {
  assert.ok(CITY_CAMERA_PRESET.targetYOffset >= 0 && CITY_CAMERA_PRESET.targetYOffset <= 100,
    `targetYOffset=${CITY_CAMERA_PRESET.targetYOffset}`);
  assert.ok(/cs\.tgt\.y = CITY_CAMERA_PRESET\.targetYOffset;/.test(html), 'enter() が target.y を設定していない');
});

test('[Mission16] radius は cs.minR/maxR（=preset min/max）でクランプ', () => {
  const narrow = cityCameraTarget(EXT, { aspect: 0.2, minR: 6000, maxR: 24000 }); // 極端な縦長 → 横 fit 巨大
  assert.equal(narrow.radius, 24000, 'maxR クランプが効いていない');
  const huge = cityCameraTarget({ minX: -100, maxX: 100, minZ: -100, maxZ: 100 }, { aspect: 1.778, minR: 6000, maxR: 24000 });
  assert.equal(huge.radius, 6000, 'minR クランプが効いていない');
});

test('[Mission16] City Mode entry でのみ fit（progressive load 中は camera を動かさない）', () => {
  // enter() で1回 getCityCameraTarget → flyTo。毎フレーム bbox 再計算しない。
  const enterBlock = html.match(/function enter\(\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(/const cam = getCityCameraTarget\(\);/.test(enterBlock), 'enter() が fit を1回計算していない');
  assert.ok(/flyTo\(cam\.x, cam\.z, \{ r: cam\.radius \}\)/.test(enterBlock), 'enter() が flyTo でカメラを移動していない');
  // camUpd / progressive load 経路に getCityCameraTarget 呼び出しが無い（entry と resize のみ）
  const camUpdBlock = html.match(/function camUpd\(\)\{[\s\S]*?\n\}/)[0];
  assert.ok(!/getCityCameraTarget/.test(camUpdBlock), 'camUpd が毎フレーム getCityCameraTarget を呼んでいる');
});

test('[Mission16] resize は「未操作のときだけ」再fit（操作済みなら初期視点へ戻さない）', () => {
  const onR = html.match(/function onR\(\)\{[\s\S]*?\n\}/)[0];
  assert.ok(/cityModeActive && cityFitSnapshot/.test(onR), 'resize が City Mode + snapshot を確認していない');
  assert.ok(/const moved = Math\.abs\(cs\.r - s\.r\)/.test(onR), 'resize が「操作済みか」を判定していない');
  assert.ok(/if \(!moved\) \{/.test(onR), 'operated 時に再fitをスキップしていない');
  // [Mission16 fix] camUpd/onR は TDZ 回避のため前方フラグ cityModeActive を参照する
  assert.ok(/let cityModeActive = false;/.test(html), 'cityModeActive フラグが無い');
  assert.ok(/const cityActive = cityModeActive;/.test(html), 'camUpd が cityModeActive を参照していない（typeof CityModeManager は TDZ）');
  assert.ok(/cityModeActive = true;/.test(html) && /cityModeActive = false;/.test(html), 'enter/exit が cityModeActive を同期していない');
});

test('[Mission16] Ward Mode 復帰で preset が漏れない（exit で elevation/azimuth/target.y を戻す）', () => {
  const exitBlock = html.match(/function exit\(nextWardId\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(/cs\.ph = Math\.PI \/ 4;/.test(exitBlock), 'exit() が cs.ph を Ward 既定(45°)へ戻していない');
  assert.ok(/cs\.th = 0;/.test(exitBlock), 'exit() が cs.th を北向きへ戻していない');
  assert.ok(/cs\.tgt\.y = 8;/.test(exitBlock), 'exit() が target.y を戻していない');
  assert.ok(/cityFitSnapshot = null;/.test(exitBlock), 'exit() が snapshot をクリアしていない');
});

test('[Mission16] Ward→City は既存 flyTo（900ms ease-out）を再利用、新 animation framework なし', () => {
  assert.ok(/const dur = 900, t0=performance\.now\(\);/.test(html), 'flyTo の duration が想定外');
  assert.ok(/const e = 1-Math\.pow\(1-t,3\);/.test(html), 'flyTo の ease-out が変わった');
  // 新しい tween/animation ライブラリを追加していない
  assert.ok(!/TWEEN|gsap|anime\.js|requestAnimationFrame\(cityCameraAnim/.test(html), 'animation framework が追加された');
});

test('[緊急回帰修正] flyTo.step() の camUpd() は try/catch で守られ rAF チェーンを止めない', () => {
  const flyTo = html.match(/function flyTo\(x, z, opts=\{\}\)\{[\s\S]*?\n\}/)[0];
  assert.ok(/try \{ camUpd\(\); \} catch/.test(flyTo), 'flyTo.step() の camUpd() が try/catch で守られていない');
  assert.ok(/if\(t<1\) searchAnim = requestAnimationFrame\(step\);/.test(flyTo), 'flyTo の rAF 再スケジュールが消えた');
});

test('[緊急回帰修正] enter() に City fit フォールバック（flyTo 未収束時に snapshot を直接適用）', () => {
  const enterBlock = html.match(/function enter\(\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(/setTimeout\(function \(\) \{/.test(enterBlock), 'enter() に フォールバック setTimeout が無い');
  assert.ok(/var notConverged = Math\.abs\(cs\.r - s\.r\)/.test(enterBlock), 'フォールバックが収束判定していない');
  assert.ok(/cs\.tgt\.x = s\.tx; cs\.tgt\.z = s\.tz; cs\.r = s\.r; cs\.th = s\.th; cs\.ph = s\.ph;/.test(enterBlock),
    'フォールバックが cityFitSnapshot を cs へ適用していない');
  // フォールバックは entry 1 回だけ（毎フレームのループには入れない）
  const camUpdBlock = html.match(/function camUpd\(\)\{[\s\S]*?\n\}/)[0];
  assert.ok(!/cityFitSnapshot/.test(camUpdBlock), 'camUpd が cityFitSnapshot を参照している（entry 限定のはず）');
});

test('[Mission16] Mission18 fog は不変（値・関数を変更しない）', () => {
  assert.ok(/const MODEL_FOG = \{[\s\S]*?DIST_FAR: 16000[\s\S]*?MAX_FAR: 40000/.test(html), 'Mission18 MODEL_FOG が変わった');
  assert.ok(/function modelDayFogRange\(cameraDist\)\{/.test(html), 'modelDayFogRange が消えた');
});

test('[Mission16] CityBuildingLOD / RiverLayerV2 / road ribbon は不変', () => {
  assert.ok(/const CityBuildingLOD = \(function \(\) \{/.test(html), 'CityBuildingLOD が消えた');
  assert.ok(/const HIDE_NEAR_M = 4000;/.test(html), 'CityBuildingLOD の handoff 距離が変わった');
  assert.ok(/const ROAD_RIBBON_COLOR = \{ major: 0xb8bdc3, mid: 0xc4c8cc, local: 0xd0d3d6 \};/.test(html), '道路 ribbon 色が変わった');
  assert.ok(/fillColor: 0x9ed6e6/.test(html), '河川色が変わった');
});

test('[Mission16] projection / znorth-neg-v1 不変', () => {
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(html), 'projection 式が変わった');
});

test('[Mission16] clip plane: camera.far は City 距離で十分（無制限拡大はしない）', () => {
  assert.ok(/const wantFar = Math\.max\(14000, cs\.r \* 1\.6 \+ 16000\);/.test(html), 'camera.far の動的式が変わった');
  // r=18382 → far ≈ 45411、r=24000 → 54400。City bbox（camera から最大 ~35km）を覆う。過剰拡大なし。
});

test('[Mission16] debug API: __CITY_CAMERA_DEBUG__ / __CITY_CAMERA_PREVIEW__', () => {
  assert.ok(/window\.__CITY_CAMERA_DEBUG__ = function \(\) \{/.test(html), '__CITY_CAMERA_DEBUG__ が無い');
  const dbg = html.match(/window\.__CITY_CAMERA_DEBUG__ = function \(\) \{[\s\S]*?\n\};/)[0];
  for (const k of ['position', 'target', 'radius', 'elevationDeg', 'azimuthDeg', 'fov', 'aspect', 'cityBBox',
    'cityWidth', 'cityDepth', 'fitDistanceX', 'fitDistanceY', 'fitDistance', 'margin', 'fogNear', 'fogFar']) {
    assert.ok(dbg.includes(k), `__CITY_CAMERA_DEBUG__ に ${k} が無い`);
  }
  assert.ok(/window\.__CITY_CAMERA_PREVIEW__ = function \(dir, elevationDeg\) \{/.test(html), '__CITY_CAMERA_PREVIEW__ が無い');
});

test('[Mission16] canonical lib と HTML の preset 値が一致', () => {
  const m = html.match(/const CITY_CAMERA_PRESET = \{([\s\S]*?)\};/)[1];
  const num = (k) => parseFloat(m.match(new RegExp(`${k}:\\s*([0-9.]+)`))[1]);
  assert.equal(num('elevationDeg'), CITY_CAMERA_PRESET.elevationDeg);
  assert.equal(num('fov'), CITY_CAMERA_PRESET.fov);
  assert.equal(num('marginFactor'), CITY_CAMERA_PRESET.marginFactor);
  assert.equal(num('headroomM'), CITY_CAMERA_PRESET.headroomM);
});

test('protected baseline fullward-v3.html は Mission16 の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/CITY_CAMERA_PRESET|__CITY_CAMERA_DEBUG__|cityFitSnapshot|WARD_FOV/.test(fw), 'fullward-v3.html に Mission16 の変更が混入');
});

test('[Mission 32U] production osaka_3d_buildings.html は promoted build（Mission16 を含む）', () => {
  const prod = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.html'), 'utf-8');
  assert.ok(/CITY_CAMERA_PRESET|__CITY_CAMERA_DEBUG__/.test(prod), 'production HTML に Mission16 の内容が無い（32U cutover 後の production は ward-ux-v1 から生成した promoted build）');
});
