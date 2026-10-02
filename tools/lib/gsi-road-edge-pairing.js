// tools/lib/gsi-road-edge-pairing.js
// [Mission 31G-FIX15/FIX16 §12-15] GSI 道路縁の左右 pairing・sample polygon 生成・幅計測の共通ロジック。
//   全大阪 polygon 化はしない（呼び出し側が対象を sample エリア・named road 近傍に限定する）。
//   pair 条件（FIX15 設計を継承）: 概ね平行（dot >= 0.85）・分離距離 1.5〜30m・中点近傍。
//   confidence: 分離 <=15m HIGH / <=22m MEDIUM / <=30m LOW。
import { validateLines } from './gsi-road-edge-validate.js';

export const CELL = 100;
export const ckey = (cx, cz) => cx + ',' + cz;

export function buildGrid(lines) {
  const grid = new Map();
  for (const f of lines) {
    const c = f.geometry.coordinates;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of c) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
    f._bbox = { minX, maxX, minZ, maxZ };
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = ckey(cx, cz); let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(f);
    }
  }
  return grid;
}

export function queryGrid(grid, bbox, padCells = 1) {
  const x0 = Math.floor(bbox.minX / CELL) - padCells, x1 = Math.floor(bbox.maxX / CELL) + padCells;
  const z0 = Math.floor(bbox.minZ / CELL) - padCells, z1 = Math.floor(bbox.maxZ / CELL) + padCells;
  const seen = new Set(), out = [];
  for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
    const arr = grid.get(ckey(cx, cz)); if (!arr) continue;
    for (const f of arr) { if (seen.has(f)) continue; seen.add(f); out.push(f); }
  }
  return out;
}

export function lineDir(coords) { const a = coords[0], b = coords[coords.length - 1]; const dx = b[0] - a[0], dz = b[1] - a[1]; const len = Math.hypot(dx, dz) || 1; return [dx / len, dz / len]; }
export function midpoint(coords) { const a = coords[0], b = coords[coords.length - 1]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
export function lineLen(coords) { let s = 0; for (let i = 1; i < coords.length; i++) s += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]); return s; }
function dist(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1]); }

const MIN_LEN_M = 8;          // 短すぎる断片は pairing 対象外（ノイズ）
const MAX_SEP_M = 30, HIGH_SEP_M = 15, MED_SEP_M = 22;
// [FIX16] 実データで MIN_SEP_M=1.0 を試したところ gsiMin が 1.1〜1.9m という非現実的な「道路幅」を
//   多数生成した（実道路が 1m 台のはずがない → 同一縁が交差点でフラグメント分割された「別 feature だが
//   物理的には同じ縁」同士を誤って pair していたと推定）。3.0m 未満は歩道の縁石幅程度で車道幅としては
//   ありえないため除外する（実測に基づく補正であり、恣意的なチューニングではない）。
const MIN_SEP_M = 3.0;
const MIN_PARALLEL = 0.82;
const MIN_LEN_RATIO = 0.4;    // 長さが大きく違う相手とはペアにしない

/**
 * lines（同一エリアの候補集合。呼び出し側で type='真幅道路' 等に絞り込み済みを想定）を pairing する。
 * @returns {{ pairs: Array<{a,b,sepM,confidence}>, unpaired: Array }}
 */
export function pairCandidates(lines) {
  const grid = buildGrid(lines);
  const used = new Set();
  const pairs = [];
  const unpaired = [];
  for (const f of lines) {
    if (used.has(f)) continue;
    const len = lineLen(f.geometry.coordinates);
    if (len < MIN_LEN_M) { unpaired.push(f); used.add(f); continue; }
    const di = lineDir(f.geometry.coordinates);
    const mi = midpoint(f.geometry.coordinates);
    const cand = queryGrid(grid, f._bbox, 1).filter((g) => g !== f && !used.has(g));
    let best = null, bestScore = -1;
    for (const g of cand) {
      const lenG = lineLen(g.geometry.coordinates);
      if (lenG < MIN_LEN_M) continue;
      if (Math.min(len, lenG) / Math.max(len, lenG) < MIN_LEN_RATIO) continue;
      const dj = lineDir(g.geometry.coordinates);
      const parallel = Math.abs(di[0] * dj[0] + di[1] * dj[1]);
      if (parallel < MIN_PARALLEL) continue;
      const sep = dist(mi, midpoint(g.geometry.coordinates));
      if (sep < MIN_SEP_M || sep > MAX_SEP_M) continue;
      const score = parallel - sep / 200;
      if (score > bestScore) { bestScore = score; best = { g, sep }; }
    }
    if (!best) { unpaired.push(f); used.add(f); continue; }
    used.add(f); used.add(best.g);
    const confidence = best.sep <= HIGH_SEP_M ? 'high' : best.sep <= MED_SEP_M ? 'medium' : 'low';
    pairs.push({ a: f, b: best.g, sepM: +best.sep.toFixed(2), confidence });
  }
  return { pairs, unpaired };
}

/** HIGH confidence pair から centerline ladder 方式で sample polygon を作る（union なし・quad 群）。 */
export function polygonFromPair(pair) {
  const ca = pair.a.geometry.coordinates, cb = pair.b.geometry.coordinates;
  // a の各点を b へ最近傍投影して対応点列を作る（単純だが sample QA には十分）
  function nearestOnLine(p, line) {
    let best = line[0], bestD = Infinity;
    for (const q of line) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < bestD) { bestD = d; best = q; } }
    return best;
  }
  const quads = [];
  for (let i = 1; i < ca.length; i++) {
    const p0 = ca[i - 1], p1 = ca[i];
    const q0 = nearestOnLine(p0, cb), q1 = nearestOnLine(p1, cb);
    quads.push([p0, p1, q1, q0]);
  }
  return quads;
}

export { validateLines };
