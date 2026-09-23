// tools/lib/water-surface.js
// [見た目改善 Mission06] WaterSurfaceLayer（大阪湾・港湾水面）の純粋ロジック。
// ══════════════════════════════════════════════════════════════════════════════════
// 設計方針（最優先: 過去の巨大水面バグを絶対に再発させない）
//
//   - OSM の natural=coastline は「神戸〜大阪〜堺」を貫く 1 本の有向線で、大阪市の海面だけを
//     切り出すにはリング組み立て（outer/inner の連結・winding 判定）が必要。これは過去に
//     巨大三角形・陸地塗り潰し・N03 境界誤利用を起こした処理そのものなので **再利用しない**。
//   - 代わりに「ラスタライズ + 行ラン結合」で海面を作る:
//       海セル = SEA_MASK（手作業で検証した外洋側の凸包に近い多角形）の内側
//                かつ 24 区の陸ポリゴンのどれにも入らない
//                かつ 描画対象の地表矩形（OSAKA_CITY_GROUND_EXTENT）の内側
//     セル単位の内外判定なので、リング winding のバグで陸が塗られることが構造的に起こらない。
//   - 生成後は必ず多重ゲートで検証する（NaN / 退化三角形 / 辺長・面積上限 / 内陸テスト点 /
//     総面積レンジ / bbox 包含）。1 つでも破れたらレイヤーごと空で出荷する（reject-to-empty）。
//
// 座標系は znorth-neg-v1（x=東,  z=南が正 / 北が負）。HTML geoToThree と一致。
// ══════════════════════════════════════════════════════════════════════════════════

// 描画対象の地表矩形（public/osaka_3d_buildings.ward-ux-v1.html の OSAKA_CITY_GROUND_EXTENT と同値）
export const GROUND_EXTENT = Object.freeze({ minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 });

// 外洋側マスク（znorth-neg-v1 XZ）。実 coastline 頂点（PBF 由来）を数値で確認して手作業で決めた
// 「西側 + 南側の水域だけを囲み、尼崎(北) / 堺(南東) / 内陸(東) を確実に外す」保守的な多角形。
//   - 北端は z=-10500 で打ち切り（夢洲/舞洲の footprint と 淀川デルタを避ける）
//   - 東端は x=-4800〜-3200（此花〜大正の港湾水面までは含み、それより内陸へは踏み込まない）
// マスクが Osaka の沿岸区（此花/港/大正/西/浪速/住之江…）の陸に掛かっても、その陸は
// 24 区ポリゴンで必ず「穴」として除外されるので問題ない。危険なのは「Osaka 区でない陸」を
// 含むことだけで、それは上記の北/南東/東の打ち切りで排除している。
export const SEA_MASK = Object.freeze([
  [-16900, -10500],
  [-16900, 2300],
  [-4800, 2300],
  [-4800, -6200],
  [-3200, -8400],
  [-8000, -9600],
]);

// ラスタライズのセルサイズ（m）。小さいほど岸なり良いが三角形が増える。
export const DEFAULT_CELL_M = 50;

// 行ラン結合時の 1 矩形あたり最大幅（m）。これで 1 三角形の最大辺長・面積が有界になり、
// 「異常に巨大な triangle」を構造的に防ぐ（描画は 1 メッシュ merge なので矩形数が増えても draw call は 1）。
export const MAX_RUN_WIDTH_M = 600;

