'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const lib = require('../tools/mission79-build-ward-2025.cjs');

test('source lock: 27100 FY2025 CityGML v5, not the Expo 27999 dataset, attribution present', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/mission79/source-lock.json'), 'utf8'));
  assert.equal(lock.package.name, 'plateau-27100-osaka-shi-2025');
  assert.match(lock.resource.url, /27100_osaka-shi_city_2025_citygml_1_op\.zip$/);
  assert.ok(!/27999/.test(JSON.stringify(lock.resource)));
  assert.ok(lock.http.contentLength > 1e9 && lock.http.etag);
  assert.match(lock.attribution, /Project PLATEAU/);
  assert.equal(lock.license.id, 'plateau');
  assert.ok(lock.entries.every((e) => ['bldg', 'tran'].includes(e.kind) && /^\d{8}$/.test(e.mesh)));
  assert.equal(lock.entries.filter((e) => e.kind === 'bldg').length, 270);
});

test('source tool: guard rejects other packages; ZIP64 central directory parsed', async () => {
  const s = await import('../tools/mission79-plateau2025-source.mjs');
  assert.throws(() => s.guardPackage({ name: 'plateau-27999-osaka-shi-2025' }));
  s.guardPackage({ name: 'plateau-27100-osaka-shi-2025' });
  const name = Buffer.from('udx/bldg/52350318_bldg_6697_op.gml');
  const extra = Buffer.alloc(4 + 24);
  extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(5_000_000_000n, 4); extra.writeBigUInt64LE(1_000_000n, 12); extra.writeBigUInt64LE(4_500_000_000n, 20);
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(8, 10);
  h.writeUInt32LE(0xffffffff, 20); h.writeUInt32LE(0xffffffff, 24); h.writeUInt16LE(name.length, 28); h.writeUInt16LE(extra.length, 30); h.writeUInt32LE(0xffffffff, 42);
  const [e] = s.parseCentralDirectory(Buffer.concat([h, name, extra]));
  assert.equal(e.uncompressedBytes, 5_000_000_000);
  assert.equal(e.compressedBytes, 1_000_000);
  assert.equal(e.localOffset, 4_500_000_000);
  assert.equal(s.kindOf(e.name), 'bldg');
  void zlib;
});

test('mesh selection for Nishi uses the N03 bbox and the 2025 lock (no hard-coded meshes)', async () => {
  const run = await import('../tools/mission79-run.mjs');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/mission79/source-lock.json'), 'utf8'));
  const area = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/areas/osaka-city.json'), 'utf8'));
  const polys = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/processed/osaka-city/boundaries/ward-classification-polygons.json'), 'utf8'));
  const sel = run.selectMeshes(lock, polys.wards.find((w) => w.wardId === 'nishi'), area.projection);
  assert.ok(sel.meshes.includes('52350318') && sel.meshes.includes('52350319'));
  assert.ok(sel.meshes.length >= 4 && sel.meshes.length <= 30);
  // every ward gets at least one mesh from the 2025 lock
  for (const w of polys.wards) assert.ok(run.selectMeshes(lock, w, area.projection).meshes.length >= 1, w.wardId);
});

test('orientation scan flags mirrored/rotated road layers (identity must have the fewest building-on-road hits)', () => {
  // Asymmetric synthetic city: roads are L-shaped blocks placed around buildings that lie in the gaps.
  const roads = []; const pts = [];
  for (let i = 0; i < 12; i++) {
    const x = 100 + i * 60;
    roads.push([[[x, 0], [x + 10, 0], [x + 10, 30 + i * 8], [x, 30 + i * 8], [x, 0]]]);
    pts.push([x + 30, 10 + i * 4]); // beside the road, never on it
  }
  const ok = lib.orientationScan(pts, roads);
  assert.equal(ok.bestTransform, 'identity');
  assert.equal(ok.candidates.identity.hits, 0);
  // Misaligned scenario: the same buildings now sit on top of the road layer -> identity is no longer the minimum.
  const onRoad = roads.map((r) => [r[0][0][0] + 5, 10]);
  const bad = lib.orientationScan(onRoad, roads);
  assert.equal(bad.candidates.identity.hits, onRoad.length);
  assert.notEqual(bad.bestTransform, 'identity');
  assert.equal(bad.orientationOk, false);
});

