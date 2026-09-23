// tools/lib/river-network.js
// [Mission22 全水系カバレッジ] 河川ネットワークの純粋ロジック:
//   - 河川名の正規化（表記揺れ吸収・誤結合なし）
//   - major / medium / minor の 3 階級分類（name + waterway tag + width + length を総合）
//   - named river の連続性監査（connected components / gap / total length）
// THREE 非依存・座標は znorth-neg-v1 の [x, z]。
// ══════════════════════════════════════════════════════════════════════════════════

// 主要 7 河川（Mission04 で width/geometry 確定済み・回帰固定。名称は OSM データ由来）。
export const MAJOR_RIVERS = Object.freeze(['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川']);
const MAJOR_SET = new Set(MAJOR_RIVERS);

// medium 確定河川（都心の骨格をなす中規模河川・運河。市内区間が短くても medium に固定する）。
//   ※ geometry・座標は一切ハードコードしない。名前で階級を上げるだけ（centerline は OSM 由来）。
export const MEDIUM_ANCHOR_RIVERS = Object.freeze([
  '大川', '堂島川', '土佐堀川', '東横堀川', '木津川運河', '六軒家川', '尻無川',
  '平野川', '平野川分水路', '第二寝屋川', '正蓮寺川', '城北川', '恩智川',
]);
const MEDIUM_ANCHOR_SET = new Set(MEDIUM_ANCHOR_RIVERS);

// medium へ引き上げる閾値（複数条件のいずれか）。
const MEDIUM_MIN_GROUP_LENGTH_M = 1200; // 名前付き river/canal のグループ総延長
const MEDIUM_MIN_WIDTH_M = 38;          // 実測幅がこれ以上なら medium 以上

/**
 * 河川名を正規化する（表記揺れ吸収）。誤結合を避けるため、括弧注記の除去と
 * 全角/半角・空白の統一に限定し、「川/河/運河」等の語尾は変えない（別河川衝突防止）。
 * @param {string} name
 * @returns {string}
 */
export function normalizeRiverName(name) {
  if (!name) return '';
  let s = String(name).trim();
  // 括弧注記を除去: 「大川（旧淀川）」→「大川」, 全角/半角括弧の両方
  s = s.replace(/[（(][^）)]*[）)]/g, '').trim();
  // 前後の記号
  s = s.replace(/^[・･\s]+|[・･\s]+$/g, '');
  // 全角英数 → 半角
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  // 連続空白を1つに
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// [Mission28] MICRO = drain / ditch / ごく小さい無名 stream。超近景（<=1500m）のみ表示。
const MICRO_TAGS = new Set(['drain', 'ditch']);
const MICRO_STREAM_MAX_GROUP_LEN_M = 300; // 無名 stream がこれ未満なら micro
const MICRO_STREAM_MAX_WIDTH_M = 6;

/**
 * 1 セグメントの階級を決める。
 * @param {object} o { name, waterwayTag, waterClass, groupLengthM, widthHint }
 *   groupLengthM: 同名グループの総延長（正規化名でまとめた合計）
 *   widthHint: 実測/riverbank 由来の幅（m, 任意）
 * @returns {'major'|'medium'|'minor'|'micro'}
 */
export function classifyRiverTier(o) {
  const name = normalizeRiverName(o.name || '');
  if (name && MAJOR_SET.has(name)) return 'major';

  const tag = o.waterwayTag || o.waterClass || '';
  const isRiverOrCanal = tag === 'river' || tag === 'canal' || o.waterClass === 'river' || o.waterClass === 'canal';

  if (name) {
    if (MEDIUM_ANCHOR_SET.has(name)) return 'medium';
    if (isRiverOrCanal) {
      if (Number.isFinite(o.widthHint) && o.widthHint >= MEDIUM_MIN_WIDTH_M) return 'medium';
      if (Number.isFinite(o.groupLengthM) && o.groupLengthM >= MEDIUM_MIN_GROUP_LENGTH_M) return 'medium';
    }
  }
  // 実測幅が広い無名 river/canal も medium（河口の分流など）
  if (isRiverOrCanal && Number.isFinite(o.widthHint) && o.widthHint >= MEDIUM_MIN_WIDTH_M * 1.6) return 'medium';

  // [Mission28] MICRO 判定。名前付きの用水路（〜井路 / 〜水路 等）は minor へ残す（都市構造として意味がある・
  //   従来 minor で NEAR 表示されていたものを維持）。無名の drain/ditch・無名の小 stream のみ micro。
  if (!name && MICRO_TAGS.has(tag)) return 'micro';
  if (!name && tag === 'stream'
    && (!Number.isFinite(o.groupLengthM) || o.groupLengthM < MICRO_STREAM_MAX_GROUP_LEN_M)
    && (!Number.isFinite(o.widthHint) || o.widthHint < MICRO_STREAM_MAX_WIDTH_M)) return 'micro';

  return 'minor';
}

