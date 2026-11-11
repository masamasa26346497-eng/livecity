#!/usr/bin/env node
'use strict';
// Mission 43D: 24-ward audit / plan / batch-run orchestration. Offline. Reuses mission43 (inspect, manifest, rebuild, regress, verify)
// and mission43b (plan); nothing is re-implemented here.
//   node tools/mission43d-ward-batch.cjs audit --src <legacy buildings dir> [--write <file.json>]
//   node tools/mission43d-ward-batch.cjs batch-plan [--inspect inspect.json] [--audit audit.json]
//   node tools/mission43d-ward-batch.cjs run --wards a,b|all-tracked --out-root <NEW dir outside repo> [--execute]
// Never uploads, packs, publishes or deletes. Gates stay false. Output contains ward ids, counts and issue kinds only
// (no paths, no building ids, no values). `run` defaults to dry-run; only Git-tracked legacy tiles are ever read.
const fs = require('fs');
const path = require('path');
const T = require('./mission43-ward-rebuild.cjs');
const A = require('./mission43b-audit.cjs');

const ROOT = path.resolve(__dirname, '..');
const GATES = { licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false, uploadAllowed: 0 };
const BYTES_PER_BUILDING = 1164; // measured: Sumiyoshi 52 tiles = 40,788,694 B / 35,031 buildings (43C regress). Estimate only.
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const reg = () => readJson(path.join(ROOT, 'config/wards/registry.json')).wards;

function assertAnonymous(obj) {
  const s = JSON.stringify(obj);
  if (/[A-Za-z]:\\|\/home\/|\/Users\/|\/tmp\/|OneDrive|bldg_[0-9a-f]{8}/.test(s)) throw new Error('refusing: output would contain a path or an id');
  return obj;
}
const kind = (m) => String(m).replace(/:.*$/, '').trim();

// ---- audit (read-only). Reuses T.inspect; adds per-ward wardCode check + a per-ward verdict.
function audit(src) {
  const safeFail = (why) => assertAnonymous({ schema: 'livecity.mission43d.audit/1', readOnly: true, ready: false, fatal: why, wards: {}, gates: GATES, note: 'Counts and issue kinds only.' });
  if (!src) return safeFail('src-missing');
  let insp;
  try { insp = T.inspect(src); } catch (e) { return safeFail(/not found/.test(e.message) ? 'src-not-a-directory' : 'inspect-failed'); }
  const R = reg();
  const out = {};
  let readyWards = 0;
  for (const w of R) {
    const i = insp.wards[w.id];
    const issues = [];
    if (!i) issues.push('ward-absent-from-root-manifest');
    else {
      if (!i.manifestPresent) issues.push('ward-manifest-missing');
      if (i.tilesMissing) issues.push('tiles-missing');
      if (i.jsonSyntaxErrors) issues.push('json-syntax');
      if (i.badId) issues.push('bad-id');
      if (i.dupIdWithinWard) issues.push('duplicate-id');
      if (i.countMismatch) issues.push('tile-count-mismatch');
      if (i.skippedUnreadable) issues.push('unreadable-or-cloud-only'); // fatal-to-ready
      if (i.skippedTooLarge) issues.push('file-over-64MiB');
      if (i.badGeometry) issues.push('bad-geometry');
      if (i.manifestPresent && !i.tilesListed) issues.push('no-tiles-listed');
      if (i.manifestBuildings != null && i.buildings !== i.manifestBuildings && !i.skippedUnreadable && !i.skippedTooLarge) issues.push('root-manifest-building-count');
      if (i.manifestTiles != null && i.tilesListed !== i.manifestTiles) issues.push('root-manifest-tile-count');
      try { // ward manifest wardCode must equal the registry code when present (43B normalisation)
        const m = readJson(path.join(path.resolve(src), 'osaka-' + w.id, 'manifest.json'));
        if (m.wardCode != null && T.normalizeWardCode(m.wardCode) !== w.code) issues.push('wardCode-mismatch');
      } catch (e) { /* already counted above */ }
    }
    const ready = issues.length === 0;
    if (ready) readyWards++;
    out[w.id] = {
      code: w.code, ready, issues,
      tiles: { expected: i ? i.manifestTiles : null, listed: i ? i.tilesListed : 0, found: i ? i.tilesFound : 0 },
      buildings: { manifest: i ? i.manifestBuildings : null, found: i ? i.buildings : 0 },
    };
  }
  const rep = {
    schema: 'livecity.mission43d.audit/1', readOnly: true, ready: readyWards === 24 && insp.rootManifest.wardCountMatches, readyWards, wards: out,
    rootManifest: insp.rootManifest, totals: insp.totals,
    warnings: { crossWardDuplicateIds: insp.totals.dupIdAcrossWards, meaning: 'informational (Mission 40D known conflicts); data is never altered and readiness is not affected' }, otherFolders: insp.otherFolders,
    rootProblemKinds: [...new Set(insp.problems.map(kind))].sort(),
    gates: GATES,
    note: 'Counts and issue kinds only; no paths, ids or values. Cross-ward duplicate ids are informational (Mission 40D). Unreadable/cloud-only files make a ward not ready.',
  };
  return assertAnonymous(rep);
}

