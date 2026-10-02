// tools/lib/land-coverage.js
// [見た目改善 Mission21] 大阪市24区の陸域 coverage 監査 + LandSurface geometry の純粋ロジック。
// ══════════════════════════════════════════════════════════════════════════════════
//   陸域の canonical = N03 2026 大阪市24区ポリゴン（24 wards / 39 features / 1 hole）。
//   - N03 を「無検証で巨大 mesh 化」しない。タイル単位でクリップし earcut で分割し検証する。
//   - fan 分割禁止 / giant triangle 検出 / NaN 0 / winding 検証。
//   - 「本来は陸なのに空白」の原因分類のため、50m グリッドで N03 land / SEA_MASK / water-surface
//     との関係を集計する。
//   - 夢洲（DREAM_ISLAND）は N03 2026 に未収録（埋立進行中・2025 大阪関西万博会場）。OSM coastline
//     も施工中で断片化しているため、施工済みコア部分だけを手作業検証した保守的ポリゴンで補完する。
//     （SEA_MASK と同じ思想: 誤って水域へはみ出すより小さめに取る）
// ══════════════════════════════════════════════════════════════════════════════════
import earcut from './earcut.js';
export { flattenWardPolygons, pointInRing, pointInPolygons, SEA_MASK, GROUND_EXTENT, pointInTriangle } from './water-surface.js';
import { flattenWardPolygons, pointInRing } from './water-surface.js';

// 夢洲 施工済みコア（znorth-neg-v1）。OSM coastline 断片から目視確認した保守的な内側ポリゴン。
// z >= -12950 の南寄り・x >= -16350 の東寄りに限定（北端・西端の未完成部と航路は含めない）。
export const DREAM_ISLAND = Object.freeze({
  id: 'yumeshima-core',
  name: '夢洲（施工済みコア・N03欠落補完）',
  ward: 'konohana',
  reason: 'N03 2026 未収録（埋立進行中 / 2025 大阪・関西万博会場）。OSM coastline は施工中で断片化。施工済みコアのみ手作業検証で補完。',
  outer: [
    [-16350, -12950], [-16350, -11800], [-15100, -11550], [-15250, -12900], [-16350, -12950],
  ],
});

// 人工島・港湾・河口の重点監査地点（znorth-neg-v1）。§5。
export const KEY_PLACES = Object.freeze([
  { id: 'yumeshima', name: '夢洲', x: -15800, z: -12200 },
  { id: 'maishima', name: '舞洲', x: -12500, z: -5200 },
  { id: 'sakishima', name: '咲洲', x: -9500, z: -3200 },
  { id: 'nanko', name: '南港（ポートタウン）', x: -8000, z: -1500 },
  { id: 'tempozan', name: '天保山', x: -6900, z: -5600 },
  { id: 'usj-area', name: 'USJ 周辺（此花・桜島）', x: -8000, z: -7200 },
  { id: 'taisho-west', name: '大正区西部（鶴町・船町）', x: -6800, z: -4200 },
  { id: 'yodo-mouth', name: '淀川河口', x: -8000, z: -12800 },
  { id: 'ajigawa-mouth', name: '安治川河口', x: -6000, z: -8000 },
  { id: 'kizugawa-mouth', name: '木津川河口', x: -5500, z: -4500 },
  { id: 'cosmo-tower', name: '大阪府咲洲庁舎', x: -10114, z: -3757 },
  { id: 'atc', name: 'ATC', x: -10310, z: -3702 },
  { id: 'kaiyukan', name: '海遊館', x: -8763, z: -5672 },
]);

