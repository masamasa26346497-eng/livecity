'use strict';
// Mission 38E: 新区メッシュ選定プラン（オフライン）。ネットワーク不要。取得そのものは検証しない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { plan, mesh3Bounds } = require('../tools/mission38e-plan-ward-mesh.cjs');
const ROOT = path.join(__dirname, '..');
const EXISTING = ['kita', 'chuo', 'tennoji', 'nishi', 'sumiyoshi', 'higashisumiyoshi', 'hirano'];

for (const ward of ['naniwa', 'fukushima']) {
  test('plan ' + ward + ': 1メッシュ・10MB以内・80%以上が区内・既存区ではない', () => {
    const p = plan(ward);
    assert.strictEqual(p.status, 'PLAN_ONLY_NOT_FETCHED');
    assert.ok(!EXISTING.includes(ward));
    assert.ok(p.selected, 'no candidate');
    assert.ok(p.selected.wardSampleFraction >= 0.8);
    assert.ok(p.selected.compressedBytes < 10 * 1024 * 1024);
    assert.match(p.source.url, /^https:\/\/assets\.cms\.plateau\.reearth\.io\//);
    assert.ok(p.fetchCommand.includes('--meshes=' + p.selected.mesh));
    assert.ok(p.candidates.every((c) => c.localOffset > 0 && c.method === 8));
  });
}

test('mesh3Bounds: 51357399 は大阪市浪速区付近（北緯34.6-34.7 / 東経135.4-135.6）', () => {
  const b = mesh3Bounds('51357399');
  assert.ok(b.south > 34.6 && b.north < 34.7 && b.west > 135.4 && b.east < 135.6);
});

test('取得器は --meshes で巨大ZIP全量ではなくRange取得に限定される（静的監査）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/mission36k-fetch-citygml-ward-range.mjs'), 'utf8');
  assert.ok(src.includes("--meshes="));
  assert.ok(src.includes('range: `bytes='));
  assert.ok(src.includes('res.status !== 206'));
});

test('コミット済みプランが現行算出結果と一致し、課金APIを参照しない', () => {
  const f = path.join(ROOT, 'public/mission38e-3dtiles/plans/naniwa-mesh-plan.json');
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(saved, JSON.parse(JSON.stringify(plan('naniwa'))));
  assert.ok(!/googleapis|photorealistic|places/i.test(fs.readFileSync(path.join(ROOT, 'tools/mission38e-plan-ward-mesh.cjs'), 'utf8').replace(/Places/g, '')));
});
