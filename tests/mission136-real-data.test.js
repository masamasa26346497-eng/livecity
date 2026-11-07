// Mission 136: 実建物フットプリント経路・建物ディレクトリ規約アダプター・実データ E2E レポートの不変条件・状態表。ブラウザ不要。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer, resolveBuildingDir, footprintInfo, wardIndex } from '../tools/mission135/server.js';
import { wardStates, verifiedFromMission136 } from '../tools/mission135/ward-status.js';
import { generate } from '../tools/mission136/gen-water-surface.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm136t-'));
const wj = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const get = (port, p, headers = {}) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res({ s: r.statusCode, b })); }).on('error', rej));
async function serve(opts) { let actual = 0; const srv = createServer({ ...opts, getPort: () => actual }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); actual = srv.address().port; return { srv, port: actual }; }

test('resolveBuildingDir accepts <ward>25 and restore-release layouts, rejects empty/missing/symlink', () => {
  const root = tmp();
  assert.equal(resolveBuildingDir(root, 'kita'), null);
  fs.mkdirSync(path.join(root, 'kita25')); assert.equal(resolveBuildingDir(root, 'kita'), null, 'dir without tileset.json is not success');
  wj(path.join(root, 'kita25/tileset.json'), {}); assert.equal(resolveBuildingDir(root, 'kita'), 'kita25');
  wj(path.join(root, '_x_chuo/tileset.json'), {}); assert.equal(resolveBuildingDir(root, 'chuo'), '_x_chuo');
  wj(path.join(root, '_x_nishi/nishi25/tileset.json'), {}); assert.equal(resolveBuildingDir(root, 'nishi'), '_x_nishi/nishi25');
  wj(path.join(root, '_x_minato/plateau2025/tileset.json'), {}); assert.equal(resolveBuildingDir(root, 'minato'), '_x_minato/plateau2025');
  const real = tmp(); wj(path.join(real, 'tileset.json'), {}); fs.symlinkSync(real, path.join(root, 'sym25'));
  assert.equal(resolveBuildingDir(root, 'sym'), null, 'symlinked dir rejected');
  assert.equal(resolveBuildingDir(root, '../x'), null); assert.equal(resolveBuildingDir(null, 'kita'), null);
});

test('server: footprint route serves manifest+tiles with 200, everything else 404 (no fake success)', async () => {
  const fp = tmp(), layers = tmp();
  wj(path.join(fp, 'osaka-kita/manifest.json'), { totalBuildings: 1, tileCount: 1, coordinateConvention: 'znorth-neg-v1', tiles: [{ file: 'tile_0_0.json' }] });
  wj(path.join(fp, 'osaka-kita/tile_0_0.json'), { buildings: [] });
  wj(path.join(fp, 'osaka-kita/secret.json'), { x: 1 });
  const { srv, port } = await serve({ buildingsRoot: null, layersRoot: layers, footprintsRoot: fp });
  try {
    assert.equal((await get(port, '/ext-3dtiles/kita/footprints/manifest.json')).s, 200);
    assert.equal((await get(port, '/ext-3dtiles/kita/footprints/tile_0_0.json')).s, 200);
    assert.equal((await get(port, '/ext-3dtiles/kita/footprints/secret.json')).s, 404, 'allowlist only');
    assert.equal((await get(port, '/ext-3dtiles/chuo/footprints/manifest.json')).s, 404);
    assert.equal((await get(port, '/ext-3dtiles/kita25/tileset.json')).s, 404);
    assert.equal((await get(port, '/ext-3dtiles/kita/footprints/../manifest.json')).s, 404);
    assert.equal((await get(port, '/ext-3dtiles/kita/footprints/manifest.json', { Host: 'evil.example' })).s, 403);
  } finally { srv.close(); }
});

test('server: 3D Tiles are served from the restore layout (<_x_ward>) under the viewer URL <ward>25', async () => {
  const b = tmp(); wj(path.join(b, '_x_kita/tileset.json'), { asset: { version: '1.1' } }); fs.writeFileSync(path.join(b, '_x_kita/a.glb'), 'glb');
  const { srv, port } = await serve({ buildingsRoot: b, layersRoot: tmp(), footprintsRoot: null });
  try {
    assert.equal((await get(port, '/ext-3dtiles/kita25/tileset.json')).s, 200);
    assert.equal((await get(port, '/ext-3dtiles/kita25/a.glb')).s, 200);
    assert.equal((await get(port, '/ext-3dtiles/chuo25/tileset.json')).s, 404);
    const idx = JSON.parse((await get(port, '/index.json')).b);
    assert.equal(idx.wards.find((w) => w.wardId === 'kita').available.buildings, true);
    assert.equal(idx.wards.find((w) => w.wardId === 'chuo').available.buildings, false);
  } finally { srv.close(); }
});

