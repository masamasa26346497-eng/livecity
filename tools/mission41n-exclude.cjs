'use strict';
// Mission 41N: HOLD handling for one transfer candidate. OFFLINE, READ-ONLY, no upload, no network.
// Output contains ONLY anonymous ids, categories, extensions, sizes and counts. Never a path, key name, value or context.
//   node tools/mission41n-exclude.cjs dry-run --manifest m.json --id <8hex>[,<8hex>] [--tar-dir <dir>] [--write-plan <new-dir>]
//        Shows what happens if the file is held back from the transfer candidates. With --write-plan a NEW exclusion plan file (ids only)
//        is written into a new/empty folder outside nothing else; nothing existing is touched.
//   node tools/mission41n-exclude.cjs sanitize-plan --manifest m.json --roots-file r.json --id <8hex>
//        Read-only: parses the JSON, runs the sanitize + verify IN MEMORY and prints counts. Writes nothing.
// The library function createSanitizedCopy() (fixture-tested) is deliberately NOT reachable from this CLI:
// generating a derived copy of real data needs the owner's explicit approval in a later mission.
// Nothing here approves a licence or personal-data review: every gate stays false.
const fs = require('node:fs');
const path = require('node:path');
const k = require('./mission41k-content-scan.cjs');
const l = require('./mission41l-triage.cjs');
const d = require('./mission41d-pack.cjs');
const f41 = require('./mission41f-pack-local.cjs');

const MIB = 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}$/;
const GATES = { licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false };

function parseIds(s) {
  const ids = String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!ids.length || !ids.every((x) => ID_RE.test(x))) throw new Error('--id must be one or more 8-hex ids (comma separated)');
  return [...new Set(ids)];
}

// ---------- header-only tar listing: names are compared by id, never printed ----------
function tarMemberIds(file) {
  const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; const hb = Buffer.alloc(512); const ids = new Set(); let count = 0;
  try {
    let pos = 0, zero = 0;
    while (pos + 512 <= size) {
      if (fs.readSync(fd, hb, 0, 512, pos) !== 512) break;
      pos += 512;
      if (hb.every((x) => x === 0)) { if (++zero === 2) break; continue; }
      const cstr = (a, b) => { const s = hb.subarray(a, b); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString('utf8'); };
      const nm = cstr(0, 100), pre = cstr(345, 500); const full = pre ? pre + '/' + nm : nm;
      const sz = parseInt(hb.toString('latin1', 124, 135).trim() || '0', 8);
      const { root, rel } = k.splitPath(full); ids.add(k.fid(root, rel)); count++;
      pos += Math.ceil(sz / 512) * 512;
    }
  } finally { fs.closeSync(fd); }
  return { ids, count };
}

