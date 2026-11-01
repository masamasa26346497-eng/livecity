#!/usr/bin/env node
// Mission 81: PLATEAU 2025 (v5) ward 3D Tiles -> one-command localhost preview (Cesium 37G page).
//   node tools/mission81-local-preview.mjs --ward nishi [--port 8137] [--max-mb 800] [--min-free-gb 3] [--no-fetch] [--check-only]
// Safety defaults:
//   - binds 127.0.0.1 only (no option to change); GET/HEAD only; no directory listing; path traversal rejected.
//   - output lives under temp/ (git-ignored). public/, 2022/2024 data and IDs are never written.
//   - an existing valid 2025 output (temp/mission81, temp/mission80, temp/mission79) is reused as-is.
//   - otherwise: source-lock verified (ETag/vintage/license/URL host) -> mission79-run.mjs (Range fetch + non-destructive conversion).
//     Download/inflated size is capped (--max-mb) and free disk is checked first. Any failure stops; nothing is half-served.
//   - Expo 2025 (27999) / unknown wards / unknown license are refused.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const { resolveUnder } = require('./mission40f-serve-local.cjs');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon' };
export const EXPECTED_HOST = 'assets.cms.plateau.reearth.io';
export const EXPO_CODE = '27999';
export const HOST = '127.0.0.1';

export function candidateDirs(wardId, root = ROOT) {
  return [path.join('temp', 'mission81', 'out', wardId + '-2025'), path.join('temp', 'mission80', 'out', wardId + '-2025'), path.join('temp', 'mission79', wardId + '-2025')]
    .map((p) => path.resolve(root, p));
}

// Source lock must be an official PLATEAU Osaka (27100) 2025 v5 CityGML package with a pinned ETag and the PLATEAU license.
export function checkLock(lock) {
  const errs = [];
  let host = '';
  try { host = new URL(lock.resource && lock.resource.url).hostname; } catch { /* noop */ }
  if (host !== EXPECTED_HOST) errs.push('source host not ' + EXPECTED_HOST + ': ' + host);
  if (!/plateau-27100-osaka-shi-2025/.test(lock.package && lock.package.name || '')) errs.push('package is not plateau-27100-osaka-shi-2025');
  if (!(lock.http && lock.http.etag)) errs.push('no pinned ETag');
  if (!(lock.license && lock.license.id === 'plateau' && /mlit\.go\.jp\/plateau\/site-policy/.test(lock.license.url || ''))) errs.push('license is not the PLATEAU site policy');
  if (!/Project PLATEAU/.test(lock.attribution || '')) errs.push('attribution missing');
  if (/27999|expo/i.test(JSON.stringify(lock.package || {}))) errs.push('lock refers to Expo (27999)');
  return errs;
}

// A finished output must be a 2025 build of exactly this ward with consistent building counts.
export function validateOutput(dir, ward) {
  const errs = [];
  const need = ['tileset.json', 'source.json', 'build-report.json'];
  for (const f of need) if (!fs.existsSync(path.join(dir, f))) errs.push('missing ' + f);
  for (const d of ['ids', 'attrs']) if (!fs.existsSync(path.join(dir, d))) errs.push('missing ' + d + '/');
  if (errs.length) return { ok: false, errs };
  const src = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
  const rep = JSON.parse(fs.readFileSync(path.join(dir, 'build-report.json'), 'utf8'));
  if (String(src.wardCode) === EXPO_CODE) errs.push('wardCode is Expo 27999');
  if (String(src.wardCode) !== String(ward.wardCode)) errs.push('wardCode ' + src.wardCode + ' != ' + ward.wardCode);
  if (Number(src.vintage) !== 2025) errs.push('vintage ' + src.vintage + ' != 2025');
  if (!/PLATEAU/.test(String(src.attribution || ''))) errs.push('no PLATEAU attribution in source.json');
  let host = ''; try { host = new URL(src.source).hostname; } catch { /* noop */ }
  if (host !== EXPECTED_HOST) errs.push('source host ' + host);
  const ids = [];
  for (const f of fs.readdirSync(path.join(dir, 'ids')).filter((n) => /^t_.*\.json$/.test(n))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'ids', f), 'utf8')); for (const x of (Array.isArray(j) ? j : (j.ids || []))) ids.push(x);
  }
  const total = rep.totals && rep.totals.buildings;
  if (!(total > 0)) errs.push('no buildings in build-report');
  if (ids.length !== total) errs.push('ids ' + ids.length + ' != report ' + total);
  if (new Set(ids).size !== ids.length) errs.push('duplicate ids');
  return { ok: errs.length === 0, errs, buildings: total, ids: ids.length, tiles: (rep.totals && rep.totals.tiles) ?? null, etag: src.sourceEtag };
}

