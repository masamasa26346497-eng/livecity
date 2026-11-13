#!/usr/bin/env node
// Mission 85: 24 区 2025 ローカル表示の無通信 preflight（read-only）。
//   node tools/mission85-preflight.mjs [--root temp/mission80] [--json] [--out <file>] [--free-gb N]
// 入力は既存の source-lock / N03 区ポリゴン / area 設定 / batch-manifest / ローカル出力の有無のみ。
// ネットワーク・子プロセス・削除・書き込み(--out 指定時の JSON 1 ファイルを除く)は行わない。
// 区が artifactReady（変換物の準備状態。ブラウザ受入ではない）になる条件: manifest が ok かつ <root>/out/<ward>-2025/tileset.json が存在。どちらか欠ければ未達として表示する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectMeshes } from './mission79-run.mjs';

export const WARD_COUNT = 24;
export const BATCH_DEFAULT_MAX_MB = 1200; // tools/mission80-batch.mjs の --max-mb 既定。展開量がこれを超える区は既定では失敗する。
const EXPO = '27999';

// lock から区ごとの bldg/tran メッシュ集計。tran 欠落は "bldg あり tran なし" として明示（隠さない）。
export function planWard(lock, ward, projection) {
  const sel = selectMeshes(lock, ward, projection);
  const by = (kind, m) => lock.entries.find((e) => e.kind === kind && e.mesh === m);
  // 区 bbox に掛かるが bldg を持たない（tran のみ）メッシュ。mission79-run は bldg 起点なので取得されない。隠さず警告に出す。
  const anyKind = selectMeshes({ ...lock, entries: lock.entries.map((e) => ({ ...e, kind: 'bldg' })) }, ward, projection).meshes;
  const tranOnly = anyKind.filter((m) => !sel.meshes.includes(m));
  let comp = 0, infl = 0; const noTran = [], noBldg = [];
  for (const m of sel.meshes) {
    const b = by('bldg', m), t = by('tran', m);
    if (!b) noBldg.push(m); else { comp += b.compressedBytes; infl += b.uncompressedBytes; }
    if (t) { comp += t.compressedBytes; infl += t.uncompressedBytes; } else noTran.push(m);
  }
  return { wardId: ward.wardId, wardCode: String(ward.wardCode), meshes: sel.meshes.length, meshList: sel.meshes,
    noTranMeshes: noTran, noBldgMeshes: noBldg, tranOnlyMeshes: tranOnly, compressedMB: +(comp / 1048576).toFixed(1), inflatedMB: +(infl / 1048576).toFixed(1) };
}

export function classify(plan, man, root, fsx = fs) {
  const mw = (man && man.wards && man.wards[plan.wardId]) || null;
  const tileset = path.join(root, 'out', plan.wardId + '-2025', 'tileset.json');
  const hasLocal = fsx.existsSync(tileset);
  const manifestStatus = mw ? mw.status : 'none';
  // artifactReady = 変換物の準備状態のみ（manifest ok ＋ tileset 存在）。実ブラウザ描画の受入ではない。
  const artifactReady = manifestStatus === 'ok' && hasLocal;
  const reasons = [];
  if (!hasLocal) reasons.push('local output missing');
  if (manifestStatus !== 'ok') reasons.push('manifest=' + manifestStatus);
  if (manifestStatus === 'ok' && !hasLocal) reasons.push('manifest ok but output not on this PC (not artifact-ready)');
  if (plan.noBldgMeshes.length) reasons.push('BLOCKER: bldg missing in lock for ' + plan.noBldgMeshes.join(','));
  return { manifestStatus, hasLocal, artifactReady, reasons, buildings: mw && mw.buildings || null };
}

