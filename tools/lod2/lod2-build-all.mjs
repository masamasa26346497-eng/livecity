#!/usr/bin/env node
// Mission 163: 大阪PLATEAU 2025 の LOD2 収録メッシュ(33)を公式 Range 取得し、全 LOD2 建物を分割 3D Tiles(GLB)へ変換する。
//   node tools/lod2/lod2-build-all.mjs [--out temp/lod2-all] [--meshes a,b,..] [--resume] [--max-bldg 300] [--cell 0.004] [--gml-dir DIR]
// - 対象メッシュは data/reports/mission159/lod2-coverage-osaka2025.json の lod2Any>0 (--meshes で上書き可)。270メッシュ全再取得はしない。
// - 期待ID集合 = 取得した GML 自身を auditGml で数えた LOD2 ID。出力ID集合と set で完全一致照合(欠落/重複/余剰を記録)。
// - 変換失敗は隠さず failed に記録(その建物は LOD1 のまま)。LOD1 を LOD2 として数えない。架空形状は作らない。
// - 生成物は temp/ のみ(public/ 拒否)。--resume は mesh-reports/<mesh>.json があるメッシュをスキップ(冪等)。
// - 小さな監査レポートだけ data/reports/mission163/ に書く(GLB/GML は書かない)。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LOCK_PATH } from '../mission79-plateau2025-source.mjs';
import { fetchEntry, auditGml } from './lod2-audit.mjs';
import { splitBuildings } from '../lib/citygml.js';
import { buildLod2Index, planBuildingSources, assertDisjoint } from './lod2-selector.js';
import { buildLod2Mesh, extractLod2Surfaces, meshToGlb, enuToEcefMatrix, geodeticToEcef } from './lod2-to-glb.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const a = process.argv.slice(2), g = (k, d = null) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : d);
const out = path.resolve(ROOT, g('--out', 'temp/lod2-all'));
if (/[\\/]public([\\/]|$)/.test(out)) throw new Error('refusing to write under public/');
const maxBldg = Number(g('--max-bldg', 300)), cell = Number(g('--cell', 0.004));
const resume = a.includes('--resume'), gmlDir = g('--gml-dir');
const repDir = path.resolve(ROOT, g('--report-dir', 'data/reports/mission163'));
for (const d of [out, path.join(out, 'tiles'), path.join(out, 'mesh-reports'), repDir]) fs.mkdirSync(d, { recursive: true });
const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
const cov = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/mission159/lod2-coverage-osaka2025.json'), 'utf8'));
const meshes = g('--meshes') ? g('--meshes').split(',') : cov.perMesh.filter((r) => r.lod2Any > 0).map((r) => r.mesh);
const expected159 = new Map(cov.perMesh.map((r) => [r.mesh, r.lod2Any]));

const t0 = Date.now(); let netBytes = 0, peakRss = 0;
const rss = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
const firstPt = (xml) => { const m = xml.match(/<gml:posList[^>]*>\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/); return m ? [+m[1], +m[2]] : null; };