// ---- batch-plan (offline). Reuses 43B plan for categories; adds size estimates and a strict 4-way status.
// A PC-side verdict is trusted only with the exact schema, not fatal, and (for audit) ready overall.
const wardClean = (i) => !!i && i.manifestPresent && i.tilesListed > 0 && i.tilesFound === i.tilesListed && i.buildings > 0 &&
  !(i.tilesMissing || i.jsonSyntaxErrors || i.badId || i.dupIdWithinWard || i.countMismatch || i.skippedUnreadable || i.skippedTooLarge || i.badGeometry) &&
  (i.manifestBuildings == null || i.manifestBuildings === i.buildings);
function pcVerdict(inspectJson, auditJson, ward) {
  if (auditJson) {
    if (auditJson.schema !== 'livecity.mission43d.audit/1') throw new Error('--audit: unexpected schema');
    const a = auditJson.wards && auditJson.wards[ward];
    // overall ready:false (fatal, root-manifest problem, any other ward) => nothing is treated as PC-usable
    const usable = auditJson.ready === true && !auditJson.fatal && !!a && a.ready === true && !!a.buildings && a.buildings.found > 0;
    return { usable, source: 'audit', buildings: a ? a.buildings.found : null, tiles: a ? a.tiles.found : null };
  }
  if (inspectJson) {
    const i = inspectJson.wards && inspectJson.wards[ward];
    return { usable: inspectJson.ok === true && wardClean(i), source: 'inspect', buildings: i ? i.buildings : null, tiles: i ? i.tilesFound : null };
  }
  return { usable: false, source: 'none', buildings: null, tiles: null };
}
function trackedEvidence(ward) {
  const dir = path.join(ROOT, 'public/map-data/osaka-city/buildings/osaka-' + ward);
  try {
    const mf = readJson(path.join(dir, 'manifest.json'));
    const onDisk = fs.readdirSync(dir).filter((f) => /^tile_.*\.json$/.test(f)).length;
    return { tilesOnDisk: onDisk, tilesInManifest: mf.tileCount, buildingsInManifest: mf.totalBuildings, consistent: onDisk === mf.tileCount && Number.isFinite(mf.totalBuildings) };
  } catch (e) { return { consistent: false }; }
}
function batchPlan(inspectJson, auditJson) {
  if (inspectJson && inspectJson.schema !== 'livecity.mission43.inspect/1') throw new Error('--inspect: unexpected schema');
  const base = A.plan(inspectJson || null, null);
  const man = T.buildManifest();
  const wards = base.wards.map((p) => {
    const mw = man.wards.find((x) => x.ward === p.ward);
    const ev = mw.groups.legacyBuildingTilesInGit.state === 'in-Git-complete' ? trackedEvidence(p.ward) : null;
    const tracked = !!ev && ev.consistent; // counted from files present in Git, not only the manifest claim
    const v = pcVerdict(inspectJson, auditJson, p.ward);
    let status, reason;
    if (tracked) { status = 'tracked-legacy-rebuildable'; reason = 'tile files counted in Git match the ward manifest'; }
    else if (v.usable) { status = 'pc-only'; reason = 'anonymous ' + v.source + ' reports this ward clean' + (v.source === 'audit' ? ' and the audit overall ready' : ''); }
    else { status = 'not-ready'; reason = v.source === 'none' ? 'unknown: no anonymous PC output provided' : 'PC ' + v.source + ' does not show a clean, overall-ready source'; }
    const buildings = tracked ? ev.buildingsInManifest : (v.usable ? v.buildings : null);
    const tilesIn = tracked ? ev.tilesOnDisk : (v.usable ? v.tiles : null);
    const pcBuildings = v.buildings, pcTiles = v.tiles;
    return {
      ward: p.ward, code: p.code, status, statusReason: reason, trackedEvidence: ev,
      knownFromGit: { legacyTilesTracked: tracked, partial3dBuildings: p.gitBuildings3d },
      knownFromPcOutput: v.source !== 'none' ? { source: v.source, tiles: pcTiles, buildings: pcBuildings } : 'unknown (no anonymous inspect/audit output provided)',
      minInputTiles: tilesIn == null ? 'unknown' : tilesIn,
      estimatedOutputGlb: tilesIn == null ? 'unknown' : tilesIn + Math.ceil(tilesIn / 9),
      estimatedOutputBytes: buildings == null ? 'unknown' : Math.round(buildings * BYTES_PER_BUILDING),
      runnableOnGitHub: tracked, approvedForTransfer: false,
    };
  });
  const rep = {
    schema: 'livecity.mission43d.batch-plan/1', dryRun: true, gates: GATES, transferredNow: { files: 0, bytes: 0 },
    estimateBasis: BYTES_PER_BUILDING + ' B/building (Sumiyoshi measured); estimates, not measurements',
    summary: ['tracked-legacy-rebuildable', 'pc-only', 'not-ready'].reduce((o, s) => { o[s] = wards.filter((w) => w.status === s).length; return o; }, {}),
    wards, note: 'No PC-only ward is approved for transfer while any gate is false. unknown = not verifiable from Git.',
  };
  return assertAnonymous(rep);
}

