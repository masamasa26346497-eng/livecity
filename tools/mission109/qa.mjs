#!/usr/bin/env node
// Mission 109: headless-Chrome QA over verified archives for any subset of the 24 wards. Reuses Mission108 qaWard (127.0.0.1 only).
//   node tools/mission109/qa.mjs --root <dir with <ward>25/> --wards ALL|a,b --summary <qa-summary.json> [--port 8188]
// One ward failing never stops the others. Counts/booleans only; acceptance is always false (headless software rendering, CI origin).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qaWard } from '../mission108/qa.mjs';
import { detectOrigin } from '../mission88-collect-evidence.mjs';
import { parseWards } from './wards.mjs';

async function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const wards = parseWards(opt('wards', ''));
  const root = path.resolve(opt('root', ''));
  const summaryPath = path.resolve(opt('summary', 'mission109-qa-summary.json'));
  const polys = JSON.parse(fs.readFileSync('data/processed/osaka-city/boundaries/ward-classification-polygons.json', 'utf8'));
  const summary = { mission: 109, kind: 'private-2025-headless-qa', origin: detectOrigin().origin, acceptance: false, note: 'headless software rendering; counts/booleans only; not acceptance, not a device value', requested: wards, wards: {} };
  let n = 0;
  for (const w of wards) {
    if (!fs.existsSync(path.join(root, w + '25', 'tileset.json'))) { summary.wards[w] = { ward: w, status: 'skipped-not-fetched' }; continue; }
    try { summary.wards[w] = await qaWard({ ward: w, root, polys, port: Number(opt('port', 8188)) + n++ }); }
    catch (e) { summary.wards[w] = { ward: w, status: 'error', error: String((e && e.message) || e).slice(0, 200) }; }
  }
  summary.passWards = wards.filter((w) => summary.wards[w].status === 'pass');
  summary.failWards = wards.filter((w) => summary.wards[w].status !== 'pass');
  summary.allPass = summary.failWards.length === 0;
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 1));
  console.log(JSON.stringify({ allPass: summary.allPass, pass: summary.passWards, notPass: summary.failWards }));
  process.exitCode = summary.allPass ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error('FAILED', String(e && e.message).slice(0, 200)); process.exit(1); });