// 内陸テスト点（znorth-neg-v1）。ここに海セルが 1 つでも掛かったら生成物は不正。
// 24 区のうち海に一切面していない区の代表点（bbox 中心）を使う。座標はハードコードだが
// 「海であってはならない点」の列挙なので、誤検出方向には安全側。
export const INLAND_TEST_POINTS = Object.freeze([
  [-455, -6277],   // 天王寺区
  [-1134, -3126],  // 阿倍野区
  [1759, -5034],   // 生野区
  [2018, -7745],   // 東成区
  [3575, -1261],   // 平野区
  [535, -1500],    // 東住吉区
  [2282, -10294],  // 城東区
  [1990, -13864],  // 旭区
  [257, -12025],   // 都島区
  [-797, -8324],   // 中央区
  [4955, -11242],  // 鶴見区
  [-3115, -3910],  // 西成区
  [-2412, -10953], // 北区
  [-1000, -6500],  // 難波近辺
  [0, -8600],      // 大阪城近辺
  // 沿岸区の市街地（24 区ポリゴンで穴抜きされるはずの陸。ゲートを固くするため明示）
  [-6800, -6300],  // 港区中心
  [-5400, -4700],  // 大正区中心
  [-7000, -7800],  // 此花区（USJ 付近）
  [-6900, -5600],  // 天保山
  [-9000, -3200],  // 咲洲（コスモスクエア）
]);

/** 点 (x,z) が 1 つのリング（[[x,z],...]）の内側か（even-odd / ray casting）。 */
export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1];
    const xj = ring[j][0], zj = ring[j][1];
    const intersect = ((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 点が「outer に入り holes に入らない」ポリゴン群の内側か。polys: [{outer, holes?}] */
export function pointInPolygons(x, z, polys) {
  for (const p of polys) {
    if (!pointInRing(x, z, p.outer)) continue;
    let inHole = false;
    for (const h of (p.holes || [])) { if (pointInRing(x, z, h)) { inHole = true; break; } }
    if (!inHole) return true;
  }
  return false;
}

/** ward-classification-polygons.json の wards[] を [{outer,holes}] のフラット配列へ。 */
export function flattenWardPolygons(wards) {
  const out = [];
  for (const w of wards) {
    for (const poly of (w.polygons || [])) {
      out.push({ wardId: w.wardId, outer: poly.outer, holes: poly.holes || [] });
    }
  }
  return out;
}

function bboxOfRing(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * 海面をラスタライズする。
 * @param {object} opts
 * @param {Array}  opts.wardPolygons flattenWardPolygons() の出力（陸マスク）
 * @param {number} [opts.cellM] セルサイズ
 * @param {Array}  [opts.mask] 外洋マスク（既定 SEA_MASK）
 * @param {object} [opts.extent] 地表矩形（既定 GROUND_EXTENT）
 * @returns {{cellM, cols, rows, origin:{x,z}, cells:Uint8Array, seaCellCount, areaM2}}
 */
export function rasterizeSea(opts) {
  const cellM = opts.cellM || DEFAULT_CELL_M;
  const mask = opts.mask || SEA_MASK;
  const ext = opts.extent || GROUND_EXTENT;
  const wardPolys = opts.wardPolygons || [];
  // [Mission21] セル中心だけでなく 4 隅も陸判定する（既定 ON）。境界を跨ぐセルを水に含めず、
  //   行ラン結合で最大 cellM の水が海岸線から陸へはみ出す問題（land∩water overlap）を防ぐ。
  const testCorners = opts.testCorners !== false;

  const maskBox = bboxOfRing(mask);
  // ラスタ範囲 = マスク bbox ∩ 地表矩形
  const minX = Math.max(ext.minX, maskBox.minX);
  const maxX = Math.min(ext.maxX, maskBox.maxX);
  const minZ = Math.max(ext.minZ, maskBox.minZ);
  const maxZ = Math.min(ext.maxZ, maskBox.maxZ);
  const cols = Math.max(0, Math.ceil((maxX - minX) / cellM));
  const rows = Math.max(0, Math.ceil((maxZ - minZ) / cellM));
  const cells = new Uint8Array(cols * rows);

  // ward ポリゴンの bbox を前計算（セルごとの PIP を早期棄却）
  const wardBoxed = wardPolys.map((p) => ({ ...p, _bb: bboxOfRing(p.outer) }));

  const ptOnLand = (x, z) => {
    for (const p of wardBoxed) {
      const b = p._bb;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (!pointInRing(x, z, p.outer)) continue;
      let inHole = false;
      for (const h of (p.holes || [])) { if (pointInRing(x, z, h)) { inHole = true; break; } }
      if (!inHole) return true;
    }
    return false;
  };

  const landCells = new Uint8Array(cols * rows); // 中心 or 隅が陸のセル
  const eps = 0.5;
  for (let r = 0; r < rows; r++) {
    const cz = minZ + (r + 0.5) * cellM;
    const z0 = minZ + r * cellM + eps, z1 = minZ + (r + 1) * cellM - eps;
    for (let c = 0; c < cols; c++) {
      const cx = minX + (c + 0.5) * cellM;
      if (!pointInRing(cx, cz, mask)) continue;
      const x0 = minX + c * cellM + eps, x1 = minX + (c + 1) * cellM - eps;
      if (ptOnLand(cx, cz) || (testCorners && (ptOnLand(x0, z0) || ptOnLand(x1, z0) || ptOnLand(x0, z1) || ptOnLand(x1, z1)))) {
        landCells[r * cols + c] = 1;
        continue;
      }
      cells[r * cols + c] = 1;
    }
  }
  // [Mission21] 1 セル海岸浸食: 陸セルに隣接する水セルを削る。行ラン結合で最大 cellM の水が
  //   海岸線から陸へはみ出す問題（land∩water overlap）を、resolution によらず 0 にする保険。
  if (testCorners) {
    const eroded = cells.slice();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!cells[r * cols + c]) continue;
        let touchesLand = false;
        for (let dr = -1; dr <= 1 && !touchesLand; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
            if (landCells[rr * cols + cc]) { touchesLand = true; break; }
          }
        }
        if (touchesLand) eroded[r * cols + c] = 0;
      }
    }
    eroded.forEach((v, i) => { cells[i] = v; });
  }
  let seaCellCount = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i]) seaCellCount++;

  return {
    cellM, cols, rows,
    origin: { x: minX, z: minZ },
    cells, seaCellCount,
    areaM2: seaCellCount * cellM * cellM,
  };
}

