'use strict';
// Mission 41P: source-registry consistency + provenance gate + online-first dry-run report. OFFLINE: reads repo files only, no network.
//   node tools/mission41p-registry-check.cjs [--registry config/source-registry.json] [--root .] [--markdown]
// Exit 0 = consistent, 1 = problems. Never changes any licence or approval state.
const fs = require('node:fs');
const path = require('node:path');

const RECON = ['confirmed', 'candidate', 'unknown'];
const RISK = ['low', 'medium', 'high'];

function check(reg, root) {
  const problems = []; const add = (id, msg) => problems.push(id + ': ' + msg);
  const entries = Array.isArray(reg.entries) ? reg.entries : [];
  if (reg.schema !== 1) problems.push('registry: schema must be 1');
  const ids = new Set();
  for (const e of entries) { if (ids.has(e.id)) add(e.id, 'duplicate id'); ids.add(e.id); }
  const read = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return null; } };
  for (const e of entries) {
    if (!/^[a-z0-9-]+$/.test(String(e.id || ''))) add(e.id, 'bad id');
    if (!RECON.includes(e.reconstructability)) add(e.id, 'bad reconstructability');
    if (!RISK.includes(e.localOnlyRisk)) add(e.id, 'bad localOnlyRisk');
    if (!String(e.basis || '').trim()) add(e.id, 'basis (why this label) is required');
    // provenance: a URL must be https and must literally appear in the evidence file (no guessed URLs)
    if (e.sourceUrl !== null) {
      if (!/^https:\/\//.test(e.sourceUrl)) add(e.id, 'sourceUrl must be https');
      const txt = e.urlEvidence ? read(e.urlEvidence) : null;
      if (txt === null) add(e.id, 'sourceUrl needs an existing urlEvidence file');
      else if (!txt.includes(e.sourceUrl)) add(e.id, 'sourceUrl string not found in urlEvidence (guessed URL?)');
    } else if (e.urlEvidence) add(e.id, 'urlEvidence set without sourceUrl');
    // confirmed requires URL + script + a basis; unknown must not claim a URL
    if (e.reconstructability === 'confirmed') {
      if (e.sourceUrl === null) add(e.id, 'confirmed needs sourceUrl');
      if (e.networkNeededToRebuild && (!Array.isArray(e.scripts) || !e.scripts.length)) add(e.id, 'confirmed needs a reproduction script');
    }
    if (e.reconstructability === 'unknown' && e.sourceUrl !== null) add(e.id, 'unknown must not have sourceUrl (use candidate)');
    for (const s of e.scripts || []) if (!fs.existsSync(path.join(root, s))) add(e.id, 'script not found: ' + s);
    for (const d of e.dependsOn || []) if (!ids.has(d)) add(e.id, 'dependsOn unknown id: ' + d);
    // licence: never approved here
    if (e.approved !== false) add(e.id, 'approved must be false (licence approval is a manual gate)');
    if (e.licenceClaim) {
      if (e.licenceClaim.verifiedAgainstPrimary !== false) add(e.id, 'licenceClaim.verifiedAgainstPrimary must be false in this phase');
      if (!e.licenceClaim.claimedIn || !fs.existsSync(path.join(root, e.licenceClaim.claimedIn))) add(e.id, 'licenceClaim.claimedIn file not found');
    }
    // no personal/absolute path leakage
    const blob = JSON.stringify(e);
    if (/[A-Za-z]:\\|\/home\/|\/Users\/|OneDrive\\/.test(blob)) add(e.id, 'looks like an absolute/local path');
    if (/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(blob)) add(e.id, 'looks like an e-mail address');
  }
  // cycle check
  const g = new Map(entries.map((e) => [e.id, e.dependsOn || []]));
  const state = new Map();
  const visit = (n) => { if (state.get(n) === 1) return true; if (state.get(n) === 2) return false; state.set(n, 1); for (const d of g.get(n) || []) if (g.has(d) && visit(d)) return true; state.set(n, 2); return false; };
  for (const n of g.keys()) if (visit(n)) { problems.push('registry: dependency cycle at ' + n); break; }
  return problems;
}

function report(reg) {
  const e = reg.entries;
  const by = (f) => e.filter(f).map((x) => x.id);
  return {
    entries: e.length,
    reconstructability: Object.fromEntries(RECON.map((r) => [r, by((x) => x.reconstructability === r).length])),
    licenceApproved: e.filter((x) => x.approved === true).length,
    licenceClaimsUnverified: e.filter((x) => x.licenceClaim && x.licenceClaim.verifiedAgainstPrimary === false).length,
    onlineRebuildCandidates: by((x) => x.reconstructability !== 'unknown' && x.networkNeededToRebuild && x.localOnlyRisk !== 'high'),
    highLocalOnlyRisk: by((x) => x.localOnlyRisk === 'high'),
    unknownSources: by((x) => x.reconstructability === 'unknown'),
    trackedAlready: by((x) => (x.trackedArtifacts || []).length > 0),
    note: 'dry-run summary of the registry only; nothing was downloaded; labels are not proof that a source is reachable or that output bytes match local files'
  };
}

function markdown(r) {
  const L = ['### Mission 41P source registry (offline dry-run)', '',
    '| item | count |', '|---|---|',
    '| entries | ' + r.entries + ' |', '| confirmed | ' + r.reconstructability.confirmed + ' |', '| candidate | ' + r.reconstructability.candidate + ' |', '| unknown | ' + r.reconstructability.unknown + ' |',
    '| licences approved | ' + r.licenceApproved + ' |', '| licence claims not verified against primary source | ' + r.licenceClaimsUnverified + ' |', '',
    'High local-only risk: ' + (r.highLocalOnlyRisk.join(', ') || 'none'), '', 'Unknown sources: ' + (r.unknownSources.join(', ') || 'none'), '',
    r.note];
  return L.join('\n');
}

function run(argv) {
  const i = (k) => { const x = argv.indexOf(k); return x >= 0 ? argv[x + 1] : undefined; };
  const root = path.resolve(i('--root') || '.');
  const reg = JSON.parse(fs.readFileSync(path.join(root, i('--registry') || 'config/source-registry.json'), 'utf8'));
  const problems = check(reg, root);
  const rep = report(reg);
  console.log(argv.includes('--markdown') ? markdown(rep) : JSON.stringify({ ok: problems.length === 0, problems, report: rep }, null, 1));
  if (problems.length) for (const p of problems) console.error('PROBLEM ' + p);
  return problems.length ? 1 : 0;
}
module.exports = { check, report, markdown, run };
if (require.main === module) { try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); } }
