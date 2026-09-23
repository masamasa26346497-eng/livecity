// tools/lib/gsi-road-edge-corridor-v3.js
// [Mission 31G-FIX18] Corridor-level GSI road edge reconstruction（Strategy B v3）。
//
//   FIX17 v2 の弱点（segment 単位の独立 best-match が、同一 corridor 内で pair 相手を
//   sidewalk/median/opposite carriageway/frontage road へ途中で切り替え、width が不自然に
//   跳ぶ＝幹線 scatter 悪化）を是正する。
//
//   手法（explainable・非 ML）:
//     1. EDGE_TRACK 構築（§7）: segment を端点連続性＋bearing連続性で束ね、同一物理縁の
//        連続 track にする（union-find。交差点では直進方向のみ橋渡し §15）。
//     2. side 分類（§8）: track の進行方向に対する外積符号で LEFT/RIGHT を推定し、
//        同じ側同士を pair 候補にしない。
//     3. corridor sequence optimization（§5）: track の segment 列に沿って、各位置での
//        候補 partner track を Viterbi DP で選ぶ。目的関数 = local pair score
//        − switch penalty（前の位置と partner track が変わったら減点）。
//        「1〜2 segment だけの pair 切替」は switch penalty で抑制され、
//        「持続する変化」は複数 segment 分の local score 総和が switch penalty を上回るため残る
//        （§12/§13 の genuine width change と誤 pair を区別する設計そのもの）。
//     4. width spike / change point（§11-13）: DP 出力後の width 系列で、1〜2 segment だけの
//        孤立した跳びを WIDTH_SPIKE として除外し、3 segment 以上持続する変化を CHANGE_POINT として残す。
//
//   §0 遵守: 座標・source geometry は一切変更しない。ここで作るのは全て導出データ。
//   lanes による幅の強制生成はしない。moving average 等の一律平滑化もしない
//   （DP は「どの pair 相手を追うか」を選ぶだけで、選ばれた区間の width 値自体は
//   実測 sepM をそのまま使う＝平滑化していない）。
import { buildGrid, queryGrid, scorePair, MIN_SEP_M, MAX_SEP_M } from './gsi-road-edge-pairing-v2.js';

const TRACK_NODE_SNAP_M = 2.0;   // segment 端点の連結判定（GSI 実測の断片境界誤差を吸収）
const trackNodeKey = ([x, z]) => Math.round(x / TRACK_NODE_SNAP_M) + ',' + Math.round(z / TRACK_NODE_SNAP_M);
const MIN_CHAIN_BEARING = 0.55;   // 緩やかなカーブまで許容して連結（§7）

