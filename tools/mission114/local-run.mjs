#!/usr/bin/env node
// Mission 114: owner-PC, read-only, INCREMENTAL 24-ward viewer for the private PLATEAU 2025 release.
//   $env:LIVECITY_3D_DATA_TOKEN = Read-Host "token"      (fine-grained, read-only, repo livecity-3d-data only)
//   node tools\mission114\local-run.mjs --wards nishi,fukushima,yodogawa     (Mission108 trio; same data layout)
//   node tools\mission114\local-run.mjs --wards ALL                          (only wards not yet in --root are downloaded)
//   node tools\mission114\local-run.mjs --reuse --wards ALL                  (no token, no download; serves what exists)
// Already-present wards are never touched. New wards are fetched+verified (Mission109 verifier) into a fresh staging dir,
// then each verified <ward>25 dir is MOVED into root only if absent. Nothing is deleted or overwritten. Token reaches the fetch child only.
// Data lives under temp/mission114 (git-ignored). Buildings = 2025 private archives only; no pc23 / legacy local files are read.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseWards, planBatches } from '../mission109/wards.mjs';

const a = process.argv.slice(2);
const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(opt('root', 'temp/mission114/root'));
const port = String(Number(opt('port', 8137)));
const batch = Number(opt('batch', 4));

let wards;
try { wards = parseWards(opt('wards', 'nishi,fukushima,yodogawa')); } catch (e) { console.error('FAIL: ' + e.message); process.exit(64); }

const hasTileset = (w) => fs.existsSync(path.join(root, w + '25', 'tileset.json'));
const have = wards.filter(hasTileset);
const missing = wards.filter((w) => !hasTileset(w));
const plan = { root, requested: wards.length, present: have, missing, batches: planBatches(missing, batch) };
if (a.includes('--dry-run')) { console.log(JSON.stringify(plan)); process.exit(0); }
fs.mkdirSync(root, { recursive: true });

if (missing.length && !a.includes('--reuse')) {
  if (!process.env.LIVECITY_3D_DATA_TOKEN) { console.error('FAIL: LIVECITY_3D_DATA_TOKEN missing (needed only for wards not yet downloaded: ' + missing.join(',') + '). Use --reuse to serve existing wards.'); process.exit(3); }
  const fv = path.join(here, '..', 'mission109', 'fetch-verify.mjs');
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '');
  const failed = [];
  for (const [i, grp] of plan.batches.entries()) {
    const stage = path.join(path.dirname(root), 'stage-' + stamp + '-' + i);
    const summary = path.join(path.dirname(root), 'fetch-summary-' + stamp + '-' + i + '.json');
    console.log('batch ' + (i + 1) + '/' + plan.batches.length + ': ' + grp.join(','));
    const r = spawnSync(process.execPath, [fv, '--wards', grp.join(','), '--dest', stage, '--summary', summary], { stdio: 'inherit', env: process.env });
    let sum = null; try { sum = JSON.parse(fs.readFileSync(summary, 'utf8')); } catch { /* summary missing -> treat all as failed */ }
    for (const w of grp) {
      const ok = sum && sum.wards && sum.wards[w] && sum.wards[w].status === 'verified';
      const src = path.join(stage, w + '25'), dst = path.join(root, w + '25');
      if (ok && fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst);
      else { failed.push(w); }
    }
    if (r.status !== 0) console.error('note: batch ' + (i + 1) + ' reported failures; verified wards in it were still kept. Staging left at ' + stage + ' (not deleted).');
  }
  if (failed.length) console.error('WARN: not available (not served): ' + failed.join(',') + ' - re-run with --wards ' + failed.join(','));
}

const served = wards.filter(hasTileset);
if (!served.length) { console.error('FAIL: no verified ward data under ' + root + '; nothing to serve.'); process.exit(2); }
const cleanEnv = { ...process.env };
delete cleanEnv.LIVECITY_3D_DATA_TOKEN;
const serve = path.join(here, '..', 'mission40f-serve-local.cjs');
if (!fs.existsSync(serve)) { console.error('FAIL: server script not found: ' + serve); process.exit(3); }
const url = 'http://127.0.0.1:' + port + '/mission37g-osaka-24ward-mvp.html?ext=' + served.map((w) => w + '25').join(',');
console.log('Serving ' + served.length + '/' + wards.length + ' ward(s), 127.0.0.1 only.\nOpen: ' + url + '\nRoads/water: 2025 archives carry no layers; orange road-edge / blue water exist only in fixed windows (see data/reports/mission114/layer-coverage.json).');
const child = spawn(process.execPath, [serve, '--ext', root, '--port', port], { stdio: 'inherit', env: cleanEnv });
child.on('error', (e) => { console.error('FAIL: could not start server: ' + e.message); process.exit(1); });
child.on('exit', (c, sig) => process.exit(c || (sig ? 1 : 0)));