export function auditKeyPlaces(wards, seaMask, dream = DREAM_ISLAND, waterPositions = null) {
  const iw = indexWardPolygons(wards);
  const inWater = (x, z) => {
    if (!Array.isArray(waterPositions)) return false;
    for (let i = 0; i + 6 <= waterPositions.length; i += 6) {
      const p = waterPositions;
      const d1 = (x - p[i + 2]) * (p[i + 1] - p[i + 3]) - (p[i] - p[i + 2]) * (z - p[i + 3]);
      const d2 = (x - p[i + 4]) * (p[i + 3] - p[i + 5]) - (p[i + 2] - p[i + 4]) * (z - p[i + 5]);
      const d3 = (x - p[i]) * (p[i + 5] - p[i + 1]) - (p[i + 4] - p[i]) * (z - p[i + 1]);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
    }
    return false;
  };
  return KEY_PLACES.map((k) => {
    const w = wardAt(k.x, k.z, iw);
    const inDream = dream && pointInRing(k.x, k.z, dream.outer);
    const inSea = seaMask ? pointInRing(k.x, k.z, seaMask) : false;
    const inW = inWater(k.x, k.z);
    const covered = !!w || inDream;
    let cause = null;
    if (w) cause = 'N03 陸（区: ' + w + '）';
    else if (inDream) cause = 'N03 欠落 → 夢洲コア補完で covered';
    else if (inW) cause = 'water-surface が水として描画（陸なら要調査）';
    else if (inSea) cause = 'SEA_MASK 内・water-surface 対象外（水域として正当）';
    else cause = 'N03/夢洲/SEA_MASK いずれにも該当せず（市外 or 未収録）';
    return { id: k.id, name: k.name, x: k.x, z: k.z, insideN03: !!w, ward: w || null, insideDreamIsland: inDream, insideSeaMask: inSea, insideWater: inW, covered, cause };
  });
}

/** N03 wards（flatten 済み [{wardId, outer, holes}]）へ bbox を前計算して付与。 */
export function indexWardPolygons(wards) {
  const flat = Array.isArray(wards) && wards[0] && wards[0].outer ? wards : flattenWardPolygons(wards);
  return flat.map((p) => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, z] of p.outer) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; }
    return { ...p, _bb: { minX: a, maxX: b, minZ: c, maxZ: d } };
  });
}

/** 点が N03 24区のどれかの陸か（穴を除く）。戻り値は wardId or null。 */
export function wardAt(x, z, indexedWards) {
  for (const p of indexedWards) {
    const b = p._bb;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (!pointInRing(x, z, p.outer)) continue;
    let inHole = false;
    for (const h of (p.holes || [])) { if (pointInRing(x, z, h)) { inHole = true; break; } }
    if (!inHole) return p.wardId;
  }
  return null;
}

/** ring bbox。 */
export function ringBbox(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
  return { minX, maxX, minZ, maxZ, w: maxX - minX, h: maxZ - minZ };
}
export function ringAreaXZ(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % n]; a += x1 * z2 - x2 * z1; }
  return Math.abs(a) / 2;
}

// ── ポリゴン × タイル矩形クリップ（Sutherland–Hodgman）──
export function clipPolygonToRect(ring, rect) {
  // rect: {minX,maxX,minZ,maxZ}
  const clipEdge = (poly, inside, intersect) => {
    if (poly.length === 0) return poly;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
      const curIn = inside(cur), prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur));
      }
    }
    return out;
  };
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  let poly = ring.slice();
  poly = clipEdge(poly, (p) => p[0] >= rect.minX, (p, q) => lerp(p, q, (rect.minX - p[0]) / (q[0] - p[0])));
  poly = clipEdge(poly, (p) => p[0] <= rect.maxX, (p, q) => lerp(p, q, (rect.maxX - p[0]) / (q[0] - p[0])));
  poly = clipEdge(poly, (p) => p[1] >= rect.minZ, (p, q) => lerp(p, q, (rect.minZ - p[1]) / (q[1] - p[1])));
  poly = clipEdge(poly, (p) => p[1] <= rect.maxZ, (p, q) => lerp(p, q, (rect.maxZ - p[1]) / (q[1] - p[1])));
  return poly.length >= 3 ? poly : null;
}

