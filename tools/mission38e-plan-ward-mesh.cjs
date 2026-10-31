#!/usr/bin/env node
'use strict';
// Mission 38E: 新区1区の最小PLATEAUメッシュ選定プラン（完全オフライン・読み取り専用）。
// 既存の36K probe（ZIP中央ディレクトリ実測値）と N03 区ポリゴンだけを使い、HTTP Range 取得対象を決める。
// 実取得は行わない。取得は tools/mission36k-fetch-citygml-ward-range.mjs --meshes=<mesh> をネットワーク可能な環境で実行する。
//   node tools/mission38e-plan-ward-mesh.cjs --ward naniwa [--write]
const fs = require('node:fs');
const path = require('node:path');
const { inWard } = require('./mission38e-build-subset.cjs');
const ROOT = path.join(__dirname, '..');

function mesh3Bounds(code) {
  const s = String(code);
  if (!/^\d{8}$/.test(s)) throw new Error('Invalid third-level mesh code: ' + code);
  const south = Number(s.slice(0, 2)) / 1.5 + Number(s[4]) * (5 / 60) + Number(s[6]) * (30 / 3600);
  const west = Number(s.slice(2, 4)) + 100 + Number(s[5]) * (7.5 / 60) + Number(s[7]) * (45 / 3600);
  return { south, west, north: south + 30 / 3600, east: west + 45 / 3600 };
}
// runtimeToGeo（36K fetch）の逆変換
function geoToRuntime(lat, lon, pj) {
  return [(lon - pj.centerLon) * Math.cos(pj.centerLat * Math.PI / 180) * pj.metersPerDegree, (pj.centerLat - lat) * pj.metersPerDegree];
}
function meshOf(name) { return (path.basename(name).match(/(^|[^0-9])(\d{8})(?=[^0-9]|$)/) || [])[2] || null; }

function plan(wardId) {
  const probe = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/mission36k-citygml-zip-probe.json'), 'utf8'));
  const area = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/areas/osaka-city.json'), 'utf8'));
  const P = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/processed/osaka-city/boundaries/ward-classification-polygons.json'), 'utf8'));
  const ward = P.wards.find((w) => w.wardId === wardId);
  if (!ward) throw new Error('unknown ward ' + wardId);
  const rows = [];
  for (const e of probe.zip.buildingEntries) {
    const mesh = meshOf(e.name);
    if (!mesh) continue;
    const b = mesh3Bounds(mesh);
    let inside = 0;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      const [x, z] = geoToRuntime(b.south + (b.north - b.south) * (i + 0.5) / 5, b.west + (b.east - b.west) * (j + 0.5) / 5, area.projection);
      if (inWard(x, z, ward)) inside++;
    }
    if (inside) rows.push({ mesh, entry: e.name, method: e.method, localOffset: e.localOffset, compressedBytes: e.compressedBytes, uncompressedBytes: e.uncompressedBytes, wardSampleFraction: inside / 25 });
  }
  rows.sort((a, b) => b.wardSampleFraction - a.wardSampleFraction || a.compressedBytes - b.compressedBytes);
  const best = rows[0] || null;
  return {
    mission: '38E-plan-ward-mesh', ward: wardId, wardCode: ward.wardCode,
    status: 'PLAN_ONLY_NOT_FETCHED',
    source: { url: probe.source.url, etag: probe.head.headers.etag, lastModified: probe.head.headers['last-modified'], contentLength: probe.zip.contentLength, probeGeneratedAt: probe.generatedAt },
    sampling: '5x5 mesh sample points inside N03 ward polygon (same rule as 37H)',
    candidates: rows,
    selected: best,
    fetchCommand: best ? 'node tools/mission36k-fetch-citygml-ward-range.mjs --ward ' + wardId + ' --meshes=' + best.mesh + ' --out temp/gml-' + wardId : null,
    notes: ['取得・変換は未実施。sha256 は取得後に記録すること。ward-hint は定数スタンプなので区判定は N03 点内判定で行う。'],
  };
}
module.exports = { plan, mesh3Bounds, geoToRuntime };
if (require.main === module) {
  const a = process.argv.slice(2);
  const ward = a[a.indexOf('--ward') + 1] || 'naniwa';
  const out = plan(ward);
  if (a.includes('--write')) {
    const d = path.join(ROOT, 'public/mission38e-3dtiles/plans');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, ward + '-mesh-plan.json'), JSON.stringify(out, null, 1) + '\n');
  }
  console.log(JSON.stringify({ ...out, candidates: out.candidates.length }, null, 1));
}
