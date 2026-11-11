#!/usr/bin/env node
// Mission 196B: 公式 PLATEAU 2025 だけから「静的ホスト(Vercel Hobby Preview 等)用 build output」を作る最小ビルド。
//   node tools/cloud/build-cloud-preview.mjs [--wards kita] [--out temp/cloud-preview/static] [--max-mb 1500] [--no-diag]
//
// 入力は公式 PLATEAU 大阪2025 CityGML(HTTP Range)のみ。PC 上の旧データ(45D・OSM・mission37h/38e 等の内蔵サンプル)は読まない:
//   - LOD1: tools/mission79-run.mjs --ward <区>   -> temp/mission79/<区>-2025
//   - LOD2: tools/lod2/lod2-build-all.mjs          -> temp/lod2-cloud   (区の LOD1 メッシュ ∩ LOD2 収録メッシュ)
// 出力(= outputDirectory)は temp/ 配下(gitignore)。GLB/GML は Git に入れない。
// 配置(ローカル serve と同じ URL):  /ext-3dtiles/<区>/…(LOD1)  /lod2-preview/…(LOD2)  /__lod2/diag.json  /mission37g-osaka-24ward-mvp.html
// 37G HTML は「複製に対して」localhost 限定ゲート 4 箇所だけを外す(元の public/ は変更しない)。nobuiltin=1 既定で内蔵旧サンプルは載せない。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyWard } from '../lod2/lod2-all-wards.mjs';
import { auditWard, auditSinglePass } from './lod1-id-audit.mjs';
import { selectMeshes } from '../mission79-run.mjs';
import { buildIndex, shardWards } from './ward-plan.mjs';
import { writeWardManifest, verifyWardDir, checkWardsDistinct } from './ward-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const a = process.argv.slice(2);
const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
// Mission 201: --plan-only は read-only(ネットワーク/生成なし)。ward-plan.mjs に委譲して終了する。
if (a.includes('--plan-only')) {
  const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'ward-plan.mjs'), ...a.filter((x) => x !== '--plan-only')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
// --shard i/n: --wards(省略時 kita)を決定的に n 分割した i 番目だけをビルド(独立バッチ)。
// --resume: 検証済みの既存 LOD1(temp/mission79/<区>-2025)を再利用する(これは既定動作。明示用フラグ)。
// Mission 206: --all-wards は registry 順の全24区。--single-pass(all-wards では既定)は
//   「LOD2 ID を先に確定 → 区ごとに 1 回の変換で補完 LOD1(除外済み)を作り、直後に出力へ移して work/GML を削除」する。
//   従来(--wards のみ)の「全区元LOD1→LOD2→全区再変換」は work/GML を全区ぶん残し再変換が二重になるため 24 区では使わない。
const ALL = a.includes('--all-wards');
const SINGLE = ALL ? !a.includes('--legacy-two-pass') : a.includes('--single-pass');
const regAll = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const wards = shardWards(ALL ? regAll.map((w) => w.id) : (opt('wards', 'kita')).split(',').filter(Boolean), opt('shard'));
// 無料枠ガード(Hobby: build 45 分 / 23GB disk / team deployment storage 10GB。値は ward-plan.mjs の confirmed 側と同じ)
const TIME_BUDGET_MIN = Number(opt('time-budget-min', ALL ? '38' : '0'));   // 45 分上限の手前で自主停止(0=無効)
const MAX_OUT_MB = Number(opt('max-out-mb', ALL ? '6000' : '0'));           // 1 デプロイ出力の自主上限(0=無効)
const MIN_FREE_GB = Number(opt('min-free-gb', ALL ? '4' : '0'));            // 各区の変換前に必要な空きディスク
const EXPECTED_TOTAL = Number(opt('expected', ALL ? '615234' : '0'));      // 全24区の元LOD1 棟数(Mission193 実測)。0=検証しない
const RESUME = a.includes('--resume');
const OUT = path.resolve(ROOT, opt('out', 'temp/cloud-preview/static'));
const maxMb = opt('max-mb', '1500');
const LOD2_DIR = path.join(ROOT, 'temp/lod2-cloud');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
if (!/[\\/]temp[\\/]|[\\/]\.vercel[\\/]output[\\/]static/.test(OUT + path.sep)) throw new Error('--out は temp/ か .vercel/output/static 配下のみ: ' + OUT);
const log = (...m) => console.error('[cloud-build]', ...m);
const run = (script, args) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 1 << 28 });
  if (r.status !== 0 && !(script.includes('lod2-build-all') && r.status === 2)) throw new Error(script + ' failed (exit ' + r.status + ')');
  return r.status;
};
const reg = regAll;
const t0 = Date.now();
const cp = (s, d) => fs.cpSync(s, d, { recursive: true, dereference: false });
const dirBytes = (d) => { let n = 0; if (!fs.existsSync(d)) return 0; for (const e of fs.readdirSync(d, { recursive: true, withFileTypes: true })) if (e.isFile()) n += fs.statSync(path.join(e.parentPath || e.path, e.name)).size; return n; };
const freeGB = () => { const f = fs.statfsSync(ROOT); return (f.bavail * f.bsize) / 1073741824; };
const extRoot = path.join(OUT, 'ext-3dtiles');
const wardInfo = [];
let lod2Meshes, lod2Rep, lod2Ids, lod2Manifest;

