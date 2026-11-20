#!/usr/bin/env node
// Mission 188 (PR #51 only): ONE-COMMAND, resumable, cross-platform builder of the 24-ward 2025 PLATEAU LOD1 set into a PERSISTENT
// local folder, laid out as the 37G `?ext45=1` loader expects: <out>/ext-3dtiles/index.json + <out>/ext-3dtiles/<ward>/{tileset.json,source.json,tiles/,attrs/}.
// Reuses unchanged: tools/mission79-run.mjs (official free Range fetch, source-lock, CityGML->LOD1), tools/mission164 harden, mission178 index schema.
//   node tools/mission188/build-local-2025.mjs --out "<dir>" --plan
//   node tools/mission188/build-local-2025.mjs --out "<dir>" --all            # generate + verify + index; re-run = resume (verified wards are skipped)
//   node tools/mission188/build-local-2025.mjs --out "<dir>" --wards chuo,kita
//   node tools/mission188/build-local-2025.mjs --out "<dir>" --verify-only    # re-hash every ward against its manifest, rebuild index
// Safety: refuses the legacy LiveCity-3DTiles-Out-24 dir and any non-empty dir not created by this tool; a ward is built in
// <out>/.staging and renamed into place only after verification; only verified wards enter index.json. Network: official PLATEAU host only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MARKER = '.livecity-2025-lod1-root.json';
export const DECLARED_2025 = 615234; // Mission 165 measured total on a runner: reference only, never counted as done

export function assertSafeOut(out, existsFn = fs.existsSync, listFn = (d) => fs.readdirSync(d)) {
  const full = path.resolve(out);
  if (/LiveCity-3DTiles-(Out|LOD0)-24/i.test(full)) throw new Error('refusing legacy output dir: ' + out);
  if (existsFn(full) && listFn(full).length && !listFn(full).includes(MARKER)) throw new Error('refusing non-empty dir not created by this tool: ' + out);
  return true;
}

export function listFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath || e.path, e.name)).split(path.sep).join('/')).sort();
}
export function treeHash(dir) {
  const h = crypto.createHash('sha256'); let bytes = 0; const files = listFiles(dir);
  for (const f of files) { const b = fs.readFileSync(path.join(dir, f)); bytes += b.length; h.update(f + '\0' + crypto.createHash('sha256').update(b).digest('hex') + '\n'); }
  return { treeSha256: h.digest('hex'), bytes, files: files.length };
}
export function tilesetUris(ts) {
  const u = []; const walk = (n) => { const c = n.content; if (c && (c.uri || c.url)) u.push(c.uri || c.url); (n.children || []).forEach(walk); }; walk(ts.root); return u;
}
// Structural verification of one ward dir. Returns {ok, problems[], buildings, ids[], source}
export function verifyWardDir(dir, expect) {
  const problems = []; const ids = [];
  const rd = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  let src = null, ts = null;
  try { src = rd('source.json'); } catch (e) { problems.push('source.json unreadable'); }
  try { ts = rd('tileset.json'); } catch (e) { problems.push('tileset.json unreadable'); }
  if (ts) {
    const uris = tilesetUris(ts);
    if (!uris.length) problems.push('tileset has no content');
    const missing = uris.filter((u) => !fs.existsSync(path.join(dir, u)));
    if (missing.length) problems.push('missing tile files: ' + missing.length + ' e.g. ' + missing[0]);
    const empties = []; (function w(n) { if (!(n.content && (n.content.uri || n.content.url)) && (n.children || []).length) empties.push(n); (n.children || []).forEach(w); })(ts.root);
    if (empties.some((n) => !(n.geometricError > Math.max(0, ...n.children.map((c) => c.geometricError || 0))))) problems.push('tileset not hardened (empty parent would stop refinement)');
  }
  let total = 0;
  if (fs.existsSync(path.join(dir, 'attrs'))) {
    for (const f of fs.readdirSync(path.join(dir, 'attrs'))) { const k = Object.keys(rd('attrs/' + f).byId || {}); total += k.length; for (const i of k) ids.push(i); }
  } else problems.push('attrs/ missing');
  if (new Set(ids).size !== ids.length) problems.push('duplicate gml:id inside ward');
  if (src) {
    if (!src.attribution) problems.push('attribution missing');
    if (expect && expect.etag && src.sourceEtag !== expect.etag) problems.push('source ETag differs from source-lock');
    if (expect && expect.wardCode && String(src.wardCode) !== String(expect.wardCode)) problems.push('wardCode mismatch');
    if (src.counts && src.counts.inWard !== total) problems.push('attrs ids ' + total + ' != source inWard ' + src.counts.inWard);
  }
  return { ok: problems.length === 0, problems, buildings: total, ids, source: src };
}
export function crossWardDuplicates(idsByWard) {
  const seen = new Map(), d = [];
  for (const [w, ids] of Object.entries(idsByWard)) for (const i of ids) { if (seen.has(i)) d.push({ id: i, wards: [seen.get(i), w] }); else seen.set(i, w); }
  return d;
}
// index.json only ever lists wards whose manifest says verified. Same schema as tools/mission178 (+ honest flags).
export function buildIndex(manifests, lock) {
  const wards = Object.entries(manifests).filter(([, m]) => m && m.verified === true).map(([ward, m]) => ({
    ward, wardCode: m.wardCode, buildings: m.buildings, tiles: m.tiles, bytes: m.bytes, treeSha256: m.treeSha256, lod: 'LOD1', idScheme: 'gml:id', sourceVersion: lock.package.name,
  }));
  return {
    schema: 'livecity-ext3dtiles-index/1', kind: 'local-only', source: lock.package.name, sourceEtag: lock.http.etag, license: lock.license, attribution: lock.attribution,
    verified: false, // 37G UI + road/river overlay are NOT measured by this tool
    structurallyVerifiedWards: wards.length, expectedWards: 24, complete24: wards.length === 24,
    ui37gVerified: false, roadRiverAlignmentVerified: false, persisted: 'local-folder-only', published: false, lod0Wards: [], layersWards: [], wards,
  };
}
export function diskCheck(out, needMB, statfs = fs.statfsSync) {
  let dir = path.resolve(out); while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const s = statfs(dir); const freeMB = Math.floor(s.bavail * s.bsize / 1048576);
  return { freeMB, needMB, ok: freeMB >= needMB };
}

