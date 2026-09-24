// tests/_generated-data.mjs
// [Mission 35L] 「生成物が手元にあるか」だけを判定する小さなヘルパー。
//
// なぜ要るか:
//   npm test には、パイプラインの **生成物そのものを検証する** テストが多数ある
//   （canonical タイル・derived JSON・QA レポート・baseline hash など）。
//   これらは .gitignore で除外されている（canonical buildings だけで約 250MB）。
//   そのため CI のような**素のチェックアウトでは入力ファイルが 1 つも存在せず**、
//   テストは「検証に失敗した」のではなく「検証する対象が無い」状態で落ちていた
//   （ENOENT / null 参照 / 「〜が無い」assertion）。
//
// 扱い:
//   入力が無いときは **skip**。入力があるときは従来どおり全部の assertion を実行する。
//   このリポジトリは既に同じ扱いをしている（html-regression は HTML が無ければ自動 skip、
//   data/reports 依存のテストは `skip: skip('…json')`。npm test の skip は 421 件）。
//
// **使ってはいけない場面**:
//   assertion が落ちたから skip する、は禁止。skip してよいのは
//   「入力ファイル / 入力ディレクトリが存在しない」ときだけ。
//   入力があるのに落ちるなら、それは本物の不具合なので直すこと。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 再生成コマンドの手掛かり（パスの接頭辞 → コマンド）。skip 理由に添えて出す。 */
const REGEN_HINTS = [
  ['data/processed/osaka-city/canonical/buildings', 'node --max-old-space-size=4096 tools/build-canonical-buildings.js'],
  ['data/processed/osaka-city/canonical/roads', 'node tools/build-canonical-roads.js'],
  ['data/processed/osaka-city/derived', 'node tools/build-canonical-derived.js'],
  ['data/processed/osaka-city/gsi-road-hybrid-v1', 'node tools/build-gsi-road-hybrid-v1.js'],
  ['data/processed/osaka-city/gsi-road-surface-v3', 'node tools/build-gsi-road-surface-v3.js'],
  ['data/processed/osaka-city/gsi-road-surface-v2', 'node tools/build-gsi-road-surface-v2.js'],
  ['data/processed/osaka-city/gsi-road-edge', 'node tools/import/gsi-road-edge.js'],
  ['data/processed/osaka-city/gsi-building-outline', 'node tools/import/gsi-building-outline.js'],
  ['public/map-data/osaka-city/buildings', 'node tools/build-ward-building-datasets.js --layout flat --public --force'],
  ['public/map-data/osaka-city/derived', 'node tools/build-canonical-derived.js --public'],
  ['public/map-data/osaka-city', 'node tools/build-city-layer-tiles.js --layer all --public --force'],
  ['data/reports/baselines', 'node tools/audit/production-cutover-snapshot.js'],
  ['data/reports', '該当ミッションの tools/audit または tools/validate を実行'],
  ['data/raw', 'ローカル PC でデータ取得（ネットワーク必要）'],
];

function hintFor(rel) {
  const norm = rel.split(path.sep).join('/');
  for (const [prefix, cmd] of REGEN_HINTS) if (norm.startsWith(prefix)) return cmd;
  return null;
}

function describe(p) {
  const rel = path.relative(REPO_ROOT, p).split(path.sep).join('/');
  const h = hintFor(path.relative(REPO_ROOT, p));
  return h ? `${rel}（再生成: ${h}）` : rel;
}

/**
 * 与えられたパスのうち 1 つでも存在しなければ skip 理由（文字列）を返す。
 * すべて存在すれば false を返す（node:test の `skip` は false だと実行される）。
 * ディレクトリは「存在し、かつ中身が空でない」ことを求める。
 */
export function skipIfMissing(...paths) {
  const gone = [];
  for (const p of paths.flat()) {
    if (!p) continue;
    let st = null;
    try { st = fs.statSync(p); } catch { gone.push(p); continue; }
    if (st.isDirectory()) {
      let n = 0;
      try { n = fs.readdirSync(p).length; } catch { n = 0; }
      if (n === 0) gone.push(p);
    }
  }
  if (!gone.length) return false;
  return '生成物が無い（パイプライン未実行）: ' + gone.map(describe).join(' / ');
}

/** リポジトリルートからの相対パスで指定する版。 */
export function skipIfMissingRel(...rels) {
  return skipIfMissing(...rels.flat().map((r) => path.join(REPO_ROOT, ...String(r).split('/'))));
}

/** data/reports/<name> が無ければ skip。既存の `skip(n)` と同じ意味を共有ヘルパーで。 */
export function skipIfNoReport(...names) {
  return skipIfMissingRel(...names.flat().map((n) => 'data/reports/' + n));
}
