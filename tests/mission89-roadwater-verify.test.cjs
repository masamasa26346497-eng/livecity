'use strict';
// Mission 89: 無通信・軽量 fixture のみ。fixture/CI は受入にならないこと、閾値根拠が無ければ verified にならないことを固定する。
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..');
const V = () => import('../tools/mission89-roadwater-verify.mjs');
const A = () => import('../tools/mission86-acceptance.mjs');
const src = fs.readFileSync(path.join(ROOT, 'tools/mission89-roadwater-verify.mjs'), 'utf8').replace(/\/\/.*$/gm, '');

// 道路: x=-5..5 の南北帯(z -200..200)。建物は帯の東西 20m 離れた所に置く（道路上には載らない）。
const road = [[[[-5, -200], [5, -200], [5, 200], [-5, 200], [-5, -200]]]];
const bldgs = [];
for (let z = -150; z <= 150; z += 10) bldgs.push([20, z], [-20, z]);
const th = { ok: true, basis: 'fixture-only basis, not a real threshold', approvedBy: 'test', minSamples: 10, minOrientationMargin: 0, maxBuildingHitRatePct: 1, maxOffsetM: 40, maxMedianNearestEdgeM: 30 };

test('no thresholds -> metrics reported but never verified; bad threshold files rejected', async () => {
  const v = await V();
  const r = v.checkLayer({ name: 'tran', features: road, buildingPts: bldgs, th: { ok: false, why: 'none' } });
  assert.strictEqual(r.status, 'unverified');
  assert.strictEqual(r.metrics.samples, bldgs.length);
  const bads = [{}, { basis: 'short', approvedBy: 'x' }, { basis: 'long enough basis text here', minSamples: 1 }];
  bads.forEach((bad, i) => {
    const f = path.join(os.tmpdir(), 'th89-' + process.pid + '-' + i + '.json');
    fs.writeFileSync(f, JSON.stringify(bad));
    assert.strictEqual(v.loadThresholds(f).ok, false);
    fs.unlinkSync(f);
  });
  assert.strictEqual(v.loadThresholds('/nonexistent/th.json').ok, false);
});

test('buildings clear of the road with explicit thresholds -> verified; buildings are never moved', async () => {
  const v = await V();
  const before = JSON.stringify(bldgs);
  const r = v.checkLayer({ name: 'tran', features: road, buildingPts: bldgs, th });
  assert.strictEqual(r.metrics.identityHits, 0);
  assert.strictEqual(r.status, 'verified', r.reason);
  assert.strictEqual(JSON.stringify(bldgs), before);
  assert.ok(src.includes('transformLayer(features, f)'), 'transforms are applied to the layer');
  assert.ok(!/transformLayer\(\s*buildingPts/.test(src));
});

test('buildings sitting on the road -> failed', async () => {
  const v = await V();
  const onRoad = bldgs.map(([x, z]) => [x === 20 ? 0 : x, z]);
  const r = v.checkLayer({ name: 'tran', features: road, buildingPts: onRoad, th });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.reason, /%/);
});

test('too few samples -> unverified, empty layer -> unverified', async () => {
  const v = await V();
  assert.strictEqual(v.checkLayer({ name: 'tran', features: road, buildingPts: bldgs.slice(0, 3), th }).status, 'unverified');
  assert.strictEqual(v.checkLayer({ name: 'wtr', features: [], buildingPts: bldgs, th }).status, 'unverified');
});

test('road x water crossing is not scored: only building signals are used', async () => {
  const v = await V();
  const river = [[[[-300, -10], [300, -10], [300, 10], [-300, 10], [-300, -10]]]];   // 橋で道路と交差する川
  const away = bldgs.filter(([, z]) => Math.abs(z) > 30);
  assert.strictEqual(v.checkLayer({ name: 'wtr', features: river, buildingPts: away, th: Object.assign({}, th, { maxMedianNearestEdgeM: 200 }) }).status, 'verified');
  assert.ok(src.includes('roadWaterCrossingScoredAsError: false'));
  assert.ok(!/intersect/i.test(src));
});

test('GML must be bound to source-lock entries of the same kind; current lock has no wtr', async () => {
  const v = await V();
  const lock = { entries: [{ kind: 'tran', mesh: '51357341', name: 'x/51357341_tran_6697_op.gml' }, { kind: 'bldg', mesh: '51357341', name: 'x/51357341_bldg_6697_op.gml' }] };
  const ok = v.bindToLock({ files: ['d/51357341_tran_6697_op.gml'], kind: 'tran', lock, wardMeshes: ['51357341', '51357342'] });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.uncoveredMeshes, ['51357342']);
  assert.strictEqual(v.bindToLock({ files: ['d/51357399_tran_6697_op.gml'], kind: 'tran', lock, wardMeshes: ['51357341'] }).ok, false);
  assert.strictEqual(v.bindToLock({ files: ['d/51357341_wtr_6697_op.gml'], kind: 'wtr', lock, wardMeshes: ['51357341'] }).lockHasKind, false);
  const real = path.join(ROOT, 'data/reports/mission79/source-lock.json');
  if (fs.existsSync(real)) assert.ok(!JSON.parse(fs.readFileSync(real, 'utf8')).entries.some((e) => e.kind === 'wtr'), 'lock gained wtr: revisit water policy');
});

