#!/usr/bin/env node
// Mission 83B: Windows/PC 向け 24 区閲覧ランチャー（127.0.0.1 限定、1 コマンド）。
//   node tools/mission83-local-all.mjs [--wards a,b] [--port 8137] [--max-wards N] [--deadline-min M] [--no-convert] [--serve-only] [--dry-run]
// 1) 未変換の区を tools/mission80-batch.mjs で順に同期変換（再開可能。取得元は source-lock 済みの公式 PLATEAU 2025 のみ。万博 27999 は対象外）
// 2) 変換済み全区を tools/mission81-local-preview.mjs --ward all で 127.0.0.1 に配信
// バックグラウンド/detached 処理は使わない。子プロセスは execFileSync / spawnSync で同期待機し、終了コードを確認する。
// 区の失敗は隠さず一覧表示する。全 24 区が揃うまでは「完成」とは表示しない。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HOST = '127.0.0.1';
export const MANIFEST = 'data/reports/mission80/batch-manifest.json';
export const WARD_COUNT = 24;

export function parseArgs(a) {
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : d; };
  const has = (k) => a.includes('--' + k);
  const o = { wards: opt('wards'), port: opt('port', '8137'), maxWards: opt('max-wards'), deadlineMin: opt('deadline-min'),
    noConvert: has('no-convert') || has('serve-only'), dryRun: has('dry-run') };
  if (!/^\d+$/.test(String(o.port)) || Number(o.port) < 1024 || Number(o.port) > 65535) throw new Error('invalid --port');
  if (o.wards && !/^[a-z]+(,[a-z]+)*$/.test(o.wards)) throw new Error('invalid --wards');
  return o;
}

export function batchArgs(o) {
  const args = ['tools/mission80-batch.mjs'];
  if (o.wards) args.push('--wards', o.wards);
  if (o.maxWards) args.push('--max-wards', String(Number(o.maxWards)));
  if (o.deadlineMin) args.push('--deadline-min', String(Number(o.deadlineMin)));
  return args;
}

export function serveArgs(o) { return ['tools/mission81-local-preview.mjs', '--ward', 'all', '--port', String(o.port)]; }

export function summarize(man) {
  const w = (man && man.wards) || {};
  const ok = Object.keys(w).filter((k) => w[k].status === 'ok');
  const failed = Object.keys(w).filter((k) => w[k].status === 'failed');
  return { ok, failed, buildings: ok.reduce((n, k) => n + (w[k].buildings || 0), 0), complete: ok.length >= WARD_COUNT };
}

function run(args) {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: process.cwd() });
  return r.status === null ? 1 : r.status;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.dryRun) { console.log(JSON.stringify({ host: HOST, batch: o.noConvert ? null : batchArgs(o), serve: serveArgs(o) })); return; }
  if (!o.noConvert) {
    const code = run(batchArgs(o));
    if (code !== 0) console.error('[83] batch exit ' + code + ' (some wards failed; successful wards are still served)');
  }
  const man = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null;
  const s = summarize(man);
  console.log('[83] converted wards in manifest: ' + s.ok.length + '/' + WARD_COUNT + ' buildings=' + s.buildings + (s.failed.length ? ' failed=' + s.failed.join(',') : ''));
  if (!s.complete) console.log('[83] NOT complete: acceptance requires all ' + WARD_COUNT + ' wards.');
  console.log('[83] open http://' + HOST + ':' + o.port + '/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1');
  process.exitCode = run(serveArgs(o));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); }
}
