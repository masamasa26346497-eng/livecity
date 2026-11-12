#!/usr/bin/env node
// Mission 109: READ-ONLY report. Joins Mission106 progress-matrix with 2025 fetch/QA summaries (counts-only JSON) and the known prior run.
//   node tools/mission109/merge-matrix.mjs [--matrix data/reports/mission106/progress-matrix.json] [--fetch f.json ...] [--qa q.json ...] [--run-id N] [--out file.json]
// Three levels are kept SEPARATE per ward: storedVerified (archive sha256 + integrity), ciBrowserQaPass (headless CI), ownerDeviceAccepted (always false here).
// Anything without evidence stays "unverified". Stored != rendered: storedVerified never implies ciBrowserQaPass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_WARDS, PRIOR_RUN, wardCodeOf } from './wards.mjs';

export function buildReport({ matrix, fetches = [], qas = [], runId = null }) {
  const rows = [];
  const byId = new Map((matrix.wards || []).map((w) => [w.wardId, w]));
  for (const w of ALL_WARDS) {
    const base = byId.get(w);
    if (!base) throw new Error('ward missing in matrix: ' + w);
    if (base.wardCode !== wardCodeOf(w)) throw new Error('ward code mismatch: ' + w);
    const f = [...fetches].reverse().map((s) => s.wards && s.wards[w]).find(Boolean);
    const q = [...qas].reverse().map((s) => s.wards && s.wards[w]).find(Boolean);
    const stored = f && f.status === 'verified';
    const qaPass = q && q.status === 'pass';
    const prior = PRIOR_RUN.wards.includes(w);
    rows.push({
      wardId: w, wardCode: base.wardCode,
      storedVerified: stored ? 'verified-in-supplied-summary' : (prior ? 'reported-by-run-' + PRIOR_RUN.runId + '-summary-not-in-repo' : 'unverified'),
      archiveSha256: stored ? f.archiveSha256 : 'unverified',
      tilesetSha256: stored ? f.tilesetSha256 : 'unverified',
      ciBrowserQaPass: qaPass ? 'pass-in-supplied-summary' : (prior ? 'reported-by-run-' + PRIOR_RUN.runId + '-summary-not-in-repo' : (q ? q.status : 'unverified')),
      qaChecks: q && q.checks ? q.checks : 'unverified',
      roadWaterAlignment: 'unverified', // archives carry no layers/; see MISSION109_README.md Phase B
      evidenceRunId: stored || qaPass ? runId : (prior ? PRIOR_RUN.runId : null),
      ownerDeviceAccepted: false,
    });
  }
  return {
    mission: 109, readOnly: true, generatedFrom: ['mission106/progress-matrix.json', 'supplied fetch/qa summaries', 'PRIOR_RUN constant'],
    counts: {
      wards: rows.length,
      storedVerifiedFromSummaries: rows.filter((r) => r.storedVerified === 'verified-in-supplied-summary').length,
      ciBrowserQaPassFromSummaries: rows.filter((r) => r.ciBrowserQaPass === 'pass-in-supplied-summary').length,
      reportedByPriorRunOnly: PRIOR_RUN.wards.length,
      ownerDeviceAccepted: 0,
    },
    priorRun: PRIOR_RUN,
    wards: rows,
  };
}

function main() {
  const a = process.argv.slice(2);
  const all = (k) => a.flatMap((x, i) => (x === '--' + k ? [a[i + 1]] : []));
  const one = (k, d = null) => all(k)[0] ?? d;
  const matrix = JSON.parse(fs.readFileSync(one('matrix', 'data/reports/mission106/progress-matrix.json'), 'utf8'));
  const rep = buildReport({ matrix, fetches: all('fetch').map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))), qas: all('qa').map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))), runId: one('run-id') });
  const out = one('out');
  const text = JSON.stringify(rep, null, 1);
  if (out) { if (fs.existsSync(out)) { console.error('FAIL: refusing to overwrite ' + out); process.exit(2); } fs.writeFileSync(out, text); }
  console.log(JSON.stringify(rep.counts));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
