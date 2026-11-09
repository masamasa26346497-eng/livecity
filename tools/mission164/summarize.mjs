#!/usr/bin/env node
// Mission 164: run diag-run for a tiles dir + camera and print a one-line summary.
//   node tools/mission164/summarize.mjs <tilesDir> <view|far|set>
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = execFileSync('node', [path.join(here, 'diag-run.mjs'), process.argv[2], process.argv[3] || 'view'], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 200000 });
const r = JSON.parse(out);
const s = { cam: process.argv[3], vis: r.vis, ld: r.ld, pixelDiff: r.pixelDiff, pixelTotal: r.pixelTotal, centerOnScreen: r.centerOnScreen, glbReq: r.serverRequests && r.serverRequests.glb, jsErrors: r.jsErrors, status: r.status };
console.log(JSON.stringify(s));
