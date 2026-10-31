#!/usr/bin/env node
'use strict';
// Mission 45J: 区ポリゴン内判定の CPU 時間（Node, 合成の点列）。旧: 全頂点を厳密 point-in-ring / 新: セル前計算 + 境界セルのみ厳密。
// これは Node の純 CPU 計測で、ブラウザ（Cesium 描画）の FPS ではない。
const fs = require('fs');
const path = require('path');
const V = (() => { const m = require('../public/mission45i-vec.js'); return m && m.makeInsideTester ? m : globalThis.LC45I; })();
const wards = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;
const pip = (r, x, z) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (((r[i][1] > z) !== (r[j][1] > z)) && (x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) c = !c; return c; };
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const N = Number(process.argv[2]) || 60000, out = [];
for (const w of wards) {
  const pts = []; for (let i = 0; i < N; i++) pts.push([w.bbox.minX - 150 + rnd() * (w.bbox.maxX - w.bbox.minX + 300), w.bbox.minZ - 150 + rnd() * (w.bbox.maxZ - w.bbox.minZ + 300)]);
  const exact = (x, z) => w.polygons.some((p) => pip(p.outer, x, z) && !(p.holes || []).some((h) => pip(h, x, z)));
  let t = process.hrtime.bigint(); let a = 0; for (const p of pts) if (exact(p[0], p[1])) a++;
  const tOld = Number(process.hrtime.bigint() - t) / 1e6;
  t = process.hrtime.bigint(); const f = V.makeInsideTester(w.polygons, 64); let b = 0; for (const p of pts) if (f(p[0], p[1])) b++;
  const tNew = Number(process.hrtime.bigint() - t) / 1e6;
  out.push({ ward: w.wardId, ringVertices: w.polygons.reduce((s, p) => s + p.outer.length, 0), points: N, insideOld: a, insideNew: b, same: a === b, oldMs: Math.round(tOld * 10) / 10, newMs: Math.round(tNew * 10) / 10, speedup: Math.round((tOld / Math.max(tNew, 0.01)) * 10) / 10 });
}
const sum = (k) => out.reduce((s, r) => s + r[k], 0);
console.log(JSON.stringify({ wards: out.length, allSame: out.every((r) => r.same), oldMsTotal: Math.round(sum('oldMs')), newMsTotal: Math.round(sum('newMs')), perWard: out }, null, 1));