// ── union-find ──
class DSU {
  constructor() { this.parent = new Map(); }
  find(x) { if (!this.parent.has(x)) this.parent.set(x, x); let r = x; while (this.parent.get(r) !== r) r = this.parent.get(r); let c = x; while (this.parent.get(c) !== c) { const n = this.parent.get(c); this.parent.set(c, r); c = n; } return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

/**
 * §1/§7 segment を EDGE_TRACK へ束ねる。
 * @param {Array} segs segmentize() の出力
 * @returns {{ trackOf: Map<segId,trackId>, tracksBySegOrder: Map<trackId, Array<seg>> }}
 */
export function buildEdgeTracks(segs) {
  const byNode = new Map();   // nodeKey -> [{seg, end:'a'|'b'}]
  const dsu = new DSU();
  for (const s of segs) {
    dsu.find(s.id);
    const a = trackNodeKey(s.coords[0]), b = trackNodeKey(s.coords[s.coords.length - 1]);
    for (const [k, end] of [[a, 'a'], [b, 'b']]) { let arr = byNode.get(k); if (!arr) { arr = []; byNode.set(k, arr); } arr.push({ seg: s, end }); }
  }
  // degree-2 の node（分岐でない）は無条件連結。degree>=3（交差点）は最も bearing が連続する pair だけ橋渡し（§15）。
  for (const [, endpoints] of byNode) {
    if (endpoints.length === 2) {
      const [e0, e1] = endpoints;
      if (e0.seg.id === e1.seg.id) continue;   // 自己ループ（同一 segment の始点=終点。異常データ回避）
      const b0 = e0.end === 'a' ? [-e0.seg.bearing[0], -e0.seg.bearing[1]] : e0.seg.bearing;
      const b1 = e1.end === 'a' ? [-e1.seg.bearing[0], -e1.seg.bearing[1]] : e1.seg.bearing;
      const cont = -(b0[0] * b1[0] + b0[1] * b1[1]);   // 逆向きに来て逆向きに出る＝直進なら -1 に近い
      if (cont > MIN_CHAIN_BEARING) dsu.union(e0.seg.id, e1.seg.id);
    } else if (endpoints.length >= 3) {
      // 交差点: 全ペアの直進度を評価し、最良の 1 組だけ橋渡し（他は独立 track のまま＝分岐として残す）
      let best = null, bestCont = MIN_CHAIN_BEARING;
      for (let i = 0; i < endpoints.length; i++) for (let j = i + 1; j < endpoints.length; j++) {
        const e0 = endpoints[i], e1 = endpoints[j];
        if (e0.seg.id === e1.seg.id) continue;
        const b0 = e0.end === 'a' ? [-e0.seg.bearing[0], -e0.seg.bearing[1]] : e0.seg.bearing;
        const b1 = e1.end === 'a' ? [-e1.seg.bearing[0], -e1.seg.bearing[1]] : e1.seg.bearing;
        const cont = -(b0[0] * b1[0] + b0[1] * b1[1]);
        if (cont > bestCont) { bestCont = cont; best = [e0, e1]; }
      }
      if (best) dsu.union(best[0].seg.id, best[1].seg.id);
    }
  }
  const trackOf = new Map();
  for (const s of segs) trackOf.set(s.id, dsu.find(s.id));
  const tracksBySegOrder = new Map();
  for (const s of segs) { const t = trackOf.get(s.id); let arr = tracksBySegOrder.get(t); if (!arr) { arr = []; tracksBySegOrder.set(t, arr); } arr.push(s); }
  // track 内の segment を空間的に連結順へ並べる（端点近接で貪欲に鎖をたどる。track は基本的に単純鎖のはず）
  for (const [t, arr] of tracksBySegOrder) {
    if (arr.length <= 1) continue;
    tracksBySegOrder.set(t, orderChain(arr));
  }
  return { trackOf, tracksBySegOrder };
}

function orderChain(arr) {
  const used = new Set();
  const adj = new Map();   // nodeKey -> [seg]
  for (const s of arr) {
    const a = trackNodeKey(s.coords[0]), b = trackNodeKey(s.coords[s.coords.length - 1]);
    for (const k of [a, b]) { let l = adj.get(k); if (!l) { l = []; adj.set(k, l); } l.push(s); }
  }
  // 端点（隣接1本のみ）から開始。無ければ任意の1本から。
  let start = arr.find((s) => {
    const a = trackNodeKey(s.coords[0]), b = trackNodeKey(s.coords[s.coords.length - 1]);
    return (adj.get(a) || []).length === 1 || (adj.get(b) || []).length === 1;
  }) || arr[0];
  const chain = [start]; used.add(start.id);
  let cur = start, curEndKey = trackNodeKey(start.coords[start.coords.length - 1]);
  let guard = arr.length + 5;
  while (chain.length < arr.length && guard-- > 0) {
    const cands = (adj.get(curEndKey) || []).filter((s) => !used.has(s.id));
    if (!cands.length) break;
    const next = cands[0];
    chain.push(next); used.add(next.id); cur = next;
    const a = trackNodeKey(next.coords[0]), b = trackNodeKey(next.coords[next.coords.length - 1]);
    curEndKey = (a === curEndKey) ? b : a;
  }
  for (const s of arr) if (!used.has(s.id)) chain.push(s);   // 孤立分（通常発生しない保険）
  return chain;
}

// ── §8 side classification: 基準 track 進行方向に対する候補 segment の外積符号 ──
function sideSign(baseBearing, fromPt, toPt) {
  const cross = baseBearing[0] * (toPt[1] - fromPt[1]) - baseBearing[1] * (toPt[0] - fromPt[0]);
  return cross >= 0 ? 1 : -1;
}

const SWITCH_PENALTY = 0.55;      // track 切替 1 回あたりの減点（§6: 安易な切替を抑制）
const NONE_PENALTY = 0.15;        // 候補なし状態のコスト（軽微。切替扱いにしない）
const TOP_K_CANDIDATES = 3;       // §4: 早期に1候補へ固定しない

/**
 * §5 corridor sequence optimization。track を「左」基準とし、track の segment 列に沿って
 * 最良の partner track 系列を Viterbi DP で選ぶ。
 * @returns {{ path: Array<{segId, partnerTrackId:string|null, partnerSegId:string|null, result:object|null}>, switches:number }}
 */
function solveTrackDP(trackSegs, grid, opts) {
  // 各 segment の上位 K 候補（track 単位に集約）を求める
  const perSeg = trackSegs.map((s) => {
    const cand = queryGrid(grid, s.bbox, 1).filter((g) => g !== s && g.parentId !== s.parentId);
    const scored = [];
    for (const g of cand) {
      const r = scorePair(s, g, opts);
      if (!r) continue;
      if (opts.sideFilterFn) { const side = opts.sideFilterFn(s, g); if (side === 'reject') continue; }
      scored.push({ seg: g, result: r });
    }
    scored.sort((a, b) => b.result.score - a.result.score);
    return scored.slice(0, TOP_K_CANDIDATES);
  });

  // 出現する partner track の集合（state 空間）。DP の計算量を抑えるため頻度上位 MAX_STATES に絞る
  // （非常に長い track が多数の交差点をまたぐ場合の state 爆発を防ぐ・§37 offline precompute の範囲内で完結させる）。
  const MAX_STATES = 10;
  const freq = new Map();
  for (const cands of perSeg) for (const c of cands) { const t = opts.trackOf.get(c.seg.id); freq.set(t, (freq.get(t) || 0) + 1); }
  const topTracks = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_STATES).map(([t]) => t);
  const states = [null, ...topTracks];

  // DP
  const n = trackSegs.length;
  const dp = states.map(() => new Array(n).fill(-Infinity));
  const choice = states.map(() => new Array(n).fill(null));   // どの候補 segment を選んだか
  const back = states.map(() => new Array(n).fill(-1));       // 直前 state index

  function bestCandFor(i, stateTrackId) {
    if (stateTrackId === null) return { local: 0, seg: null, result: null };
    let best = null;
    for (const c of perSeg[i]) if (opts.trackOf.get(c.seg.id) === stateTrackId) { if (!best || c.result.score > best.result.score) best = c; }
    return best ? { local: best.result.score, seg: best.seg, result: best.result } : null;
  }

  for (let si = 0; si < states.length; si++) {
    const cf = bestCandFor(0, states[si]);
    if (cf) { dp[si][0] = cf.local - (states[si] === null ? NONE_PENALTY : 0); choice[si][0] = cf; }
  }
  for (let i = 1; i < n; i++) {
    for (let si = 0; si < states.length; si++) {
      const cf = bestCandFor(i, states[si]);
      if (!cf) continue;
      const localScore = cf.local - (states[si] === null ? NONE_PENALTY : 0);
      let bestPrev = -Infinity, bestPrevIdx = -1;
      for (let pi = 0; pi < states.length; pi++) {
        if (dp[pi][i - 1] === -Infinity) continue;
        const switchCost = (pi !== si && states[pi] !== null && states[si] !== null) ? SWITCH_PENALTY : 0;
        const v = dp[pi][i - 1] - switchCost;
        if (v > bestPrev) { bestPrev = v; bestPrevIdx = pi; }
      }
      if (bestPrevIdx === -1) { dp[si][i] = localScore; back[si][i] = -1; }
      else { dp[si][i] = localScore + bestPrev; back[si][i] = bestPrevIdx; }
      choice[si][i] = cf;
    }
  }
  // 終端で最良 state を選び backtrack
  let bestFinal = -Infinity, bestFinalIdx = 0;
  for (let si = 0; si < states.length; si++) if (dp[si][n - 1] > bestFinal) { bestFinal = dp[si][n - 1]; bestFinalIdx = si; }
  const path = new Array(n);
  let curIdx = bestFinalIdx;
  for (let i = n - 1; i >= 0; i--) {
    const cf = choice[curIdx][i];
    path[i] = { segId: trackSegs[i].id, partnerTrackId: states[curIdx], partnerSegId: cf && cf.seg ? cf.seg.id : null, result: cf ? cf.result : null };
    curIdx = (i > 0) ? back[curIdx][i] : curIdx;
  }
  let switches = 0;
  for (let i = 1; i < n; i++) if (path[i].partnerTrackId !== path[i - 1].partnerTrackId && path[i].partnerTrackId != null && path[i - 1].partnerTrackId != null) switches++;

  // §20/§46 v2 との比較用: switch penalty 無しの「各 segment が独立に最良候補を選ぶ」baseline
  //   （FIX17 v2 の segment 単位 best-match と同じ考え方。DP の効果を定量比較するために同一 track で再現する）。
  const greedyPath = new Array(n);
  for (let i = 0; i < n; i++) {
    let best = null, bestTrack = null;
    for (const c of perSeg[i]) if (!best || c.result.score > best.result.score) { best = c; bestTrack = opts.trackOf.get(c.seg.id); }
    greedyPath[i] = best ? { segId: trackSegs[i].id, partnerTrackId: bestTrack, partnerSegId: best.seg.id, result: best.result } : { segId: trackSegs[i].id, partnerTrackId: null, partnerSegId: null, result: null };
  }
  let greedySwitches = 0;
  for (let i = 1; i < n; i++) if (greedyPath[i].partnerTrackId !== greedyPath[i - 1].partnerTrackId && greedyPath[i].partnerTrackId != null && greedyPath[i - 1].partnerTrackId != null) greedySwitches++;

  return { path, switches, greedyPath, greedySwitches };
}

/**
 * §11-13 width spike / change point 検出。孤立した 1-2 segment の跳びを spike として除外し、
 * 3 segment 以上持続する変化を genuine change として残す。
 */
export function detectChangePoints(widthSeries, opts = {}) {
  const minSustain = opts.minSustain ?? 3;
  const spikeThreshold = opts.spikeThreshold ?? 2.2;   // 前後中央値からの比率
  const flags = widthSeries.map(() => ({ spike: false, changePoint: false }));
  for (let i = 0; i < widthSeries.length; i++) {
    if (widthSeries[i] == null) continue;
    const neighbourhood = [];
    for (let d = -3; d <= 3; d++) { const j = i + d; if (d === 0 || j < 0 || j >= widthSeries.length) continue; if (widthSeries[j] != null) neighbourhood.push(widthSeries[j]); }
    if (neighbourhood.length < 3) continue;
    const med = neighbourhood.slice().sort((a, b) => a - b)[Math.floor(neighbourhood.length / 2)];
    if (med > 0 && (widthSeries[i] > med * spikeThreshold || widthSeries[i] < med / spikeThreshold)) {
      // 持続確認: 同方向の逸脱が前後 minSustain-1 区間続くか
      let sustain = 1;
      for (let d = 1; d < minSustain; d++) {
        const j = i + d; if (j >= widthSeries.length || widthSeries[j] == null) break;
        if ((widthSeries[j] > med * spikeThreshold) === (widthSeries[i] > med * spikeThreshold)) sustain++; else break;
      }
      if (sustain >= minSustain) flags[i].changePoint = true; else flags[i].spike = true;
    }
  }
  return flags;
}

/**
 * §1-14 corridor-level reconstruction 本体。
 * @returns {{ tracks: Map, corridorPairs: Array, pairSwitchCount:number, sideFlipCount:number, widthSpikeCount:number, changePointCount:number }}
 */
export function reconstructCorridorsV3(segs, opts = {}) {
  const { trackOf, tracksBySegOrder } = buildEdgeTracks(segs);
  const grid = buildGrid(segs);
  const segById = new Map(segs.map((s) => [s.id, s]));

  // side 基準: track 全体の主進行方向（最初と最後の segment の midpoint から）
  const trackBearing = new Map();
  for (const [t, arr] of tracksBySegOrder) {
    if (arr.length < 1) continue;
    const a = arr[0].midpoint, b = arr[arr.length - 1].midpoint;
    const dx = b[0] - a[0], dz = b[1] - a[1]; const len = Math.hypot(dx, dz) || 1;
    trackBearing.set(t, [dx / len, dz / len]);
  }

  const corridorPairs = [];
  const greedyPairs = [];   // §20/§46: v2 相当（switch penalty 無し）の baseline。DP との定量比較専用
  let pairSwitchCount = 0, sideFlipCount = 0, widthSpikeCount = 0, changePointCount = 0;
  let pairSwitchCountGreedy = 0, sideFlipCountGreedy = 0, widthSpikeCountGreedy = 0;
  const processedTracks = new Set();

  for (const [trackId, arr] of tracksBySegOrder) {
    if (processedTracks.has(trackId)) continue;
    if (arr.length === 0) continue;
    const baseBearing = trackBearing.get(trackId) || arr[0].bearing;
    const dpOpts = { ...opts, trackOf, sideFilterFn: (s, g) => 'ok' };   // side は DP 後に検証（§8 は事後一貫性確認で運用。事前 reject は §9 median 検出を阻害するため行わない）
    const { path, switches, greedyPath, greedySwitches } = solveTrackDP(arr, grid, dpOpts);
    pairSwitchCount += switches;
    pairSwitchCountGreedy += greedySwitches;

    // side flip 検出（選ばれた partner segment が基準進行方向に対し左右で入れ替わっていないか §8）。
    //   自 segment の midpoint → partner segment の midpoint への外積符号で実座標から判定する
    //   （track 代表 bearing 同士の比較では「向き」しか分からず「どちら側か」を判定できないため）。
    let prevSide = null;
    const widthSeries = path.map((p) => p.result ? p.result.sep : null);
    for (let i = 0; i < path.length; i++) {
      if (!path[i].partnerSegId) continue;
      const partnerSeg = segById.get(path[i].partnerSegId);
      if (!partnerSeg) continue;
      const side = sideSign(baseBearing, arr[i].midpoint, partnerSeg.midpoint);
      if (prevSide != null && side !== prevSide) sideFlipCount++;
      prevSide = side;
    }
    let prevSideG = null;
    for (let i = 0; i < greedyPath.length; i++) {
      if (!greedyPath[i].partnerSegId) continue;
      const partnerSeg = segById.get(greedyPath[i].partnerSegId);
      if (!partnerSeg) continue;
      const side = sideSign(baseBearing, arr[i].midpoint, partnerSeg.midpoint);
      if (prevSideG != null && side !== prevSideG) sideFlipCountGreedy++;
      prevSideG = side;
    }

    const cpFlags = detectChangePoints(widthSeries);
    for (const f of cpFlags) { if (f.spike) widthSpikeCount++; if (f.changePoint) changePointCount++; }
    const widthSeriesGreedy = greedyPath.map((p) => p.result ? p.result.sep : null);
    const cpFlagsGreedy = detectChangePoints(widthSeriesGreedy);
    for (const f of cpFlagsGreedy) if (f.spike) widthSpikeCountGreedy++;

    for (let i = 0; i < path.length; i++) {
      if (!path[i].partnerSegId || !path[i].result) continue;
      corridorPairs.push({
        trackId, segId: path[i].segId, partnerTrackId: path[i].partnerTrackId, partnerSegId: path[i].partnerSegId,
        sepM: path[i].result.sep, parallel: path[i].result.parallel, overlapRatio: path[i].result.overlap, score: path[i].result.score,
        widthSpike: cpFlags[i].spike, changePoint: cpFlags[i].changePoint,
        trackSwitchAt: i > 0 && path[i].partnerTrackId !== path[i - 1].partnerTrackId,
      });
    }
    for (let i = 0; i < greedyPath.length; i++) {
      if (!greedyPath[i].partnerSegId || !greedyPath[i].result) continue;
      greedyPairs.push({ trackId, segId: greedyPath[i].segId, partnerSegId: greedyPath[i].partnerSegId, sepM: greedyPath[i].result.sep });
    }
    processedTracks.add(trackId);
  }

  return {
    trackOf, tracksBySegOrder, corridorPairs, greedyPairs,
    pairSwitchCount, sideFlipCount, widthSpikeCount, changePointCount,
    pairSwitchCountGreedy, sideFlipCountGreedy, widthSpikeCountGreedy,
  };
}

export { MIN_SEP_M, MAX_SEP_M };
