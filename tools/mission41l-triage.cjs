'use strict';
// Mission 41L: OFFLINE, READ-ONLY triage of a 41K content-scan result. No network, never changes/moves/deletes a source file.
// Output (console/JSON) contains ONLY anonymous file ids, categories, extensions, counts and shape CLASSES.
// It never prints a path, a content snippet, a matched value or a fingerprint of a value.
//   node tools/mission41l-triage.cjs report    --report content-scan-report-*.json [--manifest m.json --state content-scan-state.json] [--out f.json]
//   node tools/mission41l-triage.cjs classify  --manifest m.json --roots-file r.json --id <8hex> [--detector jp-phone-number]   (owner-local; shape classes only)
//   node tools/mission41l-triage.cjs glb-meta  --manifest m.json --roots-file r.json [--path-contains fukushima] [--skip-file list.txt] [--max-files N]
// Nothing here approves anything: every output says autoApproved:false and the 41K gates stay false.
const fs = require('node:fs');
const path = require('node:path');
const k = require('./mission41k-content-scan.cjs');

const MIB = 1024 * 1024;
const KIND = {
  glb: 'glb', b3dm: '3dtiles-binary', i3dm: '3dtiles-binary', pnts: '3dtiles-binary', cmpt: '3dtiles-binary',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', tif: 'image', tiff: 'image', bmp: 'image', ico: 'image',
  pbf: 'osm-binary', osm: 'osm-binary', shp: 'gis-binary', dbf: 'gis-binary', gpkg: 'gis-binary', sqlite: 'gis-binary', db: 'gis-binary',
  zip: 'archive', '7z': 'archive', rar: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive', xlsx: 'archive', xls: 'archive', docx: 'archive', pptx: 'archive',
  pdf: 'document', mp4: 'media', mov: 'media', woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', exe: 'executable', dll: 'executable', bin: 'bin-unknown',
};
const kindOf = (ext) => KIND[ext] || 'other-binary';

// ---------- report: anonymous listing ----------
function crosstab(manifest, state) {
  const out = {}; let counted = 0;
  for (const f of k.manifestFiles(manifest)) {
    const { root, rel } = k.splitPath(f.path);
    const e = state.files && state.files[k.skey(root, rel)];
    if (!e || e.status !== 'unscanned') continue;
    const ext = k.extOf(rel) || '(none)';
    const key = f.category + '|' + kindOf(ext) + '|' + ext + '|' + (e.reason || 'unknown');
    out[key] = (out[key] || 0) + 1; counted++;
  }
  const rows = Object.entries(out).map(([key, files]) => { const [category, kind, ext, reason] = key.split('|'); return { category, kind, ext, reason, files }; })
    .sort((a, b) => b.files - a.files);
  return { counted, rows };
}

function reportView(report, extra) {
  const staleScanner = !report.scannerVersion || report.scannerVersion !== k.SCANNER_VERSION;
  const view = {
    tool: 'mission41l-triage', reportScannerVersion: report.scannerVersion || 'pre-41L', currentScannerVersion: k.SCANNER_VERSION,
    reportIsFromOlderScanner: staleScanner,
    summary: { selected: report.stats && report.stats.selected, scanned: report.byStatus && report.byStatus.scanned, unscanned: report.byStatus && report.byStatus.unscanned, complete: report.complete },
    detectorTotals: report.detectorTotals || {},
    filesWithFindings: (report.filesWithFindings || []).map((f) => ({ id: f.id, category: f.category, ext: f.ext, detections: f.detections, falsePositiveClass: 'undecided-owner-check-required', autoApproved: false })),
    unscannedByReason: report.unscanned && report.unscanned.byReason,
    unscannedByKind: {},
    unscannedByExtension: report.unscanned && report.unscanned.byExtension,
    gates: { noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false },
    warnings: [],
  };
  for (const [ext, n] of Object.entries(view.unscannedByExtension || {})) { const kd = kindOf(ext); view.unscannedByKind[kd] = (view.unscannedByKind[kd] || 0) + n; }
  if (staleScanner) view.warnings.push('this report was produced by an older scanner/detector set; re-run 41K (state is invalidated automatically) before relying on it');
  if (extra && extra.crosstab) {
    view.unscannedByCategoryKindExt = extra.crosstab.rows;
    if (extra.stateVersionMismatch) view.warnings.push('state file is from another scanner version; the cross-tab may be empty or stale');
  }
  view.notes = [
    'a detection is a pattern match; it is neither proof of a secret nor proof of a false positive',
    'unscanned is not safe',
    'to decide a detection, use the classify command (shape classes only) and then the owner-local manual check in MISSION41L_README.md',
  ];
  return view;
}

