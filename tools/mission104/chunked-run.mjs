#!/usr/bin/env node
// Mission 104: bounded, chunked per-ward conversion for wards whose inflated PLATEAU 2025 GML exceeds the --max-mb safety gate.
//   node tools/mission104/chunked-run.mjs --ward ikuno --chunk-mb 300 --max-mb 1200 --work <dir> --final <new dir> [--dry-run]
// This does NOT raise or bypass the 1200MB gate: --max-mb now bounds PEAK on-disk inflated bytes (all tran + ONE bldg chunk),
// and HARD_TOTAL_MB bounds the TOTAL inflated bytes processed. Audited scripts (mission79-*, mission36k-*) are called unchanged;
// this file is new and is NOT in the Mission101/103 pinned hash closure, so the 21 persisted wards and SHA checks are untouched.
// No secrets, no token, no upload: it only writes under --work / --final (final must be empty or absent). Scratch GML chunk dirs
// (<work>/chunk-N) are deleted after conversion; path-confined.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectMeshes } from '../mission79-run.mjs';

const ROOT = process.cwd();
const T = (f) => path.join(ROOT, 'tools', f);
export const HARD_TOTAL_MB = 1500;
const MB = 1048576;

export function planChunks(entries, meshes, chunkMb) {
  const per = meshes.map((m) => ({ mesh: m, bytes: entries.filter((e) => e.mesh === m && e.kind === 'bldg').reduce((n, e) => n + e.uncompressedBytes, 0) }));
  const cap = chunkMb * MB, chunks = [];
  let cur = null;
  for (const p of per) {
    if (p.bytes > cap) throw new Error('single mesh ' + p.mesh + ' bldg ' + (p.bytes / MB).toFixed(0) + 'MB exceeds --chunk-mb ' + chunkMb);
    if (!cur || cur.bytes + p.bytes > cap) { cur = { meshes: [], bytes: 0 }; chunks.push(cur); }
    cur.meshes.push(p.mesh); cur.bytes += p.bytes;
  }
  return chunks;
}

export function checkChunkGates(entries, meshes, chunks, maxMb, totalMb = HARD_TOTAL_MB) {
  const tranMb = entries.filter((e) => meshes.includes(e.mesh) && e.kind === 'tran').reduce((n, e) => n + e.uncompressedBytes, 0) / MB;
  const peakMb = tranMb + Math.max(0, ...chunks.map((c) => c.bytes / MB));
  const totMb = tranMb + chunks.reduce((n, c) => n + c.bytes / MB, 0);
  if (totalMb > HARD_TOTAL_MB) throw new Error('--max-total-mb above hard ceiling ' + HARD_TOTAL_MB);
  if (peakMb > maxMb) throw new Error('peak inflated ' + peakMb.toFixed(0) + 'MB exceeds --max-mb ' + maxMb);
  if (totMb > totalMb) throw new Error('total inflated ' + totMb.toFixed(0) + 'MB exceeds --max-total-mb ' + totalMb);
  return { tranMb: +tranMb.toFixed(1), peakMb: +peakMb.toFixed(1), totalMb: +totMb.toFixed(1) };
}

export function rmScratch(work, dir) {
  const r = path.resolve(dir), w = path.resolve(work);
  if (!r.startsWith(w + path.sep) || !/chunk-\d+$/.test(r)) throw new Error('refusing to delete outside scratch: ' + r);
  fs.rmSync(r, { recursive: true, force: true });
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const wardId = opt('ward');
  if (!wardId) throw new Error('--ward required');
  const chunkMb = Number(opt('chunk-mb', 300));
  if (!(chunkMb > 0 && chunkMb <= 600)) throw new Error('--chunk-mb must be in (0,600]');
  const maxMb = Number(opt('max-mb', 1200));
  const lock = JSON.parse(fs.readFileSync('data/reports/mission79/source-lock.json', 'utf8'));
  const area = JSON.parse(fs.readFileSync('config/areas/osaka-city.json', 'utf8'));
  const polys = JSON.parse(fs.readFileSync('data/processed/osaka-city/boundaries/ward-classification-polygons.json', 'utf8'));
  const ward = polys.wards.find((w) => w.wardId === wardId);
  if (!ward) throw new Error('unknown ward ' + wardId);
  const meshes = selectMeshes(lock, ward, area.projection).meshes;
  const chunks = planChunks(lock.entries, meshes, chunkMb);
  const gates = checkChunkGates(lock.entries, meshes, chunks, maxMb, Number(opt('max-total-mb', HARD_TOTAL_MB)));
  const plan = { ward: wardId, wardCode: ward.wardCode, meshes: meshes.length, chunkMb, chunks: chunks.length, gates };
  console.log('[104 run] plan ' + JSON.stringify(plan));
  if (a.includes('--dry-run')) return;
  const work = path.resolve(opt('work', path.join('temp', 'mission104', wardId + '-work')));
  const final = path.resolve(opt('final', path.join('temp', 'mission104', wardId + '-2025')));
  if (fs.existsSync(final) && fs.readdirSync(final).length) throw new Error('final output exists and is non-empty: ' + final);
  const run = (args) => execFileSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT, maxBuffer: 1 << 28 });
  const csv = meshes.join(',');
  run([T('mission79-plateau2025-fetch.mjs'), '--meshes', csv, '--kinds', 'tran', '--out', path.join(work, 'tran'), '--max-mb', String(maxMb)]);
  const cdir = path.join(work, 'chunks'); fs.mkdirSync(cdir, { recursive: true });
  const parts = [], rep = [];
  chunks.forEach((c, i) => {
    const id = String(i).padStart(3, '0'), gml = path.join(work, 'chunk-' + i), jl = path.join(cdir, 'c' + id + '.jsonl'), done = path.join(cdir, 'c' + id + '.done');
    parts.push(jl);
    if (fs.existsSync(done) && fs.existsSync(jl)) { console.log('[104 run] chunk ' + i + ' resume skip'); return; }
    run([T('mission79-plateau2025-fetch.mjs'), '--meshes', c.meshes.join(','), '--kinds', 'bldg', '--out', gml, '--max-mb', String(chunkMb)]);
    run([T('mission36k-convert-citygml-runtime.mjs'), '--input', gml, '--output', jl, '--ward-hint', wardId]);
    rmScratch(work, gml);
    fs.writeFileSync(done, JSON.stringify({ meshes: c.meshes, inflatedMB: +(c.bytes / MB).toFixed(1) }) + '\n');
    rep.push({ chunk: i, meshes: c.meshes.length, inflatedMB: +(c.bytes / MB).toFixed(1) });
  });
  const jsonl = path.join(work, wardId + '.jsonl');
  fs.writeFileSync(jsonl, '');
  for (const p of parts) { const t = fs.readFileSync(p, 'utf8'); fs.appendFileSync(jsonl, !t || t.endsWith('\n') ? t : t + '\n'); }
  fs.writeFileSync(path.join(work, 'chunk-report.json'), JSON.stringify({ mission: '104-chunked', chunkMb, gates, chunks: chunks.length, ran: rep }, null, 2) + '\n');
  const b = [T('mission79-build-ward-2025.cjs'), '--ward', wardId, '--jsonl', jsonl, '--tran', path.join(work, 'tran'), '--out', final];
  if (opt('legacy')) b.push('--legacy', opt('legacy'));
  run(b);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); }
}
