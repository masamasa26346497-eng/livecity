#!/usr/bin/env node
'use strict';
// Mission 45Y: 建物 ground footprint と道路中心線の座標基準の監査（追跡済み公開データ＝住吉区のみ。読み取り専用・ネットワークなし）。
//   node tools/mission45y-ground-audit.cjs [--out <json>]
// 1) 座標基準: ビューア(37G)の PROJ/toLon/toLat/toCart、建物変換器(37B)の ecef/ENU、旧建物タイルの z0 を突き合わせる。
// 2) 住吉区の公開道路束(37C)と旧建物 fp: 道路サンプル点が footprint 内に入る割合を、全体と 4 分割で出す。
// 福島区・北区など private データは使えない（このリポジトリに無い）ため、それらの区は「未検証」。
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const vm = require('vm');
const G = (() => { const sb = {}; vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/mission45y-gfp.js'), 'utf8'), sb); sb.globalThis = sb; return sb.LC45Y; })();
const rj = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
const conv = fs.readFileSync(path.join(ROOT, 'tools/mission37b-build-3dtiles.cjs'), 'utf8');

const D2R = Math.PI / 180, WA = 6378137, WE2 = 0.00669437999014;
const ecef = (lon, lat, h) => { const l = lon * D2R, p = lat * D2R, s = Math.sin(p), c = Math.cos(p), N = WA / Math.sqrt(1 - WE2 * s * s); return [(N + h) * c * Math.cos(l), (N + h) * c * Math.sin(l), (N * (1 - WE2) + h) * s]; };

function constants() {
  const v = html.match(/const PROJ = \{ clat: ([\d.]+), clon: ([\d.]+), mpd: (\d+) \}/);
  const c = conv.match(/CLAT\s*=\s*([\d.]+)/), o = conv.match(/CLON\s*=\s*([\d.]+)/), m = conv.match(/MPD\s*=\s*(\d+)/);
  return { viewer: v ? { clat: +v[1], clon: +v[2], mpd: +v[3] } : null, converter: c && o && m ? { clat: +c[1], clon: +o[1], mpd: +m[1] } : null };
}
function run() {
  const k = constants();
  const same = !!(k.viewer && k.converter && k.viewer.clat === k.converter.clat && k.viewer.clon === k.converter.clon && k.viewer.mpd === k.converter.mpd);
  // ビューアの toLon/toLat と同じ式で、道路頂点(h=1.4)と建物底面(h=0)が同じ鉛直線上（水平差 0）か
  const P = k.viewer, cos = Math.cos(P.clat * D2R);
  const toLon = (x) => P.clon + x / (cos * P.mpd), toLat = (z) => P.clat - z / P.mpd;
  let maxHoriz = 0;
  for (const [x, z] of [[-2500, -770], [0, 0], [-1800, 300], [-3000, 1500]]) {
    const a = ecef(toLon(x), toLat(z), 0), b = ecef(toLon(x), toLat(z), 1.4);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], n = Math.hypot(...d), up = [Math.cos(toLat(z) * D2R) * Math.cos(toLon(x) * D2R), Math.cos(toLat(z) * D2R) * Math.sin(toLon(x) * D2R), Math.sin(toLat(z) * D2R)];
    // 楕円体法線は up と僅かに違うため、1.4m 上方への変位の「地理座標上の水平ずれ」は経緯度が同一であることで担保される（fromDegrees の定義）
    maxHoriz = Math.max(maxHoriz, Math.abs(n - 1.4));
    void up;
  }
  const roads = rj('public/mission37c-layers/osaka-sumiyoshi-9tile/roads.json'), bb = roads.bboxLocal;
  const dir = path.join(ROOT, 'public/map-data/osaka-city/buildings/osaka-sumiyoshi');
  const rings = [], z0s = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    for (const b of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).buildings || []) {
      if (!Array.isArray(b.fp) || b.fp.length < 3) continue;
      z0s.set(b.z0 || 0, (z0s.get(b.z0 || 0) || 0) + 1);
      const x = b.fp[0][0], z = b.fp[0][1];
      if (x >= bb.minX && x <= bb.maxX && z >= bb.minZ && z <= bb.maxZ) rings.push(b.fp);
    }
  }
  const lines = roads.features.filter((f) => f.kind !== 'area').map((f) => f.p);
  const mx = (bb.minX + bb.maxX) / 2, mz = (bb.minZ + bb.maxZ) / 2;
  const part = (ax, low) => { const m = ax === 0 ? mx : mz, sel = (p) => (low ? p[ax] < m : p[ax] >= m); return G.roadInsideFraction(lines.filter((l) => sel(l[0])), rings.filter((r) => sel(r[0]))); };
  const whole = G.roadInsideFraction(lines, rings);
  return {
    mission: '45Y', scope: 'sumiyoshi tracked public data only; fukushima/kita etc. are NOT verified here (private data absent)',
    constants: Object.assign(k, { identical: same }),
    heightModel: { buildingsBaseEllipsoidH: 0, roadLineEllipsoidH: 1.4, note: 'both are WGS84 ellipsoid heights via the same lon/lat; globe has no terrain', nonZeroZ0Count: [...z0s.entries()].filter(([z]) => z !== 0).reduce((a, [, n]) => a + n, 0), z0Distinct: z0s.size, verticalOffsetCheckAbsErr: maxHoriz },
    footprints: rings.length, roadLines: lines.length,
    roadSamplesInsideFootprint: { whole, west: part(0, true), east: part(0, false), north: part(1, true), south: part(1, false) },
  };
}
if (require.main === module) {
  const r = run(), i = process.argv.indexOf('--out');
  if (i > 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
}
module.exports = { run };
