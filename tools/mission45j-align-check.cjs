#!/usr/bin/env node
'use strict';
// Mission 45J: 道路と建物の位置ずれ / 回転の「診断」（読み取り専用。何も書かない。ネットワークなし）。
//   node tools/mission45j-align-check.cjs --src <...\livecity-data-pipeline\public\map-data\osaka-city> --ward fukushima [--ext <45D 出力ルート>] [--yaw]
// 出力（stdout の JSON）:
//   manifest   : 旧 OSM タイル manifest の宣言の検証（規約・原点記録の有無）
//   probe      : 道路頂点が N03 区ポリゴンに入る割合を 8 通りの軸/符号で比較（identity が最良なら取り違え・符号違いなし）
//   yaw        : --yaw かつ --ext（変換済み建物の attrs）があるとき、建物代表点を ±3° 回して最近の道路までの距離中央値を比較。
//                1km クラスタ 4 つ以上で一致しない限り角度は断定しない（"inconclusive"）。
//   nearest    : 角度 0 のときの、建物代表点から最近の道路までの距離の分位（m）。
const fs = require('fs');
const path = require('path');
const L = require('./mission40g-build-ward-layers.cjs');
const A = require('./lib/mission45j-align.cjs');
const ROOT = path.resolve(__dirname, '..');

function main() {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const src = opt('src'), wardId = opt('ward'), ext = opt('ext');
  if (!src || !wardId) throw new Error('--src and --ward are required');
  const ward = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards.find((w) => w.wardId === wardId);
  if (!ward) throw new Error('unknown ward ' + wardId);
  const b = ward.bbox, box = { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
  const roads = L.readLayer(src, 'roads', box);
  if (roads.status !== 'ok') throw new Error('roads source ' + roads.status);
  const out = { mission: '45J', ward: wardId, readOnly: true, roads: { features: roads.features.length, vertices: roads.stats.vertices } };
  out.manifest = A.validateSourceManifest(roads.manifest);
  const pts = []; for (const f of roads.features) for (const p of f.p) { if (pts.length < 40000) pts.push(p); }
  out.probe = A.probeConvention(pts, ward.polygons);
  if (ext) {
    const bp = L.buildingPoints(path.join(ext, wardId));
    out.buildings = { repPoints: bp.length };
    const lines = roads.features.filter((f) => f.kind !== 'area').map((f) => f.p);
    const near = A.roadIndex(lines, 50);
    const sample = bp.length > 5000 ? bp.filter((_, i) => i % Math.ceil(bp.length / 5000) === 0) : bp;
    const d = sample.map((p) => near(p[0], p[1], 300)).filter(Number.isFinite).sort((x, y) => x - y);
    const q = (f) => (d.length ? Math.round(d[Math.min(d.length - 1, Math.floor(d.length * f))] * 10) / 10 : null);
    out.nearest = { sampled: d.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), note: 'distance from a building representative point to the nearest road, angle 0. Roads normally pass within tens of metres in a city.' };
    if (a.includes('--yaw')) out.yaw = A.yawScan(lines, bp);
  }
  console.log(JSON.stringify(out, null, 1));
  if (out.probe.verdict === 'alternative-fits-better' || !out.manifest.ok) process.exitCode = 3;
}
try { main(); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
