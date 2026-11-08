#!/usr/bin/env node
// Mission 141: ONE command -> the canonical Live City page (mission37g-osaka-24ward-mvp.html) on localhost with every available ward switchable.
//   node tools/mission141-local-24.mjs [--port 8137] [--root temp/mission141/data] [--no-fetch] [--check-only] [--wards a,b]
// Data sources (kept separate, nothing is renamed or renumbered):
//   - nishi   : existing local PLATEAU 2025 output (temp/mission81|80|79, the one `mission81-local-preview.mjs --ward nishi` made). Never re-downloaded here.
//   - 21 wards: private release livecity-3d-data / plateau2025-converted (plateau2025-<ward>.tar.gz), fetched with the USER'S OWN existing `gh` login
//               (read-only: `gh release view` / `gh release download`). No token is asked for, stored, or printed. If gh cannot see the release,
//               that ward is reported as "not delivered" and the page shows it without a 3D layer.
//   - fukushima / yodogawa: not in the release; served only if a valid local output already exists (same candidate dirs as nishi). Otherwise "not delivered".
// Safety: archives are listed before extraction (absolute / ".." / link entries -> rejected); extracted into <root>/<ward>-work then moved to <root>/<ward>-2025
// (an existing non-empty target is never overwritten); archives are deleted after extraction; everything lives under git-ignored temp/ (OneDrive roots refused).
// The server is the Mission 81 read-only loopback server (127.0.0.1, GET/HEAD only). Nothing is uploaded, committed, or published.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makeServer, candidateDirs, validateOutput, HOST, EXPO_CODE } from './mission81-local-preview.mjs';

const require = createRequire(import.meta.url);
const LAYOUT = require('./mission131/layout.cjs');
export const DATA_REPO = 'masamasa26346497-eng/livecity-3d-data';
export const TAG = 'plateau2025-converted';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'mission37g-osaka-24ward-mvp.html';

export const loadWards = (root = ROOT) => JSON.parse(fs.readFileSync(path.join(root, 'public/mission37g-data/osaka-24-wards.json'), 'utf8')).wards;

// Archive member names must be plain relative paths with no "..", no drive letters, no leading slash.
export function unsafeEntries(names) {
  return names.filter((n) => !n || /^([a-zA-Z]:|[\\/])/.test(n) || n.split(/[\\/]/).includes('..') || /[\0]/.test(n));
}
export function underSync(p, env = process.env) {
  const roots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial, env.USERPROFILE && path.join(env.USERPROFILE, 'OneDrive')].filter(Boolean).map((x) => path.resolve(x).toLowerCase() + path.sep);
  const q = path.resolve(p).toLowerCase() + path.sep;
  return roots.some((r) => q.startsWith(r));
}
// Light per-ward validity: tileset.json parses, ids sidecars exist and are bldg_* strings without duplicates (g_* LOD sidecars skipped), source.json wardCode (if present) matches.
export function checkWardDir(dir, ward) {
  const errs = [];
  try { JSON.parse(fs.readFileSync(path.join(dir, 'tileset.json'), 'utf8')); } catch { errs.push('tileset.json unparseable'); }
  let ids = 0; const seen = new Set();
  let files = []; try { files = fs.readdirSync(path.join(dir, 'ids')).filter((f) => /^t_.*\.json$/.test(f)); } catch { errs.push('no ids/'); }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'ids', f), 'utf8'));
      for (const x of (Array.isArray(j) ? j : (j.ids || []))) { if (typeof x !== 'string' || !x.startsWith('bldg_')) { errs.push('bad id'); break; } seen.add(x); ids++; }
    } catch { errs.push('ids ' + f + ' unparseable'); }
  }
  if (!ids) errs.push('no building ids');
  if (seen.size !== ids) errs.push('duplicate ids inside ward');
  try {
    const src = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
    if (src.wardCode != null && String(src.wardCode) === EXPO_CODE) errs.push('Expo 27999');
    if (src.wardCode != null && String(src.wardCode) !== String(ward.wardCode)) errs.push('wardCode ' + src.wardCode + ' != ' + ward.wardCode);
  } catch { /* source.json optional for archive layouts; the page falls back to the N03 mapping */ }
  return { ok: errs.length === 0, errs, buildings: ids };
}

