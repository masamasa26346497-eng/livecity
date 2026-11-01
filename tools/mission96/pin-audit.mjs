#!/usr/bin/env node
// Mission 96: static audit of the code closure that the pinned persist workflow executes.
//   node tools/mission96/pin-audit.mjs list     -> closure (file list, one per line)
//   node tools/mission96/pin-audit.mjs hashes   -> "<sha256>  <path>" lines (input for sha256sum -c)
//   node tools/mission96/pin-audit.mjs render   -> writes tools/mission96/persist-ward.pinned.workflow.yml from the template
// Read-only except `render`, which writes only that one file. No network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PIN_SHA = '530446ea243b042f43bea0265a23d3b5211307dc';
export const ENTRY = ['tools/mission80-batch.mjs', 'tools/mission95-check-output.mjs', 'tools/mission95-persist-ward.mjs', 'tools/mission87-persist.mjs'];
// Written by the tools at run time, not code: excluded from the hash set.
const RUNTIME_OUTPUTS = new Set(['data/reports/mission87/storage-manifest.json', 'data/reports/mission80/batch-manifest.json']);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function closure(root = ROOT) {
  const seen = new Set(); const missing = [];
  const visit = (rel) => {
    rel = path.posix.normalize(rel.split(path.sep).join('/'));
    if (seen.has(rel) || RUNTIME_OUTPUTS.has(rel)) return;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); return; }
    seen.add(rel);
    if (!/\.(mjs|cjs|js)$/.test(rel)) return;
    const s = fs.readFileSync(abs, 'utf8'); const dir = path.posix.dirname(rel);
    for (const m of s.matchAll(/(?:from\s+|require\(\s*|import\(\s*)['"](\.[^'"]+)['"]/g)) visit(path.posix.join(dir, m[1]));
    for (const m of s.matchAll(/\bT\(\s*'([^']+)'\s*\)/g)) visit('tools/' + m[1]);
    for (const m of s.matchAll(/['"](tools\/[A-Za-z0-9_\-\/]+\.(?:mjs|cjs|js))['"]/g)) visit(m[1]);
    for (const m of s.matchAll(/['"]((?:config|data)\/[A-Za-z0-9_\-\/.]+\.json)['"]/g)) visit(m[1]);
  };
  ENTRY.forEach(visit);
  return { files: [...seen].sort(), missing: missing.sort() };
}
export function sha256(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
export function hashLines(root = ROOT) { const c = closure(root); return { lines: c.files.map((f) => sha256(path.join(root, f)) + '  ' + f), missing: c.missing }; }

function main() {
  const cmd = process.argv[2];
  if (cmd === 'list') { const c = closure(); console.log(c.files.join('\n')); if (c.missing.length) { console.error('MISSING: ' + c.missing.join(', ')); process.exit(1); } }
  else if (cmd === 'hashes') { const h = hashLines(); console.log(h.lines.join('\n')); if (h.missing.length) { console.error('MISSING: ' + h.missing.join(', ')); process.exit(1); } }
  else if (cmd === 'render') {
    const h = hashLines(); if (h.missing.length) throw new Error('missing: ' + h.missing.join(', '));
    const tpl = fs.readFileSync(path.join(ROOT, 'tools/mission96/persist-ward.pinned.workflow.template.yml'), 'utf8');
    const body = h.lines.map((l) => '          ' + l).join('\n');
    fs.writeFileSync(path.join(ROOT, 'tools/mission96/persist-ward.pinned.workflow.yml'), tpl.replaceAll('@@PIN_SHA@@', PIN_SHA).replace('@@HASHES@@', body));
    console.log('rendered, files=' + h.lines.length);
  } else { console.error('usage: list|hashes|render'); process.exit(2); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) { try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); } }
