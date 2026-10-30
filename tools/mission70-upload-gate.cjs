#!/usr/bin/env node
'use strict';
// Mission 70 P0: upload approval gate. This file contains NO network code, reads NO credentials, and cannot upload.
// It only decides whether a future uploader would be allowed to start, and prints a dry-run plan (counts/bytes) from a manifest.
//   node tools/mission70-upload-gate.cjs --approval <approval.json> [--execute]
// Every gate must be literally true; --execute additionally needs env LIVECITY_UPLOAD_CONFIRM equal to the approval's confirmPhrase.
// Today no approval exists, so every invocation refuses.
const fs = require('fs');

const GATES = ['licenceApproved', 'noSecretsReviewed', 'noPersonalDataReviewed', 'costApproved', 'storageProviderApproved', 'ownerApprovedUpload'];

function evaluate(approval, opts) {
  opts = opts || {};
  const why = [];
  if (!approval || typeof approval !== 'object') return { allowed: false, why: ['no approval file'] };
  for (const g of GATES) if (approval[g] !== true) why.push('gate false: ' + g);
  if (!Number.isFinite(approval.maxMonthlyCostJpy) || approval.maxMonthlyCostJpy <= 0) why.push('no monthly cost cap');
  if (!Number.isFinite(approval.maxTransferBytes) || approval.maxTransferBytes <= 0) why.push('no transfer cap');
  if (!['cloudflare-r2', 'vercel-blob'].includes(approval.provider)) why.push('provider not chosen');
  if (approval.scope !== 'buildings-3dtiles-only') why.push('scope must be buildings-3dtiles-only (roads/rivers need their own ODbL review)');
  if (opts.execute) {
    if (!approval.confirmPhrase || (opts.env || {}).LIVECITY_UPLOAD_CONFIRM !== approval.confirmPhrase) why.push('execute needs matching LIVECITY_UPLOAD_CONFIRM');
  }
  // Even when all gates pass, this module has no uploader: it returns the plan only.
  return { allowed: why.length === 0, why, uploaderImplemented: false, network: 0 };
}

// Dry-run plan: resumable per-ward batches, bounded by the transfer cap. Pure; takes the manifest object.
function plan(manifest, approval, batchBytes) {
  const cap = approval && approval.maxTransferBytes || 0, batches = [];
  let used = 0;
  for (const w of manifest.wards) {
    const todo = w.files.filter((f) => !(approval.alreadyUploaded || {})[w.wardCode + '/' + f.path]); // resume: skip hash-verified files
    let cur = { ward: w.wardCode, files: 0, bytes: 0 };
    for (const f of todo) {
      if (used + f.bytes > cap) return { batches, stoppedByCap: true, planned: used };
      if (cur.bytes + f.bytes > (batchBytes || 64 * 1024 * 1024) && cur.files) { batches.push(cur); cur = { ward: w.wardCode, files: 0, bytes: 0 }; }
      cur.files++; cur.bytes += f.bytes; used += f.bytes;
    }
    if (cur.files) batches.push(cur);
  }
  return { batches, stoppedByCap: false, planned: used };
}

module.exports = { GATES, evaluate, plan };
if (require.main === module) {
  const a = process.argv.slice(2), i = a.indexOf('--approval');
  let ap = null; try { if (i >= 0) ap = JSON.parse(fs.readFileSync(a[i + 1], 'utf8')); } catch (e) { /* refuse */ }
  const r = evaluate(ap, { execute: a.includes('--execute'), env: process.env });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.allowed ? 0 : 3);
}