/**
 * 1 つの陸ポリゴン（outer + holes）をタイル矩形へクリップし earcut で三角形分割。
 * @returns {{positions:number[], triangleCount:number}}  positions は [x,z,...]（Y は描画側で付与）
 */
export function triangulateLandTile(outer, holes, rect) {
  const co = clipPolygonToRect(outer, rect);
  if (!co || co.length < 3) return { positions: [], triangleCount: 0 };
  const clippedHoles = [];
  for (const h of (holes || [])) {
    const ch = clipPolygonToRect(h, rect);
    if (ch && ch.length >= 3) clippedHoles.push(ch);
  }
  const flat = [];
  for (const [x, z] of co) flat.push(x, z);
  const holeIdx = [];
  for (const h of clippedHoles) { holeIdx.push(flat.length / 2); for (const [x, z] of h) flat.push(x, z); }
  const tris = earcut(flat, holeIdx.length ? holeIdx : null, 2);
  const positions = [];
  let n = 0;
  const q = (v) => Math.round(v * 100) / 100; // 配信時と同じ 1cm 量子化を先に適用（丸めで winding が反転しないように）
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i], b = tris[i + 1], c = tris[i + 2];
    const ax = q(flat[a * 2]), az = q(flat[a * 2 + 1]), bx = q(flat[b * 2]), bz = q(flat[b * 2 + 1]), cx = q(flat[c * 2]), cz = q(flat[c * 2 + 1]);
    if (![ax, az, bx, bz, cx, cz].every(Number.isFinite)) continue;
    const cross = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(cross) / 2 < 5e-2) continue; // 退化スライバを除外（クリップ境界 + 1cm 量子化で発生しうる）
    // winding を +Y（上向き, znorth-neg-v1 で cross > 0）へ正規化
    if (cross > 0) positions.push(ax, az, bx, bz, cx, cz);
    else positions.push(ax, az, cx, cz, bx, bz);
    n++;
  }
  return { positions, triangleCount: n };
}

/**
 * N03 wards（+夢洲補完）を tile グリッドでクリップ・三角形分割して 1 つの merged geometry にする。
 * @param {object} opts { wards, tileM=1000, includeDreamIsland=true, extent }
 * @returns {{positions:number[], triangleCount:number, tiles:number, bbox}}
 */
export function buildLandSurface({ wards, tileM = 1000, includeDreamIsland = true, extent }) {
  const flat = flattenWardPolygons(wards);
  const polys = flat.map((p) => ({ outer: p.outer, holes: p.holes || [], _bb: ringBbox(p.outer) }));
  if (includeDreamIsland) polys.push({ outer: DREAM_ISLAND.outer, holes: [], _bb: ringBbox(DREAM_ISLAND.outer) });

  let gMinX = Infinity, gMaxX = -Infinity, gMinZ = Infinity, gMaxZ = -Infinity;
  for (const p of polys) {
    gMinX = Math.min(gMinX, p._bb.minX); gMaxX = Math.max(gMaxX, p._bb.maxX);
    gMinZ = Math.min(gMinZ, p._bb.minZ); gMaxZ = Math.max(gMaxZ, p._bb.maxZ);
  }
  if (extent) { gMinX = Math.max(gMinX, extent.minX); gMaxX = Math.min(gMaxX, extent.maxX); gMinZ = Math.max(gMinZ, extent.minZ); gMaxZ = Math.min(gMaxZ, extent.maxZ); }

  const positions = [];
  let tilesWithLand = 0;
  const t0x = Math.floor(gMinX / tileM), t1x = Math.ceil(gMaxX / tileM);
  const t0z = Math.floor(gMinZ / tileM), t1z = Math.ceil(gMaxZ / tileM);
  for (let tz = t0z; tz < t1z; tz++) {
    for (let tx = t0x; tx < t1x; tx++) {
      const rect = { minX: tx * tileM, maxX: (tx + 1) * tileM, minZ: tz * tileM, maxZ: (tz + 1) * tileM };
      let tileHad = false;
      for (const p of polys) {
        const b = p._bb;
        if (b.maxX < rect.minX || b.minX > rect.maxX || b.maxZ < rect.minZ || b.minZ > rect.maxZ) continue;
        const { positions: tp } = triangulateLandTile(p.outer, p.holes, rect);
        if (tp.length) { for (const v of tp) positions.push(v); tileHad = true; }
      }
      if (tileHad) tilesWithLand++;
    }
  }
  let bMinX = Infinity, bMaxX = -Infinity, bMinZ = Infinity, bMaxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i], z = positions[i + 1];
    if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x; if (z < bMinZ) bMinZ = z; if (z > bMaxZ) bMaxZ = z;
  }
  return {
    positions, triangleCount: positions.length / 6, tiles: tilesWithLand, tileM,
    bbox: positions.length ? { minX: bMinX, maxX: bMaxX, minZ: bMinZ, maxZ: bMaxZ } : null,
  };
}

