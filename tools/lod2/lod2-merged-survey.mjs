#!/usr/bin/env node
// Mission 213: merged ツリーの配信サイズ・ファイル数の調査 + 404 の分類。出力は size / category / count のみ(建物属性・ID・秘密は出さない)。
//   node tools/lod2/lod2-merged-survey.mjs --root temp/cloud-merged [--not-found temp/cloud-verify/result.json] [--out temp/survey.json] [--limit-mb 100]
// (1) 24区ごとに tileset.json の全 content URI の実在と、tiles/ と lod/ のバイト数を集計する(lod/ のみ=遠景だけで配信する案の見積り)。
// (2) 静的サーバが返した 404 を、権利/出典の確認状況で分類する(classify404)。権利未確認のものは「復元しない」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 404 分類(純関数) ----
// restorable-bundled-elsewhere: 既に別ファイルで同梱済み / expected-static: 静的配信に元々無い / blocked-rights: 権利・出典が未確認なので再配布しない
// plateau-derived-needs-approval: 公式 PLATEAU 由来で出典表示で復元できるが、人の権利承認(confirmedByHuman)待ち / harmless: 描画に無関係
export const RULES = [
  [/^\/__lod2\//, 'expected-static', '動的診断エンドポイント(静的配信に無い)'],
  [/^\/favicon\.ico$/, 'harmless', 'アイコン'],
  [/^\/mission145-data\/stations/, 'blocked-rights', '駅(OpenStreetMap/ODbL 由来。帰属・継承条件の確認前は再配布しない)'],
  [/^\/mission145-data\//, 'blocked-rights', '駅・路線関連(出典未確認)'],
  [/^\/mission37c-layers\//, 'blocked-rights', '道路縁/河川(出典未確認)'],
  [/^\/mission4[0-9a-z]*-data\/.*(road|river|park|rail)/i, 'blocked-rights', '道路/河川/公園/鉄道(出典未確認)'],
  [/^\/map-data\/.*facilit/i, 'blocked-rights', '施設(OSM/Google Place 由来の可能性。未確認)'],
  [/google-place|places/i, 'blocked-rights', 'Google Places(利用規約上、再配布・キャッシュ不可)'],
  [/^\/mission36l|photo/i, 'blocked-rights', '写真索引(Wikimedia 等。ライセンス個別確認が必要)'],
  [/towns?-24|town-?stats|chocho|\/towns?\//i, 'blocked-rights', '町丁目境界・地名(出典未確認の暫定データを含む)'],
  [/^\/ext-3dtiles\/[a-z0-9-]+\/(attrs|ids)\//, 'plateau-derived-needs-approval', 'LOD1 サイドカー(PLATEAU 由来属性)。人の権利承認後に復元可'],
  [/^\/mission37g-data\//, 'restorable-bundled-elsewhere', '区境界(国土数値情報 N03)は同梱済みのはず。404 なら同梱漏れ'],
];
export function classify404(p) {
  for (const [re, cat, why] of RULES) if (re.test(p)) return { category: cat, why };
  return { category: 'unclassified', why: '未分類(要確認)' };
}
export function summarize404(paths) {
  const by = {}; for (const p of new Set(paths)) { const c = classify404(p); (by[c.category] ||= []).push(p); }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { count: v.length, examples: v.slice(0, 5) }]));
}

const ROOT0 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function walkSize(dir) { let bytes = 0, files = 0; const w = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.isFile()) { bytes += fs.statSync(p).size; files++; } } }; if (fs.existsSync(dir)) w(dir); return { bytes, files }; }
function contentUris(node, acc = []) { if (!node) return acc; if (node.content && (node.content.uri || node.content.url)) acc.push(node.content.uri || node.content.url); for (const c of node.children || []) contentUris(c, acc); return acc; }

export function survey(root, { limitMB = 100 } = {}) {
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'ext-3dtiles', 'index.json'), 'utf8'));
  const R = { wards: [], totals: {}, categories: {} };
  let missingContent = 0, lod1Bytes = 0, lodOnlyBytes = 0, tilesBytes = 0;
  for (const w of idx.wards) {
    const dir = path.join(root, 'ext-3dtiles', w.ward), real = fs.realpathSync(dir);
    const ts = JSON.parse(fs.readFileSync(path.join(real, 'tileset.json'), 'utf8')); const uris = contentUris(ts.root);
    const miss = uris.filter((u) => !fs.existsSync(path.join(real, u.split('?')[0]))).length; missingContent += miss;
    const all = walkSize(real), lod = walkSize(path.join(real, 'lod')), tiles = walkSize(path.join(real, 'tiles'));
    lod1Bytes += all.bytes; lodOnlyBytes += lod.bytes; tilesBytes += tiles.bytes;
    R.wards.push({ ward: w.ward, source: w.source || null, vintage: w.vintage || null, files: all.files, bytes: all.bytes, lodBytes: lod.bytes, tilesBytes: tiles.bytes, contentUris: uris.length, missingContent: miss });
  }
  const lod2 = walkSize(path.join(root, 'lod2-preview'));
  let all = 0, files = 0, other = 0;
  const w0 = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w0(p); else if (e.isFile()) { all += fs.statSync(p).size; files++; } else if (e.isSymbolicLink()) { /* walk via realpath below */ } } };
  w0(root);   // symlink された区(--symlink)は含まれないので ward 側の実体を加算する
  const total = all + lod1Bytes - walkSize(path.join(root, 'ext-3dtiles')).bytes + 0;
  other = Math.max(0, total - lod1Bytes - lod2.bytes);
  R.categories = { 'lod1-wards': { bytes: lod1Bytes, files: R.wards.reduce((n, w) => n + w.files, 0) }, 'lod2-preview': lod2, other: { bytes: other } };
  R.totals = { bytes: total, mb: +(total / 1048576).toFixed(1), wards: idx.wards.length, missingContent, lodOnlyMB: +(lodOnlyBytes / 1048576).toFixed(1), tilesMB: +(tilesBytes / 1048576).toFixed(1) };
  const lim = limitMB * 1048576;
  R.fit = { limitMB, fullFitsLimit: total <= lim, lod2PlusLodOnlyFitsLimit: lod2.bytes + lodOnlyBytes + other <= lim,
    note: 'limitMB は仮の閾値(Vercel Hobby の実上限は未確認。公式ドキュメントで確認すること)。単体で 100MB 超のファイルが無いかも別途確認。' };
  let big = 0; const wb = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const st = fs.statSync(p); if (st.isDirectory()) wb(p); else if (st.size > big) big = st.size; } }; wb(root);
  R.fit.largestFileMB = +(big / 1048576).toFixed(1);
  return R;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), o = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const root = path.resolve(ROOT0, o('root', 'temp/cloud-merged'));
  try {
    const R = survey(root, { limitMB: Number(o('limit-mb', 100)) });
    if (o('not-found')) { const j = JSON.parse(fs.readFileSync(path.resolve(ROOT0, o('not-found')), 'utf8')); const nf = (j.static && (j.static.notFoundAll || j.static.notFound)) || []; R.notFound = { total: nf.length, byCategory: summarize404(nf) }; }
    const text = JSON.stringify(R, null, 1);
    if (o('out')) { fs.mkdirSync(path.dirname(path.resolve(ROOT0, o('out'))), { recursive: true }); fs.writeFileSync(path.resolve(ROOT0, o('out')), text); }
    console.log(text);
    if (R.totals.missingContent > 0) { console.error('[survey] NG: tileset が参照する content が欠落'); process.exit(3); }
  } catch (e) { console.error('[survey] NG:', e.message); process.exit(2); }
}