// ---------- classify: shape classes for pattern matches, no values ----------
const UUID_NEAR = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
function prefixClass(digits) {
  if (/^0120|^0800/.test(digits)) return 'toll-free(0120/0800)';
  if (/^0[789]0/.test(digits)) return 'mobile(070/080/090)';
  if (/^050/.test(digits)) return 'ip-phone(050)';
  if (/^0[36]/.test(digits)) return 'landline-major-city(03/06)';
  return 'other-area-code';
}
// Never returns a value: only shape/prefix/context classes with counts.
function classifyMatches(text, detectorType) {
  const det = k.DETECTORS.find((d) => d.type === (detectorType || 'jp-phone-number'));
  if (!det) throw new Error('unknown detector');
  const uuidSpans = []; let u;
  UUID_NEAR.lastIndex = 0;
  while ((u = UUID_NEAR.exec(text))) uuidSpans.push([u.index, u.index + u[0].length]);
  const re = new RegExp(det.re.source, det.re.flags); const out = {}; let m;
  while ((m = re.exec(text))) {
    if (!m[0].length) { re.lastIndex++; continue; }
    const s = m.index, e = s + m[0].length;
    const raw = m[0].replace(/^\+81[- ]?/, '0');
    const shape = raw.split('-').map((x) => x.length).join('-');
    const insideUuid = uuidSpans.some(([a, b]) => s >= a && e <= b);
    const prev = (text.slice(Math.max(0, s - 3), s).match(/[^\s]$/) || [''])[0];
    const next = (text.slice(e, e + 3).match(/^[^\s]/) || [''])[0];
    const arr = /[\d,\[]/.test(prev) && /[\d,\]]/.test(next);
    const letterAdj = /[A-Za-z_]/.test(prev) || /[A-Za-z_]/.test(next);
    const context = insideUuid ? 'inside-uuid-like-id' : (arr ? 'inside-numeric-list' : (letterAdj ? 'adjacent-to-letters(id/token-like)' : 'free-text-or-field'));
    const key = 'shape ' + shape + ' | ' + prefixClass(raw.replace(/-/g, '')) + ' | ' + context;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}
function classifyFile(o) {
  const m = k.loadJson(o.manifest); const roots = k.loadJson(o.rootsFile);
  for (const f of k.manifestFiles(m)) {
    const { root, rel } = k.splitPath(f.path);
    if (k.fid(root, rel) !== o.id) continue;
    if (!roots[root]) return { error: 'root-not-given' };
    const full = path.join(roots[root], ...rel.split('/'));
    let st; try { st = fs.statSync(full); } catch (e) { return { error: 'unreadable-or-cloud-only' }; }
    if (st.size > 128 * MIB) return { error: 'over-128MiB-not-classified' };
    if (k.BINARY_EXT.has(k.extOf(rel))) return { error: 'binary-not-classified' };
    let buf; try { buf = fs.readFileSync(full); } catch (e) { return { error: 'unreadable-or-cloud-only' }; }
    const classes = classifyMatches(buf.toString('latin1'), o.detector);
    const total = Object.values(classes).reduce((a, b) => a + b, 0);
    const onlyIdish = total > 0 && Object.keys(classes).every((c) => /inside-uuid-like-id|inside-numeric-list|adjacent-to-letters/.test(c));
    return { id: o.id, category: f.category, ext: k.extOf(rel) || '(none)', detector: o.detector || 'jp-phone-number', matches: total, classes,
      hint: total === 0 ? 'no match with current detector (re-run 41K)' : (onlyIdish ? 'shapes look like id/numeric data; STILL needs owner confirmation' : 'free-text matches exist; owner must look at them locally'),
      autoApproved: false, autoExcluded: false };
  }
  return { error: 'id-not-in-manifest' };
}

// ---------- fields (41M): JSON field-level anonymous triage; never prints values, keys, paths or context ----------
// ASCII-only source: non-ASCII key names are written as \u escapes.
const KEY_CLASSES = [
  ['contact-key', /^(?:phone|tel|telephone|fax|contact|mobile|cell|電話|連絡先)$|phone|^tel[_:-]|[_:-]tel$/i],
  ['coordinate-key', /^(?:coordinates|coords|geometry|lat|lon|lng|latitude|longitude|x|y|z|bbox|fp|rep[xz]|positions?)$/i],
  ['id-key', /(?:^|[_:-])(?:id|uuid|guid|code|ref)$|^canonicalid$/i],
  ['name-or-address-key', /^(?:name|title|label|addr(?:ess)?|street|city|ward|住所|名称)(?::.*)?$|^addr:/i],
  ['free-text-key', /^(?:description|desc|note|notes|memo|comment|comments|remarks?|text|body|content|備考|メモ)$/i],
];
const SRC_META_KEY = /licen[cs]e|attribution|copyright|source|provenance|generator|odbl|publisher|dataset/i;
function keyClass(key) {
  if (key === null) return 'array-element(no-key)';
  for (const [c, re] of KEY_CLASSES) if (re.test(key)) return c;
  return 'other-key';
}
// Walks a parsed JSON value iteratively. Returns aggregate counts only.
function fieldTriage(root, detectorType) {
  const det = k.DETECTORS.find((d) => d.type === (detectorType || 'jp-phone-number'));
  if (!det) throw new Error('unknown detector');
  const agg = { byKeyClass: {}, byValueForm: {}, byPrefix: {}, matchTotal: 0, stringsScanned: 0, sourceMetaKeyOccurrences: 0, topLevelSourceMeta: 0 };
  const bump = (o, key) => { o[key] = (o[key] || 0) + 1; };
  const stack = [[root, null, 0]];
  while (stack.length) {
    const [v, key, depth] = stack.pop();
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) stack.push([v[i], key, depth + 1]); continue; }
    if (typeof v === 'object') {
      for (const kk of Object.keys(v)) {
        if (SRC_META_KEY.test(kk)) { agg.sourceMetaKeyOccurrences++; if (depth === 0) agg.topLevelSourceMeta++; }
        stack.push([v[kk], kk, depth + 1]);
      }
      continue;
    }
    const isNum = typeof v === 'number';
    const str = isNum ? String(v) : (typeof v === 'string' ? v : null);
    if (str === null) continue;
    if (!isNum) agg.stringsScanned++;
    const re = new RegExp(det.re.source, det.re.flags); let m;
    while ((m = re.exec(str))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      agg.matchTotal++;
      const whole = m[0].length === str.trim().length;
      bump(agg.byValueForm, isNum ? 'bare-number-value' : (whole ? 'whole-value' : 'embedded-in-longer-text'));
      bump(agg.byKeyClass, keyClass(key));
      bump(agg.byPrefix, prefixClass(m[0].replace(/^\+81[- ]?/, '0').replace(/-/g, '')));
    }
  }
  const kc = agg.byKeyClass, vf = agg.byValueForm, pf = agg.byPrefix;
  const personalRisk = (pf['mobile(070/080/090)'] || 0) + (pf['ip-phone(050)'] || 0);
  const reasons = [];
  if (personalRisk) reasons.push('mobile/ip-phone prefixes present (possible personal number)');
  if (vf['embedded-in-longer-text']) reasons.push('numbers embedded in free text');
  if (kc['free-text-key']) reasons.push('matches under memo/description-like keys');
  if (kc['other-key'] || kc['name-or-address-key'] || kc['array-element(no-key)'] || kc['id-key'] || kc['coordinate-key']) reasons.push('matches under keys that are not contact keys (unknown purpose)');
  let recommendation;
  if (agg.matchTotal === 0) recommendation = 'no-match-with-current-detector';
  else if (reasons.length) recommendation = 'HOLD: do not transfer this file until the owner has reviewed it locally';
  else recommendation = 'owner-review-required: all matches are under contact-like keys (possible public facility contact); publish only if the source licence allows';
  return { matches: agg.matchTotal, stringsScanned: agg.stringsScanned, byKeyClass: kc, byValueForm: vf, byPrefix: pf,
    nonContactKeyMatches: agg.matchTotal - (kc['contact-key'] || 0),
    sourceMetadata: { keyOccurrences: agg.sourceMetaKeyOccurrences, presentAtTopLevel: agg.topLevelSourceMeta > 0 },
    holdReasons: reasons, recommendation };
}
function parseJsonLoose(text) {
  try { return { value: JSON.parse(text), form: 'json' }; } catch (e) { /* maybe ndjson */ }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return null;
  const arr = [];
  for (const l of lines) { try { arr.push(JSON.parse(l)); } catch (e) { return null; } }
  return { value: arr, form: 'ndjson' };
}
function fieldsFile(o) {
  const m = k.loadJson(o.manifest); const roots = k.loadJson(o.rootsFile);
  for (const f of k.manifestFiles(m)) {
    const { root, rel } = k.splitPath(f.path);
    if (k.fid(root, rel) !== o.id) continue;
    const ext = k.extOf(rel);
    if (!/^\.?(?:json|geojson|jsonl|ndjson)$/i.test(ext)) return { error: 'not-a-json-file(use classify)' };
    if (!roots[root]) return { error: 'root-not-given' };
    const full = path.join(roots[root], ...rel.split('/'));
    let st; try { st = fs.statSync(full); } catch (e) { return { error: 'unreadable-or-cloud-only' }; }
    if (st.size > 128 * MIB) return { error: 'over-128MiB-not-parsed' };
    let text; try { text = fs.readFileSync(full, 'utf8'); } catch (e) { return { error: 'unreadable-or-cloud-only' }; }
    const parsed = parseJsonLoose(text.replace(/^﻿/, ''));
    if (!parsed) return { error: 'json-parse-failed(use classify)' };
    const r = fieldTriage(parsed.value, o.detector);
    return Object.assign({ id: o.id, category: f.category, ext: ext || '(none)', detector: o.detector || 'jp-phone-number', parsedAs: parsed.form }, r,
      { autoApproved: false, autoExcluded: false, note: 'counts and classes only: no value, key name, path or context is printed. Never a safe verdict.' });
  }
  return { error: 'id-not-in-manifest' };
}

