#!/usr/bin/env node
'use strict';
// Mission 45C: per-ward source-vs-converted(-vs-rendered) coverage, machine-checked. READ-ONLY (writes nothing unless --out).
//   node tools/mission45c-coverage.cjs --src <legacy buildings dir> --converted <dir of one converted ward | 43F out-root> --ward <id>
//        [--rendered <rendered.json>] [--kind real|synthetic|git-tracked-partial] [--out <file>]
// source    = canonical ids in <src>/osaka-<ward>/tile_*.json
// converted = canonical ids in <converted>/ids/t_*.json   (a 43F out-root resolves to status.json's attempt dir of --ward)
// rendered  = optional browser result {tilesets, mountedBuildings, http200, pixelsChanged, clickedIdVerified, peakResidentWards}
// Output = counts / booleans only (no paths, no ids). Compatible with the 45B evidence schema (livecity.mission45b.ward-evidence/1)
// but never claims "real" evidence by itself: --kind defaults to synthetic. Nothing is uploaded; gates stay false.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = 'livecity.mission45c.coverage/1';
const GATES = Object.freeze({ licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false, uploadAllowed: 0 });
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const registry = () => readJson(path.join(ROOT, 'config/wards/registry.json')).wards;
const err = (m, c) => Object.assign(new Error(m), { code: c });

function sourceIds(src, wardId) {
  const d = path.join(path.resolve(src), 'osaka-' + wardId);
  if (!fs.existsSync(d)) throw err('source-ward-dir-missing', 3);
  const ids = []; let tiles = 0;
  for (const f of fs.readdirSync(d).filter((n) => /^tile_.*\.json$/.test(n))) {
    tiles++;
    for (const b of readJson(path.join(d, f)).buildings || []) ids.push(String(b.id));
  }
  return { ids, tiles };
}

function resolveConvertedDir(p, wardId) {
  const d = path.resolve(p);
  if (fs.existsSync(path.join(d, 'ids'))) return d;
  const sp = path.join(d, 'status.json');
  if (fs.existsSync(sp)) {
    const e = (readJson(sp).wards || {})[wardId];
    if (e && e.state === 'ok' && Number.isInteger(e.attempt)) {
      const a = path.join(d, wardId + '-a' + e.attempt);
      if (fs.existsSync(path.join(a, 'ids'))) return a;
    }
  }
  const direct = path.join(d, wardId);
  if (fs.existsSync(path.join(direct, 'ids'))) return direct;
  throw err('converted-ward-dir-not-found', 3);
}

function convertedIds(dir) {
  const ids = []; let tiles = 0;
  for (const f of fs.readdirSync(path.join(dir, 'ids')).filter((n) => /^t_.*\.json$/.test(n))) {
    tiles++;
    const a = readJson(path.join(dir, 'ids', f));
    for (const id of (Array.isArray(a) ? a : a.ids || [])) ids.push(String(id));
  }
  return { ids, tiles };
}

function compute(opts) {
  const w = registry().find((x) => x.id === opts.ward);
  if (!w) throw err('unknown-ward', 2);
  const s = sourceIds(opts.src, w.id);
  const c = convertedIds(resolveConvertedDir(opts.converted, w.id));
  const sset = new Set(s.ids), cset = new Set(c.ids);
  let missing = 0, extra = 0;
  for (const id of sset) if (!cset.has(id)) missing++;
  for (const id of cset) if (!sset.has(id)) extra++;
  const dupSource = s.ids.length - sset.size, dupConverted = c.ids.length - cset.size;
  const convertedCoverage = s.ids.length === 0 ? 'none' : (missing === 0 && extra === 0 && dupConverted === 0 && c.tiles === s.tiles ? 'full' : (cset.size > 0 ? 'partial' : 'none'));
  const r = opts.rendered || null;
  const rendered = r ? {
    tilesets: Number(r.tilesets) || 0, mountedBuildings: Number(r.mountedBuildings) || 0,
    http200: r.http200 === true, pixelsChanged: r.pixelsChanged === true, clickedIdVerified: r.clickedIdVerified === true,
    peakResidentWards: Number(r.peakResidentWards) || 0,
  } : null;
  // rendered coverage = what the browser actually mounted vs the source (never inferred from the converted files alone)
  const renderedCoverage = !rendered ? 'not-measured' : (rendered.mountedBuildings === s.ids.length && s.ids.length > 0 ? 'full' : (rendered.mountedBuildings > 0 ? 'partial' : 'none'));
  const kind = opts.kind || 'synthetic';
  if (!['real', 'synthetic', 'git-tracked-partial'].includes(kind)) throw err('bad-kind', 2);
  const out = {
    schema: SCHEMA, readOnly: true, uploaded: 0, published: false, gates: GATES,
    ward: w.id, wardCode: w.code, kind,
    source: { buildings: s.ids.length, uniqueIds: sset.size, tiles: s.tiles, duplicateIds: dupSource },
    converted: { buildings: c.ids.length, uniqueIds: cset.size, tiles: c.tiles, duplicateIds: dupConverted, missingVsSource: missing, extraVsSource: extra },
    convertedCoverage, rendered, renderedCoverage,
    // 45B evidence row (accepted by 45B only when kind==='real' and every flag below is true and coverage is full)
    evidence: {
      code: w.code, kind, convertedBuildings: cset.size, convertedTiles: c.tiles,
      realSourceVerified: convertedCoverage === 'full' && kind === 'real',
      http200: !!(rendered && rendered.http200), webglPixelsChanged: !!(rendered && rendered.pixelsChanged),
      clickedBuildingIdVerified: !!(rendered && rendered.clickedIdVerified),
      peakResidentWards: rendered ? Math.max(1, rendered.peakResidentWards) : 1,
    },
    ok: convertedCoverage === 'full' && (!rendered || renderedCoverage === 'full'),
    note: 'Counts only. A full coverage here is not licence/privacy/publication approval.',
  };
  if (/[A-Za-z]:\\|\/(?:home|Users|tmp)\/|https?:\/\//.test(JSON.stringify(out))) throw err('output-not-anonymous', 1);
  return out;
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const rendered = opt('rendered') ? readJson(opt('rendered')) : null;
    const r = compute({ src: opt('src'), converted: opt('converted'), ward: opt('ward'), kind: opt('kind'), rendered });
    if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify(r, null, 1), { flag: 'wx' });
    console.log(JSON.stringify(r, null, 1));
    process.exit(r.ok ? 0 : 3);
  } catch (e) {
    const own = Number.isInteger(e.code);
    console.error(own ? e.message : 'error: operation failed (details suppressed)');
    process.exit(own ? e.code : 1);
  }
}
module.exports = { compute, sourceIds, convertedIds, resolveConvertedDir, SCHEMA, GATES };
if (require.main === module) main();