// ---- run: explicit mode, default dry-run. Tracked legacy tiles only. Output must be a NEW dir outside the repo.
function checkOutRoot(outRoot) {
  const o = path.resolve(outRoot);
  const rel = path.relative(ROOT, o);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) { const e = new Error('output root must be outside the repository (and therefore outside public/)'); e.code = 4; throw e; }
  if (fs.existsSync(o) && fs.readdirSync(o).length) { const e = new Error('output root exists and is not empty; refusing to overwrite'); e.code = 4; throw e; }
  return o;
}
function run(wardsArg, outRoot, execute) {
  const man = T.buildManifest();
  const R = reg();
  const trackedIds = man.wards.filter((w) => w.groups.legacyBuildingTilesInGit.state === 'in-Git-complete').map((w) => w.ward);
  const ids = wardsArg === 'all-tracked' ? trackedIds : String(wardsArg || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) { const e = new Error('--wards required (ids or all-tracked)'); e.code = 2; throw e; }
  const out = checkOutRoot(outRoot);
  const results = [];
  for (const id of ids) {
    const w = R.find((x) => x.id === id);
    if (!w) { results.push({ ward: id, state: 'rejected', reason: 'not-in-registry' }); continue; }
    if (!trackedIds.includes(id)) { results.push({ ward: id, state: 'fail-closed', reason: 'legacy tiles not Git-tracked (PC-only or absent); not runnable on GitHub' }); continue; }
    if (!execute) {
      const mf = readJson(path.join(ROOT, 'public/map-data/osaka-city/buildings/osaka-' + id + '/manifest.json'));
      results.push({ ward: id, state: 'dry-run', wouldConvert: { tiles: mf.tileCount, buildings: mf.totalBuildings, estimatedBytes: Math.round(mf.totalBuildings * BYTES_PER_BUILDING) } });
      continue;
    }
    const dir = path.join(out, id);
    try {
      // one codepath per ward: rebuild -> verify (tileset/GLB/ids/attrs) ; Sumiyoshi additionally regresses against committed 37B 9 tiles
      const rep = id === 'sumiyoshi' ? T.regress(dir) : Object.assign({ ok: true }, T.rebuild(id, dir));
      const v = id === 'sumiyoshi' ? null : rep.verify;
      const ok = id === 'sumiyoshi' ? rep.ok : v.ok;
      results.push(id === 'sumiyoshi'
        ? { ward: id, state: ok ? 'ok' : 'failed', buildings: rep.rebuilt.buildings, uniqueIds: rep.rebuilt.uniqueIds, bytes: rep.rebuilt.totalBytes, regress37b: { glbIdentical: rep.vsCommitted9Tile.glbByteIdentical, idsIdentical: rep.vsCommitted9Tile.idsIdentical, statsIdentical: rep.vsCommitted9Tile.leafStatsIdentical, of: rep.vsCommitted9Tile.refTiles }, problems: rep.problems.length }
        : { ward: id, state: ok ? 'ok' : 'failed', buildings: rep.convert.buildings, uniqueIds: rep.convert.uniqueIds, bytes: rep.convert.totalBytes, problems: v.problems.length });
    } catch (e) { results.push({ ward: id, state: 'failed', reason: /verif|mismatch|differ/i.test(String(e.message)) ? 'verification-failed' : 'rebuild-error' }); }
  }
  const rep = {
    schema: 'livecity.mission43d.run/1', mode: execute ? 'execute' : 'dry-run', gates: GATES, published: false, uploaded: false, uploadAllowed: 0,
    ok: results.every((r) => r.state === 'ok' || r.state === 'dry-run'), results,
    note: 'Output stays in a local directory outside the repo. Not committed, not an Actions artifact, not served.',
  };
  return assertAnonymous(rep);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const has = (k) => rest.includes('--' + k);
  const opt = (k) => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    if (cmd === 'audit') {
      const r = audit(opt('src'));
      if (opt('write')) fs.writeFileSync(opt('write'), JSON.stringify(r, null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify(r, null, 1)); process.exit(r.ready ? 0 : 1);
    } else if (cmd === 'audit-plan') { // audit -> batch-plan in one process; writes nothing; prints a compact anonymous summary
      const a = audit(opt('src'));
      const p = batchPlan(null, a);
      console.log(JSON.stringify(assertAnonymous({
        schema: 'livecity.mission43e.audit-plan/1', auditReady: a.ready, readyWards: a.readyWards, fatal: a.fatal || null,
        totals: a.totals || null, warnings: a.warnings || null, rootProblemKinds: a.rootProblemKinds || [],
        wardIssues: Object.fromEntries(Object.entries(a.wards).filter(([, w]) => !w.ready).map(([k, w]) => [k, w.issues])),
        planSummary: p.summary, gates: GATES, uploadAllowed: 0, transferredNow: p.transferredNow,
        note: 'Counts and issue kinds only. Nothing written, copied or sent. pc-only is never an approval.',
      }), null, 1));
      process.exit(a.ready ? 0 : 1);
    } else if (cmd === 'batch-plan') {
      console.log(JSON.stringify(batchPlan(opt('inspect') && readJson(opt('inspect')), opt('audit') && readJson(opt('audit'))), null, 1));
    } else if (cmd === 'run') {
      if (!opt('out-root')) throw Object.assign(new Error('--out-root required'), { code: 2 });
      const r = run(opt('wards'), opt('out-root'), has('execute'));
      console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : 3);
    } else { console.error('usage: audit | audit-plan | batch-plan | run'); process.exit(2); }
  } catch (e) { // only our own numeric-coded errors (fixed text, no paths) are printed; system errors (ENOENT/EEXIST...) carry paths
    const own = Number.isInteger(e.code);
    console.error(own ? e.message : 'error: operation failed (details suppressed so no path or id is printed)');
    process.exit(own ? e.code : 1);
  }
}
module.exports = { audit, batchPlan, run, checkOutRoot, assertAnonymous, BYTES_PER_BUILDING };
if (require.main === module) main();
