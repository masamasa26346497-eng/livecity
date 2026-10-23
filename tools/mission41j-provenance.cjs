'use strict';
// Mission 41J: provenance candidates, pack leak check, use-scope matrix. Offline, read-only except a NEW report file ('wx').
// Prints NO secret values and NO absolute paths. Nothing here approves a source or opens a gate.
//   provenance --repo <root> [--out <new file.json>]     source/licence CANDIDATES found in repo metadata, all "owner-confirm-required"
//   scopes                                               private-storage / Claude-Code-view / public-web differences
//   leak-check --manifest <m.json> [--review <secret-review.json>] [--also-review <other.json>]
//                                                        does the pack plan contain any flagged / secret-named file? (ids only, exit 2 if yes)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SECRET_NAME_HINT } = require('./mission41f-pack-local.cjs');

const sha8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
// Same id scheme as 41C (root ':' rel) so a review id can be matched to a manifest entry.
const fid = (root, rel) => crypto.createHash('sha256').update(root + ':' + rel).digest('hex').slice(0, 8);

// ---- 1. provenance candidates (from repo metadata only; never "approved") -----------------------
// keyword -> data family. Evidence = repo-relative names of files that mention it.
const FAMILIES = [
  { id: 'plateau', re: /PLATEAU|CityGML|国土交通省.*3D都市モデル/, categories: ['building-tiles', '3dtiles-output', 'plateau-raw'] },
  { id: 'osm', re: /OpenStreetMap|\bOSM\b|ODbL|Overpass/, categories: ['osm-layers', 'facilities', 'building-tiles'] },
  { id: 'n03-boundary', re: /N03|国土数値情報|町丁・字等別境界|CODH/, categories: ['boundaries'] },
  { id: 'estat-census', re: /e-Stat|国勢調査|estat/i, categories: ['demographics'] },
  { id: 'wikimedia', re: /Wikimedia|Commons|Wikidata/, categories: ['photo-index', 'photos-unverified-rights'] },
  { id: 'gsi-tiles', re: /地理院|cyberjapandata|gsi\.go\.jp/, categories: [] },
];
const TEXT_EXT = /\.(md|json|js|cjs|mjs|html|ps1)$/i;
const SKIP_DIR = /^(node_modules|\.git|temp|data|tests)$/;

function walk(dir, rel, depth, out, limit) {
  if (depth > 4 || out.length >= limit) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (out.length >= limit) return;
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(path.join(dir, e.name), rel + e.name + '/', depth + 1, out, limit); }
    else if (e.isFile() && (TEXT_EXT.test(e.name))) out.push(rel + e.name);
  }
}

