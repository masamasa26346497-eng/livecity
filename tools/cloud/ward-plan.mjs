#!/usr/bin/env node
// Mission 201: 24区クラウド配信の read-only 計画(ネットワーク不要・何も生成/ダウンロードしない)。
//   node tools/cloud/ward-plan.mjs [--wards a,b] [--served kita,chuo,nishi] [--json] [--out data/reports/mission201/ward-plan.json]
// 入力(すべてリポジトリ内の公式由来レポートのみ):
//   data/reports/mission79/source-lock.json   公式ZIP中央ディレクトリ(メッシュ別 圧縮/展開バイト)
//   data/reports/mission193/all-wards-build.json   実測: 区別 棟数/タイル数/GLBバイト/生成秒
//   data/processed/osaka-city/boundaries/ward-classification-polygons.json  区bbox(対象メッシュ選定)
//   config/wards/registry.json
// 出力は「見積り」であり、実測値(measured)と推定値(estimated)を必ず区別する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectMeshes } from '../mission79-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const MB = 1048576;

// Vercel Hobby の既知制限(2026-11 時点で本環境からは公式docsを取得できないため「要再確認の既知値」)。
// 値は変更されうる。ここの数値は判定の目安であり保証ではない。
export const VERCEL_HOBBY_ASSUMED = {
  verified: false,
  note: 'ネットワーク不可のため公式docsで再確認できていない。過去に公開されていた値を暫定採用。デプロイ前に vercel.com/docs/limits で確認すること。',
  buildMinutes: 45,
  deployFileCount: 15000,       // 静的ファイル数の目安(要確認)
  singleFileMB: 100,            // 静的ファイル1つの上限の目安(要確認)
  deployTotalMB: 1000,          // build output 総量の目安(要確認; 超過はデプロイ失敗しうる)
  bandwidthGBPerMonth: 100,     // Fast Data Transfer の目安(要確認)
};

export function loadInputs() {
  const lock = readJson('data/reports/mission79/source-lock.json');
  const build = readJson('data/reports/mission193/all-wards-build.json');
  const polys = readJson('data/processed/osaka-city/boundaries/ward-classification-polygons.json');
  const area = readJson('config/areas/osaka-city.json');
  const registry = readJson('config/wards/registry.json').wards;
  return { lock, build, polys, area, registry };
}

export function planWards({ lock, build, polys, area, registry }, wardIds = null, served = []) {
  const ids = wardIds && wardIds.length ? wardIds : registry.map((w) => w.id);
  const servedSet = new Set(served);
  return ids.map((id) => {
    const reg = registry.find((w) => w.id === id);
    if (!reg) throw new Error('unknown ward ' + id);
    const poly = polys.wards.find((w) => w.wardId === id);
    if (!poly) throw new Error('no ward polygon for ' + id);
    if (String(poly.wardCode) !== String(reg.code)) throw new Error(`${id}: wardCode mismatch registry=${reg.code} polygons=${poly.wardCode}`);
    const sel = selectMeshes(lock, poly, area.projection);
    const ents = lock.entries.filter((e) => e.kind === 'bldg' && sel.meshes.includes(e.mesh));
    const m = build.wards && build.wards[id];
    const measured = m && m.ok ? { buildings: m.buildings, contentTiles: m.contentTiles, glbBytes: m.glbBytes, seconds: m.seconds } : null;
    return {
      ward: id, name: reg.name, code: reg.code,
      served: servedSet.has(id),
      sourceMeshes: sel.meshes.length,
      downloadCompressedMB: +(ents.reduce((n, e) => n + e.compressedBytes, 0) / MB).toFixed(1),
      inflatedGmlMB: +(ents.reduce((n, e) => n + e.uncompressedBytes, 0) / MB).toFixed(1),
      measured, // mission193 実測(LOD1 全棟。LOD2除外前)
    };
  });
}

// 範囲つき試算。measured が無い区は棟数ではなく展開GMLバイト比で線形推定(estimated)。
export function estimateTotals(plans, { glbSpread = 0.15, includeLod2MB = null } = {}) {
  const meas = plans.filter((p) => p.measured);
  const inflMeas = meas.reduce((n, p) => n + p.inflatedGmlMB, 0);
  const glbPerInfl = meas.reduce((n, p) => n + p.measured.glbBytes, 0) / MB / (inflMeas || 1);
  const tilesPerInfl = meas.reduce((n, p) => n + p.measured.contentTiles, 0) / (inflMeas || 1);
  const secPerInfl = meas.reduce((n, p) => n + p.measured.seconds, 0) / (inflMeas || 1);
  let glbMB = 0, tiles = 0, sec = 0, estimatedWards = 0;
  const perWard = plans.map((p) => {
    const e = p.measured
      ? { glbMB: p.measured.glbBytes / MB, tiles: p.measured.contentTiles, sec: p.measured.seconds, basis: 'measured' }
      : { glbMB: p.inflatedGmlMB * glbPerInfl, tiles: Math.round(p.inflatedGmlMB * tilesPerInfl), sec: p.inflatedGmlMB * secPerInfl, basis: 'estimated' };
    if (e.basis === 'estimated') estimatedWards++;
    glbMB += e.glbMB; tiles += e.tiles; sec += e.sec;
    return { ward: p.ward, glbMB: +e.glbMB.toFixed(1), tiles: e.tiles, seconds: Math.round(e.sec), basis: e.basis };
  });
  // ファイル数: GLB + tileset/ids/lod/attrs 等の付随ファイル(実測が無いので 1 タイルあたり約 2.0 と仮定 = 推定)
  const filesPerTile = 2.0;
  const totalFiles = Math.round(tiles * (1 + filesPerTile));
  return {
    wards: plans.length, estimatedWards,
    lod1GlbMB: { low: +(glbMB * (1 - glbSpread)).toFixed(0), mid: +glbMB.toFixed(0), high: +(glbMB * (1 + glbSpread)).toFixed(0) },
    contentTiles: tiles,
    files: { low: Math.round(totalFiles * 0.8), mid: totalFiles, high: Math.round(totalFiles * 1.5), basis: 'estimated (filesPerTile 仮定)' },
    buildSeconds: { mid: Math.round(sec), note: 'mission193 の 4 vCPU Actions runner の実測秒の合計/比例推定。Vercel ビルド機の速度は未実測' },
    downloadCompressedMB: +plans.reduce((n, p) => n + p.downloadCompressedMB, 0).toFixed(1),
    perWard,
    ...(includeLod2MB != null ? { lod2MB: includeLod2MB } : {}),
  };
}

