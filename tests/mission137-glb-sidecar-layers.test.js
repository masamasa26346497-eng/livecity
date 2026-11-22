// Mission 137: GLB/sidecar 契約・復元済み建物の検査・rivers-v2/道路面の adapter・クリック不一致分類・E2E レポート不変条件。ブラウザ不要。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectRiversV2, deriveRoadSurface, buildWardLayers, STATES } from '../tools/lib/ward-layer-adapter.js';
import { inspectWard } from '../tools/mission137/link-restored-buildings.js';
import { classify, pip } from '../tools/mission137/click-mismatch-analysis.js';
import { writeBuildings, fixtureGeometry } from '../tools/mission135/make-fixtures.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm137t-'));
const wj = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const BBOX = { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 };

test('rivers-v2: centerline + ribbon(area) 変換。座標不変、suppressed/ok=false/規約違いは出さない', () => {
  const root = tmp();
  wj(path.join(root, 'rivers-v2/rivers.json'), { version: 2, coordinateConvention: 'znorth-neg-v1', rivers: [
    { id: 'a', name: 'A', ok: true, riverClass: 'major', centerline: [[100, 100], [200, 100]], left: [[100, 110], [200, 110]], right: [[100, 90], [200, 90]] },
    { id: 'b', ok: true, suppressed: true, centerline: [[100, 100], [200, 100]], left: [[100, 110], [200, 110]], right: [[100, 90], [200, 90]] },
    { id: 'c', ok: false, centerline: [[100, 100], [200, 100]] },
    { id: 'far', ok: true, centerline: [[9000, 9000], [9100, 9000]], left: [[9000, 9010], [9100, 9010]], right: [[9000, 8990], [9100, 8990]] },
  ] });
  const r = collectRiversV2(root, BBOX);
  assert.equal(r.state, STATES.GENERATED);
  assert.deepEqual(r.features.map((f) => f.id), ['rv2-line-a', 'rv2-area-a']);
  assert.deepEqual(r.features[0].p, [[100, 100], [200, 100]], '座標は変換しない');
  assert.equal(r.features[1].p.length, 4); assert.deepEqual(r.features[1].p[2], [200, 90], 'left + reverse(right)');
  wj(path.join(root, 'rivers-v2/rivers.json'), { version: 2, coordinateConvention: 'other', rivers: [] });
  assert.equal(collectRiversV2(root, BBOX).state, STATES.REJECTED);
  assert.equal(collectRiversV2(tmp(), BBOX).state, STATES.NOT_ACQUIRED, '入力なしは未取得（捏造しない）');
});