function provenance(repo) {
  const files = []; walk(repo, '', 0, files, 4000);
  const fam = new Map(FAMILIES.map((f) => [f.id, { family: f.id, categoriesLikely: f.categories, evidenceFiles: [], explicitLicenceFields: [] }]));
  // explicit metadata: config/datasets/*.json and any source.json
  const meta = [];
  for (const f of files) {
    const base = path.basename(f);
    const isMeta = (/^config\/datasets\//.test(f) && /\.json$/.test(f)) || base === 'source.json';
    let size = 0; try { size = fs.statSync(path.join(repo, f)).size; } catch { continue; }
    if (size > 2 * 1024 * 1024) continue;
    let t; try { t = fs.readFileSync(path.join(repo, f), 'utf8'); } catch { continue; }
    for (const F of FAMILIES) {
      if (!F.re.test(t)) continue;
      const e = fam.get(F.id);
      if (e.evidenceFiles.length < 15 && (isMeta || /^(README|MISSION|CLAUDE|config\/)/.test(f))) e.evidenceFiles.push(f);
      if (isMeta) {
        try {
          const j = JSON.parse(t.replace(/^﻿/, ''));
          const lic = j.license || j.licence || (j.source && (j.source.license || j.source.licence));
          const prov = j.provider || j.source && j.source.provider || j.sourceName;
          if ((lic || prov) && e.explicitLicenceFields.length < 8) e.explicitLicenceFields.push({ file: f, provider: prov ? String(prov).slice(0, 80) : '', licenceClaim: lic ? String(lic).slice(0, 80) : '' });
        } catch { /* not json: ignore */ }
      }
    }
    if (isMeta) meta.push(f);
  }
  const families = [...fam.values()].filter((e) => e.evidenceFiles.length || e.explicitLicenceFields.length).map((e) => {
    const claims = [...new Set(e.explicitLicenceFields.map((x) => x.licenceClaim).filter(Boolean))];
    return { ...e, distinctLicenceClaims: claims, status: 'owner-confirm-required', redistributionAllowed: null, approved: false,
      flags: [claims.length > 1 ? 'conflicting-or-multiple-licence-claims' : '', !claims.length ? 'no-explicit-licence-field-in-repo' : '', 'claim-in-repo-is-not-proof-of-redistribution-right'].filter(Boolean) };
  });
  // Categories that mix origins by construction (derived products)
  const mixed = [
    { category: '3dtiles-output', mixesFamilies: ['plateau', 'n03-boundary'], note: 'building geometry from PLATEAU; ward polygons used to select buildings from N03' },
    { category: 'building-tiles', mixesFamilies: ['plateau', 'osm'], note: 'PLATEAU where available, OSM fallback tiles (636) exist; split by tile before any claim' },
    { category: 'photo-index', mixesFamilies: ['wikimedia'], note: 'per-file author/licence differ (CC0, CC BY, CC BY-SA); keep fields, ledger per file' },
    { category: 'facilities', mixesFamilies: ['osm'], note: 'ODbL: attribution + share-alike on derived database' },
  ];
  return { schema: 1, scannedTextFiles: files.length, metadataFiles: meta.length, families, mixedOriginCategories: mixed,
    owner: { mustConfirm: 'primary source page + licence text + whether redistribution/derived work is allowed, per family', ledgerCommand: '41H licence-ledger, then fill by hand' },
    note: 'Candidates from repo text only. Nothing is approved; redistributionAllowed stays null. No network was used.' };
}

// ---- 2. use-scope matrix ------------------------------------------------------------------------
function scopes() {
  return {
    schema: 1,
    rows: [
      { scope: 'private-github-storage', who: 'owner (and collaborators you add)', licenceNeed: 'redistribution right still matters if the repo ever becomes public or is shared; private copy for backup of data you may lawfully hold is usually weaker, but source terms may forbid re-hosting', personalData: 'e-mail/phone/names in files are stored on GitHub servers; remove or exclude first', secrets: 'keys must never be stored, even privately (history is permanent; rotate if ever pushed)', status: 'owner decision' },
      { scope: 'claude-code-viewing', who: 'Claude Code in GitHub Actions reads the repo/branch', licenceNeed: 'same as private storage; the content is sent to the model provider as input', personalData: 'anything in the repo can be read and echoed into comments; keep personal data out', secrets: 'a key in the repo is readable by the agent and by logs; never commit', status: 'owner decision' },
      { scope: 'public-web', who: 'anyone (Vercel Preview, public repo)', licenceNeed: 'redistribution + attribution must be confirmed per family (PLATEAU terms unconfirmed; OSM ODbL attribution/share-alike; Commons per-file licences)', personalData: 'must be none', secrets: 'browser Maps keys are visible by design; only restricted keys, never server secrets', status: 'blocked until ledger approved' },
    ],
    note: 'Informational summary, not legal advice. The tool opens no gate.',
  };
}

// ---- 3. pack leak check --------------------------------------------------------------------------
function flaggedIds(rev) {
  const s = new Set();
  for (const f of (rev && rev.files) || []) {
    const bad = (f.hits || []).some((h) => h.verdict === 'looks-real' || h.verdict === 'personal-or-unknown-domain' || h.verdict === 'file-pattern-only' || h.verdict === 'unreviewed');
    if (bad || f.nameOnly) s.add(f.id);
  }
  return s;
}
function leakCheck(manifest, revs) {
  const flagged = new Set(); let reviewedFiles = 0;
  for (const r of revs) { reviewedFiles += (r.files || []).length; for (const id of flaggedIds(r)) flagged.add(id); }
  const hits = []; let total = 0; const byCategory = {};
  for (const p of manifest.parts || []) for (const f of p.files || []) {
    total++;
    const i = f.path.indexOf('/'); const root = i > 0 ? f.path.slice(0, i) : ''; const rel = i > 0 ? f.path.slice(i + 1) : f.path;
    const id = fid(root, rel);
    const reasons = [];
    if (flagged.has(id)) reasons.push('in-secret-review');
    if (SECRET_NAME_HINT.test(f.path)) reasons.push('secret-like-name');
    if (/(^|\/)local-config\.js$/i.test(f.path)) reasons.push('local-config.js');
    if (/\.(txt|md|js|cjs|mjs|json|html|ps1|env|ini|cfg|conf|yml|yaml)$/i.test(f.path) && /(^|\/)(notes?|memo|keys?|passwords?)[^/]*$/i.test(f.path)) reasons.push('notes-like-name');
    if (reasons.length) { hits.push({ id, category: p.category, reasons }); byCategory[p.category] = (byCategory[p.category] || 0) + 1; }
  }
  const gaps = [];
  if (!revs.length) gaps.push('no secret-review given: only name checks ran');
  gaps.push('this compares ids/names only; file CONTENTS of packed files were not scanned (41C scanned 41A candidates only)');
  gaps.push('a review made on a different root set cannot flag files from roots it did not list; run 41C with every root that 41B/41F packs');
  return { manifestFiles: total, reviewIdsLoaded: flagged.size, reviewedFiles, leaks: hits.length, byCategory, ids: hits.slice(0, 100), gaps,
    verdict: hits.length ? 'LEAK-RISK: remove these ids from the plan' : 'no flagged id or secret-like name in plan (not proof of absence)',
    gates: { noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false } };
}

function arg(argv, k) { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; }
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
function run(argv) {
  const cmd = argv[0]; const pr = (o) => console.log(JSON.stringify(o, null, 1));
  if (cmd === 'provenance') {
    const r = provenance(path.resolve(arg(argv, '--repo') || '.')); const out = arg(argv, '--out');
    if (out) { if (fs.existsSync(out)) throw new Error('--out exists (will not overwrite)'); fs.writeFileSync(out, JSON.stringify(r, null, 1), { flag: 'wx' }); }
    pr({ families: r.families.map((f) => ({ family: f.family, evidenceFiles: f.evidenceFiles.length, licenceClaims: f.distinctLicenceClaims, flags: f.flags, status: f.status })), mixedOriginCategories: r.mixedOriginCategories.map((m) => m.category), written: !!out, note: r.note });
    return 0;
  }
  if (cmd === 'scopes') { pr(scopes()); return 0; }
  if (cmd === 'leak-check') {
    if (!arg(argv, '--manifest')) throw new Error('--manifest required');
    const revs = ['--review', '--also-review'].map((k) => arg(argv, k)).filter(Boolean).map(readJson);
    const r = leakCheck(readJson(arg(argv, '--manifest')), revs); pr(r); return r.leaks ? 2 : 0;
  }
  throw new Error('usage: provenance | scopes | leak-check');
}
module.exports = { provenance, scopes, leakCheck, fid, run };
if (require.main === module) { try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); } }
