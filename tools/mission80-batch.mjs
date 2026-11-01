#!/usr/bin/env node
// Mission 80: PLATEAU 2025 (v5) -> ward 3D Tiles を区ごとに順次実行し、manifest で進捗・再開を管理するバッチ。
//   node tools/mission80-batch.mjs [--wards nishi,kita] [--max-mb 1200] [--root temp/mission80] [--keep-work] [--verify-only]
// - 各区は tools/mission79-run.mjs（source-lock / Range 取得 / N03 点内判定 / 500m tile / 3D Tiles）をそのまま子プロセスで実行する。
// - 出力は <root>/out/<ward>-2025 のみ（既定 temp/mission80, gitignore 済み）。旧 24 区(2022)の出力・public/ は一切書かない。
// - manifest: data/reports/mission80/batch-manifest.json（区ごとの status / 棟数 / unique ID / 区間重複 / 年版 / source ETag / tileset sha256 / 容量 / 所要）。
//   status=ok の区は再実行でスキップ（再開）。失敗した区は error を記録し、部分出力と作業 GML を消して次の区へ進む（--stop-on-fail で停止）。
// - 取得した生 GML は成功後に削除（容量を一定に保つ。--keep-work で保持）。生 GML・GLB は commit しない。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
export const MANIFEST = 'data/reports/mission80/batch-manifest.json';

export function wardIdsFromPolys(polys) { return polys.wards.map((w) => ({ wardId: w.wardId, wardCode: String(w.wardCode) })).sort((a, b) => a.wardCode.localeCompare(b.wardCode)); }

