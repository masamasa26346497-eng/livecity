#!/usr/bin/env node
'use strict';
// Mission 43B: (1) viewer <-> Git-tracked tileset consistency audit, (2) dry-run per-ward input plan.
// Read-only on the repo; writes only data/reports/mission43b/*.json when --write is given. No network. No paths/names in output.
//   node tools/mission43b-audit.cjs viewer [--write]
//   node tools/mission43b-audit.cjs plan [--inspect inspect.json] [--preflight preflight.json] [--write]
//     inspect.json / preflight.json = the anonymous outputs of `mission43-ward-rebuild.cjs inspect|preflight` run on the owner PC.
const fs = require('fs');
const path = require('path');
const T = require('./mission43-ward-rebuild.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data/reports/mission43b');
const HTML = path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const wards = () => readJson(path.join(ROOT, 'config/wards/registry.json')).wards;

const LICENCE = {
  licenceApproved: false,
  generalPolicy: {
    plateau: 'MLIT PLATEAU site policy (https://www.mlit.go.jp/plateau/site-policy/) states PDL1.0 / CC BY compatibility for covered content incl. 3D city models and requires source + modification notices; FAQ (https://www.mlit.go.jp/plateau/faq/) states commercial use is allowed. Reported by the requester; this audit did not fetch it.',
    osm: 'OpenStreetMap data is ODbL 1.0; attribution "(c) OpenStreetMap contributors" required (https://www.openstreetmap.org/copyright).',
    googlePlaces: 'Paid Google Places data is NOT used.',
  },
  datasetSpecific: 'Osaka City 2024 dataset page (https://www.geospatial.jp/ckan/dataset/plateau-27100-osaka-shi-2024) returned HTTP 403 to the requester: its README / per-resource terms and redistribution / modification rights are UNVERIFIED. Per the product spec (https://www.mlit.go.jp/plateaudocument/toc8/toc8_06/toc8_06_03/) a README states per-dataset terms, so the general policy must not be treated as approval of this dataset.',
  attributionAlreadyShownInViewer: 'see licenseNote in each source.json',
};

