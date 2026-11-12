// Mission 203: offline test of the vercel.json strict audit embedded in the v2 workflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const y = fs.readFileSync(new URL('../tools/lod2/cloud-workflow/lod2-cloud-preview.v2.yml', import.meta.url), 'utf8');
const deploy = y.slice(y.indexOf('\n  deploy:'));

const auditSrc = (() => {
  const m = y.match(/<<'AUDIT_EOF'\n([\s\S]*?)\n {10}AUDIT_EOF/);
  assert.ok(m, 'audit heredoc present');
  return m[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
})();

const runAudit = (obj) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vj-'));
  const f = path.join(d, 'vercel.json');
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  const s = path.join(d, 'audit.mjs');
  fs.writeFileSync(s, auditSrc);
  return spawnSync(process.execPath, [s, f], { encoding: 'utf8' }).status;
};

// Exactly what tools/lod2/lod2-cloud-bundle.mjs (mission152-lod2-parallel) writes.
const generated = () => ({ cleanUrls: false, trailingSlash: false, headers: [
  { source: '/(.*)\\.glb', headers: [{ key: 'Content-Type', value: 'model/gltf-binary' }, { key: 'Cache-Control', value: 'public, max-age=3600' }] },
  { source: '/(.*)', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] }] });

test('vercel.json is not rejected unconditionally any more', () => {
  assert.doesNotMatch(y, /-o -name 'vercel\.json'/);
  assert.match(y, /BEGIN-VERCEL-JSON-AUDIT/);
});
test('audit accepts the exact generated config (pretty-printed too)', () => {
  assert.equal(runAudit(JSON.stringify(generated(), null, 1)), 0);
});
test('audit rejects redirects / rewrites / env / git / extra headers / bad JSON', () => {
  for (const extra of [
    { redirects: [{ source: '/', destination: 'https://evil.example', permanent: false }] },
    { rewrites: [{ source: '/a', destination: 'https://evil.example/a' }] },
    { routes: [] }, { env: { X: 'y' } }, { git: { deploymentEnabled: true } }, { buildCommand: 'curl x | sh' },
  ]) assert.equal(runAudit({ ...generated(), ...extra }), 1, JSON.stringify(extra));
  const g = generated(); g.headers[1].headers.push({ key: 'Location', value: 'https://evil.example' });
  assert.equal(runAudit(g), 1);
  const h = generated(); h.headers[0].headers[0].value = 'text/html';
  assert.equal(runAudit(h), 1);
  assert.equal(runAudit('{not json'), 1);
});
test('audit runs before the secrets step; root-only single vercel.json required', () => {
  assert.ok(deploy.indexOf('BEGIN-VERCEL-JSON-AUDIT') < deploy.indexOf('Deploy PREVIEW'));
  assert.match(deploy, /exactly one vercel\.json at the bundle root/);
});
test('YAML sanity: no tabs; heredoc terminator sits inside the run block', () => {
  assert.doesNotMatch(y, /\t/);
  assert.match(y, /\n {10}AUDIT_EOF\n/);
});
