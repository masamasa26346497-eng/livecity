#!/usr/bin/env node
// tools/build-station-index.js
// [Mission 35K §2/§3/§4/§6] 駅を事業者つきで表示できるようにするための索引を作る。
//
//   canonical の駅（stations.json）は id / 名前 / 位置しか持たない。事業者は OSM の
//   `operator` / `network` タグにあるので、**canonical には触らず** 別ファイルで束ねる。
//
//   事業者の決め方（§1 駅名を直書きしない）:
//     1. 駅 node の `operator` / `network` タグ
//     2. 無ければ **最寄りの鉄道線の name**（「JR阪和線」「Osaka Metro御堂筋線」など実データ）
//     3. それでも分からなければ unknown（総称アイコン）
//   どちらも「文字列のパターン」で分類する。駅名の一覧は持たない。
//
//   出力: public/map-data/osaka-city/derived/station-index.json
//         data/processed/osaka-city/derived/station-index.json
//         data/reports/station-index.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { latLonToLiveCityWorld } from './lib/livecity-coordinate-system.js';
import { classifyPointToWard } from './lib/point-in-polygon.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const SRC = {
  stations: P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'stations.json'),
  raw: P('data', 'raw', 'osaka-city', 'railways-osm.json'),
  wards: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
};
export const OUT_FILES = [
  P('public', 'map-data', 'osaka-city', 'derived', 'station-index.json'),
  P('data', 'processed', 'osaka-city', 'derived', 'station-index.json'),
];
export const REPORT = P('data', 'reports', 'station-index.json');

/**
 * §6 事業者グループ。`match` は **operator / network / 路線名の文字列**に当てる。
 * 駅名は一切見ない。`code` はラベルに出す短い記号、`group` は Metro / JR / 私鉄の 3 分類。
 * 並び順が優先順位（先に当たったものを採る）。
 */
export const OPERATORS = [
  { id: 'metro', code: 'M', label: 'Osaka Metro', group: 'metro', color: 0x1f8ecd,
    match: /大阪市高速電気軌道|Osaka\s*Metro|大阪市営地下鉄|大阪メトロ/i },
  { id: 'newtram', code: 'NT', label: 'ニュートラム', group: 'metro', color: 0x1f8ecd,
    match: /ニュートラム|南港ポートタウン線/ },
  // 「JR〜貨物線」は貨物として分類したいので JR より前に置く。
  { id: 'jr-freight', code: 'JF', label: 'JR貨物', group: 'jr', color: 0x6b7a86,
    match: /日本貨物鉄道|貨物線/ },
  { id: 'jr', code: 'JR', label: 'JR西日本', group: 'jr', color: 0x2f7d4f,
    match: /西日本旅客鉄道|^JR|JR(?=[^A-Za-z])|JR西日本/ },
  { id: 'shinkansen', code: 'SK', label: '新幹線', group: 'jr', color: 0x2f7d4f,
    match: /新幹線/ },
  { id: 'hankyu', code: 'HK', label: '阪急', group: 'private', color: 0x8b4a3a,
    match: /阪急/ },
  { id: 'hanshin', code: 'HS', label: '阪神', group: 'private', color: 0xd08a2a,
    match: /阪神電気鉄道|阪神/ },
  { id: 'kintetsu', code: 'KT', label: '近鉄', group: 'private', color: 0xb03a48,
    match: /近畿日本鉄道|近鉄/ },
  { id: 'nankai', code: 'NK', label: '南海', group: 'private', color: 0x2a6fb0,
    match: /南海/ },
  { id: 'keihan', code: 'KH', label: '京阪', group: 'private', color: 0x2f8f6f,
    match: /京阪/ },
  { id: 'hankai', code: 'HN', label: '阪堺', group: 'private', color: 0x9a6b3a,
    match: /阪堺/ },
  { id: 'monorail', code: 'MR', label: '大阪モノレール', group: 'private', color: 0x7a5aa8,
    match: /大阪高速鉄道|大阪モノレール|モノレール/ },
  { id: 'kitakyu', code: 'KQ', label: '北大阪急行', group: 'private', color: 0x4a6fa8,
    match: /北大阪急行/ },
];
export const UNKNOWN_OPERATOR = { id: 'unknown', code: '●', label: '鉄道', group: 'other', color: 0x7b8794 };

