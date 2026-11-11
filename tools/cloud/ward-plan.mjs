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

// Mission 202: Vercel Hobby 制限。confirmed(ChatGPT が公式docsで確認した値)と unconfirmed を分離する。
// unconfirmed を確定制限として判定に使ってはならない。この実行環境はネットワーク無しで docs を再取得していない。
export const VERCEL_HOBBY_LIMITS = {
  confirmed: {
    sources: ['https://vercel.com/docs/limits', 'https://vercel.com/docs/deployments/troubleshoot-a-build',
      'https://vercel.com/changelog/hobby-projects-now-retain-fewer-deployments-to-free-up-storage'],
    confirmedBy: 'ChatGPT(2026 公式docs確認)。本環境では未再取得',
    buildMinutes: 45, buildContainer: { cpu: 4, ramGB: 8, diskGB: 23 }, buildCacheGB: 1,
    buildMinutesPerMonth: 6000, transferGBPerMonth: 100,
    cliSourceUploadMB: 100, cliSourceFiles: 15000,
    note_cliSourceUpload: 'CLI の source upload 上限であり build output 総量の上限ではない(混同禁止)',
    teamDeploymentStorageGB: 10, retention: '直近3 production + 直近3 any-type(例外あり)',
  },
  unconfirmed: {
    buildOutputTotal: '確定した「静的出力総量の上限」は無い。Mission201 の約1GBは未検証の古い推測で、制限として扱わない(訂正)',
    buildOutputFileCount: '静的出力のファイル数上限は未確認',
    singleStaticFileMB: '単一静的ファイルの上限は未確認(build は自主ガードで 90MB 超を拒否)',
    note: '未確認の項目は超過するとも超えないとも断定しない。実デプロイでの観測が必要。',
  },
};
// 後方互換(Mission 201 の import 先)。判定には使わない。
export const VERCEL_HOBBY_ASSUMED = { verified: false, deprecated: 'VERCEL_HOBBY_LIMITS を使うこと(confirmed/unconfirmed 分離)' };

// Cloudflare R2 無料枠(https://developers.cloudflare.com/r2/pricing/ ; ChatGPT 確認値)。超過後は課金。ユーザー事前承認なしに口座/バケット作成・アップロードしない。
export const R2_FREE_TIER = { storageGBMonth: 10, classAPerMonth: 1000000, classBPerMonth: 10000000, directEgress: 'free', overFreeTier: 'billed', requiresUserApproval: true };

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

// 判定には confirmed のみを使う。unconfirmed は undetermined に列挙し断定しない。
export function fitAgainstLimits(est, limits = VERCEL_HOBBY_LIMITS) {
  const c = limits.confirmed, hi = est.lod1GlbMB.high, mid = est.lod1GlbMB.mid;
  const gb = (x) => +(x / 1024).toFixed(2);
  const retained = 6; // 直近3 production + 直近3 any-type(最悪ケース)
  return {
    confirmedLimitsUsed: true,
    buildTime: { estimatedConversionMinutes: +(est.buildSeconds.mid / 60).toFixed(1), limitMinutes: c.buildMinutes,
      verdict: est.buildSeconds.mid / 60 <= c.buildMinutes ? '変換のみなら45分内(4 vCPU Actions の実測比例。Vercel 機は未実測。ZIP Range 取得/LOD2/ID監査は含まず) → 毎回ビルドは非推奨' : '45分超 → 毎回の区変換は不可' },
    deploymentStorage: { teamLimitGB: c.teamDeploymentStorageGB, perDeploymentGB: { low: gb(est.lod1GlbMB.low), mid: gb(mid), high: gb(hi) }, retainedDeployments: retained, worstCaseGB: gb(hi * retained),
      verdict: (hi * retained) / 1024 > c.teamDeploymentStorageGB ? '保持6デプロイ×全24区(LOD1のみ)で team storage 10GB 超の可能性 → 同一origin全24区は要警戒' : '範囲内の見込み' },
    transfer: { limitGBPerMonth: c.transferGBPerMonth, fullViewGB: gb(mid), fullViewsToLimit: Math.floor(c.transferGBPerMonth / gb(mid)), note: '全区を読むと約' + gb(mid) + 'GB/人(LOD1のみ・キャッシュ無し最悪ケース)。月100GBは全区フル閲覧で約' + Math.floor(c.transferGBPerMonth / gb(mid)) + '回分(R2 直送egressは無料)' },
    undetermined: ['静的出力の総量上限', '静的出力のファイル数上限', '単一静的ファイル上限'],
    files: { mid: est.files.mid, high: est.files.high, note: 'CLI source files 上限15000は source upload の話で、build output ファイル数の上限ではない' },
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
    mission: '202', readOnly: true, networkUsed: false, generatedAt: new Date().toISOString(),
    source: { package: inp.lock.package.name, etag: inp.lock.http.etag, contentLengthMB: +(inp.lock.http.contentLength / MB).toFixed(0), vintage: 2025 },
    vercelHobbyLimits: VERCEL_HOBBY_LIMITS, r2FreeTier: R2_FREE_TIER, plans, estimate: est, fit: fitAgainstLimits(est),
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
