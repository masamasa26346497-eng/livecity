#!/usr/bin/env node
// tools/audit/osm-shared-source-coverage.js
// [Mission 35F §2/§3/§4] 旧 osaka-latest.osm.pbf に依存しているレイヤーを洗い出し、
//   北側で切れているかを **layer ごとに** 実測する。
//
//   35D（建物）/ 35E（道路）で同じ崖（lat 34.73〜34.74）が出た。
//   「OSM 由来だから全部作り直す」のではなく、**実際に切れていたものだけ**直すための材料を作る。
//
//   ここでは judge するだけで canonical も tile も 1 バイトも書かない。
//   実行: node --max-old-space-size=14336 tools/audit/osm-shared-source-coverage.js
//   出力: data/reports/osm-shared-source-coverage.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { pbfPrimitiveStream } from '../lib/osm-pbf-stream.js';
import { latLonToLiveCityWorld } from '../lib/livecity-coordinate-system.js';
import { classifyPointToWard } from '../lib/point-in-polygon.js';
import { LAYER_TAG_MATCH } from '../import/osm-pbf-city.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const S = {
  oldPbf: P('data', 'raw', 'osm', 'osaka-latest.osm.pbf'),
  newPbf: P('data', 'raw', 'osm', 'osaka-full-coverage.osm.pbf'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  cacheDir: P('data', 'processed', 'osaka-city', 'osm-shared-source'),
  out: P('data', 'reports', 'osm-shared-source-coverage.json'),
};
/** §3 見る緯度帯（0.01 度刻み）。 */
export const LAT_BANDS = [34.70, 34.71, 34.72, 34.73, 34.74, 34.75, 34.76];
/** §3/§4 北側の重点確認区。 */
export const NORTH_WARDS = ['higashiyodogawa', 'yodogawa', 'asahi', 'nishiyodogawa', 'kita'];
/** 被覆を測るセルの大きさ。 */
export const COVERAGE_CELL_M = 200;
/** 市域 + 余白の緯度経度 bbox（35D と同じ範囲）。広域 PBF の node を絞るのに使う。 */
export const CITY_BBOX = { south: 34.5656, north: 34.7893, west: 135.3186, east: 135.6244 };

/**
 * §2/§3 監査する種別。osm-pbf-city.js の LAYER_TAG_MATCH をそのまま使い、
 * 加えて mission が名指しした細目（station / platform / yard / 各 landuse）を別立てで数える。
 * ここで新しい判定基準を作らない（既存のパイプラインが何を拾うかを測るのが目的）。
 */
export const KINDS = [
  { id: 'railway-way', label: '鉄道線路 (rail/light_rail/subway)', prim: 'way',
    match: (t) => LAYER_TAG_MATCH.railways.way(t) },
  { id: 'railway-station-node', label: '駅 node (railway=station)', prim: 'node',
    match: (t) => LAYER_TAG_MATCH.railways.node(t) },
  { id: 'railway-platform', label: 'プラットフォーム', prim: 'way',
    match: (t) => t.railway === 'platform' || t.public_transport === 'platform' },
  { id: 'railway-yard', label: '車両基地 (service=yard)', prim: 'way',
    match: (t) => typeof t.railway === 'string' && (t.service === 'yard' || t.landuse === 'railway') },
  { id: 'public-transport', label: 'public_transport features', prim: 'node',
    match: (t) => typeof t.public_transport === 'string' },
  { id: 'waterway-way', label: '水系 way (river/canal/stream/drain/ditch/natural=water)', prim: 'way',
    match: (t) => LAYER_TAG_MATCH.waterways.way(t) },
  { id: 'natural-water', label: 'natural=water', prim: 'way', match: (t) => t.natural === 'water' },
  { id: 'park-leisure', label: 'leisure=park', prim: 'way', match: (t) => t.leisure === 'park' },
  { id: 'landuse-grass', label: 'landuse=grass', prim: 'way', match: (t) => t.landuse === 'grass' },
  { id: 'landuse-recreation', label: 'landuse=recreation_ground', prim: 'way', match: (t) => t.landuse === 'recreation_ground' },
  { id: 'park-any', label: 'parks レイヤー全体', prim: 'way', match: (t) => LAYER_TAG_MATCH.parks.way(t) },
  { id: 'place-label', label: 'place ラベル node', prim: 'node', match: (t) => typeof t.place === 'string' && !!t.name },
];

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** 緯度を 0.01 度に丸めたキー。 */
export function latKey(lat) { return (Math.floor(lat * 100) / 100).toFixed(2); }

