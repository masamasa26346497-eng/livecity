import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAcceptanceTable, buildAcceptanceRow, renderMarkdown } from '../tools/lib/acceptance-table.js';
import { isUnsafeTarMember, assetNameFor, validWardKey } from '../tools/restore-release-assets.js';

const okLayer = { status: 'ok', features: 3 };
const complete = (k) => ({ wardKey: k, ward: k, declared: { buildings: 10 }, layers: { buildings: { status: 'ok', tilesPresent: 1, tilesDeclared: 1, buildingsLoaded: 10 }, roads: okLayer, waterways: { status: 'ok', water: { lines: 2, polygons: 1 } } }, checks: {}, waterKind: 'polygon+line', localData: 'complete' });
const px = { pixelDiff: 120, pass: true };

test('在庫が完備でもブラウザ証拠が無ければ not-verified', () => {
  const r = buildAcceptanceRow(complete('fukushima'), undefined);
  assert.equal(r.verdict, 'not-verified');
  assert.match(r.reasonNotRun, /ブラウザ検証未実行/);
});

test('データ欠落は理由コード付き', () => {
  const r = buildAcceptanceRow({ wardKey: 'nishi', ward: 'nishi', layers: { buildings: { status: 'missing', code: 'missing-file' } } }, undefined);
  assert.match(r.reasonNotRun, /buildings:missing-file/);
  assert.match(r.reasonNotRun, /waterways:absent/);
});

test('3レイヤー全ての画素差分>0 と位置整合が揃った時のみ browser-verified', () => {
  const full = { buildings: px, roads: px, water: px, alignment: { pass: true }, clickId: 'b1', fps: 40 };
  assert.equal(buildAcceptanceRow(complete('a'), full).verdict, 'browser-verified');
  assert.equal(buildAcceptanceRow(complete('a'), { ...full, water: { pixelDiff: 0, pass: true } }).verdict, 'not-verified');
  assert.equal(buildAcceptanceRow(complete('a'), { ...full, alignment: { pass: false } }).verdict, 'not-verified');
  assert.equal(buildAcceptanceRow(complete('a'), { ...full, roads: undefined }).verdict, 'not-verified');
});

test('24区に満たない/未検証があれば allVerified は false', () => {
  const keys = Array.from({ length: 24 }, (_, i) => `w${i}`);
  const results = keys.map(complete);
  const full = { buildings: px, roads: px, water: px, alignment: { pass: true } };
  const all = Object.fromEntries(keys.map((k) => [k, full]));
  assert.equal(buildAcceptanceTable(results, all).allVerified, true);
  const some = { ...all }; delete some.w5;
  const t = buildAcceptanceTable(results, some);
  assert.equal(t.allVerified, false);
  assert.equal(t.browserVerified, 23);
  assert.match(renderMarkdown(t), /24区完成ではない/);
  assert.equal(buildAcceptanceTable(results.slice(0, 21), {}).allVerified, false);
});

test('restore: 危険な tar メンバー名を拒否し、asset 名/区キーを検証する', () => {
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'C:\\x', 'a\\..\\b']) assert.equal(isUnsafeTarMember(bad), true, bad);
  for (const good of ['kita/tileset.json', './kita/a.glb']) assert.equal(isUnsafeTarMember(good), false, good);
  assert.equal(assetNameFor('kita'), 'plateau2025-kita.tar.gz');
  assert.equal(validWardKey('kita'), true);
  assert.equal(validWardKey('../kita'), false);
});