// ---------- dry-run ----------
function dryRun(m, ids, opts) {
  opts = opts || {};
  const found = []; const missing = [];
  const idSet = new Set(ids);
  const hits = new Map();
  m.parts.forEach((p, pi) => {
    for (const f of p.files) {
      const { root, rel } = k.splitPath(f.path); const id = k.fid(root, rel);
      if (idSet.has(id)) { if (!hits.has(id)) hits.set(id, []); hits.get(id).push({ pi, f }); }
    }
  });
  for (const id of ids) {
    const h = hits.get(id);
    if (!h) { missing.push(id); continue; }
    found.push({ id, occurrences: h.length, category: m.parts[h[0].pi].category, ext: k.extOf(k.splitPath(h[0].f.path).rel) || '(none)', bytes: h[0].f.size });
  }
  const sel = f41.selectForPack(m, {});
  const before = f41.selectForPack(m, {}).parts;
  const after = f41.selectForPack(m, { excludeIds: idSet }).parts;
  const sum = (ps) => ({ parts: ps.length, files: ps.reduce((a, p) => a + p.files.length, 0), bytes: ps.reduce((a, p) => a + p.files.reduce((x, y) => x + y.size, 0), 0), tarEstimate: ps.reduce((a, p) => a + d.tarEstimate(p.files), 0) });
  const affected = [];
  m.parts.forEach((p, pi) => {
    if (!hits.size || ![...hits.values()].some((h) => h.some((x) => x.pi === pi))) return;
    const b = before.find((x) => x.asset === p.asset); const a = after.find((x) => x.asset === p.asset);
    affected.push({ partIndex: pi + 1, category: p.category, filesBefore: b ? b.files.length : 0, filesAfter: a ? a.files.length : 0,
      tarEstimateBefore: b ? d.tarEstimate(b.files) : 0, tarEstimateAfter: a ? d.tarEstimate(a.files) : 0,
      fullPartTarNameStillProduced: !!(a && !a.subselection), subsetNameTar: !!(a && a.subselection) });
  });
  const out = { tool: 'mission41n-exclude', mode: 'dry-run', network: false, uploaded: false, wrote: false,
    requested: ids.length, found, notInManifest: missing, totalsBefore: sum(before), totalsAfter: sum(after), affectedParts: affected,
    existingTars: null, gates: { ...GATES }, autoApproved: false, autoExcluded: false,
    notes: [
      'this only plans to leave the file out of the transfer candidates; the original file is neither changed nor deleted',
      'holding back one id does not review anything else: every other detected file and every unscanned binary stays unreviewed and all gates stay false',
      'a manifest sourceMetadata count is not licence approval',
    ] };
  void sel;
  if (opts.tarDir) {
    const rows = []; let n = 0;
    for (const name of fs.readdirSync(opts.tarDir).filter((x) => /\.tar$/i.test(x)).sort()) {
      n++;
      try {
        const t = tarMemberIds(path.join(opts.tarDir, name));
        const contains = ids.filter((i) => t.ids.has(i));
        rows.push({ tar: n, members: t.count, containsHeldId: contains.length > 0, heldIdsInside: contains.length, mustRepack: contains.length > 0 });
      } catch (e) { rows.push({ tar: n, error: 'unreadable-tar' }); }
    }
    out.existingTars = { checked: rows.length, rows, mustRepackCount: rows.filter((r) => r.mustRepack).length,
      note: 'tars are never modified or deleted; a tar that contains a held id must be re-created with --exclude-plan into a NEW --out folder, and the old tar should be removed by the owner only' };
  }
  return out;
}

function writePlan(ids, outDir, extra) {
  const abs = path.resolve(outDir);
  if (fs.existsSync(abs) && fs.readdirSync(abs).length) throw new Error('--write-plan folder is not empty (will not overwrite)');
  fs.mkdirSync(abs, { recursive: true });
  const plan = { schema: 1, tool: 'mission41n-exclude', excludeIds: ids, reason: 'owner-requested HOLD after field-level triage (41M)', excludedByOwnerRequest: true,
    note: 'ids only (sha256(root:rel) first 8 hex); no path, key name or value is stored', gates: { ...GATES }, ...extra };
  const file = path.join(abs, 'exclusion-plan.json');
  fs.writeFileSync(file, JSON.stringify(plan, null, 1), { flag: 'wx' });
  return file;
}

// ---------- sanitize (library, fixture-tested) ----------
// Blanks every STRING under a contact-like key; never touches anything else. Objects/arrays under a contact key are not handled (refused).
function sanitizeValue(root) {
  const stats = { blanked: 0, blankedWithoutPhonePattern: 0, nonStringContact: 0, structuredContact: 0 };
  const det = k.DETECTORS.find((x) => x.type === 'jp-phone-number');
  const walk = (v, key) => {
    if (v === null || typeof v !== 'object') {
      if (key !== null && l.keyClass(key) === 'contact-key') {
        if (typeof v === 'string') {
          stats.blanked++;
          if (!new RegExp(det.re.source, det.re.flags).test(v)) stats.blankedWithoutPhonePattern++;
          return '';
        }
        if (v !== null && v !== undefined) stats.nonStringContact++;
      }
      return v;
    }
    if (Array.isArray(v)) {
      if (key !== null && l.keyClass(key) === 'contact-key') stats.structuredContact++;
      return v.map((x) => walk(x, key));
    }
    if (key !== null && l.keyClass(key) === 'contact-key') stats.structuredContact++;
    const o = {};
    for (const kk of Object.keys(v)) o[kk] = walk(v[kk], kk);
    return o;
  };
  return { value: walk(root, null), stats };
}