// Tile prefix /ext-3dtiles/<name>/... -> <outDir>/..., everything else -> public/. Read-only, loopback.
// Mission 82: `wards` = { <name>: <outDir> } serves many wards (/ext-3dtiles/<name>/...) plus a generated /ext-3dtiles/index.json (used by ?ext45=1).
export function makeServer({ publicDir, outDir, name, wards }) {
  const pub = path.resolve(publicDir);
  const map = wards ? Object.fromEntries(Object.entries(wards).map(([k, v]) => [k, path.resolve(v)])) : { [name]: path.resolve(outDir) };
  const indexBody = JSON.stringify({ verified: false, vintage: 2025, wards: Object.keys(map).sort().map((k) => ({ ward: k })) });
  const stats = { req: 0, ok: 0, nf: 0, glb200: 0, tileset200: 0 };
  const srv = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }
    stats.req++;
    const u = (req.url || '/').split('?')[0];
    let file;
    if (u === '/ext-3dtiles/index.json') { stats.ok++; res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); return res.end(req.method === 'HEAD' ? undefined : indexBody); }
    const m = /^\/ext-3dtiles\/([a-z0-9-]+)\/(.*)$/.exec(u);
    if (m && Object.prototype.hasOwnProperty.call(map, m[1])) file = resolveUnder(map[m[1]], m[2]);
    else if (u.startsWith('/ext-3dtiles/')) file = null; // only registered wards are served
    else file = resolveUnder(pub, u === '/' ? '/mission37g-osaka-24ward-mvp.html' : u);
    if (!file) { stats.nf++; res.writeHead(404); return res.end('not found'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { stats.nf++; res.writeHead(404); return res.end('not found'); }
      stats.ok++; if (file.endsWith('.glb')) stats.glb200++; if (path.basename(file) === 'tileset.json') stats.tileset200++;
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
  srv.lcStats = stats;
  return srv;
}
export const previewUrl = (port, name) => 'http://' + HOST + ':' + port + '/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext=' + name;

function freeBytes(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

// Mission 82: --ward all -> serve every already-converted, validated 2025 ward found under temp/ (never downloads; convert with tools/mission80-batch.mjs).
async function mainAll(a, opt) {
  const port = Number(opt('port', 8137));
  const polys = JSON.parse(fs.readFileSync('data/processed/osaka-city/boundaries/ward-classification-polygons.json', 'utf8'));
  const wards = {}; const rows = [];
  for (const w of polys.wards) {
    if (String(w.wardCode) === EXPO_CODE) continue;
    let found = null;
    for (const d of candidateDirs(w.wardId)) {
      if (!fs.existsSync(path.join(d, 'tileset.json'))) continue;
      const v = validateOutput(d, w);
      if (v.ok) { found = { d, v }; break; }
    }
    if (found) { wards[w.wardId + '25'] = found.d; rows.push(w.wardCode + ' ' + w.wardId + ' ' + found.v.buildings); } else rows.push(w.wardCode + ' ' + w.wardId + ' (not converted)');
  }
  console.log('[82] wards available: ' + Object.keys(wards).length + '/' + polys.wards.length + '\n' + rows.join('\n'));
  if (!Object.keys(wards).length) throw new Error('no converted wards. Run: node tools/mission80-batch.mjs');
  if (a.includes('--check-only')) return;
  const srv = makeServer({ publicDir: path.join(ROOT, 'public'), wards });
  srv.on('error', (e) => { console.error('FAILED server: ' + e.message); process.exit(1); });
  srv.listen(port, HOST, () => {
    console.log('[82] serving read-only on loopback only. Ctrl+C to stop.');
    console.log('[82] open: http://' + HOST + ':' + port + '/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1   (pick a ward in the 3D ward selector)');
  });
  process.on('SIGINT', () => { srv.close(); process.exit(0); });
}

async function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const wardId = opt('ward', 'nishi');
  if (wardId === 'all') return mainAll(a, opt);
  const port = Number(opt('port', 8137)), maxMb = Number(opt('max-mb', 800)), minFreeGb = Number(opt('min-free-gb', 3));
  if (a.includes('--host') || a.includes('--bind')) throw new Error('binding is fixed to 127.0.0.1; --host/--bind are not supported');
  if (!/^[a-z0-9-]+$/.test(wardId)) throw new Error('bad --ward');
  const polys = JSON.parse(fs.readFileSync('data/processed/osaka-city/boundaries/ward-classification-polygons.json', 'utf8'));
  const ward = polys.wards.find((w) => w.wardId === wardId);
  if (!ward) throw new Error('unknown ward ' + wardId);
  if (String(ward.wardCode) === EXPO_CODE) throw new Error('Expo 2025 (27999) is refused');
  const name = wardId + '25';

  let outDir = null;
  for (const d of candidateDirs(wardId)) {
    if (!fs.existsSync(path.join(d, 'tileset.json'))) continue;
    const v = validateOutput(d, ward);
    if (v.ok) { outDir = d; console.log('[81] reuse existing output: ' + path.relative(ROOT, d) + ' (' + v.buildings + ' buildings)'); break; }
    console.warn('[81] ignoring invalid output ' + path.relative(ROOT, d) + ': ' + v.errs.join('; '));
  }
  if (!outDir) {
    if (a.includes('--no-fetch')) throw new Error('no valid 2025 output found and --no-fetch given. Run without --no-fetch to download+convert.');
    const lock = JSON.parse(fs.readFileSync('data/reports/mission79/source-lock.json', 'utf8'));
    const le = checkLock(lock);
    if (le.length) throw new Error('source lock rejected: ' + le.join('; '));
    const sel = execFileSync(process.execPath, ['tools/mission79-run.mjs', '--ward', wardId, '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
    const plan = JSON.parse(sel.split('[79 run] plan ')[1].split('\n')[0]);
    console.log('[81] plan: ' + plan.meshes + ' meshes, ' + plan.files + ' files, download ~' + plan.compressedMB + 'MB, inflated ~' + plan.inflatedMB + 'MB (limit ' + maxMb + 'MB)');
    if (plan.inflatedMB > maxMb) throw new Error('inflated size exceeds --max-mb ' + maxMb);
    const free = freeBytes(path.join(ROOT, 'temp'));
    const need = (plan.inflatedMB * 1.5 + 300) * 1048576;
    if (free != null && (free < minFreeGb * 1073741824 || free < need)) throw new Error('not enough free disk: ' + (free / 1073741824).toFixed(1) + 'GB free');
    if (a.includes('--check-only')) { console.log('[81] check-only: lock OK, plan OK, disk OK. Nothing downloaded.'); return; }
    const work = path.join('temp', 'mission81', 'work', wardId), final = path.join('temp', 'mission81', 'out', wardId + '-2025');
    if (fs.existsSync(final) && fs.readdirSync(final).length) throw new Error('refusing to overwrite non-empty ' + final);
    try {
      execFileSync(process.execPath, ['tools/mission79-run.mjs', '--ward', wardId, '--max-mb', String(maxMb), '--work', work, '--final', final], { cwd: ROOT, stdio: 'inherit', maxBuffer: 1 << 28 });
    } catch (e) {
      // only our own temp/mission81 paths are cleaned
      fs.rmSync(path.resolve(ROOT, final), { recursive: true, force: true });
      throw new Error('download/convert failed; nothing is served (' + e.message.slice(0, 120) + ')');
    }
    fs.rmSync(path.resolve(ROOT, work), { recursive: true, force: true });
    const v = validateOutput(path.resolve(ROOT, final), ward);
    if (!v.ok) throw new Error('converted output invalid: ' + v.errs.join('; '));
    outDir = path.resolve(ROOT, final);
  }
  if (a.includes('--check-only')) { console.log('[81] check-only: output OK, not serving.'); return; }
  const srv = makeServer({ publicDir: path.join(ROOT, 'public'), outDir, name });
  srv.on('error', (e) => { console.error('FAILED server: ' + e.message + (e.code === 'EADDRINUSE' ? ' (try --port 8138)' : '')); process.exit(1); });
  srv.listen(port, HOST, () => {
    console.log('[81] serving read-only on loopback only. Press Ctrl+C to stop.');
    console.log('[81] open: ' + previewUrl(port, name));
    console.log('[81] top-down: drag with the right mouse / use the 3D controls; click a building to see its canonicalId.');
  });
  process.on('SIGINT', () => { console.log('\n[81] stopped. ' + JSON.stringify(srv.lcStats)); srv.close(); process.exit(0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
}
