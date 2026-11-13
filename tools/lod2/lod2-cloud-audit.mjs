#!/usr/bin/env node
// Mission 199: bundle audit used by the cloud workflow. node lod2-cloud-audit.mjs <bundleDir> <maxBytes>
import fs from 'node:fs';
import path from 'node:path';

const [dir, max] = process.argv.slice(2);
if (!dir || !max) { console.error('usage: lod2-cloud-audit.mjs <bundleDir> <maxBytes>'); process.exit(2); }
const SECRET = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|VERCEL_TOKEN)/;
let bytes = 0, n = 0; const hits = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else if (e.isFile()) {
    const st = fs.statSync(p); bytes += st.size; n++;
    if (!/\.(glb|png|jpg|jpeg|webp)$/i.test(e.name) && st.size < 20e6 && SECRET.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(dir, p));
  } } };
walk(dir);
const m = JSON.parse(fs.readFileSync(path.join(dir, 'BUNDLE_MANIFEST.json'), 'utf8'));
const errs = [];
if (!m.rights || m.rights.confirmedByHuman !== false) errs.push('rights.confirmedByHuman must stay false in the artifact');
if (bytes > Number(max)) errs.push(`bundle ${bytes} bytes exceeds ${max}`);
if (hits.length) errs.push('secret-like strings in: ' + hits.join(', '));
console.log(JSON.stringify({ files: n, bytes, rights: m.rights && m.rights.status, confirmedByHuman: m.rights && m.rights.confirmedByHuman, secretHits: hits.length }));
if (errs.length) { console.error('[cloud-audit] NG:', errs.join('; ')); process.exit(1); }