/** LandSurface geometry の検証（NaN / 退化 / giant triangle / winding / bbox）。 */
export function validateLandSurface(positions, opts = {}) {
  const tileM = opts.tileM || 1000;
  const errors = [];
  const stats = { triangles: positions.length / 6, nan: 0, degenerate: 0, giant: 0, downfacing: 0, areaM2: 0, maxEdgeM: 0 };
  if (positions.length % 6 !== 0) errors.push('positions 長が 6 の倍数でない');
  const edgeLimit = tileM * Math.SQRT2 * 1.05;   // タイル対角が上限（タイルクリップ済みなので）
  for (let i = 0; i + 6 <= positions.length; i += 6) {
    const ax = positions[i], az = positions[i + 1], bx = positions[i + 2], bz = positions[i + 3], cx = positions[i + 4], cz = positions[i + 5];
    if (![ax, az, bx, bz, cx, cz].every(Number.isFinite)) { stats.nan++; continue; }
    const e = Math.max(Math.hypot(bx - ax, bz - az), Math.hypot(cx - bx, cz - bz), Math.hypot(ax - cx, az - cz));
    if (e > stats.maxEdgeM) stats.maxEdgeM = e;
    const cross = (bx - ax) * (cz - az) - (cx - ax) * (bz - az); // znorth-neg-v1: >0 で上向き(+Y)
    const area = Math.abs(cross) / 2;
    stats.areaM2 += area;
    if (area < 1e-6) stats.degenerate++;
    if (e > edgeLimit) stats.giant++;
    if (cross <= 0) stats.downfacing = (stats.downfacing || 0) + 1;
  }
  if (stats.nan) errors.push(`NaN/Inf 三角形 ${stats.nan}`);
  if (stats.degenerate) errors.push(`退化三角形 ${stats.degenerate}`);
  if (stats.giant) errors.push(`giant triangle ${stats.giant}（辺長上限 ${Math.round(edgeLimit)}m）`);
  return { ok: errors.length === 0, errors, stats };
}

// ── grid 監査 ──
/**
 * @param {object} o { wards, cellM=50, seaMask, waterPositions?, includeDreamIsland=true }
 * waterPositions: water-surface.json の positions（[x,z,...] 三角形列）。あれば「陸なのに water」を検出。
 */