// Resolve every ward to a servable dir. Pure over the filesystem; never downloads.
export function resolveWards({ root, dataRoot, wards, only, local }) {
  const rows = [], map = {};
  for (const w of wards) {
    if (String(w.wardCode) === EXPO_CODE) continue;
    if (only && !only.includes(w.wardId)) continue;
    let dir = null, origin = null, note = null;
    // Mission 142: explicit --local <ward>=<dir> (e.g. an existing fukushima / yodogawa output). Validated like any other; never copied or modified.
    if (local && local[w.wardId]) {
      const d = path.resolve(local[w.wardId]);
      if (fs.existsSync(path.join(d, 'tileset.json'))) { dir = d; origin = 'local-input'; } else note = '--local dir has no tileset.json: ' + d;
    }
    const extracted = dir ? null : LAYOUT.discoverWard(dataRoot, w.wardId);
    if (extracted && extracted.dir) { dir = extracted.dir; origin = 'private-release'; }
    if (!dir) {
      for (const d of candidateDirs(w.wardId, root)) {
        if (fs.existsSync(path.join(d, 'tileset.json'))) { const v = validateOutput(d, w); if (v.ok) { dir = d; origin = 'local-2025'; break; } note = 'invalid local output: ' + v.errs.join('; '); }
      }
    }
    if (dir) {
      const c = checkWardDir(dir, w);
      if (c.ok) { map[w.wardId + '25'] = dir; rows.push({ ward: w.wardId, wardCode: w.wardCode, status: 'served', origin, buildings: c.buildings }); continue; }
      note = c.errs.join('; ');
    }
    rows.push({ ward: w.wardId, wardCode: w.wardCode, status: 'not-delivered', origin: null, note: note || 'no tileset found' });
  }
  return { rows, map };
}