/**
 * §3 北側の崖。南から北へ見て 1/10 以下に落ちる点。
 * 35D / 35E と同じ物差し（同じ現象を同じ基準で測る）。
 */
export function latitudeCliff(hist, minBefore = 100, ratio = 10) {
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
  let cliff = null;
  for (let i = 1; i < keys.length; i++) {
    const prev = hist[keys[i - 1].toFixed(2)], cur = hist[keys[i].toFixed(2)] || 0;
    if (prev >= minBefore && cur > 0 && prev / cur >= ratio) {
      cliff = { atLat: keys[i], before: prev, after: cur, ratio: +(prev / cur).toFixed(1) };
    }
    if (prev >= minBefore && cur === 0) cliff = { atLat: keys[i], before: prev, after: 0, ratio: Infinity };
  }
  return cliff;
}

/**
 * §5 そのレイヤーが旧 PBF で切れていたか。
 *
 * 当初は「緯度ヒストグラムに崖があるか」で判定していたが、**疎なレイヤーでは機能しない**。
 * 鉄道・水系・公園は建物や道路に比べて件数が 2〜3 桁少なく、1 つの緯度帯あたり数件しか
 * 無いので「前の帯の 1/10 以下」という基準に引っかからない。実際に railway / waterway /
 * parks はすべて「崖なし」と出たが、区別に見ると北側だけが 40% 増えていた。
 *
 * 正しい判定は **北側の区と南側の区の増え方の差**。
 * 切断が原因なら、南側は変わらず（OSM の編集ぶんだけ）北側だけが増える。
 */
export const CITY_NORTH_LAT = 34.7688;
/** 北側がこれ以上増えていたら「増えた」とみなす。 */
export const NORTH_GAIN_PCT = 5;
/** 南側の増え方がこれ以下なら「南は変わっていない」とみなす（OSM の編集ぶん）。 */
export const SOUTH_STABLE_PCT = 5;

/** 崖による判定（参考値として残す。疎なレイヤーでは当てにならない）。 */
export function isTruncatedByCliff(cliff, cityNorth = CITY_NORTH_LAT) {
  return !!(cliff && cliff.atLat <= cityNorth);
}
/**
 * 北側と南側の増え方から、旧 PBF の切断の影響を受けていたかを判定する。
 * @param {{old:number,new:number}} north 北側の区の合計
 * @param {{old:number,new:number}} south それ以外の区の合計
 */
export function truncationSignal(north, south) {
  const northGainPct = north.old ? ((north.new - north.old) / north.old) * 100 : null;
  const southGainPct = south.old ? ((south.new - south.old) / south.old) * 100 : null;
  const affected = northGainPct != null && southGainPct != null
    && northGainPct >= NORTH_GAIN_PCT && Math.abs(southGainPct) <= SOUTH_STABLE_PCT;
  return {
    northOld: north.old, northNew: north.new, northGainPct: northGainPct == null ? null : +northGainPct.toFixed(1),
    southOld: south.old, southNew: south.new, southGainPct: southGainPct == null ? null : +southGainPct.toFixed(1),
    affectedByOldPbfTruncation: affected,
    rationale: affected
      ? '北側だけが増えている（南側は変わらない）＝旧 PBF の切断の影響'
      : (northGainPct == null ? 'データ不足'
        : (Math.abs(southGainPct) > SOUTH_STABLE_PCT
          ? '南側も動いている＝切断ではなく OSM 側の編集差'
          : '北側が増えていない＝切断の影響なし')),
  };
}

