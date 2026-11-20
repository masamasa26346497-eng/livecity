'use strict';
// [Mission 73] 遠景 LOD 脱落の定量化ツールと coverage73 フックの静的・合成テスト。実データ・実ブラウザは使わない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const M = require('../tools/mission73-coarse-lod-loss.cjs');
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');

const sq = (x, z, s) => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];
const b = (id, x, z, s) => ({ id, fp: sq(x, z, s), z0: 0, dz: 8, h: 8 });

test('analyze: small buildings drop in coarse, large stay (synthetic)', () => {
  const tiles = [{ buildings: [b('bldg_a', 0, 0, 20), b('bldg_b', 30, 0, 5), b('bldg_c', 250, 250, 5), b('bldg_d', 255, 250, 5)] }];
  const r = M.analyze(tiles, 100, 100);
  assert.strictEqual(r.buildings, 4);
  assert.strictEqual(r.keptInCoarse, 1);
  assert.strictEqual(r.droppedPct, 75);
  assert.strictEqual(r.cellsWithBuildings, 2);
  assert.strictEqual(r.cellsEmptyInCoarse, 1);
});

test('tool is read-only, offline, and prints no ids', () => {
  const src = fs.readFileSync('tools/mission73-coarse-lod-loss.cjs', 'utf8');
  for (const bad of ['http', 'fetch(', 'unlink', 'rmSync', 'rename', 'child_process']) assert.ok(!src.includes(bad), bad);
  const r = M.analyze([{ buildings: [b('bldg_secret', 0, 0, 5)] }], 100, 100);
  assert.ok(!JSON.stringify(r).includes('bldg_secret'));
});

test('coverage73 hook sits inside the qa gate and is read-only', () => {
  const gate = html.indexOf("get('qa') === '1'");
  const a = html.indexOf('coverage73(cols, rows) {'), e = html.indexOf('// 64: 再現用スナップショット');
  assert.ok(gate > 0 && a > gate && e > a);
  const body = html.slice(a, e);
  for (const bad of ['fetch(', 'dispatchEvent', 'selectPoi(', 'flyTo', 'lookAt', '.show =', 'setVisible', '.style =', 'canonicalId']) assert.ok(!body.includes(bad), bad);
  for (const k of ['selected', 'grid', 'projCheck', '_selectedTiles']) assert.ok(body.includes(k), k);
  assert.ok(!/水平誤差|horizontalError/.test(body.replace(/地物の位置誤差/g, '')));
});
