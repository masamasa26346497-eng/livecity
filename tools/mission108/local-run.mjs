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
import * as L from './lib.mjs';

const a = process.argv.slice(2);
const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const root = path.resolve(opt('root', 'temp/mission108/root'));
const port = String(Number(opt('port', 8137)));
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (!a.includes('--reuse')) {
  const wards = L.validateWards((opt('wards', 'nishi,fukushima,yodogawa')).split(',').filter(Boolean));
  if (fs.existsSync(root) && fs.readdirSync(root).length) { console.error('FAIL: ' + root + ' is not empty. Use --reuse, or pass a new --root. (Nothing is overwritten or deleted.)'); process.exit(2); }
  const r = spawnSync(process.execPath, [path.join(here, 'fetch-verify.mjs'), '--wards', wards.join(','), '--dest', root, '--summary', path.join(path.dirname(root), 'fetch-summary.json')], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) { console.error('FAIL: fetch/verify did not pass; nothing is served.'); process.exit(r.status || 1); }
}
const cleanEnv = { ...process.env };
delete cleanEnv.LIVECITY_3D_DATA_TOKEN;
const serve = path.join(here, '..', 'mission40f-serve-local.cjs');
const child = spawn(process.execPath, [serve, '--ext', root, '--port', port], { stdio: 'inherit', env: cleanEnv });
console.log('Switch ward: left panel "3D buildings ward" selector (Nishi / Fukushima / Yodogawa). Ctrl+C stops the server.');
child.on('exit', (c) => process.exit(c || 0));
