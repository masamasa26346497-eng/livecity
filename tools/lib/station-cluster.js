// tools/lib/station-cluster.js
// [見た目改善 Mission14] 駅ノードのクラスタリング + importance 分類（純粋ロジック・THREE 非依存）。
//   station node は operator/railway 属性を持たない（{id, name, x, z} のみ）ため、
//   (a) 近接 + 主要ターミナルの別名グループで clustering し、
//   (b) override 名リスト + 周辺の鉄道 way 数 + cluster member 数で MAJOR/MEDIUM/LOCAL に分類する。
//   canonical。public/osaka_3d_buildings.ward-ux-v1.html の StationLabelLayer へ同じ計算を inline する。

// 主要ターミナルの別名グループ（会社名ではなく「同一エリアで1ラベルにまとめたい駅名」の集合）。
//   データだけでは importance 判定が難しいため、これらは常に MAJOR とし、グループ内は1ラベルへ統合する。
export const STATION_MAJOR_GROUPS = [
  { canonical: '大阪・梅田', names: ['大阪', '梅田', '大阪梅田', '東梅田', '西梅田', '北新地'] },
  { canonical: 'なんば', names: ['なんば', '難波', 'JR難波', '大阪難波'] },
  { canonical: '天王寺', names: ['天王寺', '大阪阿部野橋', '阿倍野'] },
  { canonical: '新今宮', names: ['新今宮', '新今宮駅前', '動物園前'] },
  { canonical: '新大阪', names: ['新大阪'] },
  { canonical: '京橋', names: ['京橋'] },
  { canonical: '鶴橋', names: ['鶴橋'] },
  { canonical: '大阪上本町', names: ['大阪上本町', '上本町'] },
  { canonical: '淀屋橋', names: ['淀屋橋'] },
  { canonical: '本町', names: ['本町'] },
  { canonical: '心斎橋', names: ['心斎橋'] },
  { canonical: '西九条', names: ['西九条'] },
];

const NAME_TO_GROUP = (() => {
  const m = new Map();
  for (const g of STATION_MAJOR_GROUPS) for (const n of g.names) m.set(n, g);
  return m;
})();

/** 駅名の正規化（全角空白除去・NFKC）。表記揺れの吸収は最小限に留める。 */
export function normalizeStationName(name) {
  return String(name == null ? '' : name).normalize('NFKC').replace(/[\s　]+/g, '').trim();
}