for (const mesh of meshes) {
  const mrp = path.join(out, 'mesh-reports', mesh + '.json');
  if (resume && fs.existsSync(mrp)) { console.log(mesh, 'resume: skip'); continue; }
  const e = lock.entries.find((x) => x.kind === 'bldg' && x.mesh === mesh);
  if (!e && !gmlDir) { console.log(mesh, 'NOT IN LOCK'); continue; }
  let xml;
  try {
    if (gmlDir) xml = fs.readFileSync(path.join(gmlDir, `${mesh}_bldg_6697_op.gml`), 'utf8');
    else { xml = await fetchEntry(lock.resource.url, e); netBytes += e.compressedBytes; }
  } catch (err) { fs.writeFileSync(mrp, JSON.stringify({ mesh, fetchError: String(err.message || err) })); console.log(mesh, 'FETCH ERROR', err.message); continue; }
  const au = auditGml(xml, mesh);
  const expectedIds = new Set(au.lod2Ids);
  const blds = splitBuildings(xml), xmlById = new Map(), lod1Ids = [];
  for (const b of blds) { const id = (b.match(/gml:id="([^"]+)"/) || [])[1]; if (!id) continue; if (xmlById.has(id)) continue; xmlById.set(id, b); lod1Ids.push(id); }
  const { index } = buildLod2Index([xml]);
  const plan = planBuildingSources(lod1Ids, index); assertDisjoint(plan);
  // 計画外(selector が LOD2 と認めなかった期待ID)も記録する
  const planned = [...plan.lod2Draw];
  const notPlanned = [...expectedIds].filter((id) => !plan.lod2Draw.has(id));
  // 地理グリッドで分割
  const groups = new Map();
  for (const id of planned) {
    const p = firstPt(xmlById.get(id)); const k = p ? `${Math.floor(p[0] / cell)}_${Math.floor(p[1] / cell)}` : 'nopt';
    if (!groups.has(k)) groups.set(k, []); groups.get(k).push(id);
  }
  const tiles = [], converted = [], failed = [], noRoofWall = [];
  let seq = 0;
  for (const [k, ids] of [...groups].sort()) for (let i = 0; i < ids.length; i += maxBldg) {
    const chunk = ids.slice(i, i + maxBldg), sel = new Map(chunk.map((id) => [id, xmlById.get(id)]));
    const p0 = firstPt(sel.values().next().value); if (!p0) { failed.push(...chunk); continue; }
    const org = { lat: p0[0], lon: p0[1], h: 0 };
    const m = buildLod2Mesh(sel, org, { groundToZero: true });
    for (const id of chunk) { const t = new Set(extractLod2Surfaces(sel.get(id)).map((s) => s.type)); if (!(t.has('roof') && t.has('wall'))) noRoofWall.push(id); }
    failed.push(...m.failed);
    if (!m.ok.length) continue;
    const glb = meshToGlb(m), name = `${mesh}_${String(seq++).padStart(3, '0')}.glb`;
    fs.writeFileSync(path.join(out, 'tiles', name), glb);
    const ex = m.extentEnu, lons = m.footprints.flatMap((f) => f.hull.map((q) => q[0])), lats = m.footprints.flatMap((f) => f.hull.map((q) => q[1]));
    tiles.push({
      name, cell: k, org, bytes: glb.length, sha256: sha(glb), triangles: m.ok.reduce((n, o) => n + o.triangles, 0), ids: m.ok.map((o) => o.id),
      box: [(ex.x[0] + ex.x[1]) / 2, (ex.y[0] + ex.y[1]) / 2, (ex.z[0] + ex.z[1]) / 2, (ex.x[1] - ex.x[0]) / 2 + 1, 0, 0, 0, (ex.y[1] - ex.y[0]) / 2 + 1, 0, 0, 0, (ex.z[1] - ex.z[0]) / 2 + 1],
      bbox: { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) },
      zRange: ex.z, groundH: m.ok.map((o) => o.groundH), footprints: m.footprints,
    });
    converted.push(...m.ok.map((o) => o.id));
    rss();
  }
  const convSet = new Set(converted), failSet = new Set(failed);
  const missing = [...expectedIds].filter((id) => !convSet.has(id));
  const extra = converted.filter((id) => !expectedIds.has(id));
  const rep = {
    mesh, buildings: au.buildings, expected: expectedIds.size, expected159: expected159.get(mesh) ?? null, planned: planned.length,
    converted: convSet.size, dupConverted: converted.length - convSet.size, failed: [...failSet], notPlannedByIndex: notPlanned, missing, extra,
    lod1Fallback: au.buildings - convSet.size, tiles: tiles.length, triangles: tiles.reduce((n, t) => n + t.triangles, 0), glbBytes: tiles.reduce((n, t) => n + t.bytes, 0),
    roofWallInvalid: noRoofWall, roofSurface: au.roofSurface, wallSurface: au.wallSurface, texturedLod2: au.texturedLod2, x3dMaterialLod2: au.x3dMaterialLod2,
    gmlBytes: Buffer.byteLength(xml), gmlSha256: sha(Buffer.from(xml)),
    groundHRange: tiles.length ? [Math.min(...tiles.flatMap((t) => t.groundH)), Math.max(...tiles.flatMap((t) => t.groundH))] : null,
    tileList: tiles.map(({ footprints, groundH, ids, ...t }) => t), tilesFull: tiles,
  };
  fs.writeFileSync(mrp, JSON.stringify(rep));
  rss();
  console.log(mesh, `expected=${rep.expected} converted=${rep.converted} failed=${rep.failed.length} missing=${missing.length} tiles=${rep.tiles} glb=${rep.glbBytes}`);
}

