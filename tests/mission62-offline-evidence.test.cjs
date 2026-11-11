'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../tools/mission62-offline-evidence.cjs'), 'utf8');
const ev = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/reports/mission62/evidence.json'), 'utf8'));

test('証拠スクリプトは外部通信を使わない', () => {
  assert.ok(!/require\(['"]https?['"]\)|fetch\(|XMLHttpRequest/.test(src));
  assert.strictEqual(ev.network.externalGets, 0);
});
test('レイヤー高さの見かけずれ h/tan(e): 道路1.4m 仰角30°≒2.4m, 15°≒5.2m', () => {
  assert.ok(Math.abs(ev.layerApparentShiftM.roads.elev30 - 2.42) < 0.01);
  assert.ok(Math.abs(ev.layerApparentShiftM.roads.elev15 - 5.22) < 0.01);
});
test('Mission59 の無効登録点(ピーク無)を有効な測定として数えない', () => {
  const invalid = ev.mission59.filter((p) => p.peakOverMean == null);
  assert.ok(invalid.length >= 1);
  invalid.forEach((p) => assert.ok(p.maskPx < 1000));
});
