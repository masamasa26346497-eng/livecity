'use strict';
// Mission213: LC_COARSE_MERGE の統合箱(bbox 和集合)が道路/河川ポリゴン(local-meters, znorth-neg-v1)をどれだけ覆うかを定量化する。
// 使い方: LC_COARSE_AUDIT=boxes.jsonl LC_COARSE_MERGE=20:150 でビルド後、node audit-coarse-overlap.cjs boxes.jsonl <layersDir>
// 意味: 道路/水域は「面ポリゴン」なので交差は面積で測れる。ただし「統合箱が覆う道路面積」は、個別建物 bbox が元から道路にはみ出す分(斜め建物の bbox 等)も含む。
//   そのため、箱面積−構成建物 bbox 面積和(=埋めた隙間)の上限も併記する。判定は閾値を置かず数値のみ報告(合否は人が判断)。
const fs = require('fs'), path = require('path');
function pip(x, z, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
function buildIndex(features, cell) {
  const idx = new Map();
  for (const f of features) {
    const xs = f.p.map((q) => q[0]), zs = f.p.map((q) => q[1]);
    const ix0 = Math.floor(Math.min(...xs) / cell), ix1 = Math.floor(Math.max(...xs) / cell), iz0 = Math.floor(Math.min(...zs) / cell), iz1 = Math.floor(Math.max(...zs) / cell);
    for (let a = ix0; a <= ix1; a++) for (let b = iz0; b <= iz1; b++) { const k = a + '_' + b; (idx.get(k) || idx.set(k, []).get(k)).push(f); }
  }
  return { idx, cell };
}
function inside(x, z, I) {
  const l = I.idx.get(Math.floor(x / I.cell) + '_' + Math.floor(z / I.cell)); if (!l) return false;
  for (const f of l) { if (!pip(x, z, f.p)) continue; if (Array.isArray(f.h) && f.h.some((r) => Array.isArray(r) && Array.isArray(r[0]) && pip(x, z, r))) continue; return true; }
  return false;
}
// 追加重複の分離: 箱内サンプル点を「構成建物 bbox の和集合の内側(=建物由来の既存重複)」と「gap(統合で新たに覆った部分)」に分け、
// それぞれで道路/水域に入る面積と箱数を数える。members(b.m)が無い箱は分離できないので separable から除外する。
// 誤差: 2m 格子サンプリング(面積は点数×step²相当)、ポリゴン境界は点判定の近似。小さい箱ほど相対誤差が大きい。
function separate(boxes, roads, water, step = 2) {
  const R = buildIndex(roads, 64), W = buildIndex(water, 64);
  const t = { boxes: 0, skipped: 0, gapRoadM2: 0, gapWaterM2: 0, memberRoadM2: 0, memberWaterM2: 0, gapM2: 0, boxesGapRoad: 0, boxesGapWater: 0, boxesGapRoadOver50pctOfGap: 0, worstGap: [] };
  for (const b of boxes) {
    if (!Array.isArray(b.m) || !b.m.length) { t.skipped++; continue; }
    const a = step * step; let gp = 0, gr = 0, gw = 0, mr = 0, mw = 0;
    for (let x = b.x0 + step / 2; x < b.x1; x += step) for (let z = b.z0 + step / 2; z < b.z1; z += step) {
      const inMem = b.m.some((q) => x >= q[0] && x < q[2] && z >= q[1] && z < q[3]);
      const r = inside(x, z, R), w = inside(x, z, W);
      if (inMem) { if (r) mr++; if (w) mw++; } else { gp++; if (r) gr++; if (w) gw++; }
    }
    t.boxes++; t.gapM2 += gp * a; t.gapRoadM2 += gr * a; t.gapWaterM2 += gw * a; t.memberRoadM2 += mr * a; t.memberWaterM2 += mw * a;
    if (gr) t.boxesGapRoad++; if (gw) t.boxesGapWater++; if (gp && gr / gp > 0.5) t.boxesGapRoadOver50pctOfGap++;
    if (gr || gw) t.worstGap.push({ id: b.id, gapRoadM2: gr * a, gapWaterM2: gw * a, gapM2: gp * a });
  }
  t.worstGap.sort((p, q) => (q.gapRoadM2 + q.gapWaterM2) - (p.gapRoadM2 + p.gapWaterM2)); t.worstGap = t.worstGap.slice(0, 10);
  for (const k of ['gapM2', 'gapRoadM2', 'gapWaterM2', 'memberRoadM2', 'memberWaterM2']) t[k] = Math.round(t[k]);
  return t;
}
function audit(boxes, roads, water, step = 2) {
  const R = buildIndex(roads, 64), W = buildIndex(water, 64);
  let boxA = 0, memA = 0, roadA = 0, waterA = 0, n = 0, worst = [];
  for (const b of boxes) {
    const area = (b.x1 - b.x0) * (b.z1 - b.z0); let rc = 0, wc = 0, tot = 0;
    for (let x = b.x0 + step / 2; x < b.x1; x += step) for (let z = b.z0 + step / 2; z < b.z1; z += step) { tot++; if (inside(x, z, R)) rc++; if (inside(x, z, W)) wc++; }
    if (!tot) continue;
    const ra = area * rc / tot, wa = area * wc / tot; n++; boxA += area; memA += Math.min(area, b.memberArea); roadA += ra; waterA += wa;
    worst.push({ id: b.id, area: Math.round(area), gap: Math.round(Math.max(0, area - b.memberArea)), roadFrac: +(rc / tot).toFixed(3), waterFrac: +(wc / tot).toFixed(3) });
  }
  worst.sort((a, b) => (b.roadFrac + b.waterFrac) - (a.roadFrac + a.waterFrac));
  const r = (v) => Math.round(v);
  return { boxes: n, boxAreaM2: r(boxA), memberBboxAreaM2: r(memA), gapUpperBoundM2: r(boxA - memA), roadUnderBoxM2: r(roadA), waterUnderBoxM2: r(waterA),
    roadFracOfBox: +(roadA / boxA).toFixed(4), waterFracOfBox: +(waterA / boxA).toFixed(4), boxesWithWaterOver20pct: worst.filter((w) => w.waterFrac > 0.2).length, boxesWithRoadOver50pct: worst.filter((w) => w.roadFrac > 0.5).length, worst10: worst.slice(0, 10) };
}
module.exports = { audit, separate, pip };
if (require.main === module) {
  const [boxesFile, layersDir] = process.argv.slice(2);
  const boxes = fs.readFileSync(boxesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const roads = JSON.parse(fs.readFileSync(path.join(layersDir, 'roads.json'))).features, water = JSON.parse(fs.readFileSync(path.join(layersDir, 'waterways.json'))).features;
  console.log(JSON.stringify({ ...audit(boxes, roads, water), separation: separate(boxes, roads, water) }, null, 1));
}