test('wardIndex flags real footprints separately from 3D Tiles', () => {
  const fp = tmp(); wj(path.join(fp, 'osaka-sumiyoshi/manifest.json'), { totalBuildings: 5, tileCount: 2 });
  const idx = wardIndex({ buildingsRoot: tmp(), layersRoot: tmp(), footprintsRoot: fp });
  const w = idx.find((x) => x.wardId === 'sumiyoshi');
  assert.equal(w.available.buildingFootprints, true); assert.equal(w.available.buildings, false);
  assert.deepEqual(footprintInfo(fp, 'sumiyoshi'), { totalBuildings: 5, tileCount: 2 });
  assert.equal(footprintInfo(fp, 'kita'), null);
});

test('real repo data: sumiyoshi footprints match the manifest (tile count, building count, convention)', () => {
  const root = 'public/map-data/osaka-city/buildings/osaka-sumiyoshi';
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(m.coordinateConvention, 'znorth-neg-v1'); assert.equal(m.tiles.length, m.tileCount);
  let n = 0; for (const t of m.tiles) { const j = JSON.parse(fs.readFileSync(path.join(root, t.file), 'utf8')); assert.equal(j.buildings.length, t.count); n += j.buildings.length; }
  assert.equal(n, m.totalBuildings);
});

test('viewer: footprint fallback keeps canonicalId on GeometryInstance, validates convention, never fakes success', () => {
  const js = fs.readFileSync('public/mission135-ward-viewer.js', 'utf8');
  assert.match(js, /loadFootprints/); assert.match(js, /id: b\.id,/); assert.match(js, /coordinateConvention !== 'znorth-neg-v1'/);
  assert.match(js, /tileset \/ footprints とも HTTP 404/); assert.match(js, /footprint tiles incomplete/);
  assert.doesNotMatch(js, /OFFSET_|rotateBy|addDeg/);
});

test('gen-water-surface: deterministic, offline, refuses non-empty --out', () => {
  const out = path.join(tmp(), 'map'); const r = generate(out);
  assert.equal(r.validation, 'PASS'); assert.ok(r.triangles > 1000);
  const doc = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(doc.coordinateConvention, 'znorth-neg-v1'); assert.equal(doc.emitted, true);
  assert.throws(() => generate(out), /empty or not exist/);
});

test('ward-status counts only passing real reports; mixed-synthetic reports never verify', () => {
  const rep = (o) => ({ allPassed: true, ward: 'sumiyoshi', ...o });
  assert.equal(verifiedFromMission136([rep({ dataKind: 'real-buildings+synthetic-layers', realBuildingsVerified: false })]).size, 1);
  assert.deepEqual(verifiedFromMission136([rep({ dataKind: 'real-buildings+synthetic-layers', realBuildingsVerified: false })]).get('sumiyoshi'), {});
  assert.deepEqual(verifiedFromMission136([rep({ dataKind: 'real-buildings-only', realBuildingsVerified: true })]).get('sumiyoshi'), { buildings: true });
  assert.equal(verifiedFromMission136([rep({ allPassed: false, dataKind: 'real-buildings-only', realBuildingsVerified: true })]).size, 0);
  const fp = tmp(); wj(path.join(fp, 'osaka-sumiyoshi/manifest.json'), { totalBuildings: 1, tileCount: 1 });
  const rows = wardStates({ buildingsRoot: tmp(), layersRoot: tmp(), footprintsRoot: fp, mission136Reports: [rep({ dataKind: 'real-buildings-only', realBuildingsVerified: true })] });
  const s = rows.find((r) => r.wardId === 'sumiyoshi');
  assert.equal(s.layers.buildings, 'webgl-verified'); assert.equal(s.layers.roads, 'not-acquired'); assert.equal(s.allWebglVerified, false);
  assert.equal(rows.filter((r) => r.allWebglVerified).length, 0, '0/24 until roads+rivers are real and verified');
});

test('committed Mission136 reports: real-buildings stage passed; no report claims 3-layer or 24-ward real proof', () => {
  const dir = 'data/reports/mission136';
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'real-buildings-e2e.json'), 'utf8'));
  assert.equal(a.allPassed, true); assert.equal(a.dataKind, 'real-buildings-only'); assert.equal(a.realBuildingsVerified, true);
  assert.equal(a.footprint.buildings, 35031); assert.equal(a.http.tileCount, 52); assert.deepEqual(a.http.tileStatuses, [200]);
  assert.ok(a.click.matched / a.click.samples >= 0.8);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.equal(r.threeLayersRealVerified, false, f); assert.equal(r.realData24WardsProven, false, f);
  }
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'real-buildings-synthetic-layers-e2e.json'), 'utf8'));
  assert.equal(m.realBuildingsVerified, false, 'mixed run must not count as real verification');
});
