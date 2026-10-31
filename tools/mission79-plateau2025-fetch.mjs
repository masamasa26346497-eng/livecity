#!/usr/bin/env node
// Mission 79: non-destructive mesh-level fetch of PLATEAU 2025 (v5) CityGML bldg/tran via HTTP Range.
// Reads data/reports/mission79/source-lock.json (run mission79-plateau2025-source.mjs first).
// usage: node tools/mission79-plateau2025-fetch.mjs --meshes 52350318,52350319 --out <emptyDir>
//        [--kinds bldg,tran] [--max-mb 200] [--dry-run] [--force-etag-mismatch]
// Safety: refuses to write into a non-empty dir unless it holds a previous fetch-manifest.json (resume);
// verifies ETag unchanged vs lock; verifies inflated size + records sha256; stops on first failure; size cap.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { LOCK_PATH, rangeFetch } from './mission79-plateau2025-source.mjs';

function parseArgs(argv) {
  const o = { meshes: [], out: null, kinds: ['bldg', 'tran'], maxMb: 200, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--meshes') o.meshes = argv[++i].split(',');
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--kinds') o.kinds = argv[++i].split(',');
    else if (a === '--max-mb') o.maxMb = Number(argv[++i]);
    else if (a === '--dry-run') o.dryRun = true;
  }
  return o;
}

async function extract(url, e) {
  const h = await rangeFetch(url, e.localOffset, e.localOffset + 29);
  if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header ' + e.name);
  const start = e.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  const comp = await rangeFetch(url, start, start + e.compressedBytes - 1);
  const data = e.method === 8 ? zlib.inflateRawSync(comp) : e.method === 0 ? comp : null;
  if (!data) throw new Error('unsupported method ' + e.method);
  if (data.length !== e.uncompressedBytes) throw new Error('size mismatch ' + e.name);
  return data;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.meshes.length || !o.meshes.every((m) => /^\d{8}$/.test(m))) throw new Error('--meshes required (8-digit mesh codes)');
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const sel = lock.entries.filter((e) => o.meshes.includes(e.mesh) && o.kinds.includes(e.kind));
  const missing = o.meshes.filter((m) => !sel.some((e) => e.mesh === m));
  if (missing.length) throw new Error('meshes not in 2025 lock: ' + missing.join(','));
  const totalMb = sel.reduce((n, e) => n + e.uncompressedBytes, 0) / 1048576;
  const compMb = sel.reduce((n, e) => n + e.compressedBytes, 0) / 1048576;
  console.log('[79 fetch] files=' + sel.length + ' compressed=' + compMb.toFixed(1) + 'MB inflated=' + totalMb.toFixed(1) + 'MB cap=' + o.maxMb + 'MB');
  if (totalMb > o.maxMb) throw new Error('inflated size exceeds cap; raise --max-mb deliberately');
  if (o.dryRun) { console.log('[79 fetch] dry-run: nothing written'); return; }
  if (!o.out) throw new Error('--out required');
  const out = path.resolve(o.out);
  const manifestPath = path.join(out, 'fetch-manifest.json');
  fs.mkdirSync(out, { recursive: true });
  const existing = fs.readdirSync(out);
  if (existing.length && !fs.existsSync(manifestPath)) throw new Error('output dir is non-empty and has no fetch-manifest.json; refusing: ' + out);
  const prev = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: {} };
  // ETag drift check against the locked manifest (HEAD only)
  const head = await fetch(lock.resource.url, { method: 'HEAD' });
  if (head.headers.get('etag') !== lock.http.etag) throw new Error('remote ETag changed since lock; re-run source lock and review');
  const manifest = { mission: '79-plateau2025-fetch', source: lock.resource.url, etag: lock.http.etag, attribution: lock.attribution, license: lock.license.url, files: prev.files };
  for (const e of sel) {
    const dest = path.join(out, path.basename(e.name));
    const done = manifest.files[path.basename(e.name)];
    if (done && fs.existsSync(dest) && fs.statSync(dest).size === e.uncompressedBytes) { console.log('[79 fetch] skip (resume) ' + e.name); continue; }
    const t0 = Date.now();
    const data = await extract(lock.resource.url, e);
    fs.writeFileSync(dest, data);
    manifest.files[path.basename(e.name)] = { kind: e.kind, mesh: e.mesh, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), ms: Date.now() - t0 };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log('[79 fetch] ' + e.name + ' ' + data.length + ' bytes ' + (Date.now() - t0) + 'ms');
  }
  console.log('[79 fetch] done -> ' + out);
}
main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
