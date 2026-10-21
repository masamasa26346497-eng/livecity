#!/usr/bin/env node
'use strict';
// Mission 42: 37G ページ(現行 entrypoint)の実行時依存を列挙し、Git 追跡状況・サイズ・分類を機械可読で出力する。
// 読み取り専用。ネットワーク・外部通信なし。ローカルパス・秘密値は出力しない。
// 使い方: node tools/mission42-site-deps.cjs [--write] [--check]
//   --write : data/reports/mission42/site-deps.json を書く
//   --check : required の欠落があれば終了コード 1
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const ENTRY = 'mission37g-osaka-24ward-mvp.html';

const tracked = new Set(
  execFileSync('git', ['ls-files', '-z', 'public'], { cwd: ROOT, maxBuffer: 1 << 28 }).toString('utf8').split('\0').filter(Boolean)
);
const trackedUnder = (rel) => {
  const p = 'public/' + rel.replace(/\/$/, '');
  const out = [];
  for (const f of tracked) if (f === p || f.startsWith(p + '/')) out.push(f);
  return out;
};
const sizeOf = (files) => files.reduce((s, f) => { try { return s + fs.statSync(path.join(ROOT, f)).size; } catch (e) { return s; } }, 0);

// 参照元はページ内の定数・fetch 行(37G html の行は調査時点)。required=true は「無いと該当機能が動かない」。
// optional は無くてもページが継続する(fetch の catch あり)。
const DEPS = [
  { id: 'entry-html', path: ENTRY, kind: 'file', role: 'entrypoint', required: true, refs: ['vercel.json redirect'], source: 'repo-authored' },
  { id: 'scripts-local', kind: 'files', paths: ['mission37d-data/town-normalize.js', 'mission37f-photo-select.js', 'mission37k-poi-select.js', 'mission38f-facility-fastload.js', 'mission37e-places-ui-kit.js'], role: 'code', required: true, refs: ['37G html L444-448'], source: 'repo-authored' },
  { id: 'cesium-cdn', kind: 'external', role: 'engine', required: true, refs: ['37G html L443'], source: 'jsdelivr cesium@1.121.1 (CDN, Git 外・移管不要)' },
  { id: 'wards-boundary', path: 'mission37g-data/osaka-24-wards.json', kind: 'file', role: '区境界(24区)', required: true, refs: ['WARDS_URL'], source: '国土数値情報 N03(整形済み)', prio: 1 },
  { id: 'layers-sumiyoshi-9tile', path: 'mission37c-layers/osaka-sumiyoshi-9tile', kind: 'dir', role: '住吉 道路/河川/公園/鉄道/ラベル', required: true, refs: ['LAYER_BASE'], source: 'OSM(ODbL)切り出し', prio: 2 },
  { id: 'tiles-sumiyoshi-9tile', path: 'mission37b-3dtiles/osaka-sumiyoshi-9tile', kind: 'dir', role: '住吉 3D建物(9tile)', required: true, refs: ['TILES_BASE'], source: 'PLATEAU 2024 大阪市 LOD1 から変換', prio: 1 },
  { id: 'tiles-kita', path: 'mission37h-3dtiles/kita-sample', kind: 'dir', role: '北区 3D建物(一部)', required: false, refs: ['EXTRA_SET_DEFS'], source: 'PLATEAU 2024', prio: 3 },
  { id: 'tiles-chuo', path: 'mission37h-3dtiles/chuo-sample', kind: 'dir', role: '中央区 3D建物(一部)', required: false, refs: ['EXTRA_SET_DEFS'], source: 'PLATEAU 2024', prio: 3 },
  { id: 'tiles-tennoji', path: 'mission37h-3dtiles/tennoji-sample', kind: 'dir', role: '天王寺区 3D建物(一部)', required: false, refs: ['EXTRA_SET_DEFS'], source: 'PLATEAU 2024', prio: 3 },
  { id: 'tiles-nishi', path: 'mission37h-3dtiles/nishi-sample', kind: 'dir', role: '西区 3D建物(一部)', required: false, refs: ['EXTRA_SET_DEFS'], source: 'PLATEAU 2024', prio: 3 },
  { id: 'tiles-naniwa-mesh', path: 'mission38e-3dtiles/naniwa-mesh', kind: 'dir', role: '浪速区 3D建物(一部)', required: false, refs: ['EXTRA_SET_DEFS'], source: 'PLATEAU 2024', prio: 3 },
  { id: 'tiles-naniwa-mesh2', path: 'mission38e-3dtiles/naniwa-mesh2', kind: 'dir', role: '浪速区 3D建物(一部)', required: false, refs: ['EXTRA_SET_DEFS'], source: 'PLATEAU 2024', prio: 3 },
  { id: 'published-wards', path: 'mission40j-3dtiles/published.json', kind: 'file', role: '公開承認済み区の一覧', required: false, refs: ['loadPublishedDefs'], source: 'repo-authored(承認ゲート)', prio: 5 },
  { id: 'sumiyoshi-facilities', path: 'mission37d-data/sumiyoshi-facilities.json', kind: 'file', role: '住吉 施設149件', required: false, refs: ['FAC_URL'], source: 'OSM(ODbL)', prio: 2 },
  { id: 'sumiyoshi-towns', path: 'mission37d-data/sumiyoshi-towns.json', kind: 'file', role: '住吉 町丁目104件', required: false, refs: ['TOWNS_URL'], source: 'e-Stat/CODH 町丁字境界(CC BY 4.0)+暫定形状', prio: 2 },
  { id: 'verified-google-place-ids', path: 'mission37d-data/verified-google-place-ids.json', kind: 'file', role: 'Place ID照合表(Google課金は無効)', required: false, refs: ['GOOGLE_PLACE_INDEX_URL'], source: 'repo-authored', prio: 6 },
  { id: 'ward-facilities', path: 'map-data/osaka-city/facilities/wards', kind: 'dir', role: '24区 施設(OSM)', required: false, refs: ['FAC_WARD_BASE'], source: 'OSM(ODbL)', prio: 3, expectFiles: 24 },
  { id: 'photo-index', path: 'map-data/osaka-city/derived/building-photo-index.json', kind: 'file', role: 'Wikimedia写真索引', required: false, refs: ['PHOTO_INDEX_URL'], source: 'Wikimedia Commons(各写真に作者/ライセンス)', prio: 4 },
  { id: 'photo-dates', path: 'map-data/osaka-city/derived/photo-dates.json', kind: 'file', role: '撮影日(検証済み)', required: false, refs: ['PHOTO_DATES_URL'], source: 'Commons API', prio: 4 },
  { id: 'photo-review', path: 'map-data/osaka-city/derived/photo-review.json', kind: 'file', role: '写真 holds/adds', required: false, refs: ['PHOTO_REVIEW_URL'], source: 'repo-authored', prio: 4 },
];

