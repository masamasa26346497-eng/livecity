#!/usr/bin/env node
'use strict';
// Mission 158: PLATEAU 2025 ward-by-ward pre-acceptance inventory (READ-ONLY, no network, no conversion).
//   node tools/mission158-ward2025-inventory.cjs [--local <dir>] [--exclude nishi] [--out <json>] [--md <md>]
// Evidence is taken ONLY from files tracked in this repo (never from 2022/2024 data or fixtures):
//   source-lock (M79)  : data/reports/mission79/source-lock.json   -> upstream ZIP identity (central directory only, NOT the GML bodies)
//   runner conversion  : data/reports/mission80/batch-manifest.json -> converted on a CI runner (temp, not committed)
//   runner e2e (M80)   : data/reports/mission80-ward2025/e2e.json
//   CI log summary(M140): data/reports/mission140/run42438843605-acceptance.json (21 wards, private release assets, headless software GL)
// Anything not provable from those files is reported as "unverified" (null). Nothing is inferred.
// --local <dir> : optionally scan an owner-PC output root (<dir>/<ward>*/source.json + tileset.json). Read-only.
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const rj = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const has = (p) => fs.existsSync(path.join(ROOT, p));

function walk(dir, hit, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, hit, out); else if (hit(e.name)) out.push(p);
  }
  return out;
}

// Git-tracked servable 2025 tilesets: a tileset.json whose sibling source.json says vintage 2025.
function trackedVintage2025() {
  const found = {};
  for (const f of walk(path.join(ROOT, 'public'), (n) => n === 'source.json', [])) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
    if (String(j.vintage) !== '2025') continue;
    if (!fs.existsSync(path.join(path.dirname(f), 'tileset.json'))) continue;
    found[String(j.wardCode)] = path.relative(ROOT, path.dirname(f));
  }
  return found;
}

function scanLocal(dir, wards) {
  const res = {};
  if (!dir || !fs.existsSync(dir)) return null;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const w of wards) {
    const cand = subs.filter((n) => n === w.wardId || n.startsWith(w.wardId + '-') || n.startsWith(w.wardId + '2'));
    for (const n of cand) {
      const sp = path.join(dir, n, 'source.json');
      if (!fs.existsSync(sp)) continue;
      let s; try { s = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (e) { continue; }
      res[w.wardId] = { dir: n, vintage: s.vintage || null, wardCode: s.wardCode || null,
        tilesetJson: fs.existsSync(path.join(dir, n, 'tileset.json')),
        sourceEtag: s.sourceEtag || null };
    }
  }
  return res;
}

