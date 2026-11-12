#!/usr/bin/env node
'use strict';
// Mission 159: READ-ONLY per-ward audit for the 24 N03 wards (no network, no conversion, no writes except optional NEW --out/--md files).
//   node tools/mission159/ward-audit.cjs [--local DIR] [--accept REPORT.json] [--out NEW.json] [--md NEW.md]
// Layers:
//   A. Git-only (always): N03 polygon integrity + per-ward evidence ledger (M140 CI log, M80 manifest). Nothing is inferred.
//   B. --local DIR (a 3D Tiles output root): reuses mission130/accept-lib (loadWardData/insideWard) and mission131/layout (discoverWard)
//      to check building rep points vs the ward's N03 polygon, attrs/ids consistency, sentinel heights, cross-ward duplicate ids.
//      Data check only: headless/fixture results are NOT owner-PC browser acceptance.
//   C. --accept REPORT.json: classify click-id-mismatch from a Mission130 report row that recorded click.reason. Otherwise "unclassified".
const fs = require('fs');
const path = require('path');
const L = require('../mission130/accept-lib.cjs');
const LAYOUT = require('../mission131/layout.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const rj = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const tryRj = (p) => { try { return rj(p); } catch (e) { return null; } };
const CLAT = 34.604208, CLON = 135.525020, MPD = 111320; // existing geoToThree constants, unchanged
const toLonLat = (x, z) => ({ lat: CLAT - z / MPD, lon: CLON + x / (MPD * Math.cos(CLAT * Math.PI / 180)) });
const SENTINELS = new Set([29997, 29999, 30000]);

function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]); return Math.abs(a / 2); }

/** A. N03 polygon integrity from the two tracked files. */
function n03Integrity(w, ref) {
  const issues = [];
  const rings = [];
  for (const p of w.polygons || []) { rings.push(p.outer); for (const h of p.holes || []) rings.push(h); }
  if (!rings.length) issues.push('no-polygons');
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, bad = 0;
  for (const r of rings) {
    if (r.length < 4) issues.push('ring<4');
    for (const [x, z] of r) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) { bad++; continue; }
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  if (bad) issues.push('non-finite:' + bad);
  const b = w.bbox || {}, tol = 1;
  if (!(b.minX <= minX + tol && b.maxX >= maxX - tol && b.minZ <= minZ + tol && b.maxZ >= maxZ - tol)) issues.push('bbox-does-not-cover-vertices');
  if (ref) {
    if (String(ref.wardCode) !== String(w.wardCode)) issues.push('wardCode-mismatch-between-files');
    const rb = ref.bbox || {};
    if (['minX', 'maxX', 'minZ', 'maxZ'].some((k) => !(Math.abs(rb[k] - b[k]) <= 1))) issues.push('bbox-differs-between-files');
  } else issues.push('missing-in-osaka-24-wards.json');
  const c = toLonLat((minX + maxX) / 2, (minZ + maxZ) / 2);
  if (!(c.lat > 34.4 && c.lat < 34.85 && c.lon > 135.3 && c.lon < 135.7)) issues.push('center-outside-osaka-extent');
  const area = (w.polygons || []).reduce((s, p) => s + ringArea(p.outer) - (p.holes || []).reduce((t, h) => t + ringArea(h), 0), 0);
  if (!(area > 1e5)) issues.push('area-implausible');
  return { ok: issues.length === 0, issues, areaKm2: +(area / 1e6).toFixed(2), centerLonLat: { lat: +c.lat.toFixed(4), lon: +c.lon.toFixed(4) }, polygons: (w.polygons || []).length };
}

/** Git-only evidence ledger for one ward. Anything not in a tracked file is null. */
function evidence(wardId, ctx) {
  const m140 = ctx.m140 && ctx.m140.wards.find((r) => r[0] === wardId);
  const mb = ctx.m80 && ctx.m80.wards && ctx.m80.wards[wardId];
  return {
    m140CiLog: m140 ? { glb200: m140[1], pixelDiffPct: m140[2], click: m140[3], coverage: m140[4], verdict: m140[5], scope: 'headless software GL on a CI runner, private release assets; NOT the owner PC' } : null,
    m80Runner: mb ? { status: mb.status, buildings: mb.buildings || null, error: mb.error ? String(mb.error).slice(0, 60) : null } : null,
    knownGap: ['nishi', 'fukushima', 'yodogawa'].includes(wardId) ? 'not in the M140 21-ward set' : null,
  };
}

