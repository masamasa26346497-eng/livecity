#!/usr/bin/env node
// Mission 90: ユーザー PC 用「診断 → 不足区の変換 → 実 Chrome 採取 → 受入一覧」の同期オーケストレーター。
//   node tools/mission90-pc-verify.mjs                       # 既定: plan-only（通信・変換・採取・書き込みなし）
//   node tools/mission90-pc-verify.mjs --execute --max-download-mb 3000 --deadline-min 120 [--wards a,b] [--root temp/mission80] [--port 8188] [--max-mb 1400] [--free-gb N]
// 既存ツールを子プロセスで順に呼ぶだけで、変換・採取・判定のロジックは再実装しない:
//   mission85-preflight(buildReport) -> mission80-batch(--wards 1区) -> mission88-collect-evidence(--ward) -> mission86-acceptance。
// 受入判定は mission86 のまま（緩和しない）。この工程は「実行して記録する」だけで、accepted を自分で決めない。
// 中断: Ctrl+C、または data/reports/mission90/STOP ファイルを作る（区の合間に検知）。再実行で続きから。
// 禁止: バックグラウンド実行、削除・コピー、アップロード、Git 操作。CI（CI/GITHUB_ACTIONS/RUNNER_*）では --execute を拒否する。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReport } from './mission85-preflight.mjs';

export const STATE_DIR = 'data/reports/mission90';
export const STATE_FILE = STATE_DIR + '/run-state.json';
export const STOP_FILE = STATE_DIR + '/STOP';
export const ACCEPT_OUT = STATE_DIR + '/acceptance.json';
export const EVIDENCE_DIR = 'data/reports/mission86/evidence';
export const EXTERNAL_HOST = 'plateau.geospatial.jp (公式 PLATEAU 2025, source-lock 済み zip への HTTP Range のみ)';
export const WARD_COUNT = 24;
const WARD_RE = /^[a-z]+$/;

export function parseArgs(a) {
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : d; };
  const num = (k, d) => { const v = opt(k, d); if (v !== null && !/^\d+(\.\d+)?$/.test(String(v))) throw new Error('invalid --' + k); return v === null ? null : Number(v); };
  const o = { execute: a.includes('--execute'), root: opt('root', 'temp/mission80'), wards: opt('wards'), port: String(opt('port', '8188')),
    maxMb: opt('max-mb', '1400'), maxDownloadMb: num('max-download-mb', null), deadlineMin: num('deadline-min', null), freeGb: num('free-gb', null), skipCollect: a.includes('--skip-collect') };
  if (!/^\d+$/.test(o.port) || Number(o.port) < 1024 || Number(o.port) > 65535) throw new Error('invalid --port');
  if (!/^\d+$/.test(String(o.maxMb))) throw new Error('invalid --max-mb');
  if (o.wards) { const l = o.wards.split(','); if (!l.every((w) => WARD_RE.test(w))) throw new Error('invalid --wards'); o.wardList = l; }
  if (o.execute && (o.maxDownloadMb == null || o.deadlineMin == null)) throw new Error('--execute requires explicit --max-download-mb and --deadline-min');
  return o;
}

export function isCi(env = process.env) { return !!(env.CI || env.GITHUB_ACTIONS || Object.keys(env).some((k) => k.startsWith('RUNNER_'))); }

// 純粋: 実行計画。通信しない。
export function buildPlan(report, o, evidenceExists) {
  const sel = report.wards.filter((w) => !o.wardList || o.wardList.includes(w.wardId));
  const rows = sel.map((w) => {
    const needConvert = !w.artifactReady;
    const hasEvidence = evidenceExists(w.wardId);
    return { ward: w.wardId, code: w.wardCode, meshes: w.meshes, needConvert, needCollect: !hasEvidence, hasEvidence,
      downloadMB: needConvert ? w.compressedMB : 0, workMB: needConvert ? w.inflatedMB : 0,
      overMaxMb: needConvert && w.inflatedMB > Number(o.maxMb), blocker: w.noBldgMeshes.length ? 'bldg missing in lock: ' + w.noBldgMeshes.join(',') : null };
  });
  const download = +rows.reduce((n, r) => n + r.downloadMB, 0).toFixed(1);
  const peak = Math.max(0, ...rows.filter((r) => r.needConvert).map((r) => r.workMB));
  return { rows, downloadMBEstimate: download, peakWorkMB: peak, recommendedFreeMB: report.disk.recommendedFreeMB,
    unknownWards: o.wardList ? o.wardList.filter((x) => !report.wards.some((w) => w.wardId === x)) : [] };
}

