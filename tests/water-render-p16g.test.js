// tests/water-render-p16g.test.js
// P1-6G: 水域の分類（tools/lib/water-classify.js）と距離 LOD / 岸線生成（tools/lib/water-render-lod.js）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { classifyWater, waterRenderFamily } from '../tools/lib/water-classify.js';
import {
  waterLodParams, waterBand, isGiantWater, shorelineSegments3D, bboxDiagOf, GIANT_DIAG_M,
} from '../tools/lib/water-render-lod.js';

test('classifyWater: 主要タグ', () => {
  assert.equal(classifyWater({ waterway: 'riverbank', name: '淀川' }), 'river');
  assert.equal(classifyWater({ natural: 'water', water: 'river' }), 'river');
  assert.equal(classifyWater({ waterway: 'canal' }), 'canal');
  assert.equal(classifyWater({ natural: 'water', water: 'pond' }), 'pond');
  assert.equal(classifyWater({ natural: 'water', water: 'reservoir' }), 'reservoir');
  assert.equal(classifyWater({ natural: 'water', water: 'lake' }), 'lake');
  assert.equal(classifyWater({ natural: 'coastline' }), 'harbour');
  assert.equal(classifyWater({ natural: 'water', harbour: 'yes' }), 'harbour');
  assert.equal(classifyWater({ natural: 'water' }), 'water'); // subtype 不明
});

test('waterRenderFamily: river→linear / pond→basin / 不明大→linear・不明小→basin / harbour', () => {
  assert.equal(waterRenderFamily('river'), 'linear');
  assert.equal(waterRenderFamily('canal'), 'linear');
  assert.equal(waterRenderFamily('pond'), 'basin');
  assert.equal(waterRenderFamily('reservoir'), 'basin');
  assert.equal(waterRenderFamily('harbour'), 'harbour');
  assert.equal(waterRenderFamily('water', 2000), 'linear');
  assert.equal(waterRenderFamily('water', 200), 'basin');
});

test('waterBand: 距離しきい値 6000 / 3000', () => {
  assert.equal(waterBand(9000), 'far');
  assert.equal(waterBand(5000), 'mid');
  assert.equal(waterBand(1500), 'near');
});

test('LOD linear: far=岸線のみ(fill非表示) / mid=薄fill+岸線 / near=fill+岸線', () => {
  const far = waterLodParams({ distance: 8000, family: 'linear' });
  assert.equal(far.fillVisible, false);
  assert.equal(far.shorelineVisible, true);

  const mid = waterLodParams({ distance: 4500, family: 'linear' });
  assert.equal(mid.fillVisible, true);
  assert.ok(mid.fillOpacity > 0 && mid.fillOpacity < 0.25);
  assert.equal(mid.shorelineVisible, true);

  const near = waterLodParams({ distance: 1000, family: 'linear' });
  assert.equal(near.fillVisible, true);
  assert.ok(near.fillOpacity >= 0.25);
  assert.equal(near.shorelineVisible, true);
});

test('LOD 巨大河川: 早く薄く消える（mid でごく僅か・5200m 以遠で 0・near でも控えめ）', () => {
  const g = { distance: 4500, family: 'linear', bboxDiag: 5000 };
  assert.equal(isGiantWater(g), true);
  assert.ok(waterLodParams(g).fillOpacity < 0.06, `giant mid fill=${waterLodParams(g).fillOpacity}`);
  assert.equal(waterLodParams({ distance: 5300, family: 'linear', bboxDiag: 5000 }).fillOpacity, 0);
  const near = waterLodParams({ distance: 1200, family: 'linear', bboxDiag: 5000 });
  assert.ok(near.fillVisible && near.fillOpacity <= 0.22);
  // 同距離で normal 河川より giant の方が薄い
  assert.ok(waterLodParams({ distance: 3500, family: 'linear', bboxDiag: 5000 }).fillOpacity
    < waterLodParams({ distance: 3500, family: 'linear', bboxDiag: 800 }).fillOpacity);
});

