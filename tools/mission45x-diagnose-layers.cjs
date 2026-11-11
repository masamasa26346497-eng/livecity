#!/usr/bin/env node
'use strict';
// [Mission 45X] READ-ONLY coverage diagnosis of a 45I layers root. Anonymous: prints ward ids, file presence and counts only.
//   node tools/mission45x-diagnose-layers.cjs --layers-root <dir> [--out <report.json>]
// Never writes inside the layers root, never regenerates, never prints a path, coordinate or feature id, never uses the network.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MARKER = '.livecity-45i-layers.json';
const FILES = ['roads', 'waterways', 'parks', 'railways'];
const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };

function diagnose(layersRoot, registry) {
  const R = { schema: 'livecity.mission45x.diagnose/1', markerOk: false, wards: [], summary: {} };
  const d = path.resolve(layersRoot), st = lst(d);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) { R.error = 'layers-root missing or not a real directory'; return R; }
  try { R.markerOk = JSON.parse(fs.readFileSync(path.join(d, MARKER), 'utf8')).schema === 'livecity.mission45i.layers/1'; } catch (e) { /* marker missing */ }
  const indexWards = [];
  for (const w of registry) {
    const ld = path.join(d, w.id, 'layers');
    const row = { ward: w.id, wardCode: w.code, status: 'not-delivered', files: {}, counts: {}, problems: [] };
    if (!lst(ld)) { R.wards.push(row); continue; }
    const rep = lst(path.join(ld, 'layers-report.json'));
    row.files['layers-report'] = !!rep;
    for (const f of FILES.concat(['labels'])) row.files[f] = !!lst(path.join(ld, f + '.json'));
    let report = null;
    if (rep) { try { report = JSON.parse(fs.readFileSync(path.join(ld, 'layers-report.json'), 'utf8')); } catch (e) { row.problems.push('layers-report unreadable'); } }
    if (report && report.wardCode !== undefined && String(report.wardCode) !== String(w.code)) row.problems.push('layers-report wardCode mismatch');
    for (const f of FILES) {
      const rl = report && report.layers && report.layers[f];
      if (!row.files[f]) { if (rl && rl.status === 'ok' && rl.features > 0) row.problems.push(f + ' listed ok in report but file missing'); continue; }
      try {
        const j = JSON.parse(fs.readFileSync(path.join(ld, f + '.json'), 'utf8'));
        const n = Array.isArray(j.features) ? j.features.length : -1;
        row.counts[f] = n;
        if (n < 0) row.problems.push(f + ' has no features array');
        else if (j.count !== undefined && j.count !== n) row.problems.push(f + ' count header != features');
        if (rl && rl.features !== undefined && rl.features !== n) row.problems.push(f + ' report count != file');
        if (j.coordinateConvention && j.coordinateConvention !== 'znorth-neg-v1') row.problems.push(f + ' unexpected coordinate convention');
      } catch (e) { row.problems.push(f + ' unreadable'); }
    }
    row.servedByIndex = !!rep;   // 45E lists a ward in index.json layersWards only when layers-report.json exists
    if (rep) indexWards.push(w.id);
    const drawable = (row.counts.roads | 0) + (row.counts.waterways | 0);
    row.status = !rep ? 'incomplete-no-report' : row.problems.length ? 'has-problems' : drawable > 0 ? 'ok' : 'ok-but-no-road-or-water-features';
    R.wards.push(row);
  }
  const by = (s) => R.wards.filter((r) => r.status === s).length;
  R.summary = { wards: R.wards.length, notDelivered: by('not-delivered'), ok: by('ok'), okButEmpty: by('ok-but-no-road-or-water-features'), withProblems: by('has-problems'), incompleteNoReport: by('incomplete-no-report'), indexLayersWards: indexWards.length };
  return R;
}
module.exports = { diagnose };

if (require.main === module) {
  const a = process.argv.slice(2);
  const get = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  const root = get('--layers-root'), out = get('--out');
  if (!root) { console.error('usage: --layers-root <dir> [--out <report.json>]'); process.exit(2); }
  if (out && (path.resolve(out) + path.sep).startsWith(path.resolve(root) + path.sep)) { console.error('--out must not be inside the layers root'); process.exit(2); }
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
  const R = diagnose(root, registry);
  if (R.error) { console.error(R.error); process.exit(3); }
  console.log('marker ok: ' + R.markerOk);
  for (const r of R.wards) console.log(r.ward.padEnd(14) + r.status.padEnd(34) + FILES.map((f) => f[0] + '=' + (r.counts[f] === undefined ? '-' : r.counts[f])).join(' ') + (r.problems.length ? '  !' + r.problems.join('; ') : ''));
  console.log(JSON.stringify(R.summary));
  if (out) fs.writeFileSync(out, JSON.stringify(R, null, 1));
  process.exit(R.summary.withProblems || R.summary.incompleteNoReport ? 1 : 0);
}
