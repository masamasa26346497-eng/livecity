#!/usr/bin/env node
// Mission 108: ONE command for the owner PC. Fetch (read-only) + verify the stored 2025 archives, then serve them on 127.0.0.1 only.
//   PowerShell:  $env:LIVECITY_3D_DATA_TOKEN = Read-Host "token"   (fine-grained, read-only, repo livecity-3d-data only)
//                node tools\mission108\local-run.mjs --wards nishi,fukushima,yodogawa
//   Reuse after the first run (no token, no download):  node tools\mission108\local-run.mjs --reuse
// Token is passed ONLY to the fetch child process; the server child gets an environment without it, and the browser never sees it.
// Data goes to temp/mission108/root (git-ignored). Nothing is uploaded, nothing is written under public/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';

const a = process.argv.slice(2);
const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const root = path.resolve(opt('root', 'temp/mission108/root'));
const port = String(Number(opt('port', 8137)));
// fileURLToPath decodes percent-escapes (non-ASCII, spaces, %) and handles drive letters / UNC correctly.
const here = path.dirname(fileURLToPath(import.meta.url));
if (!a.includes('--reuse')) {
  const wards = L.validateWards((opt('wards', 'nishi,fukushima,yodogawa')).split(',').filter(Boolean));
  if (fs.existsSync(root) && fs.readdirSync(root).length) { console.error('FAIL: ' + root + ' is not empty. Use --reuse, or pass a new --root. (Nothing is overwritten or deleted.)'); process.exit(2); }
  const r = spawnSync(process.execPath, [path.join(here, 'fetch-verify.mjs'), '--wards', wards.join(','), '--dest', root, '--summary', path.join(path.dirname(root), 'fetch-summary.json')], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) { console.error('FAIL: fetch/verify did not pass; nothing is served.'); process.exit(r.status || 1); }
}
if (a.includes('--reuse')) {
  // Read-only presence check; never creates, deletes or overwrites anything.
  const wards = L.validateWards((opt('wards', 'nishi,fukushima,yodogawa')).split(',').filter(Boolean));
  const hasTileset = (d) => {
    try {
      if (fs.existsSync(path.join(d, 'tileset.json'))) return true;
      return fs.readdirSync(d, { withFileTypes: true }).some((e) => e.isDirectory() && fs.existsSync(path.join(d, e.name, 'tileset.json')));
    } catch { return false; }
  };
  const missing = wards.filter((w) => !hasTileset(path.join(root, w + '25')));
  if (missing.length) {
    console.error('FAIL: --reuse needs existing data, but tileset.json is missing for: ' + missing.map((w) => w + '25').join(', ') + '\n  looked under: ' + root + '\n  Run once without --reuse (needs the read-only token) to fetch. Nothing was changed.');
    process.exit(2);
  }
}
const cleanEnv = { ...process.env };
delete cleanEnv.LIVECITY_3D_DATA_TOKEN;
const serve = path.join(here, '..', 'mission40f-serve-local.cjs');
if (a.includes('--dry-run')) { console.log(JSON.stringify({ here, serve, root, port })); process.exit(0); }
if (!fs.existsSync(serve)) { console.error('FAIL: server script not found: ' + serve); process.exit(3); }
const child = spawn(process.execPath, [serve, '--ext', root, '--port', port], { stdio: 'inherit', env: cleanEnv });
console.log('Switch ward: left panel "3D buildings ward" selector (Nishi / Fukushima / Yodogawa). Ctrl+C stops the server.');
child.on('error', (e) => { console.error('FAIL: could not start server: ' + e.message); process.exit(1); });
child.on('exit', (c, sig) => process.exit(c || (sig ? 1 : 0)));