/** 文字列（operator / network / 路線名）から事業者を決める。当たらなければ null。 */
export function classifyOperator(text) {
  if (!text) return null;
  const s = String(text);
  for (const o of OPERATORS) if (o.match.test(s)) return o;
  return null;
}

/** 駅周辺の路線を見る半径（m）。 */
export const LINE_RADIUS_M = 220;

/**
 * 路線名の「事業者つき / なし」の対応をデータ自身から学習する。
 *
 * 同じ線路に「JR大阪環状線」と「大阪環状線」の両方の way があり、後者だけが駅の近くにある
 * と unknown になる（JR の駅 5 件がこれで落ちた）。路線名の一覧をコードに書く代わりに、
 * **事業者が判る名前から接頭辞を剥がした形**を辞書にして、判らない名前を引く。
 *   「JR大阪環状線」→ jr を、剥がした「大阪環状線」にも割り当てる。
 */
export function learnLineOperators(lineNames) {
  const learned = new Map();
  for (const name of lineNames) {
    const o = classifyOperator(name);
    if (!o) continue;
    const m = o.match.exec(name);
    if (!m) continue;
    const bare = (name.slice(0, m.index) + name.slice(m.index + m[0].length)).trim();
    if (bare.length >= 2 && !classifyOperator(bare) && !learned.has(bare)) learned.set(bare, o);
  }
  return learned;
}
/** 貨物線は旅客駅の事業者としては採らない（同じ線路に旅客線が並んでいる）。 */
const isFreight = (o) => o && o.id === 'jr-freight';

/** §3 駅 1 件の事業者を、タグ → 周辺の路線名 の順で決める。 */
export function resolveOperator({ tags, nearbyLineNames, learned }) {
  const t = tags || {};
  for (const [src, val] of [['operator', t.operator], ['operator:en', t['operator:en']], ['network', t.network]]) {
    const o = classifyOperator(val);
    if (o) return { ...o, source: src, sourceValue: val };
  }
  // 旅客路線を優先し、貨物線しか無いときだけ貨物として扱う
  let freight = null;
  for (const n of (nearbyLineNames || [])) {
    const o = classifyOperator(n) || (learned && learned.get(n)) || null;
    if (!o) continue;
    if (isFreight(o)) { if (!freight) freight = { ...o, source: 'nearby-line', sourceValue: n }; continue; }
    return { ...o, source: 'nearby-line', sourceValue: n };
  }
  if (freight) return freight;
  return { ...UNKNOWN_OPERATOR, source: null, sourceValue: null };
}

/**
 * §4 同一駅とみなす距離（m）。同じ名前・同じ事業者でこの距離以内なら 1 つに畳む。
 * 地下鉄の大きな駅はホームが離れており（なんばは 400m 近い）、90m では畳めなかった。
 * 名前と事業者が一致していることが条件なので、この距離でも別駅を巻き込まない。
 */
export const DEDUPE_M = 450;
/** canonical の駅と OSM 駅 node を位置で結ぶときの許容（m）。同じ変換を通すのでほぼ 0 になる。 */
export const JOIN_M = 5;
/** §4 乗換とみなす距離（m）。名前が違っても近ければ乗換の目印にする。 */
export const TRANSFER_M = 260;

/**
 * §4 重複統合。**名前が違えば別駅**（大阪駅 / 梅田駅 / 東梅田駅 は別物）。
 * 同じ名前 かつ 同じ事業者 かつ 近い ものだけ畳む。
 */
