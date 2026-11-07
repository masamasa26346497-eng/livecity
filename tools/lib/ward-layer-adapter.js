// tools/lib/ward-layer-adapter.js
// Mission 135: Mission115 の都市レイヤー出力（{layer}/tile_{tx}_{tz}.json, water-surface.json）を、
// Cesium 24区ビューアが読む「区別ファイル」 <out>/<wardId>/layers/{roads,waterways,water-surface}.json へ変換する読み取り専用アダプター。
//
// 方針:
//  - 座標は一切変換しない。入力は znorth-neg-v1 の局所 [x,z]（m）で、出力も同じ。経緯度化は表示側が
//    liveCityProjection()（config/areas/osaka-city.json）と同一の定数でのみ行う。オフセット/回転/高さの補正値は持たない。
//  - 入力が無い/規約が違う/壊れている場合は、そのレイヤーを「未取得」等の状態で記録するだけで、地物を捏造しない。
//  - ネットワークアクセスはしない。出力は一時ファイル→rename で原子的に書く。
import fs from 'node:fs';
import path from 'node:path';

export const CONVENTION = 'znorth-neg-v1';
export const CITY_TILE_SIZE = 2000;
export const WARD_LAYER_FILES = ['roads', 'waterways', 'water-surface'];
export const STATES = Object.freeze({ NOT_ACQUIRED: 'not-acquired', GENERATED: 'generated', REJECTED: 'rejected' });
const WARD_ID = /^[a-z0-9-]+$/;

function readJson(file) {
  if (!fs.existsSync(file)) return { ok: false, code: 'missing-file' };
  try { return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return { ok: false, code: 'invalid-json', detail: e.message }; }
}

export function bboxOverlaps(a, b) { return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ; }
export function pointsBbox(pts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; }
  return { minX, maxX, minZ, maxZ };
}
function validPoints(p, min) {
  return Array.isArray(p) && p.length >= min && p.every((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]));
}
export function expandBbox(b, m) { return { minX: b.minX - m, maxX: b.maxX + m, minZ: b.minZ - m, maxZ: b.maxZ + m }; }

/** 区 bbox を覆う 2000m タイル一覧（ward-tile-coverage.js と同じ floor 規約）。 */
export function tilesFor(bbox, bufferM = 150, size = CITY_TILE_SIZE) {
  const out = [];
  for (let tx = Math.floor((bbox.minX - bufferM) / size); tx <= Math.floor((bbox.maxX + bufferM) / size); tx++) {
    for (let tz = Math.floor((bbox.minZ - bufferM) / size); tz <= Math.floor((bbox.maxZ + bufferM) / size); tz++) out.push({ tx, tz });
  }
  return out;
}

/** {layer}/tile_*.json を読み、区 bbox+buffer と重なる地物だけを id で重複排除して返す。 */
export function collectCityLayer(mapRoot, layer, bbox, { bufferM = 150, tileSize = CITY_TILE_SIZE } = {}) {
  const dir = path.join(mapRoot, layer);
  const manifest = readJson(path.join(dir, 'manifest.json'));
  if (!manifest.ok && !fs.existsSync(dir)) return { state: STATES.NOT_ACQUIRED, reason: 'layer-directory-missing', features: [] };
  if (manifest.ok && manifest.data.coordinateConvention && manifest.data.coordinateConvention !== CONVENTION) {
    return { state: STATES.REJECTED, reason: `convention-mismatch:${manifest.data.coordinateConvention}`, features: [] };
  }
  const window = expandBbox(bbox, bufferM), seen = new Set(), features = [], missingTiles = [];
  let tilesRead = 0;
  for (const { tx, tz } of tilesFor(bbox, bufferM, tileSize)) {
    const t = readJson(path.join(dir, `tile_${tx}_${tz}.json`));
    if (!t.ok) { missingTiles.push(`tile_${tx}_${tz}.json`); continue; }
    tilesRead++;
    for (const f of t.data.features || []) {
      if (!f || f.kind === 'station' || !validPoints(f.p, f.kind === 'area' ? 3 : 2)) continue;
      if (f.id != null) { if (seen.has(f.id)) continue; seen.add(f.id); }
      if (bboxOverlaps(pointsBbox(f.p), window)) features.push(f);
    }
  }
  if (!tilesRead) return { state: STATES.NOT_ACQUIRED, reason: 'no-tiles-for-ward', missingTiles, features: [] };
  return { state: STATES.GENERATED, reason: missingTiles.length ? 'partial-tiles' : 'ok', tilesRead, missingTiles, features };
}