/** PBF を 2 パスで走査し、種別ごとの緯度ヒストグラムと区別件数を作る。 */
export async function scanPbf(pbfPath, wards, { bbox = CITY_BBOX } = {}) {
  // pass 1: 市域 bbox の node（way の座標解決 + node 種別の判定に使う）
  const coord = new Map();
  const nodeHist = {}, nodeWard = {};
  for (const k of KINDS) if (k.prim === 'node') { nodeHist[k.id] = {}; nodeWard[k.id] = {}; }
  let scannedNodes = 0;
  for await (const p of pbfPrimitiveStream(pbfPath)) {
    if (p.type !== 'node') continue;
    scannedNodes++;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (p.lat < bbox.south || p.lat > bbox.north || p.lon < bbox.west || p.lon > bbox.east) continue;
    coord.set(p.id, [p.lat, p.lon]);
    const t = p.tags || {};
    for (const k of KINDS) {
      if (k.prim !== 'node' || !k.match(t)) continue;
      const lk = latKey(p.lat);
      nodeHist[k.id][lk] = (nodeHist[k.id][lk] || 0) + 1;
      const w = latLonToLiveCityWorld(p.lat, p.lon);
      const wr = classifyPointToWard(w.x, w.z, wards);
      const wid = (wr && wr.wardId) || '(outside)';
      nodeWard[k.id][wid] = (nodeWard[k.id][wid] || 0) + 1;
    }
  }
  // pass 2: way
  const wayHist = {}, wayWard = {}, wayCells = {};
  for (const k of KINDS) if (k.prim === 'way') { wayHist[k.id] = {}; wayWard[k.id] = {}; wayCells[k.id] = new Map(); }
  let scannedWays = 0, matchedWays = 0;
  for await (const p of pbfPrimitiveStream(pbfPath)) {
    if (p.type !== 'way') continue;
    scannedWays++;
    const t = p.tags || {};
    const hits = KINDS.filter((k) => k.prim === 'way' && k.match(t));
    if (!hits.length || !p.refs || !p.refs.length) continue;
    // 市域内の node を 1 つでも使っていれば対象
    const pts = [];
    for (const r of p.refs) { const ll = coord.get(r); if (ll) pts.push(ll); }
    if (!pts.length) continue;
    matchedWays++;
    let sLat = 0;
    for (const q of pts) sLat += q[0];
    const lk = latKey(sLat / pts.length);
    const mid = pts[Math.floor(pts.length / 2)];
    const mw = latLonToLiveCityWorld(mid[0], mid[1]);
    const wr = classifyPointToWard(mw.x, mw.z, wards);
    const wid = (wr && wr.wardId) || '(outside)';
    for (const k of hits) {
      wayHist[k.id][lk] = (wayHist[k.id][lk] || 0) + 1;
      wayWard[k.id][wid] = (wayWard[k.id][wid] || 0) + 1;
      if (!wayCells[k.id].has(wid)) wayCells[k.id].set(wid, new Set());
      const set = wayCells[k.id].get(wid);
      for (const q of pts) {
        const w = latLonToLiveCityWorld(q[0], q[1]);
        set.add(Math.floor(w.x / COVERAGE_CELL_M) + ',' + Math.floor(w.z / COVERAGE_CELL_M));
      }
    }
  }
  coord.clear();

  const byKind = {};
  for (const k of KINDS) {
    const hist = k.prim === 'node' ? nodeHist[k.id] : wayHist[k.id];
    const ward = k.prim === 'node' ? nodeWard[k.id] : wayWard[k.id];
    const cells = {};
    if (k.prim === 'way') for (const [wid, s] of wayCells[k.id]) cells[wid] = s.size;
    const total = Object.values(hist).reduce((a, b) => a + b, 0);
    byKind[k.id] = { label: k.label, prim: k.prim, total, hist, ward, cells,
      latBands: Object.fromEntries(LAT_BANDS.map((l) => [l.toFixed(2), hist[l.toFixed(2)] || 0])),
      cliff: latitudeCliff(hist) };
  }
  return { pbf: path.basename(pbfPath), scannedNodes, scannedWays, matchedWays, byKind };
}