function classify(d, files) {
  if (d.kind === 'external') return 'reproducible-from-audited-public-source';
  if (files.length && (d.expectFiles == null || files.length >= d.expectFiles)) return 'already-in-Git';
  if (files.length) return 'already-in-Git'; // 部分(expectFiles 未満は notes に出す)
  return 'local-only-or-missing';
}

const items = [];
for (const d of DEPS) {
  let files = [];
  if (d.kind === 'file') files = trackedUnder(d.path);
  else if (d.kind === 'dir') files = trackedUnder(d.path);
  else if (d.kind === 'files') files = d.paths.flatMap(trackedUnder);
  const exists = d.kind === 'external' ? null
    : (d.kind === 'files' ? d.paths.every((p) => fs.existsSync(path.join(PUB, p))) : fs.existsSync(path.join(PUB, d.path)));
  const notes = [];
  if (d.expectFiles != null && files.length < d.expectFiles) notes.push('tracked ' + files.length + '/' + d.expectFiles + ' files');
  if (d.kind === 'dir' && d.path.includes('3dtiles')) {
    const glb = files.filter((f) => f.endsWith('.glb')).length;
    notes.push('glb=' + glb);
  }
  items.push({
    id: d.id, role: d.role, required: d.required, priority: d.prio || 0,
    classification: classify(d, files), gitTrackedFiles: files.length, bytes: sizeOf(files),
    existsOnDisk: exists, refs: d.refs, source: d.source, notes,
  });
}

const missingRequired = items.filter((i) => i.required && i.classification === 'local-only-or-missing').map((i) => i.id);
const missingOptional = items.filter((i) => !i.required && i.classification === 'local-only-or-missing').map((i) => i.id);
const sum = (f) => items.filter(f).reduce((s, i) => s + i.bytes, 0);

// 公開 Git に無く、ローカル(オーナーPC)にしか無いもの: 名前だけ(パスは出さない)
const requiredStillLocal = [
  { id: 'fukushima-3dtiles', why: '福島区の変換 3D Tiles(約13.3MB)。PLATEAU 利用条件・公開承認ゲート未了', classification: 'cannot-transfer-without-access' },
  { id: 'fukushima-ward-layers', why: '福島区の OSM 道路/河川(40G)。ODbL 帰属確認と公開承認が未了', classification: 'cannot-transfer-without-access' },
  { id: 'other-ward-buildings-20', why: '旧タイル 1,097 tile のうち住吉以外(Git 非追跡、約0.6GB 外挿)。配信方式・ライセンス未承認', classification: 'cannot-transfer-without-access' },
  { id: 'ward-roads-rivers-23', why: '住吉 9tile 範囲外の道路/河川(OSM 元タイルがローカルのみ)', classification: 'cannot-transfer-without-access' },
];

const report = {
  schema: 'livecity.mission42.site-deps/1',
  entrypoint: 'public/' + ENTRY,
  publicRepo: true,
  gates: { licenseApproved: false, privacyReviewApproved: false, note: '41H/41P の承認ゲートは全 false のまま。本ツールは解除も送信もしない' },
  migrationReadiness: {
    requiredTotal: items.filter((i) => i.required).length,
    requiredAlreadyTracked: items.filter((i) => i.required && i.classification !== 'local-only-or-missing').length,
    missingRequired,
    missingOptional,
    siteRunsFromGitAlone: missingRequired.length === 0,
    runtimeVerifiedInBrowser: false,
  },
  alreadyTracked: { items: items.filter((i) => i.classification === 'already-in-Git').length, files: items.reduce((s, i) => s + i.gitTrackedFiles, 0), bytes: sum((i) => i.classification === 'already-in-Git') },
  transferredNow: { files: 0, bytes: 0, note: '今回、新規に Git へ移したデータは 0(既に追跡済みの構成で閲覧に足りるため)' },
  requiredStillLocal,
  nonessentialExcluded: ['public/osaka_3d_buildings*.html の旧バージョン複製(未参照)', 'mission37b/37c 旧 PoC ページ', 'public/__test__ (28MB)', 'data/reports の QA スクリーンショット', '41* の owner PC スキャン成果物(ローカルのみ・公開禁止)'],
  items,
};

const args = process.argv.slice(2);
if (args.includes('--write')) {
  const out = path.join(ROOT, 'data/reports/mission42/site-deps.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ migrationReadiness: report.migrationReadiness, alreadyTracked: report.alreadyTracked, items: items.map((i) => [i.id, i.classification, i.gitTrackedFiles, i.bytes, ...i.notes]) }, null, 1));
if (args.includes('--check') && missingRequired.length) process.exit(1);
