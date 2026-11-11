// Mission 172: ClippingPolygon の既定 OFF を保護する(静的テスト)。
// 根拠: headless Chrome + 37G 実ページで、足跡 1 件=4 区とも描画 / 足跡 41 件(大阪全域に散布)=ページが固まり 250 秒で未完 /
//       足跡 10,698 件でクリップ OFF=4 区とも描画(画素差>200)。実 GPU での挙動は未測定。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = fs.readFileSync(path.join(ROOT, 'tools/lod2/lod2-overlay.js'), 'utf8');

test('overlay: クリップは ?lod2clip=1 の明示 opt-in のときだけ適用される', () => {
  assert.match(src, /get\('lod2clip'\)\s*===\s*'1'/);
  assert.match(src, /if \(CLIP\) applyClip\(\)/);
  assert.match(src, /if \(CLIP\) scene\.postRender/);
  assert.doesNotMatch(src, /^\s*applyClip\(\);/m, 'applyClip() の無条件呼び出しが復活している');
});
test('overlay: クリップ OFF で Cesium に ClippingPolygon が無くても LOD2 を拒否しない', () => {
  assert.match(src, /if \(CLIP && \(!Cesium\.ClippingPolygonCollection/);
});
test('E2E スクリプトが存在し、37G の実ページを測る', () => {
  const e = fs.readFileSync(path.join(ROOT, 'tools/lod2/lod2-e2e-24ward.cjs'), 'utf8');
  assert.match(e, /mission37g-osaka-24ward-mvp\.html/);
  assert.match(e, /pixelDiff/);
});
