'use strict';
// Mission 60: 保存済み QA 結果の整合と、QA フックが localhost + ?qa=1 限定であること（描画コードは無変更）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');
const proj = JSON.parse(fs.readFileSync('data/reports/mission60/parallax-proj.json', 'utf8'));

test('setFov は QA フック内（localhost かつ ?qa=1 限定）にのみ存在する', () => {
  const hook = html.indexOf('window.__mission37dQA = {');
  const gate = html.lastIndexOf("location.hostname", hook);
  assert.ok(hook > 0 && gate > 0 && hook - gate < 400);
  assert.ok(html.indexOf('setFov(deg)') > hook);
  assert.strictEqual(html.split('setFov(deg)').length, 2);
});

test('透視視差: 34.4m の屋根は通常カメラで中心から 100m 離れると約 10m 見かけ上ずれ、ほぼ正射影ではほぼ 0', () => {
  const pick = (cam, off, H) => proj.cases.find((c) => c.cam === cam && c.offsetFromCentreM === off && c.roofHeightM === H);
  assert.ok(pick('persp60-r350', 100, 34.4).roofVsFootM > 8);
  assert.ok(pick('ortho-like-fov2-r12000', 100, 34.4).roofVsFootM < 0.5);
  assert.strictEqual(pick('persp60-r350', 0, 34.4).roofVsFootM, 0);
});

test('背景 tilingScheme 仮説の否定: 既定は WebMercator のためコードに tilingScheme 指定を足していない', () => {
  assert.ok(!/tilingScheme/.test(html.split('const BASEMAPS')[1].slice(0, 1800)));
});

test('QA は外部 GET を絞っている（スタブ応答と予算）', () => {
  for (const f of ['mission60_tiling_ab_qa.mjs', 'mission60_parallax_qa.mjs', 'mission60_parallax_proj.mjs']) {
    const s = fs.readFileSync('tools/experiments/' + f, 'utf8');
    assert.ok(/Fetch\.fulfillRequest/.test(s));
  }
  assert.ok(/BUDGET\s*=\s*45/.test(fs.readFileSync('tools/experiments/mission60_parallax_qa.mjs', 'utf8')));
});