function build(opts) {
  const polys = rj('data/processed/osaka-city/boundaries/ward-classification-polygons.json');
  const wards = polys.wards.map((w) => ({ wardId: w.wardId, wardCode: String(w.wardCode) })).sort((a, b) => a.wardCode.localeCompare(b.wardCode));
  const exclude = new Set((opts.exclude || 'nishi').split(',').filter(Boolean));
  const lock = has('data/reports/mission79/source-lock.json') ? rj('data/reports/mission79/source-lock.json') : null;
  const man = has('data/reports/mission80/batch-manifest.json') ? rj('data/reports/mission80/batch-manifest.json') : { wards: {} };
  const e2e = has('data/reports/mission80-ward2025/e2e.json') ? rj('data/reports/mission80-ward2025/e2e.json') : { wards: [] };
  const m140 = has('data/reports/mission140/run42438843605-acceptance.json') ? rj('data/reports/mission140/run42438843605-acceptance.json') : null;
  const tracked = trackedVintage2025();
  const local = scanLocal(opts.local, wards);
  const m140row = {};
  if (m140) for (const r of m140.wards) m140row[r[0]] = { glb200: r[1], pixelDiffPct: r[2], click: r[3], coverage: r[4], verdict: r[5] };
  const e2eRow = {};
  for (const w of e2e.wards) e2eRow[w.ward] = w;

  const rows = [];
  for (const w of wards) {
    if (exclude.has(w.wardId)) continue;
    const mb = man.wards && man.wards[w.wardId];
    const m = m140row[w.wardId];
    const e = e2eRow[w.wardId];
    rows.push({
      wardId: w.wardId, wardCode: w.wardCode,
      // 1) upstream source: the 2025 ZIP identity is locked, but GML bodies are NOT in Git
      source2025: { zipLocked: !!lock, gmlBodiesInGit: false, state: lock ? 'zip-identity-only (central directory); GML not verifiable from Git' : 'unverified' },
      // 2) converted: runner-side batch (M80) and/or CI log (M140). Neither is a committed artifact.
      converted: mb
        ? (mb.status === 'ok'
          ? { state: 'ok-on-runner (not committed)', buildings: mb.buildings, uniqueIds: mb.uniqueIds, idsUnique: mb.idsUnique, meshes: mb.meshes, outBytes: mb.outBytes, evidence: 'mission80/batch-manifest.json' }
          : { state: 'FAILED on runner', error: String(mb.error || '').slice(0, 80), evidence: 'mission80/batch-manifest.json' })
        : (m ? { state: 'ok per CI log (21/21 archives, dataOk)', buildings: null, evidence: 'mission140/run42438843605-acceptance.json' }
          : { state: 'no evidence in Git', buildings: null }),
      // 3) servable: only a Git-tracked 2025 tileset counts
      servableInGit: tracked[w.wardId] || tracked[w.wardCode] ? { state: 'yes', dir: tracked[w.wardId] || tracked[w.wardCode] } : { state: 'no (no tracked vintage-2025 tileset)' },
      http200: m ? { state: 'glb200 per CI log', glb200: m.glb200 } : (e ? { state: 'M80 e2e (aggregate http200=' + e2e.http200 + ')' } : { state: 'none' }),
      webglPixelDiff: m ? { state: 'headless software GL (CI log)', pct: m.pixelDiffPct, click: m.click } : { state: 'none' },
      wardAlignment: { state: 'unverified', note: 'M140 log has no per-ward N03 check (notProvenByLog)' },
      coverage: m ? { state: 'source-count ratio only, not in-browser proof', value: m.coverage } : { state: 'none' },
      browserVerdict: m ? m.verdict : (e && e.pass ? 'M80 e2e pass (single local run)' : 'not evaluated'),
      ownerPc: local ? (local[w.wardId] || { state: 'not found under --local' }) : { state: 'unverified (--local not given; PC-only data cannot be checked from Git)' },
    });
  }
  const tally = (f) => rows.filter(f).length;
  const summary = {
    wardsListed: rows.length,
    excluded: [...exclude],
    zipIdentityLocked: !!lock,
    convertedOkOnRunner: tally((r) => /^ok/.test(r.converted.state)),
    convertedFailedOnRunner: tally((r) => /FAILED/.test(r.converted.state)),
    servableInGit: tally((r) => r.servableInGit.state === 'yes'),
    browserAcceptedPerCiLog: tally((r) => r.browserVerdict === 'ACCEPTED'),
    browserNotAccepted: rows.filter((r) => r.browserVerdict === 'NOT ACCEPTED').map((r) => r.wardId),
    noEvidenceAtAll: rows.filter((r) => /no evidence/.test(r.converted.state)).map((r) => r.wardId),
    wardAlignmentProven: 0,
    note: '24/24 browser acceptance is NOT established. Converted data lives in runner temp / private release assets, not in Git.',
  };
  const needBatch = rows.filter((r) => r.servableInGit.state !== 'yes' && !/^ok/.test(r.converted.state)).map((r) => r.wardId);
  const plan = {
    nonDestructive: true, executed: false,
    note: 'PLAN ONLY. Existing batch (M80) skips status=ok wards and never overwrites; raw GML is deleted only from its own work dir.',
    wardsNeedingConversionEvidence: needBatch,
    ownerPcCommand: 'node tools/mission158-ward2025-inventory.cjs --local <your 3DTiles output root>   (read-only; prints which wards have vintage-2025 tileset.json)',
    existingBatchCommand: needBatch.length ? 'node tools/mission80-batch.mjs --wards ' + needBatch.join(',') + ' --max-mb 1200   (NOT run here)' : 'none needed',
  };
  return { schema: 'livecity.mission158.ward2025-inventory/1', generatedFrom: 'git-tracked evidence only', summary, plan, rows };
}

function toMd(r) {
  const L = ['# Mission 158 ward2025 inventory (read-only)', '', '| ward | converted | servable(Git) | HTTP200 | pixel diff | alignment | coverage | verdict |', '|---|---|---|---|---|---|---|---|'];
  for (const x of r.rows) L.push(['', x.wardId, x.converted.state + (x.converted.buildings ? ' ' + x.converted.buildings : ''), x.servableInGit.state, x.http200.glb200 != null ? x.http200.glb200 : x.http200.state,
    x.webglPixelDiff.pct != null ? x.webglPixelDiff.pct + '%' : 'none', x.wardAlignment.state, x.coverage.value || 'none', x.browserVerdict, ''].join(' | ').trim());
  return L.join('\n') + '\n\n```json\n' + JSON.stringify(r.summary, null, 1) + '\n```\n';
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const r = build({ local: opt('local'), exclude: opt('exclude', 'nishi') });
  const out = opt('out', 'data/reports/mission158-ward2025/inventory.json');
  const md = opt('md', 'data/reports/mission158-ward2025/inventory.md');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(r, null, 1));
  fs.writeFileSync(md, toMd(r));
  console.log(JSON.stringify(r.summary, null, 1));
  console.log(JSON.stringify(r.plan, null, 1));
}
module.exports = { build, toMd };
