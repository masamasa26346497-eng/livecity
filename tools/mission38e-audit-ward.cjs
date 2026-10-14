#!/usr/bin/env node
'use strict';
// Mission 38E 監査: テスト用 tile の building.ward ラベルと、全24区 N03 ポリゴンへの点内判定結果を突合する（読み取り専用）。
//   node tools/mission38e-audit-ward.cjs [--dataset osaka-hirano] [--tiles 5_-3,...]
const fs = require('node:fs');
const path = require('node:path');
const { inWard, repPoint } = require('./mission38e-build-subset.cjs');
const ROOT = path.join(__dirname, '..');

function audit(dataset, tiles) {
  const P = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/processed/osaka-city/boundaries/ward-classification-polygons.json'), 'utf8'));
  const res = {};
  for (const k of tiles) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/__test__/ward-poc/buildings', dataset, 'tile_' + k + '.json'), 'utf8'));
    const byWard = {};
    const labels = {};
    let none = 0;
    for (const b of j.buildings) {
      labels[b.ward] = (labels[b.ward] || 0) + 1;
      const [x, z] = repPoint(b.fp);
      const hit = P.wards.filter((w) => inWard(x, z, w)).map((w) => w.wardId);
      if (!hit.length) none++;
      const key = hit.join('+') || 'none';
      byWard[key] = (byWard[key] || 0) + 1;
    }
    res[k] = { n: j.buildings.length, labels, n03: byWard, none };
  }
  return res;
}
module.exports = { audit };
if (require.main === module) {
  const a = process.argv.slice(2);
  const o = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  console.log(JSON.stringify(audit(o('dataset', 'osaka-hirano'), o('tiles', '5_-3,5_-4,6_-3,6_-4').split(',')), null, 1));
}
