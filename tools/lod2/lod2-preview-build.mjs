#!/usr/bin/env node
// Mission 161: 公式PLATEAU大阪2025 CityGML(v5) から Range 取得 → LOD2 実建物を再生成する一発コマンド。
//   node tools/lod2/lod2-preview-build.mjs [--meshes 51357371,51357381,51357382] [--out temp/lod2-preview] [--gml-dir DIR(ネットワーク不使用)]
// 生成物は temp/ (gitignore) のみ。public/ への出力は拒否。tileset.json / lod2.glb / footprints.json / report.json / manifest.json を出す。
// manifest.json は将来の private 保管用(区/メッシュ/ID/LOD種別/sha256/ETag)。PR#51 の LOD1 manifest は書き換えない。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LOCK_PATH } from '../mission79-plateau2025-source.mjs';
import { fetchEntry } from './lod2-audit.mjs';
import { splitBuildings } from '../lib/citygml.js';
import { buildLod2Index, planBuildingSources, assertDisjoint } from './lod2-selector.js';
import { buildLod2Mesh, meshToGlb, buildTileset, geodeticToEcef } from './lod2-to-glb.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const a = process.argv.slice(2), g = (k, d = null) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : d);
const out = path.resolve(g('--out', 'temp/lod2-preview'));
if (/[\\/]public[\\/]/.test(out)) throw new Error('refusing to write under public/');
fs.mkdirSync(out, { recursive: true });
const meshes = g('--meshes', '51357371,51357381,51357382').split(',');
const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
const gmlDir = g('--gml-dir');

const sources = [];
for (const m of meshes) {
  let xml;
  if (gmlDir) xml = fs.readFileSync(path.join(gmlDir, `${m}_bldg_6697_op.gml`), 'utf8');
  else {
    const e = lock.entries.find((x) => x.kind === 'bldg' && x.mesh === m);
    if (!e) throw new Error('mesh not in source-lock: ' + m);
    xml = await fetchEntry(lock.resource.url, e);
  }
  sources.push({ mesh: m, xml, sha256: sha(Buffer.from(xml)), bytes: Buffer.byteLength(xml) });
}
const lod1Ids = [], xmlById = new Map(), idMesh = new Map();
for (const s of sources) for (const b of splitBuildings(s.xml)) {
  const id = (b.match(/gml:id="([^"]+)"/) || [])[1]; if (!id) continue;
  if (xmlById.has(id)) throw new Error('duplicate canonical id across meshes: ' + id);
  lod1Ids.push(id); xmlById.set(id, b); idMesh.set(id, s.mesh);
}
const { index } = buildLod2Index(sources.map((s) => s.xml));
const plan = planBuildingSources(lod1Ids, index);
assertDisjoint(plan);
const sel = new Map([...plan.lod2Draw].map((id) => [id, xmlById.get(id)]));
const m0 = [...sel.values()][0]?.match(/<gml:posList[^>]*>\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/);
if (!m0) throw new Error('no LOD2 building found in the selected meshes');
const org = { lat: +m0[1], lon: +m0[2], h: 0 };
const mesh = buildLod2Mesh(sel, org, { groundToZero: true });
const glb = meshToGlb(mesh), tileset = buildTileset(mesh, org);
// 座標検証: tileset transform の平行移動 = 原点の ECEF
const t = tileset.root.transform, o = geodeticToEcef(org.lat, org.lon, org.h);
const transformOk = Math.hypot(t[12] - o[0], t[13] - o[1], t[14] - o[2]) < 1e-3;
if (!transformOk) throw new Error('tileset transform does not match origin ECEF');
const lons = mesh.footprints.flatMap((f) => f.hull.map((p) => p[0])), lats = mesh.footprints.flatMap((f) => f.hull.map((p) => p[1]));
const bbox = { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) };
const gh = mesh.ok.map((o2) => o2.groundH);
const report = {
  mission: '161-lod2-preview', generatedAt: new Date().toISOString(), mode: gmlDir ? 'local-gml' : 'official-range',
  meshes, lod1Total: lod1Ids.length, lod2Candidates: index.size, lod2Planned: plan.lod2Draw.size,
  converted: mesh.ok.length, failed: mesh.failed, lod1Remaining: lod1Ids.length - mesh.ok.length,
  fallbackReasons: Object.fromEntries([...plan.fallbacks]), triangles: mesh.ok.reduce((n, o2) => n + o2.triangles, 0), glbBytes: glb.length,
  withTexture: plan.stats.withTexture, textureRendered: false, color: 'vertex-color-only (roof/wall/ground)',
  vertical: 'per-building ground (min source height) placed at ellipsoid h=0; horizontal coordinates untouched',
  groundHRange: [Math.min(...gh), Math.max(...gh)],
  origin: org, extentEnu: mesh.extentEnu, bbox, transformTranslationMatchesOrigin: transformOk,
  source: { package: lock.package?.name, license: lock.license?.title, attribution: lock.attribution, etag: lock.http?.etag },
};
// 変換失敗建物は footprints に入れない(= LOD1 がクリップされず残る)。
fs.writeFileSync(path.join(out, 'lod2.glb'), glb);
fs.writeFileSync(path.join(out, 'tileset.json'), JSON.stringify(tileset));
fs.writeFileSync(path.join(out, 'footprints.json'), JSON.stringify({ ids: mesh.ok.map((o2) => o2.id), footprints: mesh.footprints }));
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
  schema: 'livecity-lod2-asset-manifest/1', source: report.source,
  assets: [{ lod: 'lod2', meshes, ids: mesh.ok.map((o2) => ({ id: o2.id, mesh: idMesh.get(o2.id) })), glb: { path: 'lod2.glb', bytes: glb.length, sha256: sha(glb) },
    tileset: { path: 'tileset.json', sha256: sha(Buffer.from(JSON.stringify(tileset))) } }],
  sourceGml: sources.map((s) => ({ mesh: s.mesh, bytes: s.bytes, sha256: s.sha256 })),
}, null, 1));
console.log(JSON.stringify({ out, converted: report.converted, failed: report.failed.length, lod1Remaining: report.lod1Remaining, glbBytes: glb.length, bbox }));