export function stationGroupOf(name) {
  return NAME_TO_GROUP.get(normalizeStationName(name)) || null;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * 駅ノードを近接クラスタリングし、主要ターミナル別名グループを統合する。
 * @param {{id:string,name:string,x:number,z:number}[]} stations
 * @param {{radiusM?:number, groupMergeM?:number}} [opts]
 * @returns {{clusterId:string,label:string,x:number,z:number,memberIds:string[],memberNames:string[],group:string|null}[]}
 */
export function clusterStations(stations, opts = {}) {
  const radiusM = opts.radiusM ?? 130;
  const groupMergeM = opts.groupMergeM ?? 900;
  const sameNameMergeM = opts.sameNameMergeM ?? 420;
  const pts = (stations || []).filter((s) => s && Number.isFinite(s.x) && Number.isFinite(s.z));

  // 1. 近接（single-linkage 貪欲）クラスタリング
  const used = new Array(pts.length).fill(false);
  let raw = [];
  for (let i = 0; i < pts.length; i++) {
    if (used[i]) continue;
    const members = [pts[i]]; used[i] = true;
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < pts.length; j++) {
        if (used[j]) continue;
        if (members.some((m) => dist(m, pts[j]) < radiusM)) { members.push(pts[j]); used[j] = true; changed = true; }
      }
    }
    raw.push(members);
  }

  // 2. cluster オブジェクト化 + グループ判定
  let clusters = raw.map((members, idx) => {
    const x = members.reduce((s, m) => s + m.x, 0) / members.length;
    const z = members.reduce((s, m) => s + m.z, 0) / members.length;
    const names = [...new Set(members.map((m) => normalizeStationName(m.name)).filter(Boolean))];
    let group = null;
    for (const n of names) { const g = stationGroupOf(n); if (g) { group = g; break; } }
    // canonical label: グループがあればその canonical、無ければ最頻出 or 最短の名前
    const label = group ? group.canonical : (mostCommonName(members) || names[0] || '駅');
    return { clusterId: `sc_${idx}`, label, x, z, members, memberIds: members.map((m) => m.id), memberNames: names, group: group ? group.canonical : null, _groupRef: group };
  });

  // 3. 同一グループのクラスタを groupMergeM 以内で統合
  const byGroup = new Map();
  for (const c of clusters) if (c._groupRef) { const k = c._groupRef.canonical; (byGroup.get(k) || byGroup.set(k, []).get(k)).push(c); }
  const removed = new Set();
  for (const [, list] of byGroup) {
    if (list.length < 2) continue;
    const base = list[0];
    for (let i = 1; i < list.length; i++) {
      if (dist(base, list[i]) <= groupMergeM) {
        base.members.push(...list[i].members);
        base.memberIds.push(...list[i].memberIds);
        base.memberNames = [...new Set([...base.memberNames, ...list[i].memberNames])];
        removed.add(list[i].clusterId);
      }
    }
    // 統合後に重心を取り直す
    base.x = base.members.reduce((s, m) => s + m.x, 0) / base.members.length;
    base.z = base.members.reduce((s, m) => s + m.z, 0) / base.members.length;
  }
  clusters = clusters.filter((c) => !removed.has(c.clusterId));

  // 4. 同一 canonical label のクラスタを sameNameMergeM 以内で統合（platform node が離れている単一駅）
  const removed2 = new Set();
  for (let i = 0; i < clusters.length; i++) {
    if (removed2.has(clusters[i].clusterId)) continue;
    for (let j = i + 1; j < clusters.length; j++) {
      if (removed2.has(clusters[j].clusterId)) continue;
      if (clusters[i].label === clusters[j].label && dist(clusters[i], clusters[j]) <= sameNameMergeM) {
        clusters[i].members.push(...clusters[j].members);
        clusters[i].memberIds.push(...clusters[j].memberIds);
        clusters[i].memberNames = [...new Set([...clusters[i].memberNames, ...clusters[j].memberNames])];
        clusters[i].x = clusters[i].members.reduce((s, m) => s + m.x, 0) / clusters[i].members.length;
        clusters[i].z = clusters[i].members.reduce((s, m) => s + m.z, 0) / clusters[i].members.length;
        removed2.add(clusters[j].clusterId);
      }
    }
  }
  clusters = clusters.filter((c) => !removed2.has(c.clusterId));

  return clusters.map((c) => ({
    clusterId: c.clusterId, label: c.label, x: c.x, z: c.z,
    memberIds: c.memberIds, memberNames: c.memberNames, group: c.group,
  }));
}

function mostCommonName(members) {
  const cnt = new Map();
  for (const m of members) { const n = normalizeStationName(m.name); if (n) cnt.set(n, (cnt.get(n) || 0) + 1); }
  let best = null, bestN = 0;
  for (const [n, k] of cnt) if (k > bestN || (k === bestN && best && n.length < best.length)) { best = n; bestN = k; }
  return best;
}

/**
 * cluster の importance を分類する。
 * @param {{group:string|null, memberIds:string[]}} cluster
 * @param {{railWays?:number, subwayWays?:number, lightRailWays?:number}} nearby  cluster 周辺の鉄道 way 種別数
 * @returns {'major'|'medium'|'local'}
 */
export function classifyStationImportance(cluster, nearby = {}) {
  if (cluster && cluster.group) return 'major';
  const rail = nearby.railWays || 0, sub = nearby.subwayWays || 0;
  const members = (cluster && cluster.memberIds ? cluster.memberIds.length : 1);
  const interchange = rail > 0 && sub > 0;
  if (interchange || rail >= 8 || sub >= 10 || members >= 3) return 'medium';
  return 'local';
}

export function countByStationImportance(clusters, nearbyOf) {
  const out = { major: 0, medium: 0, local: 0, total: 0 };
  for (const c of clusters || []) {
    out.total++;
    out[classifyStationImportance(c, nearbyOf ? nearbyOf(c) : {})]++;
  }
  return out;
}

// 距離バンド（道路・鉄道・公園LODと一致）。
export const STATION_LABEL_BANDS = { farM: 9000, midM: 3500 };
export function stationLabelBand(distance) {
  const d = Number.isFinite(distance) ? distance : 0;
  if (d > STATION_LABEL_BANDS.farM) return 'far';
  if (d > STATION_LABEL_BANDS.midM) return 'mid';
  return 'near';
}
/** FAR=major / MID=major+medium / NEAR=all。 */
export function stationLabelVisible(importance, distance) {
  const band = stationLabelBand(distance);
  if (importance === 'major') return true;
  if (importance === 'medium') return band !== 'far';
  return band === 'near';
}
// FAR で表示される MAJOR ラベルの上限（画面が駅名だらけにならないための安全弁。collision と併用）。
export const STATION_LABEL_FAR_MAX = 26;