if (SINGLE) {
  // ---- 1S. LOD2 を先に確定(区の対象メッシュ = ward bbox 選定 ∩ LOD2 収録メッシュ。LOD1 を先に作らない) ----
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/mission79/source-lock.json'), 'utf8'));
  const area = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/areas/osaka-city.json'), 'utf8'));
  const polys = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/processed/osaka-city/boundaries/ward-classification-polygons.json'), 'utf8'));
  const plans = wards.map((id) => {
    const w = reg.find((x) => x.id === id); if (!w) throw new Error('unknown ward ' + id);
    const poly = polys.wards.find((x) => x.wardId === id); if (!poly) throw new Error('no ward polygon ' + id);
    if (String(poly.wardCode) !== String(w.code)) throw new Error(id + ': wardCode mismatch');
    const sel = selectMeshes(lock, poly, area.projection);
    if (!sel.meshes.length) throw new Error(id + ': 公式 2025 のソースメッシュが 0 件(24区源の欠落)');
    const ents = lock.entries.filter((e) => sel.meshes.includes(e.mesh) && (e.kind === 'bldg' || e.kind === 'tran'));
    return { id, w, meshes: sel.meshes, inflatedMB: ents.reduce((n, e) => n + e.uncompressedBytes, 0) / 1048576 };
  });
  const cov = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/mission159/lod2-coverage-osaka2025.json'), 'utf8'));
  const lod2Set = new Set(cov.perMesh.filter((r) => r.lod2Any > 0).map((r) => r.mesh));
  lod2Meshes = [...new Set(plans.flatMap((p) => p.meshes))].filter((m) => lod2Set.has(m)).sort();
  if (!lod2Meshes.length) throw new Error('選択区に LOD2 収録メッシュがありません');
  log('single-pass: LOD2 を先に生成', lod2Meshes.length, 'メッシュ / 区', wards.length, '/ 空きディスク', freeGB().toFixed(1) + 'GB');
  fs.mkdirSync(LOD2_DIR, { recursive: true });
  run('tools/lod2/lod2-build-all.mjs', ['--out', rel(LOD2_DIR), '--meshes', lod2Meshes.join(','), '--resume', '--report-dir', rel(path.join(LOD2_DIR, 'report'))]);
  lod2Rep = JSON.parse(fs.readFileSync(path.join(LOD2_DIR, 'report.json'), 'utf8'));
  if (!(lod2Rep.converted > 0)) throw new Error('LOD2 が 0 棟');
  lod2Manifest = path.join(LOD2_DIR, 'manifest.json');
  if (!fs.existsSync(lod2Manifest)) throw new Error('LOD2 manifest.json がありません');
  lod2Ids = new Set(JSON.parse(fs.readFileSync(lod2Manifest, 'utf8')).assets.flatMap((x) => x.ids || []));
  if (!lod2Ids.size) throw new Error('LOD2 manifest に ID が無い');
  // ---- 2S. 区ごとに 1 回の変換(LOD2 同 ID 除外済み)→ 直ちに出力へ移動 → work/GML 削除 ----
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(extRoot, { recursive: true });
  const peak = { workGB: 0, minFreeGB: freeGB() };
  const wardSecs = [];
  for (const [i, p] of plans.entries()) {
    const free = freeGB();
    const needGB = Math.max(MIN_FREE_GB, (p.inflatedMB * 2) / 1024);   // 展開 GML + JSONL + 出力の概算(estimated)
    if (MIN_FREE_GB && free < needGB) throw new Error(`${p.id}: 空きディスク不足 ${free.toFixed(1)}GB < 必要概算 ${needGB.toFixed(1)}GB(無料枠を超える前に停止)`);
    const outMB = dirBytes(OUT) / 1048576;
    if (MAX_OUT_MB && outMB > MAX_OUT_MB) throw new Error(`出力 ${outMB.toFixed(0)}MB が自主上限 ${MAX_OUT_MB}MB 超(停止)`);
    const elapsedMin = (Date.now() - t0) / 60000;
    if (wardSecs.length) {
      const avg = wardSecs.reduce((x, y) => x + y, 0) / wardSecs.length;
      const projMin = elapsedMin + (avg * (plans.length - i)) / 60;
      log(`進捗 ${i}/${plans.length} 経過 ${elapsedMin.toFixed(1)}分 残り推定 ${(projMin - elapsedMin).toFixed(1)}分 出力 ${outMB.toFixed(0)}MB 空き ${free.toFixed(1)}GB`);
      if (TIME_BUDGET_MIN && projMin > TIME_BUDGET_MIN) throw new Error(`時間ガード: 完了推定 ${projMin.toFixed(1)}分 > ${TIME_BUDGET_MIN}分(Hobby build 45 分上限の手前で停止。完了済み ${i} 区。--shard で分割)`);
    }
    const tw = Date.now();
    const id = p.id, w = p.w;
    const sdir = path.join(ROOT, 'temp/mission79', id + '-2025-supp');
    const workDir = path.join(ROOT, 'temp/mission79', id + '-work');
    fs.rmSync(sdir, { recursive: true, force: true }); fs.rmSync(workDir, { recursive: true, force: true });
    log(`[${i + 1}/${plans.length}] 公式2025 取得+変換(1 回・LOD2同ID除外済み):`, id);
    try {
      run('tools/mission79-run.mjs', ['--ward', id, '--max-mb', maxMb, '--final', sdir, '--exclude-ids', lod2Manifest]);
      peak.workGB = Math.max(peak.workGB, dirBytes(workDir) / 1073741824); peak.minFreeGB = Math.min(peak.minFreeGB, freeGB());
      const v = verifyWard(sdir, w.code);
      if (!v.ok) throw new Error('LOD1 verification failed for ' + id + ': ' + (v.problems || []).join(';'));
      const src = JSON.parse(fs.readFileSync(path.join(sdir, 'source.json'), 'utf8'));
      if (Number(src.vintage) !== 2025) throw new Error(id + ': source.vintage != 2025');
      const excluded = src.counts.excludedForLod2 | 0;
      const audit = auditSinglePass({ id, suppDir: sdir, lod2Ids, suppBuildings: v.buildings, excludedCount: excluded, inWard: src.counts.inWard });
      log('ID 監査 OK:', JSON.stringify(audit));
      const d = path.join(extRoot, id);
      fs.mkdirSync(d, { recursive: true });
      for (const n of ['tileset.json', 'source.json', 'build-report.json', 'tiles', 'lod', 'ids', 'attrs']) if (fs.existsSync(path.join(sdir, n))) cp(path.join(sdir, n), path.join(d, n));
      wardInfo.push({ id, name: w.name, code: w.code, dir: d, fullBuildings: audit.origIds, buildings: v.buildings, contentTiles: v.contentTiles, glbBytes: v.glbBytes, source: src, excludedForLod2: excluded, idAudit: audit, idAuditedIds: audit.suppIds, doubleDrawn: audit.doubleDrawn });
    } finally {
      fs.rmSync(sdir, { recursive: true, force: true }); fs.rmSync(workDir, { recursive: true, force: true });   // 直ちに cleanup
    }
    wardSecs.push((Date.now() - tw) / 1000);
  }
  const total = wardInfo.reduce((n, w) => n + w.fullBuildings, 0);
  log(`元LOD1 合計 ${total} = 補完LOD1 ${wardInfo.reduce((n, w) => n + w.buildings, 0)} + LOD2同ID除外 ${wardInfo.reduce((n, w) => n + w.excludedForLod2, 0)} / work 最大 ${peak.workGB.toFixed(2)}GB / 最小空き ${peak.minFreeGB.toFixed(1)}GB`);
  if (EXPECTED_TOTAL && wards.length === regAll.length && total !== EXPECTED_TOTAL) throw new Error(`元LOD1 合計 ${total} ≠ 期待 ${EXPECTED_TOTAL}(Mission193 実測と不整合。--expected 0 で無効化可)`);
} else {
// ---- 1. LOD1(公式 2025) ---- (従来 two-pass。3 区程度向け)
for (const id of wards) {
  const w = reg.find((x) => x.id === id);
  if (!w) throw new Error('unknown ward ' + id);
  const dir = path.join(ROOT, 'temp/mission79', id + '-2025');
  let v = fs.existsSync(dir) ? verifyWard(dir, w.code) : { ok: false };
  if (!v.ok) {
    if (RESUME && fs.existsSync(dir)) log('--resume: 既存 LOD1 が検証不合格のため作り直し:', id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    log('LOD1 生成(公式 PLATEAU 2025, Range 取得):', id);
    run('tools/mission79-run.mjs', ['--ward', id, '--max-mb', maxMb]);
    v = verifyWard(dir, w.code); // work ディレクトリは補完 LOD1 生成(2b)で再利用するため、ここでは消さない
  }
  if (!v.ok) throw new Error('LOD1 verification failed for ' + id + ': ' + (v.problems || []).join(';'));
  const src = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
  if (Number(src.vintage) !== 2025) throw new Error(id + ': source.vintage != 2025');
  wardInfo.push({ id, name: w.name, code: w.code, dir, fullBuildings: v.buildings, buildings: v.buildings, contentTiles: v.contentTiles, glbBytes: v.glbBytes, source: src });
}

// ---- 2. LOD2(公式 2025。区のメッシュ ∩ LOD2 収録メッシュ) ----
const cov = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/mission159/lod2-coverage-osaka2025.json'), 'utf8'));
const lod2Set = new Set(cov.perMesh.filter((r) => r.lod2Any > 0).map((r) => r.mesh));
lod2Meshes = [...new Set(wardInfo.flatMap((w) => w.source.sourceMeshes))].filter((m) => lod2Set.has(m)).sort();
if (!lod2Meshes.length) throw new Error('選択区に LOD2 収録メッシュがありません');
log('LOD2 生成:', lod2Meshes.length, 'メッシュ');
fs.mkdirSync(LOD2_DIR, { recursive: true });
const st = run('tools/lod2/lod2-build-all.mjs', ['--out', rel(LOD2_DIR), '--meshes', lod2Meshes.join(','), '--resume', '--report-dir', rel(path.join(LOD2_DIR, 'report'))]);
lod2Rep = JSON.parse(fs.readFileSync(path.join(LOD2_DIR, 'report.json'), 'utf8'));
if (!(lod2Rep.converted > 0)) throw new Error('LOD2 が 0 棟');

// ---- 2b. 補完 LOD1(Mission 197): LOD2 と gml:id が完全一致する棟だけを LOD1 から除外して再生成(二重描画の解消) ----
//   LOD2 manifest の gml:id 集合 = 除外 ID。LOD2 が無い棟は一切除外しない。建物座標は一切動かさない。
lod2Manifest = path.join(LOD2_DIR, 'manifest.json');
if (!fs.existsSync(lod2Manifest)) throw new Error('LOD2 manifest.json がありません(除外 ID を作れない)');
lod2Ids = new Set(JSON.parse(fs.readFileSync(lod2Manifest, 'utf8')).assets.flatMap((x) => x.ids || []));
if (!lod2Ids.size) throw new Error('LOD2 manifest に ID が無い');
for (const w of wardInfo) {
  const sdir = path.join(ROOT, 'temp/mission79', w.id + '-2025-supp');
  fs.rmSync(sdir, { recursive: true, force: true });
  log('補完 LOD1 生成(LOD2 と ID 一致の棟を除外):', w.id);
  run('tools/mission79-run.mjs', ['--ward', w.id, '--max-mb', maxMb, '--final', sdir, '--exclude-ids', lod2Manifest]);
  const v = verifyWard(sdir, w.code);
  if (!v.ok) throw new Error('補完 LOD1 verification failed for ' + w.id + ': ' + (v.problems || []).join(';'));
  const src = JSON.parse(fs.readFileSync(path.join(sdir, 'source.json'), 'utf8'));
  if (Number(src.vintage) !== 2025) throw new Error(w.id + ': supplemental vintage != 2025');
  const excluded = src.counts.excludedForLod2 | 0;
  // 監査: 元 LOD1 = 補完 LOD1 + 除外、かつ補完 LOD1 の ID に LOD2 の ID が残っていない(ダブり 0)
  if (w.fullBuildings !== v.buildings + excluded) throw new Error(`${w.id}: 件数不整合 full=${w.fullBuildings} supp=${v.buildings} excluded=${excluded}`);
  // Mission 198: 厳格 ID 監査(fail closed)。形式不正/0 件/件数不一致/除外漏れは全て例外。
  const audit = auditWard({ id: w.id, origDir: w.dir, suppDir: sdir, lod2Ids, origBuildings: w.fullBuildings, suppBuildings: v.buildings, excludedCount: excluded });
  log('ID 監査 OK:', JSON.stringify(audit));
  Object.assign(w, { dir: sdir, buildings: v.buildings, contentTiles: v.contentTiles, glbBytes: v.glbBytes, source: src, excludedForLod2: excluded, idAudit: audit, idAuditedIds: audit.suppIds, doubleDrawn: audit.doubleDrawn });
  fs.rmSync(path.join(ROOT, 'temp/mission79', w.id + '-work'), { recursive: true, force: true });
}
}

// ---- 3. 組み立て ----
// single-pass は ext-3dtiles を既に OUT へ配置済みなので OUT を消さない。two-pass は従来どおり。
if (!SINGLE) { fs.rmSync(OUT, { recursive: true, force: true }); }
fs.mkdirSync(OUT, { recursive: true });
// 3a. public/ から 37G の動作に要る静的ファイルのみ(内蔵旧サンプル 3D Tiles・旧 map-data・旧 HTML・テスト・ローカル専用設定は載せない)
const EXCLUDE_TOP = new Set(['map-data', '__test__', 'mission37b-3dtiles', 'mission37h-3dtiles', 'mission38e-3dtiles', 'mission40j-3dtiles', 'local-config.js']);
for (const n of fs.readdirSync(path.join(ROOT, 'public'))) {
  if (EXCLUDE_TOP.has(n) || /^osaka_3d_buildings/.test(n) || /\.local\.json$/.test(n)) continue;
  cp(path.join(ROOT, 'public', n), path.join(OUT, n));
}
const stripLocal = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) stripLocal(p); else if (/\.local\.json$/.test(e.name)) fs.rmSync(p); } };
stripLocal(OUT);
// 3b. LOD1: 許可リストのみコピー(alignment.json 等の内部レポートは載せない)
for (const w of wardInfo) {
  if (SINGLE) break; // single-pass は区ごとに配置済み
  const d = path.join(extRoot, w.id);
  fs.mkdirSync(d, { recursive: true });
  for (const n of ['tileset.json', 'source.json', 'build-report.json', 'tiles', 'lod', 'ids', 'attrs']) if (fs.existsSync(path.join(w.dir, n))) cp(path.join(w.dir, n), path.join(d, n));
}
// Mission 202: 区ごと manifest(vintage=2025/出典/sha256/contentVersion)を生成し実ファイルと照合。区の取り違え(同一contentVersion)も検出。
const wardManifests = [];
for (const w of wardInfo) {
  const d = path.join(extRoot, w.id);
  wardManifests.push(await writeWardManifest(d, { ward: w.id, name: w.name, code: w.code, source: w.source }));
  const vr = await verifyWardDir(d, w.id);
  if (!vr.ok) throw new Error('ward manifest 検証失敗 ' + w.id + ': ' + vr.problems.slice(0, 3).join(';'));
}
const distinct = checkWardsDistinct(wardManifests);
if (!distinct.ok) throw new Error('区データの混在疑い: ' + distinct.problems.join(';'));
// 区選択パネル + URL 解決レイヤー(既定は同一origin)
cp(path.join(ROOT, 'tools/cloud/data-resolver.cjs'), path.join(OUT, 'cloud-data-resolver.js'));
cp(path.join(ROOT, 'tools/cloud/ward-picker.js'), path.join(OUT, 'cloud-ward-picker.js'));
// Mission 201: 24区全てを列挙し、配信済(served)/未配信(not-served)を明記。未配信区を配信済と見せない。
fs.writeFileSync(path.join(extRoot, 'index.json'), JSON.stringify({
  ...buildIndex(reg, wardInfo.map((w) => ({ id: w.id, buildings: w.buildings }))),
  lod0Wards: [], layersWards: [],
}));
// 3c. LOD2 + オーバーレイ(ローカル serve と同じ URL 構成)
const l2 = path.join(OUT, 'lod2-preview');
fs.mkdirSync(l2, { recursive: true });
for (const n of ['tileset.json', 'footprints.json', 'report.json']) cp(path.join(LOD2_DIR, n), path.join(l2, n));
cp(path.join(LOD2_DIR, 'tiles'), path.join(l2, 'tiles'));
cp(path.join(ROOT, 'tools/lod2/lod2-overlay.js'), path.join(l2, 'overlay.js'));
cp(path.join(ROOT, 'tools/lod2/lod2-clip-near.cjs'), path.join(l2, 'clipnear.js'));
cp(path.join(ROOT, 'tools/lod2/lod2-diagnose.js'), path.join(l2, 'diagnose.js'));

