#!/usr/bin/env node
'use strict';
// Mission 43: per-ward rebuild (fail-closed), integrity verify, per-ward migration manifest, owner-PC preflight.
// Offline by default. Never uploads/packs/deletes. Never opens a transfer/privacy/licence gate. Output has no PC paths.
//   node tools/mission43-ward-rebuild.cjs manifest [--write]
//   node tools/mission43-ward-rebuild.cjs rebuild --ward <id> --out <NEW dir> [--tracked-only]
//   node tools/mission43-ward-rebuild.cjs verify --dir <tileset dir>
//   node tools/mission43-ward-rebuild.cjs preflight --src <buildings dir> [--gates g.json]
//   node tools/mission43-ward-rebuild.cjs sources [--online]     (online = HEAD only, 3 URLs, 10s timeout)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BLD_REL = 'public/map-data/osaka-city/buildings';
const REPORT_DIR = path.join(ROOT, 'data/reports/mission43');
const GATE_NAMES = ['licenceApproved', 'noSecretsReviewed', 'noPersonalDataReviewed'];
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function gitTracked(rel) {
  const out = execFileSync('git', ['ls-files', '-z', rel], { cwd: ROOT, maxBuffer: 1 << 28 }).toString('utf8');
  return out.split('\0').filter(Boolean);
}
function wards() { return readJson(path.join(ROOT, 'config/wards/registry.json')).wards; }
function dirBytes(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) n += fs.statSync(path.join(e.parentPath || e.path, e.name)).size;
  return n;
}