export function readIds(outDir) {
  const d = path.join(outDir, 'ids'); const ids = [];
  // t_*.json = 葉 tile の建物 ID。g_*.json は簡略 LOD（同じ建物の再掲）なので数えない。
  for (const f of fs.readdirSync(d).filter((n) => /^t_.*\.json$/.test(n))) { const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); for (const x of (Array.isArray(j) ? j : (j.ids || []))) ids.push(x); }
  return ids;
}
export function dirBytes(d) { let n = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size; } return n; }
export function sha256File(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

// 区間の ID 重複（同じ gml:id が 2 区に出るか）。境界またぎの二重計数の検出に使う。
export function crossWardDuplicates(idSets) {
  const seen = new Map(); const dup = {};
  for (const [ward, ids] of Object.entries(idSets)) for (const id of ids) { if (seen.has(id) && seen.get(id) !== ward) { const k = [seen.get(id), ward].sort().join('|'); dup[k] = (dup[k] || 0) + 1; } else seen.set(id, ward); }
  return dup;
}

export function summarizeWard(outDir, extra = {}) {
  const rep = JSON.parse(fs.readFileSync(path.join(outDir, 'build-report.json'), 'utf8'));
  const src = JSON.parse(fs.readFileSync(path.join(outDir, 'source.json'), 'utf8'));
  const ids = readIds(outDir);
  const t = rep.totals || {};
  return { status: 'ok', wardCode: src.wardCode, vintage: src.vintage, sourceEtag: src.sourceEtag, sourceBytes: src.sourceBytes, meshes: (src.sourceMeshes || []).length,
    buildings: t.buildings, sourceBuildings: t.sourceBuildings, skipped: t.skipped, fallbacks: t.fallbacks, uniqueIds: new Set(ids).size, idCount: ids.length,
    idsUnique: new Set(ids).size === ids.length && ids.length === t.buildings, glbBytes: t.glbBytes, outBytes: dirBytes(outDir),
    tilesetSha256: sha256File(path.join(outDir, 'tileset.json')), ...extra };
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const root = path.resolve(opt('root', 'temp/mission80'));
  const polys = JSON.parse(fs.readFileSync('data/processed/osaka-city/boundaries/ward-classification-polygons.json', 'utf8'));
  let wards = wardIdsFromPolys(polys);
  if (opt('wards')) { const want = opt('wards').split(','); wards = wards.filter((w) => want.includes(w.wardId)); }
  const man = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { mission: '80', vintage: 2025, wards: {} };
  const save = () => { man.updatedAt = new Date().toISOString(); fs.mkdirSync(path.dirname(MANIFEST), { recursive: true }); const tmp = MANIFEST + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(man, null, 1)); fs.renameSync(tmp, MANIFEST); };
  const lock = JSON.parse(fs.readFileSync('data/reports/mission79/source-lock.json', 'utf8'));
  man.source = { url: lock.resource && lock.resource.url, etag: lock.http && lock.http.etag, bytes: lock.http && lock.http.contentLength, lastModified: lock.http && lock.http.lastModified };
  if (a.includes('--verify-only')) { finalize(man, root, wards); save(); return; }
  // Mission 82B: 各区は execFileSync で同期的に完了を待つ。バックグラウンド/孤児プロセスは使わない。
  // --max-wards N: 今回新規処理する区の上限 / --deadline-min M: 残り時間が足りなければ次の区に着手しない / --ward-timeout-min T: 1区の強制上限(既定25)
  const maxWards = Number(opt('max-wards', 1e9)); const deadline = Date.now() + Number(opt('deadline-min', 1e9)) * 60000; const wardTimeout = Number(opt('ward-timeout-min', 25)) * 60000;
  let processed = 0, failedNow = 0, stoppedBy = null;
  for (const w of wards) {
    const out = path.join(root, 'out', w.wardId + '-2025');
    const work = path.join(root, 'work', w.wardId);
    if (man.wards[w.wardId]?.status === 'ok' && fs.existsSync(path.join(out, 'tileset.json'))) { console.log('[80] skip (ok)', w.wardId); continue; }
    if (processed >= maxWards) { stoppedBy = 'max-wards'; break; }
    if (Date.now() + wardTimeout > deadline) { stoppedBy = 'deadline'; console.log('[80] stop: remaining time < ward timeout'); break; }
    processed++;
    if (fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true }); // 自分の temp 出力のみ（失敗/不完全の再実行）
    const t0 = Date.now();
    console.log('[80] ward', w.wardId, w.wardCode);
    try {
      execFileSync(process.execPath, ['tools/mission79-run.mjs', '--ward', w.wardId, '--max-mb', opt('max-mb', '1200'), '--work', work, '--final', out], { stdio: ['ignore', 'ignore', 'inherit'], cwd: ROOT, maxBuffer: 1 << 28, timeout: wardTimeout, killSignal: 'SIGKILL' });
      man.wards[w.wardId] = summarizeWard(out, { wardId: w.wardId, ms: Date.now() - t0, finishedAt: new Date().toISOString() });
      if (!a.includes('--keep-work')) fs.rmSync(work, { recursive: true, force: true });
    } catch (e) {
      failedNow++;
      man.wards[w.wardId] = { status: 'failed', wardId: w.wardId, wardCode: w.wardCode, error: String(e.message).slice(0, 300), ms: Date.now() - t0 };
      fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true });
      if (a.includes('--stop-on-fail')) { save(); throw e; }
    }
    save();
    const r = man.wards[w.wardId]; console.log('[80]  ->', r.status, r.buildings ?? '', r.ms + 'ms');
  }
  finalize(man, root, wards); man.lastRun = { processed, failedNow, stoppedBy, at: new Date().toISOString() }; save();
  const ok = Object.values(man.wards).filter((x) => x.status === 'ok');
  console.log('[80] done ok=' + ok.length + '/' + wards.length + ' buildings=' + ok.reduce((n, x) => n + x.buildings, 0) + ' processed=' + processed + ' failed=' + failedNow + (stoppedBy ? ' stoppedBy=' + stoppedBy : ''));
  if (failedNow > 0) process.exitCode = 1;
}

function finalize(man, root, wards) {
  const sets = {};
  for (const w of wards) { const r = man.wards[w.wardId]; const out = path.join(root, 'out', w.wardId + '-2025'); if (r?.status === 'ok' && fs.existsSync(path.join(out, 'ids'))) sets[w.wardId] = readIds(out); }
  man.crossWardDuplicateIds = crossWardDuplicates(sets);
  const ok = Object.values(man.wards).filter((x) => x.status === 'ok');
  man.totals = { wardsOk: ok.length, wardsFailed: Object.values(man.wards).filter((x) => x.status === 'failed').length, buildings: ok.reduce((n, x) => n + x.buildings, 0), outBytes: ok.reduce((n, x) => n + x.outBytes, 0) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); }
}