export function dedupeStations(list, withinM = DEDUPE_M) {
  const out = [];
  const merged = [];
  for (const s of list) {
    const hit = out.find((o) => o.name === s.name && o.operator.id === s.operator.id
      && Math.hypot(o.x - s.x, o.z - s.z) <= withinM);
    if (hit) {
      hit.mergedIds.push(s.stationId);
      // 代表点は統合した点の平均
      const n = hit.mergedIds.length + 1;
      hit.x = +(((hit.x * (n - 1)) + s.x) / n).toFixed(2);
      hit.z = +(((hit.z * (n - 1)) + s.z) / n).toFixed(2);
      merged.push({ kept: hit.stationId, dropped: s.stationId, name: s.name });
      continue;
    }
    out.push({ ...s, mergedIds: [] });
  }
  return { stations: out, merged };
}

/** §4/§7 乗換判定: 近くに **別の事業者** の駅があるか。 */
export function markTransfers(list, withinM = TRANSFER_M) {
  for (const s of list) {
    const near = list.filter((o) => o !== s && Math.hypot(o.x - s.x, o.z - s.z) <= withinM);
    const ops = new Set(near.map((o) => o.operator.id));
    s.transferWith = [...ops];
    s.isTransfer = ops.size > 0;
  }
  return list;
}

/**
 * §7/§8 表示の重み。数字が小さいほど先に出す。
 *   乗換が多い / 事業者が多い駅ほど主要駅とみなす（駅名の一覧は持たない）。
 */
export function stationImportance(s) {
  const n = (s.transferWith || []).length;
  if (n >= 3) return 'major';
  if (n >= 1) return 'transfer';
  return 'local';
}

const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