export async function run({ rescan = false } = {}) {
  const t0 = Date.now();
  fs.mkdirSync(S.cacheDir, { recursive: true });
  const wards = (rj(S.wardPolys) || {}).wards || [];
  const scans = {};
  for (const [tag, p] of [['old', S.oldPbf], ['new', S.newPbf]]) {
    if (!fs.existsSync(p)) { console.log('[shared] PBF が無い', p); continue; }
    const cache = path.join(S.cacheDir, 'scan-' + path.basename(p).replace(/\.osm\.pbf$/, '') + '.json');
    let s = rescan ? null : rj(cache);
    if (s) console.log('[shared]', tag, '走査結果を再利用');
    else {
      console.log('[shared]', tag, 'PBF 走査…', path.basename(p));
      s = await scanPbf(p, wards);
      fs.writeFileSync(cache, JSON.stringify(s));
    }
    scans[tag] = s;
    console.log('[shared]', tag, 'node', s.scannedNodes, 'way', s.scannedWays, '対象 way', s.matchedWays);
  }

  // §3/§4/§5 種別ごとに比較して、直すべきものを決める
  const kinds = KINDS.map((k) => {
    const o = scans.old ? scans.old.byKind[k.id] : null;
    const n = scans.new ? scans.new.byKind[k.id] : null;
    const cliffSaysTruncated = isTruncatedByCliff(o && o.cliff);
    const wardRows = [];
    const wardIds = [...new Set([...(o ? Object.keys(o.ward) : []), ...(n ? Object.keys(n.ward) : [])])]
      .filter((w) => w !== '(outside)').sort();
    for (const wid of wardIds) {
      const ov = (o && o.ward[wid]) || 0, nv = n ? (n.ward[wid] || 0) : null;
      const oc = (o && o.cells[wid]) || 0, nc = n ? (n.cells[wid] || 0) : null;
      wardRows.push({ wardId: wid, north: NORTH_WARDS.includes(wid), old: ov, new: nv,
        added: nv != null ? nv - ov : null,
        oldCells: oc, newCells: nc,
        cellGainPct: (nc != null && oc) ? +((((nc - oc) / oc) * 100)).toFixed(1) : null });
    }
    const northRows = wardRows.filter((w) => w.north);
    const southRows = wardRows.filter((w) => !w.north);
    const sum = (rows, key) => rows.reduce((a, w) => a + (w[key] || 0), 0);
    const signal = truncationSignal(
      { old: sum(northRows, 'old'), new: sum(northRows, 'new') },
      { old: sum(southRows, 'old'), new: sum(southRows, 'new') });
    return { id: k.id, label: k.label, prim: k.prim,
      oldTotal: o ? o.total : null, newTotal: n ? n.total : null,
      added: (o && n) ? n.total - o.total : null,
      oldLatBands: o ? o.latBands : null, newLatBands: n ? n.latBands : null,
      oldCliff: o ? o.cliff : null, newCliff: n ? n.cliff : null,
      cliffSaysTruncated,
      truncationSignal: signal,
      truncatedInOldPbf: signal.affectedByOldPbfTruncation,
      northAdded: (o && n) ? sum(northRows, 'added') : null,
      byWard: wardRows, northRows,
      // §5 直す条件: 北側だけが増えている（＝切断の影響）
      needsRebuild: signal.affectedByOldPbfTruncation };
  });

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35F',
    cityNorthLat: CITY_NORTH_LAT, latBands: LAT_BANDS, northWards: NORTH_WARDS,
    coverageCellM: COVERAGE_CELL_M,
    pbf: { old: scans.old ? { file: scans.old.pbf, nodes: scans.old.scannedNodes, ways: scans.old.scannedWays } : null,
      new: scans.new ? { file: scans.new.pbf, nodes: scans.new.scannedNodes, ways: scans.new.scannedWays } : null },
    kinds,
    needsRebuild: kinds.filter((k) => k.needsRebuild).map((k) => k.id),
    unaffected: kinds.filter((k) => !k.needsRebuild).map((k) => k.id),
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(S.out), { recursive: true });
  fs.writeFileSync(S.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run({ rescan: process.argv.includes('--rescan') }).then((o) => {
    console.log('[shared] 種別ごとの結果（区内の件数で判定。北側だけ増えていれば切断の影響）:');
    console.log('   ' + 'kind'.padEnd(22) + '北側 old→new'.padEnd(22) + '南側 old→new'.padEnd(22) + '要再生成');
    for (const k of o.kinds) {
      const s = k.truncationSignal;
      console.log('   ' + k.id.padEnd(22)
        + (s.northOld + '→' + s.northNew + ' (' + (s.northGainPct == null ? '-' : (s.northGainPct >= 0 ? '+' : '') + s.northGainPct + '%') + ')').padEnd(22)
        + (s.southOld + '→' + s.southNew + ' (' + (s.southGainPct == null ? '-' : (s.southGainPct >= 0 ? '+' : '') + s.southGainPct + '%') + ')').padEnd(22)
        + (k.needsRebuild ? 'YES' : '-'));
    }
    console.log('[shared] 要再生成', JSON.stringify(o.needsRebuild));
    console.log('[shared] out', S.out);
  }).catch((e) => { console.error(e); process.exit(1); });
}