async function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const has = (k) => a.includes('--' + k);
  const ROOT = process.cwd(), readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!opt('out')) { console.error('need --out <persistent dir> (e.g. %LOCALAPPDATA%\\LiveCity-3DTiles-Out-2025)'); process.exit(2); }
  const out = path.resolve(opt('out'));
  const lock = readJson('data/reports/mission79/source-lock.json');
  const bad = []; // same rights gate as Mission 156
  if (!/^plateau-27100-osaka-shi-\d{4}$/.test(lock.package.name)) bad.push('package');
  if (lock.license.id !== 'plateau') bad.push('license');
  if (new URL(lock.resource.url).hostname !== 'assets.cms.plateau.reearth.io') bad.push('host');
  if (!lock.attribution) bad.push('attribution');
  if (!lock.http.etag) bad.push('etag');
  if (bad.length) { console.error('RIGHTS GATE FAILED:', bad.join(',')); process.exit(2); }

  const { selectMeshes } = await import('../mission79-run.mjs');
  const { hardenDir } = await import('../mission164/harden-tileset.mjs');
  const area = readJson('config/areas/osaka-city.json'), polys = readJson('data/processed/osaka-city/boundaries/ward-classification-polygons.json');
  const plan = {};
  for (const w of polys.wards) {
    const { meshes } = selectMeshes(lock, w, area.projection); const ents = lock.entries.filter((e) => meshes.includes(e.mesh));
    plan[w.wardId] = { wardCode: w.wardCode, meshes: meshes.length, compressedMB: +(ents.reduce((n, e) => n + e.compressedBytes, 0) / 1048576).toFixed(1), inflatedMB: +(ents.reduce((n, e) => n + e.uncompressedBytes, 0) / 1048576).toFixed(1) };
  }
  const wards = has('all') || has('verify-only') ? Object.keys(plan) : (opt('wards') || '').split(',').filter(Boolean);
  const pool = wards.length ? wards : Object.keys(plan);
  const maxInfl = Math.max(...pool.map((w) => (plan[w] || { inflatedMB: 0 }).inflatedMB));
  const todo = pool.filter((w) => !fs.existsSync(path.join(out, 'ext-3dtiles', '_manifest', w + '.json')));
  const need = Math.ceil((maxInfl + todo.length * 80) * 1.1); // largest raw-GML work dir + ~80MB output per ward still to build
  if (has('plan') || !wards.length) {
    console.log(JSON.stringify({ out, wardsPlanned: Object.keys(plan).length, requested: wards, perWard: plan, estimatedDiskNeedMB: need, disk: diskCheck(out, need), declaredReference2025: DECLARED_2025, note: 'declared figure is reference only; real counts come from verified manifests' }, null, 1));
    process.exit(has('plan') ? 0 : 2);
  }
  assertSafeOut(out);
  const dc = diskCheck(out, need);
  if (!has('verify-only') && !dc.ok) { console.error('NOT ENOUGH DISK: need ~' + need + ' MB, free ' + dc.freeMB + ' MB at ' + out); process.exit(3); }
  const ext = path.join(out, 'ext-3dtiles'), man = path.join(ext, '_manifest'), stg = path.join(out, '.staging');
  fs.mkdirSync(man, { recursive: true });
  fs.writeFileSync(path.join(out, MARKER), JSON.stringify({ tool: 'mission188', source: lock.package.name, note: 'LiveCity 2025 PLATEAU LOD1; legacy -Out-24 is never touched' }));
  const maxMb = Number(opt('max-mb', 1300)), tmo = Number(opt('ward-timeout-min', 25)) * 60000, retries = Number(opt('retries', 3));
  const manifests = {}, report = { built: [], skipped: [], failed: [], notRun: [] };
  for (const w of wards) {
    if (!plan[w]) { report.failed.push({ ward: w, error: 'unknown ward' }); continue; }
    const mf = path.join(man, w + '.json'), dir = path.join(ext, w);
    const prev = fs.existsSync(mf) ? readJson(mf) : null;
    const expect = { etag: lock.http.etag, wardCode: plan[w].wardCode };
    // resume: trust a stored ward only if same ETag, structure verifies AND tree hash equals its manifest
    if (prev && prev.verified && prev.sourceEtag === lock.http.etag && fs.existsSync(dir)) {
      const v = verifyWardDir(dir, expect), th = v.ok ? treeHash(dir) : null;
      if (v.ok && th.treeSha256 === prev.treeSha256) { manifests[w] = prev; report.skipped.push(w); console.log('[188] ok (verified, skipped)', w); continue; }
      console.error('[188] stored ward failed re-verification:', w, v.ok ? 'tree sha256 differs' : v.problems.join('; '));
    }
    if (has('verify-only')) { report.notRun.push({ ward: w, reason: prev ? 'failed re-verification' : 'not generated yet' }); continue; }
    const t0 = Date.now(), work = path.join(stg, w + '-work'), fin = path.join(stg, w + '-tiles');
    try {
      let lastErr = null;
      for (let i = 1; i <= retries; i++) {
        try {
          fs.rmSync(fin, { recursive: true, force: true });
          execFileSync(process.execPath, ['tools/mission79-run.mjs', '--ward', w, '--work', work, '--final', fin, '--max-mb', String(maxMb)], { stdio: 'inherit', cwd: ROOT, maxBuffer: 1 << 28, timeout: tmo });
          lastErr = null; break;
        } catch (e) { lastErr = e; console.error('[188] attempt', i, 'failed for', w, String(e.message).slice(0, 120)); }
      }
      if (lastErr) throw lastErr;
      const hardened = hardenDir(fin);
      const v = verifyWardDir(fin, expect);
      if (!v.ok) throw new Error('verification failed: ' + v.problems.join('; '));
      const th = treeHash(fin), ts = readJson(path.join(fin, 'tileset.json'));
      fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(fin, dir); // into place only after verification
      const m = { ward: w, wardCode: plan[w].wardCode, verified: true, sourceEtag: lock.http.etag, sourceBuildings: v.source.counts.read, buildings: v.buildings, outsideWard: v.source.counts.outsideWard,
        tiles: (ts.extras && ts.extras.tiles) || tilesetUris(ts).length, files: th.files, bytes: th.bytes, treeSha256: th.treeSha256, hardenedNodes: hardened, meshes: v.source.sourceMeshes.length, generatedAt: new Date().toISOString(), ms: Date.now() - t0 };
      fs.writeFileSync(mf, JSON.stringify(m, null, 1)); manifests[w] = m; report.built.push(w);
      console.log('[188] built', w, m.buildings, 'buildings', (m.bytes / 1048576).toFixed(1) + 'MB', m.ms + 'ms');
    } catch (e) { report.failed.push({ ward: w, error: String(e.message).slice(0, 300) }); console.error('[188] FAILED', w, e.message); }
    fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(fin, { recursive: true, force: true });
  }
  // the index reflects the whole folder: also include previously verified wards not named in this invocation
  for (const f of fs.readdirSync(man)) {
    const w = f.replace(/\.json$/, '');
    if (!manifests[w] && !wards.includes(w)) { const m = readJson(path.join(man, f)); if (m.verified && fs.existsSync(path.join(ext, w, 'tileset.json'))) manifests[w] = m; }
  }
  const idsByWard = {}; for (const w of Object.keys(manifests)) idsByWard[w] = verifyWardDir(path.join(ext, w), null).ids;
  const dups = crossWardDuplicates(idsByWard);
  if (dups.length) { for (const d of dups.slice(0, 20)) console.error('[188] cross-ward duplicate', d.id, d.wards.join('/')); for (const w of new Set(dups.flatMap((d) => d.wards))) delete manifests[w]; }
  const idx = buildIndex(manifests, lock);
  fs.writeFileSync(path.join(ext, 'index.json'), JSON.stringify(idx, null, 1));
  fs.rmSync(stg, { recursive: true, force: true });
  const summary = { out, wardsInIndex: idx.wards.length, of: 24, runtimeBuildings: idx.wards.reduce((n, x) => n + x.buildings, 0), declaredReference2025: DECLARED_2025, built: report.built, skippedVerified: report.skipped, failed: report.failed, notRun: report.notRun, crossWardDuplicateIds: dups.length, notYetDone: 24 - idx.wards.length, bytes: idx.wards.reduce((n, x) => n + x.bytes, 0) };
  fs.writeFileSync(path.join(out, 'build-report.json'), JSON.stringify(summary, null, 1));
  console.log('[188] summary', JSON.stringify(summary));
  console.log(idx.complete24 ? '[188] 24/24 structurally verified. 37G browser check NOT done by this tool.' : '[188] INCOMPLETE: ' + idx.wards.length + '/24 in index; re-run the same command to resume.');
  process.exit(report.failed.length || dups.length ? 1 : 0);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
