// tools/lib/river-width-smooth.js
// [Mission04] 河川セグメント（OSM way 単位）の幅を、川全体で滑らかにするための純粋関数。
//   - orderRiverSegments: 端点一致でセグメントを流路順に並べる（分岐は最長チェーンを主とする）
//   - rejectWidthOutliers: 並んだ幅列から単発スパイクを近傍の頑健推定へ寄せる
//                          （河口へ向かう緩やかな単調拡幅は保つ＝指示書6節）
// THREE 非依存。

function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function endpoints(seg) { return [seg.centerline[0], seg.centerline[seg.centerline.length - 1]]; }

/**
 * セグメント配列を端点一致で連結し、流路順のチェーンへ並べる。
 * @param {{id:string, centerline:number[][], width:number}[]} segments
 * @param {number} [tolM=60] 端点一致とみなす距離
 * @returns {{chains: {segIndex:number, flip:boolean}[][], singletons:number[]}}
 *   chains: 各チェーンは [{segIndex, flip}] の順序付き配列（flip=true なら centerline を逆向きに扱う）
 */
export function orderRiverSegments(segments, tolM = 60) {
  const n = segments.length;
  const eps = segments.map(endpoints);
  // 端点グラフ: seg i の端点 e(0/1) が seg j の端点 f(0/1) と一致 → 隣接
  const adj = Array.from({ length: n }, () => []); // adj[i] = [{j, myEnd, theirEnd}]
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let ei = 0; ei < 2; ei++) for (let ej = 0; ej < 2; ej++) {
        if (dist(eps[i][ei], eps[j][ej]) <= tolM) {
          adj[i].push({ j, myEnd: ei, theirEnd: ej });
          adj[j].push({ j: i, myEnd: ej, theirEnd: ei });
        }
      }
    }
  }
  const used = new Array(n).fill(false);
  const chains = [];
  const singletons = [];
  // 端点次数1（＝チェーンの端）から辿る。無ければ任意の未使用から。
  function degree(i) { return new Set(adj[i].map((a) => a.j)).size; }
  const order = [...Array(n).keys()].sort((a, b) => degree(a) - degree(b));
  for (const startRaw of order) {
    if (used[startRaw]) continue;
    if (adj[startRaw].length === 0) { used[startRaw] = true; singletons.push(startRaw); continue; }
    // startRaw から一方向へ貪欲に辿る
    const chain = [];
    let cur = startRaw;
    let prevExitPoint = null;
    while (cur != null && !used[cur]) {
      used[cur] = true;
      const cl = segments[cur].centerline;
      let flip = false;
      if (prevExitPoint != null) {
        // 直前の exit 点に近い端を「入口」に、反対端を「出口」にする
        flip = dist(cl[cl.length - 1], prevExitPoint) < dist(cl[0], prevExitPoint);
      } else if (adj[cur].length) {
        // 最初のセグメント: 未使用の隣接が繋がっている端を「出口」にしたい。
        //   端点[last]側に隣接があれば flip=false（[last]から出る）、端点[0]側なら flip=true。
        const near0 = adj[cur].some((a) => !used[a.j] && a.myEnd === 0);
        const nearL = adj[cur].some((a) => !used[a.j] && a.myEnd === 1);
        if (near0 && !nearL) flip = true;
      }
      chain.push({ segIndex: cur, flip });
      const exitEndIdx = flip ? 0 : (segments[cur].centerline.length - 1);
      const exitPoint = segments[cur].centerline[exitEndIdx];
      // exitPoint に繋がる未使用の隣接を探す
      let nextSeg = null;
      for (const a of adj[cur]) {
        if (used[a.j]) continue;
        const cand = segments[a.j];
        if (dist(cand.centerline[0], exitPoint) <= tolM || dist(cand.centerline[cand.centerline.length - 1], exitPoint) <= tolM) { nextSeg = a.j; break; }
      }
      prevExitPoint = exitPoint;
      cur = nextSeg;
    }
    chains.push(chain);
  }
  return { chains, singletons };
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 流路順に並んだ幅列から、単発スパイク（両隣と大きく食い違う値）を近傍の頑健推定へ寄せる。
 * 緩やかな単調変化（河口へ向かう拡幅など）は各ステップが spikeRatio 未満なので保たれる。
 * @param {number[]} widthsInOrder
 * @param {{spikeRatio?:number, windowMedianRatio?:number}} [opts]
 * @returns {number[]}
 */
export function rejectWidthOutliers(widthsInOrder, opts = {}) {
  const w = widthsInOrder.slice();
  const n = w.length;
  if (n < 3) return w;
  const spikeRatio = opts.spikeRatio ?? 1.8;      // 両隣に対しこの比を超える／下回る単発値をスパイクとみなす
  const pullRatio = opts.pullRatio ?? 1.5;        // 全体medianからこの比を超える端値の緩和にも使う
  const globalMed = median(w);
  for (let i = 0; i < n; i++) {
    const lo = w[i - 1], hi = w[i + 1];
    if (lo != null && hi != null) {
      const nbMed = median([lo, hi]);
      const r = w[i] / nbMed;
      // 両隣が近く（単調でない）自分だけ跳ねている ＝ スパイク
      const neighborsAgree = Math.max(lo, hi) / Math.min(lo, hi) < spikeRatio;
      if (neighborsAgree && (r > spikeRatio || r < 1 / spikeRatio)) {
        w[i] = nbMed;
        continue;
      }
    }
    // 端（隣が片側だけ）で全体medianから極端に外れる値もならす
    if ((lo == null || hi == null)) {
      const ref = lo != null ? lo : hi;
      if (ref != null) {
        const r = w[i] / ref;
        if (r > pullRatio * 1.4 || r < 1 / (pullRatio * 1.4)) w[i] = (w[i] + ref) / 2;
      }
      const rg = w[i] / globalMed;
      if (rg > 2.6 || rg < 1 / 2.6) w[i] = (w[i] + globalMed) / 2;
    }
  }
  return w;
}
