// tests/mission18-fog-lighting.test.js
// [見た目改善 Mission18] MODEL_STYLE + day の fog を「都市模型の空気遠近」として最適化する。
//   camera 距離を clamp + smoothstep 補間、fog.far を MAX_FAR で頭打ち。fog.color(Mission17) と
//   lighting(Mission09) は変更しない。evening/night・legacy は従来ロジック維持。新 render pass 禁止。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

// HTML 内の MODEL_FOG / modelDayFogRange を抽出して純粋関数として再現する
function loadModelFog() {
  const m = html.match(/const MODEL_FOG = \{[\s\S]*?\n\};/);
  const smooth = html.match(/function modelFogSmooth\(t\)\{[^}]*\}/);
  const range = html.match(/function modelDayFogRange\(cameraDist\)\{[\s\S]*?\n\}/);
  assert.ok(m && smooth && range, 'MODEL_FOG / helpers が見つからない');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}\n${smooth[0]}\n${range[0]}\nreturn { MODEL_FOG, modelDayFogRange };`)();
}

test('[Mission18] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const s = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m18-${process.pid}.js`);
  fs.writeFileSync(f, s[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission18] fog color は Mission17 の MS_BG_NEUTRAL を維持（今回 fog 色は変えない）', () => {
  assert.ok(/const skyHex = modelDay \? MS_BG_NEUTRAL/.test(html), 'skyHex が変わった');
  assert.ok(/const fogHex = modelDay \? MS_BG_NEUTRAL/.test(html), 'fogHex が変わった');
  assert.ok(/scene\.fog\.color\.setHex\(fogHex\);/.test(html), 'fog 色の適用が消えた');
});

test('[Mission18] MIN/MAX fog near/far が明示されている', () => {
  const { MODEL_FOG } = loadModelFog();
  assert.ok(MODEL_FOG.MIN_NEAR >= 4000 && MODEL_FOG.MIN_NEAR <= 8000, `MIN_NEAR=${MODEL_FOG.MIN_NEAR}`);
  assert.ok(MODEL_FOG.MAX_NEAR > MODEL_FOG.MIN_NEAR && MODEL_FOG.MAX_NEAR <= 14000, `MAX_NEAR=${MODEL_FOG.MAX_NEAR}`);
  assert.ok(MODEL_FOG.MIN_FAR >= 14000 && MODEL_FOG.MIN_FAR <= 24000, `MIN_FAR=${MODEL_FOG.MIN_FAR}`);
  assert.ok(MODEL_FOG.MAX_FAR >= 34000 && MODEL_FOG.MAX_FAR <= 44000, `MAX_FAR=${MODEL_FOG.MAX_FAR}（無制限後退の防止）`);
  assert.ok(MODEL_FOG.MIN_FAR > MODEL_FOG.MAX_NEAR, 'MIN_FAR <= MAX_NEAR（near/far が逆転しうる）');
});

test('[Mission18] fog.far は MAX_FAR で頭打ち（cs.r*3.6 の無制限後退を廃止）', () => {
  const { MODEL_FOG, modelDayFogRange } = loadModelFog();
  for (const d of [16000, 20000, 24000, 100000]) {
    const r = modelDayFogRange(d);
    assert.ok(r.far <= MODEL_FOG.MAX_FAR + 1, `d=${d} far=${r.far} > MAX_FAR`);
    assert.ok(r.near <= MODEL_FOG.MAX_NEAR + 1, `d=${d} near=${r.near} > MAX_NEAR`);
  }
  // City Mode 最大ズームアウト相当でも far は MAX で一定
  assert.equal(modelDayFogRange(24000).far, modelDayFogRange(60000).far, 'far が MAX でクランプされていない');
});

test('[Mission18] fog.near は MIN_NEAR 下限（Ward 近景が霞まない）', () => {
  const { MODEL_FOG, modelDayFogRange } = loadModelFog();
  for (const d of [0, 500, 1000, 3000]) {
    const r = modelDayFogRange(d);
    assert.equal(r.near, MODEL_FOG.MIN_NEAR, `d=${d} near=${r.near} != MIN_NEAR`);
    assert.equal(r.far, MODEL_FOG.MIN_FAR, `d=${d} far=${r.far} != MIN_FAR`);
  }
});

test('[Mission18] Ward Mode 想定距離: near view はクリア（fog.near がカメラより十分遠い）', () => {
  const { modelDayFogRange } = loadModelFog();
  // Ward 既定 cs.r=5300
  const w = modelDayFogRange(5300);
  assert.ok(w.near >= 6000 && w.near <= 8000, `ward near=${w.near}`);
  assert.ok(w.far >= 18000 && w.far <= 24000, `ward far=${w.far}`);
});

test('[Mission18] City Mode 想定距離: 遠景は背景へ溶けるが far は上限内', () => {
  const { MODEL_FOG, modelDayFogRange } = loadModelFog();
  // City 全景 radius ≈ 15900（getCityCameraTarget: diag*0.5）
  const c = modelDayFogRange(15900);
  assert.ok(c.near >= 10000 && c.near <= 12000, `city near=${c.near}`);
  assert.ok(c.far >= 34000 && c.far <= MODEL_FOG.MAX_FAR, `city far=${c.far}`);
});

test('[Mission18] 補間は連続（smoothstep・急なバンド切替なし）', () => {
  const { modelDayFogRange } = loadModelFog();
  let prevNear = -Infinity, prevFar = -Infinity;
  for (let d = 0; d <= 30000; d += 250) {
    const r = modelDayFogRange(d);
    // 単調非減少
    assert.ok(r.near >= prevNear - 1e-6, `near が減少 d=${d}`);
    assert.ok(r.far >= prevFar - 1e-6, `far が減少 d=${d}`);
    // 1 ステップの跳ね上がりが小さい（連続）
    if (prevNear > -Infinity) {
      assert.ok(r.near - prevNear < 200, `near のステップが大きい d=${d}`);
      assert.ok(r.far - prevFar < 700, `far のステップが大きい d=${d}`);
    }
    prevNear = r.near; prevFar = r.far;
  }
});