// Parallel walk. Everything must be identical except strings under contact keys, which must be ''.
function verifySanitized(src, dst) {
  const r = { identicalStructure: true, geometryUnchanged: true, idsUnchanged: true, featureCountEqual: true, sourceMetadataEqual: true, contactValuesAllBlank: true, changedValues: 0, problem: null };
  const fail = (what) => { r.problem = r.problem || what; };
  const walk = (a, b, key, depth) => {
    if (r.problem) return;
    const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
    const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
    const kc = key === null ? '' : l.keyClass(key);
    if (ta !== 'object' && ta !== 'array') {
      if (kc === 'contact-key' && ta === 'string') { if (b !== '') { r.contactValuesAllBlank = false; fail('contact-not-blank'); } else if (a !== '') r.changedValues++; return; }
      if (a !== b || ta !== tb) {
        r.identicalStructure = false;
        if (kc === 'coordinate-key') r.geometryUnchanged = false;
        if (kc === 'id-key') r.idsUnchanged = false;
        if (key !== null && l.SRC_META_KEY.test(key)) r.sourceMetadataEqual = false;
        fail('value-differs');
      }
      return;
    }
    if (ta !== tb) { r.identicalStructure = false; fail('type-differs'); return; }
    if (ta === 'array') {
      if (a.length !== b.length) { r.identicalStructure = false; r.featureCountEqual = false; fail('length-differs'); return; }
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], key, depth + 1);
      return;
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length || ka.some((x, i) => x !== kb[i])) { r.identicalStructure = false; fail('keys-differ'); return; }
    for (const kk of ka) walk(a[kk], b[kk], kk, depth + 1);
  };
  walk(src, dst, null, 0);
  return r;
}

function sanitizeAndVerifyInMemory(value) {
  const s = sanitizeValue(value);
  const v = verifySanitized(value, s.value);
  const before = l.fieldTriage(value), after = l.fieldTriage(s.value);
  // a phone-like value under a non-contact key is NOT handled here (unknown purpose): such a file is never sanitize-ready
  const ok = !v.problem && before.nonContactKeyMatches === 0 && s.stats.structuredContact === 0 && s.stats.nonStringContact === 0
    && (after.byKeyClass['contact-key'] || 0) === 0 && after.matches === before.nonContactKeyMatches
    && after.sourceMetadata.keyOccurrences === before.sourceMetadata.keyOccurrences;
  return { ok, stats: s.stats, verify: v, matchesBefore: before.matches, matchesAfter: after.matches, nonContactMatchesRemaining: after.matches,
    sourceMetaKeyOccurrences: { before: before.sourceMetadata.keyOccurrences, after: after.sourceMetadata.keyOccurrences }, value: s.value };
}

// Writes a NEW derived copy into a NEW folder. Source is only read. Not exposed by the CLI in 41N.
function createSanitizedCopy(srcFile, destDir, opts) {
  opts = opts || {};
  if (opts.ownerApproved !== true) throw new Error('owner approval flag is required');
  const abs = path.resolve(destDir); const srcAbs = path.resolve(srcFile);
  if (d.isUnder(abs, path.dirname(srcAbs), process.platform)) throw new Error('destination must be outside the source folder');
  if (fs.existsSync(abs) && fs.readdirSync(abs).length) throw new Error('destination is not empty (will not overwrite)');
  const text = fs.readFileSync(srcAbs, 'utf8').replace(/^﻿/, '');
  const parsed = l.parseJsonLoose(text);
  if (!parsed) throw new Error('json-parse-failed');
  const r = sanitizeAndVerifyInMemory(parsed.value);
  if (!r.ok) throw new Error('verification failed; nothing written');
  fs.mkdirSync(abs, { recursive: true });
  const body = parsed.form === 'ndjson' ? r.value.map((x) => JSON.stringify(x)).join('\n') + '\n' : JSON.stringify(r.value);
  fs.writeFileSync(path.join(abs, path.basename(srcAbs)), body, { flag: 'wx' });
  const rec = { schema: 1, tool: 'mission41n-exclude', derivedFromId: opts.sourceId || null, blankedValues: r.stats.blanked, verify: r.verify,
    licence: { inheritedFromSource: true, approved: false, note: 'a derived copy inherits the source licence/attribution; nothing was approved' }, gates: { ...GATES } };
  fs.writeFileSync(path.join(abs, 'DERIVED-FROM-SOURCE.json'), JSON.stringify(rec, null, 1), { flag: 'wx' });
  return rec;
}

