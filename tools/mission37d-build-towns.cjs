#!/usr/bin/env node
// Mission 37D: 住吉区の町丁目データ束を生成する（ネットワーク不要・読み取り専用の入力）。
//   名称 / ID : data/processed/osaka-sumiyoshi/boundaries/administrative-boundaries.json（住吉区のみ）
//   統計     : public/map-data/osaka-sumiyoshi/demographics/town-stats.json（あれば）
//   形状     : public/osaka_3d_buildings.html の TOWN_POLYGONS（暫定・出典未確認。legacy-unverified）
// 形状は新規に作らない。TOWN_POLYGONS に無い町丁目は geometry なし（検索はできるが flyTo / 輪郭は不可）。
// 出力: public/mission37d-data/sumiyoshi-towns.json
//   node tools/mission37d-build-towns.cjs [--check]    --check は書き込まず結果だけ表示
'use strict';
const fs = require('fs');
const path = require('path');
const { normalizeTownName, splitTown } = require('../public/mission37d-data/town-normalize.js');

const ROOT = path.resolve(__dirname, '..');
const P = (...s) => path.join(ROOT, ...s);
const ADMIN = P('data', 'processed', 'osaka-sumiyoshi', 'boundaries', 'administrative-boundaries.json');
const STATS = P('public', 'map-data', 'osaka-sumiyoshi', 'demographics', 'town-stats.json');
const HTML = P('public', 'osaka_3d_buildings.html');
const OUT = P('public', 'mission37d-data', 'sumiyoshi-towns.json');
const WARD = '住吉区';

const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

// HTML 1 行の `const TOWN_POLYGONS = {...};` を JSON として取り出す（HTML は変更しない）
function readLegacyPolygons(htmlPath) {
  const src = fs.readFileSync(htmlPath, 'utf8');
  const i = src.indexOf('const TOWN_POLYGONS = ');
  if (i < 0) throw new Error('TOWN_POLYGONS が見つかりません: ' + htmlPath);
  const start = src.indexOf('{', i);
  const end = src.indexOf('};', start);
  return JSON.parse(src.slice(start, end + 1));
}

// ring の配列へ正規化（[[x,z],...] 1 本 / [ring,...] / [[ring,...],...] のいずれも受ける）
function toRings(v) {
  const isPt = (p) => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number';
  if (!Array.isArray(v) || !v.length) return [];
  if (isPt(v[0])) return [v];
  if (Array.isArray(v[0]) && isPt(v[0][0])) return v;
  const out = [];
  for (const poly of v) for (const r of toRings(poly)) out.push(r);
  return out;
}

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]);
  return a / 2;
}
function ringCentroid(r) {
  const A = ringArea(r);
  if (Math.abs(A) < 1e-6) return [r[0][0], r[0][1]];
  let cx = 0, cz = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]);
    cx += (r[j][0] + r[i][0]) * f; cz += (r[j][1] + r[i][1]) * f;
  }
  return [cx / (6 * A), cz / (6 * A)];
}
const r1 = (n) => Math.round(n * 10) / 10;

function build() {
  const admin = rj(ADMIN).filter((r) => r.ward === WARD);
  const legacy = readLegacyPolygons(HTML);
  const statsByBoundary = new Map();
  if (fs.existsSync(STATS)) for (const s of rj(STATS).records || []) statsByBoundary.set(s.boundaryId, s);

  const records = [];
  for (const a of admin) {
    const key = normalizeTownName(a.chochoName);
    const legacyKey = a.ward + a.normalizedChochoName; // TOWN_POLYGONS のキー形式（例: 住吉区我孫子4丁目）
    const rings = toRings(legacy[legacyKey]).filter((r) => r.length >= 3).map((r) => r.map((p) => [r1(p[0]), r1(p[1])]));
    const rec = {
      id: a.compositeCode, boundaryId: a.boundaryId, name: a.chochoName, ward: a.ward,
      chochoCode: a.chochoCode, key, base: splitTown(key).base,
      geometryStatus: rings.length ? 'legacy-unverified' : 'none',
      rings, cx: null, cz: null, bbox: null, stats: null,
    };
    if (rings.length) {
      const main = rings.reduce((m, r) => (Math.abs(ringArea(r)) > Math.abs(ringArea(m)) ? r : m));
      const c = ringCentroid(main);
      rec.cx = r1(c[0]); rec.cz = r1(c[1]);
      const xs = rings.flat().map((p) => p[0]), zs = rings.flat().map((p) => p[1]);
      rec.bbox = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    }
    const s = statsByBoundary.get(a.boundaryId);
    if (s && s.population != null) {
      rec.stats = {
        population: s.population, households: s.households, agingRatio: s.agingRatio == null ? null : s.agingRatio,
        referenceDate: s.referenceDate || null, valueType: s.populationValueType || 'official',
        ratioValueType: s.ageRatioValueType || 'livecity-calculated', source: s.source || null,
      };
    }
    records.push(rec);
  }
  const withGeom = records.filter((r) => r.rings.length).length;
  return {
    areaId: 'osaka-sumiyoshi', ward: WARD,
    names: { source: admin[0] && admin[0].source, provider: admin[0] && admin[0].provider, license: admin[0] && admin[0].license, referenceDate: admin[0] && admin[0].referenceDate },
    geometry: {
      status: 'legacy-unverified',
      note: '形状は osaka_3d_buildings.html の TOWN_POLYGONS（暫定・出典未確認）から抽出。公式境界の頂点座標ではない。',
      withGeometry: withGeom, withoutGeometry: records.length - withGeom,
    },
    stats: { file: 'public/map-data/osaka-sumiyoshi/demographics/town-stats.json', withStats: records.filter((r) => r.stats).length },
    count: records.length, records,
  };
}

if (require.main === module) {
  const out = build();
  const summary = { count: out.count, withGeometry: out.geometry.withGeometry, withoutGeometry: out.geometry.withoutGeometry, withStats: out.stats.withStats };
  if (process.argv.includes('--check')) { console.log(JSON.stringify(summary)); process.exit(0); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('wrote', path.relative(ROOT, OUT), JSON.stringify(summary), (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
}

module.exports = { build, readLegacyPolygons, toRings, ringCentroid };
