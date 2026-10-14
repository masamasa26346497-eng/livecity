#!/usr/bin/env node
// Mission 38E: 37H ward-sample builder の 38E 専用コピー（出力先を public/mission38e-3dtiles/<ward>-mesh/ に固定）。
// 37H の本体ファイルは変更しない。ロジックは同一（N03 点内判定 → 500m tile → 37B build()）。
//
//   node tools/mission36k-fetch-citygml-ward-range.mjs --ward naniwa --meshes=51357399 --out temp/h38/gml
//   node tools/mission36k-convert-citygml-runtime.mjs --input temp/h38/gml --output temp/h38/naniwa.jsonl --ward-hint naniwa
//   node tools/mission38e-build-ward-mesh.cjs --ward naniwa --jsonl temp/h38/naniwa.jsonl --gml-sha256 <hex> --mesh 51357399
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { build } = require('./mission37b-build-3dtiles.cjs');

const ROOT = path.join(__dirname, '..');
const TILE = 500;
const ZIP_URL = 'https://assets.cms.plateau.reearth.io/assets/40/a85f8e-049c-4b3f-a97b-4a217df787df/27100_osaka-shi_city_2024_citygml_1_op.zip';

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function inWard(x, z, ward) {
  const bb = ward.bbox;
  if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) return false;
  return ward.polygons.some((p) => pointInRing(x, z, p.outer) && !(p.holes || []).some((h) => pointInRing(x, z, h)));
}
function centroid(fp) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
    const f = fp[j][0] * fp[i][1] - fp[i][0] * fp[j][1];
    a += f; cx += (fp[j][0] + fp[i][0]) * f; cz += (fp[j][1] + fp[i][1]) * f;
  }
  if (Math.abs(a) < 1e-6) return [fp.reduce((s, p) => s + p[0], 0) / fp.length, fp.reduce((s, p) => s + p[1], 0) / fp.length];
  return [cx / (3 * a), cz / (3 * a)];
}
const r1 = (v) => Math.round(v * 10) / 10;

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
  const wardId = opt('ward'), jsonl = opt('jsonl');
  if (!wardId || !jsonl) throw new Error('usage: --ward <id> --jsonl <file> [--gml-sha256 <hex>] [--mesh <code>]');
  const polys = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/processed/osaka-city/boundaries/ward-classification-polygons.json'), 'utf8'));
  if (polys.coordinateConvention !== 'znorth-neg-v1') throw new Error('coordinateConvention');
  const ward = polys.wards.find((w) => w.wardId === wardId);
  if (!ward) throw new Error('unknown ward ' + wardId);

  const tiles = new Map();
  const stat = { read: 0, inWard: 0, outsideWard: 0, duplicate: 0, existingDuplicate: 0, meshes: new Set() };
  const seen = new Set();
  // --exclude-set <name>: 既存セット（public/mission38e-3dtiles/<name>/ids）に既にあるIDは除外（重複防止）
  const existing = new Set();
  const exName = opt('exclude-set');
  if (exName) {
    const d = path.join(ROOT, 'public', 'mission38e-3dtiles', exName, 'ids');
    for (const f of fs.readdirSync(d)) for (const id of JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) existing.add(id);
  }
  for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
    if (!line) continue;
    const b = JSON.parse(line);
    stat.read++;
    if (seen.has(b.id)) { stat.duplicate++; continue; }
    seen.add(b.id);
    if (existing.has(b.id)) { stat.existingDuplicate++; continue; }
    const [rx, rz] = centroid(b.fp);
    if (!inWard(rx, rz, ward)) { stat.outsideWard++; continue; }
    stat.inWard++;
    stat.meshes.add(b.sourceMesh);
    const key = Math.floor(rx / TILE) + '_' + Math.floor(rz / TILE);
    if (!tiles.has(key)) tiles.set(key, { tx: Math.floor(rx / TILE), tz: Math.floor(rz / TILE), buildings: [] });
    tiles.get(key).buildings.push({ id: b.id, fp: b.fp, z0: b.z0 || 0, dz: b.dz, h: b.h, usage: b.usage, ulabel: b.ulabel || '', repX: r1(rx), repZ: r1(rz) });
  }

  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'h38-src-'));
  const manifestTiles = [];
  for (const t of [...tiles.values()].sort((a, b) => a.tx - b.tx || a.tz - b.tz)) {
    const file = `tile_${t.tx}_${t.tz}.json`;
    fs.writeFileSync(path.join(src, file), JSON.stringify({ tx: t.tx, tz: t.tz, tileSize: TILE, lod: 1, count: t.buildings.length, buildings: t.buildings }));
    manifestTiles.push({ tx: t.tx, tz: t.tz, file, count: t.buildings.length });
  }
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ coordinateConvention: 'znorth-neg-v1', tiles: manifestTiles }));

  const out = path.join(ROOT, 'public', 'mission38e-3dtiles', opt('name') || (wardId + '-mesh'));
  const report = build({ dataset: 'osaka-' + wardId, srcDir: src, out, all: true, group: 4, coarseError: 40, coarseMinArea: 100 });

  fs.mkdirSync(path.join(out, 'attrs'), { recursive: true });
  let attrBytes = 0;
  for (const t of tiles.values()) {
    const byId = {};
    for (const b of t.buildings) byId[b.id] = [b.h, b.usage || null, b.repX, b.repZ, b.z0];
    const s = JSON.stringify({ tx: t.tx, tz: t.tz, count: t.buildings.length, fields: ['h', 'usage', 'repX', 'repZ', 'z0'], byId });
    attrBytes += s.length;
    fs.writeFileSync(path.join(out, 'attrs', `t_${t.tx}_${t.tz}.json`), s);
  }
  const meshes = [...stat.meshes].sort();
  fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify({
    mission: '38E', ward: ward.wardName, wardId, wardCode: ward.wardCode, generatedAt: new Date().toISOString(),
    source: 'PLATEAU 3D都市モデル 大阪市 2024（国土交通省）CityGML bldg LOD1 / 27100_osaka-shi_city_2024_citygml_1_op',
    sourceZipUrl: ZIP_URL, requestedMesh: opt('mesh'), gmlSha256: opt('gml-sha256'),
    fetchMethod: 'HTTP Range（mission36k-fetch-citygml-ward-range.mjs）。ZIP 全量は取得していない',
    sourceMeshes: meshes, canonicalId: 'CityGML gml:id (bldg_<uuid>) をそのまま使用。新規採番なし',
    wardClassification: 'N03 区ポリゴンの点内判定（代表点=footprint 重心）。ポリゴン外は除外。wardHint は区判定に使っていない',
    counts: { read: stat.read, inWard: stat.inWard, outsideWard: stat.outsideWard, duplicate: stat.duplicate, existingDuplicate: stat.existingDuplicate }, excludedSet: exName || null,
    note: 'メッシュ単位の限定取得。区全体ではない。',
    licenseNote: '出典: 国土交通省 Project PLATEAU。利用条件の最終確認はリポジトリ内に記録なし（公開前に要確認）。',
  }, null, 1));
  const total = fs.readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .reduce((n, e) => n + fs.statSync(path.join(e.parentPath || e.path, e.name)).size, 0);
  console.log(JSON.stringify({ ward: wardId, ...stat, meshes, tiles: tiles.size, buildings: report.totals.buildings, uniqueIds: report.totals.uniqueCanonicalIds,
    skipped: report.totals.skipped, glbBytes: report.totals.glbBytes, attrBytes, totalBytes: total, out: path.relative(ROOT, out) }, (k, v) => (v instanceof Set ? [...v] : v), 1));
  fs.rmSync(src, { recursive: true, force: true });
}
main();