// 3d. 37G HTML の複製: localhost 限定ゲート 4 箇所 + 内蔵サンプル 404 での早期 return 1 箇所だけを直し、既定クエリ(nobuiltin=1&ext45=1&lod2=1)と出典バナーを入れる
const HTML = 'mission37g-osaka-24ward-mvp.html';
let html = fs.readFileSync(path.join(OUT, HTML), 'utf8');
const LH = String.raw`/^(localhost|127\.0\.0\.1)$/.test(location.hostname)`;
const gates = [
  [LH + " && q.get('ext45') === '1'", "true && q.get('ext45') === '1'"],
  [LH + " && q.get('lod2') === '1'", "true && q.get('lod2') === '1'"],
  [LH + " && new URLSearchParams(location.search).get('nobuiltin') === '1'", "true && new URLSearchParams(location.search).get('nobuiltin') === '1'"],
  ['!' + LH + " || new URLSearchParams(location.search).get('ext45') !== '1'", "false || new URLSearchParams(location.search).get('ext45') !== '1'"],
];
// 5 箇所目: 内蔵(旧)住吉サンプルを載せないため build-report.json が 404 になる。元コードは `return` で追加区の coverage 計算ごと飛ばしてしまうので、例外にして catch(未配信扱い)へ落とす。
gates.push(["const r = await fetch(TILES_BASE + 'build-report.json');\n      if (!r.ok) return;", "const r = await fetch(TILES_BASE + 'build-report.json');\n      if (!r.ok) throw new Error('builtin sample absent (cloud preview, nobuiltin)');"]);
// Mission 197: 区ポップアップの「ローカル変換データ／この PC のみ」表記はクラウド配信の実態と矛盾するため、クラウド専用の出典表記に置換する。
gates.push(
  ["'3D建物: ローカル全域変換済み（' + a.tiles + 'タイル・' + fmt(a.buildings) + '棟。この PC のみ・未公開。ブラウザでの全域視認は未確認）'",
   "'3D建物: 公式PLATEAU大阪2025・クラウド配信（' + a.tiles + 'タイル・' + fmt(a.buildings) + '棟。非本番Preview。LOD2化した建物は除外して補完）'"],
  ["'3D建物: ローカル変換データ（' + a.tiles + 'タイル・' + fmt(a.buildings) + '棟。この PC のみ・未公開・全域とは未確認）'",
   "'3D建物: 公式PLATEAU大阪2025・クラウド配信（補完LOD1 ' + fmt(a.buildings) + '棟＋LOD2。非本番Preview。配信済みの区のみ・他区は未接続）'"],
);
for (const [from, to] of gates) {
  const n = html.split(from).length - 1;
  if (n !== 1) throw new Error('37G HTML のゲート書式が想定と違います(' + n + ' 件): ' + from.slice(0, 80));
  html = html.replace(from, () => to);
}
const prov = {
  schema: 'livecity.mission196.provenance/1', environment: 'cloud-preview (非本番・レビュー専用)', generatedAt: new Date().toISOString(),
  dataSource: '公式 PLATEAU 大阪市 2025 CityGML v5(ZIP の HTTP Range 取得)のみ。PC 上の旧 45D / OSM / 2024 内蔵サンプルは使用しない(nobuiltin=1)',
  vintage: 2025, attribution: wardInfo[0].source.attribution, license: wardInfo[0].source.license,
  sourceEtag: wardInfo[0].source.sourceEtag,
  wards: wardInfo.map((w) => ({ ward: w.id, name: w.name, code: w.code, lod1Buildings: w.buildings, lod1OriginalBuildings: w.fullBuildings, lod1ExcludedForLod2: w.excludedForLod2, lod1DoubleDrawn: w.doubleDrawn, idAudit: w.idAudit, idAuditedIds: w.idAuditedIds, sourceVintage: w.source.vintage, sourceEtag: w.source.sourceEtag, lod1ContentTiles: w.contentTiles, lod1GlbBytes: w.glbBytes, meshes: w.source.sourceMeshes.length })),
  lod2: { meshes: lod2Meshes, buildings: lod2Rep.converted, expected: lod2Rep.expected, fullMatch: lod2Rep.fullMatch, tiles: lod2Rep.tiles, glbBytes: lod2Rep.glbBytes, color: lod2Rep.color, textureRendered: false },
  buildCondition: { wards, maxMb, node: process.version, lod2IdsTotal: lod2Ids.size, singlePass: SINGLE, allWards: ALL, guards: { TIME_BUDGET_MIN, MAX_OUT_MB, MIN_FREE_GB, EXPECTED_TOTAL } },
  overlap: '補完 LOD1: 元 LOD1 のうち LOD2 と gml:id が完全一致する棟を除外(補完 LOD1 内の LOD2 同一 ID は 0 件を監査)。LOD2 は区外の建物も含むメッシュ範囲。',
  cloudCoverage: { servedWards: wardInfo.map((w) => w.id), servedWardNames: wardInfo.map((w) => w.name), servedWardCount: wardInfo.length, totalWards: reg.length, note: '配信済みの区のみ。他区は未接続(未配信)' },
  roadsRiversParks: '未接続(旧道路/路線データは配信しない。2025 道路との整合は未検証)',
  knownOffsets: lod2Rep.vertical,
};
const UMEDA = [135.4960, 34.7055];
const banner = `<div id="lc196-banner" style="position:fixed;left:8px;bottom:8px;z-index:100000;background:rgba(14,18,26,.92);color:#fff;font:12px/1.5 sans-serif;padding:8px 10px;border-radius:6px;max-width:360px">` +
  `<b style="color:#fc8">Preview(非本番・レビュー専用)</b><br>データ: <b>公式 PLATEAU 大阪市 2025</b>(CityGML v5)のみ。旧データ・OSM 不使用<br>` +
  (prov.wards.length > 6
    ? '全' + prov.wards.length + '区合計: 元LOD1 ' + prov.wards.reduce((n, w) => n + w.lod1OriginalBuildings, 0).toLocaleString('en-US') + '棟 − LOD2と同一ID ' + prov.wards.reduce((n, w) => n + w.lod1ExcludedForLod2, 0).toLocaleString('en-US') + '棟 = 補完LOD1 ' + prov.wards.reduce((n, w) => n + w.lod1Buildings, 0).toLocaleString('en-US') + '棟(区別は cloud-preview.json)'
    : prov.wards.map((w) => w.name + ': 元LOD1 ' + w.lod1OriginalBuildings.toLocaleString('en-US') + '棟 − LOD2と同一ID ' + w.lod1ExcludedForLod2.toLocaleString('en-US') + '棟 = 補完LOD1 ' + w.lod1Buildings.toLocaleString('en-US') + '棟').join('<br>')) +
  '<br>LOD2 ' + prov.lod2.buildings.toLocaleString('en-US') + '棟(' + prov.lod2.meshes.length + 'メッシュ範囲。区外の建物を含む。頂点色のみ・テクスチャ無し・固定昼光の陰影を焼き込み=時刻非依存)<br>' +
  `<b>クラウド配信: ${prov.cloudCoverage.servedWardCount}/${prov.cloudCoverage.totalWards}区のみ${wardInfo.length > 6 ? '' : '(' + wardInfo.map((w) => w.name).join('/') + ')'}</b>${wardInfo.length < reg.length ? '(他区は未接続)' : '(区は選択で遅延読込。同時全区描画は既定OFF)'}。道路・河川・公園・駅は未接続(2025道路との整合は未検証)<br>` +
  `<button id="lc196-umeda" style="margin:4px 4px 0 0">梅田(大阪駅周辺)のLOD2へ近づく</button><button id="lc196-umeda-near" style="margin-top:4px">さらに近景</button><br>` +
  `<span style="opacity:.8">出典：国土交通省 Project PLATEAU（3D都市モデル 大阪市 2025 / CityGML v5）を加工して作成。<a style="color:#9cf" href="https://www.mlit.go.jp/plateau/site-policy/" target="_blank" rel="noopener">利用条件</a> / <a style="color:#9cf" href="/cloud-preview.json" target="_blank">provenance</a></span></div>` +
  `<script>(function(){function go(r){var f=window.__lc152&&window.__lc152.lookAtFirst;if(f)f(r,-40,[${UMEDA[0]},${UMEDA[1]}]);else alert('LOD2 の読み込み中です。数秒後にもう一度押してください')}` +
  `document.getElementById('lc196-umeda').onclick=function(){go(450)};document.getElementById('lc196-umeda-near').onclick=function(){go(160)}})()</script>`;
