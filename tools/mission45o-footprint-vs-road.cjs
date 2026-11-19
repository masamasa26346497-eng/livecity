#!/usr/bin/env node
'use strict';
// Mission 45O: 元建物 footprint（旧タイル JSON の fp）と元 OSM 道路（旧タイル）の相対位置を、同一ローカル座標で幾何比較する。読み取り専用。
//   node tools\mission45o-footprint-vs-road.cjs --src "..\livecity-data-pipeline\public\map-data\osaka-city" --ward fukushima [--radius 15]
//        [--dump "<存在しない出力フォルダ>"]    # 2D 診断画面用の diag.json を新規作成（リポジトリ外を推奨。上書き・Git 追加しない）
// 標準出力は集計のみ（ID・座標列は出さない）。ネットワークなし。
const fs = require('fs'), path = require('path');
const L = require('./mission40g-build-ward-layers.cjs');
const O = require('./lib/mission45o-overlap.cjs');
const ROOT = path.resolve(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320;   // geoToThree と同一（mission45m と同じ）

function readFootprints(src, wardId) {
  const dir = path.join(src, 'buildings', 'osaka-' + wardId);
  if (!fs.existsSync(dir)) throw new Error('source building folder not found for ward');
  const polys = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    for (const b of readJson(path.join(dir, f)).buildings || []) if (Array.isArray(b.fp) && b.fp.length >= 3) polys.push(b.fp);
  }
  return polys;
}
const readdirTiles = (d) => fs.readdirSync(d).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f)).map((f) => path.join(d, f));
// 出所の鮮度（ファイル更新日の最小〜最大。内容・座標は含まない）。生成日の目安であり、撮影日・測量日ではない。
function mtimeRange(files) {
  const t = files.map((f) => { try { return fs.statSync(f).mtime.toISOString().slice(0, 10); } catch (e) { return null; } }).filter(Boolean).sort();
  return t.length ? t[0] + ' .. ' + t[t.length - 1] : null;
}
function run(opts) {
  const ward = readJson(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json')).wards.find((w) => w.wardId === opts.ward);
  if (!ward) throw new Error('unknown ward');
  const b = ward.bbox, box = { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
  const polys = readFootprints(opts.src, opts.ward);
  const roads = L.readLayer(opts.src, 'roads', box);
  if (roads.status !== 'ok') throw new Error('roads source ' + roads.status);
  const lines = roads.features.filter((f) => f.kind !== 'area').map((f) => f.p);
  if (!polys.length || !lines.length) throw new Error('no footprints or no roads (polys=' + polys.length + ', lines=' + lines.length + ')');
  const so = { radius: opts.radius, offsetStep: 2.5, sampleStep: 5 };
  const whole = O.scan(polys, lines, so);
  const midX = (b.minX + b.maxX) / 2, midZ = (b.minZ + b.maxZ) / 2;
  const half = (axis, lowSide) => {
    const sel = (pt) => (lowSide ? pt[axis] < (axis === 0 ? midX : midZ) : pt[axis] >= (axis === 0 ? midX : midZ));
    const ls = lines.filter((l) => sel(l[0])), ps = polys.filter((p) => sel(p[0]));
    return ls.length && ps.length ? O.scan(ps, ls, so) : { samples: 0 };
  };
  const parts = [half(0, true), half(0, false), half(1, true), half(1, false)];
  const v = O.verdict(whole, parts, { radius: opts.radius });
  const strip = (s) => ({ buildings: s.buildings, samples: s.samples, zeroOffsetFraction: s.zero, best: s.best ? { dx: s.best.dx, dz: s.best.dz, fraction: s.best.f } : null });
  const out = Object.assign({ mission: '45O', ward: opts.ward, readOnly: true, footprints: polys.length, roadLines: lines.length, radiusM: opts.radius, whole: strip(whole), halves: parts.map(strip) }, v,
    { axes: 'dx: east+, dz: south+ (Live City local, znorth-neg-v1). Offsets are applied to roads only.' });
  if (opts.dump) {
    if (fs.existsSync(opts.dump)) throw new Error('--dump target already exists; refusing to overwrite');
    fs.mkdirSync(opts.dump, { recursive: true });
    const rm = roads.manifest || {};
    const meta = {
      origin: { lat: CLAT, lon: CLON }, mpd: MPD, unit: 'm',
      axes: 'x=(lon-CLON)*cos(CLAT)*MPD (east+), z=-(lat-CLAT)*MPD (south+)',
      source: { roadsGenerated: rm.generated || rm.generatedAt || null, roadsConvention: rm.coordinateConvention || null, roadsTileSize: rm.tileSize || null,
        buildingsMtime: mtimeRange(readdirTiles(path.join(opts.src, 'buildings', 'osaka-' + opts.ward))),
        roadsManifestMtime: mtimeRange([path.join(opts.src, 'roads', 'manifest.json')]), buildings: 'legacy tile JSON fp (PLATEAU LOD1)' },
      ward: opts.ward, bbox: box
    };
    const r1 = (q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10];
    fs.writeFileSync(path.join(opts.dump, 'diag.json'), JSON.stringify({ meta, footprints: polys.map((p) => p.map(r1)), roads: lines.map((l) => l.map(r1)) }), { flag: 'wx' });
    out.dump = { written: true, note: 'private geometry: keep outside the repo, never commit/upload' };
  }
  return out;
}
function parse(a) {
  const o = { radius: 15 };
  const g = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  o.src = g('src'); o.ward = g('ward'); o.dump = g('dump');
  if (g('radius')) o.radius = Number(g('radius'));
  if (!o.src || !o.ward || !/^[a-z0-9-]+$/.test(o.ward)) throw new Error('--src and --ward are required');
  if (!(o.radius > 0 && o.radius <= 60)) throw new Error('--radius must be 0..60');
  return o;
}
module.exports = { run, readFootprints, parse };
if (require.main === module) {
  try { console.log(JSON.stringify(run(parse(process.argv.slice(2))), null, 1)); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
}