// Mission 142: parse "--local a=DIR,b=DIR". Windows drive letters contain ":" but never "=", and "," separates entries, so a path with "," must be passed alone.
export function parseLocal(str) {
  const out = {};
  if (!str) return out;
  for (const part of String(str).split(',')) {
    const i = part.indexOf('=');
    if (i <= 0 || i === part.length - 1) throw new Error('--local expects ward=dir[,ward=dir]; got "' + part + '"');
    const k = part.slice(0, i).trim();
    if (!/^[a-z0-9-]+$/.test(k)) throw new Error('--local: bad ward id "' + k + '"');
    out[k] = part.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return out;
}
// Mission 142: Mission115/45I road+water output (<layersRoot>/<ward>/layers/*.json) for the wards that are served. Presence is reported; nothing is created.
// Mission 143: a ward is "layers" only when a layer file parses AND holds real features; a report/status file alone never makes it ready.
// roads / waterways / water-surface are counted separately.
export const LAYER_NAMES = ['roads', 'waterways', 'water-surface', 'parks', 'railways'];
export function countLayerFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { parsed: true, features: Array.isArray(j.features) ? j.features.length : 0 };
  } catch (e) { return { parsed: false, features: 0 }; }
}
export function resolveLayers({ layersRoot, map }) {
  const layers = {}, rows = [];
  for (const key of Object.keys(map)) {
    const ward = key.replace(/25$/, '');
    const d = layersRoot ? path.join(layersRoot, ward, 'layers') : null;
    const counts = {};
    if (d) for (const f of LAYER_NAMES) {
      const fp = path.join(d, f + '.json');
      if (fs.existsSync(fp)) counts[f] = countLayerFile(fp);
    }
    const files = Object.keys(counts).filter((f) => counts[f].parsed && counts[f].features > 0);
    const ok = files.length > 0;
    if (ok) layers[key] = d;
    const bad = Object.keys(counts).filter((f) => !counts[f].parsed);
    let note = ok ? '' : !d ? 'no layers root' : Object.keys(counts).length ? 'layer files empty or unparseable' : 'no road/river data for this ward';
    if (bad.length) note += (note ? '; ' : '') + 'unparseable: ' + bad.join(',');
    const has = (f) => !!counts[f] && counts[f].features > 0;
    rows.push({ ward, key, status: ok ? 'layers' : 'no-layers', files, counts, note, roads: has('roads'), waterways: has('waterways'), waterSurface: has('water-surface') });
  }
  return { layers, rows };
}
// Mission 143: read-only discovery of an existing converted layers root / the old OSM map-data. Only candidates that really exist are returned.
const hasWardLayers = (root) => { try { return fs.readdirSync(root).some((w) => fs.existsSync(path.join(root, w, 'layers', 'roads.json'))); } catch (e) { return false; } };
export function layersRootCandidates(env = process.env, home = env.USERPROFILE || env.HOME || '') {
  const c = [];
  if (env.LIVECITY_LAYERS_ROOT) c.push(env.LIVECITY_LAYERS_ROOT);
  if (env.LOCALAPPDATA) c.push(path.join(env.LOCALAPPDATA, 'LiveCity-MapLayers-Out-24'));
  if (home) c.push(path.join(home, 'LiveCity-MapLayers-Out-24'), path.join(home, 'AppData', 'Local', 'LiveCity-MapLayers-Out-24'));
  c.push(path.join(path.dirname(ROOT), 'LiveCity-MapLayers-Out-24'));
  return [...new Set(c.map((x) => path.resolve(x)))];
}
export function oldSourceCandidates(env = process.env, home = env.USERPROFILE || env.HOME || '') {
  const rel = path.join('public', 'map-data', 'osaka-city');
  const c = [];
  if (env.LIVECITY_OLD_MAPDATA) c.push(env.LIVECITY_OLD_MAPDATA);
  c.push(path.join(path.dirname(ROOT), 'livecity-data-pipeline', rel));
  if (home) c.push(path.join(home, 'livecity-data-pipeline', rel), path.join(home, 'Documents', 'livecity-data-pipeline', rel));
  return [...new Set(c.map((x) => path.resolve(x)))];
}
export const discoverLayersRoot = (opts = {}) => layersRootCandidates(opts.env, opts.home).find((d) => fs.existsSync(d) && hasWardLayers(d)) || null;
export const discoverOldSource = (opts = {}) => oldSourceCandidates(opts.env, opts.home).find((d) => fs.existsSync(path.join(d, 'roads')) || fs.existsSync(path.join(d, 'waterways'))) || null;
// Build through the Mission115 builder: new files only (existing ward layers/ are skipped); it refuses output inside the repo or OneDrive.
export function buildLayers({ src, out }) {
  return execFileSync(process.execPath, [path.join(ROOT, 'tools', 'mission115', 'layers-run.cjs'), 'build', '--src', src, '--layers-root', out, '--wards', 'ALL'], { encoding: 'utf8', maxBuffer: 1 << 28 });
}
// Windows file handles (AV / indexer) can briefly block rename/rm right after extraction; retry a few times.
function retry(fn, tries = 8) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= tries || !/^(EPERM|EBUSY|EACCES|ENOTEMPTY)$/.test(e.code || '')) throw e;
      const t = Date.now() + 150 * (i + 1); while (Date.now() < t) { /* brief spin; no sleep API in sync code */ }
    }
  }
}

function gh(args, opts = {}) { return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }

