#!/usr/bin/env node
// Mission 193: 24区の公式PLATEAU2025 LOD1を同一tempデータセット(temp/mission79/<ward>-2025)へ1区ずつ生成する resumable オーケストレータ。
//   node tools/lod2/lod2-all-wards.mjs [--wards a,b] [--max-mb 1500] [--expected 615234] [--report <path>]
// 各区: 生成 -> 検証(build-report/source/tileset/全GLB存在/sha256) -> state.json に登録。検証済みの区は再生成しない(resume)。
// 区ごとの作業ディレクトリ(GML/JSONL)は検証後に削除し、ディスクを積み上げない。公開repoへは小型レポートのみ。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

export function verifyWard(dir, code) {
  const p = [];
  for (const n of ['tileset.json', 'source.json', 'build-report.json', 'tiles']) if (!fs.existsSync(path.join(dir, n))) p.push('missing ' + n);
  if (p.length) return { ok: false, problems: p };
  const rep = JSON.parse(fs.readFileSync(path.join(dir, 'build-report.json'), 'utf8'));
  const src = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
  const ts = JSON.parse(fs.readFileSync(path.join(dir, 'tileset.json'), 'utf8'));
  if (String(src.wardCode) !== String(code)) p.push('source.wardCode ' + src.wardCode + ' != ' + code);
  const t = rep.totals || {};
  if (!(t.buildings > 0)) p.push('totals.buildings<=0');
  const uris = [];
  (function walk(n) { if (!n) return; if (n.content && n.content.uri) uris.push(n.content.uri); (n.children || []).forEach(walk); })(ts.root);
  let glbBytes = 0, missing = 0;
  for (const u of uris) { const f = path.join(dir, u); if (!fs.existsSync(f)) missing++; else glbBytes += fs.statSync(f).size; }
  if (missing) p.push(missing + ' GLB missing');
  if (!uris.length) p.push('no content uris');
  return { ok: p.length === 0, problems: p, buildings: t.buildings, uniqueCanonicalIds: t.uniqueCanonicalIds == null ? null : t.uniqueCanonicalIds, skipped: t.skipped == null ? null : t.skipped, fallback: t.fallback == null ? null : t.fallback, contentTiles: uris.length, glbBytes, tilesetSha256: sha(path.join(dir, 'tileset.json')) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
  const ids = opt('wards') ? opt('wards').split(',') : reg.map((w) => w.id);
  const maxMb = opt('max-mb', '1500');
  const expected = Number(opt('expected', 615234));
  const stateFile = path.join(ROOT, 'temp/all-wards/state.json');
  const reportFile = path.resolve(ROOT, opt('report', 'data/reports/mission193/all-wards-build.json'));
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { wards: {} };
  const t00 = Date.now();
  for (const id of ids) {
    const w = reg.find((x) => x.id === id);
    if (!w) { console.error('unknown ward', id); continue; }
    const dir = path.join(ROOT, 'temp/mission79', id + '-2025');
    let v = fs.existsSync(dir) ? verifyWard(dir, w.code) : { ok: false };
    if (v.ok) {
      state.wards[id] = Object.assign({}, v, { code: w.code, resumed: true, status: 'verified' });
      console.error('[all-wards] ' + id + ' resume ok ' + v.buildings);
    } else {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); // 不完全な残骸のみ(temp限定)
      const t0 = Date.now(), m0 = os.freemem();
      const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/mission79-run.mjs'), '--ward', id, '--max-mb', maxMb], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
      const sec = +((Date.now() - t0) / 1000).toFixed(1);
      v = fs.existsSync(dir) ? verifyWard(dir, w.code) : { ok: false, problems: ['no output'] };
      state.wards[id] = Object.assign({}, v, { code: w.code, seconds: sec, exit: r.status, status: v.ok && r.status === 0 ? 'verified' : 'failed', freeMemDeltaMB: Math.round((m0 - os.freemem()) / 1048576) });
      fs.rmSync(path.join(ROOT, 'temp/mission79', id + '-work'), { recursive: true, force: true });
      console.error('[all-wards] ' + id + ' ' + state.wards[id].status + ' ' + v.buildings + ' bldg ' + sec + 's ' + (v.problems || []).join(';'));
    }
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
  }
  const done = ids.filter((i) => state.wards[i] && state.wards[i].status === 'verified');
  const total = done.reduce((n, i) => n + state.wards[i].buildings, 0);
  const wards = {};
  for (const i of ids) wards[i] = state.wards[i];
  const rep = { mission: 193, data: 'REAL PLATEAU 2025 LOD1 via tools/mission79-run.mjs', runner: { cpus: os.cpus().length, totalMemMB: Math.round(os.totalmem() / 1048576) }, expectedTotal: expected, verifiedWards: done.length, requestedWards: ids.length, totalBuildings: total, matchesExpected: total === expected, failed: ids.filter((i) => !done.includes(i)), elapsedSec: Math.round((Date.now() - t00) / 1000), wards };
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(rep, null, 1));
  console.log(JSON.stringify(Object.assign({}, rep, { wards: undefined }), null, 1));
  process.exit(rep.failed.length ? 2 : 0);
}