function sanitizePlanFile(o) {
  const m = k.loadJson(o.manifest); const roots = k.loadJson(o.rootsFile);
  for (const f of k.manifestFiles(m)) {
    const { root, rel } = k.splitPath(f.path);
    if (k.fid(root, rel) !== o.id) continue;
    if (!/^\.?(?:json|geojson|jsonl|ndjson)$/i.test(k.extOf(rel))) return { error: 'not-a-json-file' };
    if (!roots[root]) return { error: 'root-not-given' };
    const full = path.join(roots[root], ...rel.split('/'));
    let st; try { st = fs.statSync(full); } catch (e) { return { error: 'unreadable-or-cloud-only' }; }
    if (st.size > 128 * MIB) return { error: 'over-128MiB-not-parsed' };
    let text; try { text = fs.readFileSync(full, 'utf8'); } catch (e) { return { error: 'unreadable-or-cloud-only' }; }
    const parsed = l.parseJsonLoose(text.replace(/^﻿/, ''));
    if (!parsed) return { error: 'json-parse-failed' };
    const r = sanitizeAndVerifyInMemory(parsed.value);
    return { tool: 'mission41n-exclude', mode: 'sanitize-plan', id: o.id, category: f.category, ext: k.extOf(rel) || '(none)', parsedAs: parsed.form, wrote: false,
      wouldBlankValues: r.stats.blanked, wouldBlankWithoutPhonePattern: r.stats.blankedWithoutPhonePattern, unsupportedContactStructures: r.stats.structuredContact + r.stats.nonStringContact,
      matchesBefore: r.matchesBefore, matchesAfterInMemory: r.matchesAfter, sourceMetaKeyOccurrences: r.sourceMetaKeyOccurrences,
      verification: { passed: r.ok, ...r.verify },
      wouldRemovePublicFacilityNumbersToo: true, gates: { ...GATES }, autoApproved: false,
      notes: ['whole contact-key values are blanked; public facility numbers cannot be told from personal ones automatically, so they are blanked too',
        'nothing was written. A derived copy needs the owner\'s explicit approval and is not available from this CLI'] };
  }
  return { error: 'id-not-in-manifest' };
}

function run(argv) {
  const cmd = argv[0]; const a = {};
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--manifest') a.manifest = argv[++i]; else if (t === '--roots-file') a.rootsFile = argv[++i]; else if (t === '--id') a.id = argv[++i];
    else if (t === '--tar-dir') a.tarDir = argv[++i]; else if (t === '--write-plan') a.writePlan = argv[++i]; else throw new Error('unknown option: ' + t);
  }
  if (cmd === 'dry-run') {
    if (!a.manifest) throw new Error('--manifest is required');
    const m = k.loadJson(a.manifest);
    if (!m || !Array.isArray(m.parts) || m.schema !== 2) throw new Error('not a schema 2 manifest');
    const ids = parseIds(a.id);
    const r = dryRun(m, ids, { tarDir: a.tarDir ? path.resolve(a.tarDir) : null });
    if (a.writePlan) { writePlan(r.found.map((x) => x.id), a.writePlan, {}); r.wrote = true; r.planWritten = 'exclusion-plan.json (ids only)'; }
    console.log(JSON.stringify(r, null, 1));
    return r.notInManifest.length ? 2 : 0;
  }
  if (cmd === 'sanitize-plan') {
    if (!a.manifest || !a.rootsFile) throw new Error('--manifest and --roots-file are required');
    const r = sanitizePlanFile({ manifest: a.manifest, rootsFile: a.rootsFile, id: parseIds(a.id)[0] });
    console.log(JSON.stringify(r, null, 1));
    return r.error ? 2 : 0;
  }
  throw new Error('usage: dry-run | sanitize-plan (see header)');
}

module.exports = { parseIds, tarMemberIds, dryRun, writePlan, sanitizeValue, verifySanitized, sanitizeAndVerifyInMemory, createSanitizedCopy, sanitizePlanFile, run };
if (require.main === module) { try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(String(e.message).replace(/[A-Za-z]:\\[^\s'"]*|\/[^\s'"]+\/[^\s'"]*/g, '<path>')); process.exit(1); } }
