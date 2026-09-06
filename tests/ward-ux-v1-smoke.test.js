// tests/ward-ux-v1-smoke.test.js
// ランタイム・スモークテスト: ward-ux-v1.html のインライン <script> を DOM/THREE スタブ下で実際に
//   実行し、モジュール評価時に例外（TDZ ReferenceError・未定義参照など）で停止しないことを確認する。
//   regex / `node --check` では検出できない「ページを開くと真っ白」クラスの回帰を防ぐ。
//   （Mission16 で camUpd 内の `typeof CityModeManager`（後方 const の TDZ）が実際にこれを引き起こした。）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const require = createRequire(import.meta.url);
const { runInlineScript } = require('./_ward-ux-v1-smoke-harness.cjs');

test('[smoke] ward-ux-v1.html のインライン script がモジュール評価で例外停止しない', () => {
  const r = runInlineScript(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'));
  if (!r.ok) {
    const stack = r.error && r.error.stack ? r.error.stack.split('\n').slice(0, 8).join('\n') : String(r.error);
    assert.fail('インライン script が top-level で throw しました（ページが真っ白になる）:\n' + stack);
  }
});

test('[smoke] 主要な camera / fog / background デバッグ API が呼び出せる（実行が完走している証跡）', () => {
  const r = runInlineScript(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'));
  assert.ok(r.ok, 'script 実行が失敗');
  const w = r.window;
  for (const api of ['__BACKGROUND_DEBUG__', '__FOG_LIGHT_DEBUG__', '__CITY_CAMERA_DEBUG__']) {
    assert.equal(typeof w[api], 'function', `${api} が定義されていない（初期化が途中で止まった可能性）`);
    const out = w[api]();
    assert.ok(out && typeof out === 'object', `${api}() がオブジェクトを返さない`);
  }
  // Mission18: Ward 既定距離(5300) で fog.near が MIN_NEAR 以上（近景が霞まない設計）
  const fl = w.__FOG_LIGHT_DEBUG__();
  assert.ok(fl.fogNear >= 6000 && fl.fogFar <= 40000, `fog レンジが想定外: near=${fl.fogNear} far=${fl.fogFar}`);
  // Mission16: aspect-aware fit の中間値が算出されている
  const cc = w.__CITY_CAMERA_DEBUG__();
  assert.ok(cc.fitDistance > 12000 && cc.fitDistance <= 30000, `city fitDistance が想定外: ${cc.fitDistance}`);
});

test('[smoke] protected baseline fullward-v3.html も評価停止しない', () => {
  const r = runInlineScript(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'));
  if (!r.ok) {
    const stack = r.error && r.error.stack ? r.error.stack.split('\n').slice(0, 8).join('\n') : String(r.error);
    assert.fail('fullward-v3.html のインライン script が throw:\n' + stack);
  }
});