test('GML parser: lat,lon axis order is verified, not assumed', async () => {
  const v = await V();
  const proj = { centerLat: 34.6, centerLon: 135.5, metersPerDegree: 111320 };
  const ok = '<tran:Road><gml:posList>34.6 135.5 0 34.6 135.501 0 34.601 135.501 0 34.6 135.5 0</gml:posList></tran:Road>';
  assert.strictEqual(v.parseGmlRings(ok, 'tran:Road', proj).length, 1);
  const swapped = ok.replace('34.6 135.5 0 34.6 135.501', '135.5 34.6 0 135.501 34.6');
  assert.throws(() => v.parseGmlRings(swapped, 'tran:Road', proj), /axis order/);
});

function report(over) {
  return Object.assign({
    kind: 'roadwater-alignment', method: 'roadwater-independent-v1', ward: 'nishi', vintage: 2025, origin: 'local-pc', fixture: false, scope: 'horizontal-only', verticalChecked: false,
    inputs: { tilesetSha256: 'T', lockEtag: 'E' }, thresholds: { basis: 'real basis text long enough', approvedBy: 'owner' }, status: 'verified',
    road: { status: 'verified', features: 5, metrics: { samples: 100, estimatedOffsetM: 5 } }, water: { status: 'verified', features: 2, metrics: { samples: 100, estimatedOffsetM: 0 } },
  }, over || {});
}
async function sealed(over) {
  const v = await V();
  const r = report(over);
  r.integrity = { digest: v.integrityDigest(r) };
  return r;
}
const ctx = { ward: 'nishi', tilesetSha256: 'T', lockEtag: 'E' };

test('toEvidence: only a sealed, local-pc, hash-bound, threshold-justified, both-layers-verified report yields verified', async () => {
  const v = await V();
  assert.strictEqual(v.toEvidence(await sealed(), ctx).status, 'verified');
  const rej = async (over, c) => v.toEvidence(await sealed(over), c || ctx).status;
  assert.strictEqual(await rej({ origin: 'ci-runner' }), 'unverified');
  assert.strictEqual(await rej({ fixture: true }), 'unverified');
  assert.strictEqual(await rej({ vintage: 2022 }), 'unverified');
  assert.strictEqual(await rej({ thresholds: {} }), 'unverified');
  assert.strictEqual(await rej({ verticalChecked: true }), 'unverified');
  assert.strictEqual(await rej({}, Object.assign({}, ctx, { tilesetSha256: 'OTHER' })), 'unverified');
  assert.strictEqual(await rej({}, Object.assign({}, ctx, { lockEtag: 'OTHER' })), 'unverified');
  assert.strictEqual(await rej({ status: 'unverified', water: { status: 'unverified', features: 0, metrics: null } }), 'unverified');
  const tampered = await sealed();
  tampered.road.features = 999;
  assert.strictEqual(v.toEvidence(tampered, ctx).status, 'unverified');
});

test('Mission86 gate requires the independent-verification fields', async () => {
  const a = await A();
  const s86 = fs.readFileSync(path.join(ROOT, 'tools/mission86-acceptance.mjs'), 'utf8');
  assert.ok(s86.includes('roadwater-independent-v1') && s86.includes('reportDigest') && s86.includes('thresholds.basis'));
  assert.ok(a.ITEMS.includes('roadWater'));
  const v = await V();
  const ev = v.toEvidence(await sealed(), ctx);
  for (const k of ['method', 'vintage', 'scope', 'verticalChecked', 'thresholds', 'reportDigest', 'samples', 'waterChecked', 'roadsChecked', 'maxOffsetM']) assert.ok(k in ev, k);
});

test('read-only / no network / no destructive calls; fixture and CI never local-pc', async () => {
  assert.ok(!/fetch\(|node:http|child_process|rmSync|unlinkSync|copyFile|renameSync/.test(src));
  assert.ok(!/opt\('origin'/.test(src));
  const C = await import('../tools/mission88-collect-evidence.mjs');
  assert.strictEqual(C.detectOrigin({ GITHUB_ACTIONS: 'true' }, {}).origin, 'ci-runner');
  assert.strictEqual(C.detectOrigin({}, { fixture: true }).origin, 'fixture');
});
