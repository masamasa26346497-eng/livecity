#!/usr/bin/env node
// Mission 218: 引き継ぎドキュメントの軽量検証（ネットワーク・Secrets不要）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VOCAB = ['verified', 'implemented_unverified', 'blocked', 'missing', 'unknown'];
export const REQUIRED_DOCS = ['docs/HANDOFF.md', 'docs/ASSET_REGISTRY.md', 'docs/DEVELOPMENT_STATUS.md'];
const SECRET_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /Bearer\s+[A-Za-z0-9._-]{20,}/];

export function validate(root) {
  const errors = [];
  const read = (p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return null; } };
  const docs = {};
  for (const p of REQUIRED_DOCS) {
    docs[p] = read(p);
    if (docs[p] === null) errors.push(`missing doc: ${p}`);
  }
  const claude = read('CLAUDE.md');
  if (claude === null || !claude.includes('docs/HANDOFF.md')) errors.push('CLAUDE.md must link docs/HANDOFF.md');

  const registry = JSON.parse(read('config/wards/registry.json') || '{"wards":[]}');
  const ids = registry.wards.map((w) => w.id);
  if (ids.length !== 24) errors.push(`registry has ${ids.length} wards, expected 24`);
  const reg = docs['docs/ASSET_REGISTRY.md'];
  if (reg) for (const id of ids) if (!new RegExp(`\\b${id}\\b`).test(reg)) errors.push(`ASSET_REGISTRY missing ward id: ${id}`);

  const st = docs['docs/DEVELOPMENT_STATUS.md'];
  if (st) {
    for (const line of st.split('\n')) {
      if (!line.startsWith('|') || /^\|[\s-|]+$/.test(line)) continue;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      const hit = cells.filter((c) => VOCAB.includes(c));
      const claimsState = cells.some((c) => /^(verified|implemented_unverified|blocked|missing|unknown|done|ok|complete|完了)$/i.test(c));
      if (claimsState && hit.length === 0) errors.push(`invalid state word in row: ${line}`);
      if (cells.includes('verified') && !/https?:\/\/|[\w./-]+\.(md|js|json|yml)/.test(cells[cells.length - 1])) {
        errors.push(`verified row without evidence link: ${line}`);
      }
    }
    if (!VOCAB.every((v) => st.includes(v))) errors.push('DEVELOPMENT_STATUS must define the full vocabulary');
  }
  for (const [p, t] of Object.entries(docs)) {
    if (!t) continue;
    for (const re of SECRET_PATTERNS) if (re.test(t)) errors.push(`possible secret in ${p}`);
    for (const m of t.matchAll(/\]\((?!https?:|#|\.|\/)[^)\s]*\)/g)) errors.push(`malformed link in ${p}: ${m[0]}`);
  }
  const ho = docs['docs/HANDOFF.md'];
  if (ho) for (const k of ['READ-FIRST', 'WRITE-BACK', '24区', '観光優先']) if (!ho.includes(k)) errors.push(`HANDOFF missing keyword: ${k}`);
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = validate(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('handoff-docs: OK');
}