// 純粋: 実行前ゲート。満たさなければ実行しない理由を返す。
export function gate(plan, o, freeGb, env = process.env) {
  const why = [];
  if (isCi(env)) why.push('CI/runner 環境では --execute を拒否（local-pc 以外は受入証拠にならない）');
  if (plan.unknownWards.length) why.push('unknown wards: ' + plan.unknownWards.join(','));
  for (const r of plan.rows) { if (r.blocker) why.push(r.ward + ': ' + r.blocker); if (r.overMaxMb) why.push(r.ward + ': 展開量 ' + r.workMB + 'MB > --max-mb ' + o.maxMb + '（上げて再実行）'); }
  if (o.maxDownloadMb != null && plan.downloadMBEstimate > o.maxDownloadMb) why.push('取得見込み ' + plan.downloadMBEstimate + 'MB > --max-download-mb ' + o.maxDownloadMb);
  if (freeGb == null) why.push('空き容量を取得できない。--free-gb N を指定');
  else if (freeGb * 1024 < plan.recommendedFreeMB) why.push('空き ' + freeGb + 'GB < 推奨 ' + plan.recommendedFreeMB + 'MB');
  return why;
}

export function freeGbOf(dir, fsx = fs) {
  try { const s = fsx.statfsSync(dir); return +((s.bavail * s.bsize) / 1073741824).toFixed(1); } catch { return null; }
}

export function formatPlan(plan, o, freeGb) {
  const L = ['[90] PLAN (' + (o.execute ? 'execute' : 'plan-only: nothing is fetched, converted, collected or written') + ')'];
  L.push('external access : ' + EXTERNAL_HOST + '（変換が必要な区がある場合のみ。採取は 127.0.0.1 のみ、Google 通信は検知して記録）');
  L.push('local storage   : ' + path.resolve(o.root) + '/ (work, out)  evidence: ' + path.resolve(EVIDENCE_DIR) + '  state: ' + path.resolve(STATE_FILE));
  L.push('download est.   : ' + plan.downloadMBEstimate + ' MB (圧縮, source-lock 値)  peak work/ward: ' + plan.peakWorkMB + ' MB  recommended free: ' + plan.recommendedFreeMB + ' MB  free now: ' + (freeGb == null ? 'unknown' : freeGb + ' GB'));
  L.push('time est.       : 未計測（実測値なし。区ごとの所要は manifest に記録される）。--deadline-min で打ち切り可');
  L.push('ward           meshes convert collect  downloadMB workMB');
  for (const r of plan.rows) L.push(r.ward.padEnd(14) + String(r.meshes).padStart(6) + '  ' + (r.needConvert ? 'YES ' : 'skip') + '    ' + (r.needCollect ? 'YES ' : 'have') + String(r.downloadMB).padStart(10) + String(r.workMB).padStart(8) + (r.blocker ? '  BLOCKER ' + r.blocker : ''));
  L.push('interrupt       : Ctrl+C か ' + STOP_FILE + ' を作成。同じコマンドで再開（変換済み・採取済みの区はスキップ）');
  return L.join('\n');
}