/**
 * ブールグリッドを「行方向に連続する水セルの区間（ラン）」へ結合する。
 * 1 ラン = 1 つの軸並行矩形。ポリゴン/リング組み立ては一切しない。
 * @returns {Array<{x0,x1,z0,z1}>}  znorth-neg-v1 の矩形
 */
export function mergeRowRuns(raster, maxWidthM = MAX_RUN_WIDTH_M) {
  const { cols, rows, cellM, origin, cells } = raster;
  const maxCells = Math.max(1, Math.floor(maxWidthM / cellM));
  const runs = [];
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      if (!cells[r * cols + c]) { c++; continue; }
      let c2 = c;
      while (c2 < cols && cells[r * cols + c2] && (c2 - c) < maxCells) c2++;
      runs.push({
        x0: origin.x + c * cellM,
        x1: origin.x + c2 * cellM,
        z0: origin.z + r * cellM,
        z1: origin.z + (r + 1) * cellM,
      });
      c = c2;
    }
  }
  return runs;
}

/**
 * [Mission21] 陸（ward ポリゴン）と少しでも重なる水矩形を除外する。
 *   - 矩形 9 点（4 隅 + 4 辺中点 + 中心）のどれかが陸
 *   - または ward ポリゴン頂点が矩形内
 *   のいずれかで矩形を捨てる。→ どの解像度でも land∩water overlap = 0。
 *   水は背景フィルなので海岸線から数十 m 引っ込んでも見た目の影響はない。
 */