export function fitAgainstLimits(est, limits = VERCEL_HOBBY_ASSUMED) {
  const hi = est.lod1GlbMB.high, mid = est.lod1GlbMB.mid;
  return {
    assumedLimitsVerified: limits.verified,
    sameOriginSingleDeploy: {
      bytes: hi <= limits.deployTotalMB ? 'LOD1 GLBのみは想定上限内(未検証の上限・LOD2/HTML/ids等は別途加算)' : 'EXCEEDS 想定上限 → 同一originの全24区一括は不可/危険',
      files: est.files.high <= limits.deployFileCount ? '想定上限内(推定・未検証)' : 'EXCEEDS 想定上限',
      buildTime: est.buildSeconds.mid / 60 <= limits.buildMinutes ? '変換のみ実測比例で想定内。ただし公式ZIPのRange取得(約840MB)・LOD2・ID監査は含まず、Vercelビルド機は未測定 → 毎回ビルドは非推奨' : 'EXCEEDS 想定ビルド時間 → 毎回の区変換は不可',
      midGlbMB: mid, highGlbMB: hi,
    },
  };
}

// 配信済/未配信を明記した ext-3dtiles/index.json の内容(24区全て列挙)。未配信を served として出さない。
export function buildIndex(registry, servedInfo) {
  const byId = new Map(servedInfo.map((w) => [w.id || w.ward, w]));
  return {
    schema: 'livecity.mission201.cloud-index/2', verified: false, vintage: 2025,
    totalWards: registry.length, servedCount: byId.size,
    wards: registry.map((r) => {
      const s = byId.get(r.id);
      return s
        ? { ward: r.id, name: r.name, wardCode: r.code, status: 'served', buildings: s.buildings, tileset: `${r.id}/tileset.json` }
        : { ward: r.id, name: r.name, wardCode: r.code, status: 'not-served', buildings: null, tileset: null };
    }),
  };
}

// "i/n"(1始まり)で区リストを決定的に分割。shard 指定なしは全区をそのまま返す。範囲外/重複は例外。
export function shardWards(list, shard) {
  if (list.length !== new Set(list).size) throw new Error('--wards に重複があります');
  if (!shard) return list;
  const m = /^(\d+)\/(\d+)$/.exec(shard);
  if (!m) throw new Error('--shard は i/n 形式: ' + shard);
  const i = +m[1], n = +m[2];
  if (!(n >= 1 && i >= 1 && i <= n)) throw new Error('--shard 範囲外: ' + shard);
  return list.filter((_, k) => k % n === i - 1);
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const inp = loadInputs();
  const wards = (opt('wards') || '').split(',').filter(Boolean);
  const served = (opt('served', 'kita,chuo,nishi')).split(',').filter(Boolean);
  const plans = planWards(inp, wards, served);
  const est = estimateTotals(plans);
  const report = {
    mission: '201', readOnly: true, networkUsed: false, generatedAt: new Date().toISOString(),
    source: { package: inp.lock.package.name, etag: inp.lock.http.etag, contentLengthMB: +(inp.lock.http.contentLength / MB).toFixed(0), vintage: 2025 },
    vercelHobbyAssumed: VERCEL_HOBBY_ASSUMED, plans, estimate: est, fit: fitAgainstLimits(est),
    measuredBuildings: plans.reduce((n, p) => n + (p.measured ? p.measured.buildings : 0), 0),
  };
  if (opt('out')) {
    const o = path.resolve(ROOT, opt('out'));
    fs.mkdirSync(path.dirname(o), { recursive: true });
    fs.writeFileSync(o, JSON.stringify(report, null, 1));
  }
  if (a.includes('--json')) console.log(JSON.stringify(report, null, 1));
  else {
    console.log('ward         served  meshes  dlMB   inflMB  bldgs   glbMB  sec');
    for (const p of plans) console.log([p.ward.padEnd(13), (p.served ? 'yes' : 'no').padEnd(6), String(p.sourceMeshes).padStart(6), String(p.downloadCompressedMB).padStart(6), String(p.inflatedGmlMB).padStart(8), String(p.measured ? p.measured.buildings : '-').padStart(6), String(p.measured ? (p.measured.glbBytes / MB).toFixed(1) : '-').padStart(7), String(p.measured ? p.measured.seconds : '-').padStart(5)].join(' '));
    console.log(JSON.stringify({ estimate: { ...est, perWard: undefined }, fit: report.fit }, null, 1));
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); }
}