// ---------- glb-meta: JSON chunk only ----------
const STD_EXT = /^(?:KHR|EXT|MSFT|CESIUM|NV|ADOBE|AGI)_[A-Za-z0-9_]{1,60}$/;
function glbJsonChunk(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') return { status: 'not-glb' };
  const total = buf.readUInt32LE(8);
  const len = buf.readUInt32LE(12); const type = buf.readUInt32LE(16);
  if (type !== 0x4E4F534A) return { status: 'first-chunk-not-json' };
  if (len > 8 * MIB) return { status: 'json-chunk-too-large' };
  if (20 + len > buf.length) return { status: 'truncated' };
  const text = buf.toString('latin1', 20, 20 + len);
  const counts = {};
  for (const d of k.DETECTORS) {
    const re = new RegExp(d.re.source, d.re.flags); let m;
    while ((m = re.exec(text))) { if (!m[0].length) { re.lastIndex++; continue; } counts[d.type] = (counts[d.type] || 0) + 1; }
  }
  let j = null; try { j = JSON.parse(buf.toString('utf8', 20, 20 + len)); } catch (e) { /* malformed */ }
  const info = { status: j ? 'json-chunk-inspected' : 'json-malformed', declaredLength: total, detections: counts, binChunkInspected: false };
  if (j) {
    info.hasExtras = /"extras"\s*:/.test(text);
    info.hasAssetCopyright = !!(j.asset && j.asset.copyright);
    info.hasDataUri = /"uri"\s*:\s*"data:/.test(text);
    info.hasExternalUri = /"uri"\s*:\s*"(?!data:)/.test(text);
    const names = [].concat(j.extensionsUsed || []);
    info.extensionsUsed = names.filter((n) => STD_EXT.test(n)).sort();
    info.nonStandardExtensionCount = names.filter((n) => !STD_EXT.test(n)).length;
  }
  return info;
}
function globalGlbMeta(o) {
  const m = k.loadJson(o.manifest); const roots = k.loadJson(o.rootsFile);
  const skip = new Set(o.skipFile ? fs.readFileSync(o.skipFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).map((s) => s.replace(/\\/g, '/').toLowerCase()) : []);
  const needle = o.pathContains ? o.pathContains.toLowerCase() : null;
  const agg = {}; const findings = []; const status = {}; let n = 0;
  for (const f of k.manifestFiles(m)) {
    if (k.extOf(f.path) !== 'glb') continue;
    if (needle && !f.path.toLowerCase().includes(needle)) continue;
    if (o.maxFiles && n >= o.maxFiles) break;
    const { root, rel } = k.splitPath(f.path); n++;
    const a = (agg[f.category] = agg[f.category] || { files: 0, hasExtras: 0, hasAssetCopyright: 0, hasDataUri: 0, hasExternalUri: 0, detections: {}, extensionsUsed: {} });
    a.files++;
    let r;
    if (!roots[root]) r = { status: 'root-not-given' };
    else if (skip.has((root + '/' + rel).toLowerCase())) r = { status: 'cloud-only-not-read' };
    else {
      let fd; try { fd = fs.openSync(path.join(roots[root], ...rel.split('/')), 'r'); } catch (e) { fd = null; }
      if (fd === null) r = { status: 'unreadable-or-cloud-only' };
      else {
        try {
          const head = Buffer.alloc(20); const got = fs.readSync(fd, head, 0, 20, 0);
          const len = got >= 20 ? head.readUInt32LE(12) : 0;
          const cap = Math.min(len, 8 * MIB + 1);
          const buf = Buffer.alloc(20 + cap); head.copy(buf, 0, 0, Math.min(got, 20));
          if (got >= 20 && cap > 0) fs.readSync(fd, buf, 20, cap, 20);
          r = glbJsonChunk(buf);
        } catch (e) { r = { status: 'read-error' }; } finally { fs.closeSync(fd); }
      }
    }
    status[r.status] = (status[r.status] || 0) + 1;
    if (r.hasExtras) a.hasExtras++; if (r.hasAssetCopyright) a.hasAssetCopyright++; if (r.hasDataUri) a.hasDataUri++; if (r.hasExternalUri) a.hasExternalUri++;
    for (const e of r.extensionsUsed || []) a.extensionsUsed[e] = (a.extensionsUsed[e] || 0) + 1;
    const real = Object.entries(r.detections || {});
    if (real.length) { for (const [t, c] of real) a.detections[t] = (a.detections[t] || 0) + c; findings.push({ id: k.fid(root, rel), category: f.category, detections: Object.fromEntries(real) }); }
  }
  return {
    tool: 'mission41l-triage glb-meta', scannerVersion: k.SCANNER_VERSION, glbFiles: n, status, byCategory: agg, filesWithFindings: findings.slice(0, 200), filesWithFindingsTotal: findings.length,
    verdictForBinChunk: 'BIN chunks (geometry/textures) were NOT inspected: these GLB files stay UNSCANNED in the 41K gates. This only checks the JSON metadata chunk.',
    gates: { noSecretsReviewed: false, noPersonalDataReviewed: false, readyToUpload: false }, autoApproved: false,
  };
}