test('buildWardLayers: rivers-v2 のみでも waterways が生成され、roads が無ければ未取得のまま', () => {
  const map = tmp(), out = tmp();
  wj(path.join(map, 'rivers-v2/rivers.json'), { version: 2, coordinateConvention: 'znorth-neg-v1', rivers: [{ id: 'a', ok: true, centerline: [[100, 100], [200, 100]], left: [[100, 110], [200, 110]], right: [[100, 90], [200, 90]] }] });
  const r = buildWardLayers({ mapRoot: map, outRoot: out, ward: { wardId: 'kita', bbox: BBOX }, roadSurface: true });
  assert.equal(r.layers.waterways.state, 'generated'); assert.equal(r.layers.roads.state, 'not-acquired');
  assert.equal(r.layers.riversV2.count, 2);
  assert.equal(fs.existsSync(path.join(out, 'kita/layers/roads.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'kita/layers/waterways.json'), 'utf8')).features.length, 2);
});

test('deriveRoadSurface: 路面帯と 3 本以上の交差点だけを derived:true で導出（元 line は変更しない）', () => {
  const lines = [
    { id: 'r1', kind: 'line', highway: 'primary', p: [[0, 0], [100, 0]] },
    { id: 'r2', kind: 'line', highway: 'residential', p: [[50, -50], [50, 0]] },
    { id: 'r3', kind: 'line', highway: 'residential', p: [[50, 0], [50, 50]] },
    { id: 'r4', kind: 'line', highway: 'residential', p: [[50, 0], [80, 40]] },
  ];
  const snap = JSON.stringify(lines);
  const d = deriveRoadSurface(lines);
  assert.equal(JSON.stringify(lines), snap);
  assert.equal(d.surfaces, 4); assert.equal(d.junctions, 1, '(50,0) は r2,r3,r4 が共有。r1 の端点ではない');
  assert.ok(d.features.every((f) => f.derived === true && f.kind === 'area'));
  const band = d.features.find((f) => f.id === 'rs-r1');
  assert.deepEqual(band.p[0], [0, 6]); assert.deepEqual(band.p[1], [100, 6]); // primary 半幅 6m
  const pts = band.p.map((p) => p[1]); assert.equal(Math.min(...pts), -6);
});

test('inspectWard: fixture(GLB+sidecar) は ready。sidecar 欠落は ID 未解決、偽 GLB/外部URI/無し は ready にしない', () => {
  const root = tmp();
  const ward = { wardId: 'kita', bbox: { minX: -2500, maxX: -2300, minZ: -11000, maxZ: -10900 } };
  const geo = fixtureGeometry(ward.bbox); writeBuildings(root, ward, geo);
  const ok = inspectWard(root, 'kita');
  assert.equal(ok.state, 'ready'); assert.equal(ok.glbCount, 1); assert.equal(ok.withoutIdSidecar, 0); assert.equal(ok.canonicalIdClick, 'available');
  fs.rmSync(path.join(root, 'kita25/ids/b.json'));
  const ns = inspectWard(root, 'kita'); assert.equal(ns.state, 'ready'); assert.equal(ns.withoutIdSidecar, 1); assert.match(ns.canonicalIdClick, /unresolved/);
  fs.writeFileSync(path.join(root, 'kita25/b.glb'), 'not a glb');
  assert.equal(inspectWard(root, 'kita').state, 'rejected');
  wj(path.join(root, 'kita25/tileset.json'), { root: { content: { uri: 'https://evil.example/x.glb' } } });
  const ext = inspectWard(root, 'kita'); assert.equal(ext.state, 'rejected'); assert.match(ext.problems[0], /unsafe-uri/);
  assert.equal(inspectWard(root, 'chuo').state, 'not-acquired');
});

test('fixture GLB: EXT_mesh_features + property table(EXT_structural_metadata) + sidecar は建物数と一致', () => {
  const root = tmp(), ward = { wardId: 'kita', bbox: { minX: -2500, maxX: -2300, minZ: -11000, maxZ: -10900 } };
  const geo = fixtureGeometry(ward.bbox); writeBuildings(root, ward, geo);
  const glb = fs.readFileSync(path.join(root, 'kita25/b.glb'));
  const jl = glb.readUInt32LE(12), json = JSON.parse(glb.toString('utf8', 20, 20 + jl));
  assert.ok(json.extensionsUsed.includes('EXT_mesh_features') && json.extensionsUsed.includes('EXT_structural_metadata'));
  const fi = json.meshes[0].primitives[0].extensions.EXT_mesh_features.featureIds[0];
  assert.equal(fi.featureCount, geo.buildings.length); assert.equal(fi.propertyTable, 0);
  assert.equal(json.extensions.EXT_structural_metadata.propertyTables[0].count, geo.buildings.length);
  const ids = JSON.parse(fs.readFileSync(path.join(root, 'kita25/ids/b.json'), 'utf8'));
  assert.deepEqual(ids, geo.buildings.map((b) => b.id), 'featureId i → sidecar[i] = canonicalId');
  // bufferView が bin の範囲内
  const binLen = json.buffers[0].byteLength; for (const v of json.bufferViews) assert.ok(v.byteOffset + v.byteLength <= binLen);
});

test('click-mismatch classify: 重なり(高い/低い)・重複footprint・非重なりを区別し、canonicalId を変えない', () => {
  const sq = (x, z, s) => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];
  const bs = [
    { id: 'low', h: 4, z0: 0, fp: sq(0, 0, 10), repX: 5, repZ: 5 },
    { id: 'tall', h: 20, z0: 0, fp: sq(-5, -5, 30), repX: 8, repZ: 8 },
    { id: 'alone', h: 5, z0: 0, fp: sq(100, 100, 10), repX: 105, repZ: 105 },
    { id: 'neighbor', h: 20, z0: 0, fp: sq(112, 100, 8), repX: 116, repZ: 104 },
    { id: 'dupA', h: 5, z0: 0, fp: sq(300, 300, 10), repX: 305, repZ: 305 },
    { id: 'dupB', h: 5, z0: 0, fp: sq(300, 300, 10), repX: 305, repZ: 305 },
  ];
  const snap = JSON.stringify(bs);
  const r = Object.fromEntries(classify(bs, bs.map((b) => b.id)).map((x) => [x.id, x.class]));
  assert.equal(JSON.stringify(bs), snap);
  assert.equal(r.low, 'overlap-higher'); assert.equal(r.tall, 'overlap-lower');
  assert.equal(r.alone, 'none'); assert.equal(r.neighbor, 'none'); assert.equal(r.dupA, 'duplicate-fp');
  assert.equal(pip(5, 5, sq(0, 0, 10)), true); assert.equal(pip(50, 5, sq(0, 0, 10)), false);
  assert.equal(classify(bs, ['nope'])[0].class, 'unknown-id');
});

test('Mission137 レポート不変条件: 実データ 3 レイヤー検証は 0、click 不一致の分類は overlap でなく非重なり（canonicalId は未変更）', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'data/reports/mission137');
  const cm = JSON.parse(fs.readFileSync(path.join(root, 'click-mismatch.json'), 'utf8'));
  assert.equal(cm.buildings, 35031);
  assert.ok(cm.targets.every((t) => t.class === 'none' && t.ownContainsRep === true), '不一致 1/25 の 2 棟は重なり・重複ではない');
  if (fs.existsSync(path.join(root, 'synthetic-e2e-glb-sidecar.json'))) {
    const s = JSON.parse(fs.readFileSync(path.join(root, 'synthetic-e2e-glb-sidecar.json'), 'utf8'));
    assert.equal(s.dataKind, 'synthetic-fixture'); assert.equal(s.realData24WardsProven, false);
    assert.equal(s.click3dTiles.dataKind, 'synthetic-fixture');
  }
});