export function buildReport({ lock, polys, area, man, root, freeGb = null, fsx = fs }) {
  const plans = polys.wards.map((w) => planWard(lock, w, area.projection)).sort((a, b) => a.wardCode.localeCompare(b.wardCode));
  const rows = plans.map((p) => ({ ...p, ...classify(p, man, root, fsx) }));
  const total = (k) => +rows.reduce((n, r) => n + r[k], 0).toFixed(1);
  // 隣接区で共有されるメッシュは区ごとに重複取得されるため、ユニークなメッシュ数も別に出す。
  const uniq = new Set(rows.flatMap((r) => r.meshList));
  const uniqIn = lock.entries.filter((e) => uniq.has(e.mesh) && (e.kind === 'bldg' || e.kind === 'tran')).reduce((n, e) => n + e.uncompressedBytes, 0) / 1048576;
  const overCap = rows.filter((r) => r.inflatedMB > BATCH_DEFAULT_MAX_MB).map((r) => ({ ward: r.wardId, inflatedMB: r.inflatedMB, note: '既定 --max-mb ' + BATCH_DEFAULT_MAX_MB + ' を超える。--max-mb を上げないと失敗する' }));
  const ready = rows.filter((r) => r.artifactReady).length;
  const peak = Math.max(...rows.map((r) => r.inflatedMB));
  const outEst = +(rows.reduce((n, r) => n + r.inflatedMB, 0) * 0.035).toFixed(0);
  const report = {
    mission: '85-preflight', network: false, vintage: 2025, lockEtag: lock.http && lock.http.etag, expoExcluded: EXPO,
    wardsPlanned: rows.length, wardsArtifactReady: ready, artifactsReady: rows.length === WARD_COUNT && ready === WARD_COUNT,
    browserAccepted: false, browserAcceptanceNote: 'preflight never judges browser acceptance; use tools/mission86-acceptance.mjs',
    totals: { meshesSumPerWard: rows.reduce((n, r) => n + r.meshes, 0), meshesUnique: uniq.size, compressedMBPerWardSum: total('compressedMB'),
      inflatedMBPerWardSum: total('inflatedMB'), inflatedMBUniqueMeshes: +uniqIn.toFixed(1) },
    disk: { peakWorkMBPerWard: peak, note: 'work GML は区ごとに成功後削除。必要な空きの目安 = 最大区の展開量 x 1.5 + 出力。出力はmanifest 実績(都島 27MB/911MB 等 約3%)に余裕を見た概算 3.5%。未確定', outputEstimateMB: outEst,
      recommendedFreeMB: Math.ceil(peak * 1.5 + outEst), freeGb },
    overDefaultCap: overCap,
    noTranWarnings: rows.filter((r) => r.noTranMeshes.length).map((r) => ({ ward: r.wardId, meshes: r.noTranMeshes, severity: 'warn', note: 'bldg あり・tran なし（公式パッケージに無い）。tran は補助。bldg 欠落とは区別' })),
    tranOnlyWarnings: rows.filter((r) => r.tranOnlyMeshes.length).map((r) => ({ ward: r.wardId, meshes: r.tranOnlyMeshes, severity: 'warn', note: 'tran のみ（bldg なし）。建物変換では取得されない' })),
    blockers: rows.filter((r) => r.noBldgMeshes.length || r.meshes === 0).map((r) => ({ ward: r.wardId, meshes: r.noBldgMeshes, note: r.meshes === 0 ? 'no bldg mesh intersects the ward bbox' : 'bldg missing' })),
    wards: rows,
  };
  if (freeGb != null && freeGb * 1024 < report.disk.recommendedFreeMB) report.diskInsufficient = true;
  return report;
}

export function formatText(r) {
  const L = [];
  L.push('[85] preflight (no network) wards=' + r.wardsPlanned + ' artifactReady=' + r.wardsArtifactReady + '/' + WARD_COUNT + ' artifactsReady=' + r.artifactsReady + ' browserAccepted=false (not judged here)');
  L.push('ward code ward          meshes noTran infl(MB) comp(MB) manifest local artifact');
  for (const w of r.wards) L.push([w.wardCode, w.wardId.padEnd(14), String(w.meshes).padStart(6), String(w.noTranMeshes.length).padStart(6), String(w.inflatedMB).padStart(8), String(w.compressedMB).padStart(8), w.manifestStatus.padEnd(8), (w.hasLocal ? 'yes' : 'NO').padEnd(5), w.artifactReady ? 'ARTIFACT-READY(not browser-accepted)' : 'not-ready'].join(' '));
  L.push('total meshes(per-ward sum)=' + r.totals.meshesSumPerWard + ' unique=' + r.totals.meshesUnique + ' inflated(per-ward sum)=' + r.totals.inflatedMBPerWardSum + 'MB unique=' + r.totals.inflatedMBUniqueMeshes + 'MB');
  L.push('disk: peak work/ward=' + r.disk.peakWorkMBPerWard + 'MB recommended free>=' + r.disk.recommendedFreeMB + 'MB (estimate)');
  for (const n of r.noTranWarnings) L.push('WARN no tran: ' + n.ward + ' mesh ' + n.meshes.join(',') + ' (bldg present; tran absent in official package)');
  for (const o of r.overDefaultCap) L.push('WARN over default --max-mb: ' + o.ward + ' ' + o.inflatedMB + 'MB (use --max-mb ' + Math.ceil(o.inflatedMB / 100) * 100 + ')');
  for (const t of r.tranOnlyWarnings) L.push('WARN tran-only (no bldg, not fetched): ' + t.ward + ' ' + t.meshes.join(','));
  for (const b of r.blockers) L.push('BLOCKER ' + b.ward + ': ' + b.note + ' ' + b.meshes.join(','));
  if (r.diskInsufficient) L.push('BLOCKER disk: free ' + r.disk.freeGb + 'GB < recommended');
  if (!r.artifactsReady) L.push('NOT artifact-ready for all 24 wards.');
  L.push('NOTE: artifact-ready is NOT acceptance. Real-browser acceptance: node tools/mission86-acceptance.mjs');
  return L.join('\n');
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : d; };
  const root = path.resolve(opt('root', 'temp/mission80'));
  const rd = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const man = fs.existsSync('data/reports/mission80/batch-manifest.json') ? rd('data/reports/mission80/batch-manifest.json') : null;
  const r = buildReport({ lock: rd('data/reports/mission79/source-lock.json'), polys: rd('data/processed/osaka-city/boundaries/ward-classification-polygons.json'),
    area: rd('config/areas/osaka-city.json'), man, root, freeGb: opt('free-gb') ? Number(opt('free-gb')) : null });
  if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify(r, null, 1));
  console.log(a.includes('--json') ? JSON.stringify(r, null, 1) : formatText(r));
  if (r.blockers.length || r.diskInsufficient) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); }
}