export function filterRunsAgainstLand(runs, wardPolygons) {
  const polys = (wardPolygons || []).map((p) => ({ ...p, _bb: bboxOfRing(p.outer) }));
  const onLand = (x, z) => {
    for (const p of polys) {
      const b = p._bb;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (!pointInRing(x, z, p.outer)) continue;
      let inHole = false;
      for (const h of (p.holes || [])) if (pointInRing(x, z, h)) { inHole = true; break; }
      if (!inHole) return true;
    }
    return false;
  };
  return runs.filter((q) => {
    const mx = (q.x0 + q.x1) / 2, mz = (q.z0 + q.z1) / 2;
    const pts = [
      [q.x0, q.z0], [q.x1, q.z0], [q.x1, q.z1], [q.x0, q.z1],
      [mx, q.z0], [mx, q.z1], [q.x0, mz], [q.x1, mz], [mx, mz],
    ];
    for (const [x, z] of pts) if (onLand(x, z)) return false;
    for (const p of polys) {
      if (p._bb.maxX < q.x0 || p._bb.minX > q.x1 || p._bb.maxZ < q.z0 || p._bb.minZ > q.z1) continue;
      for (const [vx, vz] of p.outer) if (vx >= q.x0 && vx <= q.x1 && vz >= q.z0 && vz <= q.z1) return false;
    }
    return true;
  });
}

/**
 * 矩形ラン列を上向き三角形の頂点配列（znorth-neg-v1 の [x,z] を平坦化）へ。
 * winding は「上から見て CCW」に固定（Y は描画側で付与）。
 * @returns {{positions:number[], triangleCount:number}}
 */
export function runsToTriangles(runs) {
  const positions = [];
  for (const q of runs) {
    // znorth-neg-v1（x=東, z=南）で法線が +Y（上向き）になる頂点順。
    //   tri1: (x0,z0) (x1,z1) (x1,z0)   tri2: (x0,z0) (x0,z1) (x1,z1)
    positions.push(q.x0, q.z0, q.x1, q.z1, q.x1, q.z0);
    positions.push(q.x0, q.z0, q.x0, q.z1, q.x1, q.z1);
  }
  return { positions, triangleCount: runs.length * 2 };
}