/** water-surface.json（三角形頂点の平坦配列 positions=[x,z,...]）→ 区 bbox 内の三角形を area 地物へ。 */
export function collectWaterSurface(mapRoot, bbox, { bufferM = 150 } = {}) {
  const r = readJson(path.join(mapRoot, 'water-surface', 'water-surface.json'));
  if (!r.ok) return { state: STATES.NOT_ACQUIRED, reason: r.code, features: [] };
  const d = r.data;
  if (d.coordinateConvention !== CONVENTION) return { state: STATES.REJECTED, reason: `convention-mismatch:${d.coordinateConvention}`, features: [] };
  if (!Array.isArray(d.positions) || d.positions.length % 6 !== 0) return { state: STATES.REJECTED, reason: 'bad-positions', features: [] };
  const window = expandBbox(bbox, bufferM), features = [], pos = d.positions;
  for (let i = 0; i < pos.length; i += 6) {
    const tri = [[pos[i], pos[i + 1]], [pos[i + 2], pos[i + 3]], [pos[i + 4], pos[i + 5]]];
    if (!validPoints(tri, 3)) return { state: STATES.REJECTED, reason: 'non-finite-vertex', features: [] };
    if (bboxOverlaps(pointsBbox(tri), window)) features.push({ id: `ws_${i / 6}`, kind: 'area', waterClass: 'sea-surface', p: tri });
  }
  if (!d.emitted || !pos.length) return { state: STATES.NOT_ACQUIRED, reason: 'surface-not-emitted', features: [] };
  return { state: STATES.GENERATED, reason: features.length ? 'ok' : 'no-triangles-in-ward', features };
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

/**
 * 1区分を生成。入力が無いレイヤーはファイルを作らない（ビューアは HTTP 404 → 「未取得」を表示する）。
 * @returns {{wardId, layers:{roads,waterways,waterSurface}, outDir}}
 */
export function buildWardLayers({ mapRoot, outRoot, ward, bufferM = 150 }) {
  if (!WARD_ID.test(ward.wardId)) throw new Error(`invalid wardId: ${ward.wardId}`);
  const outDir = path.join(outRoot, ward.wardId, 'layers');
  const header = { version: 1, coordinateConvention: CONVENTION, wardId: ward.wardId, source: 'mission115-city-layer-tiles', clipped: 'none', bufferM };
  const result = {};
  const roads = collectCityLayer(mapRoot, 'roads', ward.bbox, { bufferM });
  const water = collectCityLayer(mapRoot, 'waterways', ward.bbox, { bufferM });
  const surf = collectWaterSurface(mapRoot, ward.bbox, { bufferM });
  for (const [key, file, res] of [['roads', 'roads.json', roads], ['waterways', 'waterways.json', water], ['waterSurface', 'water-surface.json', surf]]) {
    const target = path.join(outDir, file);
    if (res.state === STATES.GENERATED && res.features.length) {
      writeAtomic(target, { ...header, layer: key, count: res.features.length, features: res.features });
      result[key] = { state: STATES.GENERATED, count: res.features.length, reason: res.reason };
    } else {
      // 古い出力が残っていると「生成済」に見えるため、入力が無い/空の場合は取り除く（自分が生成した区別ファイルのみ）。
      try { fs.rmSync(target, { force: true }); } catch { /* noop */ }
      result[key] = { state: res.state === STATES.GENERATED ? STATES.NOT_ACQUIRED : res.state, count: 0, reason: res.state === STATES.GENERATED ? 'no-features-in-ward' : res.reason };
    }
  }
  writeAtomic(path.join(outDir, 'status.json'), { ...header, layers: result, note: 'rivers-v2 は出力規約が未解析のため今回は変換対象外' });
  return { wardId: ward.wardId, layers: result, outDir };
}

/** ward-classification-polygons.json 形式（wards[].{wardId,bbox}）から区一覧を得る。 */
export function loadWards(polygonsFile) {
  const r = readJson(polygonsFile);
  if (!r.ok) throw new Error(`ward polygons: ${r.code}`);
  return (r.data.wards || []).map((w) => ({ wardId: w.wardId, wardCode: w.wardCode, wardName: w.wardName, bbox: w.bbox }));
}