test('[P1-7B] City Mode 遠景: linear は 9000m 以遠で岸線がさらに減衰し 20000m で 0.12 まで下がる（basin/harbourは対象外）', () => {
  const at9000 = waterLodParams({ distance: 9000, family: 'linear' });
  const at14500 = waterLodParams({ distance: 14500, family: 'linear' });
  const at20000 = waterLodParams({ distance: 20000, family: 'linear' });
  assert.ok(at14500.shorelineOpacity < at9000.shorelineOpacity,
    `14500m の岸線(${at14500.shorelineOpacity})は9000m(${at9000.shorelineOpacity})より弱いはず`);
  assert.ok(Math.abs(at20000.shorelineOpacity - 0.12) < 1e-9, `20000m 岸線=${at20000.shorelineOpacity}`);
  // 巨大河川でも同様に減衰する
  const giantAt9000 = waterLodParams({ distance: 9000, family: 'linear', bboxDiag: 5000 });
  const giantAt20000 = waterLodParams({ distance: 20000, family: 'linear', bboxDiag: 5000 });
  assert.ok(giantAt20000.shorelineOpacity < giantAt9000.shorelineOpacity);
  // basin/harbour は City Mode 遠景減衰の対象外（9000m 以遠でも変化しない）
  const basin9000 = waterLodParams({ distance: 9000, family: 'basin' }).shorelineOpacity;
  const basin20000 = waterLodParams({ distance: 20000, family: 'basin' }).shorelineOpacity;
  assert.equal(basin9000, basin20000, 'basin は 9000m 以遠でも岸線 opacity が変わらない');
});

test('LOD basin: 距離によらず fill 表示（板に見えないコンパクト水面）', () => {
  for (const d of [800, 4000, 9000]) {
    assert.equal(waterLodParams({ distance: d, family: 'basin' }).fillVisible, true);
  }
});

test('LOD harbour: 岸線なし・ごく薄い fill・極遠景で消える', () => {
  const h = waterLodParams({ distance: 4000, family: 'harbour' });
  assert.equal(h.shorelineVisible, false);
  assert.ok(h.fillOpacity <= 0.12);
  assert.equal(waterLodParams({ distance: 12000, family: 'harbour' }).fillVisible, false);
});

test('style mode: legacy=ベタ塗り0.5 / shoreline=岸線のみ / lod=既定', () => {
  const leg = waterLodParams({ distance: 4000, mode: 'legacy', family: 'linear' });
  assert.equal(leg.fillOpacity, 0.5);
  assert.equal(leg.shorelineVisible, false);
  const sho = waterLodParams({ distance: 1000, mode: 'shoreline', family: 'linear' });
  assert.equal(sho.fillVisible, false);
  assert.equal(sho.shorelineVisible, true);
});

test('shorelineSegments3D: リングを閉じた線分列に、hole も含む', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const hole = [[3, 3], [6, 3], [6, 6]];
  const seg = shorelineSegments3D([outer, hole], 0.05);
  // outer 4辺 + hole 3辺 = 7 線分 = 7*2 点 * 3 = 42
  assert.equal(seg.length, (4 + 3) * 2 * 3);
  // y は全点 0.05
  for (let i = 1; i < seg.length; i += 3) assert.equal(seg[i], 0.05);
  // 閉じている（最後の線分が hole の最終点→最初点）
  assert.deepEqual(seg.slice(-6), [6, 0.05, 6, 3, 0.05, 3]);
});

test('regression: 実データ wateraway tile に waterClass があり、大河川は linear/giant 判定', () => {
  const root = path.join(PROJECT_ROOT, 'data', 'processed', 'osaka-city', 'waterways');
  if (!fs.existsSync(path.join(root, 'manifest.json'))) return;
  const man = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf-8'));
  const seen = new Set();
  let withClass = 0, total = 0, giantLinear = 0;
  for (const t of man.tiles) {
    const tf = path.join(root, t.file);
    if (!fs.existsSync(tf)) continue;
    for (const f of (JSON.parse(fs.readFileSync(tf, 'utf-8')).features || [])) {
      if (seen.has(f.id)) continue; seen.add(f.id);
      if (f.kind !== 'area') continue;
      total++;
      if (f.waterClass) withClass++;
      const diag = bboxDiagOf(f.p);
      const fam = waterRenderFamily(f.waterClass || 'water', diag);
      if (fam === 'linear' && diag > GIANT_DIAG_M) giantLinear++;
    }
  }
  assert.ok(total > 0);
  assert.equal(withClass, total, `waterClass 無し area feature が ${total - withClass}`);
  assert.ok(giantLinear >= 1, '巨大 linear 河川（大和川・淀川等）が検出されない');
});
