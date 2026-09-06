// tests/model-style-p16h.test.js
// P1-6H: 都市模型スタイルのパレット/不透明度ヘルパ（tools/lib/model-style.js）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blendHexToward, modelBuildingColor, hexToRgb, rgbToHex,
  modelWaterFillOpacity, modelShorelineOpacity, MODEL_WATER_COLOR, MODEL_BUILDING_WHITE,
} from '../tools/lib/model-style.js';

test('blendHexToward: 端点と中点', () => {
  assert.equal(blendHexToward(0x000000, 0xffffff, 0), 0x000000);
  assert.equal(blendHexToward(0x000000, 0xffffff, 1), 0xffffff);
  assert.equal(blendHexToward(0x000000, 0xffffff, 0.5), 0x808080);
  assert.equal(blendHexToward(0x204060, 0x204060, 0.7), 0x204060);
});

test('modelBuildingColor: 鮮やかな用途色が白寄り・低彩度になる', () => {
  const before = 0xa8dcea; // アクアマリン
  const after = modelBuildingColor(before);
  const b = hexToRgb(before), a = hexToRgb(after);
  // 明るく（各チャンネル >= 元） かつ チャンネル差（彩度）が縮む
  const satBefore = Math.max(b.r, b.g, b.b) - Math.min(b.r, b.g, b.b);
  const satAfter = Math.max(a.r, a.g, a.b) - Math.min(a.r, a.g, a.b);
  assert.ok(satAfter < satBefore * 0.35, `彩度が十分落ちていない: ${satBefore} -> ${satAfter}`);
  // ほぼ白（全チャンネル > 210）
  assert.ok(a.r > 210 && a.g > 210 && a.b > 210, JSON.stringify(a));
});

test('modelWaterFillOpacity: 近景で薄い塗り / 遠景で 0（板・帯を作らない）', () => {
  const near = modelWaterFillOpacity({ distance: 1500, family: 'linear' });
  const mid = modelWaterFillOpacity({ distance: 4000, family: 'linear' });
  const far = modelWaterFillOpacity({ distance: 8000, family: 'linear' });
  assert.ok(near <= 0.32 && near >= 0.22, `near=${near}`);
  assert.ok(mid < near && mid > 0);
  assert.equal(far, 0, `far=${far} (遠景は完全に消える)`);
});

test('modelWaterFillOpacity: 巨大河川はより早く薄く消える', () => {
  const g = modelWaterFillOpacity({ distance: 4000, family: 'linear', giant: true });
  const n = modelWaterFillOpacity({ distance: 4000, family: 'linear', giant: false });
  assert.ok(g < n, `giant=${g} normal=${n}`);
  assert.equal(modelWaterFillOpacity({ distance: 5500, family: 'linear', giant: true }), 0);
});

test('modelWaterFillOpacity: basin（池・湖）は距離があっても残る / harbour は最初から極薄', () => {
  assert.ok(modelWaterFillOpacity({ distance: 8000, family: 'basin' }) >= 0.12);
  assert.ok(modelWaterFillOpacity({ distance: 3000, family: 'harbour' }) <= 0.12);
  assert.equal(modelWaterFillOpacity({ distance: 12000, family: 'harbour' }), 0);
});

test('modelWaterFillOpacity: mode 切替（legacy / shoreline）', () => {
  assert.equal(modelWaterFillOpacity({ distance: 3000, mode: 'legacy', family: 'linear' }), 0.5);
  assert.equal(modelWaterFillOpacity({ distance: 3000, mode: 'shoreline', family: 'linear' }), 0);
});

test('modelShorelineOpacity: 遠景で fill が消える分だけ岸線をやや強める', () => {
  const near = modelShorelineOpacity({ distance: 2000 });
  const far = modelShorelineOpacity({ distance: 8000 });
  assert.ok(far > near, `near=${near} far=${far}`);
  assert.ok(far <= 0.55 && near >= 0.15);
  assert.equal(modelShorelineOpacity({ distance: 3000, mode: 'legacy' }), 0);
});

test('MODEL_WATER_COLOR: 3ファミリとも淡いシアン系（青が最大チャンネル・全体的に明るい）', () => {
  for (const k of ['linear', 'basin', 'harbour']) {
    const c = hexToRgb(MODEL_WATER_COLOR[k]);
    assert.ok(c.b >= c.r && c.b >= c.g, `${k}: 青が最大でない`);
    assert.ok(c.r > 140 && c.g > 180 && c.b > 190, `${k}: 淡くない ${JSON.stringify(c)}`);
  }
});