const defaults = `<script>(function(){var q=new URLSearchParams(location.search);if(!q.has('nobuiltin')){q.set('nobuiltin','1');q.set('ext45','1');q.set('lod2','1');if(!q.has('lod2fly')&&!q.has('lod2ov'))q.set('lod2ov','1');history.replaceState(null,'','?'+q.toString())}})()</script>`;
html = html.replace('<head>', () => '<head>\n' + defaults);
html = html.replace('</body>', () => banner + '\n<script src="/cloud-data-resolver.js"></script><script src="/cloud-ward-picker.js"></script>\n</body>');
fs.writeFileSync(path.join(OUT, HTML), html);
fs.writeFileSync(path.join(OUT, 'cloud-preview.json'), JSON.stringify(prov, null, 1));
fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Live City cloud preview (PLATEAU 2025)</title><meta http-equiv="refresh" content="0;url=/${HTML}?nobuiltin=1&ext45=1&lod2=1&lod2ov=1"><a href="/${HTML}?nobuiltin=1&ext45=1&lod2=1&lod2ov=1">Live City Preview(公式 PLATEAU 2025・非本番)</a>`);

// ---- 4. 静的 /__lod2/diag.json(ローカル serve を一時起動して実出力を保存。extServed など動的値は除く) ----
const port = 18000 + Math.floor(Math.random() * 1000);
const stagingExt = extRoot;
if (!a.includes('--no-diag')) {
  const srv = spawn(process.execPath, [path.join(ROOT, 'tools/lod2/lod2-preview-serve.cjs'), '--port', String(port), '--lod2-dir', LOD2_DIR, '--ext-root', stagingExt, '--no-auto-layers'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    let body = null;
    for (let i = 0; i < 60 && !body; i++) {
      await new Promise((r) => setTimeout(r, 250));
      body = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/__lod2/diag.json', headers: { 'x-lc-probe': '1' } }, (x) => { let s = ''; x.on('data', (d) => (s += d)); x.on('end', () => res(x.statusCode === 200 ? s : null)); }).on('error', () => res(null)));
    }
    if (!body) throw new Error('diag.json を生成できません');
    const dg = JSON.parse(body);
    delete dg.extServed; delete dg.requests;
    dg.static = true; dg.note = 'cloud preview: ビルド時のローカル serve 出力の静的コピー(実行中カウンタ extServed/requests は無し)';
    fs.mkdirSync(path.join(OUT, '__lod2'), { recursive: true });
    fs.writeFileSync(path.join(OUT, '__lod2/diag.json'), JSON.stringify(dg));
  } finally { srv.kill(); }
}

// ---- 5. 検証と容量レポート ----
const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } })(OUT);
const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
const big = files.filter((f) => fs.statSync(f).size > 90 * 1048576);
if (big.length) throw new Error('90MB 超のファイル(Vercel 制限に近い): ' + big.map(rel).join(','));
const forbidden = files.filter((f) => /osaka_3d_buildings|[\\/]map-data[\\/]|mission3[78]h?-3dtiles|mission38e-3dtiles|\.local\.json$/.test(f));
if (forbidden.length) throw new Error('旧データ/ローカル専用ファイルが混入: ' + forbidden.slice(0, 3).map(rel).join(','));
const sizeOf = (sub) => { let n = 0, c = 0; for (const f of files) if (f.startsWith(path.join(OUT, sub) + path.sep)) { n += fs.statSync(f).size; c++; } return { files: c, bytes: n }; };
const report = {
  mission: '196B', out: rel(OUT), totalFiles: files.length, totalBytes: bytes, totalMB: +(bytes / 1048576).toFixed(1),
  lod1: Object.fromEntries(wardInfo.map((w) => [w.id, { buildings: w.buildings, original: w.fullBuildings, excluded: w.excludedForLod2, idAudit: w.idAudit, ...sizeOf('ext-3dtiles/' + w.id) }])),
  lod2: { buildings: lod2Rep.converted, meshes: lod2Meshes.length, ...sizeOf('lod2-preview') },
  elapsedSec: Math.round((Date.now() - t0) / 1000),
};
fs.writeFileSync(path.join(OUT, 'cloud-build-report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report));