test('[Mission18] updateFogForCameraDistance が model-day 分岐を持ち、camUpd から呼ばれる', () => {
  assert.ok(/function isModelDayFog\(\)\{/.test(html), 'isModelDayFog 未定義');
  assert.ok(/function updateFogForCameraDistance\(\)\{[\s\S]*?if \(isModelDayFog\(\)\) \{[\s\S]*?modelDayFogRange\(r\)/.test(html),
    'updateFogForCameraDistance の model-day 分岐が無い');
  assert.ok(/camUpd\(\)\{[\s\S]{0,120}updateFogForCameraDistance\(\)/.test(html), 'camUpd から呼ばれていない');
});

test('[Mission18] evening/night / legacy / data は従来ロジック（cs.r*3.6 / L.fogFar）を維持', () => {
  // model-day でないときは従来式
  assert.ok(/const far = Math\.max\(baseFar, cs\.r \* 3\.6\);/.test(html), 'legacy fog 後退式が消えた');
  assert.ok(/scene\.fog\.near = Math\.min\(baseNear, far \* 0\.35\);/.test(html), 'legacy fog near 式が消えた');
  // isModelDayFog は day かつ MODEL_STYLE.on かつ data でない
  assert.ok(/currentTimeOfDay === 'day'/.test(html) && /VISUAL_CONFIG\.mode\.current === 'data'/.test(html),
    'isModelDayFog の条件が不足');
  // VISUAL_CONFIG.lighting の evening/night 値は不変
  assert.ok(/evening: \{[\s\S]*?fogNear: 1600, fogFar: 5200/.test(html), 'evening fog 値が変わった');
  assert.ok(/night: \{[\s\S]*?fogNear: 800, fogFar: 3200/.test(html), 'night fog 値が変わった');
});

test('[Mission18] Lighting は Mission09 の比率を維持（今回 light は変更しない）', () => {
  assert.ok(/hemiLight\.intensity = modelDay \? 1\.02/.test(html), 'hemi が変わった');
  assert.ok(/sun\.intensity = modelDay \? 1\.08/.test(html), 'sun が変わった');
  assert.ok(/fillLight\.intensity = modelDay \? 0\.30/.test(html), 'fill が変わった');
  // sun >= hemi の方向
  assert.ok(1.08 >= 1.02, 'sun < hemi');
});

test('[Mission18] camera 依存の lighting 暴走がない（fog 関数内で sun/hemi intensity を書かない）', () => {
  const fogFn = html.match(/function updateFogForCameraDistance\(\)\{[\s\S]*?\n\}/)[0];
  assert.ok(!/sun\.intensity|hemiLight\.intensity|fillLight\.intensity/.test(fogFn),
    'fog 関数が light intensity を変更している（役割分離違反）');
  const modelFogBlock = html.match(/const MODEL_FOG = \{[\s\S]*?function modelDayFogRange[\s\S]*?\n\}/)[0];
  assert.ok(!/intensity/.test(modelFogBlock), 'MODEL_FOG まわりが light に触れている');
});

test('[Mission18] post-processing / SSAO / volumetric を追加していない', () => {
  assert.ok(!/EffectComposer|RenderPass|ShaderPass|SSAO|UnrealBloom|SAOPass|FogExp2/.test(html),
    'post-processing / screen-space effect / FogExp2 が追加された');
  assert.ok(/scene\.fog = new THREE\.Fog\(/.test(html), '既存の THREE.Fog を使っていない');
});

test('[Mission18] window.__FOG_LIGHT_DEBUG__ が必要フィールドを返す', () => {
  assert.ok(/window\.__FOG_LIGHT_DEBUG__ = function \(\) \{/.test(html), 'debug API が無い');
  const m = html.match(/window\.__FOG_LIGHT_DEBUG__ = function \(\) \{[\s\S]*?\n\};/);
  for (const k of ['cameraDistance', 'fogNear', 'fogFar', 'fogColor', 'sunIntensity', 'hemiIntensity',
    'fillIntensity', 'sunCastShadow', 'modelStyle', 'timeMode']) {
    assert.ok(m[0].includes(k), `debug に ${k} が無い`);
  }
});

test('[Mission18] Mission17 / drawCalls に影響なし', () => {
  assert.ok(/const MS_BG_NEUTRAL = 0xf3f4f1;/.test(html), 'Mission17 背景色が変わった');
  assert.ok(/GROUND_VISUAL_STYLE\.colorReal = MODEL_STYLE\.on \? MS_BG_NEUTRAL/.test(html), 'Mission17 地表色が変わった');
  assert.ok(/drawCalls: 1,/.test(html), 'GroundVisualLayer の Draw Call が変わった');
});

test('protected baseline fullward-v3.html は Mission18 の変更を含まない', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/MODEL_FOG|modelDayFogRange|__FOG_LIGHT_DEBUG__|isModelDayFog/.test(fw), 'fullward-v3.html に Mission18 の変更が混入');
});

test('production osaka_3d_buildings.html は Mission18 の変更を含まない', () => {
  const prod = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.html'), 'utf-8');
  assert.ok(!/MODEL_FOG|modelDayFogRange|__FOG_LIGHT_DEBUG__/.test(prod), 'production HTML に Mission18 の変更が混入');
});