/** C. Classify click-id-mismatch strictly from a recorded reason. */
function classifyClick(row) {
  const c = row && row.click;
  if (!c) return { cls: 'unclassified', why: 'no click record: the M140 log row only has id-ok/FAIL; the sub-reason was added to accept21 after that run' };
  if (c.selected === c.target) return { cls: 'none', why: 'selected id equals target' };
  if (c.reason === 'no-screen-point-picks-target') return { cls: 'pick-geometry', why: 'no scanned screen point had scene.pick == target (occlusion, LOD group or camera framing); id data not implicated' };
  if (c.reason === 'selected-other-id') return { cls: 'overlap-or-duplicate-id', why: 'a click selected a different id (' + c.selected + '); check overlapping footprints and cross-ward duplicate ids' };
  if (c.reason === 'click-did-not-select') return { cls: 'input-or-render', why: 'target pickable but click selected nothing (event handling or render not settled)' };
  return { cls: 'unclassified', why: 'reason=' + c.reason };
}

/** B. Directory check for one ward (owner-PC data or fixture). */
function localWard(w, found, allWards) {
  const d = L.loadWardData(found.dir);
  const ids = d.ids, byId = d.byId, keys = Object.keys(byId);
  let inOwn = 0, inBbox = 0, inOther = 0, sentinel = 0, nonFinite = 0; const otherWards = {};
  for (const k of keys) {
    const v = byId[k], x = v[2], z = v[3];
    if (SENTINELS.has(v[0])) sentinel++;
    if (!Number.isFinite(x) || !Number.isFinite(z)) { nonFinite++; continue; }
    if (x >= w.bbox.minX && x <= w.bbox.maxX && z >= w.bbox.minZ && z <= w.bbox.maxZ) inBbox++;
    if (L.insideWard(w, x, z)) inOwn++;
    else for (const o of allWards) if (o.wardId !== w.wardId && L.insideWard(o, x, z)) { inOther++; otherWards[o.wardId] = (otherWards[o.wardId] || 0) + 1; break; }
  }
  const idsNotInAttrs = [...ids].filter((i) => !(i in byId)).length;
  const attrsNotInIds = keys.filter((k) => !ids.has(k)).length;
  const pct = (n) => (keys.length ? +(100 * n / keys.length).toFixed(2) : null);
  const srcCode = d.source && d.source.wardCode != null ? String(d.source.wardCode) : null;
  const flags = [];
  if (!keys.length) flags.push('no-attrs-points');
  if (srcCode && srcCode !== String(w.wardCode)) flags.push('source.wardCode!=N03:' + srcCode);
  if (keys.length && pct(inOwn) < 90) flags.push('rep-points-mostly-outside-own-N03');
  if (idsNotInAttrs || attrsNotInIds) flags.push('ids-attrs-mismatch');
  if (d.dup) flags.push('dup-ids-inside-ward:' + d.dup);
  if (sentinel) flags.push('height-sentinel:' + sentinel);
  return { dir: found.rel, ids: ids.size, attrs: keys.length, repInsideOwnN03Pct: pct(inOwn), repInsideBboxPct: pct(inBbox), repInsideOtherWardN03: inOther, otherWards, nonFiniteRep: nonFinite, idsNotInAttrs, attrsNotInIds, sentinelHeights: sentinel, sourceWardCode: srcCode, flags, _ids: ids };
}

