// Mission 135: 合成 fixture（実データではない）。2区以上の「建物(3D Tiles/GLB)＋道路＋河川の線＋河川の面＋水面」を生成する。
// 実データの代用として表示・合格扱いしない。e2e レポートには dataKind:'synthetic-fixture' を必ず書く。
// 建物頂点は Live City 公式変換 liveCityWorldToLatLon() → WGS84 ECEF で置く（オフセット/回転/高さの場当たり値なし）。
import fs from 'node:fs';
import path from 'node:path';
import { liveCityWorldToLatLon } from '../lib/livecity-coordinate-system.js';

const A = 6378137, E2 = 0.00669437999014;
export function geodeticToEcef(latDeg, lonDeg, h) {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180, s = Math.sin(la), c = Math.cos(la);
  const N = A / Math.sqrt(1 - E2 * s * s);
  return [(N + h) * c * Math.cos(lo), (N + h) * c * Math.sin(lo), (N * (1 - E2) + h) * s];
}
export function enuBasis(latDeg, lonDeg) {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180;
  return {
    east: [-Math.sin(lo), Math.cos(lo), 0],
    north: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)],
    up: [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)],
  };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 区 bbox の中心を基準にした合成地物の局所座標 [x,z]（z は南が正）。建物 6 棟 + 道路 2 本 + 河川線 + 河川面 + 水面。 */
export function fixtureGeometry(bbox) {
  const cx = (bbox.minX + bbox.maxX) / 2, cz = (bbox.minZ + bbox.maxZ) / 2;
  const buildings = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
    buildings.push({ id: `fx-${Math.round(cx)}-${Math.round(cz)}-${i}${j}`, x: cx - 90 + i * 90, z: cz - 60 + j * 120, w: 36, d: 36, h: 25 + 12 * (i + j) });
  }
  const rect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
  return {
    buildings,
    roads: [
      { id: 'fx-road-ew', kind: 'line', tier: 'major', highway: 'primary', p: [[cx - 260, cz], [cx + 260, cz]] },
      { id: 'fx-road-ns', kind: 'line', tier: 'mid', highway: 'secondary', p: [[cx - 130, cz - 220], [cx - 130, cz + 220]] },
    ],
    waterLine: { id: 'fx-river-line', kind: 'line', waterClass: 'river', p: [[cx - 260, cz - 170], [cx, cz - 180], [cx + 260, cz - 170]] },
    waterArea: { id: 'fx-river-area', kind: 'area', waterClass: 'river', p: rect(cx + 140, cz + 90, cx + 240, cz + 190) },
    surfaceTris: [[[cx - 260, cz + 120], [cx - 160, cz + 120], [cx - 160, cz + 210]], [[cx - 260, cz + 120], [cx - 160, cz + 210], [cx - 260, cz + 210]]],
    center: { x: cx, z: cz },
  };
}

/** GLB を組み立てる。positions は glTF 座標（x=east, y=up, z=-north）。 */
function buildGlb(positions, normals, indices, color, featureIds) {
  // featureIds: 頂点ごとの建物 index（EXT_mesh_features の _FEATURE_ID_0 属性）。canonicalId は ids/<glb basename>.json sidecar[featureId]
  const posBuf = Buffer.from(new Float32Array(positions).buffer), nrmBuf = Buffer.from(new Float32Array(normals).buffer), idxBuf = Buffer.from(new Uint32Array(indices).buffer), fidBuf = Buffer.from(new Float32Array(featureIds).buffer);
  // property table（EXT_structural_metadata）: Cesium は property table を持つ featureId だけを「feature」として pick できる。値は連番 ord のみ（canonicalId は sidecar 側）
  const nFeat = Math.max(...featureIds) + 1, ordBuf = Buffer.from(new Uint32Array(Array.from({ length: nFeat }, (_, i) => i)).buffer);
  const bin = Buffer.concat([posBuf, nrmBuf, idxBuf, fidBuf, ordBuf]);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], positions[i + k]); mx[k] = Math.max(mx[k], positions[i + k]); }
  const json = {
    asset: { version: '2.0', generator: 'livecity mission135 synthetic fixture' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    extensionsUsed: ['EXT_mesh_features', 'EXT_structural_metadata'],
    extensions: { EXT_structural_metadata: { schema: { id: 'livecity-building', classes: { building: { properties: { ord: { type: 'SCALAR', componentType: 'UINT32' } } } } }, propertyTables: [{ class: 'building', count: nFeat, properties: { ord: { values: 4 } } }] } },
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, _FEATURE_ID_0: 3 }, indices: 2, material: 0, extensions: { EXT_mesh_features: { featureIds: [{ featureCount: nFeat, attribute: 0, propertyTable: 0 }] } } }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: mn, max: mx },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: indices.length, type: 'SCALAR' },
      { bufferView: 3, componentType: 5126, count: featureIds.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
      { buffer: 0, byteOffset: posBuf.length, byteLength: nrmBuf.length, target: 34962 },
      { buffer: 0, byteOffset: posBuf.length + nrmBuf.length, byteLength: idxBuf.length, target: 34963 },
      { buffer: 0, byteOffset: posBuf.length + nrmBuf.length + idxBuf.length, byteLength: fidBuf.length, target: 34962 },
      { buffer: 0, byteOffset: posBuf.length + nrmBuf.length + idxBuf.length + fidBuf.length, byteLength: ordBuf.length },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
  const pad = Buffer.alloc((4 - bin.length % 4) % 4);
  const binP = Buffer.concat([bin, pad]);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + binP.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.write('JSON', 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binP.length, 0); bh.write('BIN\0', 4);
  return Buffer.concat([head, jh, js, bh, binP]);
}