function fetchWard(w, dataRoot, assets) {
  const name = 'plateau2025-' + w.wardId + '.tar.gz';
  if (!assets.has(name)) return 'asset not in release';
  const work = path.join(dataRoot, w.wardId + '-work');
  const final = path.join(dataRoot, w.wardId + '25');
  if (fs.existsSync(final) && fs.readdirSync(final).length) return 'already present';
  // Mission 142: a leftover "<ward>-work" can only be a partial download/extract made by this tool (its name is fixed and it sits directly under the
  // data root), so it is removed and retried instead of making the Windows user delete it by hand. The finished "<ward>25" dir is never touched.
  if (fs.existsSync(work)) { try { retry(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })); } catch (e) { return 'stale work dir cannot be removed (' + e.code + '): close programs using ' + work; } }
  fs.mkdirSync(work, { recursive: true });
  const arc = path.join(work, name);
  try {
    gh(['release', 'download', TAG, '-R', DATA_REPO, '-p', name, '-D', work]);
    // tar runs with cwd=work and RELATIVE names: a drive letter in -f ("C:\...") is read as host:path by GNU tar, and long absolute paths hit MAX_PATH sooner.
    const list = execFileSync('tar', ['-tzf', name], { cwd: work, encoding: 'utf8', maxBuffer: 1 << 28 }).split(/\r?\n/).filter(Boolean);
    const bad = unsafeEntries(list);
    if (bad.length) throw new Error('unsafe archive entries (' + bad.length + ')');
    if (!list.some((n) => /(^|\/)tileset\.json$/.test(n))) throw new Error('no tileset.json in archive');
    const ex = path.join(work, 'x'); fs.mkdirSync(ex);
    execFileSync('tar', ['-xzf', '../' + name, '-C', '.'], { cwd: ex, stdio: 'ignore', maxBuffer: 1 << 26 });
    fs.rmSync(arc, { force: true });
    const found = LAYOUT.discoverWard(ex, w.wardId) || (LAYOUT.findTilesetDirs(ex).length === 1 ? { dir: LAYOUT.findTilesetDirs(ex)[0] } : null);
    if (!found || !found.dir) throw new Error('cannot locate the ward tileset inside the archive');
    if (fs.existsSync(final)) fs.rmdirSync(final); // succeeds only when empty; never overwrites content
    retry(() => fs.renameSync(found.dir, final));
    retry(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
    return 'fetched';
  } catch (e) {
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* reported by the next run */ }
    return 'failed: ' + String(e.message || e).split('\n')[0].slice(0, 140);
  }
}

