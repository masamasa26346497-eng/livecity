#!/usr/bin/env node
'use strict';
// Mission 38E（系統A）: 既存テスト用実形状（public/__test__/ward-poc/buildings/<dataset>/）から
// 少数 tile だけを選び、3D Tiles に変換する。PLATEAU 原典との一致は未証明のため「PLATEAU 100%」とは主張しない。
//
//   区判定: テスト用 tile の building.ward ラベルは格納フォルダの区名と一致しない（例: Hirano の tile_10_-1 は全件 '東住吉区'）。
//           そのためラベルは使わず、N03 区ポリゴン（data/processed/osaka-city/boundaries/ward-classification-polygons.json）
//           に対する footprint 頂点平均の点内判定で再判定し、対象区の内側にある建物だけを残す。
//   canonicalId: building.id（bldg_<uuid>）をそのまま使用。新規採番しない。
//   変換: tools/mission37b-build-3dtiles.cjs の build() を再利用（そちらは変更しない）。
//
//   node tools/mission38e-build-subset.cjs --survey [--dataset osaka-hirano] [--ward hirano]
//   node tools/mission38e-build-subset.cjs --dataset osaka-hirano --ward hirano --tiles 10_-1,10_0 --out public/mission38e-3dtiles/hirano-subset
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { build } = require('./mission37b-build-3dtiles.cjs');

const ROOT = path.join(__dirname, '..');
const POLY = path.join(ROOT, 'data/processed/osaka-city/boundaries/ward-classification-polygons.json');

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function inWard(x, z, ward) {
  const bb = ward.bbox;
  if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) return false;
  return ward.polygons.some((p) => pointInRing(x, z, p.outer) && !(p.holes || []).some((h) => pointInRing(x, z, h)));
}
function repPoint(fp) {
  return [fp.reduce((s, p) => s + p[0], 0) / fp.length, fp.reduce((s, p) => s + p[1], 0) / fp.length];
}
function loadWard(wardId) {
  const polys = JSON.parse(fs.readFileSync(POLY, 'utf8'));
  if (polys.coordinateConvention !== 'znorth-neg-v1') throw new Error('coordinateConvention');
  const ward = polys.wards.find((w) => w.wardId === wardId);
  if (!ward) throw new Error('unknown ward ' + wardId);
  return ward;
}
// 各 tile の building を N03 ポリゴンで再判定する。
function classifyTile(tileJson, ward) {
  const inside = [], outside = [];
  const labels = {};
  for (const b of tileJson.buildings) {
    labels[b.ward] = (labels[b.ward] || 0) + 1;
    const [x, z] = repPoint(b.fp);
    (inWard(x, z, ward) ? inside : outside).push(b);
  }
  return { inside, outside, labels };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const dataset = opt('dataset', 'osaka-hirano');
  const wardId = opt('ward', 'hirano');
  const src = path.join(ROOT, 'public/__test__/ward-poc/buildings', dataset);
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  const ward = loadWard(wardId);

  if (args.includes('--survey')) {
    for (const t of manifest.tiles) {
      const c = classifyTile(JSON.parse(fs.readFileSync(path.join(src, t.file), 'utf8')), ward);
      const n = c.inside.length + c.outside.length;
      if (c.inside.length / n >= 0.9 && n >= 300) console.log(t.tx + '_' + t.tz, 'n=' + n, 'inWard=' + c.inside.length, 'labels=' + JSON.stringify(c.labels));
    }
    return;
  }

  const want = (opt('tiles', '') || '').split(',').filter(Boolean);
  if (!want.length) throw new Error('--tiles tx_tz,... required');
  const out = path.resolve(opt('out', path.join(ROOT, 'public/mission38e-3dtiles', wardId + '-subset')));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm38e-'));
  const tiles = [];
  const stat = { wardId, dataset, sourceBuildings: 0, keptInWard: 0, droppedOutsideWard: 0, labelsInSource: {} };
  for (const key of want) {
    const t = manifest.tiles.find((x) => x.tx + '_' + x.tz === key);
    if (!t) throw new Error('tile not in manifest ' + key);
    const j = JSON.parse(fs.readFileSync(path.join(src, t.file), 'utf8'));
    const c = classifyTile(j, ward);
    stat.sourceBuildings += j.buildings.length;
    stat.keptInWard += c.inside.length;
    stat.droppedOutsideWard += c.outside.length;
    for (const [k, v] of Object.entries(c.labels)) stat.labelsInSource[k] = (stat.labelsInSource[k] || 0) + v;
    fs.writeFileSync(path.join(tmp, t.file), JSON.stringify({ ...j, buildings: c.inside, count: c.inside.length }));
    tiles.push({ tx: t.tx, tz: t.tz, file: t.file, count: c.inside.length });
  }
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({ coordinateConvention: 'znorth-neg-v1', tiles }));
  const r = build({ dataset: dataset + '-m38e', srcDir: tmp, out, all: true, group: 4, coarseError: 40, coarseMinArea: 100 });
  fs.rmSync(tmp, { recursive: true, force: true });
  const source = {
    mission: '38E-A',
    kind: 'existing-test-real-footprints-partial-3d',
    plateauOriginalMatch: 'unverified',
    note: '既存テスト用実形状（public/__test__/ward-poc）の部分3D可視化。PLATEAU原典との一致は未証明のため PLATEAU 100% とは主張しない。',
    wardJudgement: 'N03 polygon point-in-polygon on footprint vertex mean; building.ward label ignored',
    ...stat,
    tiles: want,
  };
  fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify(source, null, 1));
  console.log(JSON.stringify({ out: path.relative(process.cwd(), out), ...stat, build: r.totals }, null, 1));
}

module.exports = { pointInRing, inWard, repPoint, classifyTile, loadWard };
if (require.main === module) main();
