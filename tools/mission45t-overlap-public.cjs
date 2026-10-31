#!/usr/bin/env node
'use strict';
// Mission 45T: 追跡済み公開データ(住吉区)だけで、道路中心線と建物 footprint の相対位置を 45O と同じ純関数で計測する。読み取り専用・ネットワークなし。
//   node tools/mission45t-overlap-public.cjs [--radius 15] [--out <json>]
// 道路: public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json (37C 束)。建物: public/map-data/osaka-city/buildings/osaka-sumiyoshi (旧タイル fp)。
// 福島区には一般化できない（別地域・別データ・別時期）。出力は集計のみ(ID・座標列なし)。
const fs = require('fs'), path = require('path');
const O = require('./lib/mission45o-overlap.cjs');
const ROOT = path.resolve(__dirname, '..');
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const radius = +arg('--radius', 15), out = arg('--out', null);
const roads = rj(path.join(ROOT, 'public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json'));
const bb = roads.bboxLocal;
const dir = path.join(ROOT, 'public/map-data/osaka-city/buildings/osaka-sumiyoshi');
const polys = [];
for (const f of fs.readdirSync(dir)) {
  if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
  for (const b of rj(path.join(dir, f)).buildings || []) {
    if (!Array.isArray(b.fp) || b.fp.length < 3) continue;
    const x = b.fp[0][0], z = b.fp[0][1];
    if (x >= bb.minX && x <= bb.maxX && z >= bb.minZ && z <= bb.maxZ) polys.push(b.fp);
  }
}
const lines = roads.features.filter((f) => f.kind !== 'area').map((f) => f.p);
const so = { radius, offsetStep: 2.5, sampleStep: 5 };
const whole = O.scan(polys, lines, so);
const mx = (bb.minX + bb.maxX) / 2, mz = (bb.minZ + bb.maxZ) / 2;
const half = (axis, low) => {
  const m = axis === 0 ? mx : mz, sel = (p) => (low ? p[axis] < m : p[axis] >= m);
  const ls = lines.filter((l) => sel(l[0])), ps = polys.filter((p) => sel(p[0]));
  return ls.length && ps.length ? O.scan(ps, ls, so) : { samples: 0 };
};
const parts = [half(0, true), half(0, false), half(1, true), half(1, false)];
const v = O.verdict(whole, parts, { radius });
const strip = (s) => ({ buildings: s.buildings, samples: s.samples, zeroOffsetFraction: s.zero, best: s.best ? { dx: s.best.dx, dz: s.best.dz, fraction: s.best.f } : null });
const res = Object.assign({ mission: '45T', scope: 'sumiyoshi tracked public data only; NOT generalizable to fukushima', footprints: polys.length, roadLines: lines.length, radiusM: radius, whole: strip(whole), halves: parts.map(strip) }, v);
if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
