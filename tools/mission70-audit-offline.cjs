#!/usr/bin/env node
'use strict';
// Mission 70 P0: fully offline, read-only audit of the PC-local 24-ward private 3D Tiles (Mission 45D output).
//   node tools/mission70-audit-offline.cjs --src <legacy buildings dir> --out-root <45D root> [--json]
// Reuses the 45E plan() proof (recomputed from disk against the legacy source). No network, no writes, no deletes.
// Output is anonymous aggregates only: no absolute/private paths, no coordinates, no building ids, no names, no secret values.
const fs = require('fs');
const path = require('path');

const MIME = { '.json': 'application/json', '.glb': 'model/gltf-binary' };
const SUSPECT = /(\.env|secret|token|credential|password|\.pem|\.key|id_rsa|\.p12|\.pfx|\.sqlite|\.db|\.zip|\.7z|\.csv|\.xlsx?|\.docx?|\.pdf|\.jpe?g|\.png|\.exe|\.ps1|\.bat)$/i;
const SECRET_RE = /(AIza[0-9A-Za-z_-]{20,}|ghp_[0-9A-Za-z]{20,}|sk-[0-9A-Za-z]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|[A-Za-z]:\\Users\\|\/home\/[a-z0-9_-]+\/)/;
const BUCKETS = [[0, 1024, '<1KB'], [1024, 65536, '1-64KB'], [65536, 1048576, '64KB-1MB'], [1048576, 16777216, '1-16MB'], [16777216, Infinity, '>=16MB']];