/** 1 区分の建物 tileset.json + b.glb + ids/t_0_0.json を <buildingsRoot>/<ward>25/ に書く。 */
export function writeBuildings(buildingsRoot, ward, geo) {
  const dir = path.join(buildingsRoot, `${ward.wardId}25`);
  fs.mkdirSync(path.join(dir, 'ids'), { recursive: true });
  const ll = liveCityWorldToLatLon(geo.center.x, geo.center.z), basis = enuBasis(ll.lat, ll.lon), origin = geodeticToEcef(ll.lat, ll.lon, 0);
  const toEnu = (lat, lon, h) => { const e = geodeticToEcef(lat, lon, h), d = [e[0] - origin[0], e[1] - origin[1], e[2] - origin[2]]; return [dot(basis.east, d), dot(basis.north, d), dot(basis.up, d)]; };
  const pos = [], nrm = [], idx = [], fids = [];
  let maxUp = 0, minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity, cur = 0;
  const addQuad = (a, b, c, d, n) => { const o = pos.length / 3; for (const v of [a, b, c, d]) { pos.push(v[0], v[2], -v[1]); nrm.push(n[0], n[2], -n[1]); fids.push(cur); } idx.push(o, o + 1, o + 2, o, o + 2, o + 3); };
  for (const [bi, b] of geo.buildings.entries()) {
    cur = bi;
    const xs = [b.x - b.w / 2, b.x + b.w / 2], zs = [b.z - b.d / 2, b.z + b.d / 2];
    const at = (xi, zi, h) => { const g = liveCityWorldToLatLon(xs[xi], zs[zi]); return toEnu(g.lat, g.lon, h); };
    const lo = [at(0, 0, 0), at(1, 0, 0), at(1, 1, 0), at(0, 1, 0)], hi = [at(0, 0, b.h), at(1, 0, b.h), at(1, 1, b.h), at(0, 1, b.h)];
    for (const v of [...lo, ...hi]) { minE = Math.min(minE, v[0]); maxE = Math.max(maxE, v[0]); minN = Math.min(minN, v[1]); maxN = Math.max(maxN, v[1]); maxUp = Math.max(maxUp, v[2]); }
    addQuad(hi[0], hi[1], hi[2], hi[3], [0, 0, 1]);
    for (let k = 0; k < 4; k++) { const k2 = (k + 1) % 4, n = [lo[k2][1] - lo[k][1], -(lo[k2][0] - lo[k][0]), 0], l = Math.hypot(n[0], n[1]) || 1; addQuad(lo[k], lo[k2], hi[k2], hi[k], [n[0] / l, n[1] / l, 0]); }
  }
  fs.writeFileSync(path.join(dir, 'b.glb'), buildGlb(pos, nrm, idx, [0.82, 0.86, 0.92, 1], fids));
  const T = [...basis.east, 0, ...basis.north, 0, ...basis.up, 0, ...origin, 1];
  const cE = (minE + maxE) / 2, cN = (minN + maxN) / 2, hz = maxUp / 2;
  fs.writeFileSync(path.join(dir, 'tileset.json'), JSON.stringify({
    asset: { version: '1.1' }, geometricError: 500,
    root: { transform: T, boundingVolume: { box: [cE, cN, hz, (maxE - minE) / 2 + 1, 0, 0, 0, (maxN - minN) / 2 + 1, 0, 0, 0, hz + 1] }, geometricError: 0, refine: 'ADD', content: { uri: 'b.glb' } },
  }));
  fs.writeFileSync(path.join(dir, 'ids', 'b.json'), JSON.stringify(geo.buildings.map((b) => b.id)));
  fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ synthetic: true, note: '合成fixture（実PLATEAUではない）' }));
}

/** 道路・河川線/面・水面を <layersRoot>/<ward>/layers/ に書く（build-ward-layers.js の出力と同一形式）。 */
export function writeLayers(layersRoot, ward, geo, { skip = [] } = {}) {
  const dir = path.join(layersRoot, ward.wardId, 'layers');
  fs.mkdirSync(dir, { recursive: true });
  const head = { version: 1, coordinateConvention: 'znorth-neg-v1', wardId: ward.wardId, synthetic: true, source: 'mission135-synthetic-fixture', clipped: 'none' };
  if (!skip.includes('roads')) fs.writeFileSync(path.join(dir, 'roads.json'), JSON.stringify({ ...head, layer: 'roads', features: geo.roads }));
  if (!skip.includes('waterways')) fs.writeFileSync(path.join(dir, 'waterways.json'), JSON.stringify({ ...head, layer: 'waterways', features: [geo.waterLine, geo.waterArea] }));
  if (!skip.includes('water-surface')) fs.writeFileSync(path.join(dir, 'water-surface.json'), JSON.stringify({ ...head, layer: 'water-surface', features: geo.surfaceTris.map((p, i) => ({ id: `fx-ws-${i}`, kind: 'area', waterClass: 'sea-surface', p })) }));
}

export function writeFixture({ buildingsRoot, layersRoot, wards, skipLayers = {} }) {
  const out = {};
  for (const w of wards) {
    const geo = fixtureGeometry(w.bbox);
    writeBuildings(buildingsRoot, w, geo);
    writeLayers(layersRoot, w, geo, { skip: skipLayers[w.wardId] || [] });
    out[w.wardId] = geo;
  }
  return out;
}