export function polylineLengthXZ(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/**
 * セグメント群を正規化名でグループ化する（無名は個別扱い）。
 * @param {Array<{name?:string}>} segments
 * @returns {Map<string, {normName:string, rawNames:Set<string>, indices:number[]}>}
 */
export function groupByRiver(segments) {
  const groups = new Map();
  segments.forEach((s, i) => {
    const nn = normalizeRiverName(s.name || '');
    const key = nn || `__unnamed_${i}`;
    if (!groups.has(key)) groups.set(key, { normName: nn, rawNames: new Set(), indices: [] });
    const g = groups.get(key);
    if (s.name) g.rawNames.add(s.name);
    g.indices.push(i);
  });
  return groups;
}

function endpoints(cl) { return [cl[0], cl[cl.length - 1]]; }
function d2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

/**
 * 同名河川セグメント群の連続性を監査する。
 * @param {Array<number[][]>} centerlines  各セグメントの centerline（[x,z]列）
 * @param {number} tolM 端点一致とみなす距離
 * @returns {{segments:number, components:number, gapCount:number, maxGapM:number, totalLengthM:number, gaps:Array<{fromComp:number,toComp:number,distM:number,at:number[]}>}}
 */
export function auditContinuity(centerlines, tolM = 60) {
  const n = centerlines.length;
  const totalLengthM = centerlines.reduce((s, cl) => s + polylineLengthXZ(cl), 0);
  if (n === 0) return { segments: 0, components: 0, gapCount: 0, maxGapM: 0, totalLengthM: 0, gaps: [] };

  // union-find on segments by endpoint proximity
  const parent = [...Array(n).keys()];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const eps = centerlines.map(endpoints);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let touch = false;
      for (let ei = 0; ei < 2 && !touch; ei++) for (let ej = 0; ej < 2 && !touch; ej++) {
        if (d2(eps[i][ei], eps[j][ej]) <= tolM) touch = true;
      }
      if (touch) union(i, j);
    }
  }
  const comps = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(i);
  }
  const compList = [...comps.values()];
  // component 間の最小端点距離 = gap
  const gaps = [];
  for (let a = 0; a < compList.length; a++) {
    for (let b = a + 1; b < compList.length; b++) {
      let best = Infinity, at = null;
      for (const i of compList[a]) for (const j of compList[b]) {
        for (let ei = 0; ei < 2; ei++) for (let ej = 0; ej < 2; ej++) {
          const dd = d2(eps[i][ei], eps[j][ej]);
          if (dd < best) { best = dd; at = [(eps[i][ei][0] + eps[j][ej][0]) / 2, (eps[i][ei][1] + eps[j][ej][1]) / 2]; }
        }
      }
      gaps.push({ fromComp: a, toComp: b, distM: +best.toFixed(1), at });
    }
  }
  // 各 component を最も近い相手だけ繋ぐ想定 → gapCount = components-1、maxGap は MST 的に最小全域木の最大辺
  gaps.sort((x, y) => x.distM - y.distM);
  const mstParent = [...Array(compList.length).keys()];
  const mfind = (x) => { while (mstParent[x] !== x) { mstParent[x] = mstParent[mstParent[x]]; x = mstParent[x]; } return x; };
  let mstMax = 0; const mstGaps = [];
  for (const g of gaps) {
    const ra = mfind(g.fromComp), rb = mfind(g.toComp);
    if (ra === rb) continue;
    mstParent[ra] = rb;
    mstGaps.push(g);
    if (g.distM > mstMax) mstMax = g.distM;
  }
  return {
    segments: n,
    components: compList.length,
    gapCount: Math.max(0, compList.length - 1),
    maxGapM: +mstMax.toFixed(1),
    totalLengthM: Math.round(totalLengthM),
    gaps: mstGaps,
  };
}

/**
 * gap の原因を推定する（勝手に直線補間しない・分類のみ）。
 * @param {object} o { distM, at:[x,z], wardEdgeDistM, nearCityEdge }
 * @returns {string}
 */
export function classifyGapCause(o) {
  const d = o.distM || 0;
  if (d <= 80) return 'A: 端点許容内（実質連続。tol調整で吸収可）';
  if (o.nearCityEdge) return 'D: 市境クリップ（大阪市 study extent 外へ続く）';
  if (Number.isFinite(o.wardEdgeDistM) && o.wardEdgeDistM < 120) return 'C: 区界クリップ（polyline-ward-clip 由来の分断の疑い）';
  if (d > 400) return 'B: OSM 欠落（way が繋がっていない。補間しない＝UNRESOLVED）';
  return 'E: タイル境界・中規模 gap（tol/連結ロジックで詰める余地）';
}

export const TIER_ORDER = Object.freeze(['major', 'medium', 'minor', 'micro']);