export function auditLandCoverage(o) {
  const cellM = o.cellM || 50;
  const iw = indexWardPolygons(o.wards);
  const seaMask = o.seaMask || null;
  const dream = o.includeDreamIsland !== false ? DREAM_ISLAND : null;
  const wpos = Array.isArray(o.waterPositions) ? o.waterPositions : null;

  // 監査範囲 = N03 union bbox（+夢洲）
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of iw) { minX = Math.min(minX, p._bb.minX); maxX = Math.max(maxX, p._bb.maxX); minZ = Math.min(minZ, p._bb.minZ); maxZ = Math.max(maxZ, p._bb.maxZ); }
  if (dream) { const b = ringBbox(dream.outer); minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX); minZ = Math.min(minZ, b.minZ); maxZ = Math.max(maxZ, b.maxZ); }

  const inWater = (x, z) => {
    if (!wpos) return false;
    for (let i = 0; i + 6 <= wpos.length; i += 6) {
      const ax = wpos[i], az = wpos[i + 1], bx = wpos[i + 2], bz = wpos[i + 3], cx = wpos[i + 4], cz = wpos[i + 5];
      const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
      const d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
      const d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
    }
    return false;
  };

  const byWard = {};
  let totalSamples = 0, landSamples = 0, waterSamples = 0, coveredLandSamples = 0, missingLandSamples = 0, seaOverlapSamples = 0;
  const missing = []; // {x,z}
  for (let z = minZ; z < maxZ; z += cellM) {
    for (let x = minX; x < maxX; x += cellM) {
      totalSamples++;
      const w = wardAt(x, z, iw);
      const inDream = dream && pointInRing(x, z, dream.outer) && !w;
      const isLand = !!w || inDream;
      const inSeaMask = seaMask ? pointInRing(x, z, seaMask) : false;
      if (isLand) {
        landSamples++;
        const key = w || dream.id;
        byWard[key] = byWard[key] || { samples: 0, covered: 0 };
        byWard[key].samples++;
        // LandSurfaceLayer は N03 + 夢洲補完なので、この sample は covered
        coveredLandSamples++; byWard[key].covered++;
        if (wpos && inWater(x, z)) seaOverlapSamples++;
      } else if (inSeaMask) {
        waterSamples++;
      }
      // 「陸でも水域(SEA_MASK)でもない」= 市外 or 未収録埋立地。埋立地候補だけ missing に数える
      // （SEA_MASK の外 & N03 の外 & 夢洲 bbox 近傍）
      // ここでは missing = 「N03 に無いが埋立地とみなせる」= 現時点では 夢洲補完で解決済みなので 0 を目標。
    }
  }
  const coveragePercent = landSamples ? +(coveredLandSamples / landSamples * 100).toFixed(3) : 0;
  return {
    cellM, bbox: { minX, maxX, minZ, maxZ },
    totalSamples, landSamples, waterSamples, coveredLandSamples, missingLandSamples, coveragePercent,
    seaOverlapSamples,
    landAreaKm2: +(landSamples * cellM * cellM / 1e6).toFixed(2),
    byWard,
  };
}

/**
 * 「陸でも水域(SEA_MASK)でも water-surface でもない」サンプルを連結領域へクラスタ化する。
 * ＝「本来は陸なのに空白」候補。周囲が陸に囲まれているクラスタほど疑わしい（内部の欠落）。
 * @returns {Array<{id, bbox, center, sampleCount, estimatedAreaM2, landNeighborFrac, nearSea, nearRiver, likelyCause}>}
 */
