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
export function resolveWards({ root, dataRoot, wards, only }) {
  const rows = [], map = {};
  for (const w of wards) {
    if (String(w.wardCode) === EXPO_CODE) continue;
    if (only && !only.includes(w.wardId)) continue;
    let dir = null, origin = null, note = null;
    const extracted = LAYOUT.discoverWard(dataRoot, w.wardId);
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

function gh(args, opts = {}) { return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }

function fetchWard(w, dataRoot, assets) {
  const name = 'plateau2025-' + w.wardId + '.tar.gz';
  if (!assets.has(name)) return 'asset not in release';
  const work = path.join(dataRoot, w.wardId + '-work');
  const final = path.join(dataRoot, w.wardId + '25');
  if (fs.existsSync(final) && fs.readdirSync(final).length) return 'already present';
  if (fs.existsSync(work)) return 'stale work dir (delete ' + path.relative(ROOT, work) + ' yourself and re-run)';
  fs.mkdirSync(work, { recursive: true });
  const arc = path.join(work, name);
  try {
    gh(['release', 'download', TAG, '-R', DATA_REPO, '-p', name, '-D', work]);
    const list = execFileSync('tar', ['-tzf', arc], { encoding: 'utf8', maxBuffer: 1 << 28 }).split(/\r?\n/).filter(Boolean);
    const bad = unsafeEntries(list);
    if (bad.length) throw new Error('unsafe archive entries (' + bad.length + ')');
    if (!list.some((n) => /(^|\/)tileset\.json$/.test(n))) throw new Error('no tileset.json in archive');
    const ex = path.join(work, 'x'); fs.mkdirSync(ex);
    execFileSync('tar', ['-xzf', arc, '-C', ex], { stdio: 'ignore', maxBuffer: 1 << 26 });
    fs.rmSync(arc, { force: true });
    const found = LAYOUT.discoverWard(ex, w.wardId) || (LAYOUT.findTilesetDirs(ex).length === 1 ? { dir: LAYOUT.findTilesetDirs(ex)[0] } : null);
    if (!found || !found.dir) throw new Error('cannot locate the ward tileset inside the archive');
    if (fs.existsSync(final)) fs.rmdirSync(final); // succeeds only when empty; never overwrites content
    fs.renameSync(found.dir, final);
    fs.rmSync(work, { recursive: true, force: true });
    return 'fetched';
  } catch (e) {
    fs.rmSync(work, { recursive: true, force: true });
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

  const { rows, map } = resolveWards({ root: ROOT, dataRoot, wards, only });
  const served = rows.filter((r) => r.status === 'served');
  console.log('[141] 3D delivered (local, private): ' + served.length + '/' + rows.length + ' wards, ' + served.reduce((s, r) => s + r.buildings, 0) + ' buildings');
  for (const r of rows) console.log('  ' + r.wardCode + ' ' + r.ward + ' ' + (r.status === 'served' ? r.buildings + ' (' + r.origin + ')' : 'NOT DELIVERED: ' + r.note));
  console.log('[141] note: coverage is per-ward converted data, not proof of whole-ward completeness; roads/rivers are separate and not implied.');
  if (!served.length) throw new Error('nothing to serve');
  if (a.includes('--check-only')) return;
  const srv = makeServer({ publicDir: path.join(ROOT, 'public'), wards: map });
  srv.on('error', (e) => { console.error('FAILED server: ' + e.message + (e.code === 'EADDRINUSE' ? ' (try --port 8138)' : '')); process.exit(1); });
  srv.listen(port, HOST, () => {
    console.log('[141] serving read-only on loopback only. Ctrl+C to stop.');
    console.log('[141] open: http://' + HOST + ':' + port + '/' + PAGE + '?nobuiltin=1&ext45=1   (pick a ward in the left "3D buildings ward" selector)');
  });
  process.on('SIGINT', () => { srv.close(); process.exit(0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
}
