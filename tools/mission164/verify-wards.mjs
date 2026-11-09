#!/usr/bin/env node
// Mission 164: strict served+browser verification for several wards, one summary line each (records progress).
//   node tools/mission164/verify-wards.mjs chuo,kita,sumiyoshi [--root temp/mission156]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wards = (process.argv[2] || '').split(',').filter(Boolean);
const i = process.argv.indexOf('--root');
const root = i > 0 ? process.argv[i + 1] : 'temp/mission156';
let bad = 0;
for (const w of wards) {
  const p = spawnSync(process.execPath, [path.join(here, '..', 'mission156-verify-served.mjs'), '--dir', path.join(root, w, 'tiles'), '--ward', w, '--chrome', '--record'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  try {
    const r = JSON.parse(p.stdout);
    const b = r.browser || {};
    console.log(w, JSON.stringify({ uris: r.uris, non200: r.non200.length, regionOk: r.regionOk, tileLoad: b.tileLoadEvents, tileVisible: b.tileVisibleEvents, pixelDiff: b.pixelDiff, jsErrors: (b.jsErrors || []).length, browserOk: r.browserOk }));
    if (!r.browserOk) bad++;
  } catch { console.log(w, 'unparsed', String(p.stderr).slice(0, 200)); bad++; }
}
process.exit(bad ? 1 : 0);