// ---------- viewer audit ----------
function parseViewerDefs(html) {
  const m = html.match(/const EXTRA_SET_DEFS = \[([\s\S]*?)\n  \];/);
  const defs = [];
  if (m) for (const x of m[1].matchAll(/\{\s*id:\s*'([^']+)',\s*base:\s*'([^']+)'/g)) defs.push({ id: x[1], base: x[2] });
  const baseSet = (html.match(/const SET = q\.get\('set'\) \|\| '([^']+)'/) || [])[1] || null;
  const tilesBase = (html.match(/const TILES_BASE = '([^']+)'/) || [])[1] || null;
  const layerBase = (html.match(/const LAYER_BASE = '([^']+)'/) || [])[1] || null;
  const baseWard = (html.match(/const BASE_WARD = '(\d+)'/) || [])[1] || null;
  const publishedGate = /approved === true/.test(html) && /mission40j-3dtiles\/published\.json/.test(html);
  return { defs, baseSet, tilesBase, layerBase, baseWard, publishedGate };
}

function countJsonIn(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

function viewerAudit() {
  const reg = wards();
  const html = fs.readFileSync(HTML, 'utf8');
  const v = parseViewerDefs(html);
  const sets = T.existingSets();
  const problems = [];
  const bySetRel = (rel) => sets.find((s) => s.rel === 'public/' + rel.replace(/\/$/, ''));
  const rows = [];

  // base (Sumiyoshi) set: tileset in TILES_BASE, attrs in LAYER_BASE
  if (v.baseSet) {
    const s = bySetRel('mission37b-3dtiles/' + v.baseSet);
    const attrsDir = path.join(ROOT, 'public/mission37c-layers', v.baseSet, 'attrs');
    const brp = path.join(ROOT, 'public/mission37b-3dtiles', v.baseSet, 'build-report.json');
    const leaf = s && fs.existsSync(brp) ? (readJson(brp).leaf || []).map((l) => l.name) : [];
    const baseAttrs = leaf.filter((n) => fs.existsSync(path.join(attrsDir, n + '.json'))).length;
    if (baseAttrs !== leaf.length) problems.push('base set attrs sidecars ' + baseAttrs + '/' + leaf.length);
    rows.push({ id: 'base:' + v.baseSet, kind: 'base', ward: s && s.wardId, wardCode: s && s.wardCode, metaState: s && s.metaState,
      tracked: !!(s && s.tracked), tilesetRefs: s ? s.refs : null, buildings: s && s.buildings, leafTiles: leaf.length, attrsSidecars: baseAttrs,
      note: 'attrs are served from LAYER_BASE (mission37c-layers), not from the tileset dir' });
    if (!s) problems.push('base set not found: ' + v.baseSet);
    if (v.baseWard && s && s.wardCode !== v.baseWard) problems.push('BASE_WARD ' + v.baseWard + ' != base set ward ' + (s && s.wardCode));
  } else problems.push('could not parse base SET from viewer');

  for (const d of v.defs) {
    const s = bySetRel(d.base);
    const dir = path.join(ROOT, 'public', d.base);
    const row = { id: d.id, kind: 'extra', base: d.base, exists: !!s, tracked: !!(s && s.tracked), ward: s && s.wardId, wardCode: s && s.wardCode,
      metaState: s && s.metaState, tilesetRefs: s && s.refs, buildings: s && s.buildings };
    if (!s) { problems.push('EXTRA_SET_DEFS ' + d.id + ' points at a missing/untracked tileset'); rows.push(row); continue; }
    if (!s.tracked) problems.push(d.id + ': not Git-tracked (would 404 on Vercel)');
    if (s.metaState !== 'consistent') problems.push(d.id + ': ward metadata ' + s.metaState + ' (' + s.metaProblems.join('; ') + ')');
    if (s.refs.problems.length) problems.push(d.id + ': tileset refs: ' + s.refs.problems.slice(0, 3).join('; '));
    // the viewer fetches source.json, build-report.json, ids/t_*.json, attrs/t_*.json per leaf tile
    for (const f of ['source.json', 'build-report.json']) if (!fs.existsSync(path.join(dir, f))) problems.push(d.id + ': missing ' + f);
    const leafNames = (readJson(path.join(dir, 'build-report.json')).leaf || []).map((l) => l.name);
    row.leafTiles = leafNames.length;
    row.idsSidecars = leafNames.filter((n) => fs.existsSync(path.join(dir, 'ids', n + '.json'))).length;
    row.attrsSidecars = leafNames.filter((n) => fs.existsSync(path.join(dir, 'attrs', n + '.json'))).length;
    if (row.idsSidecars !== leafNames.length) problems.push(d.id + ': ids sidecars ' + row.idsSidecars + '/' + leafNames.length);
    if (row.attrsSidecars !== leafNames.length) problems.push(d.id + ': attrs sidecars ' + row.attrsSidecars + '/' + leafNames.length);
    // ids <-> attrs <-> report building counts
    let idN = 0, attrN = 0;
    for (const n of leafNames) {
      try { const a = readJson(path.join(dir, 'ids', n + '.json')); idN += (Array.isArray(a) ? a : a.ids || []).length; } catch (e) { /* counted above */ }
      try { attrN += Object.keys(readJson(path.join(dir, 'attrs', n + '.json')).byId || {}).length; } catch (e) { /* counted above */ }
    }
    row.idsTotal = idN; row.attrsTotal = attrN;
    if (idN !== s.buildings) problems.push(d.id + ': ids ' + idN + ' != report buildings ' + s.buildings);
    if (attrN !== s.buildings) problems.push(d.id + ': attrs ' + attrN + ' != report buildings ' + s.buildings);
    rows.push(row);
  }

  // tracked sets the viewer does not know about (registry-visible but never shown)
  const known = new Set(v.defs.map((d) => 'public/' + d.base.replace(/\/$/, '')));
  if (v.baseSet) known.add('public/mission37b-3dtiles/' + v.baseSet);
  const unregistered = sets.filter((s) => s.tracked && !known.has(s.rel)).map((s) => s.rel);
  for (const u of unregistered) problems.push('tracked tileset not registered in viewer: ' + u);

  // published gate
  const pubPath = path.join(ROOT, 'public/mission40j-3dtiles/published.json');
  const pub = fs.existsSync(pubPath) ? readJson(pubPath) : { wards: [] };
  const approved = (pub.wards || []).filter((w) => w && w.approved === true);
  for (const w of approved) {
    const dd = path.join(ROOT, 'public/mission40j-3dtiles', String(w.ward));
    if (!fs.existsSync(path.join(dd, 'tileset.json'))) problems.push('published.json approves ' + w.ward + ' but tileset is missing');
  }
  if (!v.publishedGate) problems.push('viewer published gate (approved === true) not found');

  // ward -> viewer coverage
  const codesWith3d = new Set(rows.filter((r) => r.ward).map((r) => r.wardCode));
  const wardCoverage = reg.map((w) => ({ ward: w.id, code: w.code, viewer3d: codesWith3d.has(w.code) ? 'partial' : 'unavailable' }));
  const wardsWith3d = wardCoverage.filter((c) => c.viewer3d !== 'unavailable').length;

  return {
    schema: 'livecity.mission43b.viewer-audit/1',
    method: 'static: parses viewer EXTRA_SET_DEFS and reads tracked files. NOT a browser run.',
    browserE2E: 'not-run-in-this-report (see test log / PR comment for the headless run, if any)',
    ok: problems.length === 0, problems,
    summary: { wardsRegistry: reg.length, wardsWithTrackedViewable3d: wardsWith3d, wardsUnavailable: reg.length - wardsWith3d, extraDefs: v.defs.length,
      baseWard: v.baseWard, publishedGateWired: v.publishedGate, publishedApprovedWards: approved.length },
    note: 'Every ward counted here is a PARTIAL slice of the ward. This is not "24 wards done".',
    sets: rows, unregisteredTrackedSets: unregistered, wardCoverage,
    missingConditionsFor24WardDynamicLoading: [
      '18 wards have no tileset in Git: setBuildingWard() returns false and the UI shows "3D unavailable" (viewer line ~948).',
      'All 6 covered wards are partial (PLATEAU mesh slices; Sumiyoshi 9 of 52 source tiles).',
      'A new ward needs: tileset.json + GLBs + ids/ + attrs/ + source.json(wardCode) + build-report.json under a tracked dir, plus an EXTRA_SET_DEFS entry or an approved:true row in mission40j-3dtiles/published.json.',
      'published.json approves 0 wards; local-only ?ext= sets work on localhost only.',
      'ward ids are not globally unique (Mission 40D conflicts); the viewer keys sidecars per tileset (_lcBase), so only one ward may be mounted at a time.',
      'Hosting: full-city output is estimated at ~0.6 GB, not suitable for Git/Vercel static hosting without owner approval of storage.',
    ],
    licence: LICENCE,
  };
}

// ---------- dry-run plan ----------
function assertAnonymous(obj) {
  const s = JSON.stringify(obj);
  if (/[A-Za-z]:\\\\|\/home\/|\/Users\/|OneDrive/.test(s)) throw new Error('refusing: output would contain a local path');
}
function plan(inspect, preflight) {
  const man = T.buildManifest();
  const reg = readJson(path.join(ROOT, 'config/source-registry.json'));
  const anyApproved = (reg.entries || []).some((e) => e.approved === true);
  const insp = inspect && inspect.schema === 'livecity.mission43.inspect/1' ? inspect : null;
  const pre = preflight && preflight.schema === 'livecity.mission43.preflight/1' ? preflight : null;
  if (inspect && !insp) throw new Error('--inspect: unexpected schema');
  if (preflight && !pre) throw new Error('--preflight: unexpected schema');
  const out = man.wards.map((w) => {
    const g = w.groups;
    const i = insp && insp.wards && insp.wards[w.ward];
    const p = pre && pre.perWard && pre.perWard[w.ward];
    const viewableInGit = g.buildings3dInGit.state === 'in-Git';
    const rebuildableFromGit = g.legacyBuildingTilesInGit.state === 'in-Git-complete';
    const pcHasTiles = i ? i.tilesFound > 0 : (p ? p.files > 0 : null);
    // a ward is "PC-only" only if neither a Git route to the FULL ward exists
    const pcOnly = !rebuildableFromGit && pcHasTiles === true;
    const categories = [];
    if (viewableInGit) categories.push('i-viewable-in-git-partial');
    if (rebuildableFromGit) categories.push('ii-rebuildable-from-git-legacy-tiles');
    if (pcOnly) categories.push('iii-pc-only-first-transfer-unavoidable');
    if (!rebuildableFromGit) categories.push('iv-public-refetch-candidate-licence-unverified');
    const primaryRoute = rebuildableFromGit ? 'rebuild-from-git (no transfer)'
      : pcOnly ? 'owner-PC convert (mission40c-run-local.ps1 -Wards ' + w.ward + '); only converted output, not the 75GB, would ever need to move, and only after gates + approval'
      : 'public re-fetch (36K range fetch) after licence review; or PC data if later confirmed';
    return {
      ward: w.ward, code: w.code, categories, primaryRoute,
      sourceTiles: { expected: i ? i.manifestTiles : null, listedInPcManifest: i ? i.tilesListed : null, foundOnPc: i ? i.tilesFound : null },
      sourceBuildings: i ? { manifest: i.manifestBuildings, foundOnPc: i.buildings } : null,
      anonymousFiles: p ? p.files : null, anonymousBytes: p ? p.bytes : null,
      gitBuildings3d: viewableInGit ? g.buildings3dInGit.buildings : 0,
    };
  });
  const rep = {
    schema: 'livecity.mission43b.ward-input-plan/1', dryRun: true,
    inputs: { inspectProvided: !!insp, preflightProvided: !!pre },
    gates: { licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false, uploadAllowed: 0 },
    consistentWithSourceRegistry: !anyApproved,
    transferredNow: { files: 0, bytes: 0 },
    summary: {
      'i-viewable-in-git-partial': out.filter((x) => x.categories.some((c) => c.startsWith('i-'))).length,
      'ii-rebuildable-from-git-legacy-tiles': out.filter((x) => x.categories.some((c) => c.startsWith('ii-'))).length,
      'iii-pc-only-first-transfer-unavoidable': out.filter((x) => x.categories.some((c) => c.startsWith('iii-'))).length,
      'iv-public-refetch-candidate-licence-unverified': out.filter((x) => x.categories.some((c) => c.startsWith('iv-'))).length,
      pcTotals: pre ? { perWardFiles: Object.values(pre.perWard || {}).reduce((n, x) => n + x.files, 0), perWardBytes: Object.values(pre.perWard || {}).reduce((n, x) => n + x.bytes, 0),
        otherFolders: pre.otherFolders } : 'preflight not provided',
    },
    note: 'Without --inspect/--preflight, category iii cannot be decided (PC contents unknown to the repo). Counts only; no names or paths. A ward can be in several categories.',
    wards: out, licence: LICENCE,
  };
  assertAnonymous(rep);
  return rep;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const has = (k) => rest.includes('--' + k);
  const opt = (k) => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    let rep, name;
    if (cmd === 'viewer') { rep = viewerAudit(); name = 'viewer-audit.json'; }
    else if (cmd === 'plan') {
      rep = plan(opt('inspect') ? readJson(opt('inspect')) : null, opt('preflight') ? readJson(opt('preflight')) : null);
      name = 'ward-input-plan.json';
    } else { console.error('usage: viewer | plan [--inspect f] [--preflight f] [--write]'); process.exit(2); }
    if (has('write')) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), JSON.stringify(rep, null, 2) + '\n'); }
    console.log(JSON.stringify(cmd === 'viewer' ? { ok: rep.ok, problems: rep.problems, summary: rep.summary } : { summary: rep.summary, gates: rep.gates }, null, 1));
    process.exit(cmd === 'viewer' && !rep.ok ? 1 : 0);
  } catch (e) { console.error(e.message); process.exit(e.code || 1); }
}
module.exports = { viewerAudit, plan, parseViewerDefs, LICENCE };
if (require.main === module) main();