// ---- 集約 ----
const reps = meshes.map((m) => { const p = path.join(out, 'mesh-reports', m + '.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { mesh: m, fetchError: 'no report' }; });
const ok = reps.filter((r) => !r.fetchError), bad = reps.filter((r) => r.fetchError);
const allTiles = ok.flatMap((r) => r.tilesFull.map((t) => ({ mesh: r.mesh, ...t })));
const idSeen = new Map(); let dupAcross = 0;
for (const t of allTiles) for (const id of t.ids) { if (idSeen.has(id)) dupAcross++; idSeen.set(id, t.name); }
const sum = (k) => ok.reduce((n, r) => n + r[k], 0);
const lens = (k) => ok.reduce((n, r) => n + r[k].length, 0);
const expectedTotal = sum('expected');
const lons = allTiles.flatMap((t) => [t.bbox.west, t.bbox.east]), lats = allTiles.flatMap((t) => [t.bbox.south, t.bbox.north]);
const bbox = allTiles.length ? { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) } : null;
const source = { package: lock.package?.name, license: lock.license?.title, attribution: lock.attribution, etag: lock.http?.etag };
const totals = {
  meshesRequested: meshes.length, meshesProcessed: ok.length, meshesFailed: bad.map((r) => ({ mesh: r.mesh, error: r.fetchError })),
  expected: expectedTotal, expected159Total: ok.reduce((n, r) => n + (r.expected159 ?? 0), 0), converted: sum('converted'), failedIds: lens('failed'),
  missing: lens('missing'), extra: lens('extra'), notPlannedByIndex: lens('notPlannedByIndex'), dupWithinMesh: sum('dupConverted'), dupAcrossMeshes: dupAcross,
  unconverted: expectedTotal - sum('converted'), tiles: allTiles.length, triangles: sum('triangles'), glbBytes: sum('glbBytes'),
  roofWallInvalid: lens('roofWallInvalid'), lod1Fallback: sum('lod1Fallback'), buildingsInProcessedMeshes: sum('buildings'),
  texturedLod2: sum('texturedLod2'), x3dMaterialLod2: sum('x3dMaterialLod2'),
};
totals.fullMatch = totals.expected > 0 && totals.missing === 0 && totals.extra === 0 && totals.dupWithinMesh === 0 && totals.dupAcrossMeshes === 0 && totals.failedIds === 0 && bad.length === 0;
const allH = ok.flatMap((r) => r.groundHRange || []);
const report = {
  mission: '163-lod2-all', generatedAt: new Date().toISOString(), mode: gmlDir ? 'local-gml' : 'official-range', meshes: ok.map((r) => r.mesh), ...totals,
  failed: ok.flatMap((r) => r.failed), lod1Remaining: totals.lod1Fallback, bbox, source, textureRendered: false, color: 'vertex-color-only (roof/wall/ground)',
  vertical: 'per-building ground (min source height) placed at ellipsoid h=0; horizontal coordinates untouched. Source min heights kept in manifest tiles[].groundH',
  groundHRange: allH.length ? [Math.min(...allH), Math.max(...allH)] : null,
  resources: { networkCompressedBytes: netBytes, elapsedSec: Math.round((Date.now() - t0) / 1000), peakRssMB: Math.round(peakRss / 1048576), note: 'resume 時の値は当該実行分のみ' },
};
// tileset.json: ルート(region, ADD, コンテンツなし) + 子タイル(各自 ECEF transform, geometricError 0)
const hs = allTiles.flatMap((t) => [t.zRange[0], t.zRange[1]]);
const tileset = {
  asset: { version: '1.1', tilesetVersion: 'mission163-all' }, geometricError: 2000,
  root: {
    boundingVolume: bbox ? { region: [bbox.west, bbox.south, bbox.east, bbox.north].map((v, i) => v * Math.PI / 180).concat([Math.min(...hs, 0) - 5, Math.max(...hs, 0) + 5]) } : { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
    geometricError: 1000, refine: 'ADD',
    // メッシュ単位の無コンテンツ中間ノード(geometricError 120): 遠景では子 GLB をロードせず、近づいたときだけロード/解放される。
    children: ok.filter((r) => r.tilesFull.length).map((r) => {
      const tl = r.tilesFull, w = Math.min(...tl.map((t) => t.bbox.west)), e2 = Math.max(...tl.map((t) => t.bbox.east)), s2 = Math.min(...tl.map((t) => t.bbox.south)), n2 = Math.max(...tl.map((t) => t.bbox.north));
      const zs = tl.flatMap((t) => t.zRange);
      return {
        boundingVolume: { region: [w, s2, e2, n2].map((v) => v * Math.PI / 180).concat([Math.min(...zs, 0) - 5, Math.max(...zs, 0) + 5]) },
        geometricError: 120, refine: 'ADD',
        children: tl.map((t) => ({ transform: enuToEcefMatrix(t.org.lat, t.org.lon, t.org.h), boundingVolume: { box: t.box }, geometricError: 0, content: { uri: 'tiles/' + t.name } })),
      };
    }),
  },
};
const transformOk = allTiles.every((t) => { const m = enuToEcefMatrix(t.org.lat, t.org.lon, t.org.h), o = geodeticToEcef(t.org.lat, t.org.lon, t.org.h); return Math.hypot(m[12] - o[0], m[13] - o[1], m[14] - o[2]) < 1e-3; });
report.transformTranslationMatchesOrigin = transformOk;
fs.writeFileSync(path.join(out, 'tileset.json'), JSON.stringify(tileset));
fs.writeFileSync(path.join(out, 'footprints.json'), JSON.stringify({ ids: [...idSeen.keys()], footprints: allTiles.flatMap((t) => t.footprints) }));
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
const manifest = {
  schema: 'livecity-lod2-asset-manifest/1', source,
  assets: allTiles.map((t) => ({ lod: 'lod2', mesh: t.mesh, glb: { path: 'tiles/' + t.name, bytes: t.bytes, sha256: t.sha256 }, triangles: t.triangles, ids: t.ids, groundH: t.groundH, org: t.org })),
  tileset: { path: 'tileset.json', sha256: sha(Buffer.from(JSON.stringify(tileset))) },
  sourceGml: ok.map((r) => ({ mesh: r.mesh, bytes: r.gmlBytes, sha256: r.gmlSha256 })),
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest));
// Git に載せてよい小さな監査レポート(GLB/GML/ID全列挙なし。mesh単位の件数・sha256のみ)
const small = {
  ...report, perMesh: ok.map((r) => ({ mesh: r.mesh, buildings: r.buildings, expected: r.expected, expected159: r.expected159, converted: r.converted, failed: r.failed.length, missing: r.missing.length,
    extra: r.extra.length, lod1Fallback: r.lod1Fallback, tiles: r.tiles, triangles: r.triangles, glbBytes: r.glbBytes, roofWallInvalid: r.roofWallInvalid.length,
    texturedLod2: r.texturedLod2, gmlSha256: r.gmlSha256, groundHRange: r.groundHRange, tileSha256: r.tileList.map((t) => ({ name: t.name, bytes: t.bytes, sha256: t.sha256 })) })),
  failedIdList: report.failed.slice(0, 200),
};
fs.writeFileSync(path.join(repDir, 'lod2-all-report.json'), JSON.stringify(small, null, 1));
console.log(JSON.stringify(totals));
if (!totals.fullMatch) { console.log('FULL MATCH: NO'); process.exitCode = 2; } else console.log('FULL MATCH: YES');