test('crosswalk never rewrites IDs; reports exact / candidate / new / legacy-only separately', () => {
  const legacy = new Map([
    ['bldg_a', { repX: 0, repZ: 0, h: 10 }],
    ['bldg_old', { repX: 100, repZ: 100, h: 5 }],
    ['bldg_gone', { repX: 500, repZ: 500, h: 5 }],
  ]);
  const nb = [
    { id: 'bldg_a', repX: 0, repZ: 0, h: 12 },
    { id: 'bldg_new_same_place', repX: 101, repZ: 100.5, h: 5 },
    { id: 'bldg_brand_new', repX: 900, repZ: 900, h: 5 },
  ];
  const cw = lib.crosswalk(nb, legacy);
  assert.equal(cw.summary.exactId, 1);
  assert.equal(cw.summary.geometricCandidate, 1);
  assert.equal(cw.summary.newOnly, 1);
  assert.equal(cw.summary.legacyOnly, 1); // bldg_gone only: not declared demolished
  assert.deepEqual(cw.legacyOnlyIds, ['bldg_gone']);
  const cand = cw.rows.find((r) => r.method === 'centroid-candidate');
  assert.equal(cand.id2025, 'bldg_new_same_place');
  assert.equal(cand.id2022, 'bldg_old'); // a candidate, recorded beside - never substituted
  assert.match(cw.summary.policy, /never rewritten/);
});

test('build tool refuses non-empty or legacy output dirs and never writes under legacy tilesets', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'm79t-'));
  fs.writeFileSync(path.join(tmp, 'keep.txt'), 'x');
  const r = spawnSync(process.execPath, ['tools/mission79-build-ward-2025.cjs', '--ward', 'nishi', '--jsonl', '/nonexistent', '--out', tmp], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /non-empty/);
  assert.equal(fs.readFileSync(path.join(tmp, 'keep.txt'), 'utf8'), 'x');
  const r2 = spawnSync(process.execPath, ['tools/mission79-build-ward-2025.cjs', '--ward', 'nishi', '--jsonl', '/nonexistent', '--out', path.join(ROOT, 'public/mission37h-3dtiles/zzz')], { cwd: ROOT, encoding: 'utf8' });
  assert.match(r2.stderr, /legacy output/);
});

test('tools are read-only toward legacy data and do not touch paid services', () => {
  for (const f of ['mission79-plateau2025-source.mjs', 'mission79-plateau2025-fetch.mjs', 'mission79-run.mjs', 'mission79-build-ward-2025.cjs']) {
    const s = fs.readFileSync(path.join(ROOT, 'tools', f), 'utf8');
    assert.ok(!/rmSync\([^)]*(legacy|public)/.test(s), f);
    assert.ok(!/googleapis|vercel|r2\.cloudflare|amazonaws/i.test(s), f);
  }
});

test('recorded Nishi 2025 run: orientation identity, IDs unique, no legacy offset', () => {
  const dir = path.join(ROOT, 'data/reports/mission79');
  const f = path.join(dir, 'nishi-2025-run.json');
  if (!fs.existsSync(f)) return;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(j.alignment.bestTransform, 'identity');
  assert.equal(j.buildings, j.uniqueIds);
  assert.equal(j.crosswalk.exactIdOffsetM.max, 0);
});

// Mission 84: Konohana mesh 51357341 has a bldg entry but no tran entry in the official 2025 lock.
test('mission84: fetch tolerates a missing tran entry but never a missing bldg or unknown mesh', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/mission79/source-lock.json'), 'utf8'));
  const has = (m, k) => lock.entries.some((e) => e.mesh === m && e.kind === k);
  assert.equal(has('51357341', 'bldg'), true);
  assert.equal(has('51357341', 'tran'), false);
  const src = fs.readFileSync(path.join(ROOT, 'tools/mission79-plateau2025-fetch.mjs'), 'utf8');
  assert.match(src, /lockHasNoEntryForKind/);
  assert.match(src, /meshes not in 2025 lock/);
  assert.match(src, /every\(\(k\) => k === 'tran'\)/);
});