export function run() {
  const t0 = Date.now();
  const canon = rj(SRC.stations);
  const raw = rj(SRC.raw);
  const wards = (rj(SRC.wards) || {}).wards || [];

  // 駅 node のタグを **位置で** 突き合わせる。
  //   canonical の stationId はタイル生成時のハッシュ（station_49be4527af0489）で、
  //   OSM の node id ではない。id では結べないので、同じ変換を通した world 座標で照合する。
  const rawNodes = [];
  for (const e of raw.elements) {
    if (e.type !== 'node' || !Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
    const w = latLonToLiveCityWorld(e.lat, e.lon);
    rawNodes.push({ id: e.id, x: w.x, z: w.z, tags: e.tags || {} });
  }
  /** 位置が一致する駅 node のタグ（JOIN_M 以内で最も近いもの）。 */
  const tagsAt = (x, z) => {
    let best = null, bestD = JOIN_M;
    for (const n of rawNodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d <= bestD) { bestD = d; best = n; }
    }
    return best ? { tags: best.tags, osmNodeId: best.id, joinDistM: +bestD.toFixed(2) } : null;
  };
  // 路線（name つき）を world 座標で持つ。最寄り路線を引くため。
  const lines = [];
  for (const e of raw.elements) {
    if (e.type !== 'way' || !e.tags || !e.tags.name || !Array.isArray(e.geometry)) continue;
    const pts = e.geometry.map((g) => { const w = latLonToLiveCityWorld(g.lat, g.lon); return [w.x, w.z]; });
    if (pts.length < 2) continue;
    lines.push({ name: e.tags.name, pts });
  }
  /**
   * 点の周りの路線名を近い順に返す。
   * **最も近い 1 本だけを見てはいけない**。同じ線路に「JR大阪環状線」と「大阪環状線」の
   * 両方の way があり、最も近い頂点がたまたま事業者の分からない方だと unknown になる
   * （実際に JR の駅 16 件がこれで unknown になった）。半径内の候補を全部返し、
   * 事業者が判る名前が 1 つでもあればそれを採る。
   */
  const nearbyLines = (x, z, radiusM) => {
    const byName = new Map();
    for (const L of lines) {
      let d = Infinity;
      for (const p of L.pts) { const q = Math.hypot(p[0] - x, p[1] - z); if (q < d) d = q; }
      if (d <= radiusM && (!byName.has(L.name) || byName.get(L.name) > d)) byName.set(L.name, d);
    }
    return [...byName.entries()].sort((a, b) => a[1] - b[1]).map(([name, distM]) => ({ name, distM }));
  };

  const learned = learnLineOperators(lines.map((L) => L.name));
  const stat = { canonical: canon.count, joined: 0, withOperatorTag: 0, viaNearestLine: 0, unknown: 0 };
  let raws = canon.stations.map((s) => {
    const j = tagsAt(s.point[0], s.point[1]);
    const tags = j ? j.tags : {};
    const near = nearbyLines(s.point[0], s.point[1], LINE_RADIUS_M);
    const op = resolveOperator({ tags, nearbyLineNames: near.map((n) => n.name), learned });
    if (j) stat.joined++;
    if (op.source === 'nearby-line') stat.viaNearestLine++;
    else if (op.source) stat.withOperatorTag++;
    else stat.unknown++;
    const w = classifyPointToWard(s.point[0], s.point[1], wards);
    return {
      stationId: s.stationId, name: s.name, x: s.point[0], z: s.point[1],
      wardId: (w && w.wardId) || null,
      operator: { id: op.id, code: op.code, label: op.label, group: op.group, color: op.color },
      operatorSource: op.source, operatorSourceValue: op.sourceValue,
      nearestLine: near.length ? near[0].name : null,
      nearestLineDistM: near.length ? Math.round(near[0].distM) : null,
      nearbyLines: near.slice(0, 4).map((n) => n.name),
      railwayRef: s.railwayRef || null,
      osmNodeId: j ? j.osmNodeId : null,
    };
  });

  const { stations, merged } = dedupeStations(raws);
  markTransfers(stations);
  for (const s of stations) s.importance = stationImportance(s);

  const byOperator = {}, byGroup = {}, byImportance = {};
  for (const s of stations) {
    byOperator[s.operator.id] = (byOperator[s.operator.id] || 0) + 1;
    byGroup[s.operator.group] = (byGroup[s.operator.group] || 0) + 1;
    byImportance[s.importance] = (byImportance[s.importance] || 0) + 1;
  }

  const doc = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35K',
    coordinateConvention: 'znorth-neg-v1',
    source: 'canonical rail stations + OSM 駅 node の operator / network + 最寄り路線名',
    note: '駅名の一覧は持たない。事業者は operator / network / 路線名の文字列から分類する。',
    dedupeM: DEDUPE_M, transferM: TRANSFER_M,
    canonicalCount: canon.count, count: stations.length, mergedCount: merged.length,
    operators: OPERATORS.map((o) => ({ id: o.id, code: o.code, label: o.label, group: o.group, color: o.color }))
      .concat([{ ...UNKNOWN_OPERATOR }]),
    byOperator, byGroup, byImportance,
    stations,
  };
  const text = JSON.stringify(doc);
  for (const f of OUT_FILES) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  const report = { version: 1, generatedAt: doc.generatedAt, missionId: '35K',
    stat, byOperator, byGroup, byImportance, mergedCount: merged.length, mergedSamples: merged.slice(0, 20),
    unknownSamples: stations.filter((s) => s.operator.id === 'unknown').slice(0, 20).map((s) => ({ name: s.name, nearestLine: s.nearestLine, distM: s.nearestLineDistM })),
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  return { doc, report };
}

if (isMainModule(import.meta.url)) {
  const { doc, report } = run();
  console.log('[station-index] canonical', doc.canonicalCount, '→ 表示', doc.count, '（統合', doc.mergedCount, '件）');
  console.log('[station-index] 事業者タグから', report.stat.withOperatorTag, '/ 最寄り路線から', report.stat.viaNearestLine, '/ 不明', report.stat.unknown);
  console.log('[station-index] group', JSON.stringify(doc.byGroup));
  console.log('[station-index] operator', JSON.stringify(doc.byOperator));
  console.log('[station-index] 重要度', JSON.stringify(doc.byImportance));
  console.log('[station-index] out', OUT_FILES[0]);
}