function walk(dir, rel, out, flags) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
    if (e.isSymbolicLink()) { flags.links++; continue; }
    if (e.isDirectory()) walk(p, r, out, flags);
    else if (e.isFile()) out.push({ p, r, size: fs.statSync(p).size });
  }
}
function auditWard(dir) {
  const files = [], flags = { links: 0 };
  walk(dir, '', files, flags);
  const kinds = {}, ext = {}, dist = Object.fromEntries(BUCKETS.map((b) => [b[2], 0]));
  let bytes = 0, suspectFiles = 0, secretHits = 0, unknownExt = 0;
  const glb = new Set(), ids = new Set(), attrs = new Set();
  for (const f of files) {
    bytes += f.size;
    const x = path.extname(f.r).toLowerCase();
    ext[x || '(none)'] = (ext[x || '(none)'] || 0) + 1;
    if (!MIME[x]) unknownExt++;
    const top = f.r.includes('/') ? f.r.split('/')[0] : '(root)';
    kinds[top] = (kinds[top] || 0) + 1;
    for (const b of BUCKETS) if (f.size >= b[0] && f.size < b[1]) { dist[b[2]]++; break; }
    if (SUSPECT.test(f.r)) suspectFiles++;
    const base = f.r.replace(/\.[^.]+$/, '');
    if (/^tiles\//.test(f.r) && x === '.glb') glb.add(base.slice(6));
    if (/^ids\//.test(f.r)) ids.add(base.slice(4));
    if (/^attrs\//.test(f.r)) attrs.add(base.slice(6));
    if (x === '.json' && f.size < 4 * 1024 * 1024 && !/^(ids|attrs)\//.test(f.r)) {
      if (SECRET_RE.test(fs.readFileSync(f.p, 'utf8'))) secretHits++;
    }
  }
  // tileset -> content references (relative, must exist; count only)
  let refs = 0, broken = 0, absoluteRefs = 0;
  try {
    const ts = JSON.parse(fs.readFileSync(path.join(dir, 'tileset.json'), 'utf8'));
    const stack = [ts.root];
    while (stack.length) {
      const t = stack.pop(); if (!t) continue;
      const u = t.content && (t.content.uri || t.content.url);
      if (u) { refs++; if (/^([a-z]+:)?\/\//i.test(u) || path.isAbsolute(u)) absoluteRefs++; else if (!fs.existsSync(path.join(dir, u))) broken++; }
      for (const c of t.children || []) stack.push(c);
    }
  } catch (e) { broken++; }
  // ids sidecar <-> attrs consistency: same tile set, same count of ids (no id values are emitted)
  let idMismatch = 0, idTiles = 0;
  for (const t of ids) {
    idTiles++;
    if (!attrs.has(t)) { idMismatch++; continue; }
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dir, 'ids', t + '.json'), 'utf8'));
      const b = JSON.parse(fs.readFileSync(path.join(dir, 'attrs', t + '.json'), 'utf8'));
      const n = Array.isArray(a) ? a.length : Array.isArray(a.ids) ? a.ids.length : -1;
      const m = b && b.byId ? Object.keys(b.byId).length : Array.isArray(b.ids) ? b.ids.length : -1;
      if (n < 0 || (m >= 0 && n !== m)) idMismatch++;
    } catch (e) { idMismatch++; }
  }
  let source = null;
  try { const s = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8')); source = { hasSource: true, hasLicence: !!(s.license || s.licence), hasAttribution: !!(s.attribution || s.credit || s.source) }; } catch (e) { source = { hasSource: false, hasLicence: false, hasAttribution: false }; }
  return { files: files.length, bytes, dist, ext, topDirs: kinds, unknownExt, suspectFiles, secretHits, symlinksSkipped: flags.links, glb: glb.size, idsTiles: ids.size, attrsTiles: attrs.size, tilesetRefs: refs, brokenRefs: broken, absoluteRefs, idMismatch, source };
}

function run(opts) {
  const E = require('./mission45e-preview.cjs'); // read-only plan(): recomputes the 45D proof from disk
  const pl = E.plan({ src: opts.src, outRoot: opts.outRoot });
  const wards = pl.servable.map((s, i) => ({ n: i + 1, buildings: s.buildings, ...auditWard(s.dir) }));
  const tot = { wards: wards.length, buildings: 0, files: 0, bytes: 0, glb: 0, brokenRefs: 0, absoluteRefs: 0, idMismatch: 0, suspectFiles: 0, secretHits: 0, unknownExt: 0, noLicenceInfo: 0 };
  for (const w of wards) {
    tot.buildings += w.buildings; for (const k of ['files', 'bytes', 'glb', 'brokenRefs', 'absoluteRefs', 'idMismatch', 'suspectFiles', 'secretHits', 'unknownExt']) tot[k] += w[k];
    if (!w.source.hasLicence) tot.noLicenceInfo++;
  }
  const blockers = [];
  if (tot.wards !== 24) blockers.push('wards!=24');
  if (tot.brokenRefs) blockers.push('broken tileset references');
  if (tot.absoluteRefs) blockers.push('absolute/external tileset references');
  if (tot.idMismatch) blockers.push('ids/attrs mismatch');
  if (tot.secretHits) blockers.push('secret/private-path pattern in json');
  if (tot.suspectFiles || tot.unknownExt) blockers.push('non-whitelisted file kinds present');
  // Gates are NEVER derived from this audit: licence/PII/secrets review is a human decision.
  return {
    schema: 'livecity.mission70.audit/1', network: 0, writes: 0, kind: pl.synthetic ? 'synthetic' : 'real',
    proof: { verifiedWards: pl.proof.verifiedWards, sourceBuildings: pl.proof.sourceBuildings, convertedBuildings: pl.proof.convertedBuildings },
    totals: tot, mimeMap: MIME, wardsAnonymous: wards,
    uploadReadiness: { technicalBlockers: blockers, licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false, uploadAllowed: false },
    note: 'Ward entries are numbered, not named; no paths, coordinates, ids or text values are emitted. Human gates remain false.'
  };
}
module.exports = { run, auditWard, MIME };
if (require.main === module) {
  const a = process.argv.slice(2), g = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const r = run({ src: g('--src'), outRoot: g('--out-root') });
    console.log(JSON.stringify(r, null, a.includes('--json') ? 0 : 2));
  } catch (e) { console.error('audit failed: ' + e.message + (e.code ? ' (code ' + e.code + ')' : '')); process.exit(e.code || 1); }
}
