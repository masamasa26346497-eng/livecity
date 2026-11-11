#!/usr/bin/env node
// Mission 105: per-ward batch entry for the 3 wards that exceed the 1200MB pre-flight gate (ikuno, abeno, yodogawa).
//   node tools/mission105/chunked-batch.mjs --wards ikuno [--chunk-mb 300] [--max-mb 1200] [--ward-timeout-min 80] [--root temp/mission80]
// It is a drop-in for `tools/mission80-batch.mjs --wards X --max-wards 1`: it writes the SAME output dir (<root>/out/<ward>-2025) and the SAME
// manifest entry shape (via the audited summarizeWard), so mission95-check-output / mission95-persist-ward / mission87-persist run unchanged.
// - Conversion is delegated to tools/mission104/chunked-run.mjs (peak on-disk inflated GML bounded by --chunk-mb; the 1200MB gate is not raised).
// - ONLY ikuno/abeno/yodogawa are accepted. Any other ward id is refused, so the 21 stored wards can never be regenerated through this path.
// - A ward whose manifest entry is already ok (and tileset exists) is skipped. Only this ward's own temp output is removed on retry.
// - Only the target ward's entry in the manifest is added/changed; derived keys (totals/lastRun/source/crossWardDuplicateIds) are recomputed
//   with the same formulas as mission80-batch. No network of its own, no token, no upload, no env access.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarizeWard, crossWardDuplicates, readIds, MANIFEST } from '../mission80-batch.mjs';

export const ALLOWED_WARDS = ['ikuno', 'abeno', 'yodogawa'];
const ROOT = process.cwd();

export function assertAllowed(ward) {
  if (!ALLOWED_WARDS.includes(ward)) throw new Error('ward not allowed in Mission105 chunked path: ' + ward + ' (allowed: ' + ALLOWED_WARDS.join(',') + ')');
}

// Pure: apply one ward result to a manifest object (mutates + returns it). Mirrors mission80-batch finalize().
export function applyResult(man, wardId, entry, opts = {}) {
  const lock = opts.lock, idSets = opts.idSets || {}, processed = opts.processed ?? 1, failedNow = opts.failedNow ?? 0;
  const at = opts.at || new Date().toISOString();
  assertAllowed(wardId);
  man.wards = man.wards || {};
  man.wards[wardId] = entry;
  man.source = { url: lock.resource && lock.resource.url, etag: lock.http && lock.http.etag, bytes: lock.http && lock.http.contentLength, lastModified: lock.http && lock.http.lastModified };
  man.crossWardDuplicateIds = crossWardDuplicates(idSets);
  const all = Object.values(man.wards);
  const ok = all.filter((x) => x && x.status === 'ok');
  man.totals = { wardsOk: ok.length, wardsFailed: all.filter((x) => x && x.status === 'failed').length, buildings: ok.reduce((n, x) => n + x.buildings, 0), outBytes: ok.reduce((n, x) => n + x.outBytes, 0) };
  man.lastRun = { processed, failedNow, stoppedBy: null, at };
  man.updatedAt = at;
  return man;
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const wards = String(opt('wards', '')).split(',').filter(Boolean);
  if (wards.length !== 1) throw new Error('exactly one ward per invocation (--wards <id>)');
  const wardId = wards[0]; assertAllowed(wardId);
  const root = path.resolve(opt('root', 'temp/mission80'));
  const out = path.join(root, 'out', wardId + '-2025'), work = path.join(root, 'work', wardId);
  const man = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { mission: '80', vintage: 2025, wards: {} };
  const lock = JSON.parse(fs.readFileSync('data/reports/mission79/source-lock.json', 'utf8'));
  const save = () => { fs.mkdirSync(path.dirname(MANIFEST), { recursive: true }); const tmp = MANIFEST + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(man, null, 1)); fs.renameSync(tmp, MANIFEST); };
  if (man.wards[wardId]?.status === 'ok' && fs.existsSync(path.join(out, 'tileset.json'))) { console.log('[105] skip (ok)', wardId); return; }
  const wardTimeout = Number(opt('ward-timeout-min', 80)) * 60000;
  if (fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true }); // own temp output only
  const t0 = Date.now();
  let entry, failed = 0;
  try {
    execFileSync(process.execPath, ['tools/mission104/chunked-run.mjs', '--ward', wardId, '--chunk-mb', opt('chunk-mb', '300'), '--max-mb', opt('max-mb', '1200'), '--work', work, '--final', out],
      { stdio: ['ignore', 'inherit', 'inherit'], cwd: ROOT, maxBuffer: 1 << 28, timeout: wardTimeout, killSignal: 'SIGKILL' });
    entry = summarizeWard(out, { wardId, ms: Date.now() - t0, finishedAt: new Date().toISOString(), chunked: true });
    fs.rmSync(work, { recursive: true, force: true });
  } catch (e) {
    failed = 1;
    const polys = JSON.parse(fs.readFileSync('data/processed/osaka-city/boundaries/ward-classification-polygons.json', 'utf8'));
    const hit = polys.wards.find((w) => w.wardId === wardId);
    entry = { status: 'failed', wardId, wardCode: hit ? String(hit.wardCode) : null, error: String(e.message).slice(0, 300), ms: Date.now() - t0 };
    fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true });
  }
  const idSets = {}; if (entry.status === 'ok') idSets[wardId] = readIds(out);
  applyResult(man, wardId, entry, { lock, idSets, processed: 1, failedNow: failed });
  save();
  console.log('[105] ' + wardId + ' -> ' + entry.status + ' ' + (entry.buildings ?? '') + ' ' + entry.ms + 'ms');
  if (failed) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); }
}
