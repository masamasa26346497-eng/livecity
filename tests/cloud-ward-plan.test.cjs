'use strict';
// Mission 201: 24区計画・shard・index の静的テスト(ネットワーク不要)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const build = fs.readFileSync(path.join(ROOT, 'tools/cloud/build-cloud-preview.mjs'), 'utf8');

test('shardWards は決定的で範囲外/重複を拒否する', async () => {
  const { shardWards } = await import('../tools/cloud/ward-plan.mjs');
  const l = ['a', 'b', 'c', 'd', 'e'];
  assert.deepStrictEqual(shardWards(l, null), l);
  assert.deepStrictEqual(shardWards(l, '1/2'), ['a', 'c', 'e']);
  assert.deepStrictEqual(shardWards(l, '2/2'), ['b', 'd']);
  assert.throws(() => shardWards(l, '3/2'));
  assert.throws(() => shardWards(l, 'x'));
  assert.throws(() => shardWards(['a', 'a'], null));
});

test('buildIndex は24区を列挙し未配信を served と表示しない', async () => {
  const { buildIndex } = await import('../tools/cloud/ward-plan.mjs');
  const reg = require('../config/wards/registry.json').wards;
  const idx = buildIndex(reg, [{ id: 'kita', buildings: 10 }]);
  assert.strictEqual(idx.wards.length, 24);
  assert.strictEqual(idx.servedCount, 1);
  assert.strictEqual(idx.wards.filter((w) => w.status === 'served').length, 1);
  assert.ok(idx.wards.filter((w) => w.status === 'not-served').every((w) => w.tileset === null));
});

test('read-only plan は24区・実測合計615234棟・未検証の上限を明示', async () => {
  const P = await import('../tools/cloud/ward-plan.mjs');
  const plans = P.planWards(P.loadInputs(), null, ['kita', 'chuo', 'nishi']);
  assert.strictEqual(plans.length, 24);
  assert.strictEqual(plans.filter((p) => p.served).length, 3);
  assert.strictEqual(plans.reduce((n, p) => n + p.measured.buildings, 0), 615234);
  assert.ok(plans.every((p) => p.sourceMeshes > 0 && p.downloadCompressedMB > 0));
  const est = P.estimateTotals(plans);
  assert.ok(est.lod1GlbMB.low < est.lod1GlbMB.mid && est.lod1GlbMB.mid < est.lod1GlbMB.high);
  assert.strictEqual(P.VERCEL_HOBBY_ASSUMED.verified, false);
});

test('build は --plan-only/--shard/--resume を持ち、plan はネットワークを使わない', () => {
  assert.ok(build.includes('--plan-only') && build.includes('shardWards(') && build.includes('--resume'));
  assert.ok(!/fetch\(|https?\.get|node:http/.test(fs.readFileSync(path.join(ROOT, 'tools/cloud/ward-plan.mjs'), 'utf8')));
});

test('vercel.json の既定ビルド(北区・中央区・西区)は変更されていない', () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.strictEqual(v.buildCommand, 'node tools/cloud/build-cloud-preview.mjs --wards kita,chuo,nishi');
});