function arg(argv, key) { const i = argv.indexOf(key); return i >= 0 ? argv[i + 1] : undefined; }
function run(argv) {
  const cmd = argv[0];
  if (cmd === 'report') {
    const rp = arg(argv, '--report'); if (!rp) throw new Error('--report is required');
    const report = k.loadJson(rp); let extra = null;
    const mf = arg(argv, '--manifest'), sf = arg(argv, '--state');
    if (mf && sf) { const st = k.loadJson(sf); extra = { crosstab: crosstab(k.loadJson(mf), st), stateVersionMismatch: st.scannerVersion !== k.SCANNER_VERSION || st.detectorFingerprint !== k.detectorFingerprint() }; }
    const view = reportView(report, extra);
    const out = arg(argv, '--out'); if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(view, null, 1), { flag: 'wx' });
    console.log(JSON.stringify(view, null, 1)); return 0;
  }
  if (cmd === 'classify') {
    const o = { manifest: arg(argv, '--manifest'), rootsFile: arg(argv, '--roots-file'), id: arg(argv, '--id'), detector: arg(argv, '--detector') };
    if (!o.manifest || !o.rootsFile || !/^[0-9a-f]{8}$/.test(o.id || '')) throw new Error('--manifest, --roots-file and --id (8 hex) are required');
    const r = classifyFile(o); console.log(JSON.stringify(r, null, 1)); return r.error ? 1 : 0;
  }
  if (cmd === 'fields') {
    const o = { manifest: arg(argv, '--manifest'), rootsFile: arg(argv, '--roots-file'), id: arg(argv, '--id'), detector: arg(argv, '--detector') };
    if (!o.manifest || !o.rootsFile || !/^[0-9a-f]{8}$/.test(o.id || '')) throw new Error('--manifest, --roots-file and --id (8 hex) are required');
    const r = fieldsFile(o); console.log(JSON.stringify(r, null, 1)); return r.error ? 1 : 0;
  }
  if (cmd === 'glb-meta') {
    const o = { manifest: arg(argv, '--manifest'), rootsFile: arg(argv, '--roots-file'), pathContains: arg(argv, '--path-contains') || '', skipFile: arg(argv, '--skip-file'), maxFiles: Number(arg(argv, '--max-files')) || 0 };
    if (!o.manifest || !o.rootsFile) throw new Error('--manifest and --roots-file are required');
    const r = globalGlbMeta(o); console.log(JSON.stringify(r, null, 1)); return r.filesWithFindingsTotal ? 2 : 0;
  }
  throw new Error('usage: report | classify | fields | glb-meta');
}
module.exports = { keyClass, parseJsonLoose, SRC_META_KEY, kindOf, crosstab, reportView, classifyMatches, classifyFile, fieldTriage, fieldsFile, glbJsonChunk, globalGlbMeta, run };
if (require.main === module) { try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); } }
