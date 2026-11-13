#!/usr/bin/env node
// Mission 207: 既存の 24区 LOD1 配信(index.json 付き ext-3dtiles)を維持したまま、北区・中央区だけを
// 2025 補完 LOD1 + 実 LOD2 に差し替える統合バンドラ。ベース(read-only)は変更しない。出力は temp/ 配下のみ。
//   node tools/lod2/lod2-cloud-merge.mjs --base <ext-3dtiles dir> --overlay temp/cloud-bundle [--out temp/cloud-merged] [--symlink] [--report path]
// ベース側の区ディレクトリは、各区に source.json / build-report.json / tileset.json があるものだけを採用する。
// 権利未確認のデータ(駅/地名/道路/河川)は同梱しない。区ごとに status(base/overlay/missing)・vintage を明示する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// 純関数: 区ごとの採用元を決める。overlay が優先(base の同区は置換)、どちらにも無い区は missing。
export function planMerge({ registry, baseWards, overlayWards }) {
  const plan = [];
  for (const w of registry) {
    const o = overlayWards[w.id], b = baseWards[w.id];
    if (o) plan.push({ ward: w.id, code: String(w.code), status: 'overlay', vintage: o.vintage || '2025', buildings: o.buildings, replaced: !!b, note: 'LOD2 ID 除外済みの補完 LOD1(2025)' });
    else if (b) plan.push({ ward: w.id, code: String(w.code), status: 'base', vintage: b.vintage || 'unverified', buildings: b.buildings, replaced: false, note: b.vintage ? '' : '既存 LOD1。年版は source.json に記載なし(2025 とは言えない)' });
    else plan.push({ ward: w.id, code: String(w.code), status: 'missing', vintage: null, buildings: 0, replaced: false, note: 'LOD1 が見つからない(blocked)' });
  }
  return plan;
}

// ベースの区を検査(37G の loadExtraMeta と同じ最低条件)。
export function inspectWard(dir, code) {
  const sj = path.join(dir, 'source.json'), br = path.join(dir, 'build-report.json'), ts = path.join(dir, 'tileset.json');
  if (![sj, br, ts].every(isFile)) return null;
  const s = readJson(sj), r = readJson(br);
  if (String(s.wardCode) !== String(code)) return null;
  const n = r.totals && r.totals.buildings;
  if (!(n > 0)) return null;
  return { buildings: n, vintage: s.vintage && !s.synthesized ? String(s.vintage) : null, vintageSynthesized: !!s.synthesized };
}

function copyTree(src, dst, symlink) {
  if (symlink) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.symlinkSync(path.resolve(src), dst, 'dir'); return; }
  fs.cpSync(src, dst, { recursive: true });
}

export function runMerge({ base, overlay, out, symlink = false, rootDir = ROOT }) {
  const OUT = path.resolve(rootDir, out);
  if (!/[\\/]temp[\\/]/.test(OUT + path.sep)) throw new Error('出力先は temp/ 配下のみ');
  if (OUT === path.resolve(base) || OUT === path.resolve(overlay)) throw new Error('出力先が入力と同じです');
  const registry = readJson(path.join(rootDir, 'config/wards/registry.json')).wards;
  const baseWards = {}, overlayWards = {};
  for (const w of registry) {
    const b = inspectWard(path.join(base, w.id), w.code); if (b) baseWards[w.id] = b;
    const o = inspectWard(path.join(overlay, 'ext-3dtiles', w.id), w.code);
    if (o) { if (o.vintage !== '2025') throw new Error(`${w.id}: overlay が 2025 ではありません`); overlayWards[w.id] = o; }
  }
  const plan = planMerge({ registry, baseWards, overlayWards });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'ext-3dtiles'), { recursive: true });
  // 1) overlay の非 ext 部分(HTML・LOD2・JS・vercel.json 等)をそのまま使う
  for (const n of fs.readdirSync(overlay)) if (n !== 'ext-3dtiles' && n !== 'BUNDLE_MANIFEST.json') fs.cpSync(path.join(overlay, n), path.join(OUT, n), { recursive: true });
  // 2) 区ごと: base→コピー/リンク(read-only 読み取り)、overlay→常にコピー
  for (const p of plan) {
    if (p.status === 'base') copyTree(path.join(base, p.ward), path.join(OUT, 'ext-3dtiles', p.ward), symlink);
    else if (p.status === 'overlay') fs.cpSync(path.join(overlay, 'ext-3dtiles', p.ward), path.join(OUT, 'ext-3dtiles', p.ward), { recursive: true });
  }
  const served = plan.filter((p) => p.status !== 'missing');
  const index = { schema: 'livecity.cloud-merged/1', kind: 'cloud-static', verified: false, provenance: 'mixed: base(unverified vintage) + overlay(plateau-2025)', lod0Wards: [], layersWards: [], wards: served.map((p) => ({ ward: p.ward, code: p.code, buildings: p.buildings, vintage: p.vintage, source: p.status })) };
  fs.writeFileSync(path.join(OUT, 'ext-3dtiles/index.json'), JSON.stringify(index));
  const report = {
    schema: 'livecity-cloud-merge/1', generatedAt: new Date().toISOString(),
    counts: { served: served.length, base: plan.filter((p) => p.status === 'base').length, overlay: plan.filter((p) => p.status === 'overlay').length, missing: plan.filter((p) => p.status === 'missing').length, buildings: served.reduce((n, p) => n + (p.buildings || 0), 0) },
    full24: served.length === registry.length, wards: plan,
    notBundled: ['駅(OSM/ODbL)', '地名', '道路/河川レイヤー', '施設/Google Place ID'].map((x) => x + ': 権利未確認のため同梱しない(画面では未接続)'),
    rights: { confirmedByHuman: false },
  };
  fs.writeFileSync(path.join(OUT, 'MERGE_REPORT.json'), JSON.stringify(report, null, 1));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), o = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  if (!o('base') || !o('overlay')) { console.error('usage: --base <ext-3dtiles> --overlay <cloud-bundle> [--out temp/cloud-merged] [--symlink] [--report path]'); process.exit(2); }
  try {
    const r = runMerge({ base: path.resolve(o('base')), overlay: path.resolve(o('overlay')), out: o('out', 'temp/cloud-merged'), symlink: a.includes('--symlink') });
    if (o('report')) fs.writeFileSync(path.resolve(o('report')), JSON.stringify(r, null, 1));
    console.log(JSON.stringify({ ...r, wards: r.wards.map((w) => `${w.ward}:${w.status}:${w.vintage}`) }, null, 1));
    if (!r.full24) { console.error(`[cloud-merge] 24区そろっていません (missing ${r.counts.missing})。成功とは扱いません`); process.exit(3); }
  } catch (e) { console.error('[cloud-merge] NG:', e.message); process.exit(2); }
}