// ---- existing published tilesets (Git-tracked) keyed by wardCode
function existingSets() {
  const res = [];
  for (const base of ['mission37b-3dtiles', 'mission37h-3dtiles', 'mission38e-3dtiles', 'mission40j-3dtiles']) {
    const b = path.join(ROOT, 'public', base);
    if (!fs.existsSync(b)) continue;
    for (const d of fs.readdirSync(b, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sj = path.join(b, d.name, 'source.json'), bj = path.join(b, d.name, 'build-report.json');
      const rel = 'public/' + base + '/' + d.name;
      if (!fs.existsSync(path.join(b, d.name, 'tileset.json'))) continue;
      const tracked = gitTracked(rel).length > 0;
      let wardCode = null, buildings = null;
      try { wardCode = fs.existsSync(sj) ? String(readJson(sj).wardCode || '') || null : null; } catch (e) { /* ignore */ }
      try { if (fs.existsSync(bj)) { const t = readJson(bj).totals || readJson(bj); buildings = t.buildings != null ? t.buildings : null; } } catch (e) { /* ignore */ }
      res.push({ rel, wardCode, buildings, tracked });
    }
  }
  return res;
}

function buildManifest() {
  const sets = existingSets();
  const legacyTrackedAll = gitTracked(BLD_REL);
  const out = [];
  for (const w of wards()) {
    const ds = 'osaka-' + w.id;
    const tracked = legacyTrackedAll.filter((f) => f.startsWith(BLD_REL + '/' + ds + '/'));
    const mfRel = BLD_REL + '/' + ds + '/manifest.json';
    let expectedTiles = null;
    if (tracked.includes(mfRel)) { try { expectedTiles = readJson(path.join(ROOT, mfRel)).tiles.length; } catch (e) { /* ignore */ } }
    const tileFiles = tracked.filter((f) => /\/tile_[^/]+\.json$/.test(f)).length;
    const legacyComplete = expectedTiles != null && tileFiles === expectedTiles;
    const own = sets.filter((s) => s.wardCode === w.code && s.tracked);
    const groups = {
      buildings3dInGit: own.length
        ? { state: 'in-Git', partial: w.id !== 'sumiyoshi' || undefined, sets: own.map((s) => s.rel), buildings: own.reduce((n, s) => n + (s.buildings || 0), 0) }
        : { state: 'not-in-Git' },
      legacyBuildingTilesInGit: legacyComplete ? { state: 'in-Git-complete', tiles: tileFiles } : { state: 'not-in-Git', tracked: tileFiles },
      // layers: only the Sumiyoshi 9-tile OSM slice is tracked
      osmLayers: w.id === 'sumiyoshi' ? { state: 'in-Git-partial', path: 'public/mission37c-layers/osaka-sumiyoshi-9tile' } : { state: 'not-in-Git' },
      facilities: gitTracked('public/map-data/osaka-city/facilities/wards/' + w.id + '.json').length ? { state: 'in-Git' } : { state: 'not-in-Git' },
    };
    let route;
    if (legacyComplete) route = 'rebuildable-from-Git-tracked-legacy-tiles (rebuild --ward ' + w.id + ')';
    else if (own.length) route = 'partial-3D-in-Git; full ward needs public re-fetch (PLATEAU mesh range, licence unapproved) or owner-PC legacy tiles';
    else route = 'needs public re-fetch (PLATEAU CityGML via 36K) or owner-PC legacy tiles; nothing in Git';
    out.push({
      ward: w.id, name: w.name, code: w.code, groups, route,
      localOnlyMinimum: legacyComplete ? [] : ['legacy building tiles for this ward (' + ds + '), only if public re-fetch is not approved'],
      osmLayersRoute: groups.osmLayers.state === 'not-in-Git' ? 'rebuild from OSM (ODbL) via 40G needs source tiles or Overpass; licenceApproved=false' : 'in Git (partial)',
    });
  }
  return {
    schema: 'livecity.mission43.ward-migration/1',
    gates: { licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false, uploadAllowed: 0 },
    excluded: ['whole-PC bulk (~75GB)', 'secret/credential/contact candidates', 'Google Places paid mapping', '41* scan artifacts', 'original tar archives'],
    transferredNow: { files: 0, bytes: 0 },
    summary: {
      wards: out.length,
      wardsWith3dInGit: out.filter((x) => x.groups.buildings3dInGit.state === 'in-Git').length,
      wardsLegacyTilesCompleteInGit: out.filter((x) => x.groups.legacyBuildingTilesInGit.state === 'in-Git-complete').length,
      wardsNeedingSourceData: out.filter((x) => x.groups.legacyBuildingTilesInGit.state !== 'in-Git-complete').length,
    },
    wards: out,
  };
}

// ---- verify: tileset.json -> GLB integrity, ids/attrs consistency (read-only)
function collectUris(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (node.content && node.content.uri) acc.push(node.content.uri);
  if (node.uri && typeof node.uri === 'string') acc.push(node.uri);
  for (const c of node.children || []) collectUris(c, acc);
  return acc;
}
function verifyDir(dir) {
  const problems = [];
  dir = path.resolve(dir);
  const tsPath = path.join(dir, 'tileset.json');
  if (!fs.existsSync(tsPath)) return { ok: false, problems: ['missing tileset.json'] };
  for (const f of ['source.json', 'build-report.json']) if (!fs.existsSync(path.join(dir, f))) problems.push('missing ' + f);
  for (const d of ['attrs', 'ids']) if (!fs.existsSync(path.join(dir, d))) problems.push('missing ' + d + '/');
  const ts = readJson(tsPath);
  const uris = [...new Set(collectUris(ts.root, []))];
  let glbOk = 0;
  for (const u of uris) {
    if (/^[a-z]+:/i.test(u) || u.startsWith('/') || u.includes('..')) { problems.push('non-local uri: ' + u); continue; }
    const p = path.join(dir, u);
    if (!fs.existsSync(p)) { problems.push('uri target missing: ' + u); continue; }
    if (u.endsWith('.glb')) {
      const b = fs.readFileSync(p);
      if (b.length < 20 || b.toString('ascii', 0, 4) !== 'glTF' || b.readUInt32LE(4) !== 2 || b.readUInt32LE(8) !== b.length) problems.push('bad glb header/length: ' + u);
      else glbOk++;
    }
  }
  const idsDir = path.join(dir, 'ids'), attrsDir = path.join(dir, 'attrs');
  let idCount = 0; const seen = new Set(); let dup = 0, attrIdCount = 0;
  if (fs.existsSync(idsDir)) for (const f of fs.readdirSync(idsDir)) {
    if (!/^t_.*\.json$/.test(f)) continue; // g_* = coarse LOD sidecars repeat leaf ids by design
    const arr = readJson(path.join(idsDir, f)); const list = Array.isArray(arr) ? arr : (arr.ids || []);
    for (const id of list) { idCount++; if (seen.has(id)) dup++; seen.add(id); }
  }
  if (fs.existsSync(attrsDir)) for (const f of fs.readdirSync(attrsDir)) {
    if (!f.endsWith('.json')) continue;
    attrIdCount += Object.keys(readJson(path.join(attrsDir, f)).byId || {}).length;
  }
  let reported = null;
  try { const br = readJson(path.join(dir, 'build-report.json')); reported = (br.totals || br).buildings; } catch (e) { /* ignore */ }
  if (reported != null && reported !== idCount) problems.push('ids count ' + idCount + ' != build-report buildings ' + reported);
  if (attrIdCount && attrIdCount !== idCount) problems.push('attrs ids ' + attrIdCount + ' != ids ' + idCount);
  if (dup) problems.push('duplicate ids inside ward: ' + dup);
  let wardCode = null; try { wardCode = String(readJson(path.join(dir, 'source.json')).wardCode || '') || null; } catch (e) { /* ignore */ }
  if (!wardCode) problems.push('source.json has no wardCode');
  const bytes = dirBytes(dir);
  const SIZE_CAP = 60 * 1048576; // per-ward preview cap (informational guard, not a licence decision)
  if (bytes > SIZE_CAP) problems.push('size ' + bytes + ' exceeds preview cap ' + SIZE_CAP);
  return { ok: problems.length === 0, problems, wardCode, tileUris: uris.length, glbOk, ids: idCount, uniqueIds: seen.size, reportedBuildings: reported, bytes, onDemandOk: !!wardCode && uris.length > 0 };
}

// ---- rebuild: fail-closed on anything not Git-tracked
function rebuild(wardId, outDir) {
  const w = wards().find((x) => x.id === wardId);
  if (!w) throw new Error('unknown ward: ' + wardId);
  const ds = 'osaka-' + wardId;
  const m = buildManifest().wards.find((x) => x.ward === wardId);
  if (m.groups.legacyBuildingTilesInGit.state !== 'in-Git-complete') {
    const e = new Error('FAIL-CLOSED: legacy tiles for ' + wardId + ' are not completely Git-tracked (' + m.groups.legacyBuildingTilesInGit.tracked + ' tracked files). Not guessing local paths. Owner-PC path: tools/mission40c-run-local.ps1 -Wards ' + wardId); e.code = 3; throw e;
  }
  // every on-disk tile must be tracked too (no untracked local-only file may slip in)
  const dirAbs = path.join(ROOT, BLD_REL, ds);
  const tracked = new Set(gitTracked(BLD_REL + '/' + ds).map((f) => path.basename(f)));
  const stray = fs.readdirSync(dirAbs).filter((f) => !tracked.has(f));
  if (stray.length) { const e = new Error('FAIL-CLOSED: ' + stray.length + ' untracked file(s) in source dir'); e.code = 3; throw e; }
  outDir = path.resolve(outDir);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) { const e = new Error('output dir not empty; refusing to overwrite'); e.code = 4; throw e; }
  const relOut = path.relative(ROOT, outDir);
  if (!relOut.startsWith('..') && gitTracked(relOut).length) { const e = new Error('output dir is Git-tracked; refusing'); e.code = 4; throw e; }
  const batch = require('./mission40b-legacy-tiles-batch.cjs');
  const t0 = Date.now();
  const res = batch.convertWard(wardId, { out: outDir, force: true });
  const v = verifyDir(outDir);
  const report = {
    schema: 'livecity.mission43.rebuild/1', ward: wardId, wardCode: w.code, source: 'Git-tracked legacy tiles only (no network, no local-only input)',
    convert: { tiles: res.tiles, buildings: res.buildings, uniqueIds: res.uniqueIds, skipped: res.skipped, fallbacks: res.fallbacks, totalBytes: res.totalBytes, ms: Date.now() - t0 },
    verify: v, published: false, note: 'Output is a local artifact; not added to Git. Publishing needs licenceApproved + owner approval (40J).',
  };
  fs.writeFileSync(path.join(outDir, 'rebuild-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

// ---- preflight for the owner PC: anonymous counts only
function preflight(src, gatesFile) {
  src = path.resolve(src);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error('source dir not found');
  const wardIds = new Set(wards().map((w) => 'osaka-' + w.id));
  const perWard = {}; const other = { dirs: 0, files: 0, bytes: 0 }; const risky = { archives: 0, nonJson: 0 };
  const root = { files: 0, jsonFiles: 0, nonJsonFiles: 0, hasManifestJson: false };
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    if (d.isSymbolicLink()) continue;
    const p = path.join(src, d.name);
    if (!d.isDirectory()) {
      root.files++;
      if (/\.json$/i.test(d.name)) { root.jsonFiles++; if (d.name === 'manifest.json') root.hasManifestJson = true; } else { root.nonJsonFiles++; risky.nonJson++; }
      if (/\.(tar|zip|gz|7z|tgz)$/i.test(d.name)) risky.archives++;
      continue;
    }
    let files = 0, bytes = 0;
    for (const e of fs.readdirSync(p, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue; files++; bytes += fs.statSync(path.join(e.parentPath || e.path, e.name)).size;
      if (!/\.json$/i.test(e.name)) risky.nonJson++;
      if (/\.(tar|zip|gz|7z|tgz)$/i.test(e.name)) risky.archives++;
    }
    if (wardIds.has(d.name)) perWard[d.name.replace(/^osaka-/, '')] = { files, bytes };
    else { other.dirs++; other.files += files; other.bytes += bytes; }
  }
  let gates = {}; let gf = null;
  if (gatesFile && fs.existsSync(gatesFile)) gf = readJson(gatesFile);
  for (const n of GATE_NAMES) gates[n] = !!(gf && gf[n] === true);
  const missingWards = [...wardIds].map((x) => x.replace(/^osaka-/, '')).filter((x) => !perWard[x]);
  return {
    schema: 'livecity.mission43.preflight/1', wardsFound: Object.keys(perWard).length, missingWards, perWard,
    otherFolders: other, rootFiles: root, riskyFileCounts: risky, gates,
    eligibleForUpload: 0, uploadAllowed: 0,
    note: 'Counts and sizes only; no names, paths or values. eligible/uploadAllowed stay 0 regardless of gates: transfer is a separate owner-approved phase. Nothing is packed or sent.',
  };
}

// ---- inspect: anonymous read-only integrity check of the owner's legacy buildings dir. Writes nothing.
// Output = counts only (no names, no paths, no values). Fail-closed: any problem => ok:false, exit 1.
const MAX_TILE_BYTES = 64 << 20; // larger single files are skipped and counted (skippedTooLarge)
function inspect(src) {
  if (!src) throw new Error('--src required');
  src = path.resolve(src);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error('source dir not found');
  const out = { schema: 'livecity.mission43.inspect/1', readOnly: true, ok: false, rootManifest: { present: false, valid: false, wardCountMatches: false },
    wards: {}, totals: { wards: 0, tilesListed: 0, tilesFound: 0, tilesMissing: 0, buildings: 0, jsonSyntaxErrors: 0, badId: 0, dupIdWithinWard: 0, countMismatch: 0, skippedUnreadable: 0, skippedTooLarge: 0, dupIdAcrossWards: 0 },
    otherFolders: { dirs: 0, files: 0, jsonFiles: 0, otherFiles: 0 }, problems: [],
    note: 'Anonymous counts only. Nothing was written, copied, or sent. Not proof the rebuild succeeds.' };
  const fail = (m) => { if (out.problems.length < 50) out.problems.push(m); };
  let root = null;
  const rm = path.join(src, 'manifest.json');
  if (fs.existsSync(rm)) {
    out.rootManifest.present = true;
    try { root = readJson(rm); out.rootManifest.valid = Array.isArray(root.datasets); } catch (e) { fail('root manifest unreadable'); }
  } else fail('root manifest.json missing');
  const reg = wards().map((w) => 'osaka-' + w.id);
  const listed = root && Array.isArray(root.datasets) ? root.datasets.map((d) => d.id) : [];
  out.rootManifest.wardCountMatches = listed.length === 24 && new Set(listed).size === 24 && reg.every((id) => listed.includes(id));
  if (!out.rootManifest.wardCountMatches) fail('root manifest does not list exactly the 24 registry wards');
  const seen = new Set(); let crossDup = 0;
  const sumKeys = ['jsonSyntaxErrors', 'badId', 'dupIdWithinWard', 'countMismatch', 'skippedUnreadable', 'skippedTooLarge', 'tilesListed', 'tilesFound', 'tilesMissing', 'buildings'];
  for (const d of (root && root.datasets) || []) {
    const wid = String(d.wardId || d.id || '').replace(/^osaka-/, '');
    const w = { manifestPresent: false, manifestBuildings: d.buildings, manifestTiles: d.tiles, tilesListed: 0, tilesFound: 0, tilesMissing: 0, buildings: 0, jsonSyntaxErrors: 0, badId: 0, dupIdWithinWard: 0, countMismatch: 0, skippedUnreadable: 0, skippedTooLarge: 0 };
    out.wards[wid] = w; out.totals.wards++;
    const dir = path.join(src, String(d.id));
    const mf = path.join(dir, 'manifest.json');
    if (!/^osaka-[a-z]+$/.test(String(d.id)) || !fs.existsSync(mf)) { fail('ward manifest missing: ' + wid); continue; }
    w.manifestPresent = true;
    let m;
    try { m = readJson(mf); } catch (e) { w.jsonSyntaxErrors++; out.totals.jsonSyntaxErrors++; fail('ward manifest unreadable: ' + wid); continue; }
    const own = new Set();
    for (const t of m.tiles || []) {
      w.tilesListed++;
      const fname = typeof t.file === 'string' ? path.basename(t.file) : 'tile_' + t.tx + '_' + t.tz + '.json'; // basename: no traversal
      const f = path.join(dir, fname);
      let st; try { st = fs.statSync(f); } catch (e) { w.tilesMissing++; continue; }
      if (st.size > MAX_TILE_BYTES) { w.skippedTooLarge++; continue; }
      let tile;
      try { tile = JSON.parse(fs.readFileSync(f, 'utf8')); }
      catch (e) { if (e instanceof SyntaxError) w.jsonSyntaxErrors++; else w.skippedUnreadable++; continue; } // IO error / cloud-only => skipped, not a syntax error
      w.tilesFound++;
      const bs = Array.isArray(tile.buildings) ? tile.buildings : [];
      if (!Array.isArray(tile.buildings)) w.jsonSyntaxErrors++;
      if (t.count != null && bs.length !== t.count) w.countMismatch++;
      for (const b of bs) {
        w.buildings++;
        if (!b || typeof b.id !== 'string' || !/^bldg_/.test(b.id)) { w.badId++; continue; }
        if (own.has(b.id)) w.dupIdWithinWard++; else own.add(b.id);
      }
    }
    for (const id of own) { if (seen.has(id)) crossDup++; else seen.add(id); }
    for (const k of sumKeys) out.totals[k] += w[k];
    if (d.buildings != null && w.buildings !== d.buildings && !w.skippedUnreadable && !w.skippedTooLarge) fail('building count differs from root manifest: ' + wid);
    for (const k of ['tilesMissing', 'jsonSyntaxErrors', 'badId', 'dupIdWithinWard', 'countMismatch', 'skippedUnreadable', 'skippedTooLarge']) if (w[k]) fail(k + ': ' + wid);
  }
  out.totals.dupIdAcrossWards = crossDup; // informational: known conflicts (Mission 40D), not a fail condition
  const wardIds = new Set(listed);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink() || !e.isDirectory() || wardIds.has(e.name)) continue;
    out.otherFolders.dirs++;
    try {
      for (const f of fs.readdirSync(path.join(src, e.name), { recursive: true, withFileTypes: true })) {
        if (!f.isFile()) continue; out.otherFolders.files++;
        if (/\.json$/i.test(f.name)) out.otherFolders.jsonFiles++; else out.otherFolders.otherFiles++;
      }
    } catch (x) { fail('other folder unreadable'); }
  }
  out.ok = out.problems.length === 0;
  return out;
}

function head(url) {
  return new Promise((resolve) => {
    const u = new URL(url); const mod = require(u.protocol === 'https:' ? 'https' : 'http');
    const r = mod.request(u, { method: 'HEAD', timeout: 10000, headers: { 'User-Agent': 'LiveCity-DataPipeline/0.1 (metadata HEAD check)' } }, (res) => { resolve({ url, status: res.statusCode }); res.resume(); });
    r.on('timeout', () => { r.destroy(); resolve({ url, error: 'timeout' }); });
    r.on('error', (e) => resolve({ url, error: e.code || 'error' }));
    r.end();
  });
}
async function sources(online) {
  const entries = [
    { id: 'plateau-site-policy', url: 'https://www.mlit.go.jp/plateau/site-policy/', scope: 'general site policy (not dataset-specific)' },
    { id: 'osm-copyright', url: 'https://www.openstreetmap.org/copyright', scope: 'ODbL 1.0 + attribution "© OpenStreetMap contributors"' },
    { id: 'plateau-osaka-2024', url: 'https://www.geospatial.jp/ckan/dataset/plateau-27100-osaka-shi-2024', scope: 'dataset-specific terms: MUST be read per dataset (some Osaka datasets, e.g. Expo 2025 site, carry different terms)' },
  ];
  const results = [];
  for (const e of entries) results.push(Object.assign({}, e, online ? await head(e.url) : { status: 'not-checked (offline)' }, { licenceApproved: false, evidenceOfTermsRead: false }));
  return { schema: 'livecity.mission43.sources/1', online: !!online, note: 'HEAD only (reachability). Reachability is not a licence approval; licenceApproved stays false until terms are read and recorded by a human.', results };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const has = (k) => rest.includes('--' + k);
  const opt = (k) => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    if (cmd === 'manifest') {
      const m = buildManifest();
      if (has('write')) { fs.mkdirSync(REPORT_DIR, { recursive: true }); fs.writeFileSync(path.join(REPORT_DIR, 'ward-migration-manifest.json'), JSON.stringify(m, null, 2) + '\n'); }
      console.log(JSON.stringify({ summary: m.summary, gates: m.gates, transferredNow: m.transferredNow }, null, 1));
    } else if (cmd === 'rebuild') {
      if (!opt('ward') || !opt('out')) throw new Error('--ward and --out required');
      console.log(JSON.stringify(rebuild(opt('ward'), opt('out')), null, 1));
    } else if (cmd === 'verify') {
      const r = verifyDir(opt('dir') || ''); console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : 1);
    } else if (cmd === 'preflight') {
      if (!opt('src')) throw new Error('--src required');
      console.log(JSON.stringify(preflight(opt('src'), opt('gates')), null, 1));
    } else if (cmd === 'inspect') {
      const r = inspect(opt('src')); console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : 1);
    } else if (cmd === 'sources') {
      const r = await sources(has('online'));
      if (has('write')) { fs.mkdirSync(REPORT_DIR, { recursive: true }); fs.writeFileSync(path.join(REPORT_DIR, 'sources-check.json'), JSON.stringify(r, null, 2) + '\n'); }
      console.log(JSON.stringify(r, null, 1));
    } else { console.error('usage: manifest | rebuild | verify | preflight | inspect | sources'); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(e.code || 1); }
}
module.exports = { buildManifest, verifyDir, rebuild, preflight, inspect, sources };
if (require.main === module) main();
