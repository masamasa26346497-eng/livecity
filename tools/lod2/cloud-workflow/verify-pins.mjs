#!/usr/bin/env node
// Mission 201: verify that every `uses: owner/repo@<40hex> # vX.Y.Z` pin in the v2 workflow
// really is the commit of that tag. Needs network (run on your PC, not in the sandbox).
//   node tools/lod2/cloud-workflow/verify-pins.mjs [file]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = process.argv[2] || new URL('./lod2-cloud-preview.v2.yml', import.meta.url).pathname;
const text = fs.readFileSync(file, 'utf8');
const re = /uses:\s*([\w.-]+\/[\w.-]+)@([0-9a-f]{40})\s*#\s*(v[\w.]+)/g;
const seen = new Set(); let bad = 0, m;
while ((m = re.exec(text))) {
  const [, repo, sha, tag] = m; const key = `${repo}@${sha}`;
  if (seen.has(key)) continue; seen.add(key);
  const out = execFileSync('git', ['ls-remote', `https://github.com/${repo}`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: 'utf8' });
  const shas = out.split('\n').filter(Boolean).map(l => l.split('\t')[0]);
  const ok = shas.includes(sha);
  console.log(`${ok ? 'OK ' : 'NG '} ${repo} ${tag} pinned=${sha} remote=${shas.join(',') || 'none'}`);
  if (!ok) bad++;
}
if (/__VERCEL_CLI_VERSION__/.test(text)) { console.log('TODO VERCEL_CLI_VERSION placeholder still present'); bad++; }
process.exit(bad ? 1 : 0);