async function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  if (a.includes('--host') || a.includes('--bind')) throw new Error('binding is fixed to 127.0.0.1');
  const port = Number(opt('port', 8137));
  const dataRoot = path.resolve(ROOT, opt('root', path.join('temp', 'mission141', 'data')));
  if (underSync(dataRoot)) throw new Error('data root is inside a OneDrive sync root; refusing (use the default under temp/)');
  const only = opt('wards') ? opt('wards').split(',') : null;
  const wards = loadWards();
  if (only) { const bad = only.filter((x) => !wards.some((w) => w.wardId === x)); if (bad.length) throw new Error('unknown ward id in --wards: ' + bad.join(',')); }
  const local = parseLocal(opt('local'));
  for (const k of Object.keys(local)) if (!wards.some((w) => w.wardId === k)) throw new Error('unknown ward id in --local: ' + k);
  let layersRoot = opt('layers-root') ? path.resolve(opt('layers-root')) : null;
  if (layersRoot && !fs.existsSync(layersRoot)) throw new Error('--layers-root not found: ' + layersRoot);
  // Mission 143: no argument needed. An existing converted root is auto-connected; --build-layers makes a missing one from the old OSM data (new files only).
  let layersOrigin = layersRoot ? 'explicit' : null;
  if (!layersRoot && !a.includes('--no-layers')) {
    const found = discoverLayersRoot();
    if (found) { layersRoot = found; layersOrigin = 'auto-detected'; }
    else if (a.includes('--build-layers')) {
      const src = opt('src') ? path.resolve(opt('src')) : discoverOldSource();
      if (!src || !fs.existsSync(src)) console.warn('[143] --build-layers: old OSM map-data not found. Re-run with: --build-layers --src "<path>\\public\\map-data\\osaka-city"');
      else {
        const out = path.resolve(opt('layers-out', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'LiveCity-MapLayers-Out-24') : path.join(ROOT, '..', 'LiveCity-MapLayers-Out-24')));
        console.log('[143] building road/river layers: ' + src + ' -> ' + out + ' (new files only; source is read-only)');
        try { buildLayers({ src, out }); layersRoot = out; layersOrigin = 'built'; } catch (e) { console.warn('[143] layer build failed: ' + String(e.stderr || e.message).split('\n')[0].slice(0, 200)); }
      }
    } else console.log('[143] no converted road/river layers found. Add --build-layers (auto-finds ..\\livecity-data-pipeline) or --layers-root <dir>.');
  }
  if (dataRoot.length > 120) console.warn('[141] data root path is ' + dataRoot.length + ' chars; Windows MAX_PATH (260) can break extraction. Use a short --root such as C:\\lc141.');
  fs.mkdirSync(dataRoot, { recursive: true });

  if (!a.includes('--no-fetch') && !a.includes('--check-only')) {
    let assets = null;
    try {
      const j = JSON.parse(gh(['release', 'view', TAG, '-R', DATA_REPO, '--json', 'assets']));
      assets = new Set((j.assets || []).map((x) => x.name));
      console.log('[141] release visible with your gh login: ' + assets.size + ' assets');
    } catch (e) {
      console.warn('[141] cannot read the private release with your gh login (' + String(e.stderr || e.message).split('\n')[0].slice(0, 120) + '). Run `gh auth status`; continuing with local data only.');
    }
    if (assets) for (const w of wards) {
      if (String(w.wardCode) === EXPO_CODE || (only && !only.includes(w.wardId))) continue;
      if (LAYOUT.discoverWard(dataRoot, w.wardId)) continue;
      console.log('[141] ' + w.wardId + ': ' + fetchWard(w, dataRoot, assets));
    }
  }

  const { rows, map } = resolveWards({ root: ROOT, dataRoot, wards, only, local });
  const served = rows.filter((r) => r.status === 'served');
  const lay = resolveLayers({ layersRoot, map });
  console.log('[141] 3D delivered (local, private): ' + served.length + '/' + rows.length + ' wards, ' + served.reduce((s, r) => s + r.buildings, 0) + ' buildings');
  for (const r of rows) console.log('  ' + r.wardCode + ' ' + r.ward + ' ' + (r.status === 'served' ? r.buildings + ' (' + r.origin + ')' : 'NOT DELIVERED: ' + r.note));
  console.log('[141] roads/rivers (Mission115 output, local only, ' + (layersOrigin || 'none') + (layersRoot ? ': ' + layersRoot : '') + '): ' + (layersRoot ? Object.keys(lay.layers).length + '/' + lay.rows.length + ' served wards have layers' : 'none'));
  if (layersRoot) {
    const n = (k) => lay.rows.filter((r) => r[k]).length;
    console.log('[143] data present: roads ' + n('roads') + ' wards / waterways ' + n('waterways') + ' wards / water-surface ' + n('waterSurface') + ' wards (browser rendering NOT verified by this tool)');
    for (const r of lay.rows) console.log('  ' + r.ward + ' ' + (r.status === 'layers' ? LAYER_NAMES.filter((f) => r.counts[f]).map((f) => f + '=' + r.counts[f].features).join(' ') : 'NO LAYERS (' + r.note + '; nothing drawn, nothing invented)'));
  }
  const missing = rows.filter((r) => r.status !== 'served').map((r) => r.ward);
  if (missing.length) console.log('[141] NOT DELIVERED (' + missing.length + '): ' + missing.join(', '));
  console.log('[141] note: coverage is per-ward converted data, not proof of whole-ward completeness; roads/rivers are separate and not implied.');
  if (!served.length) throw new Error('nothing to serve');
  if (a.includes('--check-only')) return;
  const srv = makeServer({ publicDir: path.join(ROOT, 'public'), wards: map, layers: lay.layers });
  srv.on('error', (e) => { console.error('FAILED server: ' + e.message + (e.code === 'EADDRINUSE' ? ' (try --port 8138)' : '')); process.exit(1); });
  srv.listen(port, HOST, () => {
    console.log('[141] serving read-only on loopback only. Ctrl+C to stop.');
    console.log('[141] open: http://' + HOST + ':' + port + '/' + PAGE + '?nobuiltin=1&ext45=1   (pick a ward in the left "3D buildings ward" selector)');
  });
  process.on('SIGINT', () => { console.log('\n[141] stopped. ' + JSON.stringify(srv.lcStats)); srv.close(); process.exit(0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
}
