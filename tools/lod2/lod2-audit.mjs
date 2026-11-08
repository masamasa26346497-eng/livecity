#!/usr/bin/env node
// Mission 159: LOD2 availability audit over real PLATEAU CityGML (read-only).
// usage:
//   node tools/lod2/lod2-audit.mjs --meshes 52350318,... --out temp/lod2-audit   (Range fetch from source-lock URL)
//   node tools/lod2/lod2-audit.mjs --gml a.gml,b.gml --out temp/lod2-audit        (local files, no network)
//   --sample N  : with --all-lock, audit every Nth bldg mesh in the lock (default: explicit --meshes only)
// Writes <out>/lod2-coverage.json. Never writes into git-tracked paths by default (temp/ is gitignored).
// Source version & attribution are copied from the Mission79 source-lock. No LOD2 is ever inferred.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { LOCK_PATH, rangeFetch } from '../mission79-plateau2025-source.mjs';

export function auditGml(xml, name = '') {
  const r = { name, buildings: 0, lod1Solid: 0, lod2Solid: 0, lod2MultiSurface: 0, lod2Any: 0, lod3: 0,
    roofSurface: 0, wallSurface: 0, groundSurface: 0, appearance: 0, textured: 0, lod2Ids: [], dupIds: 0 };
  const seen = new Set();
  // ParameterizedTexture は建物の外側(appearanceMember)にあり、<app:target uri="#<polygon gml:id>"> で面を参照する。
  // よって建物本体内の検索では常に0になる(Mission159の textured:0 は誤り)。target の id 集合と建物内ポリゴン id の交差で数える。
  const texTargets = new Set(), x3dTargets = new Set();
  for (const t of xml.matchAll(/<app:ParameterizedTexture\b[\s\S]*?<\/app:ParameterizedTexture>/g)) for (const u of t[0].matchAll(/<app:target\s+uri="#([^"]+)"/g)) texTargets.add(u[1]);
  for (const t of xml.matchAll(/<app:X3DMaterial\b[\s\S]*?<\/app:X3DMaterial>/g)) for (const u of t[0].matchAll(/<app:target>#?([^<]+)<\/app:target>/g)) x3dTargets.add(u[1].replace(/^#/, ''));
  r.textureTargets = texTargets.size; r.x3dMaterialTargets = x3dTargets.size; r.texturedLod2 = 0; r.x3dMaterialLod2 = 0;
  const re = /<bldg:Building\b[^>]*gml:id="([^"]+)"[^>]*>([\s\S]*?)<\/bldg:Building>/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, id, body] = m;
    r.buildings++;
    if (seen.has(id)) r.dupIds++; seen.add(id);
    if (/<bldg:lod1Solid\b/.test(body)) r.lod1Solid++;
    const s = /<bldg:lod2Solid\b/.test(body), ms = /<bldg:lod2MultiSurface\b/.test(body);
    const bounded = /<bldg:(Roof|Wall|Ground)Surface\b/.test(body) && /<bldg:lod2MultiSurface\b/.test(body);
    if (s) r.lod2Solid++;
    if (ms) r.lod2MultiSurface++;
    if (s || ms || bounded) { r.lod2Any++; r.lod2Ids.push(id); }
    if (/<bldg:lod3/.test(body)) r.lod3++;
    if (/<bldg:RoofSurface\b/.test(body)) r.roofSurface++;
    if (/<bldg:WallSurface\b/.test(body)) r.wallSurface++;
    if (/<bldg:GroundSurface\b/.test(body)) r.groundSurface++;
    if (/<app:(Parameterized|Georeferenced)Texture\b/.test(body)) r.textured++;
    if (s || ms || bounded) {
      const pids = [...body.matchAll(/<gml:Polygon\b[^>]*gml:id="([^"]+)"/g)].map((q) => q[1]);
      if (pids.some((q) => texTargets.has(q))) r.texturedLod2++;
      if (pids.some((q) => x3dTargets.has(q))) r.x3dMaterialLod2++;
    }
  }
  r.appearance = (xml.match(/<app:appearanceMember\b/g) || []).length;
  r.lod1FallbackCount = r.buildings - r.lod2Any;
  return r;
}

export async function fetchEntry(url, e) {
  const h = await rangeFetch(url, e.localOffset, e.localOffset + 29);
  if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header ' + e.name);
  const start = e.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  const comp = await rangeFetch(url, start, start + e.compressedBytes - 1);
  const data = e.method === 8 ? zlib.inflateRawSync(comp) : comp;
  if (data.length !== e.uncompressedBytes) throw new Error('size mismatch ' + e.name);
  return data.toString('utf8');
}

async function main() {
  const a = process.argv.slice(2), g = (k) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : null);
  const out = path.resolve(g('--out') || 'temp/lod2-audit');
  fs.mkdirSync(out, { recursive: true });
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const maxMb = Number(g('--max-mb') || 300);
  const results = [], errors = [];
  if (g('--gml')) {
    for (const f of g('--gml').split(',')) results.push(auditGml(fs.readFileSync(f, 'utf8'), path.basename(f)));
  } else {
    let bl = lock.entries.filter((e) => e.kind === 'bldg');
    const want = g('--meshes') ? g('--meshes').split(',') : null;
    if (want) bl = bl.filter((e) => want.includes(e.mesh));
    else if (g('--sample')) bl = bl.filter((_, i) => i % Number(g('--sample')) === 0);
    else throw new Error('--meshes, --sample or --gml required');
    const mb = bl.reduce((n, e) => n + e.uncompressedBytes, 0) / 1048576;
    console.log('[lod2-audit] meshes=' + bl.length + ' inflated=' + mb.toFixed(1) + 'MB');
    if (mb > maxMb) throw new Error('over --max-mb');
    for (const e of bl) {
      try { const r = auditGml(await fetchEntry(lock.resource.url, e), e.name); r.mesh = e.mesh; results.push(r); console.log(e.mesh, r.buildings, 'lod2=' + r.lod2Any); }
      catch (err) { errors.push({ mesh: e.mesh, error: String(err.message || err) }); console.log(e.mesh, 'ERROR', err.message); }
    }
  }
  const sum = (k) => results.reduce((n, r) => n + r[k], 0);
  const manifest = {
    mission: '159-lod2-coverage', generatedAt: new Date().toISOString(),
    source: { package: lock.package?.name, license: lock.license?.title, attribution: lock.attribution, etag: lock.http?.etag },
    meshesAudited: results.length, errors,
    totals: { buildings: sum('buildings'), lod1Solid: sum('lod1Solid'), lod2Solid: sum('lod2Solid'), lod2MultiSurface: sum('lod2MultiSurface'),
      lod2Any: sum('lod2Any'), lod3: sum('lod3'), roofSurface: sum('roofSurface'), wallSurface: sum('wallSurface'), textured: sum('textured'), texturedLod2: sum('texturedLod2'), x3dMaterialLod2: sum('x3dMaterialLod2'), textureTargets: sum('textureTargets'),
      appearanceMembers: sum('appearance'), lod1Fallback: sum('lod1FallbackCount') },
    lod2Ratio: sum('buildings') ? sum('lod2Any') / sum('buildings') : 0,
    classification: sum('lod2Any') === 0 ? 'source-has-no-lod2-in-audited-meshes' : 'lod2-present',
    perMesh: results.map(({ lod2Ids, ...r }) => ({ ...r, lod2IdSample: lod2Ids.slice(0, 5) })),
  };
  fs.writeFileSync(path.join(out, 'lod2-coverage.json'), JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify(manifest.totals), manifest.classification);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch((e) => { console.error(e); process.exit(1); });
