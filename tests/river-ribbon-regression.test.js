// tests/river-ribbon-regression.test.js
// [河川再構築] 実データ regression（指示書12節）: 淀川・大和川・神崎川について、
//   ribbonがcenterlineに沿っている・bboxがcenterline周辺・幅が異常に広がらない・
//   数km離れたvertexが無いことを実際に生成された public/map-data/osaka-city/rivers-v2/rivers.json
//   に対して検証する（fixture化はせず、生成済み実データそのものを対象にする。データが
//   無い/古い環境では build-river-layer.js の再実行を促してskipする）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { validateRiverRibbon } from '../tools/lib/river-ribbon-validator.js';
import { RIVER_WIDTH_LIMITS } from '../tools/lib/river-width.js';

const DATA_PATH = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json');
const hasData = fs.existsSync(DATA_PATH);

test('実データ regression: 淀川・大和川・神崎川 の ribbon が構造的に破綻していない', { skip: !hasData && 'rivers.json 未生成（node tools/build-river-layer.js を実行してください）' }, () => {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  assert.equal(data.coordinateConvention, 'znorth-neg-v1');
  const rivers = data.rivers || [];
  assert.ok(rivers.length > 0, 'rivers が空');

  for (const name of ['淀川', '大和川', '神崎川']) {
    const segs = rivers.filter((r) => r.name === name);
    assert.ok(segs.length > 0, `${name} のcenterlineが見つからない`);
    for (const seg of segs) {
      assert.equal(seg.ok, true, `${name}(${seg.id}) ribbon生成失敗: ${seg.reason}`);
      // 幅が有限かつ許容範囲内
      assert.ok(Number.isFinite(seg.width) && seg.width >= RIVER_WIDTH_LIMITS.min && seg.width <= RIVER_WIDTH_LIMITS.max,
        `${name}(${seg.id}) width異常: ${seg.width}`);
      // centerlineから数km離れたvertexが無い（bboxがcenterline+width程度に収まる）。
      // WARN（source node間隔が疎等、要目視確認レベル）は許容するが、ERRORは許容しない。
      const { errors } = validateRiverRibbon(seg);
      assert.deepEqual(errors, [], `${name}(${seg.id}) validator ERROR: ${JSON.stringify(errors)}`);
      // 巨大三角形なし（直接の数値チェックも重ねる）
      assert.ok(seg.maxTriangleArea < 30000, `${name}(${seg.id}) maxTriangleArea=${seg.maxTriangleArea}`);
    }
  }
});

test('実データ regression: 河川ribbonは全172本が build成功・ERROR 0', { skip: !hasData && 'rivers.json 未生成' }, () => {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const rivers = data.rivers || [];
  const failed = rivers.filter((r) => r.ok === false);
  assert.deepEqual(failed.map((r) => r.id), [], 'ribbon生成に失敗したriverがある');
  const withErrors = rivers.filter((r) => (r.validationErrors || []).length > 0);
  assert.deepEqual(withErrors.map((r) => r.id), [], 'validator ERRORが残っているriverがある');
});

test('実データ regression: waterway=river/canal/riverbank 以外（pond/lake/reservoir/harbour/stream）は含まれない', { skip: !hasData && 'rivers.json 未生成' }, () => {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const classes = new Set((data.rivers || []).map((r) => r.waterClass));
  for (const c of classes) assert.ok(c === 'river' || c === 'canal', `対象外のwaterClassが混入: ${c}`);
});