/** 三角形 (2D, znorth-neg-v1) の Y 上向き法線判定用の符号付き外積 Y 成分。>0 なら +Y。 */
export function upNormalY(ax, az, bx, bz, cx, cz) {
  // 3D では (b-a)×(c-a) の y 成分 = (bz-az)*(cx-ax) - (bx-ax)*(cz-az)
  return (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
}

/**
 * 生成物の多重ゲート検証。1 つでも fail したら ok:false（呼び出し側は reject-to-empty）。
 * @param {object} p
 * @param {number[]} p.positions  [x,z,...] 三角形頂点列
 * @param {number}   p.cellM
 * @param {object}   [p.extent]
 * @param {Array}    [p.inlandPoints]
 * @param {[number,number]} [p.areaRangeM2]  許容総面積 [min,max]
 */
export function validateWaterSurface(p) {
  const ext = p.extent || GROUND_EXTENT;
  const inland = p.inlandPoints || INLAND_TEST_POINTS;
  const cellM = p.cellM || DEFAULT_CELL_M;
  const maxWidthM = p.maxWidthM || MAX_RUN_WIDTH_M;
  const pos = p.positions || [];
  const errors = [];
  const stats = { triangles: pos.length / 6, nanCount: 0, degenerateCount: 0, sliverCount: 0, oversizeCount: 0, tallCount: 0, outOfExtentCount: 0, maxEdgeM: 0, maxTriAreaM2: 0, areaM2: 0 };

  if (pos.length % 6 !== 0) errors.push(`positions 長が 6 の倍数でない (${pos.length})`);

  const edgeLimit = Math.hypot(maxWidthM, cellM) * 1.05; // 対角も含めた辺長上限
  const heightLimit = cellM * 1.05;                       // 行ラン由来なので z 方向は 1 セル

  for (let i = 0; i + 6 <= pos.length; i += 6) {
    const ax = pos[i], az = pos[i + 1], bx = pos[i + 2], bz = pos[i + 3], cx = pos[i + 4], cz = pos[i + 5];
    if (![ax, az, bx, bz, cx, cz].every(Number.isFinite)) { stats.nanCount++; continue; }
    const e1 = Math.hypot(bx - ax, bz - az);
    const e2 = Math.hypot(cx - bx, cz - bz);
    const e3 = Math.hypot(ax - cx, az - cz);
    const maxE = Math.max(e1, e2, e3);
    if (maxE > stats.maxEdgeM) stats.maxEdgeM = maxE;
    const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    if (area > stats.maxTriAreaM2) stats.maxTriAreaM2 = area;
    stats.areaM2 += area;
    const triMinX = Math.min(ax, bx, cx), triMaxX = Math.max(ax, bx, cx);
    const triMinZ = Math.min(az, bz, cz), triMaxZ = Math.max(az, bz, cz);
    const bboxArea = (triMaxX - triMinX) * (triMaxZ - triMinZ);
    // 退化: 面積ゼロ
    if (area < 1e-6) stats.degenerateCount++;
    // sliver: 自分の bbox に対する面積比が直角三角形の 0.5 から大きく外れる（＝細長い針）
    else if (bboxArea > 1e-6 && Math.abs(area / bboxArea - 0.5) > 0.06) stats.sliverCount++;
    // 過大: 辺長 or z 高さが想定を超える（巨大 triangle / 縦断ポリゴンの検出）
    if (maxE > edgeLimit) stats.oversizeCount++;
    if ((triMaxZ - triMinZ) > heightLimit) stats.tallCount++;
    for (const [x, z] of [[ax, az], [bx, bz], [cx, cz]]) {
      if (x < ext.minX - cellM || x > ext.maxX + cellM || z < ext.minZ - cellM || z > ext.maxZ + cellM) stats.outOfExtentCount++;
    }
  }

  if (stats.nanCount > 0) errors.push(`NaN/Inf 頂点を含む三角形 ${stats.nanCount} 件`);
  if (stats.degenerateCount > 0) errors.push(`退化三角形（面積ゼロ）${stats.degenerateCount} 件`);
  if (stats.sliverCount > 0) errors.push(`sliver 三角形（bbox 面積比が 0.5 から乖離）${stats.sliverCount} 件`);
  if (stats.oversizeCount > 0) errors.push(`辺長が上限 ${Math.round(edgeLimit)}m を超える三角形 ${stats.oversizeCount} 件`);
  if (stats.tallCount > 0) errors.push(`z 高さが 1 セル（${cellM}m）を超える三角形 ${stats.tallCount} 件`);
  if (stats.outOfExtentCount > 0) errors.push(`地表矩形外の頂点 ${stats.outOfExtentCount} 件`);

  // 内陸テスト点: 三角形（軸並行矩形ペア）に内包されていないこと
  let inlandHits = 0;
  for (const [px, pz] of inland) {
    for (let i = 0; i + 6 <= pos.length; i += 6) {
      if (pointInTriangle(px, pz, pos[i], pos[i + 1], pos[i + 2], pos[i + 3], pos[i + 4], pos[i + 5])) { inlandHits++; break; }
    }
  }
  if (inlandHits > 0) errors.push(`内陸テスト点が海面に内包されている: ${inlandHits} 点`);
  stats.inlandHits = inlandHits;

  // 総面積レンジ（既定: 大阪市 bbox 内の外洋部として妥当な 5〜120 km²）
  const [amin, amax] = p.areaRangeM2 || [5e6, 120e6];
  if (stats.areaM2 < amin) errors.push(`海面総面積が小さすぎる ${(stats.areaM2 / 1e6).toFixed(1)}km²（下限 ${(amin / 1e6).toFixed(0)}）`);
  if (stats.areaM2 > amax) errors.push(`海面総面積が大きすぎる ${(stats.areaM2 / 1e6).toFixed(1)}km²（上限 ${(amax / 1e6).toFixed(0)}）— 陸を塗っている可能性`);

  return { ok: errors.length === 0, errors, stats };
}

export function pointInTriangle(px, pz, ax, az, bx, bz, cx, cz) {
  const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
  const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
  const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