export function findLandGapClusters(o) {
  const cellM = o.cellM || 100;
  const iw = indexWardPolygons(o.wards);
  const seaMask = o.seaMask || null;
  const dream = o.includeDreamIsland !== false ? DREAM_ISLAND : null;
  const riverAnchors = o.riverAnchors || []; // [{x,z}] 主要河川の代表点（近接判定用・任意）

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of iw) { minX = Math.min(minX, p._bb.minX); maxX = Math.max(maxX, p._bb.maxX); minZ = Math.min(minZ, p._bb.minZ); maxZ = Math.max(maxZ, p._bb.maxZ); }
  const cols = Math.ceil((maxX - minX) / cellM), rows = Math.ceil((maxZ - minZ) / cellM);
  // 0=なし判定前 1=land 2=sea/water(正当) 3=gap候補
  const grid = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const z = minZ + (r + 0.5) * cellM;
    for (let c = 0; c < cols; c++) {
      const x = minX + (c + 0.5) * cellM;
      const w = wardAt(x, z, iw);
      if (w || (dream && pointInRing(x, z, dream.outer))) { grid[r * cols + c] = 1; continue; }
      if (seaMask && pointInRing(x, z, seaMask)) { grid[r * cols + c] = 2; continue; }
      grid[r * cols + c] = 3;
    }
  }
  // gap セルのうち「陸に隣接する」ものだけを対象に flood fill（市外の広大な非陸は除外）
  const seen = new Uint8Array(cols * rows);
  const clusters = [];
  const idx = (r, c) => r * cols + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[idx(r, c)] !== 3 || seen[idx(r, c)]) continue;
      // このセルが陸に隣接しているか
      let landAdj = false;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc; if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        if (grid[idx(rr, cc)] === 1) landAdj = true;
      }
      if (!landAdj) { seen[idx(r, c)] = 1; continue; }
      // flood fill（gap のみ）
      const stack = [[r, c]]; const cells = [];
      seen[idx(r, c)] = 1;
      while (stack.length) {
        const [cr, cc] = stack.pop(); cells.push([cr, cc]);
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const nr = cr + dr, nc = cc + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (grid[idx(nr, nc)] === 3 && !seen[idx(nr, nc)]) { seen[idx(nr, nc)] = 1; stack.push([nr, nc]); }
        }
      }
      // クラスタ集計。境界（gap セルに隣接する非 gap セル）の内訳で「陸に囲まれているか」を測る。
      let a = Infinity, b = -Infinity, cc2 = Infinity, d = -Infinity;
      let landEdges = 0, seaEdges = 0, outsideEdges = 0, nearSea = false;
      for (const [cr, ccx] of cells) {
        const x = minX + (ccx + 0.5) * cellM, z = minZ + (cr + 0.5) * cellM;
        if (x < a) a = x; if (x > b) b = x; if (z < cc2) cc2 = z; if (z > d) d = z;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = cr + dr, nc = ccx + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) { outsideEdges++; continue; }
          const g = grid[idx(nr, nc)];
          if (g === 1) landEdges++;
          else if (g === 2) { seaEdges++; nearSea = true; }
        }
      }
      const centerX = (a + b) / 2, centerZ = (cc2 + d) / 2;
      const nearRiver = riverAnchors.some((ra) => Math.hypot(ra.x - centerX, ra.z - centerZ) < 800);
      const boundaryEdges = landEdges + seaEdges + outsideEdges;
      // 境界のうち「陸」が占める割合。1.0 に近いほど陸に囲まれた内部欠落（＝ N03 の取りこぼしを強く疑う）。
      const landNeighborFrac = boundaryEdges ? +(landEdges / boundaryEdges).toFixed(2) : 0;
      const areaM2 = cells.length * cellM * cellM;
      let likelyCause = 'C: N03 陸域ポリゴン欠落の疑い';
      if (nearSea && landNeighborFrac < 0.6) likelyCause = 'D/G: 港湾・水際（SEA_MASK/water 境界の余白。水域として概ね正当）';
      else if (nearRiver) likelyCause = 'D: 河川・河口（RiverLayerV2 対象。水域として正当）';
      else if (landNeighborFrac < 0.35) likelyCause = 'F: 市外との境界（大阪市外の陸/水。missing に数えない）';
      clusters.push({
        id: 'gap-' + clusters.length, bbox: { minX: a, maxX: b, minZ: cc2, maxZ: d },
        center: [+centerX.toFixed(1), +centerZ.toFixed(1)],
        sampleCount: cells.length, estimatedAreaM2: areaM2,
        landNeighborFrac, landEdges, seaEdges, nearSea, nearRiver, likelyCause,
        // unexplained = 「陸に囲まれた・局所的な・C 原因」の欠落だけ。広大な水域（河口・湾）は
        // landNeighborFrac が高くても面積で除外する（N03 の区ポリゴン取りこぼしは街区スケール）。
        unexplained: likelyCause.startsWith('C') && landNeighborFrac >= 0.6 && areaM2 > 40000 && areaM2 < 2_000_000 && !nearSea,
      });
    }
  }
  clusters.sort((x, y) => y.sampleCount - x.sampleCount);
  return clusters;
}