function build(opts) {
  opts = opts || {};
  const polys = rj('data/processed/osaka-city/boundaries/ward-classification-polygons.json').wards;
  const ref = Object.fromEntries(rj('public/mission37g-data/osaka-24-wards.json').wards.map((w) => [w.wardId, w]));
  const ctx = { m140: tryRj('data/reports/mission140/run42438843605-acceptance.json'), m80: tryRj('data/reports/mission80/batch-manifest.json') };
  const accept = opts.accept && Array.isArray(opts.accept.rows) ? opts.accept.rows : [];
  const dirs = opts.local ? LAYOUT.findTilesetDirs(opts.local) : null;
  const sorted = polys.slice().sort((a, b) => String(a.wardCode).localeCompare(String(b.wardCode)));
  const rows = sorted.map((w) => {
    const r = { wardId: w.wardId, wardCode: String(w.wardCode), n03: n03Integrity(w, ref[w.wardId]), evidence: evidence(w.wardId, ctx) };
    const ar = accept.find((x) => x.ward === w.wardId);
    r.clickClass = ar ? classifyClick(ar) : (r.evidence.m140CiLog && r.evidence.m140CiLog.click === 'FAIL' ? classifyClick(null) : null);
    if (opts.local) {
      const found = LAYOUT.discoverWard(opts.local, w.wardId, dirs);
      r.local = found && found.dir ? localWard(w, found, sorted) : { state: found ? 'ambiguous-layout' : 'not-found-under-local-root' };
    } else r.local = { state: 'unverified (--local not given; owner-PC data is not visible from Git)' };
    return r;
  });
  const seen = new Map(), pairs = {};
  for (const r of rows) if (r.local && r.local._ids) for (const id of r.local._ids) {
    if (seen.has(id)) { const k = seen.get(id) + '|' + r.wardId; pairs[k] = (pairs[k] || 0) + 1; } else seen.set(id, r.wardId);
  }
  for (const r of rows) if (r.local && r.local._ids) {
    r.local.idsInCrossWardDup = Object.entries(pairs).filter(([k]) => k.split('|').includes(r.wardId)).reduce((s, [, n]) => s + n, 0);
    delete r.local._ids;
  }
  const checked = rows.filter((r) => r.local && r.local.ids != null);
  const summary = {
    wards: rows.length,
    n03Ok: rows.filter((r) => r.n03.ok).length,
    n03Issues: rows.filter((r) => !r.n03.ok).map((r) => r.wardId + ':' + r.n03.issues.join('+')),
    localChecked: checked.length,
    localFlagged: checked.filter((r) => r.local.flags.length).map((r) => r.wardId + ':' + r.local.flags.join('+')),
    localNotChecked: rows.filter((r) => !(r.local && r.local.ids != null)).map((r) => r.wardId),
    crossWardDupPairs: pairs,
    clickMismatch: rows.filter((r) => r.clickClass).map((r) => r.wardId + ':' + r.clickClass.cls),
    noEvidenceInGit: rows.filter((r) => !r.evidence.m140CiLog && !r.evidence.m80Runner).map((r) => r.wardId),
    browserAcceptedByThisTool: 0,
    note: 'This tool never claims browser acceptance. M140 = headless software GL on a CI runner; local/fixture dirs are data checks only. 24/24 is not established.',
  };
  return { schema: 'livecity.mission159.ward-audit/1', mode: opts.local ? 'git+local' : 'git-only', summary, rows };
}

function toMd(r) {
  const out = ['# Mission 159 ward audit (read-only)', '', '| ward | N03 | M140 CI log | M80 runner | local | click class |', '|---|---|---|---|---|---|'];
  for (const x of r.rows) {
    const loc = x.local.ids != null ? (x.local.flags.length ? 'FLAGS ' + x.local.flags.join('+') : 'ok own-N03 ' + x.local.repInsideOwnN03Pct + '%') : 'unverified';
    out.push(['', x.wardId, x.n03.ok ? 'ok ' + x.n03.areaKm2 + 'km2' : 'ISSUE ' + x.n03.issues.join('+'), x.evidence.m140CiLog ? x.evidence.m140CiLog.verdict : 'none', x.evidence.m80Runner ? x.evidence.m80Runner.status : 'none', loc, x.clickClass ? x.clickClass.cls : '-', ''].join(' | ').trim());
  }
  return out.join('\n') + '\n\n```json\n' + JSON.stringify(r.summary, null, 1) + '\n```\n';
}

if (require.main === module) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : null; };
  const accept = opt('accept') ? JSON.parse(fs.readFileSync(opt('accept'), 'utf8')) : null;
  const r = build({ local: opt('local'), accept });
  for (const [k, body] of [['out', JSON.stringify(r, null, 1)], ['md', toMd(r)]]) {
    const p = opt(k); if (!p) continue;
    if (fs.existsSync(p)) { console.error('refusing to overwrite ' + p); process.exit(2); }
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true }); fs.writeFileSync(p, body, { flag: 'wx' });
  }
  console.log(JSON.stringify(r.summary, null, 1));
}
module.exports = { build, toMd, classifyClick, n03Integrity, localWard };