export function stepArgs(kind, ward, o) {
  if (kind === 'convert') return ['tools/mission80-batch.mjs', '--wards', ward, '--max-mb', String(o.maxMb), '--root', o.root];
  if (kind === 'collect') return ['tools/mission88-collect-evidence.mjs', '--ward', ward, '--root', o.root, '--evidence', EVIDENCE_DIR, '--port', o.port];
  if (kind === 'accept') return ['tools/mission86-acceptance.mjs', '--root', o.root, '--evidence', EVIDENCE_DIR, '--out', ACCEPT_OUT];
  throw new Error('unknown step ' + kind);
}

function run(args) { const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: process.cwd() }); return r.status === null ? 1 : r.status; }
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

export function loadState(f = STATE_FILE) { try { return readJson(f); } catch { return { wards: {} }; } }
export function saveState(st, f = STATE_FILE) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(st, null, 1)); }

function main() {
  const o = parseArgs(process.argv.slice(2));
  const man = fs.existsSync('data/reports/mission80/batch-manifest.json') ? readJson('data/reports/mission80/batch-manifest.json') : null;
  const freeGb = o.freeGb != null ? o.freeGb : freeGbOf(fs.existsSync(o.root) ? o.root : '.');
  const report = buildReport({ lock: readJson('data/reports/mission79/source-lock.json'), polys: readJson('data/processed/osaka-city/boundaries/ward-classification-polygons.json'),
    area: readJson('config/areas/osaka-city.json'), man, root: path.resolve(o.root), freeGb });
  const plan = buildPlan(report, o, (w) => fs.existsSync(path.join(EVIDENCE_DIR, w + '.json')));
  console.log(formatPlan(plan, o, freeGb));
  console.log('NOTE: 厳格受入は mission86 のまま（roadWater は独立検証が無い限り未受入）。この工程は受入を緩和しない。');
  if (!o.execute) { console.log('[90] plan-only. 実行するには --execute --max-download-mb N --deadline-min M を明示してください。'); return; }
  const blocked = gate(plan, o, freeGb);
  if (blocked.length) { console.error('[90] REFUSED:\n - ' + blocked.join('\n - ')); process.exitCode = 2; return; }

  const t0 = Date.now(); const st = loadState(); st.startedAt = st.startedAt || new Date().toISOString(); st.wards = st.wards || {};
  let stopped = null;
  for (const r of plan.rows) {
    if (fs.existsSync(STOP_FILE)) { stopped = 'STOP file'; break; }
    if ((Date.now() - t0) / 60000 > o.deadlineMin) { stopped = 'deadline ' + o.deadlineMin + ' min'; break; }
    const s = st.wards[r.ward] = st.wards[r.ward] || {};
    if (r.needConvert) {
      const c = run(stepArgs('convert', r.ward, o)); s.convert = { exit: c, at: new Date().toISOString() };
      if (c !== 0) { s.failed = 'convert exit ' + c; saveState(st); console.error('[90] ' + r.ward + ': convert FAILED (exit ' + c + '); continuing with next ward'); continue; }
    }
    if (o.skipCollect || !r.needCollect) { saveState(st); continue; }
    const k = run(stepArgs('collect', r.ward, o)); s.collect = { exit: k, at: new Date().toISOString() };
    s.failed = k === 0 ? null : 'collect exit ' + k + ' (evidence/failed/ に理由。Chrome 不可・欠損・未達は未受入)';
    saveState(st);
  }
  st.finishedAt = new Date().toISOString(); st.stopped = stopped; saveState(st);
  if (stopped) console.log('[90] stopped: ' + stopped + '. 同じコマンドで再開できます。');
  const acc = run(stepArgs('accept', null, o));
  const failed = Object.entries(st.wards).filter(([, v]) => v.failed).map(([k, v]) => k + ': ' + v.failed);
  if (failed.length) console.log('[90] failures:\n - ' + failed.join('\n - '));
  console.log('[90] acceptance list: ' + path.resolve(ACCEPT_OUT) + ' (mission86 exit ' + acc + '; 0 以外＝全24区の厳格受入は未達)');
  process.exitCode = acc === 0 && !failed.length && !stopped ? 0 : 3;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); }
}
